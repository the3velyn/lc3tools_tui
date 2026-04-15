from setuptools import setup, Extension
from pybind11.setup_helpers import build_ext
import pybind11
import glob
import sys
import subprocess

def _pkgconfig(*args):
    try:
        out = subprocess.check_output(["pkg-config"] + list(args),
                                      stderr=subprocess.DEVNULL)
        return out.decode().split()
    except Exception:
        return []

import os

compile_args_base = []
if sys.platform == 'win32':
    compile_args_base = ['/std:c++17', '/EHsc', '/Zc:__cplusplus']
else:
    compile_args_base = [
        '-Wno-error=format-security',
        '-Wno-format-security',
        '-fvisibility=default',
        '-std=c++17',
    ]

backend_sources = [
    *glob.glob("src/backend/*.cpp"),
    *glob.glob("src/utils/*.cpp"),
    *glob.glob("src/common/*.cpp"),
]

cli_sources = glob.glob("src/cli/*.cpp")

# curs_main.cpp uses ncurses+Qt5 — only compile it on Unix
core_cli_sources = [s for s in cli_sources if "curs_main" not in s]

include_dirs = [
    pybind11.get_include(),
    "src/backend",
    "src/utils",
    "include",
    "src/cli",
    "src/common",
]

# --- cli_bindings: platform-specific configuration ---
cli_compile_args = list(compile_args_base) + ["-DBUILDING_CLI_BINDINGS"]
cli_include_dirs = list(include_dirs)
cli_lib_dirs     = []
cli_libraries    = []
cli_link_args    = []
cli_ext_sources  = cli_sources  # all cli/*.cpp including curs_main

if sys.platform == 'win32':
    # Windows: enable curs_main when Qt + PDCurses are available.
    # CI sets QT_ROOT_DIR (or Qt6_DIR / Qt5_DIR) via install-qt-action;
    # PDCurses comes from vcpkg (VCPKG_INSTALLATION_ROOT).
    #
    # install-qt-action sets Qt6_DIR to .../lib/cmake/Qt6 (cmake config),
    # but we need the root (which has include/ and lib/).  QT_ROOT_DIR
    # points there directly; otherwise walk up from the cmake path.
    qt_root = os.environ.get('QT_ROOT_DIR', '')
    if not qt_root:
        cmake_dir = os.environ.get('Qt6_DIR', os.environ.get('Qt5_DIR', ''))
        if cmake_dir and os.path.isdir(cmake_dir):
            # .../lib/cmake/Qt6 → go up 3 levels to the root
            qt_root = os.path.dirname(os.path.dirname(os.path.dirname(cmake_dir)))

    vcpkg = os.environ.get('VCPKG_INSTALLATION_ROOT', '')

    if qt_root and os.path.isdir(os.path.join(qt_root, 'include')):
        cli_ext_sources = cli_sources  # include curs_main.cpp
        cli_compile_args.append("-DHAS_CURS_MAIN")

        # Detect Qt version: check which env var led us here
        qt_ver = 6 if os.environ.get('Qt6_DIR', '') else 5

        # Qt headers
        qt_inc = os.path.join(qt_root, 'include')
        for sub in ['', 'QtCore', 'QtGui', 'QtWidgets']:
            d = os.path.join(qt_inc, sub) if sub else qt_inc
            if os.path.isdir(d):
                cli_include_dirs.append(d)
        cli_lib_dirs.append(os.path.join(qt_root, 'lib'))
        pfx = 'Qt6' if qt_ver == 6 else 'Qt5'
        cli_libraries.extend([pfx + 'Core', pfx + 'Gui', pfx + 'Widgets'])

        # PDCurses via vcpkg
        if vcpkg:
            triplet = 'x64-windows'
            cli_include_dirs.append(
                os.path.join(vcpkg, 'installed', triplet, 'include'))
            cli_lib_dirs.append(
                os.path.join(vcpkg, 'installed', triplet, 'lib'))
        cli_libraries.append('pdcurses')
    else:
        # No Qt available — exclude curs_main.cpp
        cli_ext_sources = core_cli_sources
else:
    # Unix: enable curs_main with ncurses + Qt (try Qt6, fall back to Qt5)
    cli_compile_args.append("-DHAS_CURS_MAIN")
    cli_libraries.append("ncurses")

    qt_cflags = _pkgconfig("--cflags", "Qt6Widgets")
    qt_libs   = _pkgconfig("--libs",   "Qt6Widgets")
    if not qt_cflags and not qt_libs:
        qt_cflags = _pkgconfig("--cflags", "Qt5Widgets")
        qt_libs   = _pkgconfig("--libs",   "Qt5Widgets")
    cli_include_dirs += [f[2:] for f in qt_cflags if f.startswith("-I")]
    cli_compile_args += [f for f in qt_cflags if not f.startswith("-I")]
    cli_lib_dirs     += [f[2:] for f in qt_libs if f.startswith("-L")]
    cli_libraries    += [f[2:] for f in qt_libs if f.startswith("-l")]
    cli_link_args    += [f for f in qt_libs if not f.startswith(("-L", "-l"))]

ext_modules = [
    Extension(
        "lc3py.core",
        sources=["bindings.cpp"] + backend_sources + core_cli_sources,
        include_dirs=include_dirs,
        language='c++',
        extra_compile_args=compile_args_base,
    ),

    Extension(
        "lc3py.cli_bindings",
        sources=["bindings.cpp"] + backend_sources + cli_ext_sources,
        include_dirs=cli_include_dirs,
        language='c++',
        extra_compile_args=cli_compile_args,
        library_dirs=cli_lib_dirs,
        libraries=cli_libraries,
        extra_link_args=cli_link_args,
    ),
]

setup(
    name="lc3sim",
    version="0.2.0",
    packages=["lc3py"],
    ext_modules=ext_modules,
    cmdclass={"build_ext": build_ext},
    package_data={'lc3py': ['*.py']},
    zip_safe=False,
)
