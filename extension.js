import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Keyboard } from 'resource:///org/gnome/shell/ui/keyboard.js';
import {
    Extension,
    InjectionManager,
} from 'resource:///org/gnome/shell/extensions/extension.js';

const RECENT_CLICK_WINDOW_MS = 500;

export default class OskFixExtension extends Extension {
    enable() {
        this._pollId = 0;
        this._visibilitySignalId = 0;
        this._capturedEventHandlerId = 0;

        this._originalLastDeviceIsTouchscreen = null;
        this._lastDeviceIsTouchscreenOverride = null;

        this._userHidden = false;
        this._lastOskPressTime = 0;
        this._lastPointerPressTime = 0;
        this._prevVisible = false;
        this._prevInputFocus = null;
        this._closingProgrammatically = false;

        this._injectionManager = new InjectionManager();

        const keyboard = Main.keyboard;

        if (!keyboard)
            return;

        this._settings = this.getSettings();
        this._a11y = new Gio.Settings({ schema_id: 'org.gnome.desktop.a11y.applications' });
        if (!this._a11y.get_boolean('screen-keyboard-enabled')) {
            this._a11y.set_boolean('screen-keyboard-enabled', true);
            this._settings.set_boolean('previous-state', true);
        }

        this._installKeyboardOverrides(keyboard);

        this._visibilitySignalId = keyboard.connect('visibility-changed', () => {
            if (keyboard.visible)
                return;

            if (this._closingProgrammatically) {
                this._closingProgrammatically = false;
                return;
            }

            if (Date.now() - this._lastOskPressTime < RECENT_CLICK_WINDOW_MS)
                this._userHidden = true;
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

    disable() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
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

        if (this._settings?.get_boolean('previous-state')) {
            this._a11y?.set_boolean('screen-keyboard-enabled', false);
            this._settings.set_boolean('previous-state', false);
        }
        this._a11y = null;
        this._settings = null;

        if (Main.keyboard?.visible) {
            this._closingProgrammatically = true;
            Main.keyboard.close();
        }
    }

    _installKeyboardOverrides(keyboard) {
        if (typeof keyboard._lastDeviceIsTouchscreen === 'function') {
            this._originalLastDeviceIsTouchscreen = keyboard._lastDeviceIsTouchscreen;
            this._lastDeviceIsTouchscreenOverride = () => true;
            keyboard._lastDeviceIsTouchscreen = this._lastDeviceIsTouchscreenOverride;
        }

        const keyboardPrototype = Object.getPrototypeOf(keyboard);

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
                            !extension._oskAvailable()
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
            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
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
                this._lastOskPressTime = Date.now();
                return;
            }

            this._lastPointerPressTime = Date.now();
            this._userHidden = false;
        } catch (e) {}
    }

    _oskAvailable() {
        return !!(Main.keyboard && Main.keyboard._keyboard);
    }

    _safePoll() {
        try {
            this._poll();
        } catch (e) {}
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
                !this._userHidden) {
                keyboard.open(Main.layoutManager.focusIndex);
            }
        } else if (!hasFocus && visible) {
            this._closingProgrammatically = true;
            keyboard.close();
            this._prevInputFocus = focus;
        }
    }
}
