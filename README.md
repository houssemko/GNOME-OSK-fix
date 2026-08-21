# OSK Fix

A GNOME Shell extension that forces the native on-screen keyboard (OSK) to appear in applications that don't normally trigger it, including Chromium, Vivaldi, Firefox, Electron apps, and other XWayland applications.


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

## License

GPL-2.0-or-later - see [LICENSE](LICENSE) for details
