# OSK Fix

A GNOME Shell extension that forces the native on-screen keyboard (OSK) to appear in applications that don't normally trigger it, including Chromium, Vivaldi, Firefox, Electron apps, and other XWayland applications.

## Features

- Forces the native OSK to show in applications that don't normally trigger it
- Works with XWayland applications (Chromium, Vivaldi, Firefox, Electron apps, etc.)
- Click-only activation — opens OSK on mouse/touchpad click in text fields
- Opens OSK for password fields (user can type passwords)
- Forces touch mode for sessions without detected touchscreen
- Respects manual hide: pressing the OSK's hide button keeps it hidden until next click
- Event-driven (no polling loop) — uses `notify::current-focus` and captured events
- Safe coexistence with other extensions — preserves and restores monkey-patched methods

## Installation

### From GNOME Extensions (Recommended)

1. Visit the [extension page](https://extensions.gnome.org/extension/XXXX/osk-fix/) (TODO: update URL after publishing to EGO)
2. Click the toggle to install

### Manual Installation

```bash
# Clone the repository
git clone https://github.com/houssemko/osk-fix.git

# Copy to local extensions directory
cp -r osk-fix@local ~/.local/share/gnome-shell/extensions/

# Restart GNOME Shell (Alt+F2, type 'r', Enter) or log out and back in

# Enable the extension
gnome-extensions enable osk-fix@local
```

## Behavior

| Action | Result |
|--------|--------|
| Click text field | OSK opens |
| Click OSK hide button | OSK stays hidden |
| Click another text field | OSK opens again |
| Focus via Tab/keyboard | OSK stays closed (click required) |
| Focus password field | OSK opens |

## Compatibility

- GNOME Shell 45
- GNOME Shell 46
- GNOME Shell 47
- GNOME Shell 48
- GNOME Shell 49
- GNOME Shell 50

## License

GPL-2.0-or-later - see [LICENSE](LICENSE) for details