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
imports.gi.versions.Soup = '3.0';
const {GObject, Gtk, Gio, GLib, Gdk, Gst, GIRepository} = imports.gi;
const GioUnix = imports.gi.GioUnix;
const Soup = imports.gi.Soup;
const System = imports.system;

const rendererDir = GLib.path_get_dirname(System.programInvocationName);
const extensionDir = GLib.path_get_dirname(rendererDir);
const commonDir = GLib.build_filenamev([extensionDir, 'common']);
if (!imports.searchPath.some(path => path === commonDir))
    imports.searchPath.unshift(commonDir);
if (!imports.searchPath.some(path => path === rendererDir))
    imports.searchPath.unshift(rendererDir);

const NativeRuntimeConfig = imports.nativeRuntimeConfig;
const giRepository = GIRepository.Repository.dup_default();

const prependRepositoryDir = (path, prependFn) => {
    if (!path || !GLib.file_test(path, GLib.FileTest.IS_DIR))
        return false;

    prependFn.call(giRepository, path);
    return true;
};

prependRepositoryDir(
    NativeRuntimeConfig.nativeSceneTypelibDir,
    giRepository.prepend_search_path
);
prependRepositoryDir(
    NativeRuntimeConfig.nativeSceneLibDir,
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

let WPEWebKit = null;
try {
    imports.gi.versions.WPEWebKit = '2.0';
    WPEWebKit = imports.gi.WPEWebKit;
} catch (_e) {
    WPEWebKit = null;
}
const haveWPEWebKit = WPEWebKit !== null;
if (!haveWPEWebKit)
    console.warn('WPEWebKit, or the typelib is not installed.');

let WPEPlatform = null;
try {
    imports.gi.versions.WPEPlatform = '2.0';
    WPEPlatform = imports.gi.WPEPlatform;
} catch (_e) {
    WPEPlatform = null;
}
const haveWPEPlatform = WPEPlatform !== null;
if (!haveWPEPlatform)
    console.warn('WPEPlatform, or the typelib is not installed.');

let WPEPlatformHeadless = null;
try {
    imports.gi.versions.WPEPlatformHeadless = '2.0';
    WPEPlatformHeadless = imports.gi.WPEPlatformHeadless;
} catch (_e) {
    WPEPlatformHeadless = null;
}
const haveWPEPlatformHeadless = WPEPlatformHeadless !== null;
if (!haveWPEPlatformHeadless)
    console.warn('WPEPlatformHeadless, or the typelib is not installed.');

console.log(
    `Web backend capabilities: haveWPEWebKit=${haveWPEWebKit}, haveWPEPlatform=${haveWPEPlatform}, haveWPEPlatformHeadless=${haveWPEPlatformHeadless}`
);

if (!(haveWPEWebKit && haveWPEPlatform && haveWPEPlatformHeadless))
    console.warn('WPEWebKit platform support is unavailable. Web projects will fallback to a placeholder.');

let HanabiScene = null;
try {
    HanabiScene = imports.gi.HanabiScene;
} catch (_e) {
    HanabiScene = null;
}
const haveSceneBackend = HanabiScene !== null;
if (!haveSceneBackend)
    console.warn('HanabiScene typelib is not installed. Scene projects will fallback to a placeholder.');

let HanabiWpe = null;
try {
    HanabiWpe = imports.gi.HanabiWpe;
} catch (e) {
    HanabiWpe = null;
    console.warn(`Failed to import HanabiWpe: ${e}`);
}
const haveWpeBridge = HanabiWpe !== null;
if (!haveWpeBridge)
    console.warn('HanabiWpe typelib is not installed. WPE web projects may fail to import dma-buf textures.');

// ContentFit is available from Gtk 4.8+
const haveContentFit = isGtkVersionAtLeast(4, 8);

// Use glsinkbin for Gst 1.24+
const useGstGL = isGstVersionAtLeast(1, 24);

const rendererDbusName = 'io.github.jeffshee.HanabiRenderer';
let applicationId = rendererDbusName;

let extSettings = null;
const extSchemaId = 'io.github.jeffshee.hanabi-extension';
try {
    extSettings = Gio.Settings.new(extSchemaId);
} catch (e) {
    console.warn(`Renderer failed to initialize Gio.Settings for ${extSchemaId}: ${e}`);
}

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
const sceneUserPropertyReloadDebounceMs = 200;
const webAudioBandsPerChannel = 64;
const webAudioFrameLength = webAudioBandsPerChannel * 2;
const webAudioUpdateIntervalNs = 33333333;
const webAudioRestartDelayMs = 1000;
const webAudioSilenceThresholdDb = -80;
const localMediaHttpEndpointPath = '/hanabi-media';

const guessLocalMediaMimeType = path => {
    if (typeof path !== 'string' || path === '')
        return 'application/octet-stream';

    try {
        const [contentType] = Gio.content_type_guess(path, null);
        const mimeType = contentType
            ? Gio.content_type_get_mime_type(contentType)
            : null;
        if (mimeType)
            return mimeType;
    } catch (_e) {
    }

    const extension = path.split('.').pop()?.toLowerCase?.() ?? '';
    switch (extension) {
    case 'aac':
        return 'audio/aac';
    case 'flac':
        return 'audio/flac';
    case 'm4a':
        return 'audio/mp4';
    case 'mp3':
        return 'audio/mpeg';
    case 'mp4':
        return 'video/mp4';
    case 'oga':
    case 'ogg':
        return 'audio/ogg';
    case 'ogv':
        return 'video/ogg';
    case 'opus':
        return 'audio/ogg';
    case 'wav':
        return 'audio/wav';
    case 'webm':
        return 'video/webm';
    default:
        return 'application/octet-stream';
    }
};

const parseHttpRangeHeader = (value, totalLength) => {
    if (typeof value !== 'string' || !value.startsWith('bytes=') || !Number.isFinite(totalLength) || totalLength <= 0)
        return null;

    const match = value.trim().match(/^bytes=(\d*)-(\d*)$/i);
    if (!match)
        return null;

    const [, startText, endText] = match;
    if (startText === '' && endText === '')
        return null;

    let start = 0;
    let end = totalLength - 1;

    if (startText === '') {
        const suffixLength = Number.parseInt(endText, 10);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0)
            return null;
        start = Math.max(0, totalLength - suffixLength);
    } else {
        start = Number.parseInt(startText, 10);
        if (!Number.isFinite(start) || start < 0 || start >= totalLength)
            return null;

        if (endText !== '') {
            end = Number.parseInt(endText, 10);
            if (!Number.isFinite(end) || end < start)
                return null;
            end = Math.min(end, totalLength - 1);
        }
    }

    return {start, end};
};

class LocalMediaHttpServer {
    constructor() {
        this._server = null;
        this._token = GLib.uuid_string_random();
        this._urlPrefix = '';
        this._start();
    }

    get urlPrefix() {
        return this._urlPrefix;
    }

    getMediaUrl(path) {
        if (!this._urlPrefix || typeof path !== 'string' || path === '')
            return '';

        return `${this._urlPrefix}${encodeURIComponent(path)}`;
    }

    _start() {
        try {
            this._server = new Soup.Server({
                server_header: 'HanabiLocalMedia',
            });
            this._server.add_handler(localMediaHttpEndpointPath, (_server, message) => {
                this._handleMessage(message);
            });
            this._server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);

            const uri = this._server.get_uris()?.[0] ?? null;
            if (!uri) {
                console.warn('Local media HTTP server started without an advertised URI');
                return;
            }

            const baseUri = uri.to_string().replace(/\/$/, '');
            this._urlPrefix = `${baseUri}${localMediaHttpEndpointPath}?token=${encodeURIComponent(this._token)}&path=`;
            console.log(`Local media HTTP server listening at ${baseUri}${localMediaHttpEndpointPath}`);
        } catch (e) {
            this._server = null;
            this._urlPrefix = '';
            console.warn(`Failed to start local media HTTP server: ${e}`);
        }
    }

    _handleMessage(message) {
        const method = message.get_method?.() ?? 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
            message.set_status(Soup.Status.NOT_IMPLEMENTED, null);
            return;
        }

        const query = Soup.form_decode(message.get_uri()?.get_query?.() ?? '');
        const token = query?.token ?? '';
        const filePath = query?.path ?? '';
        if (token !== this._token || typeof filePath !== 'string' || filePath === '') {
            message.set_status(Soup.Status.NOT_FOUND, null);
            return;
        }

        try {
            const file = Gio.File.new_for_path(filePath);
            const info = file.query_info(
                'standard::content-type,standard::size,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            if (info.get_file_type() !== Gio.FileType.REGULAR) {
                message.set_status(Soup.Status.NOT_FOUND, null);
                return;
            }

            const [bytes] = file.load_bytes(null);
            const data = bytes.get_data();
            const totalLength = data.length;
            const mimeType = Gio.content_type_get_mime_type(info.get_content_type?.() ?? '')
                ?? guessLocalMediaMimeType(filePath);
            const responseHeaders = message.get_response_headers();
            responseHeaders.replace('Accept-Ranges', 'bytes');
            responseHeaders.set_content_type(mimeType, null);

            const requestedRange = parseHttpRangeHeader(
                message.get_request_headers()?.get_one?.('Range') ?? '',
                totalLength
            );

            if (
                (message.get_request_headers()?.get_one?.('Range') ?? '') &&
                !requestedRange
            ) {
                message.set_status(416, 'Range Not Satisfiable');
                responseHeaders.replace('Content-Range', `bytes */${totalLength}`);
                message.set_response(
                    'application/octet-stream',
                    Soup.MemoryUse.STATIC,
                    new Uint8Array(0)
                );
                return;
            }

            const start = requestedRange?.start ?? 0;
            const end = requestedRange?.end ?? (totalLength - 1);
            const body = method === 'HEAD'
                ? new Uint8Array(0)
                : data.slice(start, end + 1);

            if (requestedRange) {
                message.set_status(Soup.Status.PARTIAL_CONTENT, null);
                responseHeaders.set_content_range(start, end, totalLength);
                responseHeaders.set_content_length(end - start + 1);
            } else {
                message.set_status(Soup.Status.OK, null);
                responseHeaders.set_content_length(totalLength);
            }

            message.set_response(
                mimeType,
                Soup.MemoryUse.COPY,
                body
            );
        } catch (e) {
            console.warn(`Failed to serve local media file ${filePath}: ${e}`);
            message.set_status(Soup.Status.NOT_FOUND, null);
        }
    }
}

const {
    ProjectBrowserFilterKey,
    ProjectType,
    UserPropertyStoreKey,
    LegacyWebUserPropertyStoreKey,
    buildSceneUserPropertyPayload,
    buildWebUserPropertyPayload,
    getProjectFilterFromSettings,
    getProjectScenePropertyOverrides,
    getProjectWebPropertyOverrides,
    loadProject,
    listProjects,
    mergeStoredScenePropertyOverrides,
    serializeStoredScenePropertyOverrides,
} = ProjectLoader;

const mergeUserPropertyStoresFromSettings = settings => {
    if (!settings)
        return '';

    return serializeStoredScenePropertyOverrides(
        mergeStoredScenePropertyOverrides(
            settings.get_string(UserPropertyStoreKey),
            settings.get_string(LegacyWebUserPropertyStoreKey)
        )
    );
};

const migrateUserPropertyStoresInSettings = settings => {
    if (!settings)
        return '';

    const mergedStore = mergeUserPropertyStoresFromSettings(settings);
    if (settings.get_string(UserPropertyStoreKey) !== mergedStore)
        settings.set_string(UserPropertyStoreKey, mergedStore);
    if (settings.get_string(LegacyWebUserPropertyStoreKey) !== '')
        settings.set_string(LegacyWebUserPropertyStoreKey, '');
    return mergedStore;
};

let userPropertyStore = extSettings
    ? migrateUserPropertyStoresInSettings(extSettings)
    : '';

const applyProjectUserPropertyState = project => {
    if (!project)
        return project;

    if (project.type === ProjectType.SCENE) {
        project.scenePropertyOverrides = getProjectScenePropertyOverrides(userPropertyStore, project);
        project.scenePropertyPayload = buildSceneUserPropertyPayload(project, project.scenePropertyOverrides);
    } else if (project.type === ProjectType.WEB) {
        project.webPropertyOverrides = getProjectWebPropertyOverrides(userPropertyStore, project);
        project.webPropertyPayload = buildWebUserPropertyPayload(project, project.webPropertyOverrides);
    }
    return project;
};

const loadConfiguredProject = path => applyProjectUserPropertyState(loadProject(path));
const serializeProjectPropertyPayload = project => {
    if (project?.type === ProjectType.SCENE)
        return JSON.stringify(project?.scenePropertyPayload ?? {});
    if (project?.type === ProjectType.WEB)
        return JSON.stringify(project?.webPropertyPayload ?? {});
    return '{}';
};

const hasArg = arg => ARGV.includes(arg);

const buildSilentWebAudioFrame = () => new Array(webAudioFrameLength).fill(0);

const parseSpectrumMagnitudeDbValues = structureString => {
    if (!structureString)
        return [];

    const magnitudeIndex = structureString.indexOf('magnitude=');
    if (magnitudeIndex === -1)
        return [];

    const magnitudeText = structureString.slice(magnitudeIndex);
    const values = [];
    const pattern = /\(float\)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi;
    let match;
    while ((match = pattern.exec(magnitudeText)) && values.length < webAudioFrameLength)
        values.push(Number.parseFloat(match[1]));

    return values;
};

const normalizeSpectrumMagnitudeDb = magnitudeDb => {
    if (!Number.isFinite(magnitudeDb))
        return 0;

    if (magnitudeDb <= webAudioSilenceThresholdDb)
        return 0;

    if (magnitudeDb >= 0)
        return 1;

    return Math.max(0, Math.min(1, Math.pow(10, magnitudeDb / 20)));
};

class WebAudioVisualizerCapture {
    constructor(onFrame) {
        this._onFrame = onFrame;
        this._pipeline = null;
        this._bus = null;
        this._busSignalIds = [];
        this._restartSourceId = 0;
        this._shouldRun = false;
        this._isAvailable = true;
        this._lastFrame = buildSilentWebAudioFrame();
    }

    get currentFrame() {
        return [...this._lastFrame];
    }

    start() {
        this._shouldRun = true;
        if (this._pipeline || !this._isAvailable)
            return;

        this._cancelRestart();
        this._startPipeline();
    }

    stop({emitSilence = true} = {}) {
        this._shouldRun = false;
        this._cancelRestart();
        this._teardownPipeline();

        if (emitSilence)
            this._emitFrame(buildSilentWebAudioFrame());
    }

    destroy() {
        this.stop();
        this._onFrame = null;
    }

    _startPipeline() {
        if (!Gst.ElementFactory.find('pulsesrc')) {
            console.warn('Web audio visualizer capture unavailable: GStreamer pulsesrc plugin is missing');
            this._isAvailable = false;
            this._emitFrame(buildSilentWebAudioFrame());
            return;
        }

        if (!Gst.ElementFactory.find('spectrum')) {
            console.warn('Web audio visualizer capture unavailable: GStreamer spectrum plugin is missing');
            this._isAvailable = false;
            this._emitFrame(buildSilentWebAudioFrame());
            return;
        }

        try {
            this._pipeline = Gst.parse_launch(
                'pulsesrc device=@DEFAULT_MONITOR@ client-name=HanabiVisualizer do-timestamp=true ! ' +
                'audioconvert ! audioresample ! ' +
                `audio/x-raw,channels=2,rate=48000 ! ` +
                `spectrum bands=${webAudioBandsPerChannel} multi-channel=true post-messages=true ` +
                'message-magnitude=true message-phase=false ' +
                `interval=${webAudioUpdateIntervalNs} threshold=${webAudioSilenceThresholdDb} ! ` +
                'fakesink sync=false'
            );
        } catch (e) {
            console.warn(`Failed to create web audio visualizer pipeline: ${e}`);
            this._scheduleRestart();
            return;
        }

        this._bus = this._pipeline.get_bus();
        this._bus.add_signal_watch();
        this._busSignalIds = [
            this._bus.connect('message::element', (_bus, message) => {
                this._handleElementMessage(message);
            }),
            this._bus.connect('message::error', (_bus, message) => {
                let details = '';
                try {
                    const [error, debugInfo] = message.parse_error();
                    details = error?.message ?? String(error ?? '');
                    if (debugInfo)
                        details = `${details} (${debugInfo})`;
                } catch (e) {
                    details = String(e);
                }
                console.warn(`Web audio visualizer pipeline error: ${details}`);
                this._scheduleRestart();
            }),
            this._bus.connect('message::eos', () => {
                console.warn('Web audio visualizer pipeline reached EOS unexpectedly');
                this._scheduleRestart();
            }),
        ];

        const stateChange = this._pipeline.set_state(Gst.State.PLAYING);
        if (stateChange === Gst.StateChangeReturn.FAILURE) {
            console.warn('Web audio visualizer pipeline failed to enter PLAYING state');
            this._scheduleRestart();
        }
    }

    _handleElementMessage(message) {
        const structure = message.get_structure?.();
        if (!structure || structure.get_name() !== 'spectrum')
            return;

        const magnitudesDb = parseSpectrumMagnitudeDbValues(structure.to_string());
        if (magnitudesDb.length === 0)
            return;

        const normalized = buildSilentWebAudioFrame();
        if (magnitudesDb.length >= webAudioFrameLength) {
            for (let i = 0; i < webAudioFrameLength; i++)
                normalized[i] = normalizeSpectrumMagnitudeDb(magnitudesDb[i]);
        } else {
            const copyLength = Math.min(webAudioBandsPerChannel, magnitudesDb.length);
            for (let i = 0; i < copyLength; i++) {
                const value = normalizeSpectrumMagnitudeDb(magnitudesDb[i]);
                normalized[i] = value;
                normalized[i + webAudioBandsPerChannel] = value;
            }
        }

        this._emitFrame(normalized);
    }

    _emitFrame(frame) {
        this._lastFrame = [...frame];
        this._onFrame?.(this.currentFrame);
    }

    _scheduleRestart() {
        this._teardownPipeline();
        if (!this._shouldRun || this._restartSourceId)
            return;

        this._restartSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            webAudioRestartDelayMs,
            () => {
                this._restartSourceId = 0;
                if (this._shouldRun)
                    this._startPipeline();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelRestart() {
        if (!this._restartSourceId)
            return;

        GLib.source_remove(this._restartSourceId);
        this._restartSourceId = 0;
    }

    _teardownPipeline() {
        if (this._bus) {
            this._busSignalIds.forEach(signalId => {
                try {
                    this._bus.disconnect(signalId);
                } catch (_e) {
                }
            });
            this._busSignalIds = [];
            try {
                this._bus.remove_signal_watch();
            } catch (_e) {
            }
            this._bus = null;
        }

        if (this._pipeline) {
            try {
                this._pipeline.set_state(Gst.State.NULL);
            } catch (_e) {
            }
            this._pipeline = null;
        }
    }
}

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
    GObject,
    Gtk,
    Gio,
    GLib,
    Gdk,
    Gst,
    GstPlay,
    GstAudio,
    WPEWebKit,
    WPEPlatform,
    WPEPlatformHeadless,
    HanabiScene,
    HanabiWpe,
    ProjectType,
    flags: {
        forceMediaFile,
        forceGtk4PaintableSink,
        haveGstPlay,
        haveGstAudio,
        haveWPEWebKit,
        haveWPEPlatform,
        haveWPEPlatformHeadless,
        haveSceneBackend,
        haveWpeBridge,
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
            this._sceneUserPropertyReloadSourceId = 0;
            this._switchSerial = 0;
            this._nativeWindowHold = false;
            this._webAudioBackends = new Set();
            this._webAudioCapture = new WebAudioVisualizerCapture(frame => {
                this._broadcastWebAudioFrame(frame);
            });
            this._currentWebAudioFrame = buildSilentWebAudioFrame();
            this._localMediaHttpServer = new LocalMediaHttpServer();
            if (!standalone)
                this._exportDbus();
            if (!standalone)
                this._setupPointerInput();
            this._setupGst();

            this.connect('activate', app => {
                this._display = Gdk.Display.get_default();
                this._monitors = this._display ? [...this._display.get_monitors()] : [];

                let activeWindow = app.activeWindow;
                if (!activeWindow && this._hanabiWindows.length === 0) {
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

            this.connect('shutdown', () => {
                this._localMediaHttpServer = null;
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
                case ProjectBrowserFilterKey.STATE:
                    this.setAutoWallpaper();
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
                case UserPropertyStoreKey:
                    userPropertyStore = settings.get_string(key);
                    this._scheduleProjectUserPropertyStoreReload();
                    break;
                case LegacyWebUserPropertyStoreKey:
                    userPropertyStore = migrateUserPropertyStoresInSettings(settings);
                    this._scheduleProjectUserPropertyStoreReload();
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
            this._project = loadConfiguredProject(projectPath);
            this._backend = this._createBackend(this._project);
            this._syncApplicationHoldForBackend(this._backend);
            this._rebuildRendererWindows(this._backend);
            this._applyActiveBackendSettings(this._backend);
            this.setAutoWallpaper();
            console.log(`using ${this._backend.displayName} for ${this._getProjectLabel()}`);
        }

        _switchProject() {
            this._cancelProjectUserPropertyStoreReload();
            this._switchToProject(loadConfiguredProject(projectPath));
        }

        _switchToProject(nextProject) {
            this._cancelPendingSwitch();

            const nextBackend = this._createBackend(nextProject);
            const previousBackend = this._backend;

            if (!previousBackend) {
                this._project = nextProject;
                this._backend = nextBackend;
                this._syncApplicationHoldForBackend(this._backend);
                this._rebuildRendererWindows(this._backend);
                this._applyActiveBackendSettings(this._backend, this._project);
                this.setAutoWallpaper();
                console.log(`using ${this._backend.displayName} for ${this._getProjectLabel()}`);
                return;
            }

            if (this._backendUsesNativeWindows(previousBackend) || this._backendUsesNativeWindows(nextBackend)) {
                if (this._backendUsesNativeWindows(nextBackend))
                    this._syncApplicationHoldForBackend(nextBackend);
                this._destroyRendererWindows();
                previousBackend.destroy();
                this._project = nextProject;
                this._backend = nextBackend;
                this._rebuildRendererWindows(this._backend);
                this._syncApplicationHoldForBackend(this._backend);
                this._applyActiveBackendSettings(this._backend, this._project);
                this.setAutoWallpaper();
                console.log(`using ${this._backend.displayName} for ${this._getProjectLabel()}`);
                return;
            }

            const nextWidgets = this._hanabiWindows.map((_window, index) => nextBackend.createWidgetForMonitor(index));
            this._hanabiWindows.forEach((window, index) => window.stageWallpaperWidget(nextWidgets[index]));
            this._applyPendingBackendSettings(nextBackend, nextProject);
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

        _handleProjectUserPropertyStoreChanged() {
            const nextProject = loadConfiguredProject(projectPath);
            const nextPayloadJson = serializeProjectPropertyPayload(nextProject);
            const currentPayloadJson = serializeProjectPropertyPayload(this._project);
            const pendingPayloadJson = serializeProjectPropertyPayload(this._pendingSwitch?.project);

            if (nextProject?.type !== ProjectType.SCENE && nextProject?.type !== ProjectType.WEB)
                return;

            if (nextProject.type === ProjectType.WEB) {
                if (
                    this._pendingSwitch?.project?.path === nextProject.path &&
                    pendingPayloadJson !== nextPayloadJson
                ) {
                    this._pendingSwitch.project = nextProject;
                    this._pendingSwitch.backend.setWebUserProperties?.(nextProject.webPropertyPayload ?? null);
                    return;
                }

                if (
                    !this._pendingSwitch &&
                    this._project?.path === nextProject.path &&
                    currentPayloadJson !== nextPayloadJson
                ) {
                    this._project = nextProject;
                    this._backend?.setWebUserProperties?.(nextProject.webPropertyPayload ?? null);
                    return;
                }
            }

            if (this._pendingSwitch && pendingPayloadJson !== nextPayloadJson) {
                this._switchToProject(nextProject);
                return;
            }

            if (!this._pendingSwitch && currentPayloadJson !== nextPayloadJson) {
                this._switchToProject(nextProject);
                return;
            }
        }

        _scheduleProjectUserPropertyStoreReload() {
            if (this._sceneUserPropertyReloadSourceId)
                GLib.source_remove(this._sceneUserPropertyReloadSourceId);

            this._sceneUserPropertyReloadSourceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                sceneUserPropertyReloadDebounceMs,
                () => {
                    this._sceneUserPropertyReloadSourceId = 0;
                    this._handleProjectUserPropertyStoreChanged();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        _cancelProjectUserPropertyStoreReload() {
            if (!this._sceneUserPropertyReloadSourceId)
                return;

            GLib.source_remove(this._sceneUserPropertyReloadSourceId);
            this._sceneUserPropertyReloadSourceId = 0;
        }

        _resetBackend() {
            if (changeWallpaperTimerId) {
                GLib.source_remove(changeWallpaperTimerId);
                changeWallpaperTimerId = null;
            }

            this._cancelProjectUserPropertyStoreReload();
            this._cancelPendingSwitch();
            this._destroyRendererWindows();
            this._backend?.destroy();
            this._backend = null;
            this._project = null;
            this._syncApplicationHoldForBackend(null);
            this._setPlayingState(false);

            this._backendDestroySourceIds.forEach(sourceId => GLib.source_remove(sourceId));
            this._backendDestroySourceIds.clear();
            this._webAudioCapture?.stop();
            this._webAudioBackends.clear();
            this._currentWebAudioFrame = buildSilentWebAudioFrame();
        }

        _cancelPendingSwitch() {
            if (!this._pendingSwitch)
                return;

            if (this._pendingSwitch.readyTimeoutId)
                GLib.source_remove(this._pendingSwitch.readyTimeoutId);
            this._hanabiWindows.forEach(window => window.cancelWallpaperTransition());
            this._pendingSwitch.backend.destroy();
            this._pendingSwitch = null;
            this._applyActiveBackendSettings(this._backend, this._project);
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
            this._applyActiveBackendSettings(this._backend, this._project);

            this._hanabiWindows.forEach((window, index) => {
                window.commitWallpaperTransition();
                if (nohide)
                    window.set_title(this._getWindowTitle(index));
            });

            this._scheduleBackendDestroy(previousBackend);
            console.log(`using ${this._backend.displayName} for ${this._getProjectLabel()}`);
        }

        _applyActiveBackendSettings(backend, project = this._project) {
            if (!backend)
                return;

            backend.applyContentFit(contentFit);
            backend.setSceneUserProperties?.(project?.scenePropertyPayload ?? null);
            backend.setWebUserProperties?.(project?.webPropertyPayload ?? null);
            backend.setVolume(volume);
            backend.setMute(mute);
            backend.setSceneFps(sceneFps);
            if (this._requestedPlaying)
                backend.setPlay();
            else
                backend.setPause();
        }

        _applyPendingBackendSettings(backend, project) {
            if (!backend)
                return;

            backend.applyContentFit(contentFit);
            backend.setSceneUserProperties?.(project?.scenePropertyPayload ?? null);
            backend.setWebUserProperties?.(project?.webPropertyPayload ?? null);
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

        _backendUsesNativeWindows(backend) {
            return backend?.usesNativeWindows === true;
        }

        _rebuildRendererWindows(backend) {
            this._destroyRendererWindows();

            this._monitors.forEach((gdkMonitor, index) => {
                if (this._backendUsesNativeWindows(backend)) {
                    const window = backend.createNativeWindowForMonitor(
                        index,
                        gdkMonitor,
                        this._getManagedWindowTitle(index, gdkMonitor)
                    );
                    if (window)
                        this._hanabiWindows.push(window);
                    return;
                }

                const widget = backend.createWidgetForMonitor(index);
                const window = new HanabiRendererWindow(
                    this,
                    this._getManagedWindowTitle(index, gdkMonitor),
                    widget,
                    gdkMonitor
                );
                this._hanabiWindows.push(window);
            });
        }

        _destroyRendererWindows() {
            this._hanabiWindows.forEach(window => {
                try {
                    if (typeof window.destroyWindow === 'function')
                        window.destroyWindow();
                    else if (typeof window.close === 'function')
                        window.close();
                    else if (typeof window.destroy === 'function')
                        window.destroy();
                } catch (e) {
                    console.warn(e);
                }
            });
            this._hanabiWindows = [];
        }

        _syncApplicationHoldForBackend(backend) {
            const shouldHold = this._backendUsesNativeWindows(backend);
            if (shouldHold === this._nativeWindowHold)
                return;

            if (shouldHold)
                this.hold();
            else
                this.release();

            this._nativeWindowHold = shouldHold;
        }

        _getProjectLabel() {
            if (!this._project)
                return 'Invalid wallpaper project';

            return this._project.title || this._project.basename || this._project.path || 'Untitled project';
        }

        _getManagedWindowTitle(index, gdkMonitor) {
            if (nohide)
                return this._getWindowTitle(index);

            const state = {
                position: [gdkMonitor.get_geometry().x, gdkMonitor.get_geometry().y],
                keepAtBottom: true,
                keepMinimized: true,
                keepPosition: true,
            };
            return `@${applicationId}!${JSON.stringify(state)}|${index}`;
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
                    <property name="isPlaying" type="b" access="read"/>
                    <signal name="isPlayingChanged">
                        <arg name="isPlaying" type="b"/>
                    </signal>
                </interface>
            </node>`;

            const dbusImpl = {
                setPlay: () => this.setPlay(),
                setPause: () => this.setPause(),
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
            volume = _volume;
            const storedVolume = Math.round(Math.max(0.0, Math.min(1.0, _volume)) * 100.0);
            if (extSettings && extSettings.get_int('volume') !== storedVolume)
                extSettings.set_int('volume', storedVolume);

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
            this._updateWebAudioCaptureState();
            if (this._backend)
                this._backend.setPlay();
            else
                this._setPlayingState(true);
        }

        setPause() {
            this._requestedPlaying = false;
            this._updateWebAudioCaptureState();
            if (this._backend)
                this._backend.setPause();
            else
                this._setPlayingState(false);
        }

        registerWebAudioBackend(backend) {
            if (!backend)
                return;

            this._webAudioBackends.add(backend);
            backend.setAudioSamples?.(this._currentWebAudioFrame);
            this._updateWebAudioCaptureState();
        }

        unregisterWebAudioBackend(backend) {
            if (!backend)
                return;

            this._webAudioBackends.delete(backend);
            this._updateWebAudioCaptureState();
        }

        getCurrentWebAudioFrame() {
            return [...this._currentWebAudioFrame];
        }

        getLocalMediaHttpUrlPrefix() {
            return this._localMediaHttpServer?.urlPrefix ?? '';
        }

        _broadcastWebAudioFrame(frame) {
            this._currentWebAudioFrame = [...frame];
            this._webAudioBackends.forEach(backend => {
                backend.setAudioSamples?.(this._currentWebAudioFrame);
            });
        }

        _updateWebAudioCaptureState() {
            if (this._webAudioBackends.size > 0 && this._requestedPlaying) {
                this._webAudioCapture?.start();
                return;
            }

            this._webAudioCapture?.stop();
        }

        setAutoWallpaper() {
            if (changeWallpaperTimerId) {
                GLib.source_remove(changeWallpaperTimerId);
                changeWallpaperTimerId = null;
            }

            let currentIndex = 0;
            let projects = listProjects(
                changeWallpaperDirectoryPath,
                getProjectFilterFromSettings(extSettings)
            );
            if (projects.length === 0 || !changeWallpaper)
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

            operation();
            changeWallpaperTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, changeWallpaperInterval * 60, operation);
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
                    GLib.build_filenamev([extensionDir, 'renderer', 'stylesheet.css'])
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
