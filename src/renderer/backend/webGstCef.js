var createWebGstCefBackendClass = (env, helpers, baseClasses) => {
    const {
        Gtk,
        Gio,
        GLib,
        Gst,
        GstPlay,
        GstAudio,
        flags,
        state,
    } = env;
    const {
        forceMediaFile,
        forceGtk4PaintableSink,
        haveGstPlay,
        haveGstAudio,
        useGstGL,
        haveContentFit,
        haveGraphicsOffload,
    } = flags;
    const {setExpandFill, createConfiguredPicture, LocalWebProjectHttpServer} = helpers;
    const {BackendController} = baseClasses;
    const defaultAudioFrame = new Array(128).fill(0);
    const RESUME_FREEZE_HOLD_MS = 120;

    const normalizeWebFilesystemPath = path => {
        if (typeof path !== 'string')
            return path;

        if (/^[A-Za-z]:[\\/]/.test(path))
            return path;

        if (path.startsWith('/'))
            return path.replace(/^\/+/, '');

        return path;
    };

    const buildBootstrapScript = (stateEndpointPath, localMediaHttpUrlPrefix, initialState) => `
        (function() {
            if (window.__hanabiPlaybackBridgeInstalled)
                return;
            window.__hanabiPlaybackBridgeInstalled = true;

            try {
                delete window.ontouchstart;
            } catch (_e) {
            }

            try {
                const proto = Object.getPrototypeOf(window);
                if (proto)
                    delete proto.ontouchstart;
            } catch (_e) {
            }

            try {
                Object.defineProperty(navigator, 'maxTouchPoints', {
                    configurable: true,
                    get() {
                        return 0;
                    },
                });
            } catch (_e) {
            }

            const hanabiMediaHttpUrlPrefix = ${JSON.stringify(localMediaHttpUrlPrefix)};
            const stateEndpoint = ${JSON.stringify(stateEndpointPath)};
            function rewriteMediaUrl(rawValue) {
                if (typeof rawValue !== 'string' || rawValue === '')
                    return rawValue;

                if (rawValue.startsWith('blob:') || rawValue.startsWith('data:'))
                    return rawValue;

                let resolvedUrl = null;
                try {
                    resolvedUrl = new URL(rawValue, document.baseURI);
                } catch (_e) {
                    return rawValue;
                }

                if (resolvedUrl.protocol !== 'file:')
                    return rawValue;

                let decodedPath = resolvedUrl.pathname || '';
                try {
                    decodedPath = decodeURIComponent(decodedPath);
                } catch (_e) {
                }

                return hanabiMediaHttpUrlPrefix
                    ? hanabiMediaHttpUrlPrefix + encodeURIComponent(decodedPath)
                    : rawValue;
            }
            function patchSrcProperty(proto) {
                if (!proto)
                    return;

                const descriptor = Object.getOwnPropertyDescriptor(proto, 'src');
                if (!descriptor?.set || descriptor.set.__hanabiWrapped)
                    return;

                const wrappedSetter = function(value) {
                    return descriptor.set.call(this, rewriteMediaUrl(value));
                };
                wrappedSetter.__hanabiWrapped = true;

                Object.defineProperty(proto, 'src', {
                    configurable: descriptor.configurable,
                    enumerable: descriptor.enumerable,
                    get: descriptor.get,
                    set: wrappedSetter,
                });
            }
            function patchSetAttribute(proto) {
                if (!proto || proto.setAttribute?.__hanabiWrapped)
                    return;

                const originalSetAttribute = proto.setAttribute;
                const wrappedSetAttribute = function(name, value) {
                    if (String(name).toLowerCase() === 'src' && typeof value === 'string')
                        return originalSetAttribute.call(this, name, rewriteMediaUrl(value));
                    return originalSetAttribute.call(this, name, value);
                };
                wrappedSetAttribute.__hanabiWrapped = true;
                proto.setAttribute = wrappedSetAttribute;
            }

            patchSrcProperty(window.HTMLMediaElement?.prototype);
            patchSrcProperty(window.HTMLSourceElement?.prototype);
            patchSetAttribute(window.HTMLMediaElement?.prototype);
            patchSetAttribute(window.HTMLSourceElement?.prototype);

            const bridgeState = {
                version: -1,
                directorySnapshots: {},
                generalProperties: {},
                paused: false,
                userProperties: {},
            };
            let wallpaperPropertyListenerValue = window.wallpaperPropertyListener;
            let bridgeCallbacksReady = document.readyState === 'complete';
            let bridgeReplayPending = false;
            let bridgeReplayScheduled = false;

            // GameMaker HTML5 runtimes used by older Wallpaper Engine projects
            // inspect function.caller/function.arguments while formatting fatal
            // errors. Chromium throws when that walk reaches strict, async, or
            // arrow-function frames, so every bridge path that can call project
            // code intentionally uses classic functions and timer/XHR callbacks.
            function getPropertyListener() {
                const listener = wallpaperPropertyListenerValue;
                if (!listener || typeof listener !== 'object')
                    return null;
                return listener;
            }

            function logWallpaperBridgeError(methodName, error) {
                const message = error && (error.stack || error.message || String(error));
                console.warn('[Hanabi] wallpaper bridge callback failed in ' + methodName + ': ' + message);
            }

            function safeInvokeWallpaperListener(listener, methodName, args) {
                if (!listener || typeof listener[methodName] !== 'function')
                    return;

                try {
                    listener[methodName].apply(listener, args || []);
                } catch (error) {
                    // Keep a project-side bridge callback failure from escaping
                    // into GameMaker's global fatal-error handler. The warning is
                    // deliberately explicit so run.log still records which WE API
                    // callback needs the next compatibility adjustment.
                    logWallpaperBridgeError(methodName, error);
                }
            }

            function flushUserProperties() {
                safeInvokeWallpaperListener(getPropertyListener(), 'applyUserProperties', [bridgeState.userProperties]);
            }

            function flushGeneralProperties() {
                safeInvokeWallpaperListener(getPropertyListener(), 'applyGeneralProperties', [bridgeState.generalProperties]);
            }

            function flushPausedState() {
                safeInvokeWallpaperListener(getPropertyListener(), 'setPaused', [bridgeState.paused]);
            }

            function applyPlaybackState() {
                const playing = !bridgeState.paused;
                const mediaElements = document.querySelectorAll('audio, video');
                for (const media of mediaElements) {
                    if (playing) {
                        const playPromise = media.play?.();
                        if (playPromise && typeof playPromise.catch === 'function')
                            playPromise.catch(function(_e) {});
                    } else {
                        media.pause?.();
                    }
                }

                try {
                    window.dispatchEvent(new CustomEvent('hanabi-playback-change', {
                        detail: {playing},
                    }));
                } catch (error) {
                    logWallpaperBridgeError('hanabi-playback-change', error);
                }
            }

            function collectAddedFiles(nextFiles, previousSet) {
                const added = [];
                for (const file of nextFiles) {
                    if (!previousSet.has(file))
                        added.push(file);
                }
                return added;
            }

            function collectRemovedFiles(previousFiles, nextSet) {
                const removed = [];
                for (const file of previousFiles) {
                    if (!nextSet.has(file))
                        removed.push(file);
                }
                return removed;
            }

            function normalizeDirectorySnapshots(nextSnapshots) {
                return nextSnapshots && typeof nextSnapshots === 'object'
                    ? nextSnapshots
                    : {};
            }

            function flushDirectorySnapshots(nextSnapshots) {
                const listener = getPropertyListener();
                const previousSnapshots = bridgeState.directorySnapshots || {};
                bridgeState.directorySnapshots = normalizeDirectorySnapshots(nextSnapshots);

                if (!listener)
                    return;

                const allPropertyNames = new Set([
                    ...Object.keys(previousSnapshots),
                    ...Object.keys(bridgeState.directorySnapshots),
                ]);

                for (const propertyName of allPropertyNames) {
                    const previousFiles = Array.isArray(previousSnapshots[propertyName])
                        ? previousSnapshots[propertyName]
                        : [];
                    const nextFiles = Array.isArray(bridgeState.directorySnapshots[propertyName])
                        ? bridgeState.directorySnapshots[propertyName]
                        : [];
                    const previousSet = new Set(previousFiles);
                    const nextSet = new Set(nextFiles);
                    const changedFiles = collectAddedFiles(nextFiles, previousSet);
                    const removedFiles = collectRemovedFiles(previousFiles, nextSet);

                    if (changedFiles.length > 0)
                        safeInvokeWallpaperListener(listener, 'userDirectoryFilesAddedOrChanged', [propertyName, changedFiles]);
                    if (removedFiles.length > 0)
                        safeInvokeWallpaperListener(listener, 'userDirectoryFilesRemoved', [propertyName, removedFiles]);
                }
            }

            function scheduleBridgeReplay() {
                bridgeReplayPending = true;
                if (!bridgeCallbacksReady || bridgeReplayScheduled)
                    return;

                bridgeReplayScheduled = true;
                window.setTimeout(function() {
                    bridgeReplayScheduled = false;
                    if (!bridgeReplayPending || !bridgeCallbacksReady)
                        return;

                    bridgeReplayPending = false;
                    replayBridgeState();
                }, 0);
            }

            function applyState(payload) {
                if (!payload || typeof payload !== 'object')
                    return;
                if (payload.version === bridgeState.version)
                    return;

                bridgeState.version = Number(payload.version ?? bridgeState.version);
                bridgeState.userProperties = payload.userProperties && typeof payload.userProperties === 'object'
                    ? payload.userProperties
                    : {};
                bridgeState.generalProperties = payload.generalProperties && typeof payload.generalProperties === 'object'
                    ? payload.generalProperties
                    : {};
                bridgeState.paused = Boolean(payload.paused);

                if (!bridgeCallbacksReady) {
                    // Some web wallpapers register wallpaperPropertyListener
                    // before their own window.load initializers create WebGL
                    // canvases or media elements. Store the latest state now,
                    // then replay it after the page's load handlers have run so
                    // property callbacks like sakuraResize() see initialized
                    // project objects instead of half-built globals.
                    bridgeState.directorySnapshots = normalizeDirectorySnapshots(payload.directorySnapshots);
                    scheduleBridgeReplay();
                    return;
                }

                flushUserProperties();
                flushGeneralProperties();
                flushPausedState();
                applyPlaybackState();
                flushDirectorySnapshots(payload.directorySnapshots);
            }

            function replayBridgeState() {
                flushUserProperties();
                flushGeneralProperties();
                flushPausedState();
                applyPlaybackState();
                flushDirectorySnapshots(bridgeState.directorySnapshots);
            }

            Object.defineProperty(window, 'wallpaperPropertyListener', {
                configurable: true,
                enumerable: true,
                get() {
                    return wallpaperPropertyListenerValue;
                },
                set(value) {
                    wallpaperPropertyListenerValue = value;
                    scheduleBridgeReplay();
                },
            });

            window.__hanabiApplyUserProperties = function(payload) {
                applyState({
                    ...bridgeState,
                    version: bridgeState.version + 1,
                    userProperties: payload,
                });
            };
            window.__hanabiApplyGeneralProperties = function(payload) {
                applyState({
                    ...bridgeState,
                    version: bridgeState.version + 1,
                    generalProperties: payload,
                });
            };
            window.__hanabiSetPaused = function(isPaused) {
                applyState({
                    ...bridgeState,
                    version: bridgeState.version + 1,
                    paused: Boolean(isPaused),
                });
            };

            let pollPending = false;
            function pollState() {
                if (pollPending)
                    return;
                pollPending = true;

                const request = new XMLHttpRequest();
                request.open('GET', stateEndpoint, true);
                request.setRequestHeader('Cache-Control', 'no-store');
                request.onreadystatechange = function() {
                    if (request.readyState !== XMLHttpRequest.DONE)
                        return;
                    pollPending = false;

                    if (request.status < 200 || request.status >= 300)
                        return;

                    try {
                        applyState(JSON.parse(request.responseText));
                    } catch (error) {
                        console.warn('[Hanabi] failed to parse wallpaper bridge state: ' + (error && error.message ? error.message : String(error)));
                    }
                };
                request.onerror = function() {
                    pollPending = false;
                };
                request.send();
            }

            applyState(${JSON.stringify(initialState)});
            function markBridgeCallbacksReady() {
                window.setTimeout(function() {
                    bridgeCallbacksReady = true;
                    scheduleBridgeReplay();
                    pollState();
                }, 0);
            }

            if (bridgeCallbacksReady)
                markBridgeCallbacksReady();
            else
                window.addEventListener('load', markBridgeCallbacksReady, {once: true});
            window.setInterval(function() {
                pollState();
            }, 100);
        })();
    `;

    return class WebGstCefBackend extends BackendController {
        constructor(renderer, project) {
            super(renderer, project);
            this._pictures = [];
            this._displayStates = new Map();
            this._sharedPaintable = null;
            this._pipeline = null;
            this._bus = null;
            this._busSignalIds = [];
            this._cefSrcElement = null;
            this._volumeElement = null;
            this._pipelineMetrics = null;
            this._monitorWidgets = new Map();
            this._widgetSignalHandlers = [];
            this._metricsSourceId = 0;
            this._lastGeneralPropertiesJson = '';
            this._readyCallback = null;
            this._readyResolved = false;
            this._desiredVolume = state.getVolume();
            this._desiredMute = state.getMute();
            this._webUserPropertyPayload = project?.webPropertyPayload ?? {};
            this._webAudioSamples = renderer.getCurrentWebAudioFrame?.() ?? [...defaultAudioFrame];
            this._webDirectorySnapshots = {};
            this.displayName = 'gstcefsrc';
            this._syncFetchAllDirectoryProperties();
            this._renderer.registerWebAudioBackend?.(this);
            this._projectServer = new LocalWebProjectHttpServer(project, {
                // gstcefsrc cannot rely on WPE's UserContentManager injection,
                // so the shared project-root server receives this backend's
                // bootstrap builder and injects it only into served HTML files.
                bootstrapScriptBuilder: buildBootstrapScript,
                localMediaHttpUrlPrefix: renderer.getLocalMediaHttpUrlPrefix?.() ?? '',
                initialDirectorySnapshots: this._webDirectorySnapshots,
                initialGeneralProperties: this._buildGeneralPropertyPayload(),
                initialPaused: !renderer.isPlaying,
                initialUserProperties: this._webUserPropertyPayload,
            });
            this._metricsSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._updateOutputMetrics();
                return GLib.SOURCE_CONTINUE;
            });
        }

        destroy() {
            this._renderer.unregisterWebAudioBackend?.(this);
            if (this._metricsSourceId) {
                GLib.source_remove(this._metricsSourceId);
                this._metricsSourceId = 0;
            }
            this._widgetSignalHandlers.forEach(([target, signalId]) => {
                try {
                    target.disconnect(signalId);
                } catch (_e) {
                }
            });
            this._widgetSignalHandlers = [];
            this._displayStates.forEach(displayState => {
                if (displayState.resumeHideSourceId) {
                    GLib.source_remove(displayState.resumeHideSourceId);
                    displayState.resumeHideSourceId = 0;
                }
            });
            this._displayStates.clear();
            this._monitorWidgets.clear();
            this._pictures = [];
            this._sharedPaintable = null;
            this._teardownPipeline();
            this._readyCallback = null;
            this._readyResolved = true;
            this._projectServer?.destroy();
            this._projectServer = null;
            this._webDirectorySnapshots = {};
        }

        createWidgetForMonitor(index) {
            let widget = this._getWidgetFromSharedPaintable();

            if (index > 0 && !widget)
                return this._createPlaceholderWidget('gstcefsrc renderer could not be shared across monitors');

            if (!widget) {
                if (!this._projectServer?.browserUri)
                    return this._createPlaceholderWidget('gstcefsrc backend could not start the local web project server');

                widget = this._createPipelineWidget(this._getEffectiveOutputMetrics());
            }

            if (widget)
                widget = this._wrapWidgetForFreeze(index, widget);

            if (widget)
                widget = this._wrapWidgetForGraphicsOffload(index, widget);

            if (widget)
                this._trackMonitorWidget(index, widget);

            return widget ?? this._createPlaceholderWidget('gstcefsrc backend could not create a render widget');
        }

        setPlay() {
            this._scheduleFrozenFrameReveal();
            if (this._cefSrcElement)
                this._cefSrcElement.set_property('browser-suspended', false);
            this._projectServer?.updateState({paused: false});
            this._renderer._setPlayingState(true);
        }

        setPause() {
            this._freezeVisibleFrame();
            this._projectServer?.updateState({paused: true});
            if (this._cefSrcElement)
                this._cefSrcElement.set_property('browser-suspended', true);
            this._renderer._setPlayingState(false);
        }

        prepareForTransitionOut() {
            this.setPause();
        }

        setVolume(_volume) {
            this._desiredVolume = _volume;
            if (!this._volumeElement)
                return;

            let nextVolume = _volume;
            if (haveGstAudio) {
                nextVolume = GstAudio.StreamVolume.convert_volume(
                    GstAudio.StreamVolumeFormat.CUBIC,
                    GstAudio.StreamVolumeFormat.LINEAR,
                    _volume
                );
            } else {
                nextVolume = Math.pow(_volume, 3);
            }

            this._volumeElement.set_property('volume', nextVolume);
        }

        setMute(_mute) {
            this._desiredMute = _mute;
            if (!this._volumeElement)
                return;

            this._volumeElement.set_property('mute', _mute);
        }

        setWebUserProperties(payload) {
            this._webUserPropertyPayload = payload ?? {};
            this._syncFetchAllDirectoryProperties();
            this._projectServer?.updateState({
                directorySnapshots: this._webDirectorySnapshots,
                userProperties: this._webUserPropertyPayload,
            });
        }

        setAudioSamples(samples) {
            this._webAudioSamples = Array.isArray(samples)
                ? [...samples]
                : [...defaultAudioFrame];
            this._pushAudioSamplesToCef();
        }

        applyContentFit(fit) {
            if (!haveContentFit)
                return;

            this._pictures.forEach(picture => picture.set_content_fit(fit));
        }

        waitUntilReady(callback) {
            this._readyCallback = callback;
            this._resolveReadyIfNeeded();
        }

        dispatchPointerEvent(event) {
            if (!this._cefSrcElement)
                return;

            const x = Math.max(0, Math.round(Number(event.x ?? 0)));
            const y = Math.max(0, Math.round(Number(event.y ?? 0)));
            const button = Math.max(0, Math.round(Number(event.button ?? 0)));
            const deltaX = Math.round(Number(event.deltaX ?? 0));
            const deltaY = Math.round(Number(event.deltaY ?? 0));

            switch (event.type) {
            case 'mousemove':
                this._cefSrcElement.emit('mouse-move', x, y, false);
                break;
            case 'mousedown':
                this._cefSrcElement.emit('mouse-button', x, y, button, false, 1);
                break;
            case 'mouseup':
                this._cefSrcElement.emit('mouse-button', x, y, button, true, 1);
                break;
            case 'wheel':
                this._cefSrcElement.emit('mouse-wheel', x, y, deltaX, deltaY);
                break;
            }
        }

        _pushAudioSamplesToCef() {
            if (!this._cefSrcElement)
                return;

            try {
                this._cefSrcElement.emit(
                    'audio-frame',
                    JSON.stringify(Array.isArray(this._webAudioSamples) ? this._webAudioSamples : [])
                );
            } catch (e) {
                console.warn(`Failed to push audio samples into gstcefsrc: ${e}`);
            }
        }

        _getWidgetFromSharedPaintable() {
            if (!this._sharedPaintable)
                return null;

            const picture = createConfiguredPicture(new Gtk.Picture({
                paintable: this._sharedPaintable,
            }));
            this._pictures.push(picture);
            return picture;
        }

        _wrapWidgetForGraphicsOffload(index, widget) {
            if (!(haveGraphicsOffload && Gtk.GraphicsOffload))
                return widget;

            console.log(
                `gstcefsrc route: wrapping monitor ${index} widget in GraphicsOffload ` +
                `(haveGraphicsOffload=${haveGraphicsOffload})`
            );
            const offload = setExpandFill(Gtk.GraphicsOffload.new(widget));
            offload.set_enabled(Gtk.GraphicsOffloadEnabled.ENABLED);
            return offload;
        }

        _wrapWidgetForFreeze(index, widget) {
            const existingState = this._displayStates.get(index);
            if (existingState?.overlay === widget)
                return widget;

            const pausePicture = createConfiguredPicture(new Gtk.Picture({
                visible: false,
            }));
            const overlay = setExpandFill(new Gtk.Overlay());
            overlay.set_child(widget);
            overlay.add_overlay(pausePicture);

            this._displayStates.set(index, {
                overlay,
                widget,
                pausePicture,
                frozenPaintable: null,
                resumeHideSourceId: 0,
            });
            return overlay;
        }

        _getFrozenPaintable() {
            if (!this._sharedPaintable)
                return null;

            try {
                return this._sharedPaintable.get_current_image?.() ?? null;
            } catch (_e) {
                return null;
            }
        }

        _freezeVisibleFrame() {
            const frozenPaintable = this._getFrozenPaintable();
            if (!frozenPaintable)
                return;

            this._displayStates.forEach(displayState => {
                if (displayState.resumeHideSourceId) {
                    GLib.source_remove(displayState.resumeHideSourceId);
                    displayState.resumeHideSourceId = 0;
                }
                displayState.frozenPaintable = frozenPaintable;
                displayState.pausePicture.paintable = frozenPaintable;
                displayState.pausePicture.visible = true;
            });
        }

        _scheduleFrozenFrameReveal() {
            this._displayStates.forEach(displayState => {
                if (!displayState.pausePicture.visible)
                    return;

                if (displayState.resumeHideSourceId)
                    GLib.source_remove(displayState.resumeHideSourceId);

                displayState.resumeHideSourceId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    RESUME_FREEZE_HOLD_MS,
                    () => {
                        displayState.resumeHideSourceId = 0;
                        displayState.pausePicture.visible = false;
                        displayState.pausePicture.paintable = null;
                        displayState.frozenPaintable = null;
                        return GLib.SOURCE_REMOVE;
                    }
                );
            });
        }

        _getWidgetFromSink(sink) {
            let widget = null;
            if (sink.widget) {
                if (sink.widget instanceof Gtk.Picture) {
                    this._sharedPaintable = sink.widget.paintable;
                    const box = new Gtk.Box();
                    box.append(sink.widget);
                    box.append(this._getWidgetFromSharedPaintable());
                    sink.widget.hide();
                    widget = box;
                } else {
                    widget = sink.widget;
                }
            } else if (sink.paintable) {
                this._sharedPaintable = sink.paintable;
                widget = this._getWidgetFromSharedPaintable();
            }

            return widget;
        }

        _buildGeneralPropertyPayload(metrics = this._getEffectiveOutputMetrics()) {
            if (!metrics)
                return {};

            return {
                width: metrics.width,
                height: metrics.height,
                screenWidth: metrics.width,
                screenHeight: metrics.height,
                renderWidth: metrics.renderWidth,
                renderHeight: metrics.renderHeight,
                scale: metrics.scale,
                scaleFactor: metrics.scale,
                devicePixelRatio: metrics.scale,
            };
        }

        _trackMonitorWidget(index, widget) {
            if (!widget || this._monitorWidgets.get(index) === widget)
                return;

            this._monitorWidgets.set(index, widget);
            this._widgetSignalHandlers.push([
                widget,
                widget.connect('notify::scale-factor', () => {
                    this._updateOutputMetrics();
                }),
            ]);
            this._updateOutputMetrics();
        }

        _getMonitorMetrics(index, widget) {
            const monitor = this._renderer._monitors?.[index] ?? null;
            const geometry = monitor?.get_geometry?.() ?? null;
            const width = Math.max(1, geometry?.width || widget?.get_width?.() || 1);
            const height = Math.max(1, geometry?.height || widget?.get_height?.() || 1);
            const scale = Math.max(
                1,
                monitor?.get_scale_factor?.() ?? widget?.get_scale_factor?.() ?? 1
            );
            const renderWidth = Math.max(1, Math.round(width * scale));
            const renderHeight = Math.max(1, Math.round(height * scale));

            return {
                index,
                width,
                height,
                scale,
                renderWidth,
                renderHeight,
            };
        }

        _getEffectiveOutputMetrics() {
            let selectedMetrics = null;

            for (const [index, widget] of this._monitorWidgets.entries()) {
                const metrics = this._getMonitorMetrics(index, widget);
                if (!selectedMetrics) {
                    selectedMetrics = metrics;
                    continue;
                }

                const selectedArea = selectedMetrics.renderWidth * selectedMetrics.renderHeight;
                const nextArea = metrics.renderWidth * metrics.renderHeight;
                if (
                    nextArea > selectedArea ||
                    (nextArea === selectedArea && metrics.scale > selectedMetrics.scale) ||
                    (nextArea === selectedArea &&
                        metrics.scale === selectedMetrics.scale &&
                        metrics.index < selectedMetrics.index)
                )
                    selectedMetrics = metrics;
            }

            if (selectedMetrics)
                return selectedMetrics;

            let fallbackMetrics = null;
            for (const [index, monitor] of (this._renderer._monitors ?? []).entries()) {
                const metrics = this._getMonitorMetrics(index, {
                    get_width() {
                        return monitor?.get_geometry?.()?.width ?? 0;
                    },
                    get_height() {
                        return monitor?.get_geometry?.()?.height ?? 0;
                    },
                    get_scale_factor() {
                        return monitor?.get_scale_factor?.() ?? 1;
                    },
                });
                if (!fallbackMetrics) {
                    fallbackMetrics = metrics;
                    continue;
                }

                const currentArea = fallbackMetrics.renderWidth * fallbackMetrics.renderHeight;
                const nextArea = metrics.renderWidth * metrics.renderHeight;
                if (
                    nextArea > currentArea ||
                    (nextArea === currentArea && metrics.scale > fallbackMetrics.scale) ||
                    (nextArea === currentArea &&
                        metrics.scale === fallbackMetrics.scale &&
                        metrics.index < fallbackMetrics.index)
                )
                    fallbackMetrics = metrics;
            }

            return fallbackMetrics ?? this._getMonitorMetrics(0, null);
        }

        _getConfiguredChromeExtraFlags() {
            return (GLib.getenv('GST_CEF_CHROME_EXTRA_FLAGS') ?? '')
                .split(',')
                .map(flag => flag.trim())
                .filter(flag => flag !== '')
                .join(',');
        }

        _createElement(factoryName, elementName, properties = {}) {
            const element = Gst.ElementFactory.make(factoryName, elementName);
            if (!element)
                throw new Error(`Failed to create GStreamer element ${factoryName}`);

            for (const [propertyName, propertyValue] of Object.entries(properties)) {
                if (propertyValue === undefined || propertyValue === null)
                    continue;
                element.set_property(propertyName, propertyValue);
            }

            return element;
        }

        _addElements(container, elements) {
            for (const element of elements)
                container.add(element);
        }

        _linkElementChain(elements) {
            for (let i = 0; i < elements.length - 1; i++) {
                if (!elements[i].link(elements[i + 1]))
                    throw new Error(`Failed to link ${elements[i].name} -> ${elements[i + 1].name}`);
            }
        }

        _createPipelineWidget(metrics) {
            const sinkFactory = !forceGtk4PaintableSink && Gst.ElementFactory.find('clappersink')
                ? 'clappersink'
                : 'gtk4paintablesink';
            if (!Gst.ElementFactory.find(sinkFactory))
                return null;

            const initialVolume = haveGstAudio
                ? GstAudio.StreamVolume.convert_volume(
                    GstAudio.StreamVolumeFormat.CUBIC,
                    GstAudio.StreamVolumeFormat.LINEAR,
                    this._desiredVolume
                )
                : Math.pow(this._desiredVolume, 3);
            const chromeExtraFlags = this._getConfiguredChromeExtraFlags();
            try {
                const pipeline = Gst.Pipeline.new('gstcefsrc-pipeline');
                const cefSrc = this._createElement('cefsrc', 'gstcefsrc-source', {
                    url: this._projectServer.browserUri,
                    'device-scale-factor': metrics.scale,
                    'chrome-extra-flags': chromeExtraFlags,
                });
                const cefDemux = this._createElement('cefdemux', 'gstcefsrc-demux');
                const videoCaps = Gst.Caps.from_string(
                    `video/x-raw,width=${metrics.renderWidth},height=${metrics.renderHeight},framerate=60/1`
                );
                const videoCapsFilter = this._createElement('capsfilter', 'gstcefsrc-video-caps', {
                    caps: videoCaps,
                });
                const videoQueue = this._createElement('queue', 'gstcefsrc-video-queue', {
                    'max-size-buffers': 3,
                    'max-size-bytes': 0,
                    'max-size-time': 0,
                });
                const sink = this._createElement(sinkFactory, 'gstcefsrc-videosink', {
                    sync: false,
                });
                const audioQueue = this._createElement('queue', 'gstcefsrc-audio-queue', {
                    'max-size-buffers': 0,
                    'max-size-bytes': 0,
                    'max-size-time': 1000000000,
                });
                const audioConvert = this._createElement('audioconvert', 'gstcefsrc-audio-convert');
                const audioResample = this._createElement('audioresample', 'gstcefsrc-audio-resample');
                const volume = this._createElement('volume', 'gstcefsrc-volume', {
                    volume: initialVolume,
                    mute: this._desiredMute,
                });
                const audioSink = this._createElement('autoaudiosink', 'gstcefsrc-audio-sink');

                this._addElements(pipeline, [
                    cefSrc,
                    cefDemux,
                    videoCapsFilter,
                    videoQueue,
                    sink,
                    audioQueue,
                    audioConvert,
                    audioResample,
                    volume,
                    audioSink,
                ]);

                if (!cefSrc.link(cefDemux))
                    throw new Error('Failed to link cefsrc -> cefdemux');
                if (!cefDemux.link_pads('video', videoCapsFilter, 'sink'))
                    throw new Error('Failed to link cefdemux.video -> video caps');
                if (!cefDemux.link_pads('audio', audioQueue, 'sink'))
                    throw new Error('Failed to link cefdemux.audio -> audio queue');

                this._linkElementChain([
                    videoCapsFilter,
                    videoQueue,
                    sink,
                ]);
                this._linkElementChain([
                    audioQueue,
                    audioConvert,
                    audioResample,
                    volume,
                    audioSink,
                ]);

                this._pipeline = pipeline;
                this._cefSrcElement = cefSrc;
                this._volumeElement = volume;
                cefSrc.set_property('browser-suspended', !this._renderer.isPlaying);
            } catch (e) {
                console.error(`Failed to create gstcefsrc pipeline: ${e}`);
                return null;
            }

            this.displayName = `gstcefsrc + ${sinkFactory}`;
            this._sharedPaintable = null;
            const sink = this._pipeline.get_by_name('gstcefsrc-videosink');
            const widget = sink ? this._getWidgetFromSink(sink) : null;
            if (!widget) {
                this._teardownPipeline();
                return null;
            }

            this._pipelineMetrics = metrics;
            this._attachPipelineBus();
            this._pushAudioSamplesToCef();
            console.log(
                `gstcefsrc route: caps logical=${metrics.width}x${metrics.height} ` +
                `scale=${metrics.scale} render=${metrics.renderWidth}x${metrics.renderHeight} ` +
                `device-scale-factor=${metrics.scale} chrome-extra-flags=${chromeExtraFlags}`
            );
            this._setPipelineState(Gst.State.PLAYING);
            return widget;
        }

        _attachPipelineBus() {
            if (!this._pipeline)
                return;

            this._bus = this._pipeline.get_bus();
            if (!this._bus)
                return;

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
                    console.error(`gstcefsrc pipeline error: ${details}`);
                }),
                this._bus.connect('message::warning', (_bus, message) => {
                    try {
                        const [warning, debugInfo] = message.parse_warning();
                        const details = debugInfo
                            ? `${warning?.message ?? String(warning ?? '')} (${debugInfo})`
                            : (warning?.message ?? String(warning ?? ''));
                        console.warn(`gstcefsrc pipeline warning: ${details}`);
                    } catch (e) {
                        console.warn(`gstcefsrc pipeline warning: ${e}`);
                    }
                }),
                this._bus.connect('message::eos', () => {
                    this._renderer._setPlayingState(false);
                }),
                this._bus.connect('message::state-changed', (_bus, message) => {
                    if (!this._pipeline || message.src !== this._pipeline)
                        return;

                    const [_oldState, newState] = message.parse_state_changed();
                    if (newState >= Gst.State.PAUSED) {
                        this.setVolume(this._desiredVolume);
                        this.setMute(this._desiredMute);
                        this._markReady();
                    }
                    this._renderer._setPlayingState(newState === Gst.State.PLAYING);
                }),
            ];
        }

        _setPipelineState(nextState) {
            if (!this._pipeline) {
                this._renderer._setPlayingState(nextState === Gst.State.PLAYING);
                return;
            }

            const stateChange = this._pipeline.set_state(nextState);
            if (stateChange === Gst.StateChangeReturn.FAILURE)
                console.error(`gstcefsrc pipeline failed to enter ${nextState === Gst.State.PLAYING ? 'PLAYING' : 'PAUSED'} state`);
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

            this._cefSrcElement = null;
            this._volumeElement = null;
            this._pipelineMetrics = null;
        }

        _updateOutputMetrics() {
            const metrics = this._getEffectiveOutputMetrics();
            if (!metrics)
                return;

            const payload = this._buildGeneralPropertyPayload(metrics);
            const payloadJson = JSON.stringify(payload);
            if (this._lastGeneralPropertiesJson === payloadJson)
                return;

            this._lastGeneralPropertiesJson = payloadJson;
            this._projectServer?.updateState({
                generalProperties: payload,
            });
        }

        _getFetchAllDirectoryProperties() {
            return (this._project?.sceneProperties ?? []).filter(property =>
                property?.type === 'directory' && property?.mode === 'fetchall'
            );
        }

        _listFilesForDirectory(path) {
            if (!path)
                return [];

            try {
                const dir = Gio.File.new_for_path(path);
                if (dir.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY)
                    return [];

                const enumerator = dir.enumerate_children(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );
                const files = [];
                let info;
                while ((info = enumerator.next_file(null))) {
                    if (info.get_file_type() !== Gio.FileType.REGULAR)
                        continue;
                    files.push(normalizeWebFilesystemPath(dir.get_child(info.get_name()).get_path()));
                }
                return files.sort((left, right) => left.localeCompare(right));
            } catch (_e) {
                return [];
            }
        }

        _syncFetchAllDirectoryProperties() {
            const nextSnapshots = {};
            for (const property of this._getFetchAllDirectoryProperties()) {
                const directoryPath = this._webUserPropertyPayload?.[property.name]?.value ?? '';
                nextSnapshots[property.name] = this._listFilesForDirectory(directoryPath);
            }
            this._webDirectorySnapshots = nextSnapshots;
        }

        _markReady() {
            if (this._readyResolved)
                return;

            this._readyResolved = true;
            const callback = this._readyCallback;
            this._readyCallback = null;
            callback?.();
        }

        _resolveReadyIfNeeded() {
            if (this._readyResolved) {
                const callback = this._readyCallback;
                this._readyCallback = null;
                callback?.();
                return;
            }

            if (!this._pipeline)
                this._markReady();
        }
    };
};
