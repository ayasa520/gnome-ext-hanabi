var createSceneBackendClass = (env, helpers, baseClasses) => {
    const {Gtk, Gio, GLib, HanabiScene, flags, state} = env;
    const {haveSceneBackend, haveContentFit, haveGraphicsOffload} = flags;
    const {setExpandFill, createConfiguredPicture} = helpers;
    const {BackendController} = baseClasses;

    return class SceneBackend extends BackendController {
        constructor(renderer, project) {
            super(renderer, project);
            this.displayName = 'HanabiScene';
            this._sceneWidgets = [];
            this._scenePaintables = [];
            this._scenePictures = [];
            this._sceneOffloads = [];
            this._previewPictures = [];
            this._readyStates = new Map();
            this._readySignalHandlers = [];
            this._scaleSignalHandlers = [];
            this._readyCallback = null;
            this._readyResolved = false;
        }

        destroy() {
            if (this._scenePaintables.length > 0) {
                const oldScenePaintables = [...this._scenePaintables];
                oldScenePaintables.forEach(paintable => {
                    try {
                        paintable.pause();
                    } catch (_e) {
                    }
                });

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    oldScenePaintables.forEach(paintable => {
                        try {
                            paintable.pause();
                        } catch (_e) {
                        }
                    });
                    return GLib.SOURCE_REMOVE;
                });
            }

            if (this._sceneWidgets.length > 0) {
                const oldSceneWidgets = [...this._sceneWidgets];
                oldSceneWidgets.forEach(widget => {
                    try {
                        widget.pause();
                    } catch (_e) {
                    }
                });

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    oldSceneWidgets.forEach(widget => {
                        try {
                            widget.pause();
                        } catch (_e) {
                        }
                    });
                    return GLib.SOURCE_REMOVE;
                });
            }

            this._sceneWidgets = [];
            this._scenePaintables = [];
            this._scenePictures = [];
            this._sceneOffloads = [];
            this._previewPictures = [];
            this._readySignalHandlers.forEach(([target, signalId]) => {
                try {
                    target.disconnect(signalId);
                } catch (_e) {
                }
            });
            this._readySignalHandlers = [];
            this._scaleSignalHandlers.forEach(([target, signalId]) => {
                try {
                    target.disconnect(signalId);
                } catch (_e) {
                }
            });
            this._scaleSignalHandlers = [];
            this._readyStates.clear();
            this._readyCallback = null;
            this._readyResolved = true;
        }

        createWidgetForMonitor(index) {
            if (!this._project.entryPath)
                return this._createPlaceholderWidget('Scene package not found');

            if (haveSceneBackend) {
                const supportsPaintableClass = Boolean(HanabiScene.Paintable);
                const supportsGraphicsOffloadWidget = Boolean(Gtk.GraphicsOffload);
                const paintableSupported = Boolean(HanabiScene.Paintable?.is_supported?.());
                const canUsePaintable =
                    supportsPaintableClass &&
                    paintableSupported;
                const canUseGraphicsOffload =
                    haveGraphicsOffload &&
                    supportsGraphicsOffloadWidget;
                if (canUsePaintable) {
                    console.log(
                        `HanabiScene route: using Paintable for ${this._project.path} ` +
                        `(haveGraphicsOffload=${haveGraphicsOffload}, ` +
                        `supportsPaintableClass=${supportsPaintableClass}, ` +
                        `supportsGraphicsOffloadWidget=${supportsGraphicsOffloadWidget}, ` +
                        `paintableSupported=${paintableSupported})`
                    );
                    const paintable = new HanabiScene.Paintable({
                        'project-dir': this._project.path,
                        muted: state.getMute(),
                        volume: state.getVolume(),
                        fps: state.getSceneFps(),
                        'fill-mode': this._getSceneFillMode(),
                        playing: true,
                    });
                    this._scenePaintables.push(paintable);
                    this._trackReady(index, paintable);

                    const picture = createConfiguredPicture(new Gtk.Picture({
                        paintable,
                    }));
                    this._scenePictures.push(picture);

                    if (canUseGraphicsOffload) {
                        console.log(
                            `HanabiScene route: wrapping Paintable in GraphicsOffload for ${this._project.path} ` +
                            `(haveGraphicsOffload=${haveGraphicsOffload}, ` +
                            `supportsGraphicsOffloadWidget=${supportsGraphicsOffloadWidget})`
                        );
                        const offload = setExpandFill(Gtk.GraphicsOffload.new(picture));
                        offload.set_enabled(Gtk.GraphicsOffloadEnabled.ENABLED);
                        this._sceneOffloads.push(offload);
                        this._trackRenderScale(index, paintable, offload);
                        return offload;
                    }

                    console.log(
                        `HanabiScene route: presenting Paintable via GtkPicture for ${this._project.path} ` +
                        `(haveGraphicsOffload=${haveGraphicsOffload}, ` +
                        `supportsGraphicsOffloadWidget=${supportsGraphicsOffloadWidget})`
                    );
                    this._trackRenderScale(index, paintable, picture);
                    return picture;
                }

                console.log(
                    `HanabiScene route: falling back to Widget for ${this._project.path} ` +
                    `(haveGraphicsOffload=${haveGraphicsOffload}, ` +
                    `supportsPaintableClass=${supportsPaintableClass}, ` +
                    `supportsGraphicsOffloadWidget=${supportsGraphicsOffloadWidget}, ` +
                    `paintableSupported=${paintableSupported})`
                );

                const sceneWidget = setExpandFill(new HanabiScene.Widget({
                    'project-dir': this._project.path,
                    muted: state.getMute(),
                    volume: state.getVolume(),
                    fps: state.getSceneFps(),
                    'fill-mode': this._getSceneFillMode(),
                    playing: true,
                }));
                this._sceneWidgets.push(sceneWidget);
                this._trackReady(index, sceneWidget);
                this._trackRenderScale(index, sceneWidget, sceneWidget);
                return sceneWidget;
            }

            if (!this._project.previewPath)
                return this._createPlaceholderWidget('Scene preview is not available');

            const picture = createConfiguredPicture(
                Gtk.Picture.new_for_file(Gio.File.new_for_path(this._project.previewPath))
            );
            this._previewPictures.push(picture);
            this._readyStates.set(index, true);
            return picture;
        }

        setPlay() {
            this._setScenePlayback(true, true);
        }

        setPause() {
            this._setScenePlayback(false, true);
        }

        setMute(_mute) {
            this._scenePaintables.forEach(paintable => paintable.set_muted(_mute));
            this._sceneWidgets.forEach(widget => widget.set_muted(_mute));
        }

        setVolume(_volume) {
            this._scenePaintables.forEach(paintable => paintable.set_volume(_volume));
            this._sceneWidgets.forEach(widget => widget.set_volume(_volume));
        }

        setSceneFps(fps) {
            this._scenePaintables.forEach(paintable => paintable.set_fps?.(fps));
            this._sceneWidgets.forEach(widget => widget.set_fps?.(fps));
        }

        dispatchPointerEvent(event) {
            const sceneTarget = this._scenePaintables[event.monitorIndex] ?? this._sceneWidgets[event.monitorIndex];
            if (!sceneTarget)
                return;

            if (event.type === 'mousemove' && sceneTarget.set_mouse_pos)
                sceneTarget.set_mouse_pos(event.x, event.y);
        }

        applyContentFit(fit) {
            if (!haveContentFit)
                return;

            const fillMode = this._getSceneFillMode();
            this._scenePaintables.forEach(paintable => paintable.set_fill_mode?.(fillMode));
            this._sceneWidgets.forEach(widget => widget.set_fill_mode?.(fillMode));
            this._scenePictures.forEach(picture => picture.set_content_fit(fit));
            this._previewPictures.forEach(picture => picture.set_content_fit(fit));
        }

        waitUntilReady(callback) {
            this._readyCallback = callback;
            this._resolveReadyIfNeeded();
        }

        prepareForTransitionOut() {
            this._setScenePlayback(false, false);
        }

        _getSceneFillMode() {
            if (!haveContentFit)
                return 2;

            switch (state.getContentFit()) {
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

        _trackReady(index, target) {
            const updateReadyState = () => {
                this._readyStates.set(index, Boolean(target.ready));
                this._resolveReadyIfNeeded();
            };

            updateReadyState();
            this._readySignalHandlers.push([target, target.connect('notify::ready', updateReadyState)]);
        }

        _trackRenderScale(index, sceneTarget, widget) {
            if (!sceneTarget?.set_property || !widget?.connect)
                return;

            const monitor = this._renderer._monitors?.[index] ?? null;
            const updateRenderScale = () => {
                const scale = Math.max(
                    1,
                    widget.get_scale_factor?.() ?? 1,
                    monitor?.get_scale_factor?.() ?? 1
                );
                sceneTarget.set_property('render-scale', scale);
            };

            updateRenderScale();
            this._scaleSignalHandlers.push([widget, widget.connect('map', updateRenderScale)]);
            this._scaleSignalHandlers.push([widget, widget.connect('notify::scale-factor', updateRenderScale)]);
        }

        _resolveReadyIfNeeded() {
            if (this._readyResolved || !this._readyCallback)
                return;

            if (this._readyStates.size === 0 || [...this._readyStates.values()].every(Boolean)) {
                this._readyResolved = true;
                const callback = this._readyCallback;
                this._readyCallback = null;
                callback();
            }
        }

        _setScenePlayback(isPlaying, updateState) {
            if (isPlaying) {
                this._scenePaintables.forEach(paintable => paintable.play());
                this._sceneWidgets.forEach(widget => widget.play());
            } else {
                this._scenePaintables.forEach(paintable => paintable.pause());
                this._sceneWidgets.forEach(widget => widget.pause());
            }

            if (updateState)
                this._renderer._setPlayingState(isPlaying);
        }
    };
};
