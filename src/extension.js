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

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as GnomeShellOverride from './shell/integration/gnomeShellOverride.js';
import * as WindowManager from './shell/integration/windowManager.js';
import * as PlaybackState from './shell/services/playbackState.js';
import * as AutoPause from './shell/integration/autoPause.js';
import * as PanelMenu from './shell/ui/panelMenu.js';
import * as DBus from './shell/services/dbus.js';
import * as RendererManager from './shell/services/rendererManager.js';
import * as SettingsBindings from './shell/services/settingsBindings.js';

export default class HanabiExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this.isEnabled = false;
        this.startupDelayId = 0;
        this.startupCompleteId = 0;
        this.startupOverviewRestoreId = 0;

        // RendererManager also clears any stale renderer subprocess left by a shell reload.
        this.rendererManager = new RendererManager.RendererManager(this);
    }

    enable() {
        this.settings = this.getSettings();
        this.playbackState = new PlaybackState.PlaybackState();
        this.renderer = new DBus.RendererWrapper();

        /**
         * Panel Menu
         */
        this.panelMenu = new PanelMenu.HanabiPanelMenu(this);
        if (this.settings.get_boolean('show-panel-menu'))
            this.panelMenu.enable();

        this.settingsBindings = new SettingsBindings.SettingsBindings(this);
        this.settingsBindings.enable();
        /**
         * Disable startup animation (Workaround for issue #65)
         */
        this.old_hasOverview = Main.sessionMode.hasOverview;

        if (Main.layoutManager._startingUp) {
            Main.sessionMode.hasOverview = false;
            this.startupOverviewRestoreId = Main.layoutManager.connect('startup-complete', () => {
                Main.sessionMode.hasOverview = this.old_hasOverview;
                Main.layoutManager.disconnect(this.startupOverviewRestoreId);
                this.startupOverviewRestoreId = 0;
            });
            // Handle Ubuntu's method
            if (Main.layoutManager.startInOverview)
                Main.layoutManager.startInOverview = false;
        }

        /**
         * Other overrides
         */
        this.override = new GnomeShellOverride.GnomeShellOverride(this);
        this.manager = new WindowManager.WindowManager();
        this.autoPause = new AutoPause.AutoPause(this);

        // If the desktop is still starting up, wait until it is ready
        if (Main.layoutManager._startingUp) {
            this.startupCompleteId = Main.layoutManager.connect(
                'startup-complete',
                () => {
                    this.startupDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.settings.get_int('startup-delay'), () => {
                        this.startupDelayId = 0;
                        Main.layoutManager.disconnect(this.startupCompleteId);
                        this.startupCompleteId = 0;
                        if (this.settings)
                            this.innerEnable();
                        return false;
                    });
                }
            );
        } else {
            this.startupDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.settings.get_int('startup-delay'), () => {
                this.startupDelayId = 0;
                if (this.settings)
                    this.innerEnable();
                return false;
            });
        }
    }

    innerEnable() {
        this.override.enable();
        this.manager.enable();
        this.autoPause.enable();

        this.isEnabled = true;
        this.rendererManager.launch();
    }

    getPlaybackState() {
        return this.playbackState;
    }

    disable() {
        if (this.startupDelayId) {
            GLib.source_remove(this.startupDelayId);
            this.startupDelayId = 0;
        }

        if (this.startupCompleteId) {
            Main.layoutManager.disconnect(this.startupCompleteId);
            this.startupCompleteId = 0;
        }

        if (this.startupOverviewRestoreId) {
            Main.layoutManager.disconnect(this.startupOverviewRestoreId);
            this.startupOverviewRestoreId = 0;
        }

        this.settingsBindings?.destroy();

        this.panelMenu?.disable();
        Main.sessionMode.hasOverview = this.old_hasOverview;
        this.override?.disable();
        this.manager?.disable();
        this.autoPause?.disable();

        this.isEnabled = false;
        this.rendererManager?.stop();
        this.playbackState?.destroy();

        this.settings = null;
        this.settingsBindings = null;
        this.renderer = null;
        this.panelMenu = null;
        this.override = null;
        this.manager = null;
        this.autoPause = null;
        this.playbackState = null;
    }
}
