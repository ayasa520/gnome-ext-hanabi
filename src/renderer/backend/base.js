var createBaseBackendClasses = (env, helpers) => {
    const {Gtk} = env;
    const {setExpandFill} = helpers;

    class BackendController {
        constructor(renderer, project) {
            this._renderer = renderer;
            this._project = project;
            this.displayName = '';
        }

        createWidgetForMonitor(_index) {
            return this._createPlaceholderWidget('Not supported wallpaper project');
        }

        destroy() {
        }

        setPlay() {
            this._renderer._setPlayingState(true);
        }

        setPause() {
            this._renderer._setPlayingState(false);
        }

        setMute(_mute) {
        }

        setVolume(_volume) {
        }

        setSceneFps(_fps) {
        }

        dispatchPointerEvent(_event) {
        }

        applyContentFit(_fit) {
        }

        waitUntilReady(callback) {
            callback();
        }

        prepareForTransitionOut() {
        }

        _createPlaceholderWidget(message) {
            this.displayName = this.displayName || 'Placeholder';

            const box = setExpandFill(new Gtk.Box());
            box.add_css_class('background');

            const label = new Gtk.Label({
                label: message,
                wrap: true,
                justify: Gtk.Justification.CENTER,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
            });
            box.append(label);

            return box;
        }
    }

    class InvalidProjectBackend extends BackendController {
        createWidgetForMonitor(_index) {
            return this._createPlaceholderWidget('Invalid wallpaper project');
        }
    }

    return {
        BackendController,
        InvalidProjectBackend,
    };
};
