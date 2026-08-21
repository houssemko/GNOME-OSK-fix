# Native OSK Auto-Show Wrap

A GNOME Shell extension that wraps the native GNOME on-screen keyboard (OSK) so it appears in any application, including Chromium, Vivaldi, Firefox under XWayland.

## Features

- Forces the native OSK to show in applications that don't normally trigger it
- Works with XWayland applications (Chromium, Vivaldi, Firefox, etc.)
- Hooks into `maybeHandleEvent` and polls `Main.inputMethod.currentFocus`
- Forces `_lastDeviceIsTouchscreen` to true to trigger OSK display

## Installation

### From GNOME Extensions (Recommended)

1. Visit the [extension page](https://extensions.gnome.org/extension/XXXX/native-osk-autoshow-wrap/) (TODO: update URL after publishing)
2. Click the toggle to install

### Manual Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/native-osk-autoshow-wrap.git

# Copy to local extensions directory
cp -r native-osk-autoshow-wrap@local ~/.local/share/gnome-shell/extensions/

# Restart GNOME Shell (Alt+F2, type 'r', Enter)
# Or log out and back in

# Enable the extension
gnome-extensions enable native-osk-autoshow-wrap@local
```

## Configuration

Use the Extension Manager or GNOME Extensions app to configure:
- Settings are available via the extension preferences

## Compatibility

- GNOME Shell 49
- GNOME Shell 50

## License

MIT License - see [LICENSE](LICENSE) for details