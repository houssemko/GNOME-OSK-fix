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

        this._signalIds.push([
            global.stage,
            global.stage.connect('captured-event', (actor, event) => this._onCapturedEvent(actor, event))
        ]);

        this._signalIds.push([
            global.stage,
            global.stage.connect('button-press-event', (actor, event) => this._onCapturedEvent(actor, event))
        ]);

        this._oldMaybeHandleEvent = Main.keyboard.maybeHandleEvent;
        Main.keyboard.maybeHandleEvent = (event) => this._maybeHandleEvent(event);
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

        if (this._oldMaybeHandleEvent) {
            Main.keyboard.maybeHandleEvent = this._oldMaybeHandleEvent;
            this._oldMaybeHandleEvent = null;
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

    _maybeHandleEvent(event) {
        const handled = this._oldMaybeHandleEvent.call(Main.keyboard, event);
        if (handled) return true;

        if (!Main.keyboard || !Main.keyboard._keyboard) return false;

        const actor = global.stage.get_event_actor(event);
        if (!actor || !this._actorIsText(actor)) return false;

        const evType = event.type();
        const shouldOpen = TOUCH_EVENT_TYPES.has(evType);

        if (!shouldOpen) return false;

        if (this._isPasswordFocused()) return false;

        if (!Main.keyboard.visible) {
            Main.keyboard.open(Main.layoutManager.focusIndex);
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

    _isPasswordFocused() {
        try {
            return Main.inputMethod?.content_purpose === PASSWORD_PURPOSE;
        } catch (e) {
            console.error('[osk-fix] Error checking password purpose:', e);
            return false;
        }
    }
}