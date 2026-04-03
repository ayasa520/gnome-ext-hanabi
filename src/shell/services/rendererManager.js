import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Launcher from './launcher.js';
import {loadProject} from '../../project.js';

export class RendererManager {
    constructor(extension) {
        this._extension = extension;
        this._launchSourceId = 0;
        this._currentProcess = null;
        this._currentProjectType = null;
        this._reloadTime = 100;

        this.killAll();
    }

    get currentProjectType() {
        return this._currentProjectType;
    }

    sendPointerEvent(event) {
        return this._currentProcess?.sendPointerEvent(event) ?? false;
    }

    launch() {
        if (!this._extension.isEnabled)
            return;

        const settings = this._extension.settings;
        if (!settings)
            return;

        const projectPath = settings.get_string('project-path');
        const contentFit = settings.get_int('content-fit');
        const project = loadProject(projectPath);
        if (!project) {
            this._extension.openPreferences();
            return;
        }
        this._currentProjectType = project.type;

        this._reloadTime = 100;
        const argv = [
            GLib.build_filenamev([
                this._extension.path,
                'renderer',
                'renderer.js',
            ]),
        ];
        argv.push('-F', projectPath);
        argv.push('--content-fit', `${contentFit}`);

        this._currentProcess = new Launcher.LaunchSubprocess();
        this._currentProcess.set_cwd(GLib.get_home_dir());
        this._currentProcess.spawnv(argv);
        this._extension.manager.set_wayland_client(this._currentProcess);
        const process = this._currentProcess;

        process.subprocess.wait_async(null, (obj, res) => {
            obj.wait_finish(res);
            if (this._currentProcess !== process || obj !== process.subprocess)
                return;

            if (obj.get_if_exited()) {
                let retval = obj.get_exit_status();
                if (retval !== 0)
                    this._reloadTime = 1000;
            } else {
                this._reloadTime = 1000;
            }

            this._currentProcess = null;
            this._currentProjectType = null;
            this._extension.manager.set_wayland_client(null);
            if (this._extension.isEnabled)
                this._scheduleLaunch(this._reloadTime);
        });
    }

    stop() {
        this._clearLaunchSource();

        if (this._currentProcess && this._currentProcess.subprocess) {
            this._currentProcess.cancellable.cancel();
            this._currentProcess.subprocess.send_signal(15);
        }

        this._currentProcess = null;
        this._currentProjectType = null;
        this._extension.manager?.set_wayland_client(null);
    }

    killAll() {
        let procFolder = Gio.File.new_for_path('/proc');
        if (!procFolder.query_exists(null))
            return;

        let fileEnum = procFolder.enumerate_children(
            'standard::*',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        let info;
        while ((info = fileEnum.next_file(null))) {
            let filename = info.get_name();
            if (!filename)
                break;

            let processPath = GLib.build_filenamev(['/proc', filename, 'cmdline']);
            let processUser = Gio.File.new_for_path(processPath);
            if (!processUser.query_exists(null))
                continue;

            let [binaryData, _etag] = processUser.load_bytes(null);
            let contents = '';
            let readData = binaryData.get_data();
            for (let i = 0; i < readData.length; i++) {
                if (readData[i] < 32)
                    contents += ' ';
                else
                    contents += String.fromCharCode(readData[i]);
            }
            let path =
                `gjs ${
                    GLib.build_filenamev([
                        this._extension.path,
                        'renderer',
                        'renderer.js',
                    ])}`;
            if (contents.startsWith(path)) {
                let proc = new Gio.Subprocess({argv: ['/bin/kill', filename]});
                proc.init(null);
                proc.wait(null);
            }
        }
    }

    _clearLaunchSource() {
        if (!this._launchSourceId)
            return;

        GLib.source_remove(this._launchSourceId);
        this._launchSourceId = 0;
    }

    _scheduleLaunch(delay) {
        this._clearLaunchSource();
        this._launchSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this._launchSourceId = 0;
                this.launch();
                return false;
            }
        );
    }
}
