from setuptools import setup, Extension
from pybind11.setup_helpers import build_ext as _build_ext
import pybind11
import glob
import os
import shutil
import subprocess
import sys

compile_args = []
if sys.platform != 'win32':
    compile_args = ['-Wno-error=format-security', '-Wno-format-security', '-fvisibility=default', '-std=c++11']

sources = [
    "bindings.cpp",
    *glob.glob("src/backend/*.cpp"),
    *glob.glob("src/utils/*.cpp"),
    *glob.glob("src/cli/*.cpp"),
    *glob.glob("src/common/*.cpp"),
]

include_dirs = [
    pybind11.get_include(),
    "src/backend",
    "src/utils",
    "include",
    "src/cli",
    "src/common",
]

ext_modules = [
    Extension(
        "lc3py.core",
        sources=sources,
        include_dirs=include_dirs,
        language='c++',
        extra_compile_args=compile_args,
    ),

    Extension(
        "lc3py.cli_bindings",
        sources=sources,
        include_dirs=include_dirs,
        language='c++',
        extra_compile_args=compile_args,
    ),
]


class build_ext(_build_ext):
    """Extended build_ext that also compiles the C++ FTXUI TUI binary via CMake."""
    def run(self):
        _build_ext.run(self)
        try:
            self._build_tui()
        except Exception as e:
            print("WARNING: failed to build lc3tui: %s" % e)
            print("The lc3tui command will not be available.")
            print("Make sure CMake >= 3.14 is installed.")

    def _build_tui(self):
        base = os.path.dirname(os.path.abspath(__file__))
        tui_dir = os.path.join(base, "src", "tui")
        if not os.path.exists(os.path.join(tui_dir, "CMakeLists.txt")):
            return

        # Check that cmake is available
        try:
            subprocess.check_output(["cmake", "--version"])
        except (FileNotFoundError, subprocess.CalledProcessError):
            print("WARNING: cmake not found, skipping lc3tui build.")
            return

        build_dir = os.path.join(self.build_temp, "tui_build")
        os.makedirs(build_dir, exist_ok=True)

        out_dir = self.build_lib if self.build_lib else "."
        pkg_dir = os.path.join(out_dir, "lc3py")
        os.makedirs(pkg_dir, exist_ok=True)

        # Configure
        cmake_args = ["cmake", tui_dir, "-DCMAKE_BUILD_TYPE=Release"]
        if sys.platform == 'win32':
            cmake_args += ["-A", "x64"]

        print("configuring lc3tui (fetching FTXUI)...")
        subprocess.check_call(cmake_args, cwd=build_dir)

        # Build
        print("building lc3tui...")
        subprocess.check_call(
            ["cmake", "--build", ".", "--config", "Release"],
            cwd=build_dir,
        )

        # Find and copy binary to package directory
        binary_name = "lc3tui.exe" if sys.platform == 'win32' else "lc3tui"
        candidates = [
            os.path.join(build_dir, binary_name),
            os.path.join(build_dir, "Release", binary_name),
        ]
        for src in candidates:
            if os.path.exists(src):
                dest = os.path.join(pkg_dir, binary_name)
                shutil.copy2(src, dest)
                # Also copy to source lc3py/ for editable installs
                src_pkg = os.path.join(base, "lc3py")
                src_dest = os.path.join(src_pkg, binary_name)
                if os.path.abspath(dest) != os.path.abspath(src_dest):
                    shutil.copy2(src, src_dest)
                print("lc3tui built successfully: %s" % dest)
                return

        print("WARNING: lc3tui binary not found after build.")


setup(
    name="lc3py",
    version="0.1.0",
    packages=["lc3py"],
    ext_modules=ext_modules,
    cmdclass={"build_ext": build_ext},
    package_data={'lc3py': ['*.py', 'lc3tui', 'lc3tui.exe']},
    zip_safe=False,
)
