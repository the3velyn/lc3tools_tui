#!/bin/bash
set -e

WHEEL="$1"
DEST_DIR="$2"
ARCHS="$3"

# Inject the Qt cocoa platform plugin into the wheel.
QT_PREFIX=$(brew --prefix qt)
PLUGIN=""
for p in "$QT_PREFIX/share/qt/plugins/platforms/libqcocoa.dylib" \
         "$QT_PREFIX/plugins/platforms/libqcocoa.dylib"; do
    if [ -f "$p" ]; then
        PLUGIN="$p"
        break
    fi
done

if [ -n "$PLUGIN" ]; then
    python3 -c "
import zipfile, os, sys
wheel = sys.argv[1]
plugin = sys.argv[2]
with zipfile.ZipFile(wheel, 'a') as zf:
    zf.write(plugin, 'lc3py/qt_plugins/platforms/' + os.path.basename(plugin))
" "$WHEEL" "$PLUGIN"
fi

delocate-wheel --require-archs "$ARCHS" -w "$DEST_DIR" "$WHEEL"
