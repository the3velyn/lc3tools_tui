#include <pybind11/pybind11.h>
#include <pybind11/stl.h>  // Essential for std::string and std::vector conversion
#include "interface.h"     // Include the lc3tools main interface header
#include "utils.h"

namespace py = pybind11;

// Concrete implementation of IPrinter
class PythonPrinter : public lc3::utils::IPrinter {
public:
    void print(std::string const & string) override { std::cout << string;}
    void newline(void) override { std::cout << std::endl; }
    // Added missing method:
    void setColor(lc3::utils::PrintColor color) override { (void)color; } 
};

// Concrete implementation of IInputter
class PythonInputter : public lc3::utils::IInputter {
public:
    bool getChar(char & c) override { return false; }
    // Added missing methods:
    void beginInput(void) override {}
    void endInput(void) override {}
    bool hasRemaining(void) const override { return false; }
};

PYBIND11_MODULE(lc3py, m) {
    m.doc() = "Python bindings for LC-3 Tools Simulator";
    // Bind the Printer interface
    py::class_<PythonPrinter>(m, "Printer")
        .def(py::init<>());

    // Bind the Inputter interface
    py::class_<PythonInputter>(m, "Inputter")
        .def(py::init<>());

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
                // For now, let's just return the filename to Python
                return py::cast(result->first);
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
        
        // Memory and Register Access
        .def("read_mem", &lc3::sim::readMem, "Read value from memory address")
        .def("write_mem", &lc3::sim::writeMem, "Write value to memory address")
        .def("read_reg", &lc3::sim::readReg, "Read a register value (0-7)")
        .def("write_reg", &lc3::sim::writeReg, "Write a register value (0-7)")
        .def("set_pc", &lc3::sim::setPC, "Set the Program Counter")
        .def("get_pc", &lc3::sim::getPC, "Get the Program Counter");

    // Note: You may also need to wrap lc3::utils::IPrinter or 
    // provide a simple wrapper for it to see output in Python.
}
