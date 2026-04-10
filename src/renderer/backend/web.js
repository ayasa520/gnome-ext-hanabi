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
    const {setExpandFill, createConfiguredPicture, buildWebPointerDispatchScript} = helpers;
    const {BackendController} = baseClasses;

    const isLittleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;
    const wpeShmMemoryFormat = isLittleEndian
        ? Gdk.MemoryFormat.B8G8R8A8_PREMULTIPLIED
        : Gdk.MemoryFormat.A8R8G8B8_PREMULTIPLIED;

    return class WebBackend extends BackendController {
        constructor(renderer, project) {
            super(renderer, project);
            this._webViews = new Map();
            this._webPausePictures = new Map();
            this._webViewReadyStates = new Map();
            this._readyCallback = null;
            this._readyResolved = false;
            this._wpeStates = new Map();
            this._wpeDisplay = this._createWPEDisplay();
            this.usesNativeWindows = false;
            this.displayName = 'WPEWebKit';
        }

        destroy() {
            this._readyCallback = null;
            this._readyResolved = true;

            this._destroyAllWPEWidgets();

            this._webViews.clear();
            this._webPausePictures.clear();
            this._webViewReadyStates.clear();
            this._wpeStates.clear();
            this._wpeDisplay = null;
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

        setMute(_mute) {
            this._webViews.forEach(webView => {
                if (webView.is_muted === _mute)
                    webView.is_muted = !_mute;
                webView.is_muted = _mute;
            });
        }

        dispatchPointerEvent(event) {
            if (this._dispatchWPEPointerEvent(event))
                return;

            const webView = this._webViews.get(event.monitorIndex);
            if (!webView)
                return;

            this._dispatchSyntheticPointerEvent(webView, event);
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
                return offload;
            }

            return overlay;
        }

        _createUserContentManager(api) {
            const userContentManager = new api.UserContentManager();
            userContentManager.add_script(
                new api.UserScript(
                    `
                    (() => {
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
                    api.UserContentInjectedFrames.ALL_FRAMES,
                    api.UserScriptInjectionTime.START,
                    null,
                    null
                )
            );
            return userContentManager;
        }

        _loadProjectEntry(webView) {
            const file = Gio.File.new_for_path(this._project.entryPath);
            const uri = file.get_uri();
            if (!this._shouldLoadEntryAsHtml(this._project.entryPath)) {
                webView.load_uri(uri);
                return;
            }

            try {
                const [ok, contents] = GLib.file_get_contents(this._project.entryPath);
                if (!ok)
                    throw new Error('GLib.file_get_contents returned false');

                // Force local `.html` wallpaper entries through the HTML parser so
                // legacy Wallpaper Engine projects with XHTML-like markup still load.
                webView.load_html(new TextDecoder().decode(contents), uri);
                return;
            } catch (e) {
                console.warn(`Failed to load HTML entry via load_html; falling back to URI load: ${e}`);
            }

            webView.load_uri(uri);
        }

        _shouldLoadEntryAsHtml(entryPath) {
            return /\.(?:html?|xhtml)$/i.test(entryPath);
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
                wpeState.livePaintable?.clear();
            } catch (_e) {
            }
            wpeState.livePicture.paintable = null;
            wpeState.pausePicture.paintable = null;
            wpeState.pausePicture.visible = false;
            wpeState.lastTexture = null;
            wpeState.livePaintable = null;
            try {
                if (wpeState.overlay.get_child())
                    wpeState.overlay.set_child(null);
            } catch (_e) {
            }
            try {
                wpeState.overlay.remove_overlay(wpeState.pausePicture);
            } catch (_e) {
            }

            this._wpeStates.delete(index);
            this._webViews.delete(index);
            this._webPausePictures.delete(index);
            this._webViewReadyStates.delete(index);
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
