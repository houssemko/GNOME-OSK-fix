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
        curl -sSL "$REPO/raw/master/$f" -o "$EXT_DIR/$f"
    fi
done

if gnome-extensions info osk-fix@houssemko.github.io &>/dev/null; then
    gnome-extensions enable osk-fix@houssemko.github.io
else
    echo "Extension installed. Log out and back in, then run:"
    echo "  gnome-extensions enable osk-fix@houssemko.github.io"
fi

echo "Done."
