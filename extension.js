import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const POINTER_PRESS_TYPES = new Set([
    Clutter.EventType.BUTTON_PRESS,
]);
const PASSWORD_PURPOSE = Clutter.InputContentPurpose.PASSWORD;
const FOCUS_LOSS_GRACE_MS = 500;

export default class OskFixExtension extends Extension {
    enable() {
        this._pollId = 0;
        this._oldMaybeHandleEvent = null;
        this._originalLastDeviceIsTouchscreen = null;
        this._userHidden = false;
        this._visibilitySignalId = 0;
        this._hideButtonPressed = false;
        this._lastFocusLossTime = 0;

        this._lastPointerPressTime = 0;
        this._prevVisible = false;
        this._prevKeyFocusActor = null;
        this._prevInputFocus = null;
        this._focusLossTimerId = 0;

        // Guard: Main.keyboard must exist
        if (!Main.keyboard) {
            console.error('[osk-fix] Main.keyboard not available, aborting');
            return;
        }

        this._a11y = new Gio.Settings({ schema_id: 'org.gnome.desktop.a11y.applications' });
        this._originalOskEnabled = this._a11y.get_boolean('screen-keyboard-enabled');

        if (!this._originalOskEnabled) {
            this._a11y.set_boolean('screen-keyboard-enabled', true);
            this._didOverrideOsk = true;
        }

        // Instance patching (not prototype) - more compatible
        this._originalLastDeviceIsTouchscreen = Main.keyboard._lastDeviceIsTouchscreen;
        Main.keyboard._lastDeviceIsTouchscreen = () => true;

        // Track hide button press via visibility signal
        this._visibilitySignalId = Main.keyboard.connect('visibility-changed', () => {
            if (!Main.keyboard.visible && this._hideButtonPressed) {
                this._userHidden = true;
                this._hideButtonPressed = false;
            }
        });

        // Single event handler for pointer presses
        this._capturedEventHandlerId = global.stage.connect(
            'captured-event',
            (actor, event) => this._onCapturedEvent(actor, event)
        );

        // Key focus change - reset userHidden on new text field focus
        try {
            this._keyFocusHandlerId = global.stage.connect('notify::key-focus', () => {
                const focusActor = global.stage.key_focus;
                if (focusActor && this._actorIsText(focusActor) && !this._prevKeyFocusActor) {
                    this._lastPointerPressTime = Date.now();
                    this._userHidden = false;
                }
                this._prevKeyFocusActor = focusActor;
            });
        } catch (e) {
            console.error('[osk-fix] Failed to connect key-focus signal:', e);
        }

        // Safe method wrapping - preserves existing wrappers
        if (typeof Main.keyboard.maybeHandleEvent === 'function') {
            this._oldMaybeHandleEvent = Main.keyboard.maybeHandleEvent;
            Main.keyboard.maybeHandleEvent = (event) => this._maybeHandleEvent(event);
        }

        // Input method focus change signal (preferred over polling)
        if (Main.inputMethod) {
            this._inputMethodSignalId = Main.inputMethod.connect('notify::current-focus', () => {
                this._onInputMethodFocusChange();
            });
        }

        // Fallback polling loop for cases where signals don't fire
        this._pollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 300, () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            });
        GLib.Source.set_name_by_id(this._pollId, '[osk-fix] poll');
    }

    _onCapturedEvent(actor, event) {
        if (!POINTER_PRESS_TYPES.has(event.type())) return;

        this._lastPointerPressTime = Date.now();

        const keyboardActor = Main.keyboard?._keyboard;
        if (keyboardActor && (actor === keyboardActor || this._isDescendant(actor, keyboardActor))) {
            this._hideButtonPressed = true;
            return;
        }

        if (this._actorIsText(actor)) {
            this._userHidden = false;
            this._hideButtonPressed = false;
        }
    }

    _maybeHandleEvent(event) {
        const handled = this._oldMaybeHandleEvent.call(Main.keyboard, event);
        if (handled) return true;

        if (!Main.keyboard || !Main.keyboard._keyboard) return false;

        const actor = global.stage.get_event_actor(event);
        if (!actor || !this._actorIsText(actor)) return false;

        if (event.type() !== Clutter.EventType.BUTTON_PRESS) return false;

        if (this._isPasswordFocused()) return false;

        if (!Main.keyboard.visible && !this._userHidden) {
            Main.keyboard.open(Main.layoutManager.focusIndex);
        }

        return false;
    }

    _onInputMethodFocusChange() {
        // Signal-based focus detection - more responsive than polling
        if (!Main.keyboard || !Main.keyboard._keyboard) return;

        const focus = Main.inputMethod?.currentFocus;
        let hasFocus = false;
        if (focus) {
            try {
                hasFocus = !!focus.is_focused();
            } catch (e) {
                hasFocus = !!focus;
            }
        }

        const visible = Main.keyboard.visible;
        const requested = !!(Main.keyboard._keyboard && Main.keyboard._keyboard._keyboardRequested);

        if (hasFocus && !visible && !requested && !this._userHidden && !this._hideButtonPressed) {
            if (this._isPasswordFocused()) return;
            Main.keyboard.open(Main.layoutManager.focusIndex);
        } else if (!hasFocus && visible) {
            // Schedule delayed close for grace period
            this._scheduleFocusLossClose();
        }
    }

    _scheduleFocusLossClose() {
        if (this._focusLossTimerId) return; // Already scheduled

        this._focusLossTimerId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, FOCUS_LOSS_GRACE_MS, () => {
            this._focusLossTimerId = 0;
            if (Main.keyboard && Main.keyboard.visible) {
                const focus = Main.inputMethod?.currentFocus;
                let hasFocus = false;
                if (focus) {
                    try {
                        hasFocus = !!focus.is_focused();
                    } catch (e) {
                        hasFocus = !!focus;
                    }
                }
                if (!hasFocus) {
                    Main.keyboard.close();
                }
            }
        });
    }

    _poll() {
        if (!Main.keyboard) return;

        const focus = Main.inputMethod?.currentFocus;
        let hasFocus = false;
        if (focus) {
            try {
                hasFocus = !!focus.is_focused();
            } catch (e) {
                hasFocus = !!focus;
            }
        }

        const kbd = Main.keyboard._keyboard;
        const actorExists = !!kbd;
        const visible = Main.keyboard.visible;
        if (visible && !this._prevVisible) {
            this._lastPointerPressTime = 0;
        }
        this._prevVisible = visible;
        const requested = !!(kbd && kbd._keyboardRequested);

        const focusChanged = this._prevInputFocus !== null && this._prevInputFocus !== focus;
        if (focusChanged) {
            this._prevInputFocus = null;
        }

        if (hasFocus && actorExists) {
            const isNewFocus = !this._prevInputFocus;
            if (isNewFocus) {
                this._prevInputFocus = focus;
            }

            const recentClick = this._lastPointerPressTime > 0 && (Date.now() - this._lastPointerPressTime) < 500;

            if (!visible && !requested && (isNewFocus || recentClick) && !this._userHidden && !this._hideButtonPressed) {
                if (this._isPasswordFocused()) return;
                Main.keyboard.open(Main.layoutManager.focusIndex);
            }
        } else if (!hasFocus && visible) {
            this._scheduleFocusLossClose();
            this._prevInputFocus = focus;
        }
    }

    disable() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }

        if (this._focusLossTimerId) {
            GLib.source_remove(this._focusLossTimerId);
            this._focusLossTimerId = 0;
        }

        if (this._keyFocusHandlerId) {
            try {
                global.stage.disconnect(this._keyFocusHandlerId);
            } catch (e) {
                console.error('[osk-fix] Failed to disconnect key-focus signal:', e);
            }
            this._keyFocusHandlerId = 0;
        }

        if (this._capturedEventHandlerId) {
            global.stage.disconnect(this._capturedEventHandlerId);
            this._capturedEventHandlerId = 0;
        }

        if (this._inputMethodSignalId && Main.inputMethod) {
            Main.inputMethod.disconnect(this._inputMethodSignalId);
            this._inputMethodSignalId = 0;
        }

        if (this._visibilitySignalId && Main.keyboard) {
            Main.keyboard.disconnect(this._visibilitySignalId);
            this._visibilitySignalId = 0;
        }

        if (this._oldMaybeHandleEvent) {
            Main.keyboard.maybeHandleEvent = this._oldMaybeHandleEvent;
            this._oldMaybeHandleEvent = null;
        }

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

    _isDescendant(actor, ancestor) {
        let cur = actor;
        while (cur) {
            if (cur === ancestor) return true;
            cur = cur.get_parent ? cur.get_parent() : null;
        }
        return false;
    }

    /**
     * Checks if actor or its ancestors represent an editable text field.
     * Checks Clutter.Text, St.Entry, St.TextArea, and input-method-focusable actors.
     */
    _actorIsText(actor) {
        let cur = actor;
        while (cur) {
            if (cur instanceof Clutter.Text) return true;
            // GTK Wayland surfaces often have inputMethodHints
            if (cur.inputMethodHints !== undefined) return true;
            cur = cur.get_parent ? cur.get_parent() : null;
        }
        return false;
    }

    _isPasswordFocused() {
        try {
            return Main.inputMethod?.content_purpose === PASSWORD_PURPOSE;
        } catch (e) {
            console.error('[osk-fix] Error checking password purpose:', e);
            return false;
        }
    }
}