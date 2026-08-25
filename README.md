# OSK Fix

A GNOME Shell extension that forces the native on-screen keyboard (OSK) to appear in applications that don't normally trigger it.

> Only tested on GNOME 50.
> **XWayland applications are not supported yet.**

## Installation

### One-line install

```bash
curl -sSL https://raw.githubusercontent.com/houssemko/osk-fix/main/install.sh | bash
```

### Manual

```bash
git clone https://github.com/houssemko/osk-fix.git
cd osk-fix
mkdir -p ~/.local/share/gnome-shell/extensions/osk-fix@houssemko.github.io
cp extension.js metadata.json README.md LICENSE \
   ~/.local/share/gnome-shell/extensions/osk-fix@houssemko.github.io/
gnome-extensions enable osk-fix@houssemko.github.io
```

> **Note:** log out and back in after enabling (Wayland cannot restart GNOME Shell in-place).

### From extensions.gnome.org

*Coming soon — pending review.*

## Activation

The extension is active only while *Settings → Accessibility → Screen Keyboard* is ON. Toggling it takes effect immediately — no reload needed.

## License

GPL-2.0-or-later — see [LICENSE](LICENSE) for details