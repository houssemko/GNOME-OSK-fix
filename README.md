# OSK Fix

A GNOME Shell extension that forces the native on-screen keyboard (OSK) to appear in applications that don't normally trigger it, including Chromium, Vivaldi, Firefox, and other XWayland applications.

## Features

- Forces the native OSK to show in applications that don't normally trigger it
- Works with XWayland applications (Chromium, Vivaldi, Firefox, Electron apps, etc.)
- Always opens OSK on touch events
- Automatically ignores password fields
- Forces touch mode for sessions without detected touchscreen
- Polls for input method focus changes (catches apps that don't emit proper events)

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

## Compatibility

- GNOME Shell 49
- GNOME Shell 50

## License

GPL-2.0-or-later - see [LICENSE](LICENSE) for details