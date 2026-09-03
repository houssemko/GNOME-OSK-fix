#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/osk-fix@houssemko.github.io"
REPO="https://github.com/houssemko/osk-fix"
FILES=(extension.js metadata.json README.md LICENSE)

echo "Installing OSK Fix..."

mkdir -p "$EXT_DIR"

for f in "${FILES[@]}"; do
    if [ -f "$f" ]; then
        cp "$f" "$EXT_DIR/"
    else
        # Fall back to downloading from repo if file not found locally
        curl -sSL "$REPO/raw/main/$f" -o "$EXT_DIR/$f"
    fi
done

SCHEMA="schemas/org.gnome.shell.extensions.osk-fix.gschema.xml"
mkdir -p "$EXT_DIR/schemas"
if [ -f "$SCHEMA" ]; then
    cp "$SCHEMA" "$EXT_DIR/schemas/"
else
    curl -sSL "$REPO/raw/main/$SCHEMA" -o "$EXT_DIR/schemas/$(basename "$SCHEMA")"
fi
glib-compile-schemas "$EXT_DIR/schemas/"

if gnome-extensions info osk-fix@houssemko.github.io &>/dev/null; then
    gnome-extensions enable osk-fix@houssemko.github.io
else
    echo "Extension installed. Log out and back in, then run:"
    echo "  gnome-extensions enable osk-fix@houssemko.github.io"
fi

echo "Done."
