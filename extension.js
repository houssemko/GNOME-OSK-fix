import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

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

export default class OskFixExtension extends Extension {
    enable() {
        this._signalIds = [];
        this._didOverrideOsk = false;
        this._lastPointerPressTime = 0;
        this._prevKeyFocusActor = null;
        this._prevInputFocus = null;

        this._a11y = new Gio.Settings({ schema_id: 'org.gnome.desktop.a11y.applications' });
        this._originalOskEnabled = this._a11y.get_boolean('screen-keyboard-enabled');

        if (!this._originalOskEnabled) {
            this._a11y.set_boolean('screen-keyboard-enabled', true);
            this._didOverrideOsk = true;
        }

        if (Main.keyboard) {
            this._originalLastDeviceIsTouchscreen = Main.keyboard._lastDeviceIsTouchscreen;
            Main.keyboard._lastDeviceIsTouchscreen = () => true;
        }

        if (Main.inputMethod) {
            this._signalIds.push([
                Main.inputMethod,
                Main.inputMethod.connect('notify::current-focus', () => this._onFocusChange())
            ]);
        }

        this._signalIds.push([
            global.stage,
            global.stage.connect('captured-event', (actor, event) => this._onCapturedEvent(actor, event))
        ]);

        this._signalIds.push([
            global.stage,
            global.stage.connect('button-press-event', (actor, event) => this._onCapturedEvent(actor, event))
        ]);

        try {
            this._signalIds.push([
                global.stage,
                global.stage.connect('notify::key-focus', () => this._onKeyFocusChange())
            ]);
        } catch (e) {
            console.error('[osk-fix] Failed to connect key-focus signal:', e);
        }

        if (Main.overview) {
            this._signalIds.push([
                Main.overview,
                Main.overview.connect('hidden', () => this._onFocusChange())
            ]);
        }
    }

    disable() {
        if (this._signalIds) {
            for (const [obj, signalId] of this._signalIds) {
                if (obj && signalId) {
                    try {
                        obj.disconnect(signalId);
                    } catch (e) {
                        console.error('[osk-fix] Error disconnecting signal:', e);
                    }
                }
            }
            this._signalIds = [];
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

    _onCapturedEvent(actor, event) {
        if (POINTER_PRESS_TYPES.has(event.type())) {
            this._lastPointerPressTime = Date.now();
        }
    }

    _onKeyFocusChange() {
        const focusActor = global.stage.key_focus;
        if (focusActor && this._actorIsText(focusActor) && !this._prevKeyFocusActor) {
            this._lastPointerPressTime = Date.now();
        }
        this._prevKeyFocusActor = focusActor;
    }

    _onFocusChange() {
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

        if (hasFocus) {
            if (!this._prevInputFocus) {
                this._prevInputFocus = focus;
            }

            if (!visible) {
                if (this._isPasswordFocused()) return;

                const now = Date.now();
                const recentTouch = this._lastPointerPressTime > 0 && (now - this._lastPointerPressTime) < 1000;

                if (recentTouch) {
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
            if (cur instanceof Clutter.Text) return true;
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