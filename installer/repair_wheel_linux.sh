#!/bin/bash
set -e

WHEEL="$1"
DEST_DIR="$2"

# Inject the Qt xcb platform plugin into the wheel.
# auditwheel only bundles linked .so files, not Qt plugins
# (which are loaded by path at runtime).
PLUGIN="/usr/lib64/qt5/plugins/platforms/libqxcb.so"
if [ -f "$PLUGIN" ]; then
    python3 -c "
import zipfile, os, sys
wheel = sys.argv[1]
plugin = sys.argv[2]
with zipfile.ZipFile(wheel, 'a') as zf:
    zf.write(plugin, 'lc3py/qt_plugins/platforms/' + os.path.basename(plugin))
" "$WHEEL" "$PLUGIN"
fi

auditwheel repair -w "$DEST_DIR" "$WHEEL"
