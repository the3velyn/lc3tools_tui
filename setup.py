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

compile_args_base = []
if sys.platform != 'win32':
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
    # Windows: no ncurses or Qt5 — exclude curs_main.cpp
    cli_ext_sources = core_cli_sources
else:
    # Unix: enable curs_main with ncurses + Qt5
    cli_compile_args.append("-DHAS_CURS_MAIN")
    cli_libraries.append("ncurses")

    qt5_cflags = _pkgconfig("--cflags", "Qt5Widgets")
    qt5_libs   = _pkgconfig("--libs",   "Qt5Widgets")
    cli_include_dirs += [f[2:] for f in qt5_cflags if f.startswith("-I")]
    cli_compile_args += [f for f in qt5_cflags if not f.startswith("-I")]
    cli_lib_dirs     += [f[2:] for f in qt5_libs if f.startswith("-L")]
    cli_libraries    += [f[2:] for f in qt5_libs if f.startswith("-l")]
    cli_link_args    += [f for f in qt5_libs if not f.startswith(("-L", "-l"))]

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
    name="lc3py",
    version="0.1.0",
    packages=["lc3py"],
    ext_modules=ext_modules,
    cmdclass={"build_ext": build_ext},
    package_data={'lc3py': ['*.py']},
    zip_safe=False,
)
