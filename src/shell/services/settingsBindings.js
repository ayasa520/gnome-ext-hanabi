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

        this._signalHandles.push(this._settings.connect('changed::project-path', () => {
            if (!this._extension.isEnabled)
                return;

            const projectPath = this._settings.get_string('project-path');
            this._extension.renderer.setProjectPath(projectPath);
        }));

        this._signalHandles.push(this._settings.connect('changed::mute', () => {
            if (this._extension.isEnabled)
                this._extension.renderer.setMute(this._settings.get_boolean('mute'));
        }));

        this._signalHandles.push(this._settings.connect('changed::volume', () => {
            if (this._extension.isEnabled)
                this._extension.renderer.setVolume(this._settings.get_int('volume') / 100.0);
        }));
    }

    destroy() {
        this._signalHandles.forEach(signalId => this._settings?.disconnect(signalId));
        this._signalHandles = [];
        this._settings = null;
        this._extension = null;
    }
}
