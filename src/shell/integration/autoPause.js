/**
 * Copyright (C) 2023 Jeff Shee (jeffshee8969@gmail.com)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Logger from '../logger.js';
import * as DBus from '../services/dbus.js';
import UPower from 'gi://UPowerGlib';

const applicationId = 'io.github.jeffshee.HanabiRenderer';
const stopOnApplicationsReason = 'matched-applications';
const logger = new Logger.Logger('autoPause');
const moduleDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const commonDir = GLib.build_filenamev([moduleDir, '..', '..', 'common']);
if (!imports.searchPath.some(path => path === commonDir))
    imports.searchPath.unshift(commonDir);

const Mpris = imports.mpris;

// Get GNOME Shell major version
const shellVersion = parseInt(Config.PACKAGE_VERSION.split('.')[0]);

function normalizeMatcherValue(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeMatcherList(values) {
    return [...new Set(values.map(normalizeMatcherValue).filter(Boolean))];
}

function safeGetString(target, methodName) {
    if (!target || typeof target[methodName] !== 'function')
        return '';

    try {
        return target[methodName]() ?? '';
    } catch (e) {
        logger.trace(e);
    }

    return '';
}

function readProcessIdentifiers(pid, scopedLogger = logger) {
    if (!Number.isInteger(pid) || pid <= 0)
        return [];

    const identifiers = [];
    const pushPathVariants = path => {
        if (!path)
            return;

        identifiers.push(path);
        identifiers.push(GLib.path_get_basename(path));
    };

    try {
        const cmdlinePath = GLib.build_filenamev(['/proc', `${pid}`, 'cmdline']);
        const cmdlineFile = Gio.File.new_for_path(cmdlinePath);
        const [binaryData] = cmdlineFile.load_bytes(null);
        const payload = binaryData.get_data();
        const argv = new TextDecoder().decode(payload).split('\u0000').filter(Boolean);
        pushPathVariants(argv[0] ?? '');
    } catch (e) {
        scopedLogger.trace(e);
    }

    try {
        const exePath = GLib.build_filenamev(['/proc', `${pid}`, 'exe']);
        const exeFile = Gio.File.new_for_path(exePath);
        const info = exeFile.query_info(
            'standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
        pushPathVariants(info.get_symlink_target() ?? '');
    } catch (e) {
        scopedLogger.trace(e);
    }

    return normalizeMatcherList(identifiers);
}

export class AutoPause {
    constructor(extension) {
        this._playbackState = extension.getPlaybackState();
        this._rendererManager = extension.rendererManager;
        this._moduleSignalHandles = [];

        // Modules
        this.modules = [];
        this.modules.push(new PauseOnMaximizeOrFullscreenModule(extension));
        this.modules.push(new PauseOnWindowFocusModule(extension));
        this.modules.push(new PauseOnBatteryModule(extension));
        this.modules.push(new PauseOnMprisPlayingModule(extension));
        this.modules.push(new StopOnApplicationsModule(extension));
        this.modules.forEach(module => {
            const id = module.connect('updated', () => this.eval());
            this._moduleSignalHandles.push([module, id]);
        });
    }

    enable() {
        this.modules.forEach(module => module.enable());
    }

    eval() {
        if (this.modules.some(module => module.shouldAutoStop())) {
            logger.debug('Auto stop requested by application matcher');
            this._rendererManager?.suspendAutoLaunch(stopOnApplicationsReason);
            return;
        }

        this._rendererManager?.resumeAutoLaunch(stopOnApplicationsReason);

        if (this.modules.some(module => module.shouldAutoPause()))
            this._playbackState.autoPause();
        else
            this._playbackState.autoPlay();
    }

    disable() {
        this._rendererManager?.resumeAutoLaunch(stopOnApplicationsReason, {launchIfPossible: false});
        this._moduleSignalHandles.forEach(([module, id]) => module.disconnect(id));
        this._moduleSignalHandles = [];
        this.modules.forEach(module => module.disable());
        this.modules = [];
        this._playbackState = null;
        this._rendererManager = null;
    }
}


/**
 * Auto Pause Modules
 */

const AutoPauseModule = GObject.registerClass({
    Signals: {
        'updated': {},
    },
}, class AutoPauseModule extends GObject.Object {
    constructor(extension, moduleName) {
        super();
        this._settings = extension.getSettings();
        this.name = moduleName;
        this._logger = moduleName ? new Logger.Logger(`autoPause::${moduleName}`) : logger;
        this._signalHandles = [];
        this._dbusSignalHandles = [];
    }

    enable() {}

    _connectTracked(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._signalHandles.push([object, id]);
        return id;
    }

    _connectTrackedDbusSignal(proxy, signal, callback) {
        const id = proxy.connectSignal(signal, callback);
        this._dbusSignalHandles.push([proxy, id]);
        return id;
    }

    _disconnectTrackedSignals() {
        this._signalHandles.forEach(([object, id]) => object.disconnect(id));
        this._signalHandles = [];
        this._dbusSignalHandles.forEach(([proxy, id]) => proxy.disconnectSignal(id));
        this._dbusSignalHandles = [];
    }

    _update() {
        this.emit('updated');
    }

    shouldAutoPause() {
        return false;
    }

    shouldAutoStop() {
        return false;
    }

    disable() {
        this._disconnectTrackedSignals();
    }
});


/**
 * Pause On Maximize Or Fullscreen
 */

const PauseOnMaximizeOrFullscreenMode = Object.freeze({
    never: 0,
    anyMonitor: 1,
    allMonitors: 2,
});

const PauseOnMaximizeOrFullscreenModule = GObject.registerClass(
    class PauseOnMaximizeOrFullscreenModule extends AutoPauseModule {
        constructor(extension) {
            super(extension, 'maximizeOrFullscreen');
            this.states = {
                maximizedOrFullscreenOnAnyMonitor: false,
                maximizedOrFullscreenOnAllMonitors: false,
            };
            this.conditions = {
                pauseOnMaximizeOrFullscreen: this._settings.get_int('pause-on-maximize-or-fullscreen'),
            };
            this._connectTracked(this._settings, 'changed::pause-on-maximize-or-fullscreen', () => {
                this.conditions.pauseOnMaximizeOrFullscreen = this._settings.get_int('pause-on-maximize-or-fullscreen');
                this._update();
            });

            this._workspaceManager = null;
            this._activeWorkspace = null;
            this._activeWorkspaceChangedId = null;
            this._windows = []; // [{metaWindow, signals: [...]}, ...]
            this._windowAddedId = null;
            this._windowRemovedId = null;
        }

        enable() {
            this._workspaceManager = global.workspace_manager;
            this._activeWorkspace = this._workspaceManager.get_active_workspace();
            this._activeWorkspaceChangedId = this._workspaceManager.connect('active-workspace-changed', this._activeWorkspaceChanged.bind(this));

            this._activeWorkspace.list_windows().forEach(
                metaWindow => this._windowAdded(metaWindow, false)
            );
            this._windowAddedId = this._activeWorkspace.connect('window-added', (_workspace, window) => this._windowAdded(window));
            this._windowRemovedId = this._activeWorkspace.connect('window-removed', (_workspace, window) => this._windowRemoved(window));

            this._update();
        }

        _windowAdded(metaWindow, doUpdate = true) {
            // Not need to track renderer window or skip taskbar window
            if (metaWindow.title?.includes(applicationId) | metaWindow.skip_taskbar)
                return;

            let signals = [];
            signals.push(
                metaWindow.connect('notify::maximized-horizontally', () => {
                    this._logger.debug('maximized-horizontally changed');
                    this._update();
                }));
            signals.push(
                metaWindow.connect('notify::maximized-vertically', () => {
                    this._logger.debug('maximized-vertically changed');
                    this._update();
                }));
            signals.push(
                metaWindow.connect('notify::fullscreen', () => {
                    this._logger.debug('fullscreen changed');
                    this._update();
                }));
            signals.push(
                metaWindow.connect('notify::minimized', () => {
                    this._logger.debug('minimized changed');
                    this._update();
                })
            );
            this._windows.push(
                {
                    metaWindow,
                    signals,
                }
            );
            this._logger.debug(`Window ${metaWindow.title} added`);
            if (doUpdate)
                this._update();
        }

        _windowRemoved(metaWindow) {
            if (metaWindow.title?.includes(applicationId) | metaWindow.skip_taskbar)
                return;

            this._windows = this._windows.filter(window => {
                if (window.metaWindow === metaWindow) {
                    window.signals.forEach(signal => metaWindow.disconnect(signal));
                    return false;
                }
                return true;
            });
            this._logger.debug(`Window ${metaWindow.title} removed`);
            this._update();
        }

        _activeWorkspaceChanged(workspaceManager) {
            this._windows.forEach(({metaWindow, signals}) => {
                signals.forEach(signal => metaWindow.disconnect(signal));
            });
            this._windows = [];

            if (this._windowAddedId) {
                this._activeWorkspace.disconnect(this._windowAddedId);
                this._windowAddedId = null;
            }
            if (this._windowRemovedId) {
                this._activeWorkspace.disconnect(this._windowRemovedId);
                this._windowRemovedId = null;
            }
            this._activeWorkspace = null;

            this._activeWorkspace = workspaceManager.get_active_workspace();
            this._logger.debug(`Active workspace changed to ${this._activeWorkspace.workspace_index}`);

            this._activeWorkspace.list_windows().forEach(
                metaWindow => this._windowAdded(metaWindow, false)
            );
            this._windowAddedId = this._activeWorkspace.connect('window-added', (_workspace, window) => this._windowAdded(window));
            this._windowRemovedId = this._activeWorkspace.connect('window-removed', (_workspace, window) => this._windowRemoved(window));

            this._update();
        }

        _update() {
            // Filter out renderer windows and minimized windows
            let metaWindows = this._windows.map(({metaWindow}) => metaWindow).filter(
                metaWindow => !metaWindow.title?.includes(applicationId) && !metaWindow.minimized
            );

            const monitors = Main.layoutManager.monitors;

            // GNOME Shell < 49 uses get_maximized(), >= 49 uses is_maximized()
            if (shellVersion < 49) {
                this.states.maximizedOrFullscreenOnAnyMonitor = metaWindows.some(metaWindow =>
                    metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH || metaWindow.fullscreen);

                let monitorsWithMaximizedOrFullscreen = metaWindows.reduce((acc, metaWindow) => {
                    if (metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH || metaWindow.fullscreen)
                        acc[metaWindow.get_monitor()] = true;
                    return acc;
                }, {});

                this.states.maximizedOrFullscreenOnAllMonitors = monitors.every(
                    monitor => monitorsWithMaximizedOrFullscreen[monitor.index]
                );
            } else {
                this.states.maximizedOrFullscreenOnAnyMonitor = metaWindows.some(metaWindow =>
                    metaWindow.is_maximized() || metaWindow.fullscreen);

                let monitorsWithMaximizedOrFullscreen = metaWindows.reduce((acc, metaWindow) => {
                    if (metaWindow.is_maximized() || metaWindow.fullscreen)
                        acc[metaWindow.get_monitor()] = true;
                    return acc;
                }, {});

                this.states.maximizedOrFullscreenOnAllMonitors = monitors.every(
                    monitor => monitorsWithMaximizedOrFullscreen[monitor.index]
                );
            }

            super._update();
        }

        shouldAutoPause() {
            let res = false;
            if (this.conditions.pauseOnMaximizeOrFullscreen === PauseOnMaximizeOrFullscreenMode.anyMonitor &&
                this.states.maximizedOrFullscreenOnAnyMonitor)
                res = true;

            if (this.conditions.pauseOnMaximizeOrFullscreen === PauseOnMaximizeOrFullscreenMode.allMonitors &&
                this.states.maximizedOrFullscreenOnAllMonitors)
                res = true;

            this._logger.debug('shouldAutoPause:', res);
            return res;
        }

        disable() {
            super.disable();
            this._workspaceManager?.disconnect(this._activeWorkspaceChangedId);
            this._windows.forEach(({metaWindow, signals}) => {
                signals.forEach(signal => metaWindow.disconnect(signal));
            });
            this._activeWorkspace?.disconnect(this._windowAddedId);
            this._activeWorkspace?.disconnect(this._windowRemovedId);

            this._workspaceManager = null;
            this._activeWorkspace = null;
            this._activeWorkspaceChangedId = null;
            this._windows = [];
            this._windowAddedId = null;
            this._windowRemovedId = null;
        }
    }
);


/**
 * Pause On Window Focus
 */

const PauseOnWindowFocusModule = GObject.registerClass(
    class PauseOnWindowFocusModule extends AutoPauseModule {
        constructor(extension) {
            super(extension, 'windowFocus');
            this.states = {
                windowFocused: false,
            };
            this.conditions = {
                pauseOnFocus: this._settings.get_boolean('pause-on-focus'),
            };
            this._connectTracked(this._settings, 'changed::pause-on-focus', () => {
                this.conditions.pauseOnFocus = this._settings.get_boolean('pause-on-focus');
                this._update();
            });

            this._display = null;
            this._trackedFocusWindow = null;
            this._focusWindowSignalHandles = [];
        }

        enable() {
            this._display = global.display;
            this._connectTracked(this._display, 'notify::focus-window', () => {
                this._logger.debug(`focus-window changed: ${this._display.focus_window?.title ?? '<desktop>'}`);
                this._trackFocusWindow(this._display.focus_window);
                this._update();
            });

            this._trackFocusWindow(this._display.focus_window);
            this._update();
        }

        _trackFocusWindow(metaWindow) {
            this._disconnectFocusWindowSignals();
            this._trackedFocusWindow = metaWindow;

            if (!metaWindow)
                return;

            // Track focused-window properties that can change without replacing
            // global.display.focus_window, so focus-loss pause resumes promptly.
            this._focusWindowSignalHandles.push(
                metaWindow.connect('notify::appears-focused', () => {
                    this._logger.debug(
                        `appears-focused changed: ${metaWindow.appears_focused} for ${metaWindow.title}`
                    );
                    this._update();
                })
            );
            this._focusWindowSignalHandles.push(
                metaWindow.connect('notify::minimized', () => {
                    this._logger.debug(`minimized changed: ${metaWindow.minimized} for ${metaWindow.title}`);
                    this._update();
                })
            );
            this._focusWindowSignalHandles.push(
                metaWindow.connect('unmanaged', () => {
                    this._logger.debug(`focused window unmanaged: ${metaWindow.title}`);
                    this._trackFocusWindow(this._display?.focus_window ?? null);
                    this._update();
                })
            );
        }

        _disconnectFocusWindowSignals() {
            if (!this._trackedFocusWindow) {
                this._focusWindowSignalHandles = [];
                return;
            }

            this._focusWindowSignalHandles.forEach(id => this._trackedFocusWindow.disconnect(id));
            this._focusWindowSignalHandles = [];
            this._trackedFocusWindow = null;
        }

        _isPausableFocusWindow(metaWindow) {
            return !!metaWindow &&
                metaWindow.appears_focused &&
                !metaWindow.minimized &&
                !metaWindow.skip_taskbar &&
                !metaWindow.title?.includes(applicationId);
        }

        _update() {
            const focusWindow = this._display?.focus_window ?? null;
            this.states.windowFocused = this._isPausableFocusWindow(focusWindow);
            this._logger.debug(
                `windowFocused=${this.states.windowFocused}, ` +
                `displayFocus=${focusWindow?.title ?? '<desktop>'}, ` +
                `appearsFocused=${focusWindow?.appears_focused ?? '<none>'}, ` +
                `minimized=${focusWindow?.minimized ?? '<none>'}`
            );

            super._update();
        }

        shouldAutoPause() {
            const res = this.conditions.pauseOnFocus && this.states.windowFocused;
            this._logger.debug('shouldAutoPause:', res);
            return res;
        }

        disable() {
            this._disconnectFocusWindowSignals();
            super.disable();
            this._display = null;
        }
    }
);


/**
 * Pause On Battery
 */

const PauseOnBatteryMode = Object.freeze({
    never: 0,
    lowBattery: 1,
    always: 2,
});

const PauseOnBatteryModule = GObject.registerClass(
    class PauseOnBatteryModule extends AutoPauseModule {
        constructor(extension) {
            super(extension, 'battery');
            this.states = {
                onBattery: false,
                lowBattery: false,
            };
            this.conditions = {
                pauseOnBattery: this._settings.get_int('pause-on-battery'),
                lowBatteryThreshold: this._settings.get_int('low-battery-threshold'),
            };
            this._connectTracked(this._settings, 'changed::pause-on-battery', () => {
                this.conditions.pauseOnBattery = this._settings.get_int('pause-on-battery');
                this._update();
            });
            this._connectTracked(this._settings, 'changed::low-battery-threshold', () => {
                this.conditions.lowBatteryThreshold = this._settings.get_int('low-battery-threshold');
                this._update();
            });

            this._upower = new DBus.UPowerWrapper();
        }

        enable() {
            this._connectTracked(this._upower.proxy, 'g-properties-changed', (_proxy, properties) => {
                let payload = properties.deep_unpack();
                if (!payload.hasOwnProperty('State') && !payload.hasOwnProperty('Percentage'))
                    return;
                this._logger.debug(`State ${payload.State}, Percentage ${payload.Percentage}`);
                this._update();
            });

            this._update();
        }

        _update() {
            let state = this._upower.getState();
            let percentage = this._upower.getPercentage();

            this.states.onBattery = state === UPower.DeviceState.PENDING_DISCHARGE || state === UPower.DeviceState.DISCHARGING;
            this.states.lowBattery = this.states.onBattery && percentage <= this.conditions.lowBatteryThreshold;

            super._update();
        }

        shouldAutoPause() {
            let res = false;
            if (this.conditions.pauseOnBattery === PauseOnBatteryMode.lowBattery && this.states.lowBattery)
                res = true;

            if (this.conditions.pauseOnBattery === PauseOnBatteryMode.always && this.states.onBattery)
                res = true;

            this._logger.debug('shouldAutoPause:', res);
            return res;
        }

        disable() {
            super.disable();
        }
    }
);


/**
 * Pause On MPRIS Playing
 */

const PauseOnMprisPlayingModule = GObject.registerClass(
    class PauseOnMprisPlayingModule extends AutoPauseModule {
        constructor(extension) {
            super(extension, 'mpris');
            this.states = {
                mprisPlaying: false,
            };
            this.conditions = {
                pauseOnMprisPlaying: this._settings.get_boolean('pause-on-mpris-playing'),
            };
            this._connectTracked(this._settings, 'changed::pause-on-mpris-playing', () => {
                this.conditions.pauseOnMprisPlaying = this._settings.get_boolean('pause-on-mpris-playing');
                this._update();
            });

            this._monitor = null;
        }

        enable() {
            this._monitor = new Mpris.MprisMonitor({
                warn: message => this._logger.debug(message),
                onChanged: ({snapshots}) => this._monitorChanged(snapshots),
            });

            this._update();
        }

        _monitorChanged(snapshots) {
            const previousState = this.states.mprisPlaying;
            this._refreshPlaybackState(snapshots);
            if (previousState !== this.states.mprisPlaying)
                super._update();
        }

        _refreshPlaybackState(snapshots = this._monitor?.getSnapshots?.() ?? []) {
            this.states.mprisPlaying = snapshots.some(
                properties => properties.playbackStatus === 'Playing'
            );
            this._logger.debug(
                `players=${JSON.stringify(snapshots.map(({name, playbackStatus}) => ({name, playbackStatus})))} ` +
                `mprisPlaying=${this.states.mprisPlaying}`
            );
        }

        _update() {
            this._refreshPlaybackState();

            super._update();
        }

        shouldAutoPause() {
            let res = false;
            if (this.conditions.pauseOnMprisPlaying && this.states.mprisPlaying)
                res = true;

            this._logger.debug('shouldAutoPause:', res);
            return res;
        }

        disable() {
            this._monitor?.destroy?.();
            this._monitor = null;
            super.disable();
        }
    }
);


/**
 * Stop On Applications
 */

const StopOnApplicationsModule = GObject.registerClass(
    class StopOnApplicationsModule extends AutoPauseModule {
        constructor(extension) {
            super(extension, 'stopOnApplications');
            this.states = {
                matchingWindows: [],
            };
            this.conditions = {
                stopOnApplications: normalizeMatcherList(this._settings.get_strv('stop-on-applications')),
            };
            this._connectTracked(this._settings, 'changed::stop-on-applications', () => {
                this.conditions.stopOnApplications = normalizeMatcherList(this._settings.get_strv('stop-on-applications'));
                this._logger.debug(`Configured matchers: ${JSON.stringify(this.conditions.stopOnApplications)}`);
                this._update();
            });

            this._display = null;
            this._windowTracker = Shell.WindowTracker.get_default();
            this._trackedWindows = new Map();
        }

        enable() {
            this._display = global.display;
            global.get_window_actors(false).forEach(windowActor => {
                this._trackWindow(windowActor?.meta_window, false);
            });
            this._connectTracked(this._display, 'window-created', (_display, metaWindow) => {
                this._logger.debug(`window-created: ${metaWindow?.title ?? '<no-title>'}`);
                this._trackWindow(metaWindow);
            });

            this._update();
        }

        _trackWindow(metaWindow, doUpdate = true) {
            if (!metaWindow || this._trackedWindows.has(metaWindow) || metaWindow.title?.includes(applicationId))
                return;

            const signals = [];
            signals.push(metaWindow.connect('unmanaged', () => this._untrackWindow(metaWindow)));
            this._tryTrackWindowProperty(metaWindow, signals, 'title');
            this._tryTrackWindowProperty(metaWindow, signals, 'wm-class');
            this._tryTrackWindowProperty(metaWindow, signals, 'wm-class-instance');
            this._tryTrackWindowProperty(metaWindow, signals, 'gtk-application-id');
            this._trackedWindows.set(metaWindow, {
                signals,
                processIdentifiers: readProcessIdentifiers(metaWindow.get_pid?.() ?? 0, this._logger),
            });

            if (doUpdate)
                this._update();
        }

        _tryTrackWindowProperty(metaWindow, signals, propertyName) {
            try {
                signals.push(metaWindow.connect(`notify::${propertyName}`, () => {
                    this._logger.debug(`${propertyName} changed for ${metaWindow.title ?? '<no-title>'}`);
                    this._update();
                }));
            } catch (e) {
                this._logger.trace(e);
            }
        }

        _untrackWindow(metaWindow) {
            const trackedWindow = this._trackedWindows.get(metaWindow);
            if (!trackedWindow)
                return;

            trackedWindow.signals.forEach(signalId => metaWindow.disconnect(signalId));
            this._trackedWindows.delete(metaWindow);
            this._logger.debug(`Window removed from stop matcher: ${metaWindow.title ?? '<no-title>'}`);
            this._update();
        }

        /**
         * Match against stable application identifiers instead of titles so the
         * stop-list can survive localization changes and documents with dynamic
         * names. Users may configure desktop app IDs, WM_CLASS values, or the
         * executable name/path. The latter is important for apps such as
         * Showtime, whose desktop file id is less obvious than its binary name.
         */
        _getWindowMatchInfo(metaWindow) {
            const app = this._windowTracker?.get_window_app(metaWindow) ?? null;
            const trackedWindow = this._trackedWindows.get(metaWindow);
            const processIdentifiers = trackedWindow?.processIdentifiers ?? [];
            const originalIdentifiers = [
                app?.get_id?.() ?? '',
                app?.get_name?.() ?? '',
                safeGetString(metaWindow, 'get_gtk_application_id'),
                safeGetString(metaWindow, 'get_wm_class'),
                safeGetString(metaWindow, 'get_wm_class_instance'),
                ...processIdentifiers,
            ].filter(Boolean);

            const identifiers = normalizeMatcherList(originalIdentifiers);
            return {
                title: metaWindow.title ?? '',
                identifiers,
                originalIdentifiers,
            };
        }

        _update() {
            const configuredMatchers = this.conditions.stopOnApplications;
            if (configuredMatchers.length === 0) {
                this.states.matchingWindows = [];
                super._update();
                return;
            }

            const matcherSet = new Set(configuredMatchers);
            this.states.matchingWindows = [...this._trackedWindows.keys()]
                .filter(metaWindow => !metaWindow.title?.includes(applicationId))
                .map(metaWindow => {
                    const matchInfo = this._getWindowMatchInfo(metaWindow);
                    return {
                        ...matchInfo,
                        matches: matchInfo.identifiers.filter(identifier => matcherSet.has(identifier)),
                    };
                })
                .filter(matchInfo => matchInfo.matches.length > 0);

            this._logger.debug(`Matching windows: ${JSON.stringify(this.states.matchingWindows)}`);
            super._update();
        }

        shouldAutoStop() {
            const res = this.states.matchingWindows.length > 0;
            this._logger.debug('shouldAutoStop:', res);
            return res;
        }

        disable() {
            this._trackedWindows.forEach((trackedWindow, metaWindow) => {
                trackedWindow.signals.forEach(signalId => metaWindow.disconnect(signalId));
            });
            this._trackedWindows.clear();
            super.disable();
            this._display = null;
            this._windowTracker = null;
        }
    }
);
