import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Keyboard} from 'resource:///org/gnome/shell/ui/keyboard.js';
import {
    Extension,
    InjectionManager,
} from 'resource:///org/gnome/shell/extensions/extension.js';

const POINTER_PRESS_TYPES = new Set([
    Clutter.EventType.BUTTON_PRESS,
]);

export default class OskFixExtension extends Extension {
    enable() {
        this._pollId = 0;
        this._visibilitySignalId = 0;
        this._capturedEventHandlerId = 0;
        this._buttonPressHandlerId = 0;

        this._originalLastDeviceIsTouchscreen = null;
        this._lastDeviceIsTouchscreenOverride = null;

        this._userHidden = false;
        this._hideButtonPressed = false;
        this._lastPointerPressTime = 0;
        this._prevVisible = false;
        this._prevInputFocus = null;

        this._a11y = new Gio.Settings({
            schema_id: 'org.gnome.desktop.a11y.applications',
        });
        this._originalOskEnabled = this._a11y.get_boolean(
            'screen-keyboard-enabled'
        );
        this._didOverrideOsk = false;

        this._injectionManager = new InjectionManager();

        if (Main.keyboard) {
            this._installKeyboardOverrides();

            this._visibilitySignalId = Main.keyboard.connect(
                'visibility-changed',
                () => {
                    if (!Main.keyboard.visible && this._hideButtonPressed) {
                        this._userHidden = true;
                        this._hideButtonPressed = false;
                    }
                }
            );
        } else {
            console.error('[osk-fix] Main.keyboard not available at enable');
        }

        if (!this._originalOskEnabled) {
            this._a11y.set_boolean('screen-keyboard-enabled', true);
            this._didOverrideOsk = true;
        }

        this._capturedEventHandlerId = global.stage.connect(
            'captured-event',
            (actor, event) => this._onCapturedEvent(actor, event)
        );

        this._buttonPressHandlerId = global.stage.connect(
            'button-press-event',
            (actor, event) => this._onCapturedEvent(actor, event)
        );

        // Polling remains as a compatibility fallback for focus/state changes
        // that are not consistently exposed through public signals.
        this._pollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            300,
            () => {
                this._safePoll();
                return GLib.SOURCE_CONTINUE;
            }
        );

        GLib.Source.set_name_by_id(this._pollId, '[osk-fix] poll');
    }

    _installKeyboardOverrides() {
        const keyboard = Main.keyboard;
        if (!keyboard)
            return;

        // Force GNOME's keyboard manager to treat the current input device as
        // touchscreen input. This is a private Shell property and is restored
        // exactly when the extension is disabled.
        if (typeof keyboard._lastDeviceIsTouchscreen === 'function') {
            this._originalLastDeviceIsTouchscreen =
                keyboard._lastDeviceIsTouchscreen;

            this._lastDeviceIsTouchscreenOverride = () => true;
            keyboard._lastDeviceIsTouchscreen =
                this._lastDeviceIsTouchscreenOverride;
        }

        // Intercept maybeHandleEvent() through InjectionManager.
        if (typeof keyboard.maybeHandleEvent === 'function') {
            this._injectionManager.overrideMethod(
                keyboard,
                'maybeHandleEvent',
                originalMethod => {
                    return event => this._maybeHandleEvent(
                        event,
                        originalMethod
                    );
                }
            );
        }

        // Block internal manager-side reopen attempts after the user has
        // explicitly hidden the OSK.
        if (typeof keyboard.open === 'function') {
            const extension = this;

            this._injectionManager.overrideMethod(
                keyboard,
                'open',
                originalMethod => {
                    return function (...args) {
                        if (
                            extension._userHidden ||
                            extension._hideButtonPressed
                        ) {
                            return undefined;
                        }

                        return originalMethod.call(this, ...args);
                    };
                }
            );
        }

        // GNOME's Keyboard widget can be recreated independently of the
        // manager. Override its prototype so those reopen paths are covered too.
        if (typeof Keyboard?.prototype?.open === 'function') {
            const extension = this;

            this._injectionManager.overrideMethod(
                Keyboard.prototype,
                'open',
                originalMethod => {
                    return function (...args) {
                        if (
                            extension._userHidden ||
                            extension._hideButtonPressed
                        ) {
                            return undefined;
                        }

                        return originalMethod.call(this, ...args);
                    };
                }
            );
        }
    }

    _onCapturedEvent(actor, event) {
        try {
            if (!POINTER_PRESS_TYPES.has(event.type()))
                return;

            const [x, y] = event.get_coords();
            const kbd = Main.keyboard?._keyboard;
            let pressOnOsk = false;

            if (kbd && kbd.visible) {
                const [sx, sy] = kbd.get_transformed_position();
                const [w, h] = kbd.get_transformed_size();

                pressOnOsk =
                    x >= sx &&
                    x <= sx + w &&
                    y >= sy &&
                    y <= sy + h;
            }

            if (pressOnOsk) {
                const isHide = this._isHideButton(actor);

                if (isHide) {
                    this._hideButtonPressed = true;
                    this._userHidden = true;
                }

                // OSK clicks never count as text-field taps.
                return;
            }

            // Press outside the OSK: remember the click and allow the OSK to
            // be opened again for a new text-field interaction.
            this._lastPointerPressTime = Date.now();
            this._userHidden = false;
            this._hideButtonPressed = false;
        } catch (e) {
            console.error('[osk-fix] Error in captured event handler:', e);
        }
    }

    _isHideButton(actor) {
        let cur = actor;

        while (cur) {
            const styleClass =
                cur.style_class ||
                (typeof cur.get_style_class_name === 'function'
                    ? cur.get_style_class_name()
                    : '');

            if (
                typeof styleClass === 'string' &&
                (
                    styleClass.includes('hide-key') ||
                    styleClass.includes('hide')
                )
            ) {
                return true;
            }

            const iconName = cur.icon_name || cur.child?.icon_name;

            if (
                [
                    'osk-hide-symbolic',
                    'go-down-symbolic',
                    'keyboard-hide-symbolic',
                    'input-keyboard-symbolic',
                ].includes(iconName)
            ) {
                return true;
            }

            if (
                cur._key?.name === 'hide' ||
                cur._key?.action === 'hide'
            ) {
                return true;
            }

            cur = cur.get_parent ? cur.get_parent() : null;
        }

        return false;
    }

    _maybeHandleEvent(event, originalMethod) {
        try {
            const handled = originalMethod
                ? originalMethod.call(Main.keyboard, event)
                : false;

            if (handled)
                return true;

            if (!Main.keyboard?._keyboard)
                return false;

            const actor = global.stage.get_event_actor(event);

            if (!actor || !this._actorIsText(actor))
                return false;

            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                return false;

            if (!Main.keyboard.visible && !this._userHidden)
                Main.keyboard.open(Main.layoutManager.focusIndex);
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
        const keyboard = Main.keyboard;

        if (!keyboard)
            return;

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

        const kbd = keyboard._keyboard;
        const actorExists = !!kbd;
        const visible = keyboard.visible;

        if (visible && !this._prevVisible)
            this._lastPointerPressTime = 0;

        this._prevVisible = visible;

        const requested = !!(kbd && kbd._keyboardRequested);

        const focusChanged =
            this._prevInputFocus !== null &&
            this._prevInputFocus !== focus;

        if (focusChanged)
            this._prevInputFocus = null;

        if (hasFocus && actorExists) {
            const isNewFocus = !this._prevInputFocus;

            if (isNewFocus)
                this._prevInputFocus = focus;

            const recentClick =
                this._lastPointerPressTime > 0 &&
                Date.now() - this._lastPointerPressTime < 500;

            if (
                !visible &&
                !requested &&
                (isNewFocus || recentClick) &&
                !this._userHidden &&
                !this._hideButtonPressed
            ) {
                keyboard.open(Main.layoutManager.focusIndex);
            }
        } else if (!hasFocus && visible) {
            keyboard.close();
            this._prevInputFocus = focus;
        }
    }

    disable() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
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

        // Restore all method overrides installed through InjectionManager.
        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

        // Restore the private touchscreen detector only if our override is
        // still installed, avoiding an unconditional overwrite of another
        // extension's change.
        if (
            Main.keyboard &&
            this._lastDeviceIsTouchscreenOverride &&
            Main.keyboard._lastDeviceIsTouchscreen ===
                this._lastDeviceIsTouchscreenOverride
        ) {
            Main.keyboard._lastDeviceIsTouchscreen =
                this._originalLastDeviceIsTouchscreen;
        }

        this._lastDeviceIsTouchscreenOverride = null;
        this._originalLastDeviceIsTouchscreen = null;

        if (this._didOverrideOsk && this._a11y) {
            this._a11y.set_boolean(
                'screen-keyboard-enabled',
                this._originalOskEnabled
            );

            this._didOverrideOsk = false;
        }

        this._a11y = null;

        if (Main.keyboard?.visible)
            Main.keyboard.close();
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
}
