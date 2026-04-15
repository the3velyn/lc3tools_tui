# LC-3 Simulator and Assembler

## Quick Install (pre-built, recommended)

### Windows

Download and run
[`lc3tools.msi`](https://github.com/DougTownsend/lc3tools/releases/latest/download/lc3tools.msi).
The installer adds `lc3asm`, `lc3sim`, and `lc3pysim` to your PATH
automatically. You may need to close and reopen PowerShell after installing.

> If you previously installed lc3tools with pip, uninstall it first to avoid
> conflicts:
>
> ```powershell
> pip3 uninstall lc3py
> pip3 uninstall lc3sim
> ```

If you need to build from source instead, see the
[Windows build instructions](#windows) below.

### Mac / Linux

Make sure Python is installed (see platform specific installation instructions below), then run:

Also make sure to uninstall the `lc3py` package if you installed it previously. It has been renamed to `lc3sim` to avoid a name collision with another python package. Run `pip3 uninstall lc3py`. You will only need to do this once. From then on, you can just use the following command to update the simulator.

```
pip3 install --upgrade lc3sim --extra-index-url https://DougTownsend.github.io/lc3tools/simple/
```

You should now be able to use `lc3asm`, `lc3sim`, and `lc3pysim` in your
terminal.

> **Linux:** `lc3pysim` requires the Qt5 runtime for its display window.
> Install it with:
> - Ubuntu/Debian: `sudo apt install libqt5widgets5`
> - Fedora: `sudo dnf install qt5-qtbase`
>
> `lc3asm` and `lc3sim` work without Qt5.

> **Mac:** `lc3pysim` requires Qt. Install it with: `brew install qt`

---

## Build from Source

Use these instructions if a pre-built wheel is not available for your platform,
or if you want to develop or modify lc3tools.

### Windows

Open PowerShell and run the following commands:

```powershell
winget install Git.Git --source winget
winget install python3 --source winget
```

Next, install the C++ build tools. This will take a few minutes. It works
whether you have no Visual Studio installed or an existing version that is
missing the C++ workload:

```powershell
Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vs_buildtools.exe" -OutFile "$env:TEMP\vs_buildtools.exe"
& "$env:TEMP\vs_buildtools.exe" --passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
```

> **Already have Visual Studio?** The command above adds the C++ workload to
> your existing installation. You can also do this manually: open **Visual
> Studio Installer** from the Start menu, click **Modify**, and check
> **Desktop development with C++**.

Close and reopen PowerShell, then run:

```powershell
cd ~
git clone https://github.com/DougTownsend/lc3tools
cd lc3tools
pip3 install .
```

You should now be able to use `lc3asm`, `lc3sim`, and `lc3pysim` in PowerShell.

### Mac

Open a terminal (press Cmd+Space and type "terminal") and run the following
commands. Each one may prompt for your password or ask you to agree to a
license.

Install the Xcode command-line tools (C++ compiler):

```bash
xcode-select --install
```

Install [Homebrew](https://brew.sh) (Mac's package manager):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

> **Important:** When Homebrew finishes it prints two commands under
> **"Next steps"** that you must copy and run to add it to your PATH.
> They look something like:
>
> ```
> echo >> ~/.zprofile
> eval "$(/opt/homebrew/bin/brew shellenv)"
> ```

Install Python, Qt5, and pkg-config:

```bash
brew install python qt5 pkg-config
```

> **Already have Python from python.org?** That's fine — both can coexist.
> Homebrew's `pip3` will be on your PATH and is the one used below.

Then clone and install:

```bash
cd ~
git clone https://github.com/DougTownsend/lc3tools
cd lc3tools
pip3 install .
```

You should now be able to use `lc3asm`, `lc3sim`, and `lc3pysim` in the
terminal.

### Linux

Install the required system packages with your distribution's package manager.

Ubuntu / Debian:

```bash
sudo apt install git python3 python3-pip g++ pkg-config libncurses-dev qtbase5-dev
```

Fedora:

```bash
sudo dnf install git python3 python3-pip gcc-c++ pkgconf ncurses-devel qt5-qtbase-devel
```

Then clone and install:

```bash
cd ~
git clone https://github.com/DougTownsend/lc3tools
cd lc3tools
pip3 install .
```

You should now be able to use `lc3asm`, `lc3sim`, and `lc3pysim` in the
terminal.

> **Note:** Some distributions require a Python virtual environment for
> `pip install`. If you get an "externally-managed-environment" error, create
> and activate a venv first:
>
> ```bash
> python3 -m venv ~/lc3venv
> source ~/lc3venv/bin/activate
> pip install .
> ```
>
> You will need to run `source ~/lc3venv/bin/activate` each time you open a new
> terminal before using the commands. To make this automatic, add that line to
> the end of your `~/.bashrc` (or `~/.zshrc`).

## Updating (build from source)

To update to the latest stable version:

```bash
cd ~/lc3tools
git pull origin master
pip3 install .
```

## Usage

Using a terminal (or PowerShell on Windows), navigate to the directory that
contains your `.asm` files. A good practice is to create a dedicated folder:

```bash
mkdir ~/ece109
cd ~/ece109
```

This creates a folder at:

- **Windows:** `C:\Users\<your_username>\ece109`
- **Mac:** `/Users/<your_username>/ece109`
- **Linux:** `/home/<your_username>/ece109`

You can use any text editor to create and edit your `.asm` files.

### Assembling

```bash
lc3asm asmfile.asm
```

This creates `asmfile.obj`.

### Simulating

```bash
lc3pysim asmfile.obj
```

To load multiple object files at once:

```bash
lc3pysim file1.obj file2.obj file3.obj
```

Hotkeys for controlling the simulator are shown at the top right of the screen.

While the simulator is running, key presses are forwarded to the LC-3 keyboard.
Press **Esc** to pause the simulator. If the display window is open, keys typed
there are also forwarded to the simulator.
