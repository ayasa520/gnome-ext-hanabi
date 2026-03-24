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

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Graphene from 'gi://Graphene';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as DBus from './dbus.js';
import * as Logger from './logger.js';
import {loadProject, ProjectType} from './project.js';
import * as RoundedCornersEffect from './roundedCornersEffect.js';

const applicationId = 'io.github.jeffshee.HanabiRenderer';
const logger = new Logger.Logger();
// Ref: https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/layout.js
const BACKGROUND_FADE_ANIMATION_TIME = 1000;
const MOTION_EVENT_INTERVAL_US = 33000;
const MOTION_MIN_DELTA_PX = 1;
const extSchemaId = 'io.github.jeffshee.hanabi-extension';

// const CUSTOM_BACKGROUND_BOUNDS_PADDING = 2;

/**
 * The widget that holds the window preview of the renderer.
 */
export const LiveWallpaper = GObject.registerClass(
    class LiveWallpaper extends St.Widget {
        constructor(backgroundActor) {
            super({
                layout_manager: new Clutter.BinLayout(),
                width: backgroundActor.width,
                height: backgroundActor.height,
                // Layout manager will allocate extra space for the actor, if possible.
                x_expand: true,
                y_expand: true,
                opacity: 0,
                reactive: true,
            });
            this._backgroundActor = backgroundActor;
            this._metaBackgroundGroup = backgroundActor.get_parent();
            this._monitorIndex = backgroundActor.monitor;
            this._renderer = new DBus.RendererWrapper();
            this._lastMotionEventTimeUs = 0;
            this._lastMotionPos = null;
            this._bridgeProjectType = null;
            this._settings = Gio.Settings.new(extSchemaId);
            this._settingsProjectPathSignal = this._settings.connect('changed::project-path', () => {
                this._refreshProjectType();
            });
            this._rendererOwnerSignal = this._renderer.proxy.connect('notify::g-name-owner', () => {
                this._lastMotionPos = null;
            });
            this._refreshProjectType();

            /**
             * _monitorScale is fractional scale factor
             * _monitorWidth and _monitorHeight are scaled resolution
             * e.g. if the physical reolution = (2240, 1400) and fractional scale factor = 1.25,
             * then the scaled resolution would be (2240/1.25, 1400/1.25) = (1792, 1120).
             */
            this._display = backgroundActor.meta_display;
            this._monitorScale = this._display.get_monitor_scale(
                this._monitorIndex
            );
            let {width, height} =
                Main.layoutManager.monitors[this._monitorIndex];
            this._monitorWidth = width;
            this._monitorHeight = height;

            backgroundActor.layout_manager = new Clutter.BinLayout();
            backgroundActor.add_child(this);

            this._wallpaper = null;
            this._applyWallpaper();

            this._roundedCornersEffect =
                new RoundedCornersEffect.RoundedCornersEffect();
            // this._backgroundActor.add_effect(this._roundedCornersEffect);

            this.setPixelStep(this._monitorWidth, this._monitorHeight);
            this.setRoundedClipRadius(0.0);
            this.setRoundedClipBounds(0, 0, this._monitorWidth, this._monitorHeight);
            this._setupPointerBridge();

            // FIXME: Bounds calculation is wrong if the layout isn't vanilla (with custom dock, panel, etc.), disabled for now.
            // this.connect('notify::allocation', () => {
            //     let heightOffset = this.height - this._metaBackgroundGroup.get_parent().height;
            //     this._roundedCornersEffect.setBounds(
            //         [
            //             CUSTOM_BACKGROUND_BOUNDS_PADDING,
            //             CUSTOM_BACKGROUND_BOUNDS_PADDING + heightOffset,
            //             this.width,
            //             this.height,
            //         ].map(e => e * this._monitorScale)
            //     );
            // });
        }

        setPixelStep(width, height) {
            this._roundedCornersEffect.setPixelStep([
                1.0 / (width * this._monitorScale),
                1.0 / (height * this._monitorScale),
            ]);
        }

        setRoundedClipRadius(radius) {
            this._roundedCornersEffect.setClipRadius(
                radius * this._monitorScale
            );
        }

        setRoundedClipBounds(x1, y1, x2, y2) {
            this._roundedCornersEffect.setBounds(
                [x1, y1, x2, y2].map(e => e * this._monitorScale)
            );
        }

        _applyWallpaper() {
            logger.debug('Applying wallpaper...');
            const operation = () => {
                const renderer = this._getRenderer();
                if (renderer) {
                    this._wallpaper = new Clutter.Clone({
                        source: renderer,
                        // The point around which the scaling and rotation transformations occur.
                        pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
                    });
                    this._wallpaper.connect('destroy', () => {
                        this._wallpaper = null;
                    });
                    this.add_child(this._wallpaper);
                    this._fade();
                    logger.debug('Wallpaper applied');
                    // Stop the timeout.
                    return false;
                } else {
                    // Keep waiting.
                    return true;
                }
            };

            // Perform intial operation without timeout
            if (operation())
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, operation);
        }

        _getRenderer() {
            let windowActors = global.get_window_actors(false);

            const hanabiWindowActors = windowActors.filter(window =>
                window.meta_window.title?.includes(applicationId)
            );
            logger.debug(`Found ${hanabiWindowActors.length} Hanabi window actors`);
            logger.debug(`Hanabi window actors monitor: ${hanabiWindowActors.map(w => w.meta_window.get_monitor())}, target monitor: ${this._monitorIndex}`);

            // Reject if number of hanabi windows is less than the number of monitors
            const numMonitors = global.display.get_n_monitors();
            if (hanabiWindowActors.length < numMonitors) {
                logger.debug(`Hanabi windows (${hanabiWindowActors.length}) < monitors (${numMonitors}), rejecting`);
                return null;
            }

            // Reject if monitor indices are not unique (duplicate monitor assignments)
            const monitorIndices = hanabiWindowActors.map(w => w.meta_window.get_monitor());
            const uniqueMonitorIndices = new Set(monitorIndices);
            if (uniqueMonitorIndices.size !== monitorIndices.length) {
                logger.debug('Non-unique monitor indices detected, rejecting');
                return null;
            }

            // Find renderer by `applicationId` and monitor index.
            const renderer = hanabiWindowActors.find(
                window => window.meta_window.get_monitor() === this._monitorIndex
            );

            return renderer ?? null;
        }

        _fade(visible = true) {
            this.ease({
                opacity: visible ? 255 : 0,
                duration: BACKGROUND_FADE_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        _setupPointerBridge() {
            this.connect('motion-event', (_actor, event) => {
                const now = GLib.get_monotonic_time();
                // Cap high-frequency pointer move events to around 30Hz.
                if (now - this._lastMotionEventTimeUs < MOTION_EVENT_INTERVAL_US)
                    return Clutter.EVENT_PROPAGATE;

                this._lastMotionEventTimeUs = now;
                this._dispatchPointerEvent('mousemove', event);
                return Clutter.EVENT_PROPAGATE;
            });

            this.connect('button-press-event', (_actor, event) => {
                this._dispatchPointerEvent('mousedown', event);
                return Clutter.EVENT_PROPAGATE;
            });

            this.connect('button-release-event', (_actor, event) => {
                this._dispatchPointerEvent('mouseup', event);
                return Clutter.EVENT_PROPAGATE;
            });

            this.connect('scroll-event', (_actor, event) => {
                this._dispatchPointerEvent('wheel', event);
                return Clutter.EVENT_PROPAGATE;
            });
        }

        _dispatchPointerEvent(type, event) {
            if (!this._isBridgeActive())
                return;

            const [stageX, stageY] = event.get_coords();
            const [actorX, actorY] = this.get_transformed_position();
            const x = stageX - actorX;
            const y = stageY - actorY;
            if (x < 0 || y < 0 || x > this.width || y > this.height)
                return;

            if (type === 'mousemove') {
                if (this._lastMotionPos) {
                    const dx = Math.abs(x - this._lastMotionPos.x);
                    const dy = Math.abs(y - this._lastMotionPos.y);
                    if (dx < MOTION_MIN_DELTA_PX && dy < MOTION_MIN_DELTA_PX)
                        return;
                }
                this._lastMotionPos = {x, y};
            }

            let button = 0;
            if (type === 'mousedown' || type === 'mouseup')
                button = event.get_button();

            let deltaX = 0;
            let deltaY = 0;
            if (type === 'wheel') {
                const scrollDirection = event.get_scroll_direction();
                if (scrollDirection === Clutter.ScrollDirection.UP) {
                    deltaY = -120;
                } else if (scrollDirection === Clutter.ScrollDirection.DOWN) {
                    deltaY = 120;
                } else if (scrollDirection === Clutter.ScrollDirection.LEFT) {
                    deltaX = -120;
                } else if (scrollDirection === Clutter.ScrollDirection.RIGHT) {
                    deltaX = 120;
                } else {
                    [deltaX, deltaY] = event.get_scroll_delta();
                }
            }

            const payload = JSON.stringify({
                type,
                monitorIndex: this._monitorIndex,
                x,
                y,
                button,
                deltaX,
                deltaY,
            });
            this._renderer.dispatchPointerEvent(payload);
        }

        _refreshProjectType() {
            const projectPath = this._settings.get_string('project-path');
            const project = loadProject(projectPath);
            this._bridgeProjectType = [ProjectType.WEB, ProjectType.SCENE].includes(project?.type)
                ? project.type
                : null;
        }

        _isBridgeActive() {
            return !!this._bridgeProjectType && this._renderer.proxy.g_name_owner;
        }
    }
);
