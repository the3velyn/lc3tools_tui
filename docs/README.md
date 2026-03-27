# Evelyn's **lc3tools** fork: a C++ TUI with additional quality-of-life features.
### Prerequisites:
- Python >3.14
- CMake
## Installing on Windows:
Prerequisites:
```powershell
winget install Git.Git --source winget
winget install python3 --source winget
```
Installation/Update:
```powershell
cd ~
git clone https://github.com/the3velyn/lc3tools_tui
cd lc3tools_tui
pip3 install .
```
## Usage:
- `lc3tui PROGRAM.asm`: run lc3 assembly program in PROGRAM.asm.
- `lc3tui PROGRAM.obj`: legacy support to run pre-compiled programs.
- `lc3asm PROGRAM.asm`: compile PROGRAM.asm into PROGRAM.obj.
- `lc3pysim PROGRAM.obj`: run a compiled program called PROGRAM using python. Made by DougTownsend, unmodified.
## Additional Features (`lc3tui` only):
- The simulator now takes .asm file and assembles the program in-house, exiting and printing errors if any occur.
  - It can accept .obj programs for backwards compatibility.
- Profiling if run with `--profile` flag.
- Z: zip/jump to location in memory (hex code or label), unlocks memory window. Does not move PC.
- R: run at full speed; "Race to halt".
- S: slow run, step every 0.5s.
  - Note that "step" functionality is removed, a single instruction can be executed by pressing S + Esc within 0.5s.
- T: toggle race-subs; ON means subroutines will run at full speed (similar to STEP OVER), OFF means subroutines will slow run (like STEP IN).
- Esc: pause simulator if running.
- Q: quit simulator if paused.
- J/K: scroll memory.
- H/L: move pane division.
- All labels are preserved in the memory window.
- The breakpoints hotkey can use labels, and configure priority for cases where labels look like hex codes.
- Color coding in the memory window: labels have a color and standard syntax highlighting is used on lc3 instructions.
- If a register contains a direct address in the user space that has a label, the label appears in register area.
  - Ex.: `lea r0, str_prompt1`: `r0` will show `@str_prompt1`. This works through traps as well.
