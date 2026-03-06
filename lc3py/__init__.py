from .core import Simulator as _Simulator, Assembler, Printer, Inputter



class Simulator:

    def __init__(self):
        self.input = Inputter()
        self.output = Printer()
        self.asm = Assembler(self.output, 4)
        self.sim = _Simulator(self.output, self.input, 1)

    def read(self):
        return self.output.read()
    
    def write(self, str):
        self.input.set_input(str)
    
    def assemble(self, asmfile):
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

    def read_reg(self, reg):
        return self.sim.read_reg(reg)

    def write_reg(self, reg, value):
        self.sim.write_reg(reg, value)

    def get_pc(self):
        return self.sim.get_pc()
    
    def set_pc(self, value):
        self.sim.set_pc(value)
    