var createWebBackendClass = (env, helpers, baseClasses) => {
    const {
        HanabiWpe,
        WPEWebKit,
        WPEPlatform,
        WPEPlatformHeadless,
        Gio,
        GLib,
        Gdk,
        Gtk,
        flags,
    } = env;
    const {
        haveWpeBridge,
        haveWPEWebKit,
        haveWPEPlatform,
        haveWPEPlatformHeadless,
        haveContentFit,
        haveGraphicsOffload,
    } = flags;
    const {
        setExpandFill,
        createConfiguredPicture,
        buildWebPointerDispatchScript,
        LocalWebProjectHttpServer,
    } = helpers;
    const {BackendController} = baseClasses;

    const isLittleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;
    const wpeShmMemoryFormat = isLittleEndian
        ? Gdk.MemoryFormat.B8G8R8A8_PREMULTIPLIED
        : Gdk.MemoryFormat.A8R8G8B8_PREMULTIPLIED;
    const normalizeWebFilesystemPath = path => {
        if (typeof path !== 'string')
            return path;

        if (/^[A-Za-z]:[\\/]/.test(path))
            return path;

        if (path.startsWith('/'))
            return path.replace(/^\/+/, '');

        return path;
    };
    const detachWebPresentationTarget = target => {
        if (!target)
            return;

        try {
            target.set_child?.(null);
        } catch (_e) {
        }

        try {
            target.set_paintable?.(null);
        } catch (_e) {
        }

        try {
            if ('paintable' in target)
                target.paintable = null;
        } catch (_e) {
        }
    };
    const disposeWebObject = object => {
        if (!object)
            return;

        try {
            object.run_dispose?.();
        } catch (_e) {
        }
    };
    const assignWebObjectProperty = (object, propertyName, value) => {
        if (!object)
            return;

        try {
            object[propertyName] = value;
        } catch (_e) {
        }
    };

    return class WebBackend extends BackendController {
        constructor(renderer, project) {
            super(renderer, project);
            this._webViews = new Map();
            this._webPausePictures = new Map();
            this._webViewReadyStates = new Map();
            this._lastAppliedWebUserPropertyPayloads = new Map();
            this._readyCallback = null;
            this._readyResolved = false;
            this._wpeStates = new Map();
            this._wpeDisplay = this._createWPEDisplay();
            this._localMediaHttpUrlPrefix = renderer.getLocalMediaHttpUrlPrefix?.() ?? '';
            this._webUserPropertyPayload = project?.webPropertyPayload ?? {};
            this._webDirectorySnapshots = new Map();
            this._webAudioSamples = renderer.getCurrentWebAudioFrame?.() ?? new Array(128).fill(0);
            this._projectServer = new LocalWebProjectHttpServer(project);
            this.usesNativeWindows = false;
            this.displayName = 'WPEWebKit';
            this._renderer.registerAudioSamplesBackend?.(this);
        }

        destroy() {
            this._readyCallback = null;
            this._readyResolved = true;
            this._renderer.unregisterAudioSamplesBackend?.(this);

            this._destroyAllWPEWidgets();

            this._webViews.clear();
            this._webPausePictures.clear();
            this._webViewReadyStates.clear();
            this._lastAppliedWebUserPropertyPayloads.clear();
            this._wpeStates.clear();
            this._webDirectorySnapshots.clear();
            this._webAudioSamples = new Array(128).fill(0);
            this._projectServer?.destroy();
            this._projectServer = null;
            this._wpeDisplay = null;
            this._renderer = null;
            this._project = null;
        }

        createWidgetForMonitor(index) {
            return this._createWPEWidgetForMonitor(index);
        }

        createNativeWindowForMonitor(_index, _monitor, _title) {
            return null;
        }

        waitUntilReady(callback) {
            this._readyCallback = callback;
            this._resolveReadyIfNeeded();
        }

        prepareForTransitionOut() {
            this._setPlayback(false, false);
        }

        setPlay() {
            this._setPlayback(true, true);
        }

        setPause() {
            this._setPlayback(false, true);
        }

        setWebUserProperties(payload) {
            this._webUserPropertyPayload = payload ?? {};
            this._syncFetchAllDirectoryProperties();
            this._pushWebPropertiesToReadyViews();
        }

        setAudioSamples(samples) {
            this._webAudioSamples = Array.isArray(samples)
                ? samples
                : new Array(128).fill(0);
            this._pushAudioSamplesToReadyViews();
        }

        setMute(_mute) {
            this._webViews.forEach(webView => {
                if (webView.is_muted === _mute)
                    webView.is_muted = !_mute;
                webView.is_muted = _mute;
            });
        }

        setSceneFps(_fps) {
        }

        dispatchPointerEvent(event) {
            const webView = this._webViews.get(event.monitorIndex);
            const dispatchedToWPE = this._dispatchWPEPointerEvent(event);
            if (!webView)
                return;

            // Headless WPEPlatform can accept native pointer packets without
            // delivering a DOM click to the offscreen WebKit page. Mirror every
            // pointer packet through the JavaScript dispatcher as a compatibility
            // layer so interactive Wallpaper Engine web projects receive the same
            // mouse/pointer/click events that the gstcef backend provides.
            this._dispatchSyntheticPointerEvent(webView, event);

            if (dispatchedToWPE && (event.type === 'mousedown' || event.type === 'mouseup'))
                console.log(`WPE route: mirrored ${event.type} to DOM at ${event.x},${event.y} button=${event.button}`);
        }

        applyContentFit(fit) {
            if (!haveContentFit)
                return;

            this._webPausePictures.forEach(picture => picture.set_content_fit(fit));
            this._wpeStates.forEach(wpeState => {
                wpeState.livePicture.set_content_fit(fit);
                wpeState.pausePicture.set_content_fit(fit);
            });
        }

        _createWPEDisplay() {
            if (!haveWPEWebKit || !haveWPEPlatform || !haveWPEPlatformHeadless) {
                console.warn(
                    `WPE backend unavailable: haveWPEWebKit=${haveWPEWebKit}, haveWPEPlatform=${haveWPEPlatform}, haveWPEPlatformHeadless=${haveWPEPlatformHeadless}`
                );
                return null;
            }

            try {
                const display = WPEPlatformHeadless.DisplayHeadless.new();
                console.log('WPE display initialization succeeded; using headless WPEWebKit widget backend');
                return display;
            } catch (e) {
                console.warn(`WPE headless display creation threw: ${e}`);
                return null;
            }
        }

        _createWPEWidgetForMonitor(index) {
            if (!this._wpeDisplay)
                return this._createPlaceholderWidget('WPE headless display initialization failed');

            if (!this._projectServer?.browserUri)
                return this._createPlaceholderWidget('WPE backend could not start the local web project server');

            const userContentManager = this._createUserContentManager(WPEWebKit);
            const settings = this._createWebSettings(WPEWebKit);
            const webView = new WPEWebKit.WebView({
                display: this._wpeDisplay,
                user_content_manager: userContentManager,
                settings,
            });

            const livePaintable = haveWpeBridge && HanabiWpe?.Paintable
                ? new HanabiWpe.Paintable()
                : null;
            const livePicture = createConfiguredPicture(new Gtk.Picture({
                paintable: livePaintable,
            }));
            const pausePicture = createConfiguredPicture(new Gtk.Picture({
                visible: false,
            }));
            const overlay = setExpandFill(new Gtk.Overlay());
            overlay.set_child(livePicture);
            overlay.add_overlay(pausePicture);

            const view = webView.get_wpe_view();
            const toplevel =
                view.get_toplevel?.() ??
                this._wpeDisplay.create_toplevel?.(0) ??
                null;
            if (toplevel)
                view.set_toplevel(toplevel);
            view.visible = true;
            view.map();

            const wpeState = {
                overlay,
                livePicture,
                pausePicture,
                webView,
                view,
                toplevel,
                livePaintable,
                liveUpdatesEnabled: true,
                viewSuspended: false,
                lastTexture: null,
                lastWidth: 0,
                lastHeight: 0,
                lastScale: 1,
                lastRenderWidth: 0,
                lastRenderHeight: 0,
                pointerInside: false,
                pointerX: 0,
                pointerY: 0,
                pressedButtons: new Set(),
                loggedBufferKinds: new Set(),
                signalHandlers: [],
                metricsSourceId: 0,
                presentationTarget: null,
            };

            this._configureWebView(WPEWebKit, webView, index, wpeState.signalHandlers);

            wpeState.signalHandlers.push([
                view,
                view.connect('buffer-rendered', (_view, buffer) => {
                    this._handleWPEBufferRendered(index, buffer);
                }),
            ]);
            wpeState.signalHandlers.push([
                overlay,
                overlay.connect('map', () => {
                    view.visible = true;
                    view.map();
                    this._updateWPEViewMetrics(index);
                }),
            ]);
            wpeState.signalHandlers.push([
                overlay,
                overlay.connect('unmap', () => {
                    try {
                        view.unmap();
                    } catch (_e) {
                    }
                    wpeState.pointerInside = false;
                    wpeState.pressedButtons.clear();
                }),
            ]);
            wpeState.signalHandlers.push([
                overlay,
                overlay.connect('notify::scale-factor', () => {
                    this._updateWPEViewMetrics(index);
                }),
            ]);
            wpeState.metricsSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                if (!this._wpeStates.has(index))
                    return GLib.SOURCE_REMOVE;

                this._updateWPEViewMetrics(index);
                return GLib.SOURCE_CONTINUE;
            });

            this._wpeStates.set(index, wpeState);
            this._webViews.set(index, webView);
            this._webPausePictures.set(index, pausePicture);
            this._webViewReadyStates.set(index, false);
            this._updateWPEViewMetrics(index);

            this._loadProjectEntry(webView);

            if (haveGraphicsOffload && Gtk.GraphicsOffload) {
                console.log(
                    `WPE route: wrapping monitor ${index} widget in GraphicsOffload ` +
                    `(haveGraphicsOffload=${haveGraphicsOffload})`
                );
                const offload = setExpandFill(Gtk.GraphicsOffload.new(overlay));
                offload.set_enabled(Gtk.GraphicsOffloadEnabled.ENABLED);
                wpeState.presentationTarget = offload;
                return offload;
            }

            wpeState.presentationTarget = overlay;
            return overlay;
        }

        _createUserContentManager(api) {
            const userContentManager = new api.UserContentManager();
            userContentManager.add_script(
                new api.UserScript(
                    `
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

                        window.__hanabiAudioContexts = window.__hanabiAudioContexts || [];
                        function wrapAudioContext(key) {
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
                        }

                        wrapAudioContext('AudioContext');
                        wrapAudioContext('webkitAudioContext');

                        const hanabiMediaHttpUrlPrefix = ${JSON.stringify(this._localMediaHttpUrlPrefix)};
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
                            audioFrame: new Array(128).fill(0),
                            generalProperties: {},
                            paused: false,
                            userProperties: {},
                        };
                        let wallpaperPropertyListenerValue = window.wallpaperPropertyListener;
                        let wallpaperAudioListenerValue = null;
                        let bridgeCallbacksReady = document.readyState === 'complete';
                        let bridgeReplayScheduled = false;
                        const bridgeReplayPending = {
                            audioFrame: false,
                            directoryEvents: false,
                            generalProperties: false,
                            pausedState: false,
                            userProperties: false,
                        };
                        const pendingDirectoryEvents = [];

                        // GameMaker HTML5 runtimes used by older Wallpaper Engine
                        // projects inspect function.caller/function.arguments while
                        // formatting fatal errors. WPE has to keep project callbacks
                        // on classic timer frames and catch each bridge callback so
                        // those runtimes do not trip over strict, async, or arrow
                        // function frames that belong to Hanabi's compatibility layer.
                        function getPropertyListener() {
                            const listener = wallpaperPropertyListenerValue;
                            if (!listener || typeof listener !== 'object')
                                return null;
                            return listener;
                        }

                        function getAudioListener() {
                            if (typeof wallpaperAudioListenerValue !== 'function')
                                return null;
                            return wallpaperAudioListenerValue;
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
                                // Keep a project-side bridge callback failure from
                                // escaping into legacy wallpaper runtimes. The warning
                                // records the exact WE API callback in run.log so the
                                // next compatibility issue has a concrete trace.
                                logWallpaperBridgeError(methodName, error);
                            }
                        }

                        function flushAudioFrame() {
                            const listener = getAudioListener();
                            if (!listener)
                                return;
                            try {
                                listener(bridgeState.audioFrame);
                            } catch (error) {
                                logWallpaperBridgeError('wallpaperRegisterAudioListener', error);
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

                        function flushPendingDirectoryEvents() {
                            while (pendingDirectoryEvents.length > 0) {
                                const flushEvent = pendingDirectoryEvents.shift();
                                try {
                                    flushEvent();
                                } catch (error) {
                                    // Directory bridge events are queued as small
                                    // closures so ordering is preserved. Any failure
                                    // here means the compatibility layer itself needs
                                    // attention, so emit a precise warning while
                                    // keeping the wallpaper process alive.
                                    logWallpaperBridgeError('queuedDirectoryEvent', error);
                                }
                            }
                        }

                        function hasPendingBridgeReplay() {
                            return bridgeReplayPending.userProperties ||
                                bridgeReplayPending.generalProperties ||
                                bridgeReplayPending.pausedState ||
                                bridgeReplayPending.audioFrame ||
                                bridgeReplayPending.directoryEvents;
                        }

                        function markBridgeReplayPending(kind) {
                            if (kind in bridgeReplayPending)
                                bridgeReplayPending[kind] = true;
                        }

                        function markPropertyBridgeReplayPending() {
                            bridgeReplayPending.userProperties = true;
                            bridgeReplayPending.generalProperties = true;
                            bridgeReplayPending.pausedState = true;
                        }

                        function replayBridgeState() {
                            const shouldFlushUserProperties = bridgeReplayPending.userProperties;
                            const shouldFlushGeneralProperties = bridgeReplayPending.generalProperties;
                            const shouldFlushPausedState = bridgeReplayPending.pausedState;
                            const shouldFlushAudioFrame = bridgeReplayPending.audioFrame;
                            const shouldFlushDirectoryEvents = bridgeReplayPending.directoryEvents;

                            bridgeReplayPending.userProperties = false;
                            bridgeReplayPending.generalProperties = false;
                            bridgeReplayPending.pausedState = false;
                            bridgeReplayPending.audioFrame = false;
                            bridgeReplayPending.directoryEvents = false;

                            if (shouldFlushUserProperties)
                                flushUserProperties();
                            if (shouldFlushGeneralProperties)
                                flushGeneralProperties();
                            if (shouldFlushPausedState)
                                flushPausedState();
                            if (shouldFlushAudioFrame)
                                flushAudioFrame();
                            if (shouldFlushDirectoryEvents)
                                flushPendingDirectoryEvents();
                        }

                        function scheduleBridgeReplay(kind) {
                            markBridgeReplayPending(kind);
                            if (!bridgeCallbacksReady || bridgeReplayScheduled)
                                return;

                            bridgeReplayScheduled = true;
                            window.setTimeout(function() {
                                bridgeReplayScheduled = false;
                                if (!hasPendingBridgeReplay() || !bridgeCallbacksReady)
                                    return;

                                replayBridgeState();
                            }, 0);
                        }

                        function applyBridgeMutation(mutator, pendingKind) {
                            mutator();
                            // Some web wallpapers register Wallpaper Engine callbacks
                            // before their own window.load initializers create WebGL
                            // canvases, media elements, or audio nodes. Store each
                            // native update immediately, but only replay that update's
                            // own callback family after the page is ready. Audio frames
                            // must not replay applyUserProperties(), because projects
                            // such as the sakura wallpaper rebuild effects from that
                            // callback and audio updates arrive every rendered frame.
                            scheduleBridgeReplay(pendingKind);
                        }

                        Object.defineProperty(window, 'wallpaperPropertyListener', {
                            configurable: true,
                            enumerable: true,
                            get() {
                                return wallpaperPropertyListenerValue;
                            },
                            set(value) {
                                wallpaperPropertyListenerValue = value;
                                markPropertyBridgeReplayPending();
                                scheduleBridgeReplay();
                            },
                        });

                        Object.defineProperty(window, 'wallpaperRegisterAudioListener', {
                            configurable: true,
                            enumerable: true,
                            writable: true,
                            value(callback) {
                                wallpaperAudioListenerValue = typeof callback === 'function' ? callback : null;
                                scheduleBridgeReplay('audioFrame');
                            },
                        });

                        window.__hanabiApplyUserProperties = function(payload) {
                            applyBridgeMutation(function() {
                                bridgeState.userProperties = payload && typeof payload === 'object' ? payload : {};
                            }, 'userProperties');
                        };
                        window.__hanabiApplyGeneralProperties = function(payload) {
                            applyBridgeMutation(function() {
                                bridgeState.generalProperties = payload && typeof payload === 'object' ? payload : {};
                            }, 'generalProperties');
                        };
                        window.__hanabiSetPaused = function(isPaused) {
                            applyBridgeMutation(function() {
                                bridgeState.paused = Boolean(isPaused);
                            }, 'pausedState');
                        };
                        window.__hanabiUserDirectoryFilesAddedOrChanged = function(propertyName, changedFiles) {
                            if (!bridgeCallbacksReady) {
                                // Directory notifications are edge-triggered by the
                                // native side. Delay early events until the page has
                                // installed all WE callbacks, but keep them as events
                                // instead of merging them into property state.
                                pendingDirectoryEvents.push(function() {
                                    safeInvokeWallpaperListener(getPropertyListener(), 'userDirectoryFilesAddedOrChanged', [propertyName, changedFiles]);
                                });
                                scheduleBridgeReplay('directoryEvents');
                                return;
                            }
                            safeInvokeWallpaperListener(getPropertyListener(), 'userDirectoryFilesAddedOrChanged', [propertyName, changedFiles]);
                        };
                        window.__hanabiUserDirectoryFilesRemoved = function(propertyName, removedFiles) {
                            if (!bridgeCallbacksReady) {
                                // Removed-file notifications must preserve ordering
                                // relative to added-file notifications, so each early
                                // callback is retained in an explicit FIFO until the
                                // page is ready for project bridge callbacks.
                                pendingDirectoryEvents.push(function() {
                                    safeInvokeWallpaperListener(getPropertyListener(), 'userDirectoryFilesRemoved', [propertyName, removedFiles]);
                                });
                                scheduleBridgeReplay('directoryEvents');
                                return;
                            }
                            safeInvokeWallpaperListener(getPropertyListener(), 'userDirectoryFilesRemoved', [propertyName, removedFiles]);
                        };
                        window.__hanabiApplyAudioFrame = function(payload) {
                            applyBridgeMutation(function() {
                                bridgeState.audioFrame = Array.isArray(payload) ? payload : new Array(128).fill(0);
                            }, 'audioFrame');
                        };
                        function markBridgeCallbacksReady() {
                            window.setTimeout(function() {
                                bridgeCallbacksReady = true;
                                markPropertyBridgeReplayPending();
                                bridgeReplayPending.audioFrame = true;
                                if (pendingDirectoryEvents.length > 0)
                                    bridgeReplayPending.directoryEvents = true;
                                scheduleBridgeReplay();
                            }, 0);
                        }

                        if (bridgeCallbacksReady)
                            markBridgeCallbacksReady();
                        else
                            window.addEventListener('load', markBridgeCallbacksReady, {once: true});
                    })();
                    `,
                    api.UserContentInjectedFrames.ALL_FRAMES,
                    api.UserScriptInjectionTime.START,
                    null,
                    null
                )
            );
            return userContentManager;
        }

        _loadProjectEntry(webView) {
            // WPEWebKit must enter web wallpapers through the project HTTP
            // document root so relative assets, media requests, and the page
            // origin all match the gstcefsrc backend instead of mixing a file://
            // entry page with an HTTP-only media bridge.
            webView.load_uri(this._projectServer.browserUri);
        }

        _createWebSettings(api) {
            const settings = new api.Settings();
            if (settings.set_enable_webaudio)
                settings.set_enable_webaudio(true);
            if (settings.set_enable_webgl)
                settings.set_enable_webgl(true);
            if (settings.set_allow_file_access_from_file_urls)
                settings.set_allow_file_access_from_file_urls(true);
            return settings;
        }

        _configureWebView(api, webView, index, signalHandlers = null) {
            const loadChangedId = webView.connect('load-changed', (_view, loadEvent) => {
                if (loadEvent !== api.LoadEvent.FINISHED)
                    return;

                this._webViewReadyStates.set(index, true);
                this._pushWebPropertiesToView(index, webView, true);
                this._pushGeneralPropertiesToView(webView);
                this._pushPausedStateToView(webView);
                this._pushFetchAllDirectoryPropertiesToView(webView);
                this._pushAudioSamplesToView(webView);
                this._resolveReadyIfNeeded();

                if (this._renderer.isPlaying)
                    this._setPlayback(true, true);
            });

            signalHandlers?.push([webView, loadChangedId]);
        }

        _setPlayback(isPlaying, updateState) {
            if (this._webViews.size === 0) {
                if (updateState)
                    this._renderer._setPlayingState(isPlaying);
                return;
            }

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
                    window.__hanabiSetPaused?.(!playing);
                })();
            `;

            this._webViews.forEach((webView, index) => {
                webView.evaluate_javascript(
                    script,
                    -1,
                    null,
                    null,
                    null,
                    () => {}
                );

                const wpeState = this._wpeStates.get(index);
                if (!wpeState)
                    return;

                wpeState.liveUpdatesEnabled = isPlaying;
                if (isPlaying) {
                    this._resumeWPEView(index);
                    if (wpeState.livePaintable)
                        wpeState.livePicture.paintable = wpeState.livePaintable;
                    else if (wpeState.lastTexture)
                        wpeState.livePicture.paintable = wpeState.lastTexture;
                    wpeState.pausePicture.paintable = null;
                    wpeState.pausePicture.visible = false;
                } else {
                    this._freezeWPEView(index);
                    this._suspendWPEView(index);
                }
            });
            if (updateState)
                this._renderer._setPlayingState(isPlaying);
        }

        _buildGeneralPropertyPayload() {
            return {};
        }

        _pushScriptToView(webView, script) {
            webView.evaluate_javascript(
                script,
                -1,
                null,
                null,
                null,
                () => {}
            );
        }

        _cloneWebUserPropertyPayload(payload) {
            return JSON.parse(JSON.stringify(payload ?? {}));
        }

        _buildWebUserPropertyDelta(index) {
            const nextPayload = this._webUserPropertyPayload ?? {};
            const previousPayload = this._lastAppliedWebUserPropertyPayloads.get(index) ?? {};
            const delta = {};
            let hasChanges = false;

            for (const [key, value] of Object.entries(nextPayload)) {
                if (JSON.stringify(previousPayload[key]) === JSON.stringify(value))
                    continue;

                delta[key] = value;
                hasChanges = true;
            }

            return hasChanges ? delta : null;
        }

        _pushWebPropertiesToView(index, webView, forceFull = false) {
            if (!webView)
                return;

            const payload = forceFull
                ? (this._webUserPropertyPayload ?? {})
                : this._buildWebUserPropertyDelta(index);
            if (!payload)
                return;

            this._lastAppliedWebUserPropertyPayloads.set(
                index,
                this._cloneWebUserPropertyPayload(this._webUserPropertyPayload)
            );
            const payloadJson = JSON.stringify(payload);
            this._pushScriptToView(
                webView,
                `window.__hanabiApplyUserProperties?.(${payloadJson});`
            );
        }

        _pushGeneralPropertiesToView(webView) {
            if (!webView)
                return;

            const payloadJson = JSON.stringify(this._buildGeneralPropertyPayload());
            this._pushScriptToView(
                webView,
                `window.__hanabiApplyGeneralProperties?.(${payloadJson});`
            );
        }

        _pushPausedStateToView(webView) {
            if (!webView)
                return;

            this._pushScriptToView(
                webView,
                `window.__hanabiSetPaused?.(${this._renderer.isPlaying ? 'false' : 'true'});`
            );
        }

        _pushAudioSamplesToView(webView) {
            if (!webView)
                return;

            const payloadJson = JSON.stringify(this._webAudioSamples ?? []);
            this._pushScriptToView(
                webView,
                `window.__hanabiApplyAudioFrame?.(${payloadJson});`
            );
        }

        _pushWebPropertiesToReadyViews() {
            this._webViews.forEach((webView, index) => {
                if (!this._webViewReadyStates.get(index))
                    return;
                this._pushWebPropertiesToView(index, webView);
            });
        }

        _pushGeneralPropertiesToReadyViews() {
            this._webViews.forEach((webView, index) => {
                if (!this._webViewReadyStates.get(index))
                    return;
                this._pushGeneralPropertiesToView(webView);
            });
        }

        _pushAudioSamplesToReadyViews() {
            this._webViews.forEach((webView, index) => {
                if (!this._webViewReadyStates.get(index))
                    return;
                this._pushAudioSamplesToView(webView);
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
                    files.push(dir.get_child(info.get_name()).get_path());
                }
                return files.sort((left, right) => left.localeCompare(right));
            } catch (_e) {
                return [];
            }
        }

        _pushFetchAllDirectoryChangeToView(webView, propertyName, changedFiles, removedFiles) {
            if (!webView)
                return;

            const normalizedChangedFiles = changedFiles.map(normalizeWebFilesystemPath);
            const normalizedRemovedFiles = removedFiles.map(normalizeWebFilesystemPath);

            if (normalizedChangedFiles.length > 0) {
                this._pushScriptToView(
                    webView,
                    `window.__hanabiUserDirectoryFilesAddedOrChanged?.(${JSON.stringify(propertyName)}, ${JSON.stringify(normalizedChangedFiles)});`
                );
            }

            if (normalizedRemovedFiles.length > 0) {
                this._pushScriptToView(
                    webView,
                    `window.__hanabiUserDirectoryFilesRemoved?.(${JSON.stringify(propertyName)}, ${JSON.stringify(normalizedRemovedFiles)});`
                );
            }
        }

        _pushFetchAllDirectoryPropertiesToView(webView) {
            for (const property of this._getFetchAllDirectoryProperties()) {
                const files = this._webDirectorySnapshots.get(property.name) ?? [];
                this._pushFetchAllDirectoryChangeToView(webView, property.name, files, []);
            }
        }

        _syncFetchAllDirectoryProperties() {
            for (const property of this._getFetchAllDirectoryProperties()) {
                const directoryPath = this._webUserPropertyPayload?.[property.name]?.value ?? '';
                const nextFiles = this._listFilesForDirectory(directoryPath);
                const previousFiles = this._webDirectorySnapshots.get(property.name) ?? [];
                const previousSet = new Set(previousFiles);
                const nextSet = new Set(nextFiles);
                const changedFiles = nextFiles.filter(file => !previousSet.has(file));
                const removedFiles = previousFiles.filter(file => !nextSet.has(file));

                this._webDirectorySnapshots.set(property.name, nextFiles);
                if (changedFiles.length === 0 && removedFiles.length === 0)
                    continue;

                this._webViews.forEach((webView, index) => {
                    if (!this._webViewReadyStates.get(index))
                        return;
                    this._pushFetchAllDirectoryChangeToView(webView, property.name, changedFiles, removedFiles);
                });
            }
        }

        _freezeWPEView(index) {
            const wpeState = this._wpeStates.get(index);
            if (!wpeState)
                return;

            let frozenPaintable = null;
            if (wpeState.livePaintable)
                frozenPaintable = wpeState.livePaintable.get_current_image?.() ?? null;
            if (!frozenPaintable)
                frozenPaintable = wpeState.lastTexture;
            if (!frozenPaintable)
                return;

            wpeState.pausePicture.paintable = frozenPaintable;
            wpeState.pausePicture.visible = true;
        }

        _suspendWPEView(index) {
            const wpeState = this._wpeStates.get(index);
            if (!wpeState || wpeState.viewSuspended)
                return;

            try {
                wpeState.view.set_visible?.(false);
            } catch (_e) {
            }
            try {
                wpeState.view.unmap();
            } catch (_e) {
            }
            wpeState.pointerInside = false;
            wpeState.pressedButtons.clear();
            wpeState.viewSuspended = true;
        }

        _resumeWPEView(index) {
            const wpeState = this._wpeStates.get(index);
            if (!wpeState || !wpeState.viewSuspended)
                return;

            try {
                wpeState.view.set_visible?.(true);
            } catch (_e) {
            }
            try {
                if (wpeState.overlay.get_mapped?.())
                    wpeState.view.map();
            } catch (_e) {
            }
            this._updateWPEViewMetrics(index);
            wpeState.viewSuspended = false;
        }

        _dispatchSyntheticPointerEvent(webView, event) {
            webView.evaluate_javascript(
                buildWebPointerDispatchScript({
                    type: event.type,
                    x: event.x,
                    y: event.y,
                    button: event.button,
                    deltaX: event.deltaX,
                    deltaY: event.deltaY,
                }),
                -1,
                null,
                null,
                null,
                () => {}
            );
        }

        _dispatchWPEPointerEvent(event) {
            const wpeState = this._wpeStates.get(event.monitorIndex);
            if (!wpeState)
                return false;

            const {view} = wpeState;
            const eventTime = Math.floor(GLib.get_monotonic_time() / 1000) >>> 0;
            const source = WPEPlatform.InputSource.MOUSE;

            try {
                if (!wpeState.pointerInside && event.type !== 'wheel') {
                    view.event(
                        WPEPlatform.Event.pointer_move_new(
                            WPEPlatform.EventType.POINTER_ENTER,
                            view,
                            source,
                            eventTime,
                            this._getWPEPointerModifiers(wpeState.pressedButtons),
                            event.x,
                            event.y,
                            0,
                            0
                        )
                    );
                    wpeState.pointerInside = true;
                }

                switch (event.type) {
                case 'mousemove': {
                    const deltaX = event.x - wpeState.pointerX;
                    const deltaY = event.y - wpeState.pointerY;
                    view.event(
                        WPEPlatform.Event.pointer_move_new(
                            WPEPlatform.EventType.POINTER_MOVE,
                            view,
                            source,
                            eventTime,
                            this._getWPEPointerModifiers(wpeState.pressedButtons),
                            event.x,
                            event.y,
                            deltaX,
                            deltaY
                        )
                    );
                    break;
                }
                case 'mousedown': {
                    const nextButtons = new Set(wpeState.pressedButtons);
                    nextButtons.add(event.button);
                    const pressCount = view.compute_press_count
                        ? view.compute_press_count(event.x, event.y, event.button, eventTime)
                        : 1;
                    view.event(
                        WPEPlatform.Event.pointer_button_new(
                            WPEPlatform.EventType.POINTER_DOWN,
                            view,
                            source,
                            eventTime,
                            this._getWPEPointerModifiers(nextButtons),
                            event.button,
                            event.x,
                            event.y,
                            pressCount
                        )
                    );
                    wpeState.pressedButtons = nextButtons;
                    break;
                }
                case 'mouseup': {
                    view.event(
                        WPEPlatform.Event.pointer_button_new(
                            WPEPlatform.EventType.POINTER_UP,
                            view,
                            source,
                            eventTime,
                            this._getWPEPointerModifiers(wpeState.pressedButtons),
                            event.button,
                            event.x,
                            event.y,
                            0
                        )
                    );
                    wpeState.pressedButtons.delete(event.button);
                    break;
                }
                case 'wheel':
                    view.event(
                        WPEPlatform.Event.scroll_new(
                            view,
                            source,
                            eventTime,
                            this._getWPEPointerModifiers(wpeState.pressedButtons),
                            event.deltaX,
                            event.deltaY,
                            true,
                            false,
                            event.x,
                            event.y
                        )
                    );
                    break;
                default:
                    return false;
                }

                wpeState.pointerX = event.x;
                wpeState.pointerY = event.y;
                return true;
            } catch (e) {
                console.warn(`WPE pointer dispatch failed, falling back to synthetic DOM events: ${e}`);
                return false;
            }
        }

        _getWPEPointerModifiers(pressedButtons) {
            let modifiers = 0;
            for (const button of pressedButtons) {
                switch (button) {
                case 1:
                    modifiers |= WPEPlatform.Modifiers.POINTER_BUTTON1;
                    break;
                case 2:
                    modifiers |= WPEPlatform.Modifiers.POINTER_BUTTON2;
                    break;
                case 3:
                    modifiers |= WPEPlatform.Modifiers.POINTER_BUTTON3;
                    break;
                case 4:
                    modifiers |= WPEPlatform.Modifiers.POINTER_BUTTON4;
                    break;
                case 5:
                    modifiers |= WPEPlatform.Modifiers.POINTER_BUTTON5;
                    break;
                }
            }
            return modifiers;
        }

        _handleWPEBufferRendered(index, buffer) {
            const wpeState = this._wpeStates.get(index);
            if (!wpeState)
                return;

            this._logWPEBufferKind(index, buffer, wpeState);

            if (wpeState.livePaintable) {
                try {
                    const display = Gdk.Display.get_default();
                    if (!display)
                        throw new Error('No GDK display available for paintable import');

                    wpeState.livePaintable.update_from_buffer(buffer, display);
                    if (wpeState.liveUpdatesEnabled)
                        wpeState.livePicture.paintable = wpeState.livePaintable;
                    return;
                } catch (e) {
                    console.warn(`Failed to update WPE paintable for monitor ${index}: ${e}`);
                }
            }

            let texture;
            try {
                texture = this._createTextureFromWPEBuffer(buffer, wpeState.lastTexture);
            } catch (e) {
                console.warn(`Failed to import WPE buffer for monitor ${index}: ${e}`);
                return;
            }

            if (!texture)
                return;

            wpeState.lastTexture = texture;
            if (wpeState.liveUpdatesEnabled)
                wpeState.livePicture.paintable = texture;
        }

        _logWPEBufferKind(index, buffer, wpeState) {
            let kind = 'UNKNOWN';
            if (buffer instanceof WPEPlatform.BufferDMABuf)
                kind = 'DMA-BUF';
            else if (buffer instanceof WPEPlatform.BufferSHM)
                kind = 'SHM';

            if (wpeState.loggedBufferKinds.has(kind))
                return;

            wpeState.loggedBufferKinds.add(kind);
            console.log(
                `WPE route: monitor ${index} received ${kind} buffer ` +
                `(size=${buffer.get_width()}x${buffer.get_height()})`
            );
        }

        _createTextureFromWPEBuffer(buffer, previousTexture = null) {
            const width = buffer.get_width();
            const height = buffer.get_height();
            if (width <= 0 || height <= 0)
                return null;

            if (buffer instanceof WPEPlatform.BufferDMABuf)
                return this._createTextureFromWPEDMABuf(buffer, previousTexture);

            let bytes = null;
            let stride = width * 4;
            if (buffer instanceof WPEPlatform.BufferSHM) {
                bytes = buffer.get_data();
                stride = buffer.get_stride();
            } else {
                bytes = buffer.import_to_pixels();
            }

            if (!bytes)
                return null;

            return Gdk.MemoryTexture.new(
                width,
                height,
                wpeShmMemoryFormat,
                bytes,
                stride
            );
        }

        _createTextureFromWPEDMABuf(buffer, previousTexture) {
            if (!haveWpeBridge || !HanabiWpe?.dmabuf_texture_new_from_buffer)
                throw new Error('HanabiWpe native bridge is unavailable for dma-buf import');

            const display = Gdk.Display.get_default();
            if (!display)
                throw new Error('No GDK display available for DMA-BUF import');

            return HanabiWpe.dmabuf_texture_new_from_buffer(buffer, display, previousTexture);
        }

        _updateWPEViewMetrics(index) {
            const wpeState = this._wpeStates.get(index);
            if (!wpeState)
                return;

            const monitor = this._renderer._monitors?.[index] ?? null;
            const geometry = monitor?.get_geometry?.() ?? null;
            const width = Math.max(1, wpeState.overlay.get_width() || geometry?.width || 1);
            const height = Math.max(1, wpeState.overlay.get_height() || geometry?.height || 1);
            const scale = Math.max(1, wpeState.overlay.get_scale_factor?.() ?? 1);
            const renderWidth = Math.max(1, Math.round(width * scale));
            const renderHeight = Math.max(1, Math.round(height * scale));

            if (
                wpeState.lastWidth === width &&
                wpeState.lastHeight === height &&
                wpeState.lastScale === scale &&
                wpeState.lastRenderWidth === renderWidth &&
                wpeState.lastRenderHeight === renderHeight
            )
                return;

            wpeState.lastWidth = width;
            wpeState.lastHeight = height;
            wpeState.lastScale = scale;
            wpeState.lastRenderWidth = renderWidth;
            wpeState.lastRenderHeight = renderHeight;

            try {
                const screen = wpeState.view.get_screen?.();
                if (screen) {
                    screen.set_size(width, height);
                    screen.set_scale(scale);
                }
                if (wpeState.toplevel) {
                    wpeState.toplevel.scale_changed(scale);
                    wpeState.toplevel.resized(width, height);
                }
                const effectiveViewScale = wpeState.view.get_scale?.() ?? 1;
                const effectiveToplevelScale = wpeState.toplevel?.get_scale?.() ?? 1;
                console.log(
                    `WPE route: monitor ${index} metrics logical=${width}x${height} ` +
                    `scale=${scale} render=${renderWidth}x${renderHeight} ` +
                    `effectiveViewScale=${effectiveViewScale} ` +
                    `effectiveToplevelScale=${effectiveToplevelScale}`
                );
                wpeState.view.resized(width, height);
            } catch (e) {
                console.warn(`Failed to update WPE view metrics for monitor ${index}: ${e}`);
            }
        }

        _destroyWPEWidget(index) {
            const wpeState = this._wpeStates.get(index);
            const webView = this._webViews.get(index);
            if (!wpeState || !webView)
                return;

            // Remove the state from every lookup before touching GTK/WPE objects.
            // Monitor events and late WPE buffer callbacks can still arrive while
            // teardown is in progress; making the state unreachable first keeps
            // those callbacks from racing back into a half-destroyed widget graph.
            this._wpeStates.delete(index);
            this._webViews.delete(index);
            this._webPausePictures.delete(index);
            this._webViewReadyStates.delete(index);
            this._lastAppliedWebUserPropertyPayloads.delete(index);

            const {
                overlay,
                livePicture,
                pausePicture,
                livePaintable,
                presentationTarget,
            } = wpeState;

            if (wpeState.metricsSourceId) {
                GLib.source_remove(wpeState.metricsSourceId);
                wpeState.metricsSourceId = 0;
            }
            wpeState.signalHandlers.forEach(([target, signalId]) => {
                try {
                    target.disconnect(signalId);
                } catch (_e) {
                }
            });
            wpeState.signalHandlers = [];

            try {
                webView.stop_loading?.();
            } catch (_e) {
            }
            try {
                webView.try_close();
            } catch (_e) {
            }
            try {
                webView.terminate_web_process();
            } catch (_e) {
            }
            try {
                wpeState.view.set_toplevel?.(null);
            } catch (_e) {
            }
            try {
                wpeState.view.unmap();
            } catch (_e) {
            }
            try {
                livePaintable?.clear();
            } catch (_e) {
            }
            // GTK may already have disposed the presentation widgets when the
            // renderer swaps backends or closes quickly. Every detach operation
            // is therefore best-effort and isolated so one stale object cannot
            // prevent the remaining web process and paintable cleanup.
            detachWebPresentationTarget(presentationTarget);
            assignWebObjectProperty(livePicture, 'paintable', null);
            assignWebObjectProperty(pausePicture, 'paintable', null);
            assignWebObjectProperty(pausePicture, 'visible', false);
            wpeState.lastTexture = null;
            wpeState.livePaintable = null;
            wpeState.presentationTarget = null;
            try {
                if (overlay.get_child())
                    overlay.set_child(null);
            } catch (_e) {
            }
            try {
                overlay.remove_overlay(pausePicture);
            } catch (_e) {
            }
            disposeWebObject(presentationTarget);
            disposeWebObject(overlay);
            disposeWebObject(livePicture);
            disposeWebObject(pausePicture);
            disposeWebObject(livePaintable);
            disposeWebObject(webView);
        }

        _destroyAllWPEWidgets() {
            for (const index of [...this._wpeStates.keys()])
                this._destroyWPEWidget(index);
        }

        _resolveReadyIfNeeded() {
            if (this._readyResolved || !this._readyCallback)
                return;

            if (this._webViews.size === 0 || [...this._webViewReadyStates.values()].every(Boolean)) {
                this._readyResolved = true;
                const callback = this._readyCallback;
                this._readyCallback = null;
                callback();
            }
        }
    };
};
