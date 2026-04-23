import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    ProjectBrowserFilterKey,
    ProjectContentRatings,
    ScenePropertyType,
    UserPropertyStoreKey,
    areScenePropertyValuesEqual,
    buildScenePropertyValueMap,
    getProjectFilterTagOptions,
    getProjectFilterFromSettings,
    getProjectScenePropertyOverrides,
    getProjectWebPropertyOverrides,
    isScenePropertyVisible,
    listProjects,
    loadProject,
    normalizeLibraryRootPath,
    normalizeScenePropertyValue,
    projectMatchesFilter,
    serializeStoredScenePropertyOverrides,
    setProjectFilterInSettings,
    setProjectScenePropertyOverrides,
    setProjectWebPropertyOverrides,
} from '../project.js';
import {connectTracked} from './rows.js';

// Resolve paths from this module so the preview actions work both from the
// installed extension directory and from an in-tree development build where the
// preferences module still sits next to the renderer directory under src/.
const moduleDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const extensionDir = GLib.path_get_dirname(moduleDir);
const rendererScriptPath = GLib.build_filenamev([extensionDir, 'renderer', 'renderer.js']);

const haveContentFit = Gtk.get_minor_version() >= 8;
// The Browse grid uses compact square thumbnails so more wallpapers remain
// visible at once, while zero child spacing removes the gutter between adjacent
// preview cards instead of leaving GTK's default gallery-style breathing room.
const PROJECT_CARD_WIDTH = 160;
const PROJECT_FLOWBOX_ITEM_SPACING = 0;
// GTK reports mouse buttons as numeric event values; naming the two buttons we
// care about keeps card activation and thumbnail context-menu handling from
// accidentally sharing the same all-buttons gesture.
const PROJECT_CARD_PRIMARY_BUTTON = 1;
const PROJECT_CARD_SECONDARY_BUTTON = 3;
// Thumbnail work is deliberately capped so opening Browse only creates cheap
// placeholder widgets on the main thread, while disk reads and pixbuf decoding
// are allowed to complete in a small background stream instead of stampeding.
const PROJECT_THUMBNAIL_CONCURRENCY = 3;
// The context-menu window preview mirrors the manual debug command requested by
// users: a fixed 16:9 window that is large enough to inspect scene/web details
// without covering the whole desktop.
const PROJECT_PREVIEW_WINDOW_DIMENSION = '1600:900';
const SCENE_PROPERTY_PANEL_WIDTH = 360;
const INSPECTOR_ROW_HORIZONTAL_MARGIN = 24;
const INSPECTOR_ROW_CONTROL_SPACING = 12;
const INSPECTOR_WIDE_CONTROL_WIDTH = 180;
const INSPECTOR_NARROW_CONTROL_WIDTH = 56;

export function formatProjectSubtitle(path) {
    if (!path)
        return _('None');

    const project = loadProject(path);
    if (!project)
        return path;

    const title = typeof project.title === 'string' && project.title !== ''
        ? project.title
        : (project.basename || path);
    return `${title} (${project.type})`;
}

export function formatLibrarySubtitle(path) {
    return normalizeLibraryRootPath(path) || _('None');
}

export function prefsRowLibraryPath(window, prefsGroup) {
    const settings = window._settings;
    const title = _('Steam Library');
    const key = 'change-wallpaper-directory-path';

    let path = settings.get_string(key);
    const row = new Adw.ActionRow({
        title,
        subtitle: formatLibrarySubtitle(path),
    });
    prefsGroup.add(row);

    function createDialog() {
        let fileChooser = new Gtk.FileChooserDialog({
            title: _('Select Steam Library'),
            action: Gtk.FileChooserAction.SELECT_FOLDER,
        });
        fileChooser.set_modal(true);
        fileChooser.set_transient_for(window);
        fileChooser.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        fileChooser.add_button(_('Open'), Gtk.ResponseType.ACCEPT);

        fileChooser.connect('response', (dialog, responseId) => {
            if (responseId === Gtk.ResponseType.ACCEPT) {
                let _path = normalizeLibraryRootPath(dialog.get_file().get_path());
                settings.set_string(key, _path);
                row.subtitle = formatLibrarySubtitle(_path);
            }
            dialog.destroy();
        });
        return fileChooser;
    }

    let button = new Adw.ButtonContent({
        icon_name: 'document-open-symbolic',
        label: _('Open'),
    });

    row.activatable_widget = button;
    row.add_suffix(button);

    row.connect('activated', () => {
        let dialog = createDialog();
        dialog.show();
    });

    connectTracked(window, settings, `changed::${key}`, () => {
        const path = settings.get_string(key);
        const normalized = normalizeLibraryRootPath(path);
        if (normalized !== path) {
            settings.set_string(key, normalized);
            return;
        }
        row.subtitle = formatLibrarySubtitle(normalized);
    });
}

function buildProjectSearchText(project) {
    return [
        project.title,
        project.basename,
        project.type,
        project.description,
        ...(project.tags ?? []),
    ].join(' ').toLowerCase();
}

function getUserPropertyStoreFromSettings(settings) {
    // The preferences UI reads the same neutral key that the renderer watches,
    // keeping web and scene overrides synchronized without any backend-specific
    // compatibility store or migration branch.
    return settings.get_string(UserPropertyStoreKey);
}

function getProjectPropertyOverrides(settings, project) {
    const userPropertyStore = getUserPropertyStoreFromSettings(settings);
    if (project?.type === 'web')
        return getProjectWebPropertyOverrides(userPropertyStore, project);
    return getProjectScenePropertyOverrides(userPropertyStore, project);
}

function setProjectPropertyOverrides(settings, project, overrides) {
    const userPropertyStore = getUserPropertyStoreFromSettings(settings);
    const nextStore = project?.type === 'web'
        ? setProjectWebPropertyOverrides(userPropertyStore, project, overrides)
        : setProjectScenePropertyOverrides(userPropertyStore, project, overrides);

    // Persist the complete shared JSON store after backend-specific value
    // normalization so both web and scene project payloads resolve from one key.
    settings.set_string(
        UserPropertyStoreKey,
        serializeStoredScenePropertyOverrides(nextStore)
    );
    return getProjectPropertyOverrides(settings, project);
}

function isPreviewLoadCancelled(error) {
    // GIO reports user-driven dialog teardown and per-widget destruction as a
    // normal cancellation error; filtering it keeps diagnostics focused on real
    // decode or filesystem failures that still need investigation.
    return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
}

function readProjectPreviewStreamAsync(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_LOW, cancellable, (source, result) => {
            try {
                resolve(source.read_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function closePreviewStreamQuietlyAsync(stream) {
    if (!stream)
        return Promise.resolve();

    return new Promise(resolve => {
        // The thumbnail queue owns short-lived file streams, so close errors are
        // logged only by the load operation itself; failing to close an already
        // cancelled stream should not turn a harmless Browse close into noise.
        stream.close_async(GLib.PRIORITY_LOW, null, (source, result) => {
            try {
                source.close_finish(result);
            } catch (_e) {
            }
            resolve();
        });
    });
}

async function loadProjectPreviewPixbufAsync(path, cancellable) {
    let stream = null;
    try {
        stream = await readProjectPreviewStreamAsync(path, cancellable);
        return await new Promise((resolve, reject) => {
            // GdkPixbuf performs the expensive image decode asynchronously here,
            // which is the critical part that used to block the Browse dialog
            // while every project card was being created.
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                stream,
                PROJECT_CARD_WIDTH,
                PROJECT_CARD_WIDTH,
                true,
                cancellable,
                (_source, result) => {
                    try {
                        resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    } finally {
        await closePreviewStreamQuietlyAsync(stream);
    }
}

async function loadProjectPreviewAnimationAsync(path, cancellable) {
    let stream = null;
    try {
        stream = await readProjectPreviewStreamAsync(path, cancellable);
        return await new Promise((resolve, reject) => {
            // GIF previews still keep their animation support, but the animation
            // container is opened asynchronously so large workshop libraries do
            // not freeze preferences while the first frame is decoded.
            GdkPixbuf.PixbufAnimation.new_from_stream_async(
                stream,
                cancellable,
                (_source, result) => {
                    try {
                        resolve(GdkPixbuf.PixbufAnimation.new_from_stream_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    } finally {
        await closePreviewStreamQuietlyAsync(stream);
    }
}

function createProjectPreviewLoadQueue() {
    const queue = [];
    const activeJobs = new Set();
    let activeCount = 0;
    let idleId = 0;
    let destroyed = false;

    const cancelJob = job => {
        job.cancelled = true;
        job.cancellable.cancel();
    };

    const schedule = () => {
        if (destroyed || idleId)
            return;

        // Loading begins from an idle handler so the dialog has a chance to map
        // and paint its initial placeholder grid before thumbnail work consumes
        // background IO slots.
        idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            idleId = 0;
            pump();
            return GLib.SOURCE_REMOVE;
        });
    };

    const finishJob = job => {
        activeJobs.delete(job);
        activeCount = Math.max(0, activeCount - 1);
        schedule();
    };

    function pump() {
        while (!destroyed && activeCount < PROJECT_THUMBNAIL_CONCURRENCY && queue.length > 0) {
            const job = queue.shift();
            if (job.cancelled)
                continue;

            activeCount++;
            activeJobs.add(job);
            Promise.resolve()
                .then(() => job.run(job.cancellable))
                .catch(error => {
                    if (!job.cancelled && !isPreviewLoadCancelled(error))
                        console.warn(`Hanabi preferences: thumbnail queue job failed: ${error}`);
                })
                .finally(() => finishJob(job));
        }
    }

    return {
        enqueue(run) {
            const job = {
                run,
                cancellable: new Gio.Cancellable(),
                cancelled: false,
            };
            queue.push(job);
            schedule();
            return () => cancelJob(job);
        },
        destroy() {
            destroyed = true;
            if (idleId) {
                GLib.source_remove(idleId);
                idleId = 0;
            }
            queue.splice(0).forEach(cancelJob);
            activeJobs.forEach(cancelJob);
        },
    };
}

function createProjectPreviewFrame() {
    const frame = new Gtk.Overlay({
        hexpand: false,
        vexpand: false,
    });
    frame.set_size_request(PROJECT_CARD_WIDTH, PROJECT_CARD_WIDTH);

    const placeholder = new Gtk.Box({
        hexpand: false,
        vexpand: false,
        css_classes: ['card'],
    });
    placeholder.set_size_request(PROJECT_CARD_WIDTH, PROJECT_CARD_WIDTH);
    frame.set_child(placeholder);

    const picture = new Gtk.Picture({
        hexpand: false,
        vexpand: false,
        can_shrink: true,
        visible: false,
    });
    picture.set_size_request(PROJECT_CARD_WIDTH, PROJECT_CARD_WIDTH);
    if (haveContentFit)
        picture.set_content_fit(Gtk.ContentFit.COVER);
    frame.add_overlay(picture);

    const spinner = new Gtk.Spinner({
        spinning: false,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        visible: false,
    });
    frame.add_overlay(spinner);

    return {frame, picture, spinner};
}

function attachAnimatedProjectPreview(picture, animation, isCancelled) {
    const iter = animation.get_iter(null);
    const frameTextures = new Map();
    let timerId = 0;

    const updateFrame = () => {
        if (isCancelled())
            return GLib.SOURCE_REMOVE;

        const pixbuf = iter.get_pixbuf();
        if (pixbuf) {
            let texture = frameTextures.get(pixbuf);
            if (!texture) {
                // Each GIF frame is scaled once and cached as a texture; this
                // keeps animation playback cheap after the asynchronous open has
                // delivered the first decoded frame to the preview widget.
                const scaled = pixbuf.scale_simple(
                    PROJECT_CARD_WIDTH,
                    PROJECT_CARD_WIDTH,
                    GdkPixbuf.InterpType.BILINEAR
                ) ?? pixbuf;
                texture = Gdk.Texture.new_for_pixbuf(scaled);
                frameTextures.set(pixbuf, texture);
            }
            picture.set_paintable(texture);
        }

        const delay = iter.get_delay_time();
        if (delay < 0)
            return GLib.SOURCE_REMOVE;

        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(delay, 16), () => {
            timerId = 0;
            if (isCancelled())
                return GLib.SOURCE_REMOVE;

            iter.advance(null);
            return updateFrame();
        });
        return GLib.SOURCE_REMOVE;
    };

    updateFrame();
    return () => {
        if (timerId) {
            GLib.source_remove(timerId);
            timerId = 0;
        }
        frameTextures.clear();
        picture.set_paintable(null);
    };
}

function createProjectPreview(project, previewQueue) {
    const {frame, picture, spinner} = createProjectPreviewFrame();
    if (!project.previewPath || !previewQueue)
        return frame;

    let destroyed = false;
    let cancelLoad = null;
    let stopAnimation = null;
    const path = project.previewPath;
    const isGif = path.toLowerCase().endsWith('.gif');

    const finishLoading = () => {
        spinner.spinning = false;
        spinner.visible = false;
    };

    const failLoading = error => {
        if (destroyed)
            return;

        finishLoading();
        if (!isPreviewLoadCancelled(error))
            console.warn(`Hanabi preferences: failed to load wallpaper thumbnail "${path}": ${error}`);
    };

    spinner.visible = true;
    spinner.spinning = true;
    cancelLoad = previewQueue.enqueue(async cancellable => {
        try {
            if (isGif) {
                const animation = await loadProjectPreviewAnimationAsync(path, cancellable);
                if (destroyed || cancellable.is_cancelled())
                    return;

                stopAnimation = attachAnimatedProjectPreview(picture, animation, () => destroyed || cancellable.is_cancelled());
                picture.visible = true;
                finishLoading();
                return;
            }

            const pixbuf = await loadProjectPreviewPixbufAsync(path, cancellable);
            if (destroyed || cancellable.is_cancelled())
                return;

            picture.set_paintable(Gdk.Texture.new_for_pixbuf(pixbuf));
            picture.visible = true;
            finishLoading();
        } catch (error) {
            failLoading(error);
        }
    });

    frame.connect('destroy', () => {
        destroyed = true;
        cancelLoad?.();
        stopAnimation?.();
        finishLoading();
    });

    return frame;
}

function openProjectDirectory(project) {
    const path = project?.path;
    if (!path) {
        console.warn('Hanabi preferences: cannot open wallpaper folder because the project path is empty');
        return;
    }

    // Launch the project directory URI through GIO instead of shelling out so
    // the desktop chooses the user's configured file manager and reports real
    // launch failures back through the async finish callback.
    const uri = Gio.File.new_for_path(path).get_uri();
    try {
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, (_source, result) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(result);
            } catch (error) {
                console.warn(`Hanabi preferences: failed to open wallpaper folder "${path}": ${error}`);
            }
        });
    } catch (error) {
        console.warn(`Hanabi preferences: failed to open wallpaper folder "${path}": ${error}`);
    }
}

function launchProjectPreview(project, windowed) {
    const path = project?.path;
    if (!path) {
        console.warn('Hanabi preferences: cannot preview wallpaper because the project path is empty');
        return;
    }

    if (!GLib.file_test(rendererScriptPath, GLib.FileTest.IS_REGULAR)) {
        console.warn(`Hanabi preferences: cannot preview wallpaper because renderer.js was not found at "${rendererScriptPath}"`);
        return;
    }

    const argv = [
        'gjs',
        rendererScriptPath,
        '--standalone',
        '--nohide',
    ];
    if (windowed)
        argv.push('-W', PROJECT_PREVIEW_WINDOW_DIMENSION);
    argv.push('--project-path', path);

    // Use a small shell wrapper only for the same stderr/stdout tee behavior as
    // the documented manual preview command. Every argv segment is shell-quoted
    // before joining so wallpaper paths with spaces or quotes stay data, not
    // shell syntax.
    const command = `${argv.map(arg => GLib.shell_quote(arg)).join(' ')} 2>&1 | tee run.log`;
    try {
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.set_cwd(extensionDir);
        launcher.spawnv(['/bin/sh', '-c', command]);
    } catch (error) {
        const mode = windowed ? 'window' : 'fullscreen';
        console.warn(`Hanabi preferences: failed to launch ${mode} wallpaper preview for "${path}": ${error}`);
    }
}

function attachProjectPreviewContextMenu(preview, project) {
    const actions = new Gio.SimpleActionGroup();
    const openFolderAction = new Gio.SimpleAction({name: 'open-folder'});
    openFolderAction.connect('activate', () => openProjectDirectory(project));
    actions.add_action(openFolderAction);
    const previewWindowAction = new Gio.SimpleAction({name: 'preview-window'});
    previewWindowAction.connect('activate', () => launchProjectPreview(project, true));
    actions.add_action(previewWindowAction);
    const previewFullscreenAction = new Gio.SimpleAction({name: 'preview-fullscreen'});
    previewFullscreenAction.connect('activate', () => launchProjectPreview(project, false));
    actions.add_action(previewFullscreenAction);
    preview.insert_action_group('thumbnail', actions);

    const menu = new Gio.Menu();
    const previewMenu = new Gio.Menu();
    previewMenu.append(_('Window Preview'), 'thumbnail.preview-window');
    previewMenu.append(_('Fullscreen Preview'), 'thumbnail.preview-fullscreen');

    // Keep both launch modes grouped under one submenu so the thumbnail context
    // menu stays compact as more wallpaper maintenance actions are added.
    menu.append_submenu(_('Preview'), previewMenu);
    menu.append(_('Open Wallpaper Folder'), 'thumbnail.open-folder');

    // The popover is parented to the thumbnail widget so the menu is only
    // available from right-clicking the preview image, not the title/subtitle
    // labels below the card.
    const popover = Gtk.PopoverMenu.new_from_model(menu);
    popover.set_parent(preview);
    preview.connect('destroy', () => popover.unparent());

    const contextGesture = new Gtk.GestureClick({button: PROJECT_CARD_SECONDARY_BUTTON});
    contextGesture.connect('pressed', (_gesture, _nPress, x, y) => {
        // Pointing the popover at the click position makes the context menu feel
        // anchored to the exact thumbnail spot the user right-clicked.
        popover.set_pointing_to(new Gdk.Rectangle({
            x: Math.round(x),
            y: Math.round(y),
            width: 1,
            height: 1,
        }));
        popover.popup();
    });
    preview.add_controller(contextGesture);
}

function createProjectCard(project, onActivate, previewQueue) {
    const titleText = typeof project.title === 'string' && project.title !== ''
        ? project.title
        : (project.basename || _('Untitled'));

    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        hexpand: false,
        width_request: PROJECT_CARD_WIDTH,
        halign: Gtk.Align.START,
        valign: Gtk.Align.START,
        tooltip_text: project.path,
    });

    const preview = createProjectPreview(project, previewQueue);
    preview.set({
        hexpand: false,
        vexpand: false,
    });
    preview.set_size_request(PROJECT_CARD_WIDTH, PROJECT_CARD_WIDTH);
    attachProjectPreviewContextMenu(preview, project);

    const subtitleParts = [project.type || _('Unknown')];
    if (project.tags?.length)
        subtitleParts.push(project.tags[0]);

    const title = new Gtk.Label({
        label: titleText,
        xalign: 0,
        wrap: false,
        max_width_chars: 18,
        ellipsize: Pango.EllipsizeMode.END,
        css_classes: ['heading'],
    });

    const subtitle = new Gtk.Label({
        label: subtitleParts.join(' • '),
        xalign: 0,
        wrap: false,
        max_width_chars: 18,
        ellipsize: Pango.EllipsizeMode.END,
        css_classes: ['dim-label'],
    });

    root.append(preview);
    root.append(title);
    root.append(subtitle);

    // Keep selection on the primary button only, leaving the secondary button
    // free for thumbnail context-menu actions without also activating the card.
    const gesture = new Gtk.GestureClick({button: PROJECT_CARD_PRIMARY_BUTTON});
    gesture.connect('released', () => onActivate(project));
    root.add_controller(gesture);

    return root;
}

function stripScenePropertyMarkup(text) {
    if (typeof text !== 'string')
        return '';

    return text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<hr\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'')
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}

function formatScenePropertyLabel(text, fallback = _('Untitled')) {
    const label = stripScenePropertyMarkup(text);
    return label || fallback;
}

function decodeScenePropertyMarkupEntities(text) {
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'');
}

function balanceScenePropertyMarkup(markup) {
    const supportedTags = ['big', 'b', 'i', 'small', 'u'];
    const tagPattern = /<(\/?)(big|b|i|small|u)\s*>|<(\/?)a\b[^>]*>/gi;
    const stack = [];
    let match = null;

    while ((match = tagPattern.exec(markup)) !== null) {
        const fullMatch = match[0];
        const closing = (match[1] ?? match[3] ?? '') === '/';
        const tagName = (match[2] ?? 'a').toLowerCase();

        if (closing || fullMatch.startsWith('</')) {
            const openIndex = stack.lastIndexOf(tagName);
            if (openIndex >= 0)
                stack.splice(openIndex, 1);
            continue;
        }

        stack.push(tagName);
    }

    return markup + stack.reverse().map(tag => `</${tag}>`).join('');
}

function formatScenePropertyMarkup(text, fallback = _('Untitled')) {
    const source = typeof text === 'string' && text.trim() !== '' ? text : fallback;
    const tagPlaceholders = new Map([
        ['<big>', '__SCENE_BIG_OPEN__'],
        ['</big>', '__SCENE_BIG_CLOSE__'],
        ['<b>', '__SCENE_B_OPEN__'],
        ['</b>', '__SCENE_B_CLOSE__'],
        ['<i>', '__SCENE_I_OPEN__'],
        ['</i>', '__SCENE_I_CLOSE__'],
        ['<small>', '__SCENE_SMALL_OPEN__'],
        ['</small>', '__SCENE_SMALL_CLOSE__'],
        ['<u>', '__SCENE_U_OPEN__'],
        ['</u>', '__SCENE_U_CLOSE__'],
    ]);
    const placeholderMarkup = new Map([...tagPlaceholders.entries()].map(([markup, token]) => [token, markup]));
    const linkPlaceholders = [];
    const openLinkStack = [];

    let markup = source
        .replace(/\r\n?/g, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<hr\s*\/?>/gi, '\n')
        .replace(/<\/?(p|div|center)\b[^>]*>/gi, '\n')
        .replace(/<img\b[^>]*>/gi, '\n')
        .replace(/<a\b([^>]*)>|<\/a>/gi, (match, attributes) => {
            if (match.startsWith('</')) {
                const index = openLinkStack.pop();
                return index !== undefined ? `__SCENE_LINK_${index}_CLOSE__` : '';
            }

            const quotedHrefMatch = attributes.match(/\bhref\s*=\s*(['"])(.*?)\1/i);
            const unquotedHrefMatch = attributes.match(/\bhref\s*=\s*([^\s>]+)/i);
            const href = decodeScenePropertyMarkupEntities(
                quotedHrefMatch?.[2] ?? unquotedHrefMatch?.[1] ?? ''
            ).trim();
            const index = linkPlaceholders.length;
            linkPlaceholders.push(href);
            openLinkStack.push(index);
            return `__SCENE_LINK_${index}_OPEN__`;
        })
        .replace(/<\s*(\/?)\s*(big|b|i|small|u)\s*>/gi, (_match, closing, tagName) => {
            const key = `<${closing ? '/' : ''}${tagName.toLowerCase()}>`;
            return tagPlaceholders.get(key) ?? '';
        })
        .replace(/<[^>]*>/g, ' ');

    markup = decodeScenePropertyMarkupEntities(markup)
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .trim();

    if (!markup)
        return GLib.markup_escape_text(fallback, -1);

    markup = GLib.markup_escape_text(markup, -1);

    for (const [token, replacement] of placeholderMarkup.entries())
        markup = markup.split(token).join(replacement);

    linkPlaceholders.forEach((href, index) => {
        const escapedHref = GLib.markup_escape_text(href, -1);
        markup = markup
            .split(`__SCENE_LINK_${index}_OPEN__`)
            .join(href ? `<a href="${escapedHref}">` : '<u>')
            .split(`__SCENE_LINK_${index}_CLOSE__`)
            .join(href ? '</a>' : '</u>');
    });

    return balanceScenePropertyMarkup(markup);
}

function scenePropertyUsesCenteredMarkup(text) {
    return typeof text === 'string' && /<center\b/i.test(text);
}

function parseScenePropertyImages(text) {
    if (typeof text !== 'string')
        return [];

    const images = [];
    const imagePattern = /<img\b([^>]*)\/?>/gi;
    let match = null;

    while ((match = imagePattern.exec(text)) !== null) {
        const attributes = match[1] ?? '';
        const getAttribute = attributeName => {
            const quotedMatch = attributes.match(new RegExp(`\\b${attributeName}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
            const unquotedMatch = attributes.match(new RegExp(`\\b${attributeName}\\s*=\\s*([^\\s>]+)`, 'i'));
            return decodeScenePropertyMarkupEntities(
                quotedMatch?.[2] ?? unquotedMatch?.[1] ?? ''
            ).trim();
        };
        const src = getAttribute('src');
        const width = Number.parseFloat(getAttribute('width'));
        const height = Number.parseFloat(getAttribute('height'));

        if (!src)
            continue;

        images.push({
            src,
            width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
            height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
        });
    }

    return images;
}

function formatScenePropertyDisplayTitle(text, fallback = _('Untitled')) {
    const label = stripScenePropertyMarkup(text);
    if (label)
        return label;

    return parseScenePropertyImages(text).length > 0 ? '' : fallback;
}

function getInspectorContentMaxWidth(suffixWidth = 0) {
    return Math.max(
        96,
        SCENE_PROPERTY_PANEL_WIDTH - INSPECTOR_ROW_HORIZONTAL_MARGIN - INSPECTOR_ROW_CONTROL_SPACING - suffixWidth - 24
    );
}

function getColorComponentCount(defaultValue) {
    if (typeof defaultValue !== 'string')
        return 3;

    const components = defaultValue
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
    return components.length >= 4 ? 4 : 3;
}

function parseScenePropertyColor(value) {
    const rgba = new Gdk.RGBA();
    if (typeof value === 'string') {
        const components = value
            .trim()
            .split(/[\s,]+/)
            .map(component => Number.parseFloat(component))
            .filter(Number.isFinite);

        if (components.length >= 3) {
            rgba.red = components[0];
            rgba.green = components[1];
            rgba.blue = components[2];
            rgba.alpha = components[3] ?? 1.0;
            return rgba;
        }

        try {
            if (rgba.parse(value))
                return rgba;
        } catch (_e) {
        }
    }

    rgba.red = 1.0;
    rgba.green = 1.0;
    rgba.blue = 1.0;
    rgba.alpha = 1.0;
    return rgba;
}

function serializeScenePropertyColor(rgba, defaultValue) {
    const componentCount = getColorComponentCount(defaultValue);
    const components = [
        rgba.red,
        rgba.green,
        rgba.blue,
        rgba.alpha,
    ].slice(0, componentCount);

    return components
        .map(component => {
            const rounded = Math.round(component * 1000000) / 1000000;
            return `${rounded}`;
        })
        .join(' ');
}

function getStepDigits(step) {
    if (typeof step !== 'number' || !Number.isFinite(step))
        return 0;

    const trimmed = `${step}`.replace(/0+$/, '');
    const dotIndex = trimmed.indexOf('.');
    return dotIndex >= 0 ? trimmed.length - dotIndex - 1 : 0;
}

function createProjectBrowserDialog(window, settings) {
    const currentProjectKey = 'project-path';
    const libraryKey = 'change-wallpaper-directory-path';
    const filterStateKey = ProjectBrowserFilterKey.STATE;

    const dialog = new Gtk.Dialog({
        title: _('Choose Wallpaper'),
        transient_for: window,
        modal: true,
        default_width: 1120,
        default_height: 760,
    });
    dialog.add_button(_('Close'), Gtk.ResponseType.CLOSE);
    dialog.connect('response', () => dialog.destroy());

    const content = dialog.get_content_area();
    content.set_spacing(12);
    content.set_margin_top(12);
    content.set_margin_bottom(12);
    content.set_margin_start(12);
    content.set_margin_end(12);

    const header = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
    });
    content.append(header);

    const selectedLabel = new Gtk.Label({
        xalign: 0,
        wrap: false,
        ellipsize: Pango.EllipsizeMode.END,
        css_classes: ['heading'],
    });
    const libraryLabel = new Gtk.Label({
        xalign: 0,
        wrap: false,
        ellipsize: Pango.EllipsizeMode.MIDDLE,
        css_classes: ['dim-label'],
    });
    header.append(selectedLabel);
    header.append(libraryLabel);

    const toolbar = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
    });
    const searchRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
    });
    const searchEntry = new Gtk.SearchEntry({
        hexpand: true,
        placeholder_text: _('Search wallpapers'),
    });
    const filterButton = new Gtk.MenuButton({
        label: _('Filter'),
        valign: Gtk.Align.CENTER,
    });
    const filterPopover = new Gtk.Popover({
        position: Gtk.PositionType.BOTTOM,
        has_arrow: true,
    });
    const filterPopoverScrolled = new Gtk.ScrolledWindow({
        min_content_width: 280,
        min_content_height: 360,
        max_content_height: 420,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
    });
    const filterPopoverContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    const filterPopoverHeader = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
    });
    const filterPopoverDescription = new Gtk.Label({
        label: _('Show or hide wallpapers by category'),
        xalign: 0,
        wrap: true,
        hexpand: true,
        css_classes: ['dim-label'],
    });
    const filterResetButton = new Gtk.Button({
        label: _('Reset'),
        valign: Gtk.Align.START,
    });
    const filterSectionsBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
    });
    filterPopoverHeader.append(filterPopoverDescription);
    filterPopoverHeader.append(filterResetButton);
    filterPopoverContent.append(filterPopoverHeader);
    filterPopoverContent.append(filterSectionsBox);
    filterPopoverScrolled.set_child(filterPopoverContent);
    filterPopover.set_child(filterPopoverScrolled);
    filterButton.set_popover(filterPopover);
    searchRow.append(searchEntry);
    searchRow.append(filterButton);
    toolbar.append(searchRow);
    content.append(toolbar);

    const body = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        hexpand: true,
        vexpand: true,
    });
    content.append(body);

    const browserPane = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        vexpand: true,
    });
    body.append(browserPane);

    const scrolled = new Gtk.ScrolledWindow({
        min_content_height: 600,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        hexpand: true,
        vexpand: true,
    });
    const flowBox = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        column_spacing: PROJECT_FLOWBOX_ITEM_SPACING,
        row_spacing: PROJECT_FLOWBOX_ITEM_SPACING,
        min_children_per_line: 1,
        max_children_per_line: 6,
        hexpand: true,
        valign: Gtk.Align.START,
        homogeneous: false,
        // Keep the outer edge gap matched to the internal gap so the compact
        // wallpaper grid has no leftover border padding around the first or
        // last preview card.
        margin_top: PROJECT_FLOWBOX_ITEM_SPACING,
        margin_bottom: PROJECT_FLOWBOX_ITEM_SPACING,
        margin_start: PROJECT_FLOWBOX_ITEM_SPACING,
        margin_end: PROJECT_FLOWBOX_ITEM_SPACING,
    });
    flowBox.set_homogeneous(false);
    flowBox.set_selection_mode(Gtk.SelectionMode.NONE);
    scrolled.set_child(flowBox);
    browserPane.append(scrolled);

    const placeholder = new Gtk.Label({
        xalign: 0,
        wrap: true,
        css_classes: ['dim-label'],
    });
    browserPane.append(placeholder);

    const inspectorPane = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        width_request: SCENE_PROPERTY_PANEL_WIDTH,
        hexpand: false,
        vexpand: true,
    });
    inspectorPane.set_size_request(SCENE_PROPERTY_PANEL_WIDTH, -1);
    body.append(inspectorPane);

    const inspectorScrolled = new Gtk.ScrolledWindow({
        hexpand: false,
        vexpand: true,
        min_content_width: SCENE_PROPERTY_PANEL_WIDTH,
        max_content_width: SCENE_PROPERTY_PANEL_WIDTH,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        propagate_natural_width: false,
    });
    inspectorPane.append(inspectorScrolled);

    const inspectorStack = new Gtk.Stack({
        hexpand: false,
        vexpand: true,
    });
    inspectorScrolled.set_child(inspectorStack);

    const inspectorMessage = new Gtk.Label({
        xalign: 0,
        yalign: 0,
        wrap: true,
        css_classes: ['dim-label'],
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    inspectorStack.add_named(inspectorMessage, 'message');

    const inspectorContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        hexpand: false,
        margin_top: 4,
        margin_bottom: 4,
    });
    inspectorStack.add_named(inspectorContent, 'content');

    let currentQuery = '';
    let currentInspectorProject = null;
    let currentInspectorOverrides = {};
    let currentProjectsByPath = new Map();
    let currentFilterTagOptions = getProjectFilterTagOptions([]);
    let inspectorSections = [];
    const sceneImageSession = new Soup.Session();
    const cards = [];
    // The Browse dialog owns one thumbnail queue. Destroying the dialog cancels
    // pending preview IO and prevents late async callbacks from touching widgets
    // that GTK has already removed from the preferences window.
    const previewQueue = createProjectPreviewLoadQueue();
    let syncingFilterControls = false;
    const filterControls = {
        type: new Map(),
        contentrating: new Map(),
        tags: new Map(),
    };

    dialog.connect('destroy', () => previewQueue.destroy());

    const projectMatchesCurrentFilters = project => {
        const query = currentQuery.trim().toLowerCase();
        if (query && !buildProjectSearchText(project).includes(query))
            return false;

        return projectMatchesFilter(
            project,
            getProjectFilterFromSettings(settings, currentFilterTagOptions)
        );
    };

    const clearChildren = box => {
        while (true) {
            const child = box.get_first_child();
            if (!child)
                break;
            box.remove(child);
        }
    };

    const createFilterSection = (title, sectionKey, items) => {
        const section = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
        });
        const heading = new Gtk.Label({
            label: title,
            xalign: 0,
            css_classes: ['heading'],
        });
        const list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
        });

        items.forEach(item => {
            const button = new Gtk.CheckButton({
                label: item.label,
                halign: Gtk.Align.START,
            });
            button.connect('toggled', checkbox => {
                if (syncingFilterControls)
                    return;

                const filterState = getProjectFilterFromSettings(settings, currentFilterTagOptions);
                filterState[sectionKey][item.key] = checkbox.active;
                setProjectFilterInSettings(settings, filterState, currentFilterTagOptions);
            });
            filterControls[sectionKey].set(item.key, button);
            list.append(button);
        });

        section.append(heading);
        section.append(list);
        return section;
    };

    const syncFilterControls = () => {
        const filterState = getProjectFilterFromSettings(settings, currentFilterTagOptions);
        syncingFilterControls = true;
        Object.entries(filterControls).forEach(([sectionKey, controls]) => {
            controls.forEach((button, key) => {
                button.active = filterState[sectionKey][key] !== false;
            });
        });
        syncingFilterControls = false;
    };

    const rebuildFilterControls = projects => {
        currentFilterTagOptions = getProjectFilterTagOptions(projects);
        Object.values(filterControls).forEach(controls => controls.clear());
        clearChildren(filterSectionsBox);

        filterSectionsBox.append(createFilterSection(_('Type'), 'type', [
            {key: 'scene', label: _('Scene')},
            {key: 'web', label: _('Web')},
            {key: 'video', label: _('Video')},
        ]));
        filterSectionsBox.append(createFilterSection(_('Age'), 'contentrating', ProjectContentRatings.map(rating => ({
            key: rating,
            label: rating,
        }))));
        filterSectionsBox.append(createFilterSection(_('Genre'), 'tags', currentFilterTagOptions.map(tag => ({
            key: tag,
            label: tag,
        }))));

        syncFilterControls();
    };

    filterResetButton.connect('clicked', () => {
        setProjectFilterInSettings(settings, null, currentFilterTagOptions);
    });

    const resolveSceneImageFile = source => {
        if (!source || /^https?:\/\//i.test(source))
            return null;

        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source))
            return Gio.File.new_for_uri(source);

        if (GLib.path_is_absolute(source))
            return Gio.File.new_for_path(source);

        if (!currentInspectorProject?.path)
            return null;

        return Gio.File.new_for_path(GLib.build_filenamev([currentInspectorProject.path, source]));
    };

    const createSceneImageWidget = (image, maxWidth) => {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        });
        const picture = new Gtk.Picture({
            can_shrink: true,
            content_fit: Gtk.ContentFit.SCALE_DOWN,
            halign: Gtk.Align.START,
            visible: false,
        });
        const spinner = new Gtk.Spinner({
            spinning: true,
            halign: Gtk.Align.START,
        });
        const errorLabel = new Gtk.Label({
            xalign: 0,
            wrap: true,
            visible: false,
            css_classes: ['dim-label'],
            label: _('Image unavailable'),
        });

        picture.set_size_request(
            Math.min(image.width ?? maxWidth, maxWidth),
            image.height ?? -1
        );
        box.append(spinner);
        box.append(picture);
        box.append(errorLabel);

        const showError = () => {
            spinner.visible = false;
            picture.visible = false;
            errorLabel.visible = true;
        };

        const applyTexture = texture => {
            spinner.visible = false;
            errorLabel.visible = false;
            picture.visible = true;
            picture.set_paintable(texture);

            if (!image.width)
                picture.width_request = Math.min(texture.get_width(), maxWidth);
            if (!image.height)
                picture.height_request = -1;
        };

        try {
            if (/^https?:\/\//i.test(image.src)) {
                const message = Soup.Message.new('GET', image.src);
                sceneImageSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        applyTexture(Gdk.Texture.new_from_bytes(bytes));
                    } catch (_error) {
                        showError();
                    }
                });
            } else {
                const file = resolveSceneImageFile(image.src);
                if (!file) {
                    showError();
                    return box;
                }
                applyTexture(Gdk.Texture.new_from_file(file));
            }
        } catch (_error) {
            showError();
        }

        return box;
    };

    const buildSceneImageStrip = (text, maxWidth) => {
        const images = parseScenePropertyImages(text);
        if (images.length === 0)
            return null;

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            margin_top: 4,
            margin_bottom: 4,
            width_request: maxWidth,
        });
        images.forEach(image => {
            box.append(createSceneImageWidget(image, maxWidth));
        });
        return box;
    };

    const buildSceneMarkupContentWidget = (text, fallback, maxWidth) => {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: false,
            valign: Gtk.Align.CENTER,
        });
        const plainText = formatScenePropertyDisplayTitle(text, fallback);
        if (plainText) {
            const textLabel = new Gtk.Label({
                label: formatScenePropertyMarkup(text, fallback),
                use_markup: true,
                xalign: scenePropertyUsesCenteredMarkup(text) ? 0.5 : 0,
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                justify: scenePropertyUsesCenteredMarkup(text)
                    ? Gtk.Justification.CENTER
                    : Gtk.Justification.LEFT,
                max_width_chars: 36,
                selectable: true,
                tooltip_text: plainText,
                width_request: maxWidth,
            });
            box.append(textLabel);
        }

        const imageStrip = buildSceneImageStrip(text, maxWidth);
        if (imageStrip)
            box.append(imageStrip);

        const clamp = new Adw.Clamp({
            maximum_size: maxWidth,
            tightening_threshold: maxWidth,
            hexpand: false,
            halign: Gtk.Align.START,
        });
        clamp.set_child(box);
        return clamp;
    };

    const createInspectorControlRow = ({title, tooltipText, contentWidget, suffixWidget = null}) => {
        const row = new Adw.PreferencesRow({
            title: title || _('Untitled'),
        });
        row.tooltip_text = tooltipText || null;

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            hexpand: true,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        contentWidget.hexpand = true;
        contentWidget.halign = Gtk.Align.FILL;
        box.append(contentWidget);
        if (suffixWidget) {
            suffixWidget.valign = Gtk.Align.CENTER;
            suffixWidget.halign = Gtk.Align.END;
            box.append(suffixWidget);
        }
        row.set_child(box);
        return row;
    };

    const updateLabels = () => {
        selectedLabel.label = `${_('Current')}: ${formatProjectSubtitle(settings.get_string(currentProjectKey))}`;
        selectedLabel.tooltip_text = settings.get_string(currentProjectKey);
        libraryLabel.label = `${_('Steam Library')}: ${formatLibrarySubtitle(settings.get_string(libraryKey))}`;
        libraryLabel.tooltip_text = formatLibrarySubtitle(settings.get_string(libraryKey));
    };

    const clearInspectorContent = () => {
        while (true) {
            const child = inspectorContent.get_first_child();
            if (!child)
                break;
            inspectorContent.remove(child);
        }
        inspectorSections = [];
    };

    const openPathChooser = (property, row) => {
        const chooser = new Gtk.FileChooserDialog({
            title: formatScenePropertyLabel(property.text, property.name),
            transient_for: dialog,
            modal: true,
            action: property.type === ScenePropertyType.DIRECTORY
                ? Gtk.FileChooserAction.SELECT_FOLDER
                : Gtk.FileChooserAction.OPEN,
        });
        chooser.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        chooser.add_button(_('Open'), Gtk.ResponseType.ACCEPT);

        if (row.text) {
            const currentFile = Gio.File.new_for_path(row.text);
            if (currentFile.query_exists(null))
                chooser.set_file(currentFile);
        }

        chooser.connect('response', (chooserDialog, responseId) => {
            if (responseId === Gtk.ResponseType.ACCEPT) {
                const file = chooserDialog.get_file();
                row.text = file?.get_path() ?? '';
            }
            chooserDialog.destroy();
        });
        chooser.show();
    };

    const persistInspectorOverrides = (property, rawValue) => {
        if (!currentInspectorProject)
            return;

        const nextValue = normalizeScenePropertyValue(property.type, rawValue, property.defaultValue);
        if (areScenePropertyValuesEqual(property.type, nextValue, property.defaultValue))
            delete currentInspectorOverrides[property.name];
        else
            currentInspectorOverrides[property.name] = nextValue;

        currentInspectorOverrides = setProjectPropertyOverrides(
            settings,
            currentInspectorProject,
            currentInspectorOverrides
        );
        updateInspectorSensitivity();
    };

    function createInspectorPropertyWidget(property) {
        const title = formatScenePropertyDisplayTitle(property.text, property.name);
        const currentValue = normalizeScenePropertyValue(
            property.type,
            currentInspectorOverrides[property.name],
            property.defaultValue
        );

        switch (property.type) {
        case ScenePropertyType.BOOL: {
            const contentMaxWidth = getInspectorContentMaxWidth(INSPECTOR_NARROW_CONTROL_WIDTH);
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            const toggle = new Gtk.Switch({
                active: currentValue,
                valign: Gtk.Align.CENTER,
            });
            toggle.connect('notify::active', () => {
                persistInspectorOverrides(property, toggle.active);
            });
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget: toggle,
            });
        }
        case ScenePropertyType.SLIDER: {
            const contentMaxWidth = getInspectorContentMaxWidth(INSPECTOR_WIDE_CONTROL_WIDTH);
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            const lower = property.min ?? 0;
            const upper = property.max ?? Math.max(lower + 1, currentValue);
            const digits = getStepDigits(property.step);
            const adjustment = new Gtk.Adjustment({
                lower: Math.min(lower, upper),
                upper: Math.max(lower, upper),
                step_increment: property.step ?? 0.1,
                page_increment: Math.max((property.step ?? 0.1) * 10, 1),
                value: currentValue,
            });
            const scale = new Gtk.Scale({
                orientation: Gtk.Orientation.HORIZONTAL,
                adjustment,
                digits,
                draw_value: true,
                value_pos: Gtk.PositionType.RIGHT,
                width_request: 180,
                valign: Gtk.Align.CENTER,
            });
            adjustment.connect('value-changed', () => {
                persistInspectorOverrides(property, adjustment.value);
            });
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget: scale,
            });
        }
        case ScenePropertyType.COMBO: {
            const contentMaxWidth = getInspectorContentMaxWidth(INSPECTOR_WIDE_CONTROL_WIDTH);
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            if (property.options.length === 0) {
                const unsupported = new Gtk.Label({
                    label: _('No options available'),
                    xalign: 1,
                    wrap: true,
                    css_classes: ['dim-label'],
                });
                return createInspectorControlRow({
                    title: title || property.name,
                    tooltipText: title,
                    contentWidget,
                    suffixWidget: unsupported,
                });
            }

            const labels = property.options.map(option => formatScenePropertyLabel(option.text, option.value));
            const dropdown = new Gtk.DropDown({
                model: Gtk.StringList.new(labels),
                valign: Gtk.Align.CENTER,
                width_request: 180,
            });
            const currentIndex = Math.max(
                0,
                property.options.findIndex(option => option.value === `${currentValue}`)
            );
            dropdown.selected = currentIndex >= 0 ? currentIndex : 0;
            dropdown.connect('notify::selected', () => {
                const option = property.options[dropdown.selected];
                if (option)
                    persistInspectorOverrides(property, option.value);
            });
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget: dropdown,
            });
        }
        case ScenePropertyType.COLOR: {
            const contentMaxWidth = getInspectorContentMaxWidth(INSPECTOR_NARROW_CONTROL_WIDTH);
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            const colorButton = new Gtk.ColorButton({
                valign: Gtk.Align.CENTER,
                use_alpha: getColorComponentCount(property.defaultValue) >= 4,
            });
            colorButton.set_rgba(parseScenePropertyColor(currentValue));
            colorButton.connect('color-set', button => {
                persistInspectorOverrides(
                    property,
                    serializeScenePropertyColor(button.get_rgba(), property.defaultValue)
                );
            });
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget: colorButton,
            });
        }
        case ScenePropertyType.TEXT_INPUT:
        case ScenePropertyType.FILE:
        case ScenePropertyType.DIRECTORY:
        case ScenePropertyType.SCENE_TEXTURE: {
            const contentMaxWidth = getInspectorContentMaxWidth(INSPECTOR_WIDE_CONTROL_WIDTH);
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            const entry = new Gtk.Entry({
                text: currentValue,
                valign: Gtk.Align.CENTER,
                width_request: 180,
            });
            entry.connect('notify::text', entryWidget => {
                persistInspectorOverrides(property, entryWidget.text);
            });

            let suffixWidget = entry;
            if ([ScenePropertyType.FILE, ScenePropertyType.DIRECTORY, ScenePropertyType.SCENE_TEXTURE].includes(property.type)) {
                const entryBox = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 6,
                    valign: Gtk.Align.CENTER,
                });
                const browseButton = new Gtk.Button({
                    icon_name: 'document-open-symbolic',
                    valign: Gtk.Align.CENTER,
                });
                browseButton.connect('clicked', () => openPathChooser(property, entry));
                entryBox.append(entry);
                entryBox.append(browseButton);
                suffixWidget = entryBox;
            }
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget,
            });
        }
        case ScenePropertyType.TEXT: {
            const contentMaxWidth = getInspectorContentMaxWidth();
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
            });
        }
        default:
        {
            const contentMaxWidth = getInspectorContentMaxWidth();
            const contentWidget = buildSceneMarkupContentWidget(property.text, property.name, contentMaxWidth);
            const unsupported = new Gtk.Label({
                label: _('Unsupported setting type'),
                xalign: 1,
                wrap: true,
                css_classes: ['dim-label'],
            });
            return createInspectorControlRow({
                title: title || property.name,
                tooltipText: title,
                contentWidget,
                suffixWidget: unsupported,
            });
        }
        }
    }

    function updateInspectorSensitivity() {
        if (!currentInspectorProject)
            return;

        const valueMap = buildScenePropertyValueMap(currentInspectorProject, currentInspectorOverrides);
        const enabledMap = new Map();

        inspectorSections.forEach(section => {
            const groupEnabled = section.groupProperty
                ? isScenePropertyVisible(currentInspectorProject, section.groupProperty, valueMap, enabledMap)
                : true;

            section.rows.forEach(entry => {
                const rowEnabled = isScenePropertyVisible(
                    currentInspectorProject,
                    entry.property,
                    valueMap,
                    enabledMap
                );
                entry.widget.sensitive = groupEnabled && rowEnabled;
            });

            if (section.groupHeader) {
                section.groupHeader.visible = section.rows.length > 0;
                section.groupHeader.sensitive = groupEnabled;
            }
            section.groupWidget.visible = section.rows.length > 0;
            section.groupWidget.sensitive = groupEnabled;
        });
    }

    function showInspectorMessage(project, message) {
        clearInspectorContent();
        currentInspectorProject = project ?? null;
        currentInspectorOverrides = {};
        inspectorMessage.label = message;
        inspectorStack.set_visible_child_name('message');
    }

    function buildInspector(project) {
        clearInspectorContent();
        currentInspectorProject = project;
        currentInspectorOverrides = getProjectPropertyOverrides(settings, project);

        if ((project.sceneProperties?.length ?? 0) === 0) {
            showInspectorMessage(project, _('This wallpaper has no configurable properties'));
            return;
        }

        const sections = [];
        let currentSection = {
            groupProperty: null,
            properties: [],
        };
        sections.push(currentSection);

        for (const property of project.sceneProperties) {
            if (property.type === ScenePropertyType.GROUP) {
                currentSection = {
                    groupProperty: property,
                    properties: [],
                };
                sections.push(currentSection);
                continue;
            }
            currentSection.properties.push(property);
        }

        inspectorSections = sections.map(section => {
            const groupWidget = new Adw.PreferencesGroup();
            let groupHeader = null;
            if (section.groupProperty) {
                const fullTitle = formatScenePropertyDisplayTitle(section.groupProperty.text, section.groupProperty.name);
                groupHeader = buildSceneMarkupContentWidget(
                    section.groupProperty.text,
                    section.groupProperty.name,
                    getInspectorContentMaxWidth()
                );
                groupHeader.tooltip_text = fullTitle || null;
                groupHeader.add_css_class('heading');
                groupHeader.margin_top = 6;
                inspectorContent.append(groupHeader);
            }

            const rows = [];
            section.properties.forEach(property => {
                const widget = createInspectorPropertyWidget(property);
                rows.push({property, widget});
                groupWidget.add(widget);
            });
            inspectorContent.append(groupWidget);
            return {
                ...section,
                groupHeader,
                groupWidget,
                rows,
            };
        });

        inspectorStack.set_visible_child_name('content');
        updateInspectorSensitivity();
    }

    const refreshInspector = () => {
        const currentPath = settings.get_string(currentProjectKey);
        const project = currentProjectsByPath.get(currentPath) ?? loadProject(currentPath);
        if (!project) {
            showInspectorMessage(null, _('Select a wallpaper to configure its properties'));
            return;
        }
        buildInspector(project);
    };

    const syncSelectionState = () => {
        const currentPath = settings.get_string(currentProjectKey);
        cards.forEach(({project, card}) => {
            if (project.path === currentPath)
                card.add_css_class('suggested-action');
            else
                card.remove_css_class('suggested-action');
        });
        updateLabels();
    };

    const updateEmptyState = () => {
        const visibleChildren = cards.filter(({project}) => projectMatchesCurrentFilters(project)).length;
        const hasVisibleCards = visibleChildren > 0;
        scrolled.visible = hasVisibleCards;
        placeholder.visible = !hasVisibleCards;
        if (!hasVisibleCards)
            placeholder.label = cards.length > 0 ? _('No wallpapers match your search or filters') : placeholder.label;
    };

    const rebuild = () => {
        const projects = listProjects(settings.get_string(libraryKey));
        currentProjectsByPath = new Map(projects.map(project => [project.path, project]));
        rebuildFilterControls(projects);
        while (true) {
            const child = flowBox.get_first_child();
            if (!child)
                break;
            flowBox.remove(child);
        }
        cards.length = 0;

        const hasProjects = projects.length > 0;
        scrolled.visible = hasProjects;
        placeholder.visible = !hasProjects;
        if (!hasProjects) {
            placeholder.label = settings.get_string(libraryKey)
                ? _('No wallpaper projects were found in this Steam library')
                : _('Choose a Steam library first');
            updateLabels();
            refreshInspector();
            return;
        }

        projects.forEach(project => {
            const card = createProjectCard(project, selectedProject => {
                settings.set_string(currentProjectKey, selectedProject.path);
                syncSelectionState();
                buildInspector(selectedProject);
            }, previewQueue);
            const flowChild = new Gtk.FlowBoxChild({
                halign: Gtk.Align.START,
                hexpand: false,
            });
            flowChild.set_size_request(PROJECT_CARD_WIDTH, -1);
            flowChild.set_child(card);
            cards.push({project, card});
            flowBox.append(flowChild);
        });

        flowBox.invalidate_filter();
        updateEmptyState();
        syncSelectionState();
        refreshInspector();
    };

    flowBox.set_filter_func(child => {
        const item = cards.find(entry => entry.card === child.get_child());
        if (!item)
            return false;

        return projectMatchesCurrentFilters(item.project);
    });

    searchEntry.connect('search-changed', entry => {
        currentQuery = entry.text ?? '';
        flowBox.invalidate_filter();
        updateEmptyState();
    });

    connectTracked(window, settings, `changed::${currentProjectKey}`, () => {
        syncSelectionState();
        refreshInspector();
    });
    connectTracked(window, settings, `changed::${libraryKey}`, () => {
        rebuild();
    });
    connectTracked(window, settings, `changed::${filterStateKey}`, () => {
        syncFilterControls();
        flowBox.invalidate_filter();
        updateEmptyState();
    });
    showInspectorMessage(null, _('Select a wallpaper to configure its properties'));
    rebuild();
    return dialog;
}

export function prefsRowProjectChooser(window, prefsGroup) {
    const settings = window._settings;
    const currentProjectKey = 'project-path';

    const row = new Adw.ActionRow({
        title: _('Wallpaper'),
        subtitle: formatProjectSubtitle(settings.get_string(currentProjectKey)),
    });
    prefsGroup.add(row);

    const button = new Adw.ButtonContent({
        icon_name: 'view-grid-symbolic',
        label: _('Browse'),
    });
    row.activatable_widget = button;
    row.add_suffix(button);

    row.connect('activated', () => {
        const dialog = createProjectBrowserDialog(window, settings);
        dialog.present();
    });

    connectTracked(window, settings, `changed::${currentProjectKey}`, () => {
        row.subtitle = formatProjectSubtitle(settings.get_string(currentProjectKey));
    });
}
