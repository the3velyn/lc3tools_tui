cmake_minimum_required(VERSION 3.14)
project(lc3tui LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Fetch FTXUI ──────────────────────────────────────────────────────────────
include(FetchContent)
FetchContent_Declare(
  ftxui
  GIT_REPOSITORY https://github.com/ArthurSonzogni/FTXUI
  GIT_TAG        v5.0.0
  GIT_SHALLOW    TRUE
)
set(FTXUI_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(FTXUI_BUILD_DOCS     OFF CACHE BOOL "" FORCE)
set(FTXUI_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(ftxui)

# ── Backend sources ──────────────────────────────────────────────────────────
file(GLOB BACKEND_SRC "${CMAKE_CURRENT_SOURCE_DIR}/../backend/*.cpp")
file(GLOB COMMON_SRC  "${CMAKE_CURRENT_SOURCE_DIR}/../common/*.cpp")

# ── TUI executable ──────────────────────────────────────────────────────────
add_executable(lc3tui
  lc3tui.cpp
  ${BACKEND_SRC}
  ${COMMON_SRC}
)

target_include_directories(lc3tui PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../backend
  ${CMAKE_CURRENT_SOURCE_DIR}/../common
  ${CMAKE_CURRENT_SOURCE_DIR}/../../include
)

# Only define API_VER=2 for our TUI source, not for backend sources
set_source_files_properties(lc3tui.cpp PROPERTIES COMPILE_DEFINITIONS "API_VER=2")

# Backend's aliases.h is missing #include <cstdint>; force-include it
if(MSVC)
  target_compile_options(lc3tui PRIVATE /FI"cstdint" /wd4996)
else()
  target_compile_options(lc3tui PRIVATE -include cstdint -Wno-format-security)
endif()

target_link_libraries(lc3tui PRIVATE
  ftxui::screen
  ftxui::dom
  ftxui::component
)

find_package(Threads REQUIRED)
target_link_libraries(lc3tui PRIVATE Threads::Threads)
