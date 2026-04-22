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
const {GObject, Gtk, Gio, GLib, Gdk, GdkPixbuf, Gst, GIRepository} = imports.gi;
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

let GstApp = null;
try {
    GstApp = imports.gi.GstApp;
} catch (e) {
    console.error(e);
    console.warn('GstApp, or the typelib is not installed.');
}
const haveGstApp = GstApp !== null;

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
const WebBackendKind = {
    WPE_WEBKIT: 'wpewebkit',
    GST_CEF_SRC: 'gstcefsrc',
};
const gstCefSrcWebBackendEnabled = Boolean(NativeRuntimeConfig.enableGstCefSrcWebBackend);

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

const normalizeWebBackend = value => {
    switch (`${value ?? ''}`.trim().toLowerCase()) {
    case WebBackendKind.GST_CEF_SRC:
        return WebBackendKind.GST_CEF_SRC;
    case WebBackendKind.WPE_WEBKIT:
    default:
        return WebBackendKind.WPE_WEBKIT;
    }
};

const getEffectiveWebBackend = value => {
    const normalized = normalizeWebBackend(value);
    if (normalized === WebBackendKind.GST_CEF_SRC && gstCefSrcWebBackendEnabled)
        return normalized;
    return WebBackendKind.WPE_WEBKIT;
};

const prependEnvPath = (name, value) => {
    if (!value)
        return;

    const current = GLib.getenv(name) ?? '';
    const segments = current
        .split(':')
        .filter(segment => segment !== '');
    if (segments.includes(value))
        return;

    GLib.setenv(name, [value, ...segments].join(':'), true);
};

const setEnvDefault = (name, value) => {
    if (!value || GLib.getenv(name))
        return;

    GLib.setenv(name, value, true);
};

const configureGstCefSrcEnvironment = () => {
    if (!gstCefSrcWebBackendEnabled)
        return;

    const artifactsDir = `${NativeRuntimeConfig.gstCefSrcArtifactsDir ?? ''}`;
    if (!GLib.file_test(artifactsDir, GLib.FileTest.IS_DIR)) {
        console.warn(`gstcefsrc backend enabled, but artifacts directory is unavailable: ${artifactsDir}`);
        return;
    }

    prependEnvPath('GST_PLUGIN_PATH', artifactsDir);

    const subprocessPath = `${NativeRuntimeConfig.gstCefSrcSubprocessPath ?? ''}`;
    if (GLib.file_test(subprocessPath, GLib.FileTest.IS_REGULAR))
        setEnvDefault('GST_CEF_SUBPROCESS_PATH', subprocessPath);
    else
        console.warn(`gstcefsrc subprocess binary is unavailable: ${subprocessPath}`);

    setEnvDefault('GST_CEF_CACHE_LOCATION', `${NativeRuntimeConfig.gstCefSrcCacheDir ?? '/tmp/gstcef-cache'}`);
    setEnvDefault('GST_CEF_SANDBOX', '0');
    setEnvDefault('GST_CEF_GPU_ENABLED', 'set');
    setEnvDefault(
        'GST_CEF_CHROME_EXTRA_FLAGS',
        `${NativeRuntimeConfig.gstCefSrcChromeExtraFlags ?? 'use-angle=default,ignore-gpu-blocklist,enable-gpu-rasterization,enable-logging=stderr'}`
    );
};

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
let webBackend = extSettings
    ? getEffectiveWebBackend(extSettings.get_string('web-backend'))
    : WebBackendKind.WPE_WEBKIT;
let windowDimension = {width: 1920, height: 1080};
let windowed = false;
let fullscreened = true;
let isDebugMode = extSettings ? extSettings.get_boolean('debug-mode') : true;
let changeWallpaperTimerId = null;
let argvContentFitOverride = false;
const wallpaperSwitchTransitionDurationMs = 1000;
const wallpaperSwitchTransitionCleanupDelayMs = wallpaperSwitchTransitionDurationMs + 150;
const wallpaperSwitchReadyTimeoutMs = 15000;
const formatRendererAspect = (width, height) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0)
        return 'n/a';

    return (width / height).toFixed(6);
};
const sceneUserPropertyReloadDebounceMs = 200;
// Keep the visualizer cadence aligned with the gstcefsrc backend's 60 Hz audio
// push while retaining the reusable backend's per-channel FFT output layout.
const webAudioUpdateIntervalNs = 16666667;
const webAudioOutputBandsPerChannel = 64;
const webAudioFrameLength = webAudioOutputBandsPerChannel * 2;
const webAudioPollIntervalMs = Math.max(1, Math.round(webAudioUpdateIntervalNs / 1000000));
const webAudioRestartDelayMs = 1000;
const webAudioSampleRate = 44100;
const webAudioFftSize = 2048;
const webAudioSlowProcessingLogThresholdUs = 8000;
const webAudioFrameLogIntervalFrames = Math.max(1, Math.round(5000 / webAudioPollIntervalMs));
const webAudioMinFrequencyHz = 30;
const webAudioMaxFrequencyHz = 18000;
const webAudioMinDb = -80;
const webAudioMaxDb = 0;
const webAudioSilenceRmsThreshold = 0.003;
const webAudioSpectrumOutputGain = 4.0;
const webAudioBandPeakBlend = 0.35;
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
    buildSceneUserPropertyPayload,
    buildWebUserPropertyPayload,
    getProjectFilterFromSettings,
    getProjectScenePropertyOverrides,
    getProjectWebPropertyOverrides,
    loadProject,
    listProjects,
} = ProjectLoader;

// The renderer keeps one shared user-property JSON string in memory because
// both web and scene payload builders must react to the same GSettings source.
let userPropertyStore = extSettings
    ? extSettings.get_string(UserPropertyStoreKey)
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

const buildLogBandEdgesHz = () => Array.from(
    {length: webAudioOutputBandsPerChannel + 1},
    (_unused, index) => {
        const t = index / webAudioOutputBandsPerChannel;
        return webAudioMinFrequencyHz * Math.pow(webAudioMaxFrequencyHz / webAudioMinFrequencyHz, t);
    }
);

const webAudioBandEdgesHz = buildLogBandEdgesHz();
const webAudioBandCentersHz = webAudioBandEdgesHz.slice(0, -1).map((edge, index) => {
    return Math.sqrt(edge * webAudioBandEdgesHz[index + 1]);
});
const webAudioFrequenciesHz = Array.from(
    {length: Math.floor(webAudioFftSize / 2) + 1},
    (_unused, index) => (index * webAudioSampleRate) / webAudioFftSize
);
const webAudioWindow = Float32Array.from(
    {length: webAudioFftSize},
    (_unused, index) => 0.5 * (1 - Math.cos((2 * Math.PI * index) / (webAudioFftSize - 1)))
);
const webAudioMagnitudeReference = Math.max(
    1,
    webAudioWindow.reduce((sum, sample) => sum + sample, 0) * 0.5
);
const webAudioBandBinRanges = webAudioBandEdgesHz.slice(0, -1).map((_edge, index) => {
    const low = webAudioBandEdgesHz[index];
    const high = webAudioBandEdgesHz[index + 1];
    let begin = 0;
    while (begin < webAudioFrequenciesHz.length && webAudioFrequenciesHz[begin] < low)
        begin++;
    let end = begin;
    while (end < webAudioFrequenciesHz.length && webAudioFrequenciesHz[end] < high)
        end++;
    return {begin, end};
});

const clipNumber = (value, min, max) => Math.max(min, Math.min(max, value));

const createSpectrumProcessorState = () => ({
    smoothed: new Float32Array(webAudioOutputBandsPerChannel),
    lastDb: new Float32Array(webAudioOutputBandsPerChannel).fill(webAudioMinDb),
    bandDb: new Float32Array(webAudioOutputBandsPerChannel),
    normalized: new Float32Array(webAudioOutputBandsPerChannel),
    horizontallySmoothed: new Float32Array(webAudioOutputBandsPerChannel),
    real: new Float64Array(webAudioFftSize),
    imag: new Float64Array(webAudioFftSize),
    magnitudes: new Float32Array(Math.floor(webAudioFftSize / 2) + 1),
    normalizedMagnitudes: new Float32Array(Math.floor(webAudioFftSize / 2) + 1),
    binDb: new Float32Array(Math.floor(webAudioFftSize / 2) + 1),
});

const appendMonoChunk = (buffer, chunk) => {
    if (!(buffer instanceof Float32Array) || !(chunk instanceof Float32Array) || chunk.length === 0)
        return buffer;

    if (chunk.length >= buffer.length) {
        buffer.set(chunk.subarray(chunk.length - buffer.length));
        return buffer;
    }

    buffer.copyWithin(0, chunk.length);
    buffer.set(chunk, buffer.length - chunk.length);
    return buffer;
};

const appendInterleavedStereoChunk = (leftBuffer, rightBuffer, interleaved, frameCount) => {
    if (!(leftBuffer instanceof Float32Array) || !(rightBuffer instanceof Float32Array) ||
        !(interleaved instanceof Float32Array) || frameCount <= 0)
        return;

    const capacity = Math.min(leftBuffer.length, rightBuffer.length);
    if (frameCount >= capacity) {
        const startFrame = frameCount - capacity;
        for (let i = 0; i < capacity; i++) {
            const sourceIndex = (startFrame + i) * 2;
            const left = interleaved[sourceIndex] ?? 0;
            leftBuffer[i] = left;
            rightBuffer[i] = interleaved[sourceIndex + 1] ?? left;
        }
        return;
    }

    leftBuffer.copyWithin(0, frameCount);
    rightBuffer.copyWithin(0, frameCount);
    const writeOffset = capacity - frameCount;
    for (let i = 0; i < frameCount; i++) {
        const sourceIndex = i * 2;
        const left = interleaved[sourceIndex] ?? 0;
        leftBuffer[writeOffset + i] = left;
        rightBuffer[writeOffset + i] = interleaved[sourceIndex + 1] ?? left;
    }
};

const interpolateLinearly = (xs, ys, target) => {
    if (!Array.isArray(xs) || !(ys instanceof Float32Array) || xs.length === 0 || ys.length === 0)
        return webAudioMinDb;

    if (target <= xs[0])
        return ys[0];
    const lastIndex = Math.min(xs.length, ys.length) - 1;
    if (target >= xs[lastIndex])
        return ys[lastIndex];

    let lowerIndex = 0;
    while (lowerIndex < lastIndex && xs[lowerIndex + 1] < target)
        lowerIndex++;

    const upperIndex = Math.min(lastIndex, lowerIndex + 1);
    const lowerX = xs[lowerIndex];
    const upperX = xs[upperIndex];
    if (upperX <= lowerX)
        return ys[lowerIndex];

    const mix = (target - lowerX) / (upperX - lowerX);
    return ys[lowerIndex] + (ys[upperIndex] - ys[lowerIndex]) * mix;
};

const resampleSpectrumValues = (values, resolution) => {
    const targetSize = Math.max(0, Number(resolution) || 0);
    const sourceSize = values?.length ?? 0;
    const result = new Array(targetSize).fill(0);
    if (targetSize === 0 || sourceSize === 0)
        return result;

    if (targetSize === sourceSize)
        return Array.from(values);

    for (let i = 0; i < targetSize; i++) {
        const sourcePosition = ((i + 0.5) * sourceSize / targetSize) - 0.5;
        const clampedPosition = clipNumber(sourcePosition, 0, sourceSize - 1);
        const lowerIndex = Math.floor(clampedPosition);
        const upperIndex = Math.min(sourceSize - 1, lowerIndex + 1);
        const mix = clampedPosition - lowerIndex;
        const lowerValue = Number(values[lowerIndex] ?? 0);
        const upperValue = Number(values[upperIndex] ?? 0);
        result[i] = lowerValue + (upperValue - lowerValue) * mix;
    }
    return result;
};

const shouldLogWebAudioFrame = frameCount =>
    frameCount <= 8 || frameCount % webAudioFrameLogIntervalFrames === 0;

const normalizeAbsoluteSpectrumMagnitude = magnitude =>
    clipNumber(((Number(magnitude) || 0) / webAudioMagnitudeReference) * webAudioSpectrumOutputGain, 0, 1);

const magnitudeToDb = magnitude => {
    if (!Number.isFinite(magnitude) || magnitude <= 0)
        return webAudioMinDb;
    return clipNumber(20 * Math.log10(magnitude + 1e-12), webAudioMinDb, webAudioMaxDb);
};

const computeSceneLow16Pair = values => {
    const bins16 = resampleSpectrumValues(values, 16);
    return [Number(bins16[0] ?? 0), Number(bins16[1] ?? 0)];
};

const computeSceneLow16Average = (leftPair, rightPair) =>
    (Number(leftPair[0] ?? 0) + Number(leftPair[1] ?? 0) +
        Number(rightPair[0] ?? 0) + Number(rightPair[1] ?? 0)) * 0.25;

const formatSpectrumPair = values =>
    `[${Number(values[0] ?? 0).toFixed(4)}, ${Number(values[1] ?? 0).toFixed(4)}]`;

const computeRfftMagnitudes = (pcm, state) => {
    const real = state.real;
    const imag = state.imag;
    const magnitudes = state.magnitudes;

    real.fill(0);
    imag.fill(0);

    for (let i = 0; i < webAudioFftSize; i++)
        real[i] = (pcm[i] ?? 0) * webAudioWindow[i];

    for (let i = 1, j = 0; i < webAudioFftSize; i++) {
        let bit = webAudioFftSize >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if (i < j) {
            const realValue = real[i];
            real[i] = real[j];
            real[j] = realValue;
            const imagValue = imag[i];
            imag[i] = imag[j];
            imag[j] = imagValue;
        }
    }

    for (let size = 2; size <= webAudioFftSize; size <<= 1) {
        const halfSize = size >> 1;
        const theta = (-2 * Math.PI) / size;
        const phaseRealStep = Math.cos(theta);
        const phaseImagStep = Math.sin(theta);
        for (let offset = 0; offset < webAudioFftSize; offset += size) {
            let phaseReal = 1;
            let phaseImag = 0;
            for (let i = 0; i < halfSize; i++) {
                const evenIndex = offset + i;
                const oddIndex = evenIndex + halfSize;
                const oddReal = real[oddIndex] * phaseReal - imag[oddIndex] * phaseImag;
                const oddImag = real[oddIndex] * phaseImag + imag[oddIndex] * phaseReal;
                real[oddIndex] = real[evenIndex] - oddReal;
                imag[oddIndex] = imag[evenIndex] - oddImag;
                real[evenIndex] += oddReal;
                imag[evenIndex] += oddImag;
                const nextPhaseReal = phaseReal * phaseRealStep - phaseImag * phaseImagStep;
                const nextPhaseImag = phaseReal * phaseImagStep + phaseImag * phaseRealStep;
                phaseReal = nextPhaseReal;
                phaseImag = nextPhaseImag;
            }
        }
    }

    for (let index = 0; index < magnitudes.length; index++)
        magnitudes[index] = Math.hypot(real[index], imag[index]);
    return magnitudes;
};

const applyHorizontalSmoothing = (values, target) => {
    for (let i = 0; i < values.length; i++) {
        const left = values[Math.max(0, i - 1)] ?? 0;
        const center = values[i] ?? 0;
        const right = values[Math.min(values.length - 1, i + 1)] ?? 0;
        target[i] = left * 0.08 + center * 0.84 + right * 0.08;
    }
    return target;
};

const processSpectrumFrame = (pcm, state) => {
    if (!(pcm instanceof Float32Array) || !(state?.smoothed instanceof Float32Array))
        return {
            values: new Float32Array(webAudioOutputBandsPerChannel),
            dbValues: new Float32Array(webAudioOutputBandsPerChannel).fill(webAudioMinDb),
            rms: 0,
            framePeak: 0,
        };

    const rms = Math.sqrt(pcm.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, pcm.length) + 1e-12);
    if (rms < webAudioSilenceRmsThreshold) {
        for (let i = 0; i < webAudioOutputBandsPerChannel; i++)
            state.smoothed[i] *= 0.82;
        state.lastDb.fill(webAudioMinDb);
        return {
            values: state.smoothed,
            dbValues: state.lastDb,
            rms,
            framePeak: 0,
        };
    }

    const magnitudes = computeRfftMagnitudes(pcm, state);
    const normalizedMagnitudes = state.normalizedMagnitudes;
    let framePeak = 0;
    const binDb = state.binDb;
    for (let i = 0; i < magnitudes.length; i++) {
        const normalizedMagnitude = normalizeAbsoluteSpectrumMagnitude(magnitudes[i]);
        normalizedMagnitudes[i] = normalizedMagnitude;
        framePeak = Math.max(framePeak, normalizedMagnitude);
        binDb[i] = magnitudeToDb(normalizedMagnitude);
    }

    const bandDb = state.bandDb;
    const normalized = state.normalized;
    for (let i = 0; i < webAudioOutputBandsPerChannel; i++) {
        const centerMagnitude = interpolateLinearly(
            webAudioFrequenciesHz,
            normalizedMagnitudes,
            webAudioBandCentersHz[i]
        );

        let powerSum = 0;
        let sampleCount = 0;
        let peakMagnitude = 0;
        const {begin, end} = webAudioBandBinRanges[i];
        for (let bin = begin; bin < end; bin++) {
            const magnitude = normalizedMagnitudes[bin] ?? 0;
            powerSum += magnitude * magnitude;
            peakMagnitude = Math.max(peakMagnitude, magnitude);
            sampleCount++;
        }

        let bandMagnitude = centerMagnitude;
        if (sampleCount > 0) {
            const rmsMagnitude = Math.sqrt(powerSum / sampleCount + 1e-12);
            const blendedPeakMagnitude =
                peakMagnitude * webAudioBandPeakBlend + rmsMagnitude * (1 - webAudioBandPeakBlend);
            bandMagnitude = Math.max(centerMagnitude, blendedPeakMagnitude);
        }

        bandMagnitude = clipNumber(bandMagnitude, 0, 1);
        normalized[i] = bandMagnitude;
        bandDb[i] = magnitudeToDb(bandMagnitude);
    }

    state.lastDb.set(bandDb);
    const horizontallySmoothed = applyHorizontalSmoothing(normalized, state.horizontallySmoothed);
    for (let i = 0; i < webAudioOutputBandsPerChannel; i++) {
        const target = horizontallySmoothed[i];
        const current = state.smoothed[i];
        state.smoothed[i] = target > current
            ? current * 0.25 + target * 0.75
            : current * 0.75 + target * 0.25;
    }

    return {
        values: state.smoothed,
        dbValues: state.lastDb,
        rms,
        framePeak,
    };
};

class WebAudioVisualizerCapture {
    constructor(onFrame) {
        this._onFrame = onFrame;
        this._pipeline = null;
        this._appsink = null;
        this._bus = null;
        this._busSignalIds = [];
        this._pollSourceId = 0;
        this._processingSourceId = 0;
        this._restartSourceId = 0;
        this._shouldRun = false;
        this._isAvailable = true;
        this._lastFrame = buildSilentWebAudioFrame();
        this._workingFrame = buildSilentWebAudioFrame();
        this._pendingInterleavedChunk = null;
        this._pendingInterleavedFrameCount = 0;
        this._leftSampleBuffer = new Float32Array(webAudioFftSize * 2);
        this._rightSampleBuffer = new Float32Array(webAudioFftSize * 2);
        this._leftProcessorState = createSpectrumProcessorState();
        this._rightProcessorState = createSpectrumProcessorState();
        this._emittedFrameCount = 0;
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

    stop({emitSilence = true, reason = 'unspecified'} = {}) {
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

    _resetSpectrumState() {
        this._leftSampleBuffer.fill(0);
        this._rightSampleBuffer.fill(0);
        this._leftProcessorState = createSpectrumProcessorState();
        this._rightProcessorState = createSpectrumProcessorState();
        this._emittedFrameCount = 0;
        this._pendingInterleavedChunk = null;
        this._pendingInterleavedFrameCount = 0;
    }

    _startPipeline() {
        if (!Gst.ElementFactory.find('pulsesrc')) {
            console.warn('Web audio visualizer capture unavailable: GStreamer pulsesrc plugin is missing');
            this._isAvailable = false;
            this._emitFrame(buildSilentWebAudioFrame());
            return;
        }

        if (!haveGstApp || !Gst.ElementFactory.find('appsink')) {
            console.warn('Web audio visualizer capture unavailable: GStreamer appsink plugin is missing');
            this._isAvailable = false;
            this._emitFrame(buildSilentWebAudioFrame());
            return;
        }

        try {
            this._pipeline = Gst.parse_launch(
                'pulsesrc device=@DEFAULT_MONITOR@ client-name=HanabiVisualizer do-timestamp=true ! ' +
                'audioconvert ! audioresample ! ' +
                `audio/x-raw,format=F32LE,channels=2,rate=${webAudioSampleRate} ! ` +
                'appsink name=audio_sink emit-signals=false max-buffers=1 drop=true sync=false'
            );
        } catch (e) {
            console.warn(`Failed to create web audio visualizer pipeline: ${e}`);
            this._scheduleRestart();
            return;
        }

        this._appsink = this._pipeline.get_by_name('audio_sink');
        if (!this._appsink) {
            console.warn('Web audio visualizer capture pipeline did not expose appsink');
            this._scheduleRestart();
            return;
        }

        this._resetSpectrumState();

        this._bus = this._pipeline.get_bus();
        this._bus.add_signal_watch();
        this._busSignalIds = [
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
        } else {
            this._pollSourceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                webAudioPollIntervalMs,
                () => {
                    try {
                        this._pullLatestAudioSample();
                    } catch (e) {
                        console.warn(`Web audio visualizer polling failed: ${e}`);
                    }
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }
    }

    _pullLatestAudioSample() {
        if (!this._appsink)
            return;

        const sample = this._appsink.emit('try-pull-sample', 0);
        if (!sample)
            return;

        const buffer = sample.get_buffer?.();
        if (!buffer)
            return;

        const [mapped, mapInfo] = buffer.map(Gst.MapFlags.READ);
        if (!mapped || !mapInfo?.data || mapInfo.size < Float32Array.BYTES_PER_ELEMENT) {
            if (mapped)
                buffer.unmap(mapInfo);
            return;
        }

        const interleaved = new Float32Array(
            mapInfo.data.buffer,
            mapInfo.data.byteOffset,
            Math.floor(mapInfo.size / Float32Array.BYTES_PER_ELEMENT)
        );
        const frameCount = Math.floor(interleaved.length / 2);
        const interleavedCopy = new Float32Array(frameCount * 2);
        interleavedCopy.set(interleaved.subarray(0, frameCount * 2));
        buffer.unmap(mapInfo);

        this._pendingInterleavedChunk = interleavedCopy;
        this._pendingInterleavedFrameCount = frameCount;
        this._schedulePendingAudioProcessing();
    }

    _schedulePendingAudioProcessing() {
        if (this._processingSourceId)
            return;

        this._processingSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._processingSourceId = 0;
            try {
                this._processPendingAudioChunk();
            } catch (e) {
                console.warn(`Web audio visualizer processing failed: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _processPendingAudioChunk() {
        const interleaved = this._pendingInterleavedChunk;
        const frameCount = this._pendingInterleavedFrameCount;
        this._pendingInterleavedChunk = null;
        this._pendingInterleavedFrameCount = 0;
        if (!(interleaved instanceof Float32Array) || frameCount <= 0)
            return;

        const startedAtUs = GLib.get_monotonic_time();
        appendInterleavedStereoChunk(this._leftSampleBuffer, this._rightSampleBuffer, interleaved, frameCount);

        const leftProcessed = processSpectrumFrame(this._leftSampleBuffer.subarray(this._leftSampleBuffer.length - webAudioFftSize), this._leftProcessorState);
        const rightProcessed = processSpectrumFrame(this._rightSampleBuffer.subarray(this._rightSampleBuffer.length - webAudioFftSize), this._rightProcessorState);
        const normalized = this._workingFrame;
        for (let i = 0; i < webAudioOutputBandsPerChannel; i++) {
            normalized[i] = leftProcessed.values[i];
            normalized[i + webAudioOutputBandsPerChannel] = rightProcessed.values[i];
        }

        this._emittedFrameCount++;
        if (shouldLogWebAudioFrame(this._emittedFrameCount)) {
            const leftSceneLow16 = computeSceneLow16Pair(leftProcessed.values);
            const rightSceneLow16 = computeSceneLow16Pair(rightProcessed.values);
            const sceneLow16Average = computeSceneLow16Average(leftSceneLow16, rightSceneLow16);
            const frameMax = normalized.reduce((max, value) => Math.max(max, Number(value) || 0), 0);
            console.log(
                `Web audio visualizer frame: rms(left/right)=${leftProcessed.rms.toFixed(4)}/${rightProcessed.rms.toFixed(4)} peak(left/right)=${leftProcessed.framePeak.toFixed(4)}/${rightProcessed.framePeak.toFixed(4)}`
            );
            console.log(
                `HanabiScene audio samples: max=${frameMax.toFixed(4)} scene16-avg2ch=${sceneLow16Average.toFixed(4)} scene16-low(left/right)=${formatSpectrumPair(leftSceneLow16)}/${formatSpectrumPair(rightSceneLow16)} bands=${normalized.length}`
            );
        }

        this._emitFrame(normalized);

        const elapsedUs = GLib.get_monotonic_time() - startedAtUs;
        if (elapsedUs >= webAudioSlowProcessingLogThresholdUs) {
            console.warn(
                `Web audio visualizer processing slow: ${(elapsedUs / 1000).toFixed(2)}ms frameCount=${frameCount} pollIntervalMs=${webAudioPollIntervalMs}`
            );
        }

        if (this._pendingInterleavedChunk)
            this._schedulePendingAudioProcessing();
    }

    _emitFrame(frame) {
        const emittedFrame = [...frame];
        this._lastFrame = emittedFrame;
        this._onFrame?.(emittedFrame);
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
        if (this._pollSourceId) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = 0;
        }

        if (this._processingSourceId) {
            GLib.source_remove(this._processingSourceId);
            this._processingSourceId = 0;
        }

        this._pendingInterleavedChunk = null;
        this._pendingInterleavedFrameCount = 0;

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
            const pipeline = this._pipeline;
            this._pipeline = null;
            this._appsink = null;
            try {
                pipeline.set_state(Gst.State.NULL);
                pipeline.get_state(Gst.SECOND);
            } catch (e) {
                console.warn(`Web audio visualizer pipeline stop wait failed: ${e}`);
            }
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
    // gstcefsrc uses Soup for its local asset bridge, while the scene backend
    // still needs GdkPixbuf for thumbnail decoding and serialization.
    Soup,
    GdkPixbuf,
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
        enableGstCefSrcWebBackend: gstCefSrcWebBackendEnabled,
    },
    state: {
        getContentFit: () => contentFit,
        getMute: () => mute,
        getVolume: () => volume,
        getSceneFps: () => sceneFps,
        getWebBackend: () => webBackend,
    },
});

let deferredGarbageCollectionSourceId = 0;
let rendererCssProvider = null;
const detachedWallpaperWidgetReleases = new WeakSet();

const disposeDetachedObject = object => {
    if (!object)
        return;

    try {
        object.run_dispose?.();
    } catch (_e) {
    }
};

const detachWallpaperChildWidget = (widget, childWidget) => {
    if (!widget || !childWidget)
        return;

    let parent = null;
    try {
        parent = childWidget.get_parent?.() ?? null;
    } catch (_e) {
        return;
    }

    if (parent !== widget)
        return;

    try {
        if ((widget.get_child?.() ?? null) === childWidget) {
            widget.set_child?.(null);
            return;
        }
    } catch (_e) {
    }

    try {
        widget.remove_overlay?.(childWidget);
    } catch (_e) {
    }

    try {
        if ((childWidget.get_parent?.() ?? null) === widget)
            widget.remove?.(childWidget);
    } catch (_e) {
    }
};

const releaseDetachedWallpaperWidget = widget => {
    if (!widget)
        return;

    if (detachedWallpaperWidgetReleases.has(widget))
        return;
    detachedWallpaperWidgetReleases.add(widget);

    const children = [];
    let child = widget.get_first_child?.() ?? null;
    while (child) {
        children.push(child);
        child = child.get_next_sibling?.() ?? null;
    }

    try {
        widget.pause?.();
    } catch (_e) {
    }

    try {
        widget.set_paintable?.(null);
    } catch (_e) {
    }

    try {
        if ('paintable' in widget)
            widget.paintable = null;
    } catch (_e) {
    }

    children.forEach(childWidget => detachWallpaperChildWidget(widget, childWidget));
    children.forEach(releaseDetachedWallpaperWidget);

    disposeDetachedObject(widget);
};

const runGarbageCollection = () => {
    try {
        System.gc();
    } catch (e) {
        console.warn(`Failed to trigger GJS GC: ${e}`);
    }

    if (deferredGarbageCollectionSourceId)
        return;

    deferredGarbageCollectionSourceId = GLib.idle_add(
        GLib.PRIORITY_DEFAULT_IDLE,
        () => {
            deferredGarbageCollectionSourceId = 0;
            try {
                System.gc();
            } catch (e) {
                console.warn(`Failed to trigger deferred GJS GC: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        }
    );
};

const ensureRendererCssProvider = () => {
    if (rendererCssProvider)
        return rendererCssProvider;

    rendererCssProvider = new Gtk.CssProvider();
    rendererCssProvider.load_from_file(
        Gio.File.new_for_path(
            GLib.build_filenamev([extensionDir, 'renderer', 'stylesheet.css'])
        )
    );

    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        rendererCssProvider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    );

    return rendererCssProvider;
};


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
            this._audioSampleBackends = new Set();
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
                this._resetBackend();
                this._unexportDbus();
                this._webAudioCapture?.destroy();
                this._webAudioCapture = null;
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
                case 'web-backend': {
                    const nextWebBackend = getEffectiveWebBackend(settings.get_string(key));
                    if (nextWebBackend === webBackend)
                        break;

                    webBackend = nextWebBackend;
                    if (this._project?.type === ProjectType.WEB || this._pendingSwitch?.project?.type === ProjectType.WEB)
                        this._switchProject();
                    break;
                }
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
                    // A single neutral key is authoritative for both backends;
                    // any change can affect the active project's generated web
                    // or scene payload, so reload the current project state.
                    userPropertyStore = settings.get_string(key);
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

            const previousBackend = this._backend;

            if (!previousBackend) {
                const nextBackend = this._createBackend(nextProject);
                this._project = nextProject;
                this._backend = nextBackend;
                this._syncApplicationHoldForBackend(this._backend);
                this._rebuildRendererWindows(this._backend);
                this._applyActiveBackendSettings(this._backend, this._project);
                this.setAutoWallpaper();
                console.log(`using ${this._backend.displayName} for ${this._getProjectLabel()}`);
                return;
            }

            if (this._reuseActiveBackendForProject(nextProject))
                return;

            const nextBackend = this._createBackend(nextProject);

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

        _reuseActiveBackendForProject(nextProject) {
            if (!this._backend?.canReuseForProject?.(nextProject))
                return false;

            if (!this._backend.switchProject?.(nextProject))
                return false;

            // Scene backends follow the KDE plugin's persistent item model: the
            // Gtk window and native render target stay mounted while the current
            // backend updates its SceneWallpaper source.  That means the normal
            // crossfade path, which builds a second backend and second target, is
            // skipped for scene-to-scene switches.
            this._project = nextProject;
            this._syncApplicationHoldForBackend(this._backend);
            this._applyActiveBackendSettings(this._backend, this._project);
            this.setAutoWallpaper();
            this._hanabiWindows.forEach((window, index) => {
                if (nohide)
                    window.set_title(this._getWindowTitle(index));
            });
            console.log(`reusing ${this._backend.displayName} for ${this._getProjectLabel()}`);
            return true;
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
            this._webAudioCapture?.stop({emitSilence: false, reason: 'renderer-reset'});
            this._audioSampleBackends.clear();
            this._currentWebAudioFrame = buildSilentWebAudioFrame();
            this._destroyRendererWindows();
            this._backend?.destroy();
            this._backend = null;
            this._project = null;
            this._syncApplicationHoldForBackend(null);
            this._setPlayingState(false);

            this._backendDestroySourceIds.forEach(sourceId => GLib.source_remove(sourceId));
            this._backendDestroySourceIds.clear();
            runGarbageCollection();
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
            runGarbageCollection();
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
                wallpaperSwitchTransitionCleanupDelayMs + 50,
                () => {
                    this._backendDestroySourceIds.delete(sourceId);
                    backend.destroy();
                    runGarbageCollection();
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

        registerAudioSamplesBackend(backend) {
            if (!backend)
                return;

            this._audioSampleBackends.add(backend);
            backend.setAudioSamples?.(this._currentWebAudioFrame);
            this._updateWebAudioCaptureState();
        }

        unregisterAudioSamplesBackend(backend) {
            if (!backend)
                return;

            this._audioSampleBackends.delete(backend);
            this._updateWebAudioCaptureState();
        }

        registerWebAudioBackend(backend) {
            this.registerAudioSamplesBackend(backend);
        }

        unregisterWebAudioBackend(backend) {
            this.unregisterAudioSamplesBackend(backend);
        }

        getCurrentWebAudioFrame() {
            return [...this._currentWebAudioFrame];
        }

        getLocalMediaHttpUrlPrefix() {
            return this._localMediaHttpServer?.urlPrefix ?? '';
        }

        _broadcastWebAudioFrame(frame) {
            this._currentWebAudioFrame = Array.isArray(frame) ? frame : [...frame];
            this._audioSampleBackends.forEach(backend => {
                backend.setAudioSamples?.(this._currentWebAudioFrame);
            });
        }

        _updateWebAudioCaptureState() {
            if (this._audioSampleBackends.size > 0 && this._requestedPlaying) {
                this._webAudioCapture?.start();
                return;
            }

            const reason = this._audioSampleBackends.size === 0
                ? 'no-audio-backends'
                : 'playback-paused';
            this._webAudioCapture?.stop({reason});
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
	            this._windowTitleForLog = title;
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
	            ensureRendererCssProvider();

	            super.set_child(this._wallpaperOverlay);
	            this._logWindowGeometry('construct-before-child', widget);
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
	            this._logWindowGeometry('construct-after-layout');
	            this._queueWindowGeometryLog('construct-idle');
	            this.connect('map', () => {
	                this._logWindowGeometry('window-map');
	                this._queueWindowGeometryLog('window-map-idle');
	            });
	        }

	        _describeMonitorForLog() {
	            const geometry = this._gdkMonitor?.get_geometry?.() ?? null;
	            if (!geometry)
	                return 'monitor=n/a monitor-aspect=n/a monitor-scale=n/a';

	            return `monitor=${geometry.x},${geometry.y} ${geometry.width}x${geometry.height} ` +
	                `monitor-aspect=${formatRendererAspect(geometry.width, geometry.height)} ` +
	                `monitor-scale=${this._gdkMonitor.get_scale_factor?.() ?? 'n/a'}`;
	        }

	        _describeWidgetForLog(label, widget) {
	            if (!widget)
	                return `${label}=n/a`;

	            const width = widget.get_width?.() ?? 'n/a';
	            const height = widget.get_height?.() ?? 'n/a';
	            const scale = widget.get_scale_factor?.() ?? 'n/a';
	            return `${label}=${width}x${height} ${label}-aspect=${formatRendererAspect(width, height)} ${label}-scale=${scale}`;
	        }

	        _logWindowGeometry(phase, candidateWidget = null) {
	            const child = this._wallpaperOverlay?.get_child?.() ?? candidateWidget;
	            // This diagnostic sits after the backend texture has been handed to GTK.
	            // If the whole scene looks horizontally compressed while native render
	            // targets report the expected aspect, the window/overlay/child sizes here
	            // show whether GTK is stretching the final presentation widget.
	            console.log(
	                `HanabiRenderer geometry: phase=${phase} title='${this._windowTitleForLog}' ` +
	                `windowed=${windowed} fullscreened=${fullscreened} nohide=${nohide} ` +
	                `default=${windowDimension.width}x${windowDimension.height} ` +
	                `window=${this.get_width?.() ?? 'n/a'}x${this.get_height?.() ?? 'n/a'} ` +
	                `window-aspect=${formatRendererAspect(this.get_width?.() ?? NaN, this.get_height?.() ?? NaN)} ` +
	                `${this._describeMonitorForLog()} ` +
	                `${this._describeWidgetForLog('overlay', this._wallpaperOverlay)} ` +
	                `${this._describeWidgetForLog('child', child)}`
	            );
	        }

	        _queueWindowGeometryLog(phase) {
	            // GTK computes the first non-zero allocations asynchronously.  The idle
	            // pass captures the dimensions after layout has settled for the current
	            // frame, which is where a presentation-only aspect error becomes visible.
	            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
	                if (this._wallpaperOverlay)
	                    this._logWindowGeometry(phase);

	                return GLib.SOURCE_REMOVE;
	            });
	        }

	        setWallpaperWidget(widget) {
	            this._prepareWallpaperWidget(widget);
	            const previousWidget = this._wallpaperOverlay.get_child();
	            this._discardWallpaperTransition();
	            this._wallpaperOverlay.set_child(widget);
	            this._logWindowGeometry('set-wallpaper-widget', widget);
	            this._queueWindowGeometryLog('set-wallpaper-widget-idle');
	            if (previousWidget && previousWidget !== widget)
	                releaseDetachedWallpaperWidget(previousWidget);
	        }

	        stageWallpaperWidget(widget) {
            this._prepareWallpaperWidget(widget);

            const previousWidget = this._wallpaperOverlay.get_child();
	            this.cancelWallpaperTransition();
	            this._wallpaperOverlay.set_child(widget);
	            this._logWindowGeometry('stage-wallpaper-widget', widget);
	            this._queueWindowGeometryLog('stage-wallpaper-widget-idle');

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
                    const discardedWidget = this._discardWallpaperTransition();
                    releaseDetachedWallpaperWidget(discardedWidget);
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        cancelWallpaperTransition() {
            if (!this._transitionRevealer)
                return;

            const previousWidget = this._transitionCommitted ? null : this._transitionRevealer.get_child();
            const discardedWidget = this._transitionCommitted ? null : this._wallpaperOverlay.get_child();
            const detachedTransitionWidget = this._discardWallpaperTransition();
            if (previousWidget)
                this._wallpaperOverlay.set_child(previousWidget);
            if (discardedWidget && discardedWidget !== previousWidget)
                releaseDetachedWallpaperWidget(discardedWidget);
            if (detachedTransitionWidget && detachedTransitionWidget !== previousWidget)
                releaseDetachedWallpaperWidget(detachedTransitionWidget);
        }

        destroyWindow() {
            this.cancelWallpaperTransition();

            const currentWidget = this._wallpaperOverlay?.get_child?.() ?? null;
            if (currentWidget) {
                try {
                    this._wallpaperOverlay.set_child(null);
                } catch (_e) {
                }
                releaseDetachedWallpaperWidget(currentWidget);
            }

            const detachedTransitionWidget = this._discardWallpaperTransition();
            releaseDetachedWallpaperWidget(detachedTransitionWidget);

            try {
                super.set_child(null);
            } catch (_e) {
            }

            this.destroy();
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
            let detachedWidget = null;
            if (this._transitionCleanupId) {
                GLib.source_remove(this._transitionCleanupId);
                this._transitionCleanupId = 0;
            }

            if (this._transitionRevealer) {
                detachedWidget = this._transitionRevealer.get_child();
                this._transitionRevealer.set_child(null);
                this._wallpaperOverlay.remove_overlay(this._transitionRevealer);
                this._transitionRevealer = null;
            }

            this._transitionCommitted = false;
            return detachedWidget;
        }
    }
);

configureGstCefSrcEnvironment();
Gst.init(null);

let renderer = new HanabiRenderer();
renderer.run(ARGV);
