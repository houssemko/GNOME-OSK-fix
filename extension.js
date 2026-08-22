import Clutter from 'gi://Clutter';
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

        /*
         * We need stage-level pointer handling because GNOME's OSK event
         * hierarchy is not reliable for identifying OSK clicks on all
         * supported Shell versions.
         */
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

        /*
         * Force the OSK subsystem on regardless of the accessibility
         * setting or attached devices - without touching any GSettings.
         * The native destroy path is never reached while the extension
         * is enabled; restoring the original method in disable() lets
         * GNOME clean up normally.
         */
        if (typeof keyboard._syncEnabled === 'function') {
            this._injectionManager.overrideMethod(
                keyboard,
                '_syncEnabled',
                originalMethod => function () {
                    if (!this._keyboard) {
                        this._keyboard = new Keyboard();
                        this._keyboard.connect(
                            'visibility-changed',
                            () => {
                                this.emit('visibility-changed');
                                this._bottomDragGesture.enabled =
                                    !this._keyboard.visible;
                            }
                        );
                    }
                }
            );
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
                            extension._hideButtonPressed
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

                /*
                 * Never treat a click on an OSK key as a click on a normal
                 * text input.
                 */
                return;
            }

            /*
             * Pointer press outside the OSK.
             *
             * A later focus event/polling cycle can use this timestamp to
             * determine whether the user interacted with a text field.
             */
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

    _maybeHandleEvent(event, originalMethod) {
        try {
            /*
             * Preserve GNOME's original event handling first.
             */
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

            /*
             * If a text actor receives a button press while the OSK is hidden,
             * reopen it unless the user explicitly dismissed it.
             */
            if (
                !Main.keyboard.visible &&
                !this._userHidden &&
                !this._hideButtonPressed
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
        /*
         * Stop polling first so no new callbacks execute while the extension
         * is being torn down.
         */
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }

        /*
         * Disconnect global stage signals.
         */
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

        /*
         * Disconnect the keyboard visibility signal.
         */
        if (
            this._visibilitySignalId &&
            Main.keyboard
        ) {
            Main.keyboard.disconnect(
                this._visibilitySignalId
            );

            this._visibilitySignalId = 0;
        }

        /*
         * Restore all InjectionManager overrides.
         */
        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

        /*
         * Restore the private touchscreen callback, but only when it is still
         * our override. This avoids blindly overwriting a change made by
         * another extension.
         */
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


        /*
         * Keep GNOME's keyboard state clean after disabling the extension.
         */
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
