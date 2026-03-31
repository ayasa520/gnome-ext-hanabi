import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const haveContentFit = Gtk.get_minor_version() >= 8;

export function connectTracked(window, object, signal, callback) {
    const id = object.connect(signal, callback);
    window._signalHandles.push([object, id]);
    return id;
}

export function prefsRowBoolean(window, prefsGroup, title, key, subtitle) {
    const settings = window._settings;
    const row = new Adw.ActionRow({title, subtitle});
    prefsGroup.add(row);

    const toggle = new Gtk.Switch({
        active: settings.get_boolean(key),
        valign: Gtk.Align.CENTER,
    });
    settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);

    row.add_suffix(toggle);
    row.activatable_widget = toggle;
}

export function prefsRowInt(
    window,
    prefsGroup,
    title,
    key,
    subtitle,
    lower,
    upper,
    stepIncrement,
    pageIncrement
) {
    const settings = window._settings;
    const row = new Adw.ActionRow({title, subtitle});
    prefsGroup.add(row);

    const adjustment = new Gtk.Adjustment({
        lower,
        upper,
        step_increment: stepIncrement,
        page_increment: pageIncrement,
        value: settings.get_int(key),
    });

    adjustment.connect('value-changed', () => {
        settings.set_int(key, adjustment.value);
    });

    const spin = new Gtk.SpinButton({
        adjustment,
        valign: Gtk.Align.CENTER,
    });

    row.add_suffix(spin);
}

export function prefsRowFitMode(window, prefsGroup) {
    const settings = window._settings;
    const title = _('Fit Mode');
    const subtitle = _('Control how wallpaper fits within the monitor');
    const tooltip = _(`
    <b>Fill</b>: Stretch the wallpaper to fill the monitor.
    <b>Contain</b>: Scale the wallpaper to fit the monitor (keep aspect ratio).
    <b>Cover</b>: Scale the wallpaper to cover the monitor (keep aspect ratio).
    <b>Scale-down</b>: Scale down the wallpaper to fit the monitor if needed, otherwise keep its original size.
    `);

    const items = Gtk.StringList.new([
        _('Fill'),
        _('Contain'),
        _('Cover'),
        _('Scale-down'),
    ]);

    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: items,
        selected: settings.get_int('content-fit'),
    });

    if (haveContentFit) {
        row.set_tooltip_markup(tooltip);
    } else {
        row.set_tooltip_markup(_('This feature requires Gtk 4.8 or above'));
        row.set_sensitive(false);
    }
    prefsGroup.add(row);

    row.connect('notify::selected', () => {
        settings.set_int('content-fit', row.selected);
    });
}

export function prefsRowPauseOnMaximizeOrFullscreen(window, prefsGroup) {
    const settings = window._settings;
    const title = _('Pause on Maximize or Fullscreen');
    const subtitle = _('Pause playback when there is maximized or fullscreen window');
    const tooltip = _(`
    <b>Never</b>: Disable this feature.
    <b>Any Monitor</b>: Pause playback when there is maximized or fullscreen window on any monitor.
    <b>All Monitors</b>: Pause playback when there are maximized or fullscreen windows on all monitors.
    `);

    const items = Gtk.StringList.new([
        _('Never'),
        _('Any Monitor'),
        _('All Monitors'),
    ]);

    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: items,
        selected: settings.get_int('pause-on-maximize-or-fullscreen'),
    });

    row.set_tooltip_markup(tooltip);
    prefsGroup.add(row);

    row.connect('notify::selected', () => {
        settings.set_int('pause-on-maximize-or-fullscreen', row.selected);
    });
}

export function prefsRowPauseOnBattery(window, prefsGroup) {
    const settings = window._settings;
    const title = _('Pause on Battery');
    const subtitle = _('Pause playback when the device is on battery or the battery is low');
    const tooltip = _(`
    <b>Never</b>: Disable this feature.
    <b>Low Battery</b>: Pause playback when the device is on low battery (below the threshold).
    <b>Always</b>: Pause playback when the device is on battery.
    `);

    const items = Gtk.StringList.new([
        _('Never'),
        _('Low Battery'),
        _('Always'),
    ]);

    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: items,
        selected: settings.get_int('pause-on-battery'),
    });

    row.set_tooltip_markup(tooltip);
    prefsGroup.add(row);

    row.connect('notify::selected', () => {
        settings.set_int('pause-on-battery', row.selected);
    });
}

export function prefsRowChangeWallpaperMode(window, prefsGroup) {
    const settings = window._settings;
    const title = _('Change Wallpaper Mode');
    const subtitle = _('Control how to change wallpapers automatically');
    const tooltip = _(`
    <b>Sequential:</b> Preserve the directory sequence (descending order).
    <b>Inverse Sequential:</b> Retrieve wallpapers in the opposite sequence (ascending order).
    <b>Random:</b> Randomly select wallpapers from the directory.
    `);

    const items = Gtk.StringList.new([
        _('Sequential'),
        _('Inverse Sequential'),
        _('Random'),
    ]);

    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: items,
        selected: settings.get_int('change-wallpaper-mode'),
    });
    row.set_tooltip_markup(tooltip);
    prefsGroup.add(row);

    row.connect('notify::selected', () => {
        settings.set_int('change-wallpaper-mode', row.selected);
    });
}
