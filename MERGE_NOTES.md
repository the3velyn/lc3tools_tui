# Upstream Merge Notes

Merge of `DougTownsend/lc3tools` (upstream/dev) into fork `dev` on 2026-04-15.

Fork base before merge: `93dafde` (C++ FTXUI TUI simulator for LC3tools).
Upstream tip merged: `e92a3ca`.

## Scope rules applied

The fork contains two bespoke components based on an older upstream snapshot:

- `src/tui/` — FTXUI-based C++ TUI (`lc3tui`)
- `web/` — browser-based LC-3 tool (untracked in git at merge time)

Per the user's directive, neither was modified. Shared-library, backend,
installer, and CI changes from upstream were accepted.

## Accepted from upstream

- `src/backend/` — interface.cpp/h, state.cpp/h (shared sim library)
- `bindings.cpp` — pybind11 wiring updates (incl. assembler symbol table return)
- `lc3py/__init__.py` — display process integration
- `pyproject.toml` — version + metadata updates
- `readme.md` (new) — upstream docs
- `installer/` — new Windows MSI / wheel build scripts and PyInstaller hooks
- `.github/workflows/build.yml` — CI for wheels and MSI
- `.gitignore`
- Removal of obsolete `src/gui/` Electron GUI, `src/test/` legacy C++ test
  harness, and `test/` regression scripts — upstream deleted these; we
  followed.
- All upstream pycache drops (incidental).

## Excluded / kept-as-ours

- `src/tui/**` — fork's FTXUI TUI (upstream doesn't ship this path; no conflict, nothing to merge).
- `src/cli/curs_main.cpp` — upstream's new ncurses/Qt TUI. **Not imported**
  (treated as a "cpp TUI version" per user instruction). The fork's `setup.py`
  therefore does not need the Qt/PDCurses detection machinery.
- `web/` — fork-only, untracked, untouched.
- `lc3py/cli.py` — kept fork's version. Upstream rewrote this to drop the
  Python TUI helpers; the fork's `lc3tui()` launcher for the FTXUI binary
  would have been lost. Resolution: **kept ours**.
- `setup.py` — kept fork's version. Upstream's rewrite centers on building
  `curs_main.cpp` with Qt on all platforms, which we are not adopting.
  Resolution: **kept ours**.

## Commits folded in (71)

Notable:

- Backend: `9b8c23f` runUntilHaltOrInput, `44db959` step-over TRAP fix,
  `a101083` trap step / label display, `de28dc5` assembler symbol-table return.
- Python CLI / sim (informational — kept fork's cli.py): display process,
  reassemble/goto/clear-console hotkeys, breakpoint fixes, profiling hook,
  pygame-ce switch, process shutdown hardening.
- Packaging/CI: wheel + MSI pipeline, Qt plugin bundling, WiX v4 pin, macOS
  runner bump, Linux yum, 32-bit drop, installer entrypoints.
- Docs: `readme.md` added, multiple readme touch-ups.

## Follow-ups to consider

- Audit backend API changes (`interface.h`, `state.h`) against
  `src/tui/lc3tui.cpp` and the `web/` frontend — signatures or new fields may
  need wiring on both sides.
- If `src/cli/curs_main.cpp` becomes desirable later, it can be cherry-picked
  along with the setup.py Qt detection block from upstream `20635fa` / `6a7be07`.
- `lc3py/cli.py`: consider cherry-picking non-TUI improvements from upstream
  (display process, hotkeys) without pulling in the TUI-removal pieces.
