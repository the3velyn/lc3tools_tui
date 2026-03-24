import sys
from .cli_bindings import asm_main, sim_main
import lc3py
import curses
import threading
import multiprocessing
import time
import textwrap
import collections

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

def registers_str(sim):
    lines = []
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
        lines.append(f"R{i}:\tx{val:04X}\t{val}\t{signedval}\t{char}")
    lines.append("\n")
    cc = ""
    psr = sim.read_psr()
    if psr & 1:
        cc = "P"
    elif psr & 2:
        cc = "Z"
    elif psr & 4:
        cc = "N"
    lines.append(f"PC: x{sim.get_pc():04X}\tCC: {cc}")
    return lines

def mem_str(maxy, maxx, sim, breakpoints, status):
    addrcount = maxy-2
    maxchars = maxx -2
    lines = []
    for i in range(status['baseaddr'], status['baseaddr']+addrcount):
        line = ""
        if sim.get_pc() == i:
            line += ">"
        elif sim.get_pc() < 0x3000 and sim.read_mem(0x2ffe)-1 == i:
            line += "T"
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
    return lines

def sim_proc(reg_lines, mem_lines, breakpoints, console_out, kbd_input, status, locks):
    sim = lc3py.Simulator()
    load_args(sim)
    key = 0
    next_screen_update = time.time() + 0.1
    running = False
    step_trap = False
    while(True):

        if sim.read_mem(sim.get_pc()) == 0xf025:
            status['mode'] = 'break'
            running = False
        
        if running:
            sim.step_in()
            if step_trap:
                if sim.get_pc() >= 0x3000:
                    running = False
                    step_trap = False
                    status['mode'] = 'break'
        else:
            time.sleep(0.01) #lower CPU usage while stopped
            if not kbd_input.empty():
                key = kbd_input.get()
                if key == ord('s'):
                    if sim.read_mem(sim.get_pc()) >> 12 == 0xF:
                        step_trap = True
                        running = True
                        status['mode'] = 'running'
                    sim.step_in()
        
        if time.time() >= next_screen_update:
            #put all interprocess communication in here to not bog down simulator
            if not status['run']: break
            next_screen_update += 0.02
            if status['mode'] == 'running':
                running = True
            else:
                running = False
            if running:
                while not kbd_input.empty():
                    key = kbd_input.get()
                    sim.write(chr(key))
            else:
                if not kbd_input.empty():
                    key = kbd_input.get()
                    if key == ord('r'):
                        status['mode'] = 'running'
            stdout = sim.read()
            if len(stdout) > 0:
                console_out.put(stdout)
            if sim.get_pc() >= 0x3000:
                status['pc'] = sim.get_pc()
            else:
                status['rti_pc'] = sim.read_mem(0x2ffe)
            with locks['reg']:
                reg_lines [:] = []
                reg_lines.extend(registers_str(sim))
            with locks['mem']:
                mem_lines[:] = []
                mem_lines.extend(mem_str(status['mem_maxyx'][0], status['mem_maxyx'][1], sim, breakpoints, status))
    return

def input_handler(stdscr, status, kbd_input):
    while(True):
        key = stdscr.getch()
        if key == 27:
            status['mode'] = 'break'
    
        if status['mode'] == 'break':
            if key == ord('q') and status['mode'] == 'break':
                status['run'] = False
                break
            if key == ord('r'):
                status['mode'] = 'running'
            if key == ord('h'):
                status['col0width'] = max(39,status['col0width'] - 1)
            if key == ord('l'):
                status['col0width'] = status['col0width'] + 1
            if key == ord('s'):
                kbd_input.put(key)
        else:
            kbd_input.put(key)



def enter_is_terminate(ch):
    """Custom validator: lets Enter (10 or 13) finish the input."""
    if ch in (10, 13, curses.KEY_ENTER):
        return 7  # 7 is the ASCII code for Bell, which textpad treats as 'stop'
    return ch

def move_and_resize(win, new_y, new_x, new_h, new_w):
    try:
        # Get current dimensions
        curr_h, curr_w = win.getmaxyx()
        
        # If shrinking, resize before moving
        if new_h < curr_h or new_w < curr_w:
            win.resize(new_h, new_w)
            win.mvwin(new_y, new_x)
        # If growing, move before resizing
        else:
            win.mvwin(new_y, new_x)
            win.resize(new_h, new_w)
            
    except curses.error:
        # This occurs if the window would be off-screen at any point
        pass

def hotkey_str(status, win_width):
    strwidth = win_width - 2
    retstr = ""
    if status['mode'] == 'running':
        retstr = "Input forwarded to LC3 keyboard. Press [Esc] to pause simulator."
    elif status['mode'] == 'break':
        retstr = "s:step-in o:step-over r:run q:quit b:breakpoints h:hsplit-left l:hsplit-right restart reassemble lock-mem-screen" 
    
    retstr = textwrap.wrap(retstr, strwidth, break_long_words=False, break_on_hyphens=False)
    return retstr

def cli_main(stdscr):
    mgr = multiprocessing.Manager()
    status = mgr.dict()
    status['run'] = True
    status['mode'] = 'break'
    status['baseaddr'] = 0x01fe
    status['pc'] = 0x01fe
    status['rti_pc'] = 0x3000
    breakpoints = []
    #sim = lc3py.Simulator()
    curses.curs_set(0) # Hide cursor
    maxy, maxx = stdscr.getmaxyx()
    status['col0width'] = 45
    last_col0width = 45
    hotkey_prompt = hotkey_str(status, maxx-status['col0width'])
    hotkeyheight = len(hotkey_prompt) + 2
    reg_win = curses.newwin(13, status['col0width'], 0, 0)
    mem_win = curses.newwin(maxy-13, status['col0width'], 13, 0)
    hotkeys_win = curses.newwin(hotkeyheight, maxx-status['col0width'], 0, status['col0width'])
    console_win = curses.newwin(maxy-hotkeyheight, maxx-status['col0width'], hotkeyheight, status['col0width'])
    curses.use_default_colors()
    try:
        curses.set_escdelay(25)
    except:
        pass
    stdscr.clear()
    curses.resize_term(maxy,maxx)
    stdscr.refresh()

    console_tmp = []
    console_deque = collections.deque()
    current_console_line = ""

    kbd_input = mgr.Queue()
    input_thread = threading.Thread(target=input_handler, args=[stdscr, status, kbd_input], daemon=True)
    input_thread.start()

    reg_lines = mgr.list()
    mem_lines = mgr.list()
    breakpoints = mgr.list()
    console_q = mgr.Queue()
    locks = mgr.dict()
    locks['mem'] = mgr.Lock()
    locks['reg'] = mgr.Lock()
    locks['console'] = mgr.Lock()

    sim = multiprocessing.Process(target=sim_proc, args=[reg_lines, mem_lines, breakpoints, console_q, kbd_input, status, locks])
    sim.start()

    while True:
        #Update size and location of windows
        hotkey_prompt = hotkey_str(status, stdscr.getmaxyx()[1]-status['col0width'])
        if stdscr.getmaxyx() != (maxy,maxx) or (len(hotkey_prompt) < hotkeyheight+2) or last_col0width != status['col0width']:
            last_col0width = status['col0width']
            hotkeyheight = len(hotkey_prompt) + 2
            stdscr.erase()
            if stdscr.getmaxyx() != (maxy,maxx):
                maxy, maxx = stdscr.getmaxyx()
                curses.resize_term(maxy,maxx)
            reg_win.resize(13, status['col0width'])
            mem_win.resize(maxy-13, status['col0width'])
            move_and_resize(hotkeys_win, 0, status['col0width'], hotkeyheight, maxx-status['col0width'])
            move_and_resize(console_win, hotkeyheight, status['col0width'], maxy-hotkeyheight, maxx-status['col0width'])
            stdscr.noutrefresh()
            
        status['scr_maxyx'] = stdscr.getmaxyx()
        status['mem_maxyx'] = mem_win.getmaxyx()
        
        reg_win.erase()
        #reg_lines = draw_registers(sim)
        try:
            reg_win.addstr(0, 2, " Regs ")
            reg_win.addstr(1,2,"Reg\tHex\tuint\tint\tchar")
            i = 2
            with locks['reg']:
                for line in reg_lines:
                    reg_win.addstr(i, 2, line)
                    i += 1
        except:
            pass
        reg_win.box()
        reg_win.noutrefresh()

        if status['pc'] >= 0x3000:
            status['baseaddr'] = status['pc'] - 3
        else:
            status['baseaddr'] = status['rti_pc'] - 3

        mem_win.erase()
        mem_win.addstr(0,2, " Memory ")
        #mem_lines = draw_mem(mem_win.getmaxyx()[0], mem_win.getmaxyx()[1], sim, breakpoints, status)
        with locks['mem']:
            for i in range(len(mem_lines)):
                try:
                    mem_win.addstr(i+1, 1, mem_lines[i])
                except:
                    pass
        mem_win.box()
        mem_win.noutrefresh()
        
        
        hotkeys_win.erase()
        hotkeys_win.box()
        hotkeys_win.addstr(0,2, " Hotkeys ")
        for i in range(len(hotkey_prompt)):
            try:
                hotkeys_win.addstr(i+1, 1, hotkey_prompt[i])
            except:
                pass
        hotkeys_win.noutrefresh()

        
        while not console_q.empty():
            console_tmp.append(console_q.get())
        console_tmp = "".join(console_tmp)
        if len(console_tmp) > 0:
            sp = console_tmp.split("\n")
            for i in range(len(sp)):
                if i == 0 and len(console_deque) > 0:
                    console_deque[-1] = console_deque[-1] + sp[0]
                else:
                    console_deque.append(sp[i])
        console_tmp = []

        console_win.erase()
        console_win.box()
        console_win.addstr(0,2, " Console ")
        console_pos = console_win.getmaxyx()[0]-2
        for line in reversed(console_deque):
            if len(line) == 0:
                console_pos -= 1
                continue
            wrapped = textwrap.wrap(line, console_win.getmaxyx()[1]-2)
            for subline in reversed(wrapped):
                console_win.addstr(console_pos, 1, subline)
                console_pos -= 1
                if console_pos <= 0:
                    break
            if console_pos <= 0:
                break
        #console_win.addstr(1,2, str(len(hotkey_prompt)))
        console_win.noutrefresh()
        
        if status['run'] == False:
            break
        
        curses.doupdate()

        time.sleep(0.05)

    input_thread.join()
    sim.join()
            
def lc3pysim():    
    curses.wrapper(cli_main)