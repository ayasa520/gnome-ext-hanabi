var createSceneBackendClass = (env, helpers, baseClasses) => {
    const {Gtk, Gio, GLib, HanabiScene, flags, state} = env;
    const {haveSceneBackend, haveContentFit} = flags;
    const {setExpandFill, createConfiguredPicture} = helpers;
    const {BackendController} = baseClasses;

    return class SceneBackend extends BackendController {
        constructor(renderer, project) {
            super(renderer, project);
            this.displayName = 'HanabiScene';
            this._sceneWidgets = [];
            this._previewPictures = [];
        }

        destroy() {
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
            this._previewPictures = [];
        }

        createWidgetForMonitor(_index) {
            if (!this._project.entryPath)
                return this._createPlaceholderWidget('Scene package not found');

            if (haveSceneBackend) {
                const sceneWidget = setExpandFill(new HanabiScene.Widget({
                    'project-dir': this._project.path,
                    muted: state.getMute(),
                    volume: state.getVolume(),
                    fps: state.getSceneFps(),
                    'fill-mode': this._getSceneFillMode(),
                    playing: true,
                }));
                this._sceneWidgets.push(sceneWidget);
                return sceneWidget;
            }

            if (!this._project.previewPath)
                return this._createPlaceholderWidget('Scene preview is not available');

            const picture = createConfiguredPicture(
                Gtk.Picture.new_for_file(Gio.File.new_for_path(this._project.previewPath))
            );
            this._previewPictures.push(picture);
            return picture;
        }

        setPlay() {
            this._sceneWidgets.forEach(widget => widget.play());
            this._renderer._setPlayingState(true);
        }

        setPause() {
            this._sceneWidgets.forEach(widget => widget.pause());
            this._renderer._setPlayingState(false);
        }

        setMute(_mute) {
            this._sceneWidgets.forEach(widget => widget.set_muted(_mute));
        }

        setVolume(_volume) {
            this._sceneWidgets.forEach(widget => widget.set_volume(_volume));
        }

        setSceneFps(fps) {
            this._sceneWidgets.forEach(widget => widget.set_fps?.(fps));
        }

        dispatchPointerEvent(event) {
            const sceneWidget = this._sceneWidgets[event.monitorIndex];
            if (!sceneWidget)
                return;

            if (event.type === 'mousemove' && sceneWidget.set_mouse_pos)
                sceneWidget.set_mouse_pos(event.x, event.y);
        }

        applyContentFit(fit) {
            if (!haveContentFit)
                return;

            this._previewPictures.forEach(picture => picture.set_content_fit(fit));
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
    };
};
