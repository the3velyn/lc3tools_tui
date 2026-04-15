from .core import Simulator as _Simulator, Assembler, Printer, Inputter
import time


class Simulator:

    def __init__(self, rand=False):
        self.input = Inputter()
        self.output = Printer()
        self.asm = Assembler(self.output, 4)
        self.sim = _Simulator(self.output, self.input, 1)
        if rand:
            self.randomize()

    def read(self):
        return self.output.read()

    def print(self):
        print(self.read())
    
    def write(self, str):
        self.input.set_input(str)
    
    def assemble(self, asmfile, ret_symtab=False):
        if not ret_symtab:
            asm = self.asm.assemble(asmfile)
            if asm != None:
                return asm[0]
            else:
                return None
        else:
            return self.asm.assemble(asmfile)

    def load_obj(self, objfile):
        return self.sim.load_object_file(objfile)

    def run(self):
        return self.sim.run()
    
    def step_in(self):
        return self.sim.step_in()
    
    def step_over(self):
        return self.sim.step_over()
    
    def read_mem(self, addr):
        return self.sim.read_mem(addr)

    def write_mem(self, addr, value):
        self.sim.write_mem(addr, value)
    
    def read_mem_line(self, addr):
        return self.sim.read_mem_line(addr)

    def read_reg(self, reg):
        return self.sim.read_reg(reg)

    def write_reg(self, reg, value):
        self.sim.write_reg(reg, value)

    def read_psr(self):
        return self.sim.read_psr()

    def get_pc(self):
        return self.sim.get_pc()
    
    def set_pc(self, value):
        self.sim.set_pc(value)
    
    def set_inst_limit(self, value):
        self.sim.set_inst_limit(value)

    def exceeded_inst_limit(self):
        return self.sim.exceeded_inst_limit()
    
    def randomize(self):
        return self.sim.randomize(int(time.time()))

    def reinit(self):
        return self.sim.reinit()

    def run_until_halt_or_input(self, inst_limit=0):
        """Run until PC points to HALT or GETC.
        Returns True if stopped at GETC, False if stopped at HALT.
        If already at HALT, does nothing. If already at GETC, steps past
        it and runs to the next HALT or GETC."""
        return self.sim.run_until_halt_or_input(inst_limit)