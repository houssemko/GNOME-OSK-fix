import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const logError = global.logError || ((e, msg) => console.error(msg, e));
import { Keyboard } from 'resource:///org/gnome/shell/ui/keyboard.js';
import {
    Extension,
    InjectionManager,
} from 'resource:///org/gnome/shell/extensions/extension.js';

const POINTER_PRESS_TYPES = new Set([
    Clutter.EventType.BUTTON_PRESS,
]);
const RECENT_CLICK_WINDOW_MS = 500;

export default class OskFixExtension extends Extension {
    enable() {
        this._pollId = 0;
        this._visibilitySignalId = 0;
        this._capturedEventHandlerId = 0;

        this._originalLastDeviceIsTouchscreen = null;
        this._lastDeviceIsTouchscreenOverride = null;

        this._userHidden = false;
        this._hideButtonPressed = false;
        this._lastPointerPressTime = 0;
        this._prevVisible = false;
        this._prevInputFocus = null;
        this._closingProgrammatically = false;

        this._injectionManager = new InjectionManager();

        const keyboard = Main.keyboard;

        if (!keyboard) {
            console.error('[osk-fix] Main.keyboard not available at enable, aborting');
            return;
        }

        this._a11y = new Gio.Settings({ schema_id: 'org.gnome.desktop.a11y.applications' });
        this._originalOskEnabled = this._a11y.get_boolean('screen-keyboard-enabled');
        if (!this._originalOskEnabled) {
            this._a11y.set_boolean('screen-keyboard-enabled', true);
            this._didOverrideOsk = true;
        }

        this._installKeyboardOverrides(keyboard);

        this._visibilitySignalId = keyboard.connect('visibility-changed', () => {
            if (keyboard.visible)
                return;

            if (this._closingProgrammatically) {
                this._closingProgrammatically = false;
                return;
            }

            if (this._hideButtonPressed) {
                this._userHidden = true;
                this._hideButtonPressed = false;
            }
        });

        this._capturedEventHandlerId = global.stage.connect(
            'captured-event',
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
        GLib.Source.set_name_by_id(this._pollId, '[osk-fix] poll');
    }

    _installKeyboardOverrides(keyboard) {
        if (typeof keyboard._lastDeviceIsTouchscreen === 'function') {
            this._originalLastDeviceIsTouchscreen = keyboard._lastDeviceIsTouchscreen;
            this._lastDeviceIsTouchscreenOverride = () => true;
            keyboard._lastDeviceIsTouchscreen = this._lastDeviceIsTouchscreenOverride;
        } else {
            console.debug('[osk-fix] _lastDeviceIsTouchscreen not found on Main.keyboard; ' +
                'force-touch patch skipped for this GNOME Shell version.');
        }

        const keyboardPrototype = Object.getPrototypeOf(keyboard);

        const maybeHandleEventTarget =
            keyboardPrototype && typeof keyboardPrototype.maybeHandleEvent === 'function'
                ? keyboardPrototype
                : keyboard;

        if (typeof maybeHandleEventTarget.maybeHandleEvent === 'function') {
            this._injectionManager.overrideMethod(
                maybeHandleEventTarget,
                'maybeHandleEvent',
                originalMethod => {
                    const extension = this;
                    return function (event) {
                        return extension._maybeHandleEvent(event, originalMethod, this);
                    };
                }
            );
        }

        const openTarget =
            keyboardPrototype && typeof keyboardPrototype.open === 'function'
                ? keyboardPrototype
                : (typeof keyboard.open === 'function' ? keyboard : Keyboard?.prototype);

        if (openTarget && typeof openTarget.open === 'function') {
            const extension = this;
            this._injectionManager.overrideMethod(
                openTarget,
                'open',
                originalMethod => {
                    return function (...args) {
                        if (
                            extension._userHidden ||
                            extension._hideButtonPressed ||
                            !extension._oskAvailable()
                        ) {
                            return undefined;
                        }
                        return originalMethod.call(this, ...args);
                    };
                }
            );
        } else {
            console.error('[osk-fix] Could not find an "open" method to override on the keyboard.');
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
                pressOnOsk = x >= sx && x <= sx + w && y >= sy && y <= sy + h;
            }

            if (pressOnOsk) {
                if (this._isHideButton(actor)) {
                    this._hideButtonPressed = true;
                    this._userHidden = true;
                }
                return;
            }

            this._lastPointerPressTime = Date.now();
            this._userHidden = false;
            this._hideButtonPressed = false;
        } catch (e) {
            logError(e, '[osk-fix] Error in captured event handler');
        }
    }

    _isHideButton(actor) {
        let cur = actor;
        while (cur) {
            const styleClass = cur.style_class ||
                (typeof cur.get_style_class_name === 'function' ? cur.get_style_class_name() : '');
            if (typeof styleClass === 'string' &&
                (styleClass.includes('hide-key') || styleClass.includes('hide'))) {
                return true;
            }

            const iconName = cur.icon_name || cur.child?.icon_name;
            if ([
                'osk-hide-symbolic',
                'go-down-symbolic',
                'keyboard-hide-symbolic',
                'input-keyboard-symbolic',
            ].includes(iconName)) {
                return true;
            }

            if (cur._key?.name === 'hide' || cur._key?.action === 'hide')
                return true;

            cur = typeof cur.get_parent === 'function' ? cur.get_parent() : null;
        }
        return false;
    }

    _oskAvailable() {
        return !!(Main.keyboard && Main.keyboard._keyboard);
    }

    _maybeHandleEvent(event, originalMethod, keyboardSelf) {
        try {
            const handled = originalMethod ? originalMethod.call(keyboardSelf, event) : false;
            if (handled)
                return true;

            if (!Main.keyboard?._keyboard)
                return false;

            const actor = global.stage.get_event_actor(event);
            if (!actor || !this._actorIsText(actor))
                return false;

            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                return false;

            if (!Main.keyboard.visible && !this._userHidden && !this._hideButtonPressed) {
                Main.keyboard.open(Main.layoutManager.focusIndex);
            }
        } catch (e) {
            logError(e, '[osk-fix] Error in _maybeHandleEvent');
        }
        return false;
    }

    _safePoll() {
        try {
            this._poll();
        } catch (e) {
            logError(e, '[osk-fix] Exception during poll cycle');
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
                logError(e, '[osk-fix] Error checking focus state');
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

        const focusChanged = this._prevInputFocus !== null && this._prevInputFocus !== focus;
        if (focusChanged)
            this._prevInputFocus = null;

        if (hasFocus && actorExists) {
            const isNewFocus = !this._prevInputFocus;
            if (isNewFocus)
                this._prevInputFocus = focus;

            const recentClick = this._lastPointerPressTime > 0 &&
                Date.now() - this._lastPointerPressTime < RECENT_CLICK_WINDOW_MS;

            if (!visible && !requested && (isNewFocus || recentClick) &&
                !this._userHidden && !this._hideButtonPressed) {
                keyboard.open(Main.layoutManager.focusIndex);
            }
        } else if (!hasFocus && visible) {
            this._closingProgrammatically = true;
            keyboard.close();
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

        if (this._visibilitySignalId && Main.keyboard) {
            Main.keyboard.disconnect(this._visibilitySignalId);
            this._visibilitySignalId = 0;
        }

        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

        if (Main.keyboard &&
            this._lastDeviceIsTouchscreenOverride &&
            Main.keyboard._lastDeviceIsTouchscreen === this._lastDeviceIsTouchscreenOverride) {
            Main.keyboard._lastDeviceIsTouchscreen = this._originalLastDeviceIsTouchscreen;
        }
        this._lastDeviceIsTouchscreenOverride = null;
        this._originalLastDeviceIsTouchscreen = null;

        if (this._didOverrideOsk && this._a11y) {
            this._a11y.set_boolean('screen-keyboard-enabled', this._originalOskEnabled);
            this._didOverrideOsk = false;
        }
        this._a11y = null;

        if (Main.keyboard?.visible) {
            this._closingProgrammatically = true;
            Main.keyboard.close();
        }
    }

    _actorIsText(actor) {
        let cur = actor;
        while (cur) {
            if (cur instanceof Clutter.Text)
                return true;
            if (cur.inputMethodHints !== undefined)
                return true;
            cur = typeof cur.get_parent === 'function' ? cur.get_parent() : null;
        }
        return false;
    }
}
