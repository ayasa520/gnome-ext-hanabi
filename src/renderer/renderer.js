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
imports.gi.versions.GioUnix = '2.0';
const {GObject, Gtk, Gio, GLib, Gdk, Gst, GIRepository} = imports.gi;
const GioUnix = imports.gi.GioUnix;
const System = imports.system;

const rendererDir = GLib.path_get_dirname(System.programInvocationName);
const sourceDir = GLib.path_get_dirname(rendererDir);
const repoDir = GLib.path_get_dirname(sourceDir);
const commonDir = GLib.build_filenamev([sourceDir, 'common']);
if (!imports.searchPath.some(path => path === commonDir))
    imports.searchPath.unshift(commonDir);
if (!imports.searchPath.some(path => path === rendererDir))
    imports.searchPath.unshift(rendererDir);

const nativeSceneBuildDir = GLib.build_filenamev([sourceDir, 'native', 'scene', 'build', 'out']);
const nativeSceneBuildGirDir = GLib.build_filenamev([nativeSceneBuildDir, 'gir']);
const nativeSceneInstallGirDir = GLib.build_filenamev([sourceDir, 'native', 'scene', 'girepository-1.0']);
const nativeSceneInstallLibDir = GLib.build_filenamev([sourceDir, 'native', 'scene', 'lib']);
const giRepository = GIRepository.Repository.dup_default();

const prependRepositoryDir = (path, prependFn) => {
    if (!GLib.file_test(path, GLib.FileTest.IS_DIR))
        return false;

    prependFn.call(giRepository, path);
    return true;
};

const usingBuildGirDir = prependRepositoryDir(
    nativeSceneBuildGirDir,
    giRepository.prepend_search_path
);
const usingBuildLibDir = prependRepositoryDir(
    nativeSceneBuildDir,
    giRepository.prepend_library_path
);
const usingInstallGirDir = !usingBuildGirDir && prependRepositoryDir(
    nativeSceneInstallGirDir,
    giRepository.prepend_search_path
);
const usingInstallLibDir = !usingBuildLibDir && prependRepositoryDir(
    nativeSceneInstallLibDir,
    giRepository.prepend_library_path
);

const ProjectLoader = imports.projectLoader;
const RendererBackends = imports.backends;

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
let sceneFps = extSettings ? extSettings.get_int('scene-fps') : 30;
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
const wallpaperSwitchTransitionDurationMs = 1000;
const wallpaperSwitchTransitionCleanupDelayMs = wallpaperSwitchTransitionDurationMs + 150;
const wallpaperSwitchReadyTimeoutMs = 15000;

const {ProjectType, loadProject, listProjects} = ProjectLoader;

const hasArg = arg => ARGV.includes(arg);

if (hasArg('-S') || hasArg('--standalone')) {
    standalone = true;
    applicationId = `${rendererDbusName}.Standalone`;
}

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

const createBackend = RendererBackends.createBackendFactory({
    Gtk,
    Gio,
    GLib,
    Gst,
    GstPlay,
    GstAudio,
    WebKit,
    HanabiScene,
    ProjectType,
    flags: {
        forceMediaFile,
        forceGtk4PaintableSink,
        haveGstPlay,
        haveGstAudio,
        haveWebKit,
        haveSceneBackend,
        haveContentFit,
        useGstGL,
        haveGraphicsOffload,
    },
    state: {
        getContentFit: () => contentFit,
        getMute: () => mute,
        getVolume: () => volume,
        getSceneFps: () => sceneFps,
    },
});


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
            this._project = null;
            this._backend = null;
            this._isPlaying = false;
            this._requestedPlaying = false;
            this._dbus = null;
            this._backendDestroySourceIds = new Set();
            this._pendingSwitch = null;
            this._switchSerial = 0;
            if (!standalone)
                this._exportDbus();
            if (!standalone)
                this._setupPointerInput();
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
                case 'scene-fps':
                    sceneFps = settings.get_int(key);
                    this.setSceneFps(sceneFps);
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
                    this._backend?.applyContentFit(contentFit);
                    this._pendingSwitch?.backend?.applyContentFit(contentFit);
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
                    // Keep CLI override for standalone/manual runs.
                    // In extension mode we still want settings changes to update live.
                    argvContentFitOverride = standalone;
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
            this._backend = this._createBackend(this._project);

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
                        ? this._getWindowTitle(index)
                        : `@${applicationId}!${JSON.stringify(state)}|${index}`,
                    widget,
                    gdkMonitor
                );

                this._hanabiWindows.push(window);
            });
            this._applyActiveBackendSettings(this._backend);
            this.setAutoWallpaper();
            console.log(`using ${this._backend.displayName} for ${this._getProjectLabel()}`);
        }

        _switchProject() {
            this._cancelPendingSwitch();

            const nextProject = loadProject(projectPath);
            const nextBackend = this._createBackend(nextProject);
            const previousBackend = this._backend;

            if (!previousBackend) {
                this._project = nextProject;
                this._backend = nextBackend;
                this._hanabiWindows.forEach((window, index) => {
                    const widget = nextBackend.createWidgetForMonitor(index);
                    window.setWallpaperWidget(widget);
                    if (nohide)
                        window.set_title(this._getWindowTitle(index));
                });
                this._applyActiveBackendSettings(this._backend);
                this.setAutoWallpaper();
                console.log(`using ${this._backend.displayName} for ${this._getProjectLabel()}`);
                return;
            }

            const nextWidgets = this._hanabiWindows.map((_window, index) => nextBackend.createWidgetForMonitor(index));
            this._hanabiWindows.forEach((window, index) => window.stageWallpaperWidget(nextWidgets[index]));
            this._applyPendingBackendSettings(nextBackend);
            this.setAutoWallpaper();

            const switchId = ++this._switchSerial;
            const readyTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                wallpaperSwitchReadyTimeoutMs,
                () => {
                    if (this._pendingSwitch?.id === switchId)
                        console.warn(`Wallpaper switch readiness timed out after ${wallpaperSwitchReadyTimeoutMs}ms`);
                    this._completePendingSwitch(switchId);
                    return GLib.SOURCE_REMOVE;
                }
            );

            this._pendingSwitch = {
                id: switchId,
                project: nextProject,
                backend: nextBackend,
                previousBackend,
                readyTimeoutId,
            };
            nextBackend.waitUntilReady(() => this._completePendingSwitch(switchId));
        }

        _resetBackend() {
            if (changeWallpaperTimerId) {
                GLib.source_remove(changeWallpaperTimerId);
                changeWallpaperTimerId = null;
            }

            this._cancelPendingSwitch();
            this._backend?.destroy();
            this._backend = null;
            this._project = null;
            this._setPlayingState(false);

            this._backendDestroySourceIds.forEach(sourceId => GLib.source_remove(sourceId));
            this._backendDestroySourceIds.clear();
        }

        _cancelPendingSwitch() {
            if (!this._pendingSwitch)
                return;

            if (this._pendingSwitch.readyTimeoutId)
                GLib.source_remove(this._pendingSwitch.readyTimeoutId);
            this._hanabiWindows.forEach(window => window.cancelWallpaperTransition());
            this._pendingSwitch.backend.destroy();
            this._pendingSwitch = null;
            this._applyActiveBackendSettings(this._backend);
        }

        _completePendingSwitch(switchId) {
            if (!this._pendingSwitch || this._pendingSwitch.id !== switchId)
                return;

            const {backend, previousBackend, project, readyTimeoutId} = this._pendingSwitch;
            if (readyTimeoutId)
                GLib.source_remove(readyTimeoutId);
            this._pendingSwitch = null;
            this._project = project;
            this._backend = backend;
            previousBackend.prepareForTransitionOut?.();
            this._applyActiveBackendSettings(this._backend);

            this._hanabiWindows.forEach((window, index) => {
                window.commitWallpaperTransition();
                if (nohide)
                    window.set_title(this._getWindowTitle(index));
            });

            this._scheduleBackendDestroy(previousBackend);
            console.log(`using ${this._backend.displayName} for ${this._getProjectLabel()}`);
        }

        _applyActiveBackendSettings(backend) {
            if (!backend)
                return;

            backend.applyContentFit(contentFit);
            backend.setVolume(volume);
            backend.setMute(mute);
            backend.setSceneFps(sceneFps);
            if (this._requestedPlaying)
                backend.setPlay();
            else
                backend.setPause();
        }

        _applyPendingBackendSettings(backend) {
            if (!backend)
                return;

            backend.applyContentFit(contentFit);
            backend.setVolume(volume);
            backend.setMute(true);
            backend.setSceneFps(sceneFps);
            backend.setPlay();
        }

        _scheduleBackendDestroy(backend) {
            const sourceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                wallpaperSwitchTransitionCleanupDelayMs,
                () => {
                    this._backendDestroySourceIds.delete(sourceId);
                    backend.destroy();
                    return GLib.SOURCE_REMOVE;
                }
            );
            this._backendDestroySourceIds.add(sourceId);
        }

        _createBackend(project) {
            return createBackend(this, project);
        }

        _getWidgetForMonitor(index) {
            return this._backend.createWidgetForMonitor(index);
        }

        _getProjectLabel() {
            if (!this._project)
                return 'Invalid wallpaper project';

            return this._project.title || this._project.basename || this._project.path || 'Untitled project';
        }

        _getWindowTitle(index) {
            return `Hanabi Renderer #${index}: ${this._getProjectLabel()} (using ${this._backend.displayName})`;
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

        _setupPointerInput() {
            try {
                this._pointerInputStream = Gio.DataInputStream.new(
                    new GioUnix.InputStream({fd: 0, close_fd: false})
                );
                this._readPointerInput();
            } catch (e) {
                console.warn(e);
                this._pointerInputStream = null;
            }
        }

        _readPointerInput() {
            if (!this._pointerInputStream)
                return;

            this._pointerInputStream.read_line_async(
                GLib.PRIORITY_DEFAULT,
                null,
                (stream, res) => {
                    try {
                        const [line, length] = stream.read_line_finish_utf8(res);
                        if (!length || line === null) {
                            this._pointerInputStream = null;
                            return;
                        }

                        this._handlePointerInput(line);
                    } catch (e) {
                        console.warn(e);
                        this._pointerInputStream = null;
                        return;
                    }

                    this._readPointerInput();
                }
            );
        }

        _handlePointerInput(line) {
            const [opcode, monitorIndexRaw, xRaw, yRaw, aRaw = '0', bRaw = '0'] = line.split('\t');
            const monitorIndex = Number(monitorIndexRaw);
            const x = Number(xRaw);
            const y = Number(yRaw);

            if (!Number.isFinite(monitorIndex) || !Number.isFinite(x) || !Number.isFinite(y))
                return;

            switch (opcode) {
            case 'm':
                this.dispatchPointerEvent({
                    monitorIndex,
                    type: 'mousemove',
                    x,
                    y,
                    button: 0,
                    deltaX: 0,
                    deltaY: 0,
                });
                break;
            case 'd':
            case 'u': {
                const button = Number(aRaw);
                if (!Number.isFinite(button))
                    return;

                this.dispatchPointerEvent({
                    monitorIndex,
                    type: opcode === 'd' ? 'mousedown' : 'mouseup',
                    x,
                    y,
                    button,
                    deltaX: 0,
                    deltaY: 0,
                });
                break;
            }
            case 'w': {
                const deltaX = Number(aRaw);
                const deltaY = Number(bRaw);
                if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY))
                    return;

                this.dispatchPointerEvent({
                    monitorIndex,
                    type: 'wheel',
                    x,
                    y,
                    button: 0,
                    deltaX,
                    deltaY,
                });
                break;
            }
            }
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
            this._backend?.setVolume(_volume);
            this._pendingSwitch?.backend?.setVolume(_volume);
        }

        setMute(_mute) {
            mute = _mute;
            if (extSettings && extSettings.get_boolean('mute') !== _mute)
                extSettings.set_boolean('mute', _mute);

            this._backend?.setMute(_mute);
        }

        setSceneFps(fps) {
            this._backend?.setSceneFps(fps);
            this._pendingSwitch?.backend?.setSceneFps(fps);
        }

        dispatchPointerEvent(event) {
            const monitorIndex = Number(event.monitorIndex);
            const type = String(event.type ?? '');
            if (!['mousemove', 'mousedown', 'mouseup', 'wheel'].includes(type) || Number.isNaN(monitorIndex))
                return;

            const x = Number(event.x ?? 0);
            const y = Number(event.y ?? 0);
            const button = Number(event.button ?? 0);
            const deltaX = Number(event.deltaX ?? 0);
            const deltaY = Number(event.deltaY ?? 0);
            if (
                !Number.isFinite(x) ||
                !Number.isFinite(y) ||
                !Number.isFinite(button) ||
                !Number.isFinite(deltaX) ||
                !Number.isFinite(deltaY)
            )
                return;

            this._backend?.dispatchPointerEvent({
                monitorIndex,
                type,
                x,
                y,
                button,
                deltaX,
                deltaY,
            });
        }

        _setPlayingState(isPlaying) {
            this._isPlaying = isPlaying;
            this._emitPlayingChanged();
        }

        setPlay() {
            this._requestedPlaying = true;
            if (this._backend)
                this._backend.setPlay();
            else
                this._setPlayingState(true);
        }

        setPause() {
            this._requestedPlaying = false;
            if (this._backend)
                this._backend.setPause();
            else
                this._setPlayingState(false);
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
                if (this._requestedPlaying) {
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
            this._wallpaperOverlay = new Gtk.Overlay({
                hexpand: true,
                vexpand: true,
                halign: Gtk.Align.FILL,
                valign: Gtk.Align.FILL,
            });
            this._transitionRevealer = null;
            this._transitionCleanupId = 0;
            this._transitionCommitted = false;

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

            super.set_child(this._wallpaperOverlay);
            this.setWallpaperWidget(widget);
            if (!windowed) {
                // In extension mode (nohide=false), fullscreen may transiently mark the
                // renderer as the active fullscreen window during login and hide/cover
                // panel or dock before shell-side management catches up.
                if (fullscreened && nohide) {
                    this.fullscreen_on_monitor(this._gdkMonitor);
                } else {
                    let geometry = this._gdkMonitor.get_geometry();
                    let [width, height] = [geometry.width, geometry.height];
                    this.set_size_request(width, height);
                }
            }
        }

        setWallpaperWidget(widget) {
            this._prepareWallpaperWidget(widget);
            this._discardWallpaperTransition();
            this._wallpaperOverlay.set_child(widget);
        }

        stageWallpaperWidget(widget) {
            this._prepareWallpaperWidget(widget);

            const previousWidget = this._wallpaperOverlay.get_child();
            this.cancelWallpaperTransition();
            this._wallpaperOverlay.set_child(widget);

            if (!previousWidget)
                return;

            const revealer = new Gtk.Revealer({
                hexpand: true,
                vexpand: true,
                halign: Gtk.Align.FILL,
                valign: Gtk.Align.FILL,
                can_target: false,
                reveal_child: true,
                transition_duration: wallpaperSwitchTransitionDurationMs,
                transition_type: Gtk.RevealerTransitionType.CROSSFADE,
            });
            revealer.set_child(previousWidget);
            this._wallpaperOverlay.add_overlay(revealer);
            this._transitionRevealer = revealer;
            this._transitionCommitted = false;
        }

        commitWallpaperTransition() {
            if (!this._transitionRevealer)
                return;

            this._transitionCommitted = true;

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (this._transitionRevealer)
                    this._transitionRevealer.set_reveal_child(false);
                return GLib.SOURCE_REMOVE;
            });

            this._transitionCleanupId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                wallpaperSwitchTransitionCleanupDelayMs,
                () => {
                    this._discardWallpaperTransition();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        cancelWallpaperTransition() {
            if (!this._transitionRevealer)
                return;

            const previousWidget = this._transitionCommitted ? null : this._transitionRevealer.get_child();
            this._discardWallpaperTransition();
            if (previousWidget)
                this._wallpaperOverlay.set_child(previousWidget);
        }

        _prepareWallpaperWidget(widget) {
            widget.set({
                hexpand: true,
                vexpand: true,
                halign: Gtk.Align.FILL,
                valign: Gtk.Align.FILL,
            });
        }

        _discardWallpaperTransition() {
            if (this._transitionCleanupId) {
                GLib.source_remove(this._transitionCleanupId);
                this._transitionCleanupId = 0;
            }

            if (this._transitionRevealer) {
                this._transitionRevealer.set_child(null);
                this._wallpaperOverlay.remove_overlay(this._transitionRevealer);
                this._transitionRevealer = null;
            }

            this._transitionCommitted = false;
        }
    }
);

Gst.init(null);

let renderer = new HanabiRenderer();
renderer.run(ARGV);
