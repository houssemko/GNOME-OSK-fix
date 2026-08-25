import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Keyboard } from 'resource:///org/gnome/shell/ui/keyboard.js';
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
        this._lastDeviceWasPointer = true;
        this._prevVisible = false;
        this._prevInputFocus = null;

        this._injectionManager = new InjectionManager();

        const keyboard = Main.keyboard;

        if (keyboard) {
            this._installKeyboardOverrides(keyboard);

            this._visibilitySignalId = keyboard.connect(
                'visibility-changed',
                () => {
                    if (!keyboard.visible && this._hideButtonPressed) {
                        this._userHidden = true;
                        this._hideButtonPressed = false;
                    }
                }
            );
        } else {
            console.error(
                '[osk-fix] Main.keyboard not available at enable'
            );
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
            GLib.PRIORITY_DEFAULT,
            300,
            () => {
                this._safePoll();
                return GLib.SOURCE_CONTINUE;
            }
        );

        GLib.Source.set_name_by_id(
            this._pollId,
            '[osk-fix] poll'
        );

        /*
         * Track the last input device used. GNOME delivers this signal on
         * every device switch - including clicks inside Wayland clients,
         * whose pointer events never reach stage handlers. A pointer/mouse
         * as the last device therefore means "the user is mousing", which
         * is our observable proxy for text-field clicks in those apps.
         */
        if (global.backend?.connect) {
            this._lastDeviceChangedId = global.backend.connect(
                'last-device-changed',
                (backend, device) => {
                    try {
                        this._lastDeviceWasPointer =
                            device.get_device_type() !==
                            Clutter.InputDeviceType.KEYBOARD_DEVICE;
                    } catch (e) {}
                }
            );
        }
    }

    _installKeyboardOverrides(keyboard) {
        if (!this._injectionManager)
            return;

        if (typeof keyboard._lastDeviceIsTouchscreen === 'function') {
            this._originalLastDeviceIsTouchscreen =
                keyboard._lastDeviceIsTouchscreen;

            this._lastDeviceIsTouchscreenOverride = () => true;

            keyboard._lastDeviceIsTouchscreen =
                this._lastDeviceIsTouchscreenOverride;
        }

        const keyboardPrototype = Object.getPrototypeOf(keyboard);
        const keyboardTarget =
            keyboardPrototype &&
            typeof keyboardPrototype.maybeHandleEvent === 'function'
                ? keyboardPrototype
                : keyboard;

        if (typeof keyboardTarget.maybeHandleEvent === 'function') {
            this._injectionManager.overrideMethod(
                keyboardTarget,
                'maybeHandleEvent',
                originalMethod => {
                    return function (event) {
                        return this._maybeHandleEvent(
                            event,
                            originalMethod
                        );
                    }.bind(this);
                }
            );
        }

        const openTarget =
            keyboardPrototype &&
            typeof keyboardPrototype.open === 'function'
                ? keyboardPrototype
                : keyboard;

        if (typeof openTarget.open === 'function') {
            const extension = this;

            this._injectionManager.overrideMethod(
                openTarget,
                'open',
                originalMethod => {
                    return function (...args) {
                        if (
                            extension._userHidden ||
                            extension._hideButtonPressed ||
                            !extension._a11yOskEnabled()
                        ) {
                            return undefined;
                        }

                        return originalMethod.call(this, ...args);
                    };
                }
            );
        }

        if (
            Keyboard?.prototype &&
            typeof Keyboard.prototype.open === 'function'
        ) {
            const extension = this;

            this._injectionManager.overrideMethod(
                Keyboard.prototype,
                'open',
                originalMethod => {
                    return function (...args) {
                        if (
                            extension._userHidden ||
                            extension._hideButtonPressed ||
                            !extension._a11yOskEnabled()
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

                return;
            }

            this._lastPointerPressTime = Date.now();
            this._userHidden = false;
            this._hideButtonPressed = false;
        } catch (e) {
            console.error(
                '[osk-fix] Error in captured event handler:',
                e
            );
        }
    }

    _isHideButton(actor) {
        let cur = actor;

        while (cur) {
            const styleClass =
                cur.style_class ||
                (
                    typeof cur.get_style_class_name === 'function'
                        ? cur.get_style_class_name()
                        : ''
                );

            if (
                typeof styleClass === 'string' &&
                (
                    styleClass.includes('hide-key') ||
                    styleClass.includes('hide')
                )
            ) {
                return true;
            }

            const iconName =
                cur.icon_name ||
                cur.child?.icon_name;

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

            cur =
                typeof cur.get_parent === 'function'
                    ? cur.get_parent()
                    : null;
        }

        return false;
    }

    _a11yOskEnabled() {
        return !!(Main.keyboard && Main.keyboard._keyboard);
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

            if (
                !Main.keyboard.visible &&
                !this._userHidden &&
                !this._hideButtonPressed &&
                this._a11yOskEnabled()
            ) {
                Main.keyboard.open(
                    Main.layoutManager.focusIndex
                );
            }
        } catch (e) {
            console.error(
                '[osk-fix] Error in _maybeHandleEvent:',
                e
            );
        }

        return false;
    }

    _safePoll() {
        try {
            this._poll();
        } catch (e) {
            console.error(
                '[osk-fix] Exception during poll cycle:',
                e
            );
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
                console.error(
                    '[osk-fix] Error checking focus state:',
                    e
                );

                hasFocus = !!focus;
            }
        }

        const kbd = keyboard._keyboard;
        const actorExists = !!kbd;
        const visible = keyboard.visible;

        if (visible && !this._prevVisible)
            this._lastPointerPressTime = 0;
        this._lastDeviceWasPointer = true;

        this._prevVisible = visible;

        const requested =
            !!(kbd && kbd._keyboardRequested);

        const focusChanged =
            this._prevInputFocus !== null &&
            this._prevInputFocus !== focus;

        if (focusChanged)
            this._prevInputFocus = null;

        if (hasFocus && actorExists) {
            const isNewFocus = !this._prevInputFocus;

            if (isNewFocus)
                this._prevInputFocus = focus;

            const timeSinceInteraction = this._lastPointerPressTime > 0
                ? Date.now() - this._lastPointerPressTime : Infinity;
            const recentClick = timeSinceInteraction < 600;
            // Wayland clients like Vivaldi can take 1.5-3s to commit focus
            // after the click - use a generous window for new fields.
            const wasUserInitiated = timeSinceInteraction < 4000;

            /*
             * Two reopen triggers, both requiring the last input device to
             * be the mouse (keyboard-driven focus never opens):
             * 1) New editable committed focus shortly after a click
             * 2) Same editable re-clicked within 600ms
             */
            const sameFieldReClick = !isNewFocus && recentClick;
            const newFieldWithIntent = isNewFocus && wasUserInitiated;

            if (
                !visible &&
                !requested &&
                lastDeviceWasPointer &&
                (sameFieldReClick || newFieldWithIntent) &&
                !this._userHidden &&
                !this._hideButtonPressed &&
                this._a11yOskEnabled()
            ) {
                keyboard.open(
                    Main.layoutManager.focusIndex
                );
            }
        } else if (!hasFocus && visible) {
            keyboard.close();
            this._prevInputFocus = focus;
        }
    }

    disable() {
        // TEMPORARY: remove observation listeners first
        if (this._debugSignalIds) {
            for (const [obj, id] of this._debugSignalIds) {
                try {
                    obj.disconnect(id);
                } catch (e) {}
            }
            this._debugSignalIds = [];
        }

        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }

        if (this._capturedEventHandlerId) {
            global.stage.disconnect(
                this._capturedEventHandlerId
            );

            this._capturedEventHandlerId = 0;
        }

        if (this._buttonPressHandlerId) {
            global.stage.disconnect(
                this._buttonPressHandlerId
            );

            this._buttonPressHandlerId = 0;
        }


        if (
            this._visibilitySignalId &&
            Main.keyboard
        ) {
            Main.keyboard.disconnect(
                this._visibilitySignalId
            );

            this._visibilitySignalId = 0;
        }


        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

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

        if (Main.keyboard?.visible)
            Main.keyboard.close();
    }

    _actorIsText(actor) {
        let cur = actor;

        while (cur) {
            if (cur instanceof Clutter.Text)
                return true;

            cur =
                typeof cur.get_parent === 'function'
                    ? cur.get_parent()
                    : null;
        }

        return false;
    }
}
