#!/usr/bin/env gjs

/**
 * Copyright (C) 2024 Jeff Shee (jeffshee8969@gmail.com)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

imports.gi.versions.Gtk = '4.0';
const {GObject, Gtk, Gio, GLib, Gdk, Gst} = imports.gi;

// [major, minor, micro, nano]
const gstVersion = Gst.version();
console.log(`GStreamer version: ${gstVersion.join('.')}`);

// [major, minor, micro]
const gtkVersion = [Gtk.get_major_version(), Gtk.get_minor_version(), Gtk.get_micro_version()];
console.log(`Gtk version: ${gtkVersion.join('.')}`);

const isGstVersionAtLeast = (major, minor) => {
    return gstVersion[0] > major || (gstVersion[0] === major && gstVersion[1] >= minor);
};

const isGtkVersionAtLeast = (major, minor) => {
    return gtkVersion[0] > major || (gtkVersion[0] === major && gtkVersion[1] >= minor);
};

let GstPlay = null;
// GstPlay is available from GStreamer 1.20+
try {
    GstPlay = imports.gi.GstPlay;
} catch (e) {
    console.error(e);
    console.warn('GstPlay, or the typelib is not installed. Renderer will fallback to GtkMediaFile!');
}
const haveGstPlay = GstPlay !== null;

let GstAudio = null;
// Might not pre-installed on some distributions
try {
    GstAudio = imports.gi.GstAudio;
} catch (e) {
    console.error(e);
    console.warn('GstAudio, or the typelib is not installed.');
}
const haveGstAudio = GstAudio !== null;

let WebKit = null;
try {
    for (const version of ['6.0', '4.1', '4.0']) {
        try {
            imports.gi.versions.WebKit = version;
            WebKit = imports.gi.WebKit;
            break;
        } catch (e) {
            WebKit = null;
        }
    }
} catch (_e) {
    WebKit = null;
}
const haveWebKit = WebKit !== null;
if (!haveWebKit)
    console.warn('WebKit, or the typelib is not installed. Web projects will fallback to a placeholder.');

let HanabiScene = null;
try {
    HanabiScene = imports.gi.HanabiScene;
} catch (_e) {
    HanabiScene = null;
}
const haveSceneBackend = HanabiScene !== null;
if (!haveSceneBackend)
    console.warn('HanabiScene typelib is not installed. Scene projects will fallback to a placeholder.');

// ContentFit is available from Gtk 4.8+
const haveContentFit = isGtkVersionAtLeast(4, 8);

// Use glsinkbin for Gst 1.24+
const useGstGL = isGstVersionAtLeast(1, 24);

const rendererDbusName = 'io.github.jeffshee.HanabiRenderer';
let applicationId = rendererDbusName;

let extSettings = null;
const extSchemaId = 'io.github.jeffshee.hanabi-extension';
let settingsSchemaSource = Gio.SettingsSchemaSource.get_default();
const settingsSchema = settingsSchemaSource
    ? settingsSchemaSource.lookup(extSchemaId, false)
    : null;
if (settingsSchema)
    extSettings = Gio.Settings.new(extSchemaId);

const forceGtk4PaintableSink = extSettings
    ? extSettings.get_boolean('force-gtk4paintablesink')
    : false;
const forceMediaFile = extSettings
    ? extSettings.get_boolean('force-mediafile')
    : false;

const isEnableVADecoders = extSettings
    ? extSettings.get_boolean('enable-va')
    : false;
const isEnableNvSl = extSettings
    ? extSettings.get_boolean('enable-nvsl')
    : false;

// Support for dmabus and graphics offload is available from Gtk 4.14+
const isEnableGraphicsOffload = extSettings
    ? extSettings.get_boolean('enable-graphics-offload')
    : false;
const haveGraphicsOffload = isGtkVersionAtLeast(4, 14) && isEnableGraphicsOffload;

let codePath = 'src';
let contentFit = null;
let mute = extSettings ? extSettings.get_boolean('mute') : false;
let nohide = false;
let standalone = false;
let projectPath = extSettings ? extSettings.get_string('project-path') : '';
let volume = extSettings ? extSettings.get_int('volume') / 100.0 : 0.5;
let changeWallpaper = extSettings ? extSettings.get_boolean('change-wallpaper') : true;
let changeWallpaperDirectoryPath = extSettings ? extSettings.get_string('change-wallpaper-directory-path') : '';
let changeWallpaperMode = extSettings ? extSettings.get_int('change-wallpaper-mode') : 0;
let changeWallpaperInterval = extSettings ? extSettings.get_int('change-wallpaper-interval') : 15;
let windowDimension = {width: 1920, height: 1080};
let windowed = false;
let fullscreened = true;
let isDebugMode = extSettings ? extSettings.get_boolean('debug-mode') : true;
let changeWallpaperTimerId = null;
let argvContentFitOverride = false;

const hasArg = arg => ARGV.includes(arg);

if (hasArg('-S') || hasArg('--standalone')) {
    standalone = true;
    applicationId = `${rendererDbusName}.Standalone`;
}

const ProjectType = {
    VIDEO: 'video',
    WEB: 'web',
    SCENE: 'scene',
};

const readJsonFile = path => {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return null;

        return JSON.parse(new TextDecoder().decode(contents));
    } catch (e) {
        return null;
    }
};

const resolveRegularFile = (projectDirPath, relativePath) => {
    if (!relativePath)
        return null;

    const filePath = GLib.build_filenamev([projectDirPath, relativePath]);
    const file = Gio.File.new_for_path(filePath);
    if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.REGULAR)
        return null;

    return filePath;
};

const loadProject = path => {
    if (!path)
        return null;

    const projectDir = Gio.File.new_for_path(path);
    if (projectDir.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY)
        return null;

    const manifestPath = GLib.build_filenamev([path, 'project.json']);
    const manifest = readJsonFile(manifestPath);
    const type = `${manifest?.type ?? ''}`.toLowerCase();
    if (![ProjectType.VIDEO, ProjectType.WEB, ProjectType.SCENE].includes(type))
        return null;

    let entry = typeof manifest?.file === 'string' && manifest.file !== ''
        ? manifest.file
        : null;
    if (!entry && type === ProjectType.WEB)
        entry = 'index.html';

    let entryPath = resolveRegularFile(path, entry);
    if (type === ProjectType.SCENE && !entryPath)
        entryPath = resolveRegularFile(path, 'scene.pkg');
    if (entry && !entryPath && type !== ProjectType.SCENE)
        return null;

    let previewPath = resolveRegularFile(path, manifest?.preview);
    if (!previewPath)
        previewPath = resolveRegularFile(path, 'preview.jpg');

    return {
        type,
        path,
        entryPath,
        previewPath,
    };
};

const listProjects = parentDirPath => {
    const projects = [];
    if (!parentDirPath)
        return projects;

    const dir = Gio.File.new_for_path(parentDirPath);
    if (dir.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY)
        return projects;

    const enumerator = dir.enumerate_children(
        'standard::*',
        Gio.FileQueryInfoFlags.NONE,
        null
    );

    let info;
    while ((info = enumerator.next_file(null))) {
        if (info.get_file_type() !== Gio.FileType.DIRECTORY)
            continue;

        const child = dir.get_child(info.get_name());
        const project = loadProject(child.get_path());
        if (project)
            projects.push(project);
    }

    return projects.sort((a, b) => a.path.localeCompare(b.path));
};

const parseContentFit = value => {
    if (!haveContentFit)
        return null;

    switch (String(value).toLowerCase()) {
    case '0':
    case 'fill':
        return Gtk.ContentFit.FILL;
    case '1':
    case 'contain':
        return Gtk.ContentFit.CONTAIN;
    case '2':
    case 'cover':
        return Gtk.ContentFit.COVER;
    case '3':
    case 'scale-down':
    case 'scaledown':
    case 'scale_down':
        return Gtk.ContentFit.SCALE_DOWN;
    default:
        return null;
    }
};

if (haveContentFit) {
    contentFit = extSettings
        ? extSettings.get_int('content-fit')
        : Gtk.ContentFit.CONTAIN;
}


const HanabiRenderer = GObject.registerClass(
    {
        GTypeName: 'HanabiRenderer',
    },
    class HanabiRenderer extends Gtk.Application {
        constructor() {
            super({
                application_id: applicationId,
                flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
            });

            GLib.log_set_debug_enabled(isDebugMode);

            this._hanabiWindows = [];
            this._pictures = [];
            this._sharedPaintable = null;
            this._gstImplName = '';
            this._project = null;
            this._play = null;
            this._media = null;
            this._webView = null;
            this._webPausePicture = null;
            this._sceneWidgets = [];
            this._isPlaying = false;
            this._dbus = null;
            if (!standalone)
                this._exportDbus();
            this._setupGst();

            this.connect('activate', app => {
                this._display = Gdk.Display.get_default();
                this._monitors = this._display ? [...this._display.get_monitors()] : [];

                let activeWindow = app.activeWindow;
                if (!activeWindow) {
                    this._buildUI();
                    this._hanabiWindows.forEach(window => {
                        window.present();
                    });
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this.setPlay();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });

            this.connect('command-line', (app, commandLine) => {
                let argv = commandLine.get_arguments();
                if (this._parseArgs(argv)) {
                    this.activate();
                    commandLine.set_exit_status(0);
                } else {
                    commandLine.set_exit_status(1);
                }
            });

            extSettings?.connect('changed', (settings, key) => {
                switch (key) {
                case 'project-path':
                    projectPath = settings.get_string(key);
                    this._switchProject();
                    break;
                case 'mute':
                    mute = settings.get_boolean(key);
                    this.setMute(mute);
                    break;
                case 'volume':
                    volume = settings.get_int(key) / 100.0;
                    this.setVolume(volume);
                    break;
                case 'change-wallpaper':
                    changeWallpaper = settings.get_boolean(key);
                    this.setAutoWallpaper();
                    break;
                case 'change-wallpaper-interval':
                    changeWallpaperInterval = settings.get_int(key);
                    this.setAutoWallpaper();
                    break;
                case 'change-wallpaper-directory-path':
                    changeWallpaperDirectoryPath = settings.get_string(key);
                    this.setAutoWallpaper();
                    break;
                case 'change-wallpaper-mode':
                    changeWallpaperMode = settings.get_int(key);
                    break;
                case 'content-fit':
                    if (!haveContentFit)
                        return;
                    if (argvContentFitOverride)
                        return;
                    contentFit = settings.get_int(key);
                    this._pictures.forEach(picture =>
                        picture.set_content_fit(contentFit)
                    );
                    break;
                case 'debug-mode':
                    isDebugMode = settings.get_boolean(key);
                    GLib.log_set_debug_enabled(isDebugMode);
                    break;
                }
            });
        }

        _parseArgs(argv) {
            let lastCommand = null;
            for (let arg of argv) {
                if (!lastCommand) {
                    switch (arg) {
                    case '-M':
                    case '--mute':
                        mute = true;
                        break;
                    case '-N':
                    case '--nohide':
                        // Launch renderer in standalone mode without hiding
                        nohide = true;
                        break;
                    case '-S':
                    case '--standalone':
                        standalone = true;
                        applicationId = `${rendererDbusName}.Standalone`;
                        break;
                    case '-W':
                    case '--windowed':
                    case '-P':
                    case '--codepath':
                    case '-F':
                    case '--project-path':
                    case '-T':
                    case '--fit-mode':
                    case '--content-fit':
                    case '-V':
                    case '--volume':
                        lastCommand = arg;
                        break;
                    default:
                        console.error(`Argument ${arg} not recognized. Aborting.`);
                        return false;
                    }
                    continue;
                }
                switch (lastCommand) {
                case '-W':
                case '--windowed': {
                    windowed = true;
                    let data = arg.split(':');
                    windowDimension = {
                        width: parseInt(data[0]),
                        height: parseInt(data[1]),
                    };
                    break;
                }
                case '-P':
                case '--codepath':
                    codePath = arg;
                    break;
                case '-F':
                case '--project-path':
                    projectPath = arg;
                    break;
                case '-T':
                case '--fit-mode':
                case '--content-fit': {
                    let parsedContentFit = parseContentFit(arg);
                    if (parsedContentFit === null) {
                        console.error(`Invalid content fit "${arg}". Use fill, contain, cover, scale-down or 0-3.`);
                        return false;
                    }
                    contentFit = parsedContentFit;
                    argvContentFitOverride = true;
                    break;
                }
                case '-V':
                case '--volume':
                    volume = Math.max(0.0, Math.min(1.0, parseFloat(arg)));
                    break;
                }
                lastCommand = null;
            }
            return true;
        }

        _setupGst() {
            // Software libav decoders have "primary" rank, set Nvidia higher
            // to use NVDEC hardware acceleration.
            this._setPluginDecodersRank(
                'nvcodec',
                Gst.Rank.PRIMARY + 1,
                isEnableNvSl
            );

            // Legacy "vaapidecodebin" have rank "primary + 2",
            // we need to set VA higher then that to be used
            if (isEnableVADecoders)
                this._setPluginDecodersRank('va', Gst.Rank.PRIMARY + 3);
        }

        _setPluginDecodersRank(pluginName, rank, useStateless = false) {
            let gstRegistry = Gst.Registry.get();
            let features = gstRegistry.get_feature_list_by_plugin(pluginName);

            for (let feature of features) {
                let featureName = feature.get_name();

                if (
                    !featureName.endsWith('dec') &&
                    !featureName.endsWith('postproc')
                )
                    continue;

                let isStateless = featureName.includes('sl');

                if (isStateless !== useStateless)
                    continue;

                let oldRank = feature.get_rank();

                if (rank === oldRank)
                    continue;

                feature.set_rank(rank);
            }
        }

        _buildUI() {
            this._project = loadProject(projectPath);

            this._monitors.forEach((gdkMonitor, index) => {
                let widget = this._getWidgetForMonitor(index);

                let state = {
                    position: [gdkMonitor.get_geometry().x, gdkMonitor.get_geometry().y],
                    keepAtBottom: true,
                    keepMinimized: true,
                    keepPosition: true,
                };
                let window = new HanabiRendererWindow(
                    this,
                    nohide
                        ? `Hanabi Renderer #${index} (using ${this._gstImplName})`
                        : `@${applicationId}!${JSON.stringify(state)}|${index}`,
                    widget,
                    gdkMonitor
                );

                this._hanabiWindows.push(window);
            });
            console.log(`using ${this._gstImplName}`);
        }

        _switchProject() {
            this._project = loadProject(projectPath);
            this._resetBackend();

            this._hanabiWindows.forEach((window, index) => {
                const widget = this._getWidgetForMonitor(index);
                window.setWallpaperWidget(widget);
            });

            this.setVolume(volume);
            this.setMute(mute);
            this.setAutoWallpaper();
        }

        _resetBackend() {
            if (changeWallpaperTimerId) {
                GLib.source_remove(changeWallpaperTimerId);
                changeWallpaperTimerId = null;
            }

            if (this._sceneWidgets?.length) {
                this._sceneWidgets.forEach(widget => {
                    try {
                        // Explicitly stop scene audio before widget gets replaced/collected.
                        widget.set_muted(true);
                    } catch (_e) {
                    }
                    try {
                        widget.pause();
                    } catch (_e) {
                    }
                    try {
                        widget.set_project_dir(null);
                    } catch (_e) {
                    }
                });
            }
            if (this._media) {
                try {
                    this._media.pause();
                    this._media.stream_unprepared();
                } catch (_e) {
                }
            }

            this._pictures = [];
            this._sharedPaintable = null;
            this._play = null;
            this._media = null;
            this._webView = null;
            this._webPausePicture = null;
            this._scenePicture = null;
            this._sceneWidgets = [];
            this._adapter = null;
            this._gstImplName = '';
            this._setPlayingState(false);
        }

        _getWidgetForMonitor(index) {
            if (!this._project)
                return this._getPlaceholderWidget('Invalid wallpaper project');

            switch (this._project.type) {
            case ProjectType.WEB:
                return this._getWebWidget();
            case ProjectType.SCENE:
                return this._getSceneWidget();
            case ProjectType.VIDEO:
            default:
                return this._getVideoWidget(index);
            }
        }

        _getVideoWidget(index) {
            let widget = this._getWidgetFromSharedPaintable();

            if (index > 0 && !widget)
                return this._getPlaceholderWidget('Video renderer could not be shared across monitors');

            if (!widget) {
                if (!forceMediaFile && haveGstPlay) {
                    let sink = null;
                    if (!forceGtk4PaintableSink)
                        sink = Gst.ElementFactory.make('clappersink', 'clappersink');

                    if (!sink)
                        sink = Gst.ElementFactory.make('gtk4paintablesink', 'gtk4paintablesink');

                    if (sink)
                        widget = this._getWidgetFromSink(sink);
                }

                if (!widget)
                    widget = this._getGtkStockWidget();
            }

            return widget;
        }

        _getPlaceholderWidget(message) {
            this._gstImplName = this._gstImplName || 'Placeholder';

            const box = new Gtk.Box({
                hexpand: true,
                vexpand: true,
                halign: Gtk.Align.FILL,
                valign: Gtk.Align.FILL,
            });
            box.add_css_class('background');

            const label = new Gtk.Label({
                label: message,
                wrap: true,
                justify: Gtk.Justification.CENTER,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
            });
            box.append(label);

            return box;
        }

        _getSceneWidget() {
            this._gstImplName = 'HanabiScene';

            if (!this._project.entryPath)
                return this._getPlaceholderWidget('Scene package not found');

            if (haveSceneBackend) {
                const sceneWidget = new HanabiScene.Widget({
                    'project-dir': this._project.path,
                    muted: mute,
                    volume,
                    'fill-mode': this._getSceneFillMode(),
                    playing: true,
                    hexpand: true,
                    vexpand: true,
                    halign: Gtk.Align.FILL,
                    valign: Gtk.Align.FILL,
                });
                this._sceneWidgets.push(sceneWidget);
                this._setPlayingState(true);
                this.setAutoWallpaper();
                return sceneWidget;
            }

            if (!this._project.previewPath)
                return this._getPlaceholderWidget('Scene preview is not available');

            const picture = Gtk.Picture.new_for_file(
                Gio.File.new_for_path(this._project.previewPath)
            );
            picture.set({
                hexpand: true,
                vexpand: true,
                can_shrink: true,
                halign: Gtk.Align.FILL,
                valign: Gtk.Align.FILL,
            });
            if (haveContentFit)
                picture.set_content_fit(contentFit);

            this._scenePicture = picture;
            this._setPlayingState(true);
            this.setAutoWallpaper();

            return picture;
        }

        _getSceneFillMode() {
            if (!haveContentFit)
                return 2;

            switch (contentFit) {
            case Gtk.ContentFit.FILL:
                return 0;
            case Gtk.ContentFit.CONTAIN:
            case Gtk.ContentFit.SCALE_DOWN:
                return 1;
            case Gtk.ContentFit.COVER:
            default:
                return 2;
            }
        }

        _getWebWidget() {
            this._gstImplName = 'WebKitWebView';

            if (!haveWebKit)
                return this._getPlaceholderWidget('WebKitGTK is not available');

            const userContentManager = new WebKit.UserContentManager();
            userContentManager.add_script(
                new WebKit.UserScript(
                    `
                    (() => {
                        if (window.__hanabiPlaybackBridgeInstalled)
                            return;
                        window.__hanabiPlaybackBridgeInstalled = true;

                        window.__hanabiAudioContexts = window.__hanabiAudioContexts || [];
                        const wrapAudioContext = key => {
                            const Original = window[key];
                            if (typeof Original !== 'function')
                                return;

                            const Wrapped = class extends Original {
                                constructor(...args) {
                                    super(...args);
                                    window.__hanabiAudioContexts.push(this);
                                }
                            };
                            Object.setPrototypeOf(Wrapped, Original);
                            window[key] = Wrapped;
                        };

                        wrapAudioContext('AudioContext');
                        wrapAudioContext('webkitAudioContext');
                    })();
                    `,
                    WebKit.UserContentInjectedFrames.ALL_FRAMES,
                    WebKit.UserScriptInjectionTime.START,
                    null,
                    null
                )
            );

            const webView = new WebKit.WebView({
                user_content_manager: userContentManager,
                hexpand: true,
                vexpand: true,
            });
            const pausePicture = new Gtk.Picture({
                hexpand: true,
                vexpand: true,
                visible: false,
                can_shrink: true,
            });
            if (haveContentFit)
                pausePicture.set_content_fit(contentFit);

            const overlay = new Gtk.Overlay({
                hexpand: true,
                vexpand: true,
            });
            overlay.set_child(webView);
            overlay.add_overlay(pausePicture);
            webView.set_can_focus(false);

            const settings = webView.get_settings();
            if (settings.set_enable_webaudio)
                settings.set_enable_webaudio(true);
            if (settings.set_enable_webgl)
                settings.set_enable_webgl(true);
            if (settings.set_allow_file_access_from_file_urls)
                settings.set_allow_file_access_from_file_urls(true);

            webView.connect('load-changed', (_view, loadEvent) => {
                if (loadEvent !== WebKit.LoadEvent.FINISHED)
                    return;

                if (this._isPlaying)
                    this._setWebPlayback(true);
            });

            const file = Gio.File.new_for_path(this._project.entryPath);
            webView.load_uri(file.get_uri());
            this._webView = webView;
            this._webPausePicture = pausePicture;

            this._setPlayingState(true);
            this.setAutoWallpaper();

            return overlay;
        }

        _setWebPlayback(isPlaying) {
            if (!this._webView)
                return;

            const script = `
                (() => {
                    const playing = ${isPlaying ? 'true' : 'false'};
                    const mediaElements = document.querySelectorAll('audio, video');
                    for (const media of mediaElements) {
                        if (playing)
                            media.play?.().catch?.(() => {});
                        else
                            media.pause?.();
                    }

                    const contexts = window.__hanabiAudioContexts || [];
                    for (const context of contexts) {
                        if (playing)
                            context.resume?.().catch?.(() => {});
                        else
                            context.suspend?.().catch?.(() => {});
                    }

                    window.dispatchEvent(new CustomEvent('hanabi-playback-change', {
                        detail: {playing},
                    }));
                })();
            `;

            this._webView.evaluate_javascript(
                script,
                -1,
                null,
                null,
                null,
                () => {}
            );

            if (isPlaying) {
                this._webView.visible = true;
                if (this._webPausePicture)
                    this._webPausePicture.visible = false;
            } else {
                this._freezeWebView();
            }
            this._setPlayingState(isPlaying);
        }

        _freezeWebView() {
            if (!this._webView || !this._webPausePicture)
                return;

            this._webView.get_snapshot(
                WebKit.SnapshotRegion.VISIBLE,
                WebKit.SnapshotOptions.NONE,
                null,
                (webView, result) => {
                    try {
                        const snapshot = webView.get_snapshot_finish(result);
                        if (!snapshot)
                            return;

                        this._webPausePicture.paintable = snapshot;
                        this._webPausePicture.visible = true;
                        this._webView.visible = false;
                    } catch (e) {
                        console.warn(e);
                    }
                }
            );
        }

        _getWidgetFromSharedPaintable() {
            if (this._sharedPaintable) {
                let picture = new Gtk.Picture({
                    paintable: this._sharedPaintable,
                    hexpand: true,
                    vexpand: true,
                });

                if (haveContentFit)
                    picture.set_content_fit(contentFit);
                this._pictures.push(picture);

                if (haveGraphicsOffload) {
                    let offload = Gtk.GraphicsOffload.new(picture);
                    offload.set_enabled(Gtk.GraphicsOffloadEnabled.ENABLED);
                    return offload;
                }

                return picture;
            }
            return null;
        }

        _getWidgetFromSink(sink) {
            this._gstImplName = sink.name;

            // If sink already offers GTK widget, use it.
            // Otherwise use GtkPicture with paintable from sink.
            let widget = null;

            if (sink.widget) {
                if (sink.widget instanceof Gtk.Picture) {
                    // Workaround for clappersink.
                    // We use a Gtk.Box here to piggyback the sink.widget from clappersink,
                    // otherwise the sink.widget will spawn a window for itself.
                    // This workaround is only needed for the first window.
                    this._sharedPaintable = sink.widget.paintable;
                    let box = new Gtk.Box();
                    box.append(sink.widget);
                    box.append(this._getWidgetFromSharedPaintable());
                    // Hide the sink.widget to show our Gtk.Picture only
                    sink.widget.hide();
                    widget = box;
                } else {
                    // Just in case clappersink doesn't use GtkPicture internally anymore
                    widget = sink.widget;
                }
            } else if (sink.paintable) {
                this._sharedPaintable = sink.paintable;
                widget = this._getWidgetFromSharedPaintable();
            }

            if (!widget)
                return null;

            if (useGstGL) {
                let glsink = Gst.ElementFactory.make(
                    'glsinkbin',
                    'glsinkbin'
                );
                if (glsink) {
                    this._gstImplName = `glsinkbin + ${this._gstImplName}`;
                    glsink.set_property('sink', sink);
                    sink = glsink;
                }
            }
            this._play = GstPlay.Play.new(
                GstPlay.PlayVideoOverlayVideoRenderer.new_with_sink(null, sink)
            );
            this._adapter = GstPlay.PlaySignalAdapter.new(this._play);

            // Loop video
            this._adapter.connect('end-of-stream', adapter =>
                adapter.play.seek(0)
            );

            // Error handling
            this._adapter.connect('warning', (_adapter, err) => console.warn(err));
            this._adapter.connect('error', (_adapter, err) => console.error(err));

            // Set the volume and mute after paused state, otherwise it won't work.
            // Use paused or greater, as some states might be skipped.
            let stateSignal = this._adapter.connect(
                'state-changed',
                (adapter, state) => {
                    if (state >= GstPlay.PlayState.PAUSED) {
                        this.setVolume(volume);
                        this.setMute(mute);

                        this._adapter.disconnect(stateSignal);
                        stateSignal = null;
                    }
                }
            );
            // Monitor playing state.
            this._adapter.connect(
                'state-changed',
                (adapter, state) => {
                    // Monitor playing state.
                    this._isPlaying = state === GstPlay.PlayState.PLAYING;
                    this._emitPlayingChanged();
                }
            );

            let file = Gio.File.new_for_path(this._project.entryPath);
            this._play.set_uri(file.get_uri());

            this.setPlay();
            this.setAutoWallpaper();

            return widget;
        }

        _getGtkStockWidget() {
            this._gstImplName = 'GtkMediaFile';

            // The constructor of MediaFile doesn't work in gjs.
            // Have to call the `new_for_xxx` function here.
            this._media = Gtk.MediaFile.new_for_filename(this._project.entryPath);
            this._media.set({
                loop: true,
            });
            // Set the volume and mute after prepared, otherwise it won't work.
            this._media.connect('notify::prepared', () => {
                this.setVolume(volume);
                this.setMute(mute);
            });
            // Monitor playing state.
            this._media.connect('notify::playing', media => {
                this._isPlaying = media.get_playing();
                this._emitPlayingChanged();
            });

            this._sharedPaintable = this._media;
            let widget = this._getWidgetFromSharedPaintable();

            this.setPlay();
            this.setAutoWallpaper();

            return widget;
        }

        _exportDbus() {
            const dbusXml = `
            <node>
                <interface name="io.github.jeffshee.HanabiRenderer">
                    <method name="setPlay"/>
                    <method name="setPause"/>
                    <method name="setMute">
                        <arg name="mute" type="b" direction="in"/>
                    </method>
                    <method name="setVolume">
                        <arg name="volume" type="d" direction="in"/>
                    </method>
                    <method name="setProjectPath">
                        <arg name="projectPath" type="s" direction="in"/>
                    </method>
                    <property name="isPlaying" type="b" access="read"/>
                    <signal name="isPlayingChanged">
                        <arg name="isPlaying" type="b"/>
                    </signal>
                </interface>
            </node>`;

            const dbusImpl = {
                setPlay: () => this.setPlay(),
                setPause: () => this.setPause(),
                setMute: _mute => this.setMute(_mute),
                setVolume: _volume => this.setVolume(_volume),
                setProjectPath: _projectPath => this.setProjectPath(_projectPath),
                get isPlaying() {
                    return this._renderer.isPlaying;
                },
                _renderer: this,
            };

            this._dbus = Gio.DBusExportedObject.wrapJSObject(
                dbusXml,
                dbusImpl
            );
            this._dbus.export(
                Gio.DBus.session,
                '/io/github/jeffshee/HanabiRenderer'
            );
        }

        _unexportDbus() {
            this._dbus?.unexport();
        }

        _emitPlayingChanged() {
            if (!this._dbus)
                return;
            this._dbus.emit_signal('isPlayingChanged', new GLib.Variant('(b)', [this._isPlaying]));
        }

        setProjectPath(_projectPath) {
            projectPath = _projectPath;
            if (extSettings && extSettings.get_string('project-path') !== _projectPath)
                extSettings.set_string('project-path', _projectPath);
            this._switchProject();
        }


        /**
         * These workarounds are needed because get_volume() and get_muted() can be wrong in some cases.
         * If the current value is equal to the new value, the changes will be skipped.
         * Avoid this behavior by resetting the current value to null before setting the new value.
         *
         * @param _volume
         */
        setVolume(_volume) {
            let player = this._play != null ? this._play : this._media;
            if (!player) {
                if (this._sceneWidgets?.length)
                    this._sceneWidgets.forEach(widget => widget.set_volume(_volume));
                return;
            }

            // GstPlay uses linear volume
            if (this._play) {
                if (haveGstAudio) {
                    _volume = GstAudio.StreamVolume.convert_volume(
                        GstAudio.StreamVolumeFormat.CUBIC,
                        GstAudio.StreamVolumeFormat.LINEAR,
                        _volume
                    );
                } else {
                    _volume = Math.pow(_volume, 3);
                }
            }

            if (player.volume === _volume)
                player.volume = null;
            player.volume = _volume;
        }

        setMute(_mute) {
            mute = _mute;
            if (extSettings && extSettings.get_boolean('mute') !== _mute)
                extSettings.set_boolean('mute', _mute);

            if (!this._play && !this._media && !this._webView && !this._sceneWidgets?.length)
                return;

            if (this._play) {
                if (this._play.mute === _mute)
                    this._play.mute = !_mute;
                this._play.mute = _mute;
            } else if (this._media) {
                if (this._media.muted === _mute)
                    this._media.muted = !_mute;
                this._media.muted = _mute;
            } else if (this._webView) {
                if (this._webView.is_muted === _mute)
                    this._webView.is_muted = !_mute;
                this._webView.is_muted = _mute;
            } else if (this._sceneWidgets?.length) {
                this._sceneWidgets.forEach(widget => widget.set_muted(_mute));
            }
        }

        _setPlayingState(isPlaying) {
            this._isPlaying = isPlaying;
            this._emitPlayingChanged();
        }

        setPlay() {
            if (this._play) {
                this._play.play();
            } else if (this._media) {
                this._media.play();
            } else if (this._webView) {
                this._setWebPlayback(true);
            } else if (this._sceneWidgets?.length) {
                this._sceneWidgets.forEach(widget => widget.play());
                this._setPlayingState(true);
            } else if (this._project?.type === ProjectType.SCENE) {
                this._setPlayingState(true);
            } else {
                this._setPlayingState(true);
            }
        }

        setPause() {
            if (this._play) {
                this._play.pause();
            } else if (this._media) {
                this._media.pause();
            } else if (this._webView) {
                this._setWebPlayback(false);
            } else if (this._sceneWidgets?.length) {
                this._sceneWidgets.forEach(widget => widget.pause());
                this._setPlayingState(false);
            } else if (this._project?.type === ProjectType.SCENE) {
                this._setPlayingState(false);
            } else {
                this._setPlayingState(false);
            }
        }

        setAutoWallpaper() {
            let currentIndex = 0;
            let projects = listProjects(changeWallpaperDirectoryPath);
            if (projects.length === 0)
                return;

            let getRandomIndex = (actualIndex, projectsLength) => {
                if (projectsLength <= 1)
                    return actualIndex;

                let newIndex;
                do
                    newIndex = Math.floor(Math.random() * projectsLength);
                while (newIndex === actualIndex);
                return newIndex;
            };

            const activeProjectIndex = projects.findIndex(project => project.path === projectPath);
            if (activeProjectIndex !== -1)
                currentIndex = activeProjectIndex;

            let operation = () => {
                if (this._isPlaying) {
                    extSettings.set_string('project-path', projects[currentIndex].path);

                    if (changeWallpaperMode === 0)
                        currentIndex = (currentIndex + 1) % projects.length;
                    else if (changeWallpaperMode === 1)
                        currentIndex = (currentIndex - 1 + projects.length) % projects.length;
                    else if (changeWallpaperMode === 2)
                        currentIndex = getRandomIndex(currentIndex, projects.length);
                }

                return true;
            };

            if (changeWallpaperTimerId) {
                GLib.source_remove(changeWallpaperTimerId);
                changeWallpaperTimerId = null;
            }

            if (changeWallpaper) {
                operation();
                changeWallpaperTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, changeWallpaperInterval * 60, operation);
            }
        }

        get isPlaying() {
            return this._isPlaying;
        }
    }
);

const HanabiRendererWindow = GObject.registerClass(
    {
        GTypeName: 'HanabiRendererWindow',
    },
    class HanabiRendererWindow extends Gtk.ApplicationWindow {
        constructor(application, title, widget, gdkMonitor) {
            super({
                application,
                decorated: !!nohide,
                default_height: windowDimension.height,
                default_width: windowDimension.width,
                title,
            });
            this._gdkMonitor = gdkMonitor;

            // Load CSS with custom style
            let cssProvider = new Gtk.CssProvider();
            cssProvider.load_from_file(
                Gio.File.new_for_path(
                    GLib.build_filenamev([codePath, 'renderer', 'stylesheet.css'])
                )
            );

            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default(),
                cssProvider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );

            this.setWallpaperWidget(widget);
            if (!windowed) {
                if (fullscreened) {
                    this.fullscreen_on_monitor(this._gdkMonitor);
                } else {
                    let geometry = this._gdkMonitor.get_geometry();
                    let [width, height] = [geometry.width, geometry.height];
                    this.set_size_request(width, height);
                }
            }
        }

        setWallpaperWidget(widget) {
            this.set_child(widget);
        }
    }
);

Gst.init(null);

let renderer = new HanabiRenderer();
renderer.run(ARGV);
