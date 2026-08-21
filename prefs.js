import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODES = [
    ['touch', 'On Touch', 'Open the OSK only on touch/tap events over a text field.'],
    ['click', 'On Click or Touch', 'Open on any pointer button-press or touch event over a text field.'],
    ['always', 'Always When Focused', 'Open whenever any text field has input-method focus (polling-based).'],
];

export default class NativeOSKAutoShowWrapPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const modeGroup = new Adw.PreferencesGroup({
            title: 'Open Mode',
            description: 'When the on-screen keyboard should appear.',
        });
        page.add(modeGroup);

        const rows = [];
        for (const [value, title, subtitle] of MODES) {
            const row = new Adw.ActionRow({title, subtitle});
            row.value = value;
            modeGroup.add(row);
            rows.push(row);
        }

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const radio = new Gtk.CheckButton({
                group: i === 0 ? null : rows[i - 1]._radio,
                valign: Gtk.Align.CENTER,
            });
            row._radio = radio;
            row.add_prefix(radio);
            row.activatable_widget = radio;

            radio.connect('toggled', () => {
                if (radio.get_active())
                    settings.set_string('open-mode', row.value);
            });

            if (settings.get_string('open-mode') === row.value)
                radio.set_active(true);
        }

        const togglesGroup = new Adw.PreferencesGroup({
            title: 'Toggles',
        });
        page.add(togglesGroup);

        const pollRow = new Adw.SwitchRow({
            title: 'Poll Input Focus',
            subtitle: 'In "Always" mode: open/close on IM focus. In "Click" or "Touch" mode: only closes keyboard on focus loss (open handled by click/touch events).',
        });
        settings.bind('enable-poll', pollRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        togglesGroup.add(pollRow);

        const touchRow = new Adw.SwitchRow({
            title: 'Force Touch Mode',
            subtitle: 'Force KeyboardManager._lastDeviceIsTouchscreen() to return true so the OSK is enabled on any session.',
        });
        settings.bind('force-touch-mode', touchRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        togglesGroup.add(touchRow);

        const pwdRow = new Adw.SwitchRow({
            title: 'Ignore Password Fields',
            subtitle: 'Do not open the OSK on input-purpose PASSWORD fields.',
        });
        settings.bind('ignore-password-fields', pwdRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        togglesGroup.add(pwdRow);

        const thresholdRow = new Adw.SpinRow({
            title: 'Click Threshold (ms)',
            subtitle: 'Max delay between a click and text-field focus in "On Click or Touch" mode. XWayland apps can take 1-2s to report focus.',
            adjustment: new Gtk.Adjustment({
                lower: 1000,
                upper: 8000,
                step_increment: 100,
                page_increment: 500,
            }),
        });
        settings.bind('click-threshold-ms', thresholdRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        togglesGroup.add(thresholdRow);
    }
}