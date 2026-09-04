#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/osk-fix@houssemko.github.io"
REPO="https://github.com/houssemko/osk-fix"
VERSION="1.5"
ZIP_URL="$REPO/releases/download/$VERSION/osk-fix%40houssemko.github.io.v$VERSION.shell-extension.zip"
FILES=(extension.js metadata.json README.md LICENSE)
SCHEMA_SRC="schemas/org.gnome.shell.extensions.osk-fix.gschema.xml"

echo "Installing OSK Fix..."

mkdir -p "$EXT_DIR/schemas"

if [ -f "extension.js" ] && [ -f "$SCHEMA_SRC" ]; then
    for f in "${FILES[@]}"; do
        cp "$f" "$EXT_DIR/"
    done
    cp "$SCHEMA_SRC" "$EXT_DIR/schemas/"
else
    if ! command -v unzip &>/dev/null; then
        echo "Error: unzip is required for installation." >&2
        exit 1
    fi
    TMP_ZIP="$(mktemp --suffix=.zip)"
    curl -fsSL "$ZIP_URL" -o "$TMP_ZIP"
    unzip -oq "$TMP_ZIP" -d "$HOME/.local/share/gnome-shell/extensions/"
    rm -f "$TMP_ZIP"
fi
glib-compile-schemas "$EXT_DIR/schemas/"

if gnome-extensions info osk-fix@houssemko.github.io &>/dev/null; then
    gnome-extensions enable osk-fix@houssemko.github.io
else
    echo "Extension installed. Log out and back in, then run:"
    echo "  gnome-extensions enable osk-fix@houssemko.github.io"
fi

echo "Done."
