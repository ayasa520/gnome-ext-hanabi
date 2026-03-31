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

    return class VideoBackend extends BackendController {
        constructor(renderer, project) {
            super(renderer, project);
            this._pictures = [];
            this._sharedPaintable = null;
            this._play = null;
            this._media = null;
            this._adapter = null;
        }

        destroy() {
            if (this._play) {
                try {
                    this._play.pause();
                } catch (_e) {
                }
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
            this._adapter = null;
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
            if (this._play) {
                this._play.pause();
            } else if (this._media) {
                this._media.pause();
            } else {
                this._renderer._setPlayingState(false);
            }
        }

        setVolume(_volume) {
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

            this._adapter.connect('end-of-stream', adapter => adapter.play.seek(0));
            this._adapter.connect('warning', (_adapter, err) => console.warn(err));
            this._adapter.connect('error', (_adapter, err) => console.error(err));

            let stateSignal = this._adapter.connect('state-changed', (_adapter, currentState) => {
                if (currentState >= GstPlay.PlayState.PAUSED) {
                    this.setVolume(state.getVolume());
                    this.setMute(state.getMute());

                    this._adapter.disconnect(stateSignal);
                    stateSignal = null;
                }
            });
            this._adapter.connect('state-changed', (_adapter, currentState) => {
                this._renderer._setPlayingState(currentState === GstPlay.PlayState.PLAYING);
            });

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
            this._media.connect('notify::prepared', () => {
                this.setVolume(state.getVolume());
                this.setMute(state.getMute());
            });
            this._media.connect('notify::playing', media => {
                this._renderer._setPlayingState(media.get_playing());
            });

            this._sharedPaintable = this._media;
            return this._getWidgetFromSharedPaintable();
        }
    };
};
