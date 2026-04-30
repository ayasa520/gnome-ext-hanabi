export class SettingsBindings {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.settings;
        this._signalHandles = [];
    }

    enable() {
        this._signalHandles.push(this._settings.connect('changed::show-panel-menu', () => {
            if (this._settings.get_boolean('show-panel-menu'))
                this._extension.panelMenu.enable();
            else
                this._extension.panelMenu.disable();
        }));

        this._signalHandles.push(this._settings.connect('changed::gpu-pipeline', () => {
            this._extension.rendererManager?.restart();
        }));
    }

    destroy() {
        this._signalHandles.forEach(signalId => this._settings?.disconnect(signalId));
        this._signalHandles = [];
        this._settings = null;
        this._extension = null;
    }
}
