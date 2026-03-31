import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {listProjects, loadProject} from '../project.js';
import {connectTracked} from './rows.js';

const haveContentFit = Gtk.get_minor_version() >= 8;
const PROJECT_CARD_WIDTH = 180;
const PROJECT_FLOWBOX_COLUMN_SPACING = 12;

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
    return path || _('None');
}

export function prefsRowLibraryPath(window, prefsGroup) {
    const settings = window._settings;
    const title = _('Wallpaper Library');
    const key = 'change-wallpaper-directory-path';

    let path = settings.get_string(key);
    const row = new Adw.ActionRow({
        title,
        subtitle: formatLibrarySubtitle(path),
    });
    prefsGroup.add(row);

    function createDialog() {
        let fileChooser = new Gtk.FileChooserDialog({
            title: _('Select Wallpaper Library'),
            action: Gtk.FileChooserAction.SELECT_FOLDER,
        });
        fileChooser.set_modal(true);
        fileChooser.set_transient_for(window);
        fileChooser.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        fileChooser.add_button(_('Open'), Gtk.ResponseType.ACCEPT);

        fileChooser.connect('response', (dialog, responseId) => {
            if (responseId === Gtk.ResponseType.ACCEPT) {
                let _path = dialog.get_file().get_path();
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
        row.subtitle = formatLibrarySubtitle(settings.get_string(key));
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

function createProjectPreview(project) {
    if (!project.previewPath) {
        const placeholder = new Gtk.Box({
            hexpand: false,
            vexpand: false,
            css_classes: ['card'],
        });
        placeholder.set_size_request(PROJECT_CARD_WIDTH, PROJECT_CARD_WIDTH);
        return placeholder;
    }

    if (project.previewPath.toLowerCase().endsWith('.gif'))
        return createAnimatedProjectPreview(project.previewPath);

    try {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
            project.previewPath,
            PROJECT_CARD_WIDTH,
            PROJECT_CARD_WIDTH,
            true
        );
        const texture = Gdk.Texture.new_for_pixbuf(pixbuf);
        const picture = new Gtk.Picture({
            paintable: texture,
            hexpand: false,
            vexpand: false,
            can_shrink: true,
        });
        picture.set_size_request(PROJECT_CARD_WIDTH, PROJECT_CARD_WIDTH);
        if (haveContentFit)
            picture.set_content_fit(Gtk.ContentFit.COVER);
        return picture;
    } catch (_e) {
        const picture = Gtk.Picture.new_for_file(Gio.File.new_for_path(project.previewPath));
        picture.set({
            hexpand: false,
            vexpand: false,
            can_shrink: true,
        });
        picture.set_size_request(PROJECT_CARD_WIDTH, PROJECT_CARD_WIDTH);
        if (haveContentFit)
            picture.set_content_fit(Gtk.ContentFit.COVER);
        return picture;
    }
}

function createAnimatedProjectPreview(path) {
    const image = new Gtk.Picture({
        hexpand: false,
        vexpand: false,
        can_shrink: true,
    });
    image.set_size_request(PROJECT_CARD_WIDTH, PROJECT_CARD_WIDTH);
    if (haveContentFit)
        image.set_content_fit(Gtk.ContentFit.COVER);

    try {
        const animation = GdkPixbuf.PixbufAnimation.new_from_file(path);
        const iter = animation.get_iter(null);
        const frameTextures = new Map();
        let timerId = 0;
        let destroyed = false;

        const updateFrame = () => {
            if (destroyed)
                return GLib.SOURCE_REMOVE;

            const pixbuf = iter.get_pixbuf();
            if (pixbuf) {
                let texture = frameTextures.get(pixbuf);
                if (!texture) {
                    const scaled = pixbuf.scale_simple(
                        PROJECT_CARD_WIDTH,
                        PROJECT_CARD_WIDTH,
                        GdkPixbuf.InterpType.BILINEAR
                    ) ?? pixbuf;
                    texture = Gdk.Texture.new_for_pixbuf(scaled);
                    frameTextures.set(pixbuf, texture);
                }
                image.set_paintable(texture);
            }

            const delay = Math.max(iter.get_delay_time(), 16);
            timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                if (destroyed) {
                    timerId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                timerId = 0;
                iter.advance(null);
                return updateFrame();
            });
            return GLib.SOURCE_REMOVE;
        };

        updateFrame();
        image.connect('destroy', () => {
            destroyed = true;
            if (timerId) {
                GLib.source_remove(timerId);
                timerId = 0;
            }
            frameTextures.clear();
            image.set_paintable(null);
        });
    } catch (_e) {
        const picture = Gtk.Picture.new_for_file(Gio.File.new_for_path(path));
        picture.set({
            hexpand: false,
            vexpand: false,
            can_shrink: true,
        });
        picture.set_size_request(PROJECT_CARD_WIDTH, PROJECT_CARD_WIDTH);
        if (haveContentFit)
            picture.set_content_fit(Gtk.ContentFit.COVER);
        return picture;
    }

    return image;
}

function createProjectCard(project, onActivate) {
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

    const preview = createProjectPreview(project);
    preview.set({
        hexpand: false,
        vexpand: false,
    });
    preview.set_size_request(PROJECT_CARD_WIDTH, PROJECT_CARD_WIDTH);

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

    const gesture = new Gtk.GestureClick({button: 0});
    gesture.connect('released', () => onActivate(project));
    root.add_controller(gesture);

    return root;
}

function createProjectBrowserDialog(window, settings) {
    const currentProjectKey = 'project-path';
    const libraryKey = 'change-wallpaper-directory-path';

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
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
    });
    const searchEntry = new Gtk.SearchEntry({
        hexpand: true,
        placeholder_text: _('Search wallpapers'),
    });
    toolbar.append(searchEntry);
    content.append(toolbar);

    const scrolled = new Gtk.ScrolledWindow({
        min_content_height: 600,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        hexpand: true,
        vexpand: true,
    });
    const flowBox = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        column_spacing: PROJECT_FLOWBOX_COLUMN_SPACING,
        row_spacing: 12,
        min_children_per_line: 1,
        max_children_per_line: 6,
        hexpand: true,
        valign: Gtk.Align.START,
        homogeneous: false,
        margin_top: 4,
        margin_bottom: 4,
        margin_start: 4,
        margin_end: 4,
    });
    flowBox.set_homogeneous(false);
    flowBox.set_selection_mode(Gtk.SelectionMode.NONE);
    scrolled.set_child(flowBox);
    content.append(scrolled);

    const placeholder = new Gtk.Label({
        xalign: 0,
        wrap: true,
        css_classes: ['dim-label'],
    });
    content.append(placeholder);

    let currentQuery = '';
    const cards = [];

    const updateLabels = () => {
        selectedLabel.label = `${_('Current')}: ${formatProjectSubtitle(settings.get_string(currentProjectKey))}`;
        selectedLabel.tooltip_text = settings.get_string(currentProjectKey);
        libraryLabel.label = `${_('Library')}: ${formatLibrarySubtitle(settings.get_string(libraryKey))}`;
        libraryLabel.tooltip_text = settings.get_string(libraryKey);
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
        const query = currentQuery.trim().toLowerCase();
        const visibleChildren = cards.filter(({project}) => !query || buildProjectSearchText(project).includes(query)).length;
        const hasVisibleCards = visibleChildren > 0;
        scrolled.visible = hasVisibleCards;
        placeholder.visible = !hasVisibleCards;
        if (!hasVisibleCards)
            placeholder.label = cards.length > 0 ? _('No wallpapers match your search') : placeholder.label;
    };

    const rebuild = () => {
        const projects = listProjects(settings.get_string(libraryKey));
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
                ? _('No wallpaper projects were found in this directory')
                : _('Choose a wallpaper library first');
            updateLabels();
            return;
        }

        projects.forEach(project => {
            const card = createProjectCard(project, selectedProject => {
                settings.set_string(currentProjectKey, selectedProject.path);
                syncSelectionState();
            });
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
    };

    flowBox.set_filter_func(child => {
        const item = cards.find(entry => entry.card === child.get_child());
        if (!item)
            return false;

        const query = currentQuery.trim().toLowerCase();
        return !query || buildProjectSearchText(item.project).includes(query);
    });

    searchEntry.connect('search-changed', entry => {
        currentQuery = entry.text ?? '';
        flowBox.invalidate_filter();
        updateEmptyState();
    });

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
