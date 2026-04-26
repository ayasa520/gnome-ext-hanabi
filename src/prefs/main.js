import Adw from 'gi://Adw';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import * as BuildConfig from '../buildConfig.js';

import {
    prefsRowBoolean,
    prefsRowChangeWallpaperMode,
    prefsRowFitMode,
    prefsRowInt,
    prefsRowPauseOnBattery,
    prefsRowPauseOnMaximizeOrFullscreen,
    prefsRowWebBackend,
} from './rows.js';
import {
    prefsRowLibraryPath,
    prefsRowProjectChooser,
} from './projectBrowser.js';

export default class HanabiExtensionPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window._settings = this.getSettings();
        window._signalHandles = [];
        window.connect('close-request', () => {
            window._signalHandles?.forEach(([object, id]) => object.disconnect(id));
            window._signalHandles = [];
            return false;
        });

        const page = new Adw.PreferencesPage();

        // Keep renderer-neutral controls together so web-only and scene-only
        // options do not visually mix with shared wallpaper behavior.
        const generalGroup = new Adw.PreferencesGroup({
            title: _('General Settings'),
        });
        page.add(generalGroup);
        prefsRowLibraryPath(window, generalGroup);
        prefsRowProjectChooser(window, generalGroup);
        prefsRowFitMode(window, generalGroup);
        prefsRowBoolean(window, generalGroup, _('Mute Audio'), 'mute', '');
        prefsRowInt(window, generalGroup, _('Volume Level'), 'volume', '', 0, 100, 1, 10);
        prefsRowBoolean(window, generalGroup, _('Show Panel Menu'), 'show-panel-menu', '');

        // Web renderer controls live in their own group because these settings
        // only affect Wallpaper Engine web projects and should not imply scene
        // backend behavior.
        const webGroup = new Adw.PreferencesGroup({
            title: _('Web Settings'),
        });
        page.add(webGroup);
        const webBackends = [
            {value: 'wpewebkit', label: _('WPE WebKit')},
        ];
        if (BuildConfig.enableGstCefSrcWebBackend) {
            // Append the optional Chromium backend only when this build ships
            // the native gstcefsrc artifacts that can actually launch it.
            webBackends.push({value: 'gstcefsrc', label: _('CEF (gstcefsrc)')});
        }
        prefsRowWebBackend(window, webGroup, webBackends);

        // Scene renderer controls stay separate from shared settings because
        // native scene projects have their own performance and timing model.
        const sceneGroup = new Adw.PreferencesGroup({
            title: _('Scene Settings'),
        });
        page.add(sceneGroup);
        prefsRowInt(window, sceneGroup, _('Scene FPS'), 'scene-fps', _('Set target FPS for scene wallpapers'), 5, 240, 5, 10);

        const autoPauseGroup = new Adw.PreferencesGroup({
            title: _('Auto Pause'),
        });
        page.add(autoPauseGroup);
        prefsRowPauseOnMaximizeOrFullscreen(window, autoPauseGroup);
        prefsRowPauseOnBattery(window, autoPauseGroup);
        prefsRowInt(window, autoPauseGroup, _('Low Battery Threshold'), 'low-battery-threshold', _('Set the threshold percentage for low battery level'), 0, 100, 5, 10);
        prefsRowBoolean(
            window,
            autoPauseGroup,
            _('Pause on Media Player Playing'),
            'pause-on-mpris-playing',
            _('Pause playback when an MPRIS media player is playing media')
        );

        const wallpaperChangerGroup = new Adw.PreferencesGroup({
            title: _('Wallpaper Changer'),
        });
        page.add(wallpaperChangerGroup);
        prefsRowBoolean(window, wallpaperChangerGroup, _('Change Wallpaper Automatically'), 'change-wallpaper', '');
        prefsRowChangeWallpaperMode(window, wallpaperChangerGroup);
        prefsRowInt(window, wallpaperChangerGroup, _('Change Wallpaper Interval (minutes)'), 'change-wallpaper-interval', '', 1, 1440, 5, 0);

        const experimentalGroup = new Adw.PreferencesGroup({
            title: _('Experimental'),
        });
        page.add(experimentalGroup);
        prefsRowBoolean(
            window,
            experimentalGroup,
            _('Experimental VA Plugin'),
            'enable-va',
            _('Enable VA decoders which improve performance for Intel/AMD Wayland users')
        );
        prefsRowBoolean(
            window,
            experimentalGroup,
            _('NVIDIA Stateless Decoders'),
            'enable-nvsl',
            _('Use new stateless NVIDIA decoders')
        );

        const developerGroup = new Adw.PreferencesGroup({
            title: _('Developer'),
        });
        page.add(developerGroup);
        prefsRowBoolean(
            window,
            developerGroup,
            _('Debug Mode'),
            'debug-mode',
            _('Print debug messages to log')
        );
        prefsRowBoolean(
            window,
            developerGroup,
            _('Force gtk4paintablesink'),
            'force-gtk4paintablesink',
            _('Force use of gtk4paintablesink for video playback')
        );
        prefsRowBoolean(
            window,
            developerGroup,
            _('Force GtkMediaFile'),
            'force-mediafile',
            _('Force use of GtkMediaFile for video playback')
        );
        prefsRowBoolean(
            window,
            developerGroup,
            _('Enable Graphics Offload'),
            'enable-graphics-offload',
            _('Enable graphics offload for improved performance (requires GTK 4.14+)')
        );
        prefsRowInt(window, developerGroup, _('Startup Delay'), 'startup-delay', _('Add a startup delay (in milliseconds) to mitigate compatibility issues with other extensions'), 0, 10000, 100, 500);

        window.add(page);
    }
}
