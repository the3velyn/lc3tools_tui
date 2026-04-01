#include <pybind11/pybind11.h>
#include <pybind11/stl.h>  // Essential for std::string and std::vector conversion
#include "interface.h"     // Include the lc3tools main interface header
#include "utils.h"
#include <cstdio>

namespace py = pybind11;

int asm_main(int argc, char ** const argv);
int sim_main(int argc, char ** const argv);

int asm_main_py(std::vector<std::string> args){
    int argc = static_cast<int>(args.size());
    std::vector<char*> argv;
    for (const auto& arg : args) {
        argv.push_back(const_cast<char*>(arg.c_str()));
    }

    return asm_main(argc, argv.data());
}

int sim_main_py(std::vector<std::string> args){
    int argc = static_cast<int>(args.size());
    std::vector<char*> argv;
    for (const auto& arg : args) {
        argv.push_back(const_cast<char*>(arg.c_str()));
    }

    return sim_main(argc, argv.data());
}

// Concrete implementation of IPrinter
class PythonPrinter : public lc3::utils::IPrinter{
public:
    PythonPrinter() {buffer = "";};
    std::string buffer;
    std::string retstr; //Allows passing a c_str pointer to python
    void print(std::string const & string) override { buffer = buffer + string;}
    std::string read(){
        retstr = buffer;
        buffer = "";
        /*
        I am doing it this way because the simulator writes a bunch of garbage
        to the buffer when the instruction limit is reached, but it starts with
        a \0 character, so returning the C string prevents python from trying
        to print garbage and crashing. -Doug
        */
        return retstr.c_str();
    }
    void newline(void) override { buffer = buffer + "\n"; }
    void setColor(lc3::utils::PrintColor color) override { (void)color; } 
};

// Concrete implementation of IInputter
class PythonInputter : public lc3::utils::IInputter {
public:
    std::string buffer;
    uint32_t idx;
    void setInput(std::string in) {
        if(idx >= buffer.length()){
            buffer = in;
            idx = 0;
        } else {
            buffer = buffer + in;
        }
    }
    bool getChar(char & c) override {
        if(idx < buffer.length()){
            c = buffer[idx++];
            return true;
        } else {
            return false;
        }
    }
    // Added missing methods:
    void beginInput(void) override {}
    void endInput(void) override {}
    bool hasRemaining(void) const override { return false; }
};

PYBIND11_MODULE(cli_bindings, m) {

    m.def("asm_main", [](std::vector<std::string> args) {
        // ... conversion logic ...
        return asm_main_py(args);
    });
    
    m.def("sim_main", [](std::vector<std::string> args) {
        // ... conversion logic ...
        return sim_main_py(args);
    });
}


PYBIND11_MODULE(core, m) {
    m.doc() = "Python bindings for LC-3 Tools Simulator";


    // Bind the Printer interface
    py::class_<PythonPrinter>(m, "Printer")
        .def(py::init<>())
        .def("read", &PythonPrinter::read, "return the contents of the buffer, and clear it");

    // Bind the Inputter interface
    py::class_<PythonInputter>(m, "Inputter")
        .def(py::init<>())
        .def("set_input", &PythonInputter::setInput, "Set the input to the program");

// --- Assembler Binding ---
    py::class_<lc3::as>(m, "Assembler")
        .def(py::init([](PythonPrinter & p, uint32_t print_level, bool enable_liberal_asm) {
            return new lc3::as(p, print_level, enable_liberal_asm);
        }), py::arg("printer"), py::arg("print_level") = 1, py::arg("enable_liberal_asm") = false)
        
        // Custom wrapper for assemble to handle lc3::optional and the complex return type
        .def("assemble", [](lc3::as &self, std::string const & asm_filename) -> py::object {
            // Call the actual C++ function
            auto result = self.assemble(asm_filename);
            
            // Check if the lc3::optional has a value (assuming it has has_value() or operator bool)
            if (result) {
                // result->first is the string filename
                // result->second is the symbol table (map)
                return py::cast(std::make_pair(result->first, result->second));
            } else {
                // Return None if assembly failed
                return py::none();
            }
        }, py::arg("asm_filename"), "Assembles a file and returns the output filename or None");

    // Bind the lc3::sim class
    py::class_<lc3::sim>(m, "Simulator")
        .def(py::init([](PythonPrinter &p, PythonInputter &i, uint32_t level) {
            return new lc3::sim(p, i, level);
        }))
        // Basic Execution
        .def("load_object_file", &lc3::sim::loadObjFile, "Load a .obj file into memory")
        .def("run", &lc3::sim::run, "Run the simulator until HALT or breakpoint")
        .def("step_in", &lc3::sim::stepIn, "Execute a single instruction")
        .def("step_over", &lc3::sim::stepOver, "Execute a single instruction")
        .def("step_out", &lc3::sim::stepOut, "Execute a single instruction")
        .def("randomize", &lc3::sim::randomizeState, "Randomize the simulator memory and regs")
        .def("reinit", &lc3::sim::zeroState, "Reinitialize the simulator")
        
        // Memory and Register Access
        .def("read_psr", &lc3::sim::readPSR, "Read the PSR")
        .def("read_mem", &lc3::sim::readMem, "Read value from memory address")
        .def("read_mem_line", &lc3::sim::getMemLine, "Read asm or bin line of memory at address")
        .def("write_mem", &lc3::sim::writeMem, "Write value to memory address")
        .def("read_reg", &lc3::sim::readReg, "Read a register value (0-7)")
        .def("write_reg", &lc3::sim::writeReg, "Write a register value (0-7)")
        .def("set_pc", &lc3::sim::setPC, "Set the Program Counter")
        .def("get_pc", &lc3::sim::getPC, "Get the Program Counter")
        .def("set_inst_limit", &lc3::sim::setRunInstLimit, "Set instruction limit")
        .def("exceeded_inst_limit", &lc3::sim::didExceedInstLimit, "return true if instruction limit reached");

    // Note: You may also need to wrap lc3::utils::IPrinter or 
    // provide a simple wrapper for it to see output in Python.
}
