# OSK Fix

A GNOME Shell extension that forces the native on-screen keyboard (OSK) to appear in **native Wayland** applications that don't normally trigger it.

> Only tested on GNOME 50.
> **XWayland applications are not supported yet.**

## Installation

### From extensions.gnome.org

1. Visit the [extension page](https://extensions.gnome.org/extension/XXXX/osk-fix/) *(link works once the extension is approved)*
2. Toggle the switch and accept the browser prompt
3. The extension is installed and enabled immediately

### Via Extension Manager

Install [Extension Manager](https://flathub.org/apps/com.mattjakeman.ExtensionManager) from Flathub or your software center, then search for "OSK Fix" in its Browse tab.

### Manual

```bash
# Clone the repository
git clone https://github.com/houssemko/osk-fix.git
cd osk-fix

# Copy to the local extensions directory
mkdir -p ~/.local/share/gnome-shell/extensions/osk-fix@houssemko.github.io
cp extension.js metadata.json README.md LICENSE    ~/.local/share/gnome-shell/extensions/osk-fix@houssemko.github.io/

# Enable it
gnome-extensions enable osk-fix@houssemko.github.io
```

> **Note:** on Wayland, GNOME Shell cannot be restarted in-place — log out
> and back in if the extension doesn't appear after enabling.

## Activation

The extension is active only while *Settings → Accessibility → Screen Keyboard* is ON. Toggling it takes effect immediately.

## License

GPL-2.0-or-later — see [LICENSE](LICENSE) for details