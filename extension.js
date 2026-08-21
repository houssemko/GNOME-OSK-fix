import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const POINTER_PRESS_TYPES = new Set([
    Clutter.EventType.BUTTON_PRESS,
    Clutter.EventType.TOUCH_BEGIN,
]);
const PASSWORD_PURPOSE = Clutter.InputContentPurpose.PASSWORD;
const IDLE_POLL_LIMIT = 10; // Stop polling after ~3s of inactivity

export default class OskFixExtension extends Extension {
    enable() {
        this._pollId = 0;
        this._idleTicks = 0;
        this._userHidden = false;
        this._hideButtonPressed = false;
        this._lastPointerPressTime = 0;
        this._prevInputFocus = null;
        this._prevVisible = false;

        this._oldMaybeHandleEvent = null;
        this._maybeHandleEventWrapper = null;
        this._originalLastDeviceIsTouchscreen = null;
        this._visibilitySignalId = 0;
        this._capturedEventHandlerId = 0;

        // Conditional a11y override - needed when no touchscreen means
        // touch_mode is false and the Keyboard object is never created.
        // Only set if disabled; always restored in disable().
        this._a11y = new Gio.Settings({ schema_id: 'org.gnome.desktop.a11y.applications' });
        this._originalOskEnabled = this._a11y.get_boolean('screen-keyboard-enabled');
        if (!this._originalOskEnabled) {
            this._a11y.set_boolean('screen-keyboard-enabled', true);
            this._didOverrideOsk = true;
        }

        if (Main.keyboard) {
            this._originalLastDeviceIsTouchscreen = Main.keyboard._lastDeviceIsTouchscreen;
            Main.keyboard._lastDeviceIsTouchscreen = () => true;

            this._visibilitySignalId = Main.keyboard.connect('visibility-changed', () => {
                if (!Main.keyboard.visible && this._hideButtonPressed) {
                    this._userHidden = true;
                    this._hideButtonPressed = false;
                }
            });

            if (typeof Main.keyboard.maybeHandleEvent === 'function') {
                this._oldMaybeHandleEvent = Main.keyboard.maybeHandleEvent;
                this._maybeHandleEventWrapper = (event) => this._maybeHandleEvent(event);
                Main.keyboard.maybeHandleEvent = this._maybeHandleEventWrapper;
            }
        }

        // Intercept stage pointer events to reactivate polling
        this._capturedEventHandlerId = global.stage.connect(
            'captured-event',
            (actor, event) => this._onCapturedEvent(actor, event)
        );

        this._startPolling();
    }

    _startPolling() {
        this._idleTicks = 0;
        if (this._pollId) return;

        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            return this._adaptivePoll();
        });
        GLib.Source.set_name_by_id(this._pollId, '[osk-fix] adaptive-poll');
    }

    _stopPolling() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    _onCapturedEvent(actor, event) {
        if (!POINTER_PRESS_TYPES.has(event.type())) return;

        this._lastPointerPressTime = Date.now();

        const keyboardActor = Main.keyboard?._keyboard;
        if (keyboardActor && this._isInsideKeyboard(actor, keyboardActor)) {
            if (this._isHideButton(actor)) {
                this._hideButtonPressed = true;
            }
            return;
        }

        // Any pointer press reactivates polling...
        this._startPolling();

        // ...but only a press on a text field clears the explicit-hide state
        if (this._actorIsText(actor)) {
            this._userHidden = false;
            this._hideButtonPressed = false;
        }
    }

    _adaptivePoll() {
        if (!Main.keyboard) {
            this._pollId = 0;
            return GLib.SOURCE_REMOVE;
        }

        const focus = Main.inputMethod?.currentFocus;
        let hasFocus = false;

        if (focus) {
            try {
                hasFocus = typeof focus.is_focused === 'function' ? !!focus.is_focused() : !!focus;
            } catch (e) {
                hasFocus = !!focus;
            }
        }

        const visible = Main.keyboard.visible;
        const requested = !!Main.keyboard._keyboard?._keyboardRequested;

        if (visible && !this._prevVisible) {
            this._lastPointerPressTime = 0;
        }
        this._prevVisible = visible;

        const focusChanged = this._prevInputFocus !== focus;
        if (focusChanged) {
            this._prevInputFocus = focus;
            this._idleTicks = 0;
        } else {
            this._idleTicks++;
        }

        if (hasFocus) {
            const recentClick = this._lastPointerPressTime > 0 && (Date.now() - this._lastPointerPressTime) < 600;

            if (!visible && !requested && (focusChanged || recentClick) && !this._userHidden && !this._hideButtonPressed) {
                if (!this._isPasswordFocused()) {
                    Main.keyboard.open(Main.layoutManager.focusIndex);
                }
            }
        } else if (!hasFocus && visible) {
            Main.keyboard.close();
        }

        // Adaptive cleanup: stop polling when idle and keyboard is closed
        if (this._idleTicks >= IDLE_POLL_LIMIT && !visible) {
            this._pollId = 0;
            return GLib.SOURCE_REMOVE;
        }

        return GLib.SOURCE_CONTINUE;
    }

    _isPasswordFocused() {
        const focus = Main.inputMethod?.currentFocus;
        if (!focus) return false;

        try {
            if (typeof focus.get_purpose === 'function') {
                return focus.get_purpose() === PASSWORD_PURPOSE;
            }
            if (focus.purpose !== undefined) {
                return focus.purpose === PASSWORD_PURPOSE;
            }
        } catch (e) {
            // fall through to inputMethod check
        }

        try {
            return Main.inputMethod?.content_purpose === PASSWORD_PURPOSE;
        } catch (e) {
            return false;
        }
    }

    _maybeHandleEvent(event) {
        const handled = this._oldMaybeHandleEvent?.call(Main.keyboard, event);
        if (handled) return true;

        if (!Main.keyboard) return false;

        // Text-field gate: don't open on clicks over arbitrary UI
        const actor = global.stage.get_event_actor(event);
        if (!actor || !this._actorIsText(actor)) return false;

        if (event.type() !== Clutter.EventType.BUTTON_PRESS &&
            event.type() !== Clutter.EventType.TOUCH_BEGIN) return false;

        if (this._isPasswordFocused()) return false;

        if (!Main.keyboard.visible && !this._userHidden) {
            Main.keyboard.open(Main.layoutManager.focusIndex);
        }

        return false;
    }

    _isInsideKeyboard(actor, keyboardActor) {
        let cur = actor;
        while (cur) {
            if (cur === keyboardActor) return true;
            cur = cur.get_parent ? cur.get_parent() : null;
        }
        return false;
    }

    _isHideButton(actor) {
        let cur = actor;
        while (cur) {
            const styleClass = cur.style_class;
            if ((typeof styleClass === 'string' && styleClass.includes('hide-key')) ||
                cur.icon_name === 'osk-hide-symbolic') {
                return true;
            }
            cur = cur.get_parent ? cur.get_parent() : null;
        }
        return false;
    }

    _actorIsText(actor) {
        let cur = actor;
        while (cur) {
            if (cur instanceof Clutter.Text) return true;
            cur = cur.get_parent ? cur.get_parent() : null;
        }
        return false;
    }

    disable() {
        this._stopPolling();

        if (this._capturedEventHandlerId) {
            global.stage.disconnect(this._capturedEventHandlerId);
            this._capturedEventHandlerId = 0;
        }

        if (this._visibilitySignalId && Main.keyboard) {
            Main.keyboard.disconnect(this._visibilitySignalId);
            this._visibilitySignalId = 0;
        }

        if (this._oldMaybeHandleEvent && Main.keyboard &&
            Main.keyboard.maybeHandleEvent === this._maybeHandleEventWrapper) {
            Main.keyboard.maybeHandleEvent = this._oldMaybeHandleEvent;
        }
        this._oldMaybeHandleEvent = null;
        this._maybeHandleEventWrapper = null;

        if (Main.keyboard && this._originalLastDeviceIsTouchscreen !== undefined) {
            Main.keyboard._lastDeviceIsTouchscreen = this._originalLastDeviceIsTouchscreen;
            this._originalLastDeviceIsTouchscreen = undefined;
        }

        if (this._didOverrideOsk && this._a11y) {
            this._a11y.set_boolean('screen-keyboard-enabled', this._originalOskEnabled);
            this._didOverrideOsk = false;
        }
        this._a11y = null;

        if (Main.keyboard && Main.keyboard.visible) {
            Main.keyboard.close();
        }
    }
}