var createVideoBackendClass = (env, helpers, baseClasses) => {
    const {
        Gtk,
        Gio,
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
        haveGraphicsOffload,
        haveContentFit,
    } = flags;
    const {createConfiguredPicture} = helpers;
    const {BackendController} = baseClasses;

    const detachVideoPresentationTarget = target => {
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
    const detachVideoWidgetTree = widget => {
        if (!widget)
            return;

        const children = [];
        let child = widget.get_first_child?.() ?? null;
        while (child) {
            children.push(child);
            child = child.get_next_sibling?.() ?? null;
        }

        children.forEach(detachVideoWidgetTree);
        detachVideoPresentationTarget(widget);

        children.forEach(childWidget => {
            try {
                widget.remove_overlay?.(childWidget);
            } catch (_e) {
            }

            try {
                widget.remove?.(childWidget);
            } catch (_e) {
            }
        });
    };
    const disposeVideoTarget = target => {
        if (!target)
            return;

        try {
            target.run_dispose?.();
        } catch (_e) {
        }
    };

    return class VideoBackend extends BackendController {
        constructor(renderer, project) {
            super(renderer, project);
            this._pictures = [];
            this._rootWidgets = [];
            this._presentationTargets = [];
            this._signalHandlers = [];
            this._sharedPaintable = null;
            this._play = null;
            this._media = null;
            this._adapter = null;
            this._readyCallback = null;
            this._readyResolved = false;
            this._desiredVolume = state.getVolume();
            this._desiredMute = state.getMute();
        }

        destroy() {
            this._signalHandlers.forEach(([target, signalId]) => {
                try {
                    target.disconnect(signalId);
                } catch (_e) {
                }
            });
            this._signalHandlers = [];

            if (this._play) {
                try {
                    this._play.pause();
                } catch (_e) {
                }
                try {
                    this._play.stop();
                } catch (_e) {
                }
                try {
                    this._play.get_pipeline?.()?.set_state?.(Gst.State.NULL);
                } catch (_e) {
                }
            }

            if (this._media) {
                try {
                    this._media.pause();
                } catch (_e) {
                }
                try {
                    this._media.stream_unprepared();
                } catch (_e) {
                }
                try {
                    this._media.clear();
                } catch (_e) {
                }
            }

            this._pictures.forEach(picture => detachVideoPresentationTarget(picture));
            this._presentationTargets.forEach(target => detachVideoPresentationTarget(target));
            this._rootWidgets.forEach(widget => detachVideoWidgetTree(widget));
            [...new Set([
                ...this._pictures,
                ...this._presentationTargets,
                ...this._rootWidgets,
                this._sharedPaintable,
                this._media,
                this._adapter,
                this._play,
            ].filter(Boolean))].forEach(target => disposeVideoTarget(target));
            this._pictures = [];
            this._rootWidgets = [];
            this._presentationTargets = [];
            this._sharedPaintable = null;
            this._play = null;
            this._media = null;
            this._adapter = null;
            this._readyCallback = null;
            this._readyResolved = true;
            this._renderer = null;
            this._project = null;
        }

        createWidgetForMonitor(index) {
            let widget = this._getWidgetFromSharedPaintable();

            if (index > 0 && !widget)
                return this._createPlaceholderWidget('Video renderer could not be shared across monitors');

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

            if (widget)
                this._rootWidgets.push(widget);

            return widget;
        }

        setPlay() {
            if (this._play) {
                this._play.play();
            } else if (this._media) {
                this._media.play();
            } else {
                this._renderer._setPlayingState(true);
            }
        }

        setPause() {
            if (this._play || this._media) {
                this._pauseInternal();
            } else {
                this._renderer._setPlayingState(false);
            }
        }

        setVolume(_volume) {
            this._desiredVolume = _volume;
            let player = this._play != null ? this._play : this._media;
            if (!player)
                return;

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
            this._desiredMute = _mute;
            if (this._play) {
                if (this._play.mute === _mute)
                    this._play.mute = !_mute;
                this._play.mute = _mute;
            } else if (this._media) {
                if (this._media.muted === _mute)
                    this._media.muted = !_mute;
                this._media.muted = _mute;
            }
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

        prepareForTransitionOut() {
            this._pauseInternal();
        }

        _getWidgetFromSharedPaintable() {
            if (!this._sharedPaintable)
                return null;

            let picture = createConfiguredPicture(new Gtk.Picture({
                paintable: this._sharedPaintable,
            }));
            this._pictures.push(picture);

            if (haveGraphicsOffload) {
                let offload = Gtk.GraphicsOffload.new(picture);
                offload.set_enabled(Gtk.GraphicsOffloadEnabled.ENABLED);
                this._presentationTargets.push(offload);
                return offload;
            }

            return picture;
        }

        _getWidgetFromSink(sink) {
            this.displayName = sink.name;

            let widget = null;

            if (sink.widget) {
                if (sink.widget instanceof Gtk.Picture) {
                    this._sharedPaintable = sink.widget.paintable;
                    this._pictures.push(sink.widget);
                    let box = new Gtk.Box();
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

            if (!widget)
                return null;

            if (useGstGL) {
                let glsink = Gst.ElementFactory.make('glsinkbin', 'glsinkbin');
                if (glsink) {
                    this.displayName = `glsinkbin + ${this.displayName}`;
                    glsink.set_property('sink', sink);
                    sink = glsink;
                }
            }

            this._play = GstPlay.Play.new(
                GstPlay.PlayVideoOverlayVideoRenderer.new_with_sink(null, sink)
            );
            this._adapter = GstPlay.PlaySignalAdapter.new(this._play);

            this._signalHandlers.push([
                this._adapter,
                this._adapter.connect('end-of-stream', adapter => adapter.play.seek(0)),
            ]);
            this._signalHandlers.push([
                this._adapter,
                this._adapter.connect('warning', (_adapter, err) => console.warn(err)),
            ]);
            this._signalHandlers.push([
                this._adapter,
                this._adapter.connect('error', (_adapter, err) => console.error(err)),
            ]);

            let stateSignal = this._adapter.connect('state-changed', (_adapter, currentState) => {
                if (currentState >= GstPlay.PlayState.PAUSED) {
                    this.setVolume(this._desiredVolume);
                    this.setMute(this._desiredMute);
                    this._markReady();

                    this._adapter.disconnect(stateSignal);
                    stateSignal = null;
                }
            });
            this._signalHandlers.push([this._adapter, stateSignal]);
            this._signalHandlers.push([
                this._adapter,
                this._adapter.connect('state-changed', (_adapter, currentState) => {
                    this._renderer._setPlayingState(currentState === GstPlay.PlayState.PLAYING);
                }),
            ]);

            let file = Gio.File.new_for_path(this._project.entryPath);
            this._play.set_uri(file.get_uri());

            return widget;
        }

        _getGtkStockWidget() {
            this.displayName = 'GtkMediaFile';

            this._media = Gtk.MediaFile.new_for_filename(this._project.entryPath);
            this._media.set({
                loop: true,
            });
            this._signalHandlers.push([
                this._media,
                this._media.connect('notify::prepared', () => {
                    this._markReady();
                    this.setVolume(this._desiredVolume);
                    this.setMute(this._desiredMute);
                }),
            ]);
            this._signalHandlers.push([
                this._media,
                this._media.connect('notify::playing', media => {
                    this._renderer._setPlayingState(media.get_playing());
                }),
            ]);

            this._sharedPaintable = this._media;
            return this._getWidgetFromSharedPaintable();
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

            if (!this._play && !this._media)
                this._markReady();
        }

        _pauseInternal() {
            if (this._play)
                this._play.pause();
            else if (this._media)
                this._media.pause();
        }
    };
};
