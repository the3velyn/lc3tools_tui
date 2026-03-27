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
Installation:
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

## Additional Features:
- The simulator now takes .asm file and assembles the program in-house, exiting and printing errors if any occur.
  - It can accept .obj programs for backwards compatibility.
- Z: zip/jump to location in memory (hex code or label), unlocks memory window.
- All labels are preserved in the memory window.
- The breakpoints hotkey can use labels, and configure priority for cases where labels look like hex codes.
- Color coding in the memory window: labels have a color and standard syntax highlighting is used on lc3 instructions.
- If a register contains a direct address in the user space that has a label, the label appears in register area.
  - Ex.: `lea r0, str_prompt1`: `r0` will show `@str_prompt1`. This works through traps as well.
