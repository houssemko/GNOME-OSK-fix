import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { KeyboardManager } from 'resource:///org/gnome/shell/ui/keyboard.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const POLL_INTERVAL_MS = 300;
const TOUCH_EVENT_TYPES = new Set([
    Clutter.EventType.TOUCH_BEGIN,
    Clutter.EventType.TOUCH_UPDATE,
    Clutter.EventType.TOUCH_END,
]);
const POINTER_PRESS_TYPES = new Set([
    Clutter.EventType.BUTTON_PRESS,
    Clutter.EventType.TOUCH_BEGIN,
]);
const PASSWORD_PURPOSE = Clutter.InputContentPurpose.PASSWORD;

export default class NativeOSKAutoShowWrap extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._pollId = 0;
        this._oldMaybeHandleEvent = null;
        this._originalLastDeviceIsTouchscreen = null;
        this._settingsChangedId = 0;

        this._lastPointerPressTime = 0;
        this._prevVisible = false;
        this._prevKeyFocusActor = null;
        this._prevInputFocus = null;
        this._capturedEventHandlerId = 0;
        this._buttonPressHandlerId = 0;
        this._keyFocusHandlerId = 0;

        this._a11y = new Gio.Settings({
            schema_id: 'org.gnome.desktop.a11y.applications',
        });
        this._oldEnabled = this._a11y.get_boolean('screen-keyboard-enabled');
        this._a11y.set_boolean('screen-keyboard-enabled', true);

        console.debug(`[native-osk-autoshow-wrap] enabled: open-mode=${this._settings.get_string('open-mode')} force-touch-mode=${this._settings.get_boolean('force-touch-mode')}`);

        if (this._settings.get_boolean('force-touch-mode')) {
            this._originalLastDeviceIsTouchscreen =
                KeyboardManager.prototype._lastDeviceIsTouchscreen;
            KeyboardManager.prototype._lastDeviceIsTouchscreen =
                () => true;
        }

        // React live to force-touch-mode being toggled in prefs without
        // requiring the extension to be disabled/re-enabled.
        this._settingsChangedId = this._settings.connect('changed::force-touch-mode', () => {
            if (this._settings.get_boolean('force-touch-mode')) {
                if (!this._originalLastDeviceIsTouchscreen) {
                    this._originalLastDeviceIsTouchscreen =
                        KeyboardManager.prototype._lastDeviceIsTouchscreen;
                    KeyboardManager.prototype._lastDeviceIsTouchscreen = () => true;
                }
            } else if (this._originalLastDeviceIsTouchscreen) {
                KeyboardManager.prototype._lastDeviceIsTouchscreen =
                    this._originalLastDeviceIsTouchscreen;
                this._originalLastDeviceIsTouchscreen = null;
            }
        });

        // Listen for both "captured-event" (X11) and "button-press-event" (Wayland)
        this._capturedEventHandlerId = global.stage.connect(
            'captured-event',
            (actor, event) => this._onCapturedEvent(actor, event)
        );
        // Wayland does not emit captured-event for mouse clicks, so also hook the raw button-press signal
        this._buttonPressHandlerId = global.stage.connect(
            'button-press-event',
            (actor, event) => this._onCapturedEvent(actor, event)
        );

        try {
            this._keyFocusHandlerId = global.stage.connect('notify::key-focus',
                () => {
                    const focusActor = global.stage.key_focus;
                    if (focusActor && this._actorIsText(focusActor) && !this._prevKeyFocusActor) {
                        this._lastPointerPressTime = Date.now();
                    }
                    this._prevKeyFocusActor = focusActor;
                });
        } catch (e) {
        }

        this._oldMaybeHandleEvent = Main.keyboard.maybeHandleEvent;
        Main.keyboard.maybeHandleEvent = (event) => {
            const handled = this._oldMaybeHandleEvent.call(Main.keyboard, event);
            if (handled)
                return true;

            if (!Main.keyboard || !Main.keyboard._keyboard)
                return false;

            const actor = global.stage.get_event_actor(event);
            if (!actor || !this._actorIsText(actor))
                return false;

            const mode = this._settings.get_string('open-mode');
            const evType = event.type();

            let shouldOpen = false;
            if (mode === 'always') {
                shouldOpen = true;
            } else if (mode === 'click') {
                shouldOpen = evType === Clutter.EventType.BUTTON_PRESS ||
                             TOUCH_EVENT_TYPES.has(evType);
            } else {
                shouldOpen = TOUCH_EVENT_TYPES.has(evType);
            }

            if (!shouldOpen)
                return false;

            if (this._settings.get_boolean('ignore-password-fields') &&
                this._isPasswordFocused())
                return false;

            if (!Main.keyboard.visible)
                Main.keyboard.open(Main.layoutManager.focusIndex);

            return false;
        };

        if (this._settings.get_boolean('enable-poll')) {
            this._pollId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
                    this._poll();
                    return GLib.SOURCE_CONTINUE;
                });
            GLib.Source.set_name_by_id(this._pollId,
                '[native-osk-autoshow-wrap] poll');
        }
    }

    _onCapturedEvent(actor, event) {
        if (POINTER_PRESS_TYPES.has(event.type())) {
            this._lastPointerPressTime = Date.now();
        }
    }

    disable() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }

        if (this._keyFocusHandlerId) {
            try {
                global.stage.disconnect(this._keyFocusHandlerId);
            } catch (e) {}
            this._keyFocusHandlerId = 0;
        }

        if (this._capturedEventHandlerId) {
            global.stage.disconnect(this._capturedEventHandlerId);
            this._capturedEventHandlerId = 0;
        }
        if (this._buttonPressHandlerId) {
            global.stage.disconnect(this._buttonPressHandlerId);
            this._buttonPressHandlerId = 0;
        }

        if (this._oldMaybeHandleEvent) {
            Main.keyboard.maybeHandleEvent = this._oldMaybeHandleEvent;
            this._oldMaybeHandleEvent = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._originalLastDeviceIsTouchscreen) {
            KeyboardManager.prototype._lastDeviceIsTouchscreen =
                this._originalLastDeviceIsTouchscreen;
            this._originalLastDeviceIsTouchscreen = null;
        }

        if (this._a11y) {
            this._a11y.set_boolean('screen-keyboard-enabled', this._oldEnabled);
            this._a11y = null;
        }

        if (Main.keyboard && Main.keyboard.visible)
            Main.keyboard.close();

        this._settings = null;
    }

    _poll() {
        if (!Main.keyboard)
            return;

        const focus = Main.inputMethod?.currentFocus;
        let focused = false;
        if (focus) {
            try {
                focused = !!focus.is_focused();
            } catch (e) {
                focused = !!focus;
            }
        }
        const hasFocus = !!focused;
        const kbd = Main.keyboard._keyboard;
        const actorExists = !!kbd;
        const visible = Main.keyboard.visible;
        if (visible && !this._prevVisible)
            this._lastPointerPressTime = 0;
        this._prevVisible = visible;
        const requested = !!(kbd && kbd._keyboardRequested);

        if (this._prevInputFocus !== null && this._prevInputFocus !== focus) {
            this._prevInputFocus = null;
        }

        if (hasFocus && actorExists) {
            if (!this._prevInputFocus)
                this._prevInputFocus = focus;

            const mode = this._settings.get_string('open-mode');
            const now = Date.now();
            if (mode === 'always' && !visible && !requested) {
                if (this._settings.get_boolean('ignore-password-fields') &&
                    this._isPasswordFocused())
                    return;
                Main.keyboard.open(Main.layoutManager.focusIndex);
            } else if (mode === 'click' && !visible && !requested) {
                const threshold = this._settings.get_int('click-threshold-ms');
                const recentClick = now - this._lastPointerPressTime < threshold;
                if (recentClick) {
                    if (this._settings.get_boolean('ignore-password-fields') &&
                        this._isPasswordFocused())
                        return;
                    Main.keyboard.open(Main.layoutManager.focusIndex);
                }
            }
        } else if (!hasFocus && visible) {
            Main.keyboard.close();
            this._prevInputFocus = focus;
        }
    }

    _actorIsText(actor) {
        let cur = actor;
        while (cur) {
            if (cur instanceof Clutter.Text)
                return true;
            cur = cur.get_parent ? cur.get_parent() : null;
        }
        return false;
    }

    _isPasswordFocused() {
        try {
            return Main.inputMethod?.content_purpose === PASSWORD_PURPOSE;
        } catch {
            return false;
        }
    }
}
