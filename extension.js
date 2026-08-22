import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const POINTER_PRESS_TYPES = new Set([
    Clutter.EventType.BUTTON_PRESS,
]);

export default class OskFixExtension extends Extension {
    enable() {
        this._pollId = 0;
        this._oldMaybeHandleEvent = null;
        this._maybeHandleEventWrapper = null;
        this._originalLastDeviceIsTouchscreen = null;
        this._userHidden = false;
        this._visibilitySignalId = 0;
        this._hideButtonPressed = false;

        this._lastPointerPressTime = 0;
        this._prevVisible = false;
        this._prevKeyFocusActor = null;
        this._prevInputFocus = null;
        this._capturedEventHandlerId = 0;
        this._buttonPressHandlerId = 0;
        this._keyFocusHandlerId = 0;
        this._didOverrideOsk = false;
        this._originalOpen = null;
        this._openWrapper = null;

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
                if (!Main.keyboard.visible) {
                    if (this._hideButtonPressed) {
                        this._userHidden = true;
                        this._hideButtonPressed = false;
                    }
                }
            });

            if (typeof Main.keyboard.maybeHandleEvent === 'function') {
                this._oldMaybeHandleEvent = Main.keyboard.maybeHandleEvent;
                this._maybeHandleEventWrapper = (event) => this._maybeHandleEvent(event);
                Main.keyboard.maybeHandleEvent = this._maybeHandleEventWrapper;
            }

            // Gate ALL open() paths. GNOME's internal reopen calls (input
            // panel state changes when the client re-commits text-input,
            // key-focus idle show) ignore our hidden state entirely -
            // without this, the OSK reopens instantly after hide.
            this._originalOpen = Main.keyboard.open;
            const ext = this;
            this._openWrapper = function (...args) {
                if (ext._userHidden || ext._hideButtonPressed) return;
                return ext._originalOpen.apply(this, args);
            };
            Main.keyboard.open = this._openWrapper;
        } else {
            console.error('[osk-fix] Main.keyboard not available at enable');
        }

        this._capturedEventHandlerId = global.stage.connect(
            'captured-event',
            (actor, event) => this._onCapturedEvent(actor, event)
        );
        this._buttonPressHandlerId = global.stage.connect(
            'button-press-event',
            (actor, event) => this._onCapturedEvent(actor, event)
        );

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

        this._pollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 300, () => {
                this._safePoll();
                return GLib.SOURCE_CONTINUE;
            }
        );
        GLib.Source.set_name_by_id(this._pollId, '[osk-fix] poll');
    }

    _onCapturedEvent(actor, event) {
        try {
            if (!POINTER_PRESS_TYPES.has(event.type())) return;

            const keyboardActor = Main.keyboard?._keyboard;
            
            // Handle OSK clicks first to prevent updating _lastPointerPressTime
            if (keyboardActor && this._isInsideKeyboard(actor, keyboardActor)) {
                if (this._isHideButton(actor)) {
                    this._hideButtonPressed = true;
                    this._userHidden = true; // Set userHidden instantly on click
                }
                return; // Exit early so keyboard clicks don't count as text field taps
            }

            // Only record click time when tapping OUTSIDE the keyboard
            this._lastPointerPressTime = Date.now();

            // Any press outside the OSK lifts the hidden state. Gating on
            // _actorIsText() left it unliftable in Wayland apps, whose
            // window actors have no Clutter.Text ancestor.
            this._userHidden = false;
            this._hideButtonPressed = false;
        } catch (e) {
            console.error('[osk-fix] Error in captured event handler:', e);
        }
    }

    _isInsideKeyboard(actor, keyboardActor) {
        return actor === keyboardActor || this._isDescendant(actor, keyboardActor);
    }

    _isHideButton(actor) {
        let cur = actor;
        while (cur) {
            const styleClass = cur.style_class || (typeof cur.get_style_class_name === 'function' ? cur.get_style_class_name() : '');
            if (typeof styleClass === 'string' && (styleClass.includes('hide-key') || styleClass.includes('hide'))) {
                return true;
            }

            const iconName = cur.icon_name || cur.child?.icon_name;
            if (['osk-hide-symbolic', 'go-down-symbolic', 'keyboard-hide-symbolic', 'input-keyboard-symbolic'].includes(iconName)) {
                return true;
            }

            if (cur._key?.name === 'hide' || cur._key?.action === 'hide') {
                return true;
            }

            cur = cur.get_parent ? cur.get_parent() : null;
        }
        return false;
    }

    _maybeHandleEvent(event) {
        try {
            const handled = this._oldMaybeHandleEvent ? this._oldMaybeHandleEvent.call(Main.keyboard, event) : false;
            if (handled) return true;

            if (!Main.keyboard || !Main.keyboard._keyboard) return false;

            const actor = global.stage.get_event_actor(event);
            if (!actor || !this._actorIsText(actor)) return false;

            if (event.type() !== Clutter.EventType.BUTTON_PRESS) return false;

            if (!Main.keyboard.visible && !this._userHidden) {
                Main.keyboard.open(Main.layoutManager.focusIndex);
            }
        } catch (e) {
            console.error('[osk-fix] Error in _maybeHandleEvent:', e);
        }

        return false;
    }

    _safePoll() {
        try {
            this._poll();
        } catch (e) {
            console.error('[osk-fix] Exception during poll cycle:', e);
        }
    }

    _poll() {
        if (!Main.keyboard) return;

        const focus = Main.inputMethod?.currentFocus;
        let hasFocus = false;
        if (focus) {
            try {
                hasFocus = !!focus.is_focused();
            } catch (e) {
                console.error('[osk-fix] Error checking focus state:', e);
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
            this._userHidden = false; // Reset hidden state when focus moves to a NEW input field
        }

        if (hasFocus && actorExists) {
            const isNewFocus = !this._prevInputFocus;
            if (isNewFocus) {
                this._prevInputFocus = focus;
            }

            const recentClick = this._lastPointerPressTime > 0 && (Date.now() - this._lastPointerPressTime) < 500;

            if (!visible && !requested && (isNewFocus || recentClick) && !this._userHidden && !this._hideButtonPressed) {
                Main.keyboard.open(Main.layoutManager.focusIndex);
            }
        } else if (!hasFocus && visible) {
            Main.keyboard.close();
            this._prevInputFocus = focus;
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
            } catch (e) {
                console.error('[osk-fix] Failed to disconnect key-focus signal:', e);
            }
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

        if (this._originalOpen && Main.keyboard &&
            Main.keyboard.open === this._openWrapper) {
            Main.keyboard.open = this._originalOpen;
        }
        this._originalOpen = null;
        this._openWrapper = null;

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

    _actorIsText(actor) {
        let cur = actor;
        while (cur) {
            if (cur instanceof Clutter.Text) return true;
            cur = cur.get_parent ? cur.get_parent() : null;
        }
        return false;
    }

}
