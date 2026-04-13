// Qt headers must come before ncurses.h because ncurses defines
// 'timeout' as a macro that breaks QTimer::timeout signal.
#include <QApplication>
#include <QWidget>
#include <QPainter>
#include <QImage>
#include <QTimer>
#include <QCloseEvent>
#include <QKeyEvent>
#include <QCoreApplication>

#include <ncurses.h>
#include <atomic>
#include <mutex>
#include <thread>
#include <chrono>
#include <deque>
#include <vector>
#include <string>
#include <algorithm>
#include <queue>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <functional>

#include "interface.h"
#include "printer.h"
#include "inputter.h"

// ============================================================
// Constants
// ============================================================
static const int    DISP_W    = 128;
static const int    DISP_H    = 124;
static const uint16_t DISP_BASE = 0xC000;
static const uint64_t RUN_SLICE = 100000ULL;

// ============================================================
// CursePrinter – thread-safe IPrinter
// ============================================================
class CursePrinter : public lc3::utils::IPrinter {
public:
    void print(std::string const & s) override {
        std::lock_guard<std::mutex> lk(mu_);
        buf_ += s;
    }
    void newline() override {
        std::lock_guard<std::mutex> lk(mu_);
        buf_ += '\n';
    }
    void setColor(lc3::utils::PrintColor) override {}

    std::string drain() {
        std::lock_guard<std::mutex> lk(mu_);
        std::string r = std::move(buf_);
        buf_.clear();
        return r;
    }
private:
    std::mutex mu_;
    std::string buf_;
};

// ============================================================
// CurseInputter – thread-safe IInputter
// ============================================================
class CurseInputter : public lc3::utils::IInputter {
public:
    void push(char c) {
        std::lock_guard<std::mutex> lk(mu_);
        q_.push(c);
    }
    void beginInput() override {}
    void endInput() override {}
    bool hasRemaining() const override {
        std::lock_guard<std::mutex> lk(mu_);
        return !q_.empty();
    }
    bool getChar(char & c) override {
        std::lock_guard<std::mutex> lk(mu_);
        if (q_.empty()) return false;
        c = q_.front(); q_.pop();
        return true;
    }
private:
    mutable std::mutex mu_;
    std::queue<char> q_;
};

// ============================================================
// Shared data structures
// ============================================================
struct DisplayCache {
    std::mutex mu;
    uint8_t fb[DISP_W * DISP_H * 3] = {};  // RGB888 row-major
};

struct UIData {
    std::mutex mu;
    std::string reg_str;
    std::string mem_str;
    uint16_t pc     = 0x01fe;
    uint16_t rti_pc = 0x3000;
    bool halted     = false;
    bool running    = false;
};

struct ConsoleState {
    std::mutex mu;
    std::deque<std::string> lines;

    void append(const std::string & s) {
        std::lock_guard<std::mutex> lk(mu);
        if (lines.empty()) lines.push_back("");
        for (char c : s) {
            if (c == '\0') continue;
            if (c == '\n') { lines.push_back(""); }
            else            { lines.back() += c; }
        }
        while (lines.size() > 5000) lines.pop_front();
    }
    void clear_all() {
        std::lock_guard<std::mutex> lk(mu);
        lines.clear();
    }
};

struct MemViewParams {
    std::mutex mu;
    int rows         = 20;
    int cols         = 80;
    uint16_t baseaddr = 0x01fe;
    bool mem_locked  = false;
};

struct SimCtrl {
    std::atomic<bool> quit{false};
    std::atomic<bool> run_mode{false};
    std::atomic<bool> step_in_req{false};
    std::atomic<bool> step_over_req{false};
    std::atomic<bool> restart_req{false};
    std::atomic<bool> reassemble_req{false};
    std::atomic<bool> bp_hit{false};
    std::atomic<bool> display_on{false};
    std::atomic<bool> clear_console_req{false};

    std::mutex bp_mu;
    std::vector<uint16_t> bp_add;
    std::vector<uint16_t> bp_remove;
    std::vector<uint16_t> active_bps;  // maintained by sim thread only

    // Keys forwarded from the Qt display window to the ncurses thread.
    std::mutex key_mu;
    std::queue<int> key_queue;
    void pushKey(int k) {
        std::lock_guard<std::mutex> lk(key_mu);
        key_queue.push(k);
    }
    int popKey() {
        std::lock_guard<std::mutex> lk(key_mu);
        if (key_queue.empty()) return ERR;
        int k = key_queue.front();
        key_queue.pop();
        return k;
    }
};

// ============================================================
// Qt5 Display Window
// ============================================================
class LC3Display : public QWidget {
public:
    LC3Display(DisplayCache & dc, SimCtrl & ctrl)
        : QWidget(nullptr), dc_(dc), ctrl_(ctrl)
    {
        setWindowTitle("LC-3 Display");
        setFixedSize(DISP_W * 2, DISP_H * 2);
        setAttribute(Qt::WA_QuitOnClose, false);
        timer_ = new QTimer(this);
        connect(timer_, &QTimer::timeout, this, [this]{ tick(); });
        timer_->start(33);
    }

protected:
    void paintEvent(QPaintEvent *) override {
        QPainter p(this);
        std::lock_guard<std::mutex> lk(dc_.mu);
        QImage img(dc_.fb, DISP_W, DISP_H, DISP_W * 3, QImage::Format_RGB888);
        p.drawImage(rect(), img);
    }
    void closeEvent(QCloseEvent * e) override {
        ctrl_.display_on.store(false, std::memory_order_relaxed);
        hide();
        e->ignore();
    }
    void keyPressEvent(QKeyEvent * e) override {
        int key = -1;
        // Map Qt keys to the values the ncurses thread expects.
        if (e->key() == Qt::Key_Escape)     key = 27;
        else if (e->key() == Qt::Key_Return || e->key() == Qt::Key_Enter) key = 10;
        else if (e->key() == Qt::Key_Backspace) key = 127;
        else {
            QString txt = e->text();
            if (!txt.isEmpty()) key = txt.at(0).unicode();
        }
        if (key > 0) ctrl_.pushKey(key);
    }

private:
    DisplayCache & dc_;
    SimCtrl & ctrl_;
    QTimer * timer_;

    void tick() {
        bool on = ctrl_.display_on.load(std::memory_order_relaxed);
        if (on && !isVisible()) show();
        else if (!on && isVisible()) hide();
        if (on) update();
        if (ctrl_.quit.load(std::memory_order_relaxed))
            QCoreApplication::quit();
    }
};

// ============================================================
// Register string formatting
// ============================================================
static std::string formatRegs(lc3::sim & sim) {
    std::string out;
    char buf[128];
    out += "Reg\tHex\tuint\tint\tchar\n";
    for (int i = 0; i < 8; i++) {
        uint16_t val  = sim.readReg((uint16_t)i);
        int16_t  sval = static_cast<int16_t>(val);
        int      av   = sval < 0 ? -sval : sval;
        std::string ch;
        if      (av >= 32 && av <= 126) ch = std::string("'") + (char)av + "'";
        else if (val == 0)  ch = "\\0";
        else if (av == 9)   ch = "\\t";
        else if (av == 10)  ch = "\\n";
        else if (av == 13)  ch = "\\r";
        if (!ch.empty() && sval < 0) ch = "-" + ch;
        snprintf(buf, sizeof(buf), "R%d:\tx%04X\t%u\t%d\t%s\n",
                 i, val, (unsigned)val, (int)sval, ch.c_str());
        out += buf;
    }
    out += "\n";
    uint16_t psr = sim.readPSR();
    char cc = (psr & 1) ? 'P' : ((psr & 2) ? 'Z' : 'N');
    snprintf(buf, sizeof(buf), "PC: x%04X\tCC: %c\n", sim.readPC(), cc);
    out += buf;
    return out;
}

// ============================================================
// Memory string formatting
// ============================================================
static std::string formatMem(lc3::sim & sim, int rows, int cols,
                              uint16_t baseaddr,
                              const std::vector<uint16_t> & bps)
{
    std::string out;
    char buf[256];
    uint16_t pc     = sim.readPC();
    uint16_t rti_pc = sim.readMem(0x2ffe);

    for (int i = 0; i < rows; i++) {
        uint16_t addr = baseaddr + static_cast<uint16_t>(i);
        std::string line;

        if      (pc == addr)                                    line += '>';
        else if (pc < 0x3000 && rti_pc > 0 && (uint16_t)(rti_pc - 1) == addr) line += 'T';
        else                                                    line += ' ';

        bool has_bp = std::find(bps.begin(), bps.end(), addr) != bps.end();
        line += has_bp ? 'B' : ' ';

        snprintf(buf, sizeof(buf), "x%04X: ", addr);
        line += buf;

        std::string memline = sim.getMemLine(addr);
        std::string ml = memline;
        for (char & c : ml) c = (char)tolower((unsigned char)c);

        bool is_fill = ml.find(".fill") != std::string::npos;
        bool is_blkw = ml.find(".blkw") != std::string::npos;
        bool is_data = is_fill || is_blkw || memline.empty();

        if (is_data) {
            uint16_t val  = sim.readMem(addr);
            int16_t  sval = static_cast<int16_t>(val);
            int      av   = sval < 0 ? -sval : sval;
            std::string ch;
            if      (av >= 32 && av <= 126) ch = std::string("'") + (char)av + "'";
            else if (val == 0)  ch = "\\0";
            else if (av == 9)   ch = "\\t";
            else if (av == 10)  ch = "\\n";
            else if (av == 13)  ch = "\\r";
            if (!ch.empty() && sval < 0) ch = "-" + ch;

            if (is_fill || is_blkw) {
                size_t pos = is_blkw ? ml.find(".blkw") : ml.find(".fill");
                std::string lbl = memline.substr(0, pos);
                while (!lbl.empty() && isspace((unsigned char)lbl.back())) lbl.pop_back();
                if (!lbl.empty()) {
                    line += lbl + " ";
                    while ((int)line.size() < 20) line += ' ';
                }
            }
            snprintf(buf, sizeof(buf), "x%04X %u %d %s",
                     val, (unsigned)val, (int)sval, ch.c_str());
            line += buf;
        } else {
            line += memline;
        }

        if ((int)line.size() > cols - 2)
            line = line.substr(0, cols - 2);
        out += line + "\n";
    }
    return out;
}

// ============================================================
// Hotkey string (word-wrapped)
// ============================================================
enum class UIMode { BREAK, RUNNING, SET_BREAKPOINT, SET_BASEADDR };

static std::string hotkeyStr(UIMode mode, bool mem_locked,
                              const std::string & bp_input,
                              const std::string & addr_input,
                              int width)
{
    std::string s;
    if (mode == UIMode::RUNNING) {
        s = "Input forwarded to LC3 keyboard. Press [Esc] to pause.";
    } else if (mode == UIMode::BREAK) {
        std::string lk = mem_locked ? "unlock" : "lock";
        s = "s:step-in r:run q:quit b:breakpoints g:goto-address "
            "a:reassemble h:split-left l:split-right e:restart "
            "c:clear-console n:" + lk + "-mem k:scroll-up j:scroll-down d:toggle-display";
    } else if (mode == UIMode::SET_BREAKPOINT) {
        s = "Enter address to toggle breakpoint: " + bp_input;
    } else {
        s = "Enter new starting address for memory window: " + addr_input;
    }

    if (width < 1) width = 1;
    std::string result;
    int col = 0;
    size_t i = 0;
    while (i < s.size()) {
        size_t sp = s.find(' ', i);
        if (sp == std::string::npos) sp = s.size();
        std::string word = s.substr(i, sp - i);
        if (col > 0 && col + 1 + (int)word.size() > width) {
            result += '\n'; col = 0;
        }
        if (col > 0) { result += ' '; col++; }
        result += word;
        col += (int)word.size();
        i = sp + 1;
    }
    return result;
}

// ============================================================
// Sim thread
// ============================================================
static void simThread(
    lc3::sim & sim,
    CursePrinter & printer,
    SimCtrl & ctrl,
    UIData & uid,
    ConsoleState & console,
    MemViewParams & mvp,
    const std::vector<std::string> & obj_files
) {
    using namespace std::chrono;
    using namespace std::chrono_literals;

    // Register BREAKPOINT callback: stop sim and flag it
    sim.registerCallback(lc3::core::CallbackType::BREAKPOINT,
        [&ctrl](lc3::core::CallbackType, lc3::sim & s) {
            ctrl.bp_hit.store(true, std::memory_order_relaxed);
            s.asyncInterrupt();
        });

    auto load_objs = [&]() {
        for (auto & f : obj_files) sim.loadObjFile(f);
        sim.writePC(0x3000);
    };
    load_objs();

    // Apply queued breakpoint add/remove requests
    auto apply_bps = [&]() {
        std::lock_guard<std::mutex> lk(ctrl.bp_mu);
        for (auto addr : ctrl.bp_add) {
            if (std::find(ctrl.active_bps.begin(), ctrl.active_bps.end(), addr)
                    == ctrl.active_bps.end()) {
                ctrl.active_bps.push_back(addr);
                sim.setBreakpoint(addr);
            }
        }
        ctrl.bp_add.clear();
        for (auto addr : ctrl.bp_remove) {
            auto it = std::find(ctrl.active_bps.begin(), ctrl.active_bps.end(), addr);
            if (it != ctrl.active_bps.end()) {
                ctrl.active_bps.erase(it);
                sim.removeBreakpoint(addr);
            }
        }
        ctrl.bp_remove.clear();
    };

    // Rebuild register/memory text and flush console output
    auto do_ui_update = [&]() {
        int rows, cols;
        uint16_t baseaddr;
        {
            std::lock_guard<std::mutex> lk(mvp.mu);
            rows    = mvp.rows;
            cols    = mvp.cols;
            baseaddr = mvp.baseaddr;
        }
        std::vector<uint16_t> bps_snap;
        {
            std::lock_guard<std::mutex> lk(ctrl.bp_mu);
            bps_snap = ctrl.active_bps;
        }
        std::string regs = formatRegs(sim);
        std::string mems = formatMem(sim, rows, cols, baseaddr, bps_snap);
        {
            std::lock_guard<std::mutex> lk(uid.mu);
            uid.reg_str = std::move(regs);
            uid.mem_str = std::move(mems);
            uid.pc      = sim.readPC();
            uid.rti_pc  = sim.readMem(0x2ffe);
        }
        std::string out = printer.drain();
        if (!out.empty()) console.append(out);
    };

    auto last_update = steady_clock::now();
    bool step_trap   = false;  // step-over mode: run until PC >= 0x3000

    while (!ctrl.quit.load(std::memory_order_relaxed)) {

        // --- Handle one-shot requests ---
        if (ctrl.reassemble_req.exchange(false)) {
            for (auto & f : obj_files) {
                std::string asmf = f.size() >= 4
                    ? f.substr(0, f.size() - 4) + ".asm" : f + ".asm";
                lc3::as assembler(printer, 1, false);
                assembler.assemble(asmf);
            }
        }

        if (ctrl.restart_req.exchange(false)) {
            sim.zeroState();
            load_objs();
            ctrl.run_mode.store(false, std::memory_order_release);
            step_trap = false;
            {
                std::lock_guard<std::mutex> lk(uid.mu);
                uid.halted  = false;
                uid.running = false;
            }
        }

        if (ctrl.clear_console_req.exchange(false))
            console.clear_all();

        apply_bps();

        bool running = ctrl.run_mode.load(std::memory_order_acquire);
        bool halted;
        { std::lock_guard<std::mutex> lk(uid.mu); halted = uid.halted; }

        // --- Simulation step ---
        if (running && !halted) {
            sim.setRunInstLimit(RUN_SLICE);
            sim.run();

            if (!sim.didExceedInstLimit()) {
                // Stopped before reaching the instruction limit
                bool bp = ctrl.bp_hit.exchange(false);
                ctrl.run_mode.store(false, std::memory_order_release);
                step_trap = false;
                {
                    std::lock_guard<std::mutex> lk(uid.mu);
                    uid.halted  = !bp;   // not a breakpoint → HALT
                    uid.running = false;
                }
            } else {
                // Full slice completed – clear any stray bp_hit
                ctrl.bp_hit.store(false, std::memory_order_relaxed);
                // Check step-over completion
                if (step_trap && sim.readPC() >= 0x3000) {
                    step_trap = false;
                    ctrl.run_mode.store(false, std::memory_order_release);
                    { std::lock_guard<std::mutex> lk(uid.mu); uid.running = false; }
                }
            }

        } else if (ctrl.step_in_req.exchange(false)) {
            { std::lock_guard<std::mutex> lk(uid.mu); uid.halted = false; }
            sim.stepIn();

        } else if (ctrl.step_over_req.exchange(false)) {
            { std::lock_guard<std::mutex> lk(uid.mu); uid.halted = false; }
            uint16_t pc    = sim.readPC();
            uint16_t instr = sim.readMem(pc);
            bool is_trap   = (instr >> 12) == 0xF;
            if ((is_trap || pc < 0x3000) && instr != 0xF025) {
                // Enter the trap/OS routine, then run until back in user code
                sim.stepIn();
                step_trap = true;
                ctrl.run_mode.store(true, std::memory_order_release);
                { std::lock_guard<std::mutex> lk(uid.mu); uid.running = true; }
            } else {
                sim.stepIn();
            }

        } else {
            std::this_thread::sleep_for(3ms);
        }

        // --- Periodic updates ---
        auto now = steady_clock::now();

        if (now - last_update >= 33ms) {
            last_update = now;
            // Auto-scroll: update baseaddr in MemViewParams
            uint16_t pc, rti_pc;
            { std::lock_guard<std::mutex> lk(uid.mu); pc = uid.pc; rti_pc = uid.rti_pc; }
            {
                std::lock_guard<std::mutex> lk(mvp.mu);
                if (!mvp.mem_locked) {
                    if (pc >= 0x3000)
                        mvp.baseaddr = (pc >= 3) ? (uint16_t)(pc - 3) : 0;
                    else
                        mvp.baseaddr = (rti_pc >= 3) ? (uint16_t)(rti_pc - 3) : 0;
                }
            }
            do_ui_update();
        }
    }
}

// ============================================================
// Display thread – reads flat_mem directly and converts to RGB888
// ============================================================
static void displayThread(
    lc3::sim & sim,
    SimCtrl & ctrl,
    DisplayCache & dc
) {
    using namespace std::chrono_literals;

    // Shadow copy for dirty-pixel detection so we only rewrite changed pixels.
    uint16_t prev[DISP_W * DISP_H] = {};

    // Pointer into the flat contiguous uint16_t mirror inside MachineState.
    // Reads are safe without a mutex: each element is a naturally-aligned
    // uint16_t, so loads are atomic on x86 / ARM / any modern ISA.
    const uint16_t * flat = sim.getMachineState().flatMemPtr() + DISP_BASE;

    while (!ctrl.quit.load(std::memory_order_relaxed)) {
        if (!ctrl.display_on.load(std::memory_order_relaxed)) {
            std::this_thread::sleep_for(16ms);
            continue;
        }

        // Convert only changed pixels to RGB888 and write to the framebuffer.
        {
            std::lock_guard<std::mutex> lk(dc.mu);
            for (int i = 0; i < DISP_W * DISP_H; i++) {
                uint16_t d = flat[i];
                if (d == prev[i]) continue;
                prev[i] = d;
                int r = (d >> 10) & 0x1F;
                int g = (d >>  5) & 0x1F;
                int b =  d        & 0x1F;
                dc.fb[i*3 + 0] = (uint8_t)(r << 3);
                dc.fb[i*3 + 1] = (uint8_t)(g << 3);
                dc.fb[i*3 + 2] = (uint8_t)(b << 3);
            }
        }

        std::this_thread::sleep_for(16ms);  // ~60 fps
    }
}

// ============================================================
// NCurses thread
// ============================================================
static void ncursesThread(
    CurseInputter & inputter,
    SimCtrl & ctrl,
    UIData & uid,
    ConsoleState & console,
    MemViewParams & mvp
) {
    using namespace std::chrono_literals;

    initscr();
    cbreak();
    noecho();
    keypad(stdscr, TRUE);
    curs_set(0);
    use_default_colors();
#ifdef NCURSES_VERSION
    set_escdelay(25);
#endif

    int maxy, maxx;
    getmaxyx(stdscr, maxy, maxx);
    maxy = std::max(maxy, 20);
    maxx = std::max(maxx, 80);

    int col0w    = 45;
    int hotkey_h = 3;

    WINDOW * reg_win = newwin(13, col0w, 0, 0);
    WINDOW * mem_win = newwin(std::max(1, maxy - 13), col0w, 13, 0);
    WINDOW * hk_win  = newwin(hotkey_h, std::max(1, maxx - col0w), 0, col0w);
    WINDOW * con_win = newwin(std::max(1, maxy - hotkey_h),
                              std::max(1, maxx - col0w), hotkey_h, col0w);
    WINDOW * kbd_win = newwin(1, 1, 0, 0);
    nodelay(kbd_win, TRUE);
    keypad(kbd_win, TRUE);

    refresh();

    // Notify sim thread of initial window dimensions
    {
        std::lock_guard<std::mutex> lk(mvp.mu);
        mvp.rows = std::max(1, maxy - 13 - 2);
        mvp.cols = col0w;
    }

    UIMode      mode        = UIMode::BREAK;
    std::string bp_input;
    std::string addr_input;
    bool        mem_locked  = false;

    // Resize a window safely: shrink before moving (if shrinking height),
    // move before growing (if growing height).  Always call clearok so the
    // full window interior is redrawn, not just the diff.
    auto safe_resize = [](WINDOW * win, int new_h, int new_w, int new_y, int new_x) {
        int cur_h, cur_w;
        getmaxyx(win, cur_h, cur_w);
        new_h = std::max(1, new_h);
        new_w = std::max(1, new_w);
        if (new_h < cur_h || new_w < cur_w) {
            wresize(win, new_h, new_w);
            mvwin(win, new_y, new_x);
        } else {
            mvwin(win, new_y, new_x);
            wresize(win, new_h, new_w);
        }
        clearok(win, TRUE);
    };

    // Apply the current layout (col0w, hotkey_h, maxy, maxx) to all windows.
    // Clears stdscr first so no old border fragments linger in the background.
    auto relayout = [&]() {
        int right_w = std::max(1, maxx - col0w);
        int con_h   = std::max(1, maxy - hotkey_h);
        int mem_h   = std::max(1, maxy - 13);

        // Blank the underlying stdscr so old characters don't show through.
        werase(stdscr);
        wnoutrefresh(stdscr);

        safe_resize(reg_win, 13,       col0w,   0,        0);
        safe_resize(mem_win, mem_h,    col0w,   13,       0);
        safe_resize(hk_win,  hotkey_h, right_w, 0,        col0w);
        safe_resize(con_win, con_h,    right_w, hotkey_h, col0w);

        // Force every window to repaint its full content, not just changed cells.
        touchwin(reg_win);
        touchwin(mem_win);
        touchwin(hk_win);
        touchwin(con_win);

        {
            std::lock_guard<std::mutex> lk(mvp.mu);
            mvp.rows = std::max(1, maxy - 13 - 2);
            mvp.cols = col0w;
        }
    };

    auto do_resize = [&]() {
        getmaxyx(stdscr, maxy, maxx);
        maxy = std::max(maxy, 20);
        maxx = std::max(maxx, 80);
        resizeterm(maxy, maxx);

        // Recompute hotkey height for the new terminal width.
        std::string hk = hotkeyStr(mode, mem_locked, bp_input, addr_input,
                                   std::max(1, maxx - col0w - 2));
        int hkl = 1;
        for (char c : hk) if (c == '\n') hkl++;
        hotkey_h = hkl + 2;

        relayout();
    };

    auto toggle_bp = [&](const std::string & hex) {
        try {
            uint16_t addr = (uint16_t)std::stoul(hex, nullptr, 16);
            std::lock_guard<std::mutex> lk(ctrl.bp_mu);
            auto it = std::find(ctrl.active_bps.begin(), ctrl.active_bps.end(), addr);
            if (it != ctrl.active_bps.end()) ctrl.bp_remove.push_back(addr);
            else                             ctrl.bp_add.push_back(addr);
        } catch (...) {}
    };

    while (!ctrl.quit.load(std::memory_order_relaxed)) {

        // Read from ncurses first, then check the Qt display key queue.
        int key = wgetch(kbd_win);
        if (key == ERR) key = ctrl.popKey();

        bool sim_running = ctrl.run_mode.load(std::memory_order_relaxed);

        // Sync UIMode with actual run state
        if (sim_running && mode == UIMode::BREAK)   mode = UIMode::RUNNING;
        if (!sim_running && mode == UIMode::RUNNING) mode = UIMode::BREAK;

        if (key != ERR) {
            if (mode == UIMode::RUNNING) {
                if (key == 27) {
                    ctrl.run_mode.store(false, std::memory_order_release);
                    mode = UIMode::BREAK;
                } else if (key >= 1 && key < 256) {
                    inputter.push((char)key);
                }
            } else if (mode == UIMode::BREAK) {
                switch (key) {
                    case 'q': ctrl.quit.store(true); break;
                    case 'r':
                        ctrl.run_mode.store(true, std::memory_order_release);
                        mode = UIMode::RUNNING;
                        { std::lock_guard<std::mutex> lk(uid.mu); uid.halted = false; }
                        break;
                    case 's': ctrl.step_in_req.store(true); break;
                    case 'o': ctrl.step_over_req.store(true); break;
                    case 'n':
                        mem_locked = !mem_locked;
                        { std::lock_guard<std::mutex> lk(mvp.mu); mvp.mem_locked = mem_locked; }
                        break;
                    case 'k':
                        mem_locked = true;
                        {
                            std::lock_guard<std::mutex> lk(mvp.mu);
                            mvp.mem_locked = true;
                            if (mvp.baseaddr > 0) mvp.baseaddr--;
                        }
                        break;
                    case 'j':
                        mem_locked = true;
                        {
                            std::lock_guard<std::mutex> lk(mvp.mu);
                            mvp.mem_locked = true;
                            mvp.baseaddr++;
                        }
                        break;
                    case 'h': col0w = std::max(39, col0w - 1); do_resize(); break;
                    case 'l': col0w = std::min(maxx - 10, col0w + 1); do_resize(); break;
                    case 'e': ctrl.restart_req.store(true); break;
                    case 'a':
                        ctrl.reassemble_req.store(true);
                        ctrl.restart_req.store(true);
                        break;
                    case 'b': mode = UIMode::SET_BREAKPOINT; bp_input.clear(); break;
                    case 'c': ctrl.clear_console_req.store(true); break;
                    case 'g': mode = UIMode::SET_BASEADDR; addr_input.clear(); break;
                    case 'd':
                        ctrl.display_on.store(!ctrl.display_on.load(std::memory_order_relaxed));
                        break;
                    default: break;
                }
            } else if (mode == UIMode::SET_BREAKPOINT) {
                if (key == 10 || key == 13 || key == KEY_ENTER) {
                    toggle_bp(bp_input);
                    bp_input.clear();
                    mode = UIMode::BREAK;
                } else if (key == KEY_BACKSPACE || key == 127 || key == 8) {
                    if (!bp_input.empty()) bp_input.pop_back();
                } else if (key >= 0 && key < 256 && isprint(key)) {
                    bp_input += (char)key;
                }
            } else if (mode == UIMode::SET_BASEADDR) {
                if (key == 10 || key == 13 || key == KEY_ENTER) {
                    try {
                        uint16_t addr = (uint16_t)std::stoul(addr_input, nullptr, 16);
                        mem_locked = true;
                        {
                            std::lock_guard<std::mutex> lk(mvp.mu);
                            mvp.baseaddr    = addr;
                            mvp.mem_locked  = true;
                        }
                    } catch (...) {}
                    addr_input.clear();
                    mode = UIMode::BREAK;
                } else if (key == KEY_BACKSPACE || key == 127 || key == 8) {
                    if (!addr_input.empty()) addr_input.pop_back();
                } else if (key >= 0 && key < 256 && isprint(key)) {
                    addr_input += (char)key;
                }
            }

            if (key == KEY_RESIZE) do_resize();
        }

        // --- Render ---
        std::string reg_str, mem_str;
        {
            std::lock_guard<std::mutex> lk(uid.mu);
            reg_str = uid.reg_str;
            mem_str = uid.mem_str;
        }

        // Registers
        werase(reg_win);
        box(reg_win, 0, 0);
        mvwaddstr(reg_win, 0, 2, " Regs ");
        {
            int row = 1;
            std::istringstream ss(reg_str);
            std::string line;
            int rh, rw; getmaxyx(reg_win, rh, rw);
            while (std::getline(ss, line) && row < rh - 1) {
                mvwaddnstr(reg_win, row++, 2, line.c_str(), rw - 4);
            }
        }
        wnoutrefresh(reg_win);

        // Memory
        werase(mem_win);
        box(mem_win, 0, 0);
        mvwaddstr(mem_win, 0, 2, " Memory ");
        {
            int row = 1;
            int mh, mw; getmaxyx(mem_win, mh, mw);
            std::istringstream ss(mem_str);
            std::string line;
            while (std::getline(ss, line) && row < mh - 1) {
                mvwaddnstr(mem_win, row++, 1, line.c_str(), mw - 2);
            }
        }
        wnoutrefresh(mem_win);

        // Hotkeys
        {
            std::string hk = hotkeyStr(mode, mem_locked, bp_input, addr_input,
                                       std::max(1, maxx - col0w - 2));
            int hkl = 1;
            for (char c : hk) if (c == '\n') hkl++;
            int new_hkh = hkl + 2;
            if (new_hkh != hotkey_h) {
                hotkey_h = new_hkh;
                relayout();  // clear stdscr, resize in correct order, touchwin all
            }
            werase(hk_win);
            box(hk_win, 0, 0);
            mvwaddstr(hk_win, 0, 2, " Hotkeys ");
            int row = 1;
            int hh, hw; getmaxyx(hk_win, hh, hw);
            std::istringstream ss(hk);
            std::string line;
            while (std::getline(ss, line) && row < hh - 1) {
                mvwaddnstr(hk_win, row++, 1, line.c_str(), hw - 2);
            }
            wnoutrefresh(hk_win);
        }

        // Console
        werase(con_win);
        box(con_win, 0, 0);
        mvwaddstr(con_win, 0, 2, " Console ");
        {
            std::deque<std::string> snap;
            { std::lock_guard<std::mutex> lk(console.mu); snap = console.lines; }
            int ch, cw; getmaxyx(con_win, ch, cw);
            int pos = ch - 2;
            for (auto it = snap.rbegin(); it != snap.rend() && pos >= 1; ++it) {
                const std::string & line = *it;
                if (line.empty()) { pos--; continue; }
                // Simple word-wrap: split into cw-2 chunks
                int llen = (int)line.size();
                int wrap = std::max(1, cw - 2);
                std::vector<std::string> chunks;
                for (int s = 0; s < llen; s += wrap)
                    chunks.push_back(line.substr(s, std::min(wrap, llen - s)));
                for (auto ci = chunks.rbegin(); ci != chunks.rend() && pos >= 1; ++ci)
                    mvwaddnstr(con_win, pos--, 1, ci->c_str(), cw - 2);
            }
        }
        wnoutrefresh(con_win);

        doupdate();

        std::this_thread::sleep_for(std::chrono::milliseconds(33));
    }

    // Signal Qt to exit
    QCoreApplication::quit();

    delwin(reg_win);
    delwin(mem_win);
    delwin(hk_win);
    delwin(con_win);
    delwin(kbd_win);
    endwin();
}

// ============================================================
// Entry point
// ============================================================
int curs_main(std::vector<std::string> args, std::string /* python_exe */) {
    std::vector<std::string> obj_files;
    for (size_t i = 1; i < args.size(); i++) {
        const auto & a = args[i];
        if (a.size() >= 4 && a.substr(a.size() - 4) == ".obj")
            obj_files.push_back(a);
    }

    // Shared state
    CursePrinter    printer;
    CurseInputter   inputter;
    SimCtrl         ctrl;
    UIData          uid;
    ConsoleState    console;
    DisplayCache    dc;
    MemViewParams   mvp;

    // Simulator (must exist before threads start)
    lc3::sim sim(printer, inputter, 1);

    // Qt must live on the main thread
    int    fake_argc   = 1;
    char   prog_name[] = "lc3pysim";
    char * fake_argv[] = {prog_name, nullptr};
    QApplication app(fake_argc, fake_argv);
    LC3Display * display = new LC3Display(dc, ctrl);
    (void)display;

    // Sim thread: runs the LC-3 simulator (no display work)
    std::thread sim_thr(simThread,
        std::ref(sim), std::ref(printer), std::ref(ctrl),
        std::ref(uid), std::ref(console),
        std::ref(mvp), obj_files);

    // Display thread: reads flat_mem directly and converts to RGB
    std::thread disp_thr(displayThread,
        std::ref(sim), std::ref(ctrl), std::ref(dc));

    // TUI thread: ncurses rendering and keyboard input
    std::thread ncurses_thr(ncursesThread,
        std::ref(inputter), std::ref(ctrl), std::ref(uid),
        std::ref(console), std::ref(mvp));

    app.exec();          // blocks until QCoreApplication::quit()

    ctrl.quit.store(true, std::memory_order_release);
    ncurses_thr.join();
    disp_thr.join();
    sim_thr.join();

    return 0;
}
