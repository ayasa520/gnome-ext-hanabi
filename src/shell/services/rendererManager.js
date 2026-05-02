import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Launcher from './launcher.js';
import {loadProject} from '../../project.js';

const GpuPipelinePolicy = imports.gpuPipelinePolicy;

export class RendererManager {
    constructor(extension) {
        this._extension = extension;
        this._launchSourceId = 0;
        this._currentProcess = null;
        this._currentProjectType = null;
        this._reloadTime = 100;
        this._launchInhibitionReasons = new Set();
        this._stoppingProcess = null;
        this._pendingLaunchDelay = null;

        this.killAll();
    }

    get currentProjectType() {
        return this._currentProjectType;
    }

    get isLaunchInhibited() {
        return this._launchInhibitionReasons.size > 0;
    }

    sendPointerEvent(event) {
        return this._currentProcess?.sendPointerEvent(event) ?? false;
    }

    launch() {
        if (this.isLaunchInhibited || this._currentProcess || this._stoppingProcess)
            return;

        if (!this._extension.isEnabled)
            return;

        const settings = this._extension.settings;
        if (!settings)
            return;

        const projectPath = settings.get_string('project-path');
        const contentFit = settings.get_int('content-fit');
        const gpuPipeline = settings.get_string('gpu-pipeline');
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
        // The renderer is a long-lived GJS process that exercises GTK/GStreamer/WPE
        // on many threads. Constrain glibc arena growth and trim freed pages more
        // aggressively so repeated wallpaper switches do not leave RSS permanently high.
        this._currentProcess.setenv('MALLOC_ARENA_MAX', '2');
        this._currentProcess.setenv('MALLOC_TRIM_THRESHOLD_', '131072');
        GpuPipelinePolicy.applyEnvironmentToLauncher(this._currentProcess, gpuPipeline);
        this._currentProcess.spawnv(argv);
        this._extension.manager.set_wayland_client(this._currentProcess);
        const process = this._currentProcess;

        process.subprocess.wait_async(null, (obj, res) => {
            obj.wait_finish(res);
            const isCurrentProcess = this._currentProcess === process;
            const isStoppingProcess = this._stoppingProcess === process;
            if ((!isCurrentProcess && !isStoppingProcess) || obj !== process.subprocess)
                return;

            if (obj.get_if_exited()) {
                let retval = obj.get_exit_status();
                if (retval !== 0)
                    this._reloadTime = 1000;
            } else {
                this._reloadTime = 1000;
            }

            if (isCurrentProcess) {
                this._currentProcess = null;
                this._currentProjectType = null;
                this._extension.manager.set_wayland_client(null);
            }

            if (isStoppingProcess) {
                this._stoppingProcess = null;
                if (this._extension.isEnabled)
                    this._extension.override?.reloadBackgrounds?.();

                if (
                    this._pendingLaunchDelay !== null &&
                    this._extension.isEnabled &&
                    !this.isLaunchInhibited &&
                    !this._currentProcess
                ) {
                    const delay = this._pendingLaunchDelay;
                    this._pendingLaunchDelay = null;
                    this._scheduleLaunch(delay);
                }
                return;
            }

            if (this._extension.isEnabled)
                this._extension.override?.reloadBackgrounds?.();
            if (this._extension.isEnabled && !this.isLaunchInhibited)
                this._scheduleLaunch(this._reloadTime);
        });
    }

    stop() {
        const hadActiveProcess = !!this._currentProcess;
        const hadPendingLaunch = !!this._launchSourceId;
        this._clearLaunchSource();

        if (this._currentProcess && this._currentProcess.subprocess) {
            this._stoppingProcess = this._currentProcess;
            this._currentProcess.cancellable.cancel();
            this._currentProcess.subprocess.send_signal(15);
        }

        this._currentProcess = null;
        this._currentProjectType = null;
        this._extension.manager?.set_wayland_client(null);

        if (this._extension.isEnabled && (!hadActiveProcess && hadPendingLaunch))
            this._extension.override?.reloadBackgrounds?.();

        if (this._extension.isEnabled && !hadActiveProcess && !hadPendingLaunch)
            this._extension.override?.reloadBackgrounds?.();
    }

    restart(delay = 100) {
        this.stop();
        if (this._extension.isEnabled && !this.isLaunchInhibited)
            this._requestLaunch(delay);
    }

    suspendAutoLaunch(reason = 'unspecified') {
        this._launchInhibitionReasons.add(reason);
        this.stop();
    }

    resumeAutoLaunch(reason = 'unspecified', {launchIfPossible = true} = {}) {
        this._launchInhibitionReasons.delete(reason);
        if (
            launchIfPossible &&
            !this.isLaunchInhibited &&
            this._extension.isEnabled &&
            !this._currentProcess
        )
            this._requestLaunch(0);
    }

    clearAutoLaunchInhibition() {
        this._launchInhibitionReasons.clear();
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

    _requestLaunch(delay) {
        if (this._stoppingProcess) {
            this._pendingLaunchDelay = delay;
            return;
        }

        this._pendingLaunchDelay = null;
        this._scheduleLaunch(delay);
    }
}
