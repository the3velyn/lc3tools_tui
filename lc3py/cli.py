import sys
from .cli_bindings import asm_main, sim_main


def lc3asm():
    # Pass terminal arguments to the C++ run function
    sys.exit(asm_main(sys.argv))

def lc3sim():
    sys.exit(sim_main(sys.argv))

def lc3pysim():
    try:
        from .cli_bindings import curs_main
    except ImportError:
        print("lc3pysim is not available on Windows. Use lc3sim instead.",
              file=sys.stderr)
        sys.exit(1)
    sys.exit(curs_main(sys.argv, sys.executable))
