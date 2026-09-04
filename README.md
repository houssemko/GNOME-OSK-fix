# OSK Fix

A GNOME Shell extension that forces the native on-screen keyboard (OSK) to appear in applications that don't normally trigger it.

Native Wayland apps work out of the box; the keyboard is forced in apps that don't request it (Vivaldi, Chromium, Electron).

> Only tested on GNOME 50.
> **XWayland applications are not supported yet.**

## Installation

### Drag and drop (recommended)

1. Download the release zip and extract it.
2. Drag the `osk-fix@houssemko.github.io` folder into `~/.local/share/gnome-shell/extensions/`.
3. Log out and back in, then enable it with `gnome-extensions enable osk-fix@houssemko.github.io` (or Extensions app → OSK Fix → on).

- **Release 1.5:** [osk-fix@houssemko.github.io.v1.5.shell-extension.zip](https://github.com/houssemko/osk-fix/releases/download/1.5/osk-fix%40houssemko.github.io.v1.5.shell-extension.zip)

### One-line install

```bash
curl -sSL https://raw.githubusercontent.com/houssemko/osk-fix/master/install.sh | bash
```

### Manual

```bash
git clone https://github.com/houssemko/osk-fix.git
cd osk-fix
mkdir -p ~/.local/share/gnome-shell/extensions/osk-fix@houssemko.github.io/schemas
cp extension.js metadata.json README.md LICENSE \
   ~/.local/share/gnome-shell/extensions/osk-fix@houssemko.github.io/
cp schemas/org.gnome.shell.extensions.osk-fix.gschema.xml \
   ~/.local/share/gnome-shell/extensions/osk-fix@houssemko.github.io/schemas/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/osk-fix@houssemko.github.io/schemas/
gnome-extensions enable osk-fix@houssemko.github.io
```

> **Note:** log out and back in after enabling (Wayland cannot restart GNOME Shell in-place).

## Activation

The extension is active only while *Settings → Accessibility → Screen Keyboard* is ON. Toggling it takes effect immediately — no reload needed.

## License

GPL-2.0-or-later — see [LICENSE](LICENSE) for details