import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Keyboard } from 'resource:///org/gnome/shell/ui/keyboard.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const POINTER_PRESS_TYPES = new Set([
    Clutter.EventType.BUTTON_PRESS,
]);
const DEBUG = true;

export default class OskFixExtension extends Extension {
    enable() {
        this._pollId = 0;
        this._oldMaybeHandleEvent = null;
        this._maybeHandleEventWrapper = null;
        this._originalLastDeviceIsTouchscreen = null;
        this._hiddenByUser = false;
        this._hiddenAt = 0;
        this._hiddenForFocus = null;
        this._weClosedIt = false;
        this._visibilitySignalId = 0;

        this._lastPointerPressTime = 0;
        this._prevVisible = false;
        this._prevInputFocus = null;
        this._capturedEventHandlerId = 0;
        this._buttonPressHandlerId = 0;
        this._didOverrideOsk = false;
        this._originalOpen = null;
        this._openWrapper = null;
        this._originalWidgetOpen = null;
        this._widgetOpenWrapper = null;

        this._a11y = new Gio.Settings({ schema_id: 'org.gnome.desktop.a11y.applications' });
        this._originalOskEnabled = this._a11y.get_boolean('screen-keyboard-enabled');

        if (!this._originalOskEnabled) {
            this._a11y.set_boolean('screen-keyboard-enabled', true);
            this._didOverrideOsk = true;
        }

        if (Main.keyboard) {
            this._originalLastDeviceIsTouchscreen = Main.keyboard._lastDeviceIsTouchscreen;
            Main.keyboard._lastDeviceIsTouchscreen = () => true;

            // Actor-independent hide detection: if the OSK hides while an
            // editable still holds input focus, and it wasn't our own
            // poll-driven close, the user dismissed it (hide key, Esc,
            // swipe-down, etc). GNOME 50 delivers OSK key presses with
            // Meta_Stage as the event actor, so actor-tree identification
            // of the hide key is impossible.
            this._visibilitySignalId = Main.keyboard.connect(
                'visibility-changed', () => this._onVisibilityChanged());

            if (typeof Main.keyboard.maybeHandleEvent === 'function') {
                this._oldMaybeHandleEvent = Main.keyboard.maybeHandleEvent;
                this._maybeHandleEventWrapper = (event) => this._maybeHandleEvent(event);
                Main.keyboard.maybeHandleEvent = this._maybeHandleEventWrapper;
            }

            // Gate ALL open() paths. GNOME's internal reopen calls ignore
            // our hidden state entirely - without this, the OSK reopens
            // instantly after hide.
            this._originalOpen = Main.keyboard.open;
            const ext = this;
            this._openWrapper = function (...args) {
                if (ext._isHidden()) return;
                return ext._originalOpen.apply(this, args);
            };
            Main.keyboard.open = this._openWrapper;

            // The Keyboard WIDGET also has its own open(), used by all of
            // GNOME's internal reopen paths (_onKeyFocusChanged idle show,
            // _onKeyboardStateChanged panel-state ON). Those bypass the
            // manager entirely. Prototype patch survives widget recreation.
            this._originalWidgetOpen = Keyboard.prototype.open;
            this._widgetOpenWrapper = function (...args) {
                if (ext._isHidden()) return;
                return ext._originalWidgetOpen.apply(this, args);
            };
            Keyboard.prototype.open = this._widgetOpenWrapper;
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

        this._pollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 300, () => {
                this._safePoll();
                return GLib.SOURCE_CONTINUE;
            }
        );
        GLib.Source.set_name_by_id(this._pollId, '[osk-fix] poll');
    }

    _onVisibilityChanged() {
        if (!Main.keyboard.visible && !this._weClosedIt) {
            const focus = Main.inputMethod?.currentFocus;
            const stillFocused = focus
                ? (typeof focus.is_focused === 'function' ? !!focus.is_focused() : true)
                : false;
            if (stillFocused) {
                this._hiddenByUser = true;
                this._hiddenAt = Date.now();
                this._hiddenForFocus = Main.inputMethod?.currentFocus ?? null;
                if (DEBUG) console.error('[osk-fix] hidden by user (visibility)');
            }
        }
        this._weClosedIt = false;
    }

    _isHidden() {
        return this._hiddenByUser;
    }

    _onCapturedEvent(actor, event) {
        try {
            if (!POINTER_PRESS_TYPES.has(event.type())) return;

            // Actor-hierarchy checks fail on GNOME 50.4 (pressed OSK keys
            // arrive with Meta_Stage as the event actor), so decide "is this
            // press on the OSK?" using stage coordinates instead.
            const [x, y] = event.get_coords();
            const kbd = Main.keyboard?._keyboard;
            let pressOnOsk = false;
            if (kbd && kbd.visible) {
                const [sx, sy] = kbd.get_transformed_position();
                const [w, h] = kbd.get_transformed_size();
                pressOnOsk = x >= sx && x <= sx + w && y >= sy && y <= sy + h;
            }

            if (DEBUG) console.error(`[osk-fix] press @${x},${y} onOsk=${pressOnOsk} kbdVisible=${kbd ? !!kbd.visible : 'n/a'}`);

            if (pressOnOsk) {
                // OSK clicks never count as text-field taps
                return;
            }

            // Press outside the OSK: record click time and clear the
            // user-hidden state - this is the "reappear when I press"
            // signal.
            this._lastPointerPressTime = Date.now();
            this._hiddenByUser = false;
        } catch (e) {
            console.error('[osk-fix] Error in captured event handler:', e);
        }
    }

    _maybeHandleEvent(event) {
        try {
            const handled = this._oldMaybeHandleEvent ? this._oldMaybeHandleEvent.call(Main.keyboard, event) : false;
            if (handled) return true;

            if (!Main.keyboard || !Main.keyboard._keyboard) return false;

            const actor = global.stage.get_event_actor(event);
            if (!actor || !this._actorIsText(actor)) return false;

            if (event.type() !== Clutter.EventType.BUTTON_PRESS) return false;

            if (!Main.keyboard.visible && !this._isHidden()) {
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

        if (focus !== this._prevInputFocus) {
            this._prevInputFocus = focus;
        }

        if (hasFocus && actorExists) {
            // Wayland clients' pointer events never reach the Shell stage,
            // so click-correlation is unobservable for apps like Vivaldi.
            // The only reliable open signal for them is the IM focus commit
            // itself (a new editable gained focus).
            const newEditable = this._prevInputFocus !== focus;

            if (DEBUG && hasFocus && !visible) {
                console.error(`[osk-fix] poll: newEd=${newEditable} ` +
                    `hidden=${this._hiddenByUser} req=${requested}`);
            }

            if (!visible && !requested && newEditable && !this._hiddenByUser) {
                if (DEBUG) console.error('[osk-fix] OPEN called');
                Main.keyboard.open(Main.layoutManager.focusIndex);
            }
        } else if (!hasFocus && visible) {
            // Our own poll-driven close - tell the visibility handler so it
            // is not misread as a user dismissal.
            this._weClosedIt = true;
            Main.keyboard.close();
            this._prevInputFocus = focus;
        }
    }

    disable() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
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

        if (this._originalWidgetOpen &&
            Keyboard.prototype.open === this._widgetOpenWrapper) {
            Keyboard.prototype.open = this._originalWidgetOpen;
        }
        this._originalWidgetOpen = null;
        this._widgetOpenWrapper = null;

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

    _actorIsText(actor) {
        let cur = actor;
        while (cur) {
            if (cur instanceof Clutter.Text) return true;
            cur = cur.get_parent ? cur.get_parent() : null;
        }
        return false;
    }
}