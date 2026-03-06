from setuptools import setup, Extension
import pybind11
import glob
import os

# All paths are now relative to the root directory
sources = [
    "bindings.cpp",
    *glob.glob("src/backend/*.cpp"),
    *glob.glob("src/utils/*.cpp"),
]

include_dirs = [
    pybind11.get_include(),
    "src/backend",
    "src/utils",
    "include",
]

ext_modules = [
    Extension(
        "lc3py.core",
        sources=sources,
        include_dirs=include_dirs,
        language='c++',
        extra_compile_args=['-std=c++11', '-Wno-error=format-security', '-Wno-format-security'],
    ),
]

setup(
    name="lc3py",
    version="0.1.0",
    packages=["lc3py"],
    ext_modules=ext_modules,
    # This ensures your __init__.py is included in the install
    package_data={'lc3py': ['*.py']}, 
)