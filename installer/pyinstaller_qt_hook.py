import os, sys

# When frozen by PyInstaller, DLLs are extracted to sys._MEIPASS.
# Tell Qt where to find its platform plugin (platforms/qwindows.dll).
if getattr(sys, 'frozen', False):
    os.environ['QT_PLUGIN_PATH'] = sys._MEIPASS
