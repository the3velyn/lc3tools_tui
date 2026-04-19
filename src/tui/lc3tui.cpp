/*
 * LC-3 FTXUI TUI debugger
 * C++ port of lc3py/cli.py — eliminates Python/multiprocessing overhead.
 * Links directly against the C++ backend for zero-overhead register/memory access.
 * Uses FTXUI for cross-platform terminal UI (Windows/Linux/macOS, no curses needed).
 */
#include <ftxui/component/component.hpp>
#include <ftxui/component/event.hpp>
#include <ftxui/component/screen_interactive.hpp>
#include <ftxui/dom/elements.hpp>
#include <ftxui/screen/terminal.hpp>

#include <string>
#include <vector>
#include <deque>
#include <set>
#include <unordered_map>
#include <mutex>
#include <thread>
#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <fstream>
#include <sstream>

#define API_VER 2

// ── Profiler ────────────────────────────────────────────────────────────────

struct ProfileSection {
    std::string name;
    double total_ms = 0;
    uint64_t call_count = 0;
    double max_ms = 0;
};

struct Profiler {
    bool enabled = false;
    std::chrono::steady_clock::time_point program_start;
    std::unordered_map<std::string, ProfileSection> sections;

    void start() {
        program_start = std::chrono::steady_clock::now();
    }

    void record(const std::string & name, double ms) {
        if (!enabled) return;
        auto & s = sections[name];
        s.name = name;
        s.total_ms += ms;
        s.call_count++;
        if (ms > s.max_ms) s.max_ms = ms;
    }

    void write(const char * filename) {
        if (!enabled) return;
        auto elapsed = std::chrono::steady_clock::now() - program_start;
        double total_s = std::chrono::duration<double>(elapsed).count();

        std::ofstream f(filename);
        f << "LC3 TUI Profile\n";
        f << "================\n";
        f << "Total runtime: " << total_s << "s\n\n";
        f << std::left;

        // Sort by total time descending
        std::vector<ProfileSection*> sorted;
        for (auto & p : sections) sorted.push_back(&p.second);
        std::sort(sorted.begin(), sorted.end(),
            [](ProfileSection* a, ProfileSection* b) { return a->total_ms > b->total_ms; });

        char buf[256];
        snprintf(buf, sizeof(buf), "%-25s %10s %10s %10s %10s\n",
                 "Section", "Total(ms)", "Calls", "Avg(ms)", "Max(ms)");
        f << buf;
        snprintf(buf, sizeof(buf), "%-25s %10s %10s %10s %10s\n",
                 "-------", "---------", "-----", "-------", "-------");
        f << buf;

        for (auto * s : sorted) {
            double avg = s->call_count > 0 ? s->total_ms / s->call_count : 0;
            snprintf(buf, sizeof(buf), "%-25s %10.1f %10lu %10.3f %10.3f\n",
                     s->name.c_str(), s->total_ms, (unsigned long)s->call_count, avg, s->max_ms);
            f << buf;
        }
    }
};

static Profiler g_profiler;

struct ScopedTimer {
    std::string name;
    std::chrono::steady_clock::time_point t0;
    ScopedTimer(const std::string & n) : name(n), t0(std::chrono::steady_clock::now()) {}
    ~ScopedTimer() {
        auto t1 = std::chrono::steady_clock::now();
        double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
        g_profiler.record(name, ms);
    }
};
#include "interface.h"

using namespace ftxui;

// ── I/O adapters ────────────────────────────────────────────────────────────

class TuiPrinter : public lc3::utils::IPrinter {
public:
    void setColor(lc3::utils::PrintColor) override {}
    void print(std::string const & s) override {
        std::lock_guard<std::mutex> lk(mtx);
        buf += s;
    }
    void newline() override {
        std::lock_guard<std::mutex> lk(mtx);
        buf += "\n";
    }
    std::string flush() {
        std::lock_guard<std::mutex> lk(mtx);
        std::string tmp;
        tmp.swap(buf);
        return tmp;
    }
private:
    std::mutex mtx;
    std::string buf;
};

class TuiInputter : public lc3::utils::IInputter {
public:
    void beginInput() override {}
    void endInput() override {}
    bool hasRemaining() const override {
        std::lock_guard<std::mutex> lk(mtx);
        return idx < buf.size();
    }
    bool getChar(char & c) override {
        std::lock_guard<std::mutex> lk(mtx);
        if (idx < buf.size()) { c = buf[idx++]; return true; }
        return false;
    }
    void feed(char c) {
        std::lock_guard<std::mutex> lk(mtx);
        buf += c;
    }
private:
    mutable std::mutex mtx;
    std::string buf;
    size_t idx = 0;
};

// ── Shared state ────────────────────────────────────────────────────────────

enum class Mode { BREAK, RUNNING, SLOW_RUN, SET_BREAKPOINT, GOTO_ADDRESS };

// Display peripheral framebuffer: upstream pygame display renders a
// 128×124 grid starting at 0xC000, one word per cell with 5-6-5 RGB.
static constexpr uint16_t DISP_BASE = 0xC000;
static constexpr int DISP_W = 128;
static constexpr int DISP_H = 124;

struct SharedState {
    std::mutex mtx;

    uint16_t regs[8] = {};
    uint16_t prev_regs[8] = {};
    uint16_t pc = 0x01FE;
    uint16_t prev_pc = 0x01FE;
    uint16_t psr = 0;
    uint16_t rti_pc = 0x3000;
    struct MemEntry { uint16_t addr; uint16_t val; std::string line; };
    std::vector<MemEntry> mem_snapshot;

    // Symbol table: address → label name (built once after loading .obj)
    std::unordered_map<uint16_t, std::string> symbols;
    // Cached label lookups for current register values (updated in snapshot)
    std::string reg_sym[8];

    std::deque<std::string> console_lines;
    // Console scroll offset: 0 == follow tail (auto-scroll), N == lines from bottom
    std::atomic<int> console_scroll{0};

    // Input sources loaded at startup — used to reassemble (B2) and reinit (B3).
    std::vector<std::string> asm_sources;   // original .asm paths
    std::vector<std::string> obj_sources;   // .obj paths (incl. those assembled from .asm)

    std::atomic<Mode> mode{Mode::BREAK};
    std::atomic<bool> quit{false};
    std::atomic<bool> restart{false};       // reset PC only
    std::atomic<bool> reinit{false};        // zero state + reload obj files
    std::atomic<bool> reassemble{false};    // run assembler on asm_sources
    std::atomic<bool> step_in{false};       // single stepIn pending
    std::atomic<bool> step_over{false};     // single stepOver pending
    std::atomic<bool> mem_locked{false};
    std::atomic<int>  baseaddr{0x01FE};
    std::atomic<int>  col0width{45};

    // Slow run: race through subroutines (JSR/JSRR/TRAP) at full speed
    std::atomic<bool> race_subroutines{true};

    // Display peripheral panel visible
    std::atomic<bool> display_visible{false};
    // Snapshot of framebuffer (read each tick when visible)
    std::vector<uint16_t> disp_snapshot;

    std::set<uint16_t> breakpoints;
    std::string bp_entry;
    std::string goto_entry;

    std::atomic<int> mem_rows{20};
};

// ── Simulator thread ────────────────────────────────────────────────────────

// Forward declaration (defined later with label parsing)
static std::pair<std::string, std::string> split_label(const std::string & line);

static bool is_trap(uint16_t instr) {
    return (instr >> 12) == 0xF && instr != 0xF025;
}

static bool is_jsr(uint16_t instr) {
    return (instr >> 12) == 0x4;
}

static void sim_thread(SharedState & st, TuiPrinter & printer, TuiInputter & inputter,
                       int /*argc*/, char ** /*argv*/, ScreenInteractive & screen)
{
    lc3::sim simulator(printer, inputter, 4);

    // Load pre-assembled .obj files (assembly done in main before TUI starts).
    // Paths were pre-resolved into st.obj_sources so we can reload on reinit.
    {
        std::lock_guard<std::mutex> lk(st.mtx);
        for (auto & obj : st.obj_sources)
            simulator.loadObjFile(obj);
    }
    simulator.writePC(0x3000);

    // For .obj-only files, fall back to scanning memory lines for labels
    {
        std::lock_guard<std::mutex> lk(st.mtx);
        for (uint16_t addr = 0x3000; addr < 0xFE00; ++addr) {
            // Skip addresses already in symbol table from assembler
            if (st.symbols.count(addr)) continue;

            std::string line = simulator.getMemLine(addr);
            if (line.empty() || line.size() == 1) continue;

            auto parts = split_label(line);
            if (parts.first.empty()) continue;

            std::string lower_instr = parts.second;
            std::transform(lower_instr.begin(), lower_instr.end(), lower_instr.begin(), ::tolower);

            if (parts.second.empty()) {
                if (addr + 1 < 0xFE00 && !st.symbols.count(addr + 1))
                    st.symbols[addr + 1] = parts.first;
            } else if (lower_instr.find(".stringz") != std::string::npos) {
                uint16_t start = addr;
                while (start > 0x3000) {
                    std::string prev = simulator.getMemLine(start - 1);
                    if (prev.size() == 1)
                        --start;
                    else
                        break;
                }
                if (!st.symbols.count(start))
                    st.symbols[start] = parts.first;
            } else {
                st.symbols[addr] = parts.first;
            }
        }
    }

    bool racing_sub = false;   // currently racing through a subroutine
    std::set<uint16_t> local_bp;
    bool skip_bp_once = false; // skip breakpoint check for one step after resuming

    // Assembler reused for live reassemble ('a').  Errors go into a dedicated
    // printer buffer so they land in the console, not the LC-3 output stream.
    TuiPrinter as_printer;
    lc3::as assembler(as_printer, 4, true);

    auto reload_objs = [&]() {
        std::lock_guard<std::mutex> lk(st.mtx);
        for (auto & obj : st.obj_sources)
            simulator.loadObjFile(obj);
    };

    auto push_console = [&](const std::string & s) {
        std::lock_guard<std::mutex> lk(st.mtx);
        for (char c : s) {
            if (c == '\n') st.console_lines.push_back("");
            else {
                if (st.console_lines.empty()) st.console_lines.push_back("");
                st.console_lines.back() += c;
            }
        }
        while (st.console_lines.size() > 500) st.console_lines.pop_front();
    };

    auto next_update = std::chrono::steady_clock::now();
    auto next_slow_step = std::chrono::steady_clock::now();
    Mode prev_mode = Mode::BREAK;

    while (!st.quit.load()) {
        // Check for HALT (instruction at PC is TRAP x25) or machine clock stopped
        bool machine_halted = (simulator.readMem(simulator.readPC()) == 0xF025)
                           || !(simulator.readMCR() & 0x8000);
        if (machine_halted) {
            st.mode.store(Mode::BREAK);
            racing_sub = false;
        }

        Mode m = st.mode.load();

        // Detect mode transition: reset racing state and set skip flag
        if (prev_mode != m) {
            if (m == Mode::RUNNING || m == Mode::SLOW_RUN) {
                if (prev_mode == Mode::BREAK) skip_bp_once = true;
                racing_sub = false;
            }
        }
        prev_mode = m;

        if (m == Mode::RUNNING) {
            // Full speed — execute as fast as possible
            if (!skip_bp_once && local_bp.count(simulator.readPC())) {
                st.mode.store(Mode::BREAK);
            } else {
                skip_bp_once = false;
                simulator.stepIn();
            }
        } else if (m == Mode::SLOW_RUN) {
            if (racing_sub) {
                simulator.stepIn();
                if (simulator.readPC() >= 0x3000) {
                    racing_sub = false;
                }
                if (local_bp.count(simulator.readPC())) {
                    racing_sub = false;
                    st.mode.store(Mode::BREAK);
                }
            } else {
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
            }
        } else {
            // BREAK or SET_BREAKPOINT — idle
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }

        // Periodic state snapshot & slow-run step
        auto now = std::chrono::steady_clock::now();
        if (now >= next_update) {
            next_update = now + std::chrono::milliseconds(50);

            {
                std::lock_guard<std::mutex> lk(st.mtx);
                local_bp = st.breakpoints;
            }

            m = st.mode.load();

            if (st.restart.load()) {
                st.restart.store(false);
                simulator.writePC(0x3000);
                racing_sub = false;
            }

            // B3: reinit — zero all memory/registers then reload obj files.
            if (st.reinit.load()) {
                st.reinit.store(false);
                simulator.zeroState();        // A2
                reload_objs();
                simulator.writePC(0x3000);
                racing_sub = false;
                st.mode.store(Mode::BREAK);
            }

            // B2: live reassemble — re-run the assembler on each .asm source
            // then reload everything.  Errors surface in the console.
            if (st.reassemble.load()) {
                st.reassemble.store(false);
                bool ok = true;
                std::vector<std::string> new_objs;
                std::unordered_map<uint16_t, std::string> new_syms;
                {
                    std::lock_guard<std::mutex> lk(st.mtx);
                    for (auto & asmf : st.asm_sources) {
                        auto result = assembler.assemble(asmf);
                        std::string err = as_printer.flush();
                        if (!err.empty()) push_console(err);
                        if (!result) {
                            push_console("[reassemble failed: " + asmf + "]\n");
                            ok = false;
                            continue;
                        }
                        new_objs.push_back((*result).first);
                        for (auto & pair : (*result).second)
                            new_syms[(uint16_t)pair.second] = pair.first;
                    }
                    // Preserve any obj files that weren't produced from an .asm source
                    for (auto & obj : st.obj_sources) {
                        bool produced = false;
                        for (auto & asmf : st.asm_sources) {
                            std::string expected = asmf.substr(0, asmf.size() > 4 ? asmf.size()-4 : 0) + ".obj";
                            if (obj == expected) { produced = true; break; }
                        }
                        if (!produced) new_objs.push_back(obj);
                    }
                    st.obj_sources = new_objs;
                    st.symbols = new_syms;
                }
                if (ok) {
                    simulator.zeroState();
                    reload_objs();
                    simulator.writePC(0x3000);
                    push_console("[reassembled OK]\n");
                }
                racing_sub = false;
                st.mode.store(Mode::BREAK);
            }

            // A5: step-over — backend tracks subroutine depth and returns
            // when the CALL returns (or the current instruction completes).
            if (st.step_over.load()) {
                st.step_over.store(false);
                if (simulator.readMem(simulator.readPC()) != 0xF025) {
                    simulator.stepOver();
                }
                racing_sub = false;
                st.mode.store(Mode::BREAK);
            }
            if (st.step_in.load()) {
                st.step_in.store(false);
                if (simulator.readMem(simulator.readPC()) != 0xF025) {
                    simulator.stepIn();
                }
                racing_sub = false;
                st.mode.store(Mode::BREAK);
            }

            // Slow run: execute one instruction per 500ms
            if (m == Mode::SLOW_RUN && !racing_sub && now >= next_slow_step) {
                next_slow_step = now + std::chrono::milliseconds(500);
                uint16_t instr = simulator.readMem(simulator.readPC());
                if (instr != 0xF025) {
                    // Traps always race through; JSR/JSRR race only if toggle is on
                    if (is_trap(instr) || (st.race_subroutines.load() && is_jsr(instr))) {
                        simulator.stepIn();
                        racing_sub = true;
                    } else {
                        simulator.stepIn();
                    }

                    if (local_bp.count(simulator.readPC())) {
                        st.mode.store(Mode::BREAK);
                        racing_sub = false;
                    }
                } else {
                    st.mode.store(Mode::BREAK);
                    racing_sub = false;
                }
            }

            // Flush printer -> console
            {ScopedTimer _t("flush_console");
            std::string out = printer.flush();
            if (!out.empty()) {
                std::lock_guard<std::mutex> lk(st.mtx);
                for (char c : out) {
                    if (c == '\n') {
                        st.console_lines.push_back("");
                    } else {
                        if (st.console_lines.empty()) st.console_lines.push_back("");
                        st.console_lines.back() += c;
                    }
                }
                while (st.console_lines.size() > 500)
                    st.console_lines.pop_front();
            }
            } // end flush_console timer

            // Snapshot registers & memory
            {
                ScopedTimer _t("sim_snapshot");
                std::lock_guard<std::mutex> lk(st.mtx);
                // Save previous state for change highlighting
                for (int i = 0; i < 8; ++i)
                    st.prev_regs[i] = st.regs[i];
                st.prev_pc = st.pc;
                // Snapshot current state
                for (int i = 0; i < 8; ++i)
                    st.regs[i] = simulator.readReg(i);
                st.pc = simulator.readPC();
                st.psr = simulator.readPSR();
                st.rti_pc = simulator.readMem(0x2FFE);

                // Look up register values against symbol table
                for (int i = 0; i < 8; ++i) {
                    auto it = st.symbols.find(st.regs[i]);
                    st.reg_sym[i] = (it != st.symbols.end()) ? it->second : "";
                }


                int base = st.baseaddr.load();
                int rows = st.mem_rows.load();
                st.mem_snapshot.clear();
                st.mem_snapshot.reserve(rows);
                for (int i = 0; i < rows; ++i) {
                    uint16_t addr = (uint16_t)(base + i);
                    SharedState::MemEntry e;
                    e.addr = addr;
                    e.val = simulator.readMem(addr);
                    e.line = simulator.getMemLine(addr);
                    st.mem_snapshot.push_back(e);
                }

                // B8: snapshot framebuffer only when panel is visible.
                // readMem per cell is slow but adequate at 20Hz for a
                // 128×124 region; upstream uses flatMemPtr for this but
                // we don't have it plumbed into lc3::sim with API_VER=2.
                if (st.display_visible.load()) {
                    st.disp_snapshot.resize(DISP_W * DISP_H);
                    for (int i = 0; i < DISP_W * DISP_H; ++i) {
                        uint32_t a = (uint32_t)DISP_BASE + i;
                        st.disp_snapshot[i] = (a <= 0xFFFF)
                            ? simulator.readMem((uint16_t)a) : 0;
                    }
                }
            }

            // Wake FTXUI to re-render with fresh state
            screen.Post(Event::Custom);
        }
    }
}

// ── Formatting helpers ──────────────────────────────────────────────────────

static std::string char_repr(int16_t val, uint16_t uval) {
    std::string ch;
    int av = abs(val);
    if (av >= 32 && av <= 126)       ch = std::string("'") + (char)av + "'";
    else if (uval == 0)              ch = "'\\0'";
    else if (av == 9)                ch = "'\\t'";
    else if (av == 10)               ch = "'\\n'";
    else if (av == 13)               ch = "'\\r'";
    if (!ch.empty() && val < 0)      ch = "-" + ch;
    return ch;
}

static int16_t to_signed(uint16_t v) {
    return (v >= 0x8000) ? -(int16_t)((~v + 1) & 0x7FFF) : (int16_t)v;
}

static std::string fmt(const char * format, ...) {
    char buf[256];
    va_list args;
    va_start(args, format);
    vsnprintf(buf, sizeof(buf), format, args);
    va_end(args);
    return std::string(buf);
}

// ── Label / instruction parsing ──────────────────────────────────────────────

static const char * LC3_MNEMONICS[] = {
    "ADD", "AND", "BR", "BRN", "BRZ", "BRP", "BRNZ", "BRZP", "BRNP", "BRNZP",
    "JMP", "JSR", "JSRR", "LD", "LDI", "LDR", "LEA", "NOT", "RET", "RTI",
    "ST", "STI", "STR", "TRAP", "GETC", "OUT", "PUTC", "PUTS", "IN", "PUTSP", "HALT",
    ".ORIG", ".END", ".FILL", ".BLKW", ".STRINGZ",
    nullptr
};

// Split a source line into (label, instruction_with_operands).
// If no label, label is empty.
static std::pair<std::string, std::string> split_label(const std::string & line) {
    if (line.empty()) return {"", ""};

    // Find first non-whitespace token
    size_t start = line.find_first_not_of(" \t");
    if (start == std::string::npos) return {"", ""};

    // Find end of first token
    size_t end = line.find_first_of(" \t", start);
    std::string first_token = (end == std::string::npos)
        ? line.substr(start) : line.substr(start, end - start);

    // Uppercase for comparison
    std::string upper = first_token;
    std::transform(upper.begin(), upper.end(), upper.begin(), ::toupper);

    // Check if first token is a known mnemonic
    for (const char ** m = LC3_MNEMONICS; *m; ++m) {
        if (upper == *m) {
            // No label — the whole line is the instruction
            return {"", line.substr(start)};
        }
    }

    // First token is a label; the rest is the instruction
    if (end == std::string::npos) return {first_token, ""};

    size_t instr_start = line.find_first_not_of(" \t", end);
    if (instr_start == std::string::npos) return {first_token, ""};
    return {first_token, line.substr(instr_start)};
}

// ── Syntax highlighting ──────────────────────────────────────────────────────

static bool is_mnemonic(const std::string & tok) {
    std::string u = tok;
    std::transform(u.begin(), u.end(), u.begin(), ::toupper);
    for (const char ** m = LC3_MNEMONICS; *m; ++m)
        if (u == *m) return true;
    return false;
}

static bool is_directive(const std::string & tok) {
    return !tok.empty() && tok[0] == '.';
}

static bool is_register(const std::string & tok) {
    if (tok.size() != 2) return false;
    char c0 = toupper(tok[0]);
    return c0 == 'R' && tok[1] >= '0' && tok[1] <= '7';
}

static bool is_number(const std::string & tok) {
    if (tok.empty()) return false;
    if (tok[0] == '#' || tok[0] == 'x' || tok[0] == 'X') return true;
    if (tok[0] == '-' && tok.size() > 1) return true;
    if (tok.size() > 1 && tok[0] == '0' && (tok[1] == 'x' || tok[1] == 'X')) return true;
    return false;
}

static bool is_string_literal(const std::string & tok) {
    return tok.size() >= 2 && tok.front() == '"';
}

// Tokenize an instruction string preserving separators for display
static std::vector<std::string> tokenize_instr(const std::string & s) {
    std::vector<std::string> tokens;
    size_t i = 0;
    while (i < s.size()) {
        // Whitespace
        if (s[i] == ' ' || s[i] == '\t') {
            size_t start = i;
            while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
            tokens.push_back(s.substr(start, i - start));
        }
        // Comment
        else if (s[i] == ';') {
            tokens.push_back(s.substr(i));
            break;
        }
        // String literal
        else if (s[i] == '"') {
            size_t start = i++;
            while (i < s.size() && s[i] != '"') {
                if (s[i] == '\\' && i + 1 < s.size()) i++;
                i++;
            }
            if (i < s.size()) i++; // closing quote
            tokens.push_back(s.substr(start, i - start));
        }
        // Comma
        else if (s[i] == ',') {
            tokens.push_back(",");
            i++;
        }
        // Word token
        else {
            size_t start = i;
            while (i < s.size() && s[i] != ' ' && s[i] != '\t' &&
                   s[i] != ',' && s[i] != ';') i++;
            tokens.push_back(s.substr(start, i - start));
        }
    }
    return tokens;
}

static Element highlight_instruction(const std::string & instr) {
    auto tokens = tokenize_instr(instr);
    Elements parts;
    for (auto & tok : tokens) {
        if (tok.empty() || tok[0] == ' ' || tok[0] == '\t' || tok == ",") {
            parts.push_back(text(tok));
        } else if (tok[0] == ';') {
            parts.push_back(text(tok) | color(Color::GrayDark));
        } else if (is_string_literal(tok)) {
            parts.push_back(text(tok) | color(Color::Yellow));
        } else if (is_directive(tok)) {
            parts.push_back(text(tok) | color(Color::Red));
        } else if (is_mnemonic(tok)) {
            parts.push_back(text(tok) | color(Color::Cyan) | bold);
        } else if (is_register(tok)) {
            parts.push_back(text(tok) | color(Color::Green));
        } else if (is_number(tok)) {
            parts.push_back(text(tok) | color(Color::Magenta));
        } else {
            // Label reference / unknown — default color
            parts.push_back(text(tok));
        }
    }
    if (parts.empty()) return text("");
    return hbox(std::move(parts));
}

// ── Render functions (return ftxui::Element) ────────────────────────────────

static Element render_registers(SharedState & st) {
    ScopedTimer _t("render_registers");
    Elements lines;
    lines.push_back(text("Reg   Hex    uint   int    char") | bold);

    std::lock_guard<std::mutex> lk(st.mtx);
    for (int i = 0; i < 8; ++i) {
        uint16_t v = st.regs[i];
        int16_t sv = to_signed(v);
        std::string ch = char_repr(sv, v);
        std::string reg_str = fmt("R%d:  x%04X  %5u  %6d  %s", i, v, v, sv, ch.c_str());
        auto reg_elem = text(reg_str);
        if (v != st.prev_regs[i])
            reg_elem = reg_elem | color(Color::Green) | bold;

        if (!st.reg_sym[i].empty()) {
            auto label_elem = text("  @" + st.reg_sym[i]) | color(Color::Cyan);
            lines.push_back(hbox({reg_elem, label_elem}));
        } else {
            lines.push_back(reg_elem);
        }
    }
    lines.push_back(text(""));

    // PC with change highlight
    auto pc_str = fmt("PC: x%04X   CC: ", st.pc);
    auto pc_elem = text(pc_str);
    if (st.pc != st.prev_pc)
        pc_elem = pc_elem | color(Color::Green) | bold;
    else
        pc_elem = pc_elem | bold;

    // CC with N/Z/P coloring
    char cc = ' ';
    Decorator cc_color = nothing;
    if (st.psr & 4)      { cc = 'N'; cc_color = color(Color::Red); }
    else if (st.psr & 2) { cc = 'Z'; cc_color = color(Color::Yellow); }
    else if (st.psr & 1) { cc = 'P'; cc_color = color(Color::Green); }
    auto cc_elem = text(std::string(1, cc)) | bold | cc_color;

    lines.push_back(hbox({pc_elem, cc_elem}));

    return window(text(" Regs "), vbox(std::move(lines)));
}

static Element render_memory(SharedState & st) {
    ScopedTimer _t("render_memory");
    Elements lines;

    std::lock_guard<std::mutex> lk(st.mtx);
    for (auto & e : st.mem_snapshot) {
        char marker = ' ';
        if (st.pc == e.addr)
            marker = '>';
        else if (st.pc < 0x3000 && (st.rti_pc - 1) == e.addr)
            marker = 'T';

        char bp = ' ';
        if (st.breakpoints.count(e.addr)) bp = 'B';

        std::string prefix = fmt("%c%cx%04X: ", marker, bp, e.addr);

        // Use symbol table for labels (handles standalone labels correctly)
        std::string label_str;
        auto sym_it = st.symbols.find(e.addr);
        if (sym_it != st.symbols.end())
            label_str = sym_it->second;

        // Get instruction text (strip label from source line if present)
        std::string instr_str;
        bool is_string_data = false;
        if (e.line.size() == 1) {
            // .STRINGZ character data — show as character
            char c = e.line[0];
            if (c >= 32 && c <= 126)
                instr_str = fmt("'%c'", c);
            else
                instr_str = fmt("x%04X", e.val);
            is_string_data = true;
        } else if (e.line.empty()) {
            // No source — show raw value
            int16_t sv = to_signed(e.val);
            std::string ch = char_repr(sv, e.val);
            instr_str = fmt("x%04X %5u %6d %s", e.val, e.val, sv, ch.c_str());
        } else {
            auto parts = split_label(e.line);
            std::string remainder = parts.second;

            // Standalone label line (label on its own line, no instruction)
            if (!parts.first.empty() && remainder.empty()) {
                int16_t sv = to_signed(e.val);
                std::string ch = char_repr(sv, e.val);
                instr_str = fmt("x%04X %5u %6d %s", e.val, e.val, sv, ch.c_str());
            } else {
                // Use the instruction part (without label)
                std::string actual_instr = remainder.empty() ? e.line : remainder;
                std::string lower = actual_instr;
                std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);

                if (lower.find(".stringz") != std::string::npos) {
                    // Null terminator of .STRINGZ
                    instr_str = "'\\0'";
                    is_string_data = true;
                } else if (lower.find(".fill") != std::string::npos ||
                    lower.find(".blkw") != std::string::npos) {
                    int16_t sv = to_signed(e.val);
                    std::string ch = char_repr(sv, e.val);
                    instr_str = fmt("x%04X %5u %6d %s", e.val, e.val, sv, ch.c_str());
                } else {
                    instr_str = actual_instr;
                }
            }
        }

        // Format: prefix | label (padded to 12) | highlighted instruction
        if (label_str.size() > 12) label_str = label_str.substr(0, 12);
        std::string padded_label = label_str;
        while (padded_label.size() < 12) padded_label += ' ';

        auto label_elem = text(padded_label) | color(Color::Yellow);
        Element instr_elem;
        if (e.line.empty())
            instr_elem = text(instr_str) | color(Color::GrayDark);
        else if (is_string_data)
            instr_elem = text(instr_str) | color(Color::Yellow) | dim;
        else
            instr_elem = highlight_instruction(instr_str);

        auto elem = hbox({
            text(prefix),
            label_elem,
            text(" "),
            instr_elem,
        });

        if (marker == '>') elem = elem | bold | inverted;
        else if (bp == 'B') elem = elem | color(Color::Red);
        lines.push_back(elem);
    }

    return window(text(" Memory "), vbox(std::move(lines)) | flex);
}

static Element render_hotkeys(SharedState & st) {
    ScopedTimer _t("render_hotkeys");
    Mode m = st.mode.load();
    Elements lines;

    if (m == Mode::RUNNING) {
        lines.push_back(text("RUNNING (full speed). Input -> LC3 keyboard. [Esc] pause."));
    } else if (m == Mode::SLOW_RUN) {
        std::string race_str = st.race_subroutines.load() ? "ON" : "OFF";
        lines.push_back(text("SLOW RUN. [Esc] pause  t:race-subs[" + race_str + "]"));
    } else if (m == Mode::BREAK) {
        std::string lock_str = st.mem_locked.load() ? "unlock" : "lock";
        std::string race_str = st.race_subroutines.load() ? "ON" : "OFF";
        std::string disp_str = st.display_visible.load() ? "ON" : "OFF";
        lines.push_back(text("s:slow-run r:run i:step-in o:step-over q:quit b:bp e:restart E:reinit a:reassemble"));
        lines.push_back(text("h/l:resize n:" + lock_str + "-mem j/k:scroll z:jump c:clear-console d:display[" + disp_str + "] t:race[" + race_str + "] PgUp/PgDn:console-scroll"));
    } else if (m == Mode::SET_BREAKPOINT) {
        std::lock_guard<std::mutex> lk(st.mtx);
        lines.push_back(text("Toggle breakpoint (hex addr or label): " + st.bp_entry));
    } else if (m == Mode::GOTO_ADDRESS) {
        std::lock_guard<std::mutex> lk(st.mtx);
        lines.push_back(text("Jump to (hex addr or label): " + st.goto_entry));
    }

    return window(text(" Hotkeys "), vbox(std::move(lines)));
}

static Element render_console(SharedState & st) {
    ScopedTimer _t("render_console");
    Elements lines;

    int scroll;
    {
        std::lock_guard<std::mutex> lk(st.mtx);
        for (auto & line : st.console_lines) {
            lines.push_back(text(line.empty() ? " " : line));
        }
        scroll = st.console_scroll.load();
    }

    if (lines.empty()) {
        lines.push_back(text(""));
    }

    // scroll==0 means follow tail (focus last line); positive values step up.
    float rel_y = (scroll > 0) ? 0.f : 1.f;
    auto focused = (scroll > 0)
        ? vbox(std::move(lines)) | flex | focusPositionRelative(0, rel_y) | frame | flex
        : vbox(std::move(lines)) | flex | focusPositionRelative(0, 1) | frame | flex;

    std::string title = " Console ";
    if (scroll > 0) title = " Console (scroll -" + std::to_string(scroll) + ") ";
    return window(text(title), focused);
}

// B8: display peripheral panel — render 128×124 framebuffer into an FTXUI
// canvas.  Each LC-3 word encodes 5-6-5 RGB (matching upstream's pygame
// display peripheral).
static Element render_display(SharedState & st) {
    std::vector<uint16_t> snap;
    {
        std::lock_guard<std::mutex> lk(st.mtx);
        snap = st.disp_snapshot;
    }
    if ((int)snap.size() < DISP_W * DISP_H) {
        return window(text(" Display "), text("(no data yet)"));
    }

    int cw = DISP_W;
    int ch = DISP_H;
    auto c = Canvas(cw, ch);
    for (int y = 0; y < DISP_H; ++y) {
        for (int x = 0; x < DISP_W; ++x) {
            uint16_t v = snap[y * DISP_W + x];
            int r5 = (v >> 11) & 0x1F;
            int g6 = (v >>  5) & 0x3F;
            int b5 =  v        & 0x1F;
            int r = (r5 << 3) | (r5 >> 2);
            int g = (g6 << 2) | (g6 >> 4);
            int b = (b5 << 3) | (b5 >> 2);
            c.DrawPoint(x, y, true, Color::RGB(r, g, b));
        }
    }
    return window(text(" Display "), canvas(std::move(c)));
}

// ── Main ────────────────────────────────────────────────────────────────────

int main(int argc, char ** argv) {
    bool has_file = false;
    for (int i = 1; i < argc; ++i) {
        std::string arg(argv[i]);
        if (arg == "--profile") {
            g_profiler.enabled = true;
            continue;
        }
        std::string ext = (arg.size() > 4) ? arg.substr(arg.size()-4) : "";
        if (ext == ".obj" || ext == ".asm") {
            has_file = true;
        }
    }
    if (!has_file) {
        fprintf(stderr, "Usage: %s [--profile] <file.obj|file.asm> [...]\n", argv[0]);
        return 1;
    }
    g_profiler.start();

    // Pre-assemble .asm files before starting TUI (so errors print to terminal)
    TuiPrinter asm_printer;
    lc3::as assembler(asm_printer, 4, true);
    SharedState st;

    for (int i = 1; i < argc; ++i) {
        std::string arg(argv[i]);
        if (arg == "--profile") continue;
        std::string ext = (arg.size() > 4) ? arg.substr(arg.size()-4) : "";

        if (ext == ".obj") {
            st.obj_sources.push_back(arg);
        } else if (ext == ".asm") {
            st.asm_sources.push_back(arg);
            auto result = assembler.assemble(arg);
            if (result) {
                st.obj_sources.push_back((*result).first);
                for (auto & pair : (*result).second)
                    st.symbols[(uint16_t)pair.second] = pair.first;
            } else {
                std::string errors = asm_printer.flush();
                fprintf(stderr, "Assembly failed for %s:\n%s", arg.c_str(), errors.c_str());
                return 1;
            }
        }
    }

    TuiPrinter printer;
    TuiInputter inputter;

    auto screen = ScreenInteractive::Fullscreen();

    // Start simulator thread (passes obj_files instead of raw argv)
    std::thread sim_thr(sim_thread, std::ref(st), std::ref(printer), std::ref(inputter),
                        argc, argv, std::ref(screen));

    // Build FTXUI component
    auto renderer = Renderer([&] {
        // Update mem_rows based on terminal size
        auto dims = Terminal::Size();
        st.mem_rows.store(std::max(5, dims.dimy - 13 - 4));

        // Update memory base address if not locked
        if (!st.mem_locked.load()) {
            std::lock_guard<std::mutex> lk(st.mtx);
            if (st.pc >= 0x3000)
                st.baseaddr.store(st.pc - 3);
            else
                st.baseaddr.store(st.rti_pc - 3);
        }

        int col0w = st.col0width.load();

        Element right_col;
        if (st.display_visible.load()) {
            right_col = vbox({
                render_hotkeys(st),
                render_display(st),
                render_console(st) | flex,
            }) | flex;
        } else {
            right_col = vbox({
                render_hotkeys(st),
                render_console(st) | flex,
            }) | flex;
        }

        return hbox({
            vbox({
                render_registers(st),
                render_memory(st) | flex,
            }) | size(WIDTH, EQUAL, col0w),
            right_col,
        });
    });

    auto quit_closure = screen.ExitLoopClosure();

    auto component = CatchEvent(renderer, [&](Event event) -> bool {
        Mode m = st.mode.load();

        // Custom events from sim thread trigger re-render automatically
        if (event == Event::Custom) {
            return false;
        }

        // Esc ALWAYS works — pauses from any running mode
        if (event == Event::Escape) {
            st.mode.store(Mode::BREAK);
            return true;
        }

        // While running, Esc goes to keybinds (handled above), everything else -> LC3
        if (m == Mode::RUNNING || m == Mode::SLOW_RUN) {
            if (event.is_character())
                inputter.feed(event.character()[0]);
            return true;
        }

        // BREAK mode keybinds
        if (m == Mode::BREAK) {
            if (event == Event::Character('q')) { st.quit.store(true); quit_closure(); return true; }
            if (event == Event::Character('s')) { st.mode.store(Mode::SLOW_RUN); return true; }
            if (event == Event::Character('r')) { st.mode.store(Mode::RUNNING); return true; }
            if (event == Event::Character('t')) { st.race_subroutines.store(!st.race_subroutines.load()); return true; }
            if (event == Event::Character('h')) { st.col0width.store(std::max(30, st.col0width.load() - 1)); return true; }
            if (event == Event::Character('l')) { st.col0width.store(std::min(st.col0width.load() + 1, 120)); return true; }
            if (event == Event::Character('n')) { st.mem_locked.store(!st.mem_locked.load()); return true; }
            if (event == Event::Character('j')) { st.mem_locked.store(true); st.baseaddr.fetch_add(1); return true; }
            if (event == Event::Character('k')) { st.mem_locked.store(true); st.baseaddr.fetch_sub(1); return true; }
            if (event == Event::Character('e')) { st.restart.store(true); return true; }
            if (event == Event::Character('E')) { st.reinit.store(true); return true; }
            if (event == Event::Character('a')) { st.reassemble.store(true); return true; }
            if (event == Event::Character('i')) { st.step_in.store(true); return true; }
            if (event == Event::Character('o')) { st.step_over.store(true); return true; }
            if (event == Event::Character('c')) {
                std::lock_guard<std::mutex> lk(st.mtx);
                st.console_lines.clear();
                st.console_scroll.store(0);
                return true;
            }
            if (event == Event::Character('d')) {
                st.display_visible.store(!st.display_visible.load());
                return true;
            }
            if (event == Event::PageUp)   { st.console_scroll.fetch_add(5); return true; }
            if (event == Event::PageDown) {
                int cur = st.console_scroll.load();
                st.console_scroll.store(std::max(0, cur - 5));
                return true;
            }
            if (event == Event::Character('b')) {
                std::lock_guard<std::mutex> lk(st.mtx);
                st.bp_entry.clear();
                st.mode.store(Mode::SET_BREAKPOINT);
                return true;
            }
            if (event == Event::Character('z')) {
                std::lock_guard<std::mutex> lk(st.mtx);
                st.goto_entry.clear();
                st.mode.store(Mode::GOTO_ADDRESS);
                return true;
            }
        } else if (m == Mode::SET_BREAKPOINT || m == Mode::GOTO_ADDRESS) {
            std::string & entry = (m == Mode::SET_BREAKPOINT) ? st.bp_entry : st.goto_entry;

            if (event == Event::Return) {
                std::lock_guard<std::mutex> lk(st.mtx);
                std::string input = entry;
                bool resolved = false;
                uint16_t addr = 0;

                // Helper: case-insensitive label lookup
                auto find_label = [&](const std::string & name) -> bool {
                    std::string lower = name;
                    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
                    for (auto & pair : st.symbols) {
                        std::string sym_lower = pair.second;
                        std::transform(sym_lower.begin(), sym_lower.end(), sym_lower.begin(), ::tolower);
                        if (sym_lower == lower) {
                            addr = pair.first;
                            return true;
                        }
                    }
                    return false;
                };

                // Helper: parse full string as hex address
                auto parse_hex = [&](const std::string & s) -> bool {
                    if (s.empty()) return false;
                    try {
                        size_t pos = 0;
                        addr = (uint16_t)std::stoi(s, &pos, 16);
                        return pos == s.size();
                    } catch (...) { return false; }
                };

                if (input.size() > 2 && (input.substr(0, 2) == "0x" || input.substr(0, 2) == "0X")) {
                    resolved = parse_hex(input.substr(2));
                } else if (!input.empty() && (input[0] == 'x' || input[0] == 'X')) {
                    resolved = find_label(input);
                    if (!resolved)
                        resolved = parse_hex(input.substr(1));
                } else {
                    resolved = find_label(input);
                    if (!resolved)
                        resolved = parse_hex(input);
                }

                if (resolved) {
                    if (m == Mode::SET_BREAKPOINT) {
                        if (st.breakpoints.count(addr))
                            st.breakpoints.erase(addr);
                        else
                            st.breakpoints.insert(addr);
                    } else {
                        // GOTO_ADDRESS — jump memory window, lock so it doesn't snap back to PC
                        // Place target 3 rows from top
                        st.mem_locked.store(true);
                        st.baseaddr.store(addr - 3);
                    }
                }

                entry.clear();
                st.mode.store(Mode::BREAK);
                return true;
            }
            if (event == Event::Backspace) {
                std::lock_guard<std::mutex> lk(st.mtx);
                if (!entry.empty()) entry.pop_back();
                return true;
            }
            if (event.is_character()) {
                std::lock_guard<std::mutex> lk(st.mtx);
                entry += event.character();
                return true;
            }
        }

        return false;
    });

    screen.Loop(component);

    st.quit.store(true);
    sim_thr.join();

    if (g_profiler.enabled) {
        g_profiler.write("profile.txt");
        fprintf(stderr, "Profile written to profile.txt\n");
    }

    return 0;
}
