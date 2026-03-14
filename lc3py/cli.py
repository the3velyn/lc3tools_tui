import sys
from .cli_bindings import asm_main, sim_main
import lc3py
import curses
import threading
import time
import textwrap

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

def load_args(sim):
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

def input_handler(stdscr, status):
    while(True):
        key = stdscr.getch()
        if key == ord('q') and status['mode'] == 'hotkey':
            status['run'] = False
            break
        if key == ord('t'):
            if status['mode'] == 'stdin':
                status['mode'] = 'hotkey'
            else:
                status['mode'] = 'stdin'
        if key == ord('h'):
            status['col0width'] = max(39,status['col0width'] - 1)
        if key == ord('l'):
            status['col0width'] = status['col0width'] + 1


def draw_registers(win, sim):
    win.erase()
    win.box()
    try:
        win.addstr(0, 2, " Regs ")
        win.addstr(1,2,"Reg\tHex\tuint\tint\tchar")
    except:
        pass
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
        if char != "":
            char = f"\'{char}\'"
        if char != "" and signedval < 0:
            char = "-" + char
        try:
            win.addstr(i+2, 2, f"R{i}:\tx{val:04X}\t{val}\t{signedval}\t{char}")
        except:
            pass
    
    try:
        win.addstr(11, 2, f"PC: x{sim.get_pc():04X}\tCC: To do")
    except:
        pass
    win.refresh()

def draw_mem(mem_win, sim, breakpoints, status):
    maxy, maxx = mem_win.getmaxyx()
    addrcount = maxy-2
    maxchars = maxx -2
    lines = []
    for i in range(status['baseaddr'], status['baseaddr']+addrcount):
        line = ""
        if sim.get_pc() == i:
            line += ">"
        else:
            line += " "

        if i in breakpoints:
            line += "B"
        else:
            line += " "
        line += f"x{i:04X}: "
        if(".fill" in sim.read_mem_line(i).lower()) or sim.read_mem_line(i) == "":
            val = sim.read_mem(i)
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
            if char != "":
                char = f"\'{char}\'"
            if char != "" and signedval < 0:
                char = "-" + char
            if (".fill" in sim.read_mem_line(i).lower()):
                tmp = sim.read_mem_line(i).lower().split(".fill")
                if (len(tmp) > 1):
                    tmp = tmp[0].strip()
                    if len(tmp) > 0:
                        line += f"{tmp.upper()} "
                        while len(line) < 20:
                            line += " "
            line += f"x{val:04X} {val} {signedval} {char}"
        else:
            line += sim.read_mem_line(i)
        line = line[:maxchars]
        lines.append(line)

    for i in range(len(lines)):
        try:
            mem_win.addstr(i+1, 1, lines[i])
        except:
            pass

    return

def enter_is_terminate(ch):
    """Custom validator: lets Enter (10 or 13) finish the input."""
    if ch in (10, 13, curses.KEY_ENTER):
        return 7  # 7 is the ASCII code for Bell, which textpad treats as 'stop'
    return ch

def hotkey_str(status, win_width):
    strwidth = win_width - 2
    retstr = ""
    if status['mode'] == 'stdin':
        retstr = "Input forwarded to LC3 keyboard. Press [Esc] to pause simulator."
    elif status['mode'] == 'hotkey':
        retstr = "s:step-in o:step-over r:run q:quit b:breakpoints h:hsplit-left l:hsplit-right restart reassemble lock-mem-screen" 

    retstr = textwrap.wrap(retstr, strwidth, break_long_words=False, break_on_hyphens=False)
    return retstr

def cli_main(stdscr):
    status = {'run': True}
    status['mode'] = "hotkey"
    status['baseaddr'] = 0x01fe
    breakpoints = []
    sim = lc3py.Simulator()
    curses.curs_set(0) # Hide cursor
    maxy, maxx = stdscr.getmaxyx()
    status['col0width'] = 45
    current_col0width = 45
    hotkeyheight = 4
    reg_win = curses.newwin(13, status['col0width'], 0, 0)
    mem_win = curses.newwin(maxy-13, status['col0width'], 13, 0)
    hotkeys_win = curses.newwin(hotkeyheight, maxx-status['col0width'], 0, status['col0width'])
    console_win = curses.newwin(maxy-hotkeyheight, maxx-status['col0width'], hotkeyheight, status['col0width'])
    stdscr.clear()
    curses.resizeterm(maxy,maxx)
    stdscr.refresh()
    
    threads = []
    threads.append(threading.Thread(target=input_handler, args=[stdscr, status], daemon=True))

    for t in threads:
        t.start()

    while True:
        # Draw the components
        if stdscr.getmaxyx() != (maxy,maxx) or current_col0width != status['col0width']:
            current_col0width = status['col0width']
            maxy, maxx = stdscr.getmaxyx()
            reg_win = curses.newwin(13, status['col0width'], 0, 0)
            mem_win = curses.newwin(maxy-13, status['col0width'], 13, 0)
            hotkeys_win = curses.newwin(hotkeyheight, maxx-status['col0width'], 0, status['col0width'])
            console_win = curses.newwin(maxy-hotkeyheight, maxx-status['col0width'], hotkeyheight, status['col0width'])
            stdscr.clear()
            curses.resizeterm(maxy,maxx)
            stdscr.refresh()
            
        draw_registers(reg_win, sim)
        
        # Draw a simple console box
        mem_win.erase()
        mem_win.box()
        mem_win.addstr(0,2, " Memory ")
        draw_mem(mem_win, sim, breakpoints, status)
        mem_win.refresh()
        
        hotkey_prompt = hotkey_str(status, maxx-status['col0width'])
        if (len(hotkey_prompt) < hotkeyheight+2):
            hotkeyheight = len(hotkey_prompt) + 2
            hotkeys_win = curses.newwin(hotkeyheight, maxx-status['col0width'], 0, status['col0width'])
            console_win = curses.newwin(maxy-hotkeyheight, maxx-status['col0width'], hotkeyheight, status['col0width'])
            stdscr.refresh()
        
        hotkeys_win.erase()
        hotkeys_win.box()
        hotkeys_win.addstr(0,2, " Hotkeys ")
        for i in range(len(hotkey_prompt)):
            try:
                hotkeys_win.addstr(i+1, 1, hotkey_prompt[i])
            except:
                pass
        hotkeys_win.refresh()

        
        console_win.erase()
        console_win.box()
        console_win.addstr(0,2, " Console ")
        console_win.addstr(1,2, str(len(hotkey_prompt)))
        console_win.refresh()
        
        if status['run'] == False:
            break

        time.sleep(0.1)

    for t in threads:
        t.join()
            
def lc3pysim():    
    curses.wrapper(cli_main)