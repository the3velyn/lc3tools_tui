import sys
from .cli_bindings import asm_main, sim_main
import lc3py

#from .core import sim_backend

def lc3asm():
    # Pass terminal arguments to the C++ run function
    sys.exit(asm_main(sys.argv))

def lc3sim():
    sys.exit(sim_main(sys.argv))

def sim_run(sim, breakpoints, input_text = ""):
    while True:
        sim.step_in()
        if sim.get_pc() in breakpoints:
            print(f"Hit breakpoint at x{sim.get_pc():04X}")
            print(f"x{sim.get_pc():04X}: {sim.read_mem_line(sim.get_pc())}")
            break
        if sim.read_mem(sim.get_pc()) == 0xf025:
            print("\n\nHALT")
            break

def lc3pysim():
    sim = lc3py.Simulator()
    if len(sys.argv) > 1:
        for infile in sys.argv[1:]:
            sp = infile.split(".")
            if len(sp) > 1:
                if sp[-1] == "obj":
                    sim.load_obj(infile)
                else:
                    print(f"{infile} is not an obj file.")
            else:
                print(f"{infile} is not an obj file.")

    breakpoints = []
    
    while True:
        print("> ", end="")
        command = input()
        if command == "quit":
            break
        
        if command[0:3] == "run":
            if len(command) > 4:
                sim_run(sim, breakpoints, command[4:])
            else:
                sim_run(sim, breakpoints)
        
        if command[0:3] == "mem":
            command = command.lower()
            sp = command.split(" ")
            start = 0
            stop = 0
            if len(sp) == 2:
                start = int(sp[1].split("x")[1], 16)
                stop = int(sp[1].split("x")[1], 16)
            elif len(sp) == 3:
                start = int(sp[1].split("x")[1],16)
                stop = int(sp[2].split("x")[1],16)
            for i in range(start, stop+1):
                print(f"x{i:04X}: x{sim.read_mem(i):04X}: {sim.read_mem_line(i)}")
        
        if command == "regs":
            print("Reg\tHex\tuint\tint\tchar")
            for i in range(8):
                val = sim.read_reg(i)
                signedval = val
                if val >= 0x8000:
                    signedval = -((~val + 1) & 0x7fff)
                char = ""
                if abs(signedval) >= 32 and abs(signedval) <= 126:
                    char = chr(abs(signedval))
                elif val == 0:
                    char = "\\0"
                elif abs(signedval) == 10:
                    char = "\\t"
                elif abs(signedval) == 10:
                    char = "\\n"
                elif abs(signedval) == 13:
                    char = "\\r"
                if char != "" and signedval < 0:
                    char = "-" + char
                print(f"R{i}:\tx{val:04X}\t{val}\t{signedval}\t{char}")