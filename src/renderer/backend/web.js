var createWebBackendClass = (env, helpers, baseClasses) => {
    const {WebKit, Gio, Gtk, flags} = env;
    const {haveWebKit, haveContentFit} = flags;
    const {setExpandFill, createConfiguredPicture, buildWebPointerDispatchScript} = helpers;
    const {BackendController} = baseClasses;

    return class WebBackend extends BackendController {
        constructor(renderer, project) {
            super(renderer, project);
            this.displayName = 'WebKitWebView';
            this._webViews = new Map();
            this._webPausePictures = new Map();
            this._webViewReadyStates = new Map();
            this._readyCallback = null;
            this._readyResolved = false;
        }

        destroy() {
            this._readyCallback = null;
            this._readyResolved = true;
            this._webViews.clear();
            this._webPausePictures.clear();
            this._webViewReadyStates.clear();
        }

        createWidgetForMonitor(index) {
            if (!haveWebKit)
                return this._createPlaceholderWidget('WebKitGTK is not available');

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

            const webView = setExpandFill(new WebKit.WebView({
                user_content_manager: userContentManager,
            }));
            const pausePicture = createConfiguredPicture(new Gtk.Picture({
                visible: false,
            }));

            const overlay = setExpandFill(new Gtk.Overlay());
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

                this._webViewReadyStates.set(index, true);
                this._resolveReadyIfNeeded();

                if (this._renderer.isPlaying)
                    this._setPlayback(true, true);
            });

            const file = Gio.File.new_for_path(this._project.entryPath);
            webView.load_uri(file.get_uri());
            this._webViews.set(index, webView);
            this._webPausePictures.set(index, pausePicture);
            this._webViewReadyStates.set(index, false);

            return overlay;
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
            const webView = this._webViews.get(event.monitorIndex);
            if (!webView)
                return;

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

        applyContentFit(fit) {
            if (!haveContentFit)
                return;

            this._webPausePictures.forEach(picture => picture.set_content_fit(fit));
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

                if (isPlaying) {
                    webView.visible = true;
                    const pausePicture = this._webPausePictures.get(index);
                    if (pausePicture)
                        pausePicture.visible = false;
                } else {
                    this._freezeWebView(index);
                }
            });
            if (updateState)
                this._renderer._setPlayingState(isPlaying);
        }

        _freezeWebView(index) {
            const webView = this._webViews.get(index);
            const pausePicture = this._webPausePictures.get(index);
            if (!webView || !pausePicture)
                return;

            webView.get_snapshot(
                WebKit.SnapshotRegion.VISIBLE,
                WebKit.SnapshotOptions.NONE,
                null,
                (currentWebView, result) => {
                    try {
                        const snapshot = currentWebView.get_snapshot_finish(result);
                        if (!snapshot)
                            return;

                        pausePicture.paintable = snapshot;
                        pausePicture.visible = true;
                        currentWebView.visible = false;
                    } catch (e) {
                        console.warn(e);
                    }
                }
            );
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
