import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Keyboard } from 'resource:///org/gnome/shell/ui/keyboard.js';
import {
    Extension,
    InjectionManager,
} from 'resource:///org/gnome/shell/extensions/extension.js';

const RECENT_CLICK_WINDOW_MS = 800;
const APP_PRESS_WINDOW_MS = 3000;
const PENDING_DUE_MS = 250;
const PENDING_EXPIRE_MS = 1500;

const CLICK_ONLY_MIN_EPISODES = 3;
const FOREIGN_MIN_EPISODES = 1;
const CLICK_ONLY_ENTER_RATE = 0.5;
const CLICK_ONLY_EXIT_RATE = 0.3;
const MAX_TRACKED_APPS = 50;

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
        this._lastAppPress = null;
        this._prevInputFocus = null;
        this._closingProgrammatically = false;
        this._viaManager = false;
        this._pendingForce = null;
        this._appStats = new Map();

        this._injectionManager = new InjectionManager();

        const keyboard = Main.keyboard;

        if (!keyboard)
            return;

        this._settings = null;
        this._a11y = null;
        try {
            this._settings = this.getSettings();
            this._a11y = new Gio.Settings({ schema_id: 'org.gnome.desktop.a11y.applications' });
            if (!this._a11y.get_boolean('screen-keyboard-enabled')) {
                this._a11y.set_boolean('screen-keyboard-enabled', true);
                this._settings.set_boolean('previous-state', true);
            }
        } catch (e) {}
        this._loadLearnedState();

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

        if (this._appStats) {
            this._appStats.clear();
            this._appStats = null;
        }
        this._pendingForce = null;
        this._lastAppPress = null;

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
            Main.keyboard._keyboard?.close(true);
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

        const extension = this;
        const makeManagerOpener = originalMethod => {
            return function (...args) {
                if (extension._openBlocked())
                    return undefined;
                extension._viaManager = true;
                try {
                    return originalMethod.call(this, ...args);
                } finally {
                    extension._viaManager = false;
                }
            };
        };
        const makeInnerOpener = originalMethod => {
            return function (...args) {
                const viaManager = extension._viaManager;
                extension._viaManager = false;
                if (!viaManager)
                    extension._noteNativeOpen(args);
                const blocked = extension._openBlocked();
                if (blocked)
                    return undefined;
                return originalMethod.call(this, ...args);
            };
        };

        if (openTarget && typeof openTarget.open === 'function') {
            this._injectionManager.overrideMethod(
                openTarget, 'open', makeManagerOpener);
        }

        if (Keyboard?.prototype && typeof Keyboard.prototype.open === 'function' &&
            Keyboard.prototype !== openTarget) {
            this._injectionManager.overrideMethod(
                Keyboard.prototype, 'open', makeInnerOpener);
        }
    }

    _noteNativeOpen(args) {
        if (args[0] === true)
            return;
        try {
            if (global.stage.key_focus instanceof Clutter.Text)
                return;
        } catch (e) {}
        const st = this._statsFor(this._getAppId(), true);
        if (st) {
            let changed = false;
            if (!st.nativeCapable) {
                st.nativeCapable = true;
                changed = true;
            }
            if (st.provenForeign) {
                st.provenForeign = false;
                changed = true;
            }
            if (changed)
                this._saveLearnedState();
        }
    }

    _openBlocked() {
        if (this._userHidden || this._hideButtonPressed || !this._oskAvailable())
            return true;
        try {
            if (global.stage.key_focus instanceof Clutter.Text)
                return false;
        } catch (e) {}
        const recentPress = this._lastPointerPressTime > 0 &&
            Date.now() - this._lastPointerPressTime < RECENT_CLICK_WINDOW_MS;
        if (recentPress)
            return false;
        const appId = this._getAppId();
        const st = appId ? this._appStats?.get(appId) : null;
        if (st?.clickOnly)
            return true;
        return false;
    }

    _onCapturedEvent(actor, event) {
        try {
            const eventType = event.type();
            if (eventType !== Clutter.EventType.BUTTON_PRESS &&
                eventType !== Clutter.EventType.TOUCH_BEGIN)
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

            this._userHidden = false;
            this._hideButtonPressed = false;
            let onChrome = false;
            try {
                const target = global.stage.get_event_actor(event);
                onChrome = !!Main.layoutManager.uiGroup?.contains(target);
            } catch (e) {}
            if (!onChrome) {
                this._lastPointerPressTime = Date.now();
                const pressApp = this._pressAppId(event);
                if (pressApp)
                    this._lastAppPress = {appId: pressApp, time: Date.now()};
            }
        } catch (e) {}
    }

    _pressAppId(event) {
        try {
            const target = global.stage.get_event_actor(event);
            let cur = target;
            while (cur) {
                const win = cur.meta_window ||
                    (typeof cur.get_meta_window === 'function' ? cur.get_meta_window() : null);
                if (win) {
                    const app = Shell.WindowTracker.get_default().get_window_app(win);
                    return app?.get_id() ?? null;
                }
                cur = typeof cur.get_parent === 'function' ? cur.get_parent() : null;
            }
        } catch (e) {}
        return null;
    }

    _isHideButton(actor) {
        for (let cur = actor;
             cur;
             cur = typeof cur.get_parent === 'function' ? cur.get_parent() : null) {
            const styleClass = cur.style_class ||
                (typeof cur.get_style_class_name === 'function' ? cur.get_style_class_name() : '');
            if (typeof styleClass === 'string' &&
                (styleClass.includes('hide-key') || styleClass.includes('hide')))
                return true;
        }
        return false;
    }

    _oskAvailable() {
        return !!(Main.keyboard && Main.keyboard._keyboard);
    }

    _getAppId() {
        try {
            const win = global.display?.focus_window;
            const app = win && Shell.WindowTracker.get_default().get_window_app(win);
            return app?.get_id() ?? null;
        } catch (e) {
            return null;
        }
    }

    _stateFile() {
        const dir = GLib.getenv('OSK_FIX_STATE_DIR') ||
            GLib.build_filenamev([GLib.get_user_state_dir(), 'osk-fix']);
        return Gio.File.new_for_path(GLib.build_filenamev([dir, 'state.json']));
    }

    _loadLearnedState() {
        try {
            this._stateFile().load_contents_async(null, (file, res) => {
                try {
                    const [ok, contents] = file.load_contents_finish(res);
                    if (ok) {
                        this._applyLearnedState(JSON.parse(new TextDecoder().decode(contents)));
                        this._saveLearnedState();
                        return;
                    }
                } catch (e) {}
                this._migrateLearnedState();
            });
        } catch (e) {
            this._migrateLearnedState();
        }
    }

    _applyLearnedState(data) {
        if (!data || typeof data !== 'object')
            return;
        const keys = [['native', 'nativeCapable'], ['clickOnly', 'clickOnly'], ['immediate', 'provenForeign']];
        for (const [key, flag] of keys) {
            if (!Array.isArray(data[key]))
                continue;
            for (const id of data[key]) {
                if (typeof id !== 'string')
                    continue;
                const st = this._statsFor(id, true);
                if (!st)
                    continue;
                st[flag] = true;
                if (flag === 'clickOnly' && st.with + st.without < CLICK_ONLY_MIN_EPISODES) {
                    st.with = CLICK_ONLY_MIN_EPISODES - 1;
                    st.without = 0;
                }
            }
        }
        let fixed = false;
        for (const [, st] of this._appStats ?? []) {
            if ((st.nativeCapable || st.clickOnly) && st.provenForeign) {
                st.provenForeign = false;
                fixed = true;
            }
        }
        if (fixed)
            this._saveLearnedState();
    }

    _migrateLearnedState() {
        let native, clickOnly, immediate;
        try {
            native = this._settings.get_strv('native-capable-apps');
            clickOnly = this._settings.get_strv('click-only-apps');
            immediate = this._settings.get_strv('force-immediate-apps');
        } catch (e) {
            return;
        }
        try {
            this._applyLearnedState({native, clickOnly, immediate});
            this._saveLearnedState();
            this._settings.set_strv('native-capable-apps', []);
            this._settings.set_strv('click-only-apps', []);
            this._settings.set_strv('force-immediate-apps', []);
        } catch (e) {}
    }

    _saveLearnedState() {
        let data;
        try {
            data = {native: [], clickOnly: [], immediate: []};
            for (const [id, st] of this._appStats ?? []) {
                if (st.nativeCapable)
                    data.native.push(id);
                if (st.clickOnly)
                    data.clickOnly.push(id);
                if (st.provenForeign)
                    data.immediate.push(id);
            }
        } catch (e) {
            return;
        }
        try {
            const file = this._stateFile();
            const text = new TextEncoder().encode(JSON.stringify(data));
            file.get_parent().make_directory_async(GLib.PRIORITY_DEFAULT, null, (dir, res) => {
                try {
                    dir.make_directory_finish(res);
                } catch (e) {}
                try {
                    file.replace_contents_async(text, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, r) => {
                        try {
                            f.replace_contents_finish(r);
                        } catch (e) {}
                    });
                } catch (e) {}
            });
        } catch (e) {}
    }

    _statsFor(appId, create) {
        if (!appId || !this._appStats)
            return null;
        let st = this._appStats.get(appId);
        if (!st && create) {
            if (this._appStats.size >= MAX_TRACKED_APPS)
                this._appStats.delete(this._appStats.keys().next().value);
            st = {with: 0, without: 0, clickOnly: false, nativeCapable: false, provenForeign: false};
            this._appStats.set(appId, st);
        }
        return st ?? null;
    }

    _updateAppStats(appId, withClick) {
        const st = this._statsFor(appId, true);
        if (!st)
            return false;
        if (withClick)
            st.with++;
        else
            st.without++;
        const total = st.with + st.without;
        const rate = total ? st.with / total : 0;
        if (!st.clickOnly && total >= CLICK_ONLY_MIN_EPISODES && rate >= CLICK_ONLY_ENTER_RATE) {
            st.clickOnly = true;
            st.provenForeign = false;
            this._saveLearnedState();
        } else if (st.clickOnly && rate < CLICK_ONLY_EXIT_RATE) {
            st.clickOnly = false;
            this._saveLearnedState();
        }
        return st.clickOnly;
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
                hasFocus = false;
            }
        }

        const kbd = keyboard._keyboard;
        const actorExists = !!kbd;
        const visible = keyboard.visible;
        if (!actorExists)
            this._pendingForce = null;

        const requested = !!(kbd && kbd._keyboardRequested);

        const focusChanged = this._prevInputFocus !== null && this._prevInputFocus !== focus;
        if (focusChanged)
            this._prevInputFocus = null;

        if (hasFocus && actorExists) {
            if (visible)
                this._pendingForce = null;

            const recentClick = this._lastPointerPressTime > 0 &&
                Date.now() - this._lastPointerPressTime < RECENT_CLICK_WINDOW_MS;

            const appId = this._getAppId();
            const tappedApp = !!appId && !!this._lastAppPress &&
                this._lastAppPress.appId === appId &&
                Date.now() - this._lastAppPress.time < APP_PRESS_WINDOW_MS;
            const tapped = recentClick || tappedApp;
            const isNewFocus = !this._prevInputFocus;
            let openOnFocus = isNewFocus;
            if (isNewFocus) {
                this._prevInputFocus = focus;
                if (this._updateAppStats(appId, tapped))
                    openOnFocus = false;
                this._pendingForce = null;
            }
            const st = appId ? this._appStats?.get(appId) : null;
            if (isNewFocus && st && !st.provenForeign && !st.nativeCapable &&
                st.with + st.without >= FOREIGN_MIN_EPISODES) {
                st.provenForeign = true;
                this._saveLearnedState();
            }
            const nativeCapable = !!st?.nativeCapable;
            const provenForeign = !!st?.provenForeign;

            const p = this._pendingForce;
            if (p && (p.focus !== focus || Date.now() > p.expires))
                this._pendingForce = null;

            if (!visible && !requested &&
                !this._userHidden && !this._hideButtonPressed) {
                if (tapped) {
                    this._pendingForce = null;
                    keyboard.open(Main.layoutManager.focusIndex);
                } else if (openOnFocus && !nativeCapable) {
                    const now = Date.now();
                    const pending = this._pendingForce;
                    if (provenForeign ||
                        (pending && pending.focus === focus && now >= pending.due)) {
                        this._pendingForce = null;
                        keyboard.open(Main.layoutManager.focusIndex);
                    } else if (!pending || pending.focus !== focus) {
                        this._pendingForce = {
                            focus, due: now + PENDING_DUE_MS,
                            expires: now + PENDING_EXPIRE_MS,
                        };
                    }
                }
            }
        } else if (!hasFocus && visible) {
            this._closingProgrammatically = true;
            this._pendingForce = null;
            if (kbd)
                kbd.close(true);
            else
                keyboard.close();
            this._prevInputFocus = focus;
        }
    }
}
