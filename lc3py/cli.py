import sys
from .cli_bindings import asm_main, sim_main
import lc3py
import curses
import curses.ascii
import threading
import multiprocessing
import time
import textwrap
import collections
import os
os.environ['PYGAME_HIDE_SUPPORT_PROMPT'] = 'hide'
import pygame
import numpy as np
import ctypes

#from .core import sim_backend

def lc3asm():
    # Pass terminal arguments to the C++ run function
    sys.exit(asm_main(sys.argv))

def lc3sim():
    sys.exit(sim_main(sys.argv))

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
    sim.set_pc(0x3000)

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
        elif abs(signedval) == 9:
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
        if(".fill" in sim.read_mem_line(i).lower()) or (".blkw" in sim.read_mem_line(i).lower()) or sim.read_mem_line(i) == "":
            val = sim.read_mem(i)
            signedval = val
            if val >= 0x8000:
                signedval = -((~val + 1) & 0x7fff)
            char = ""
            if abs(signedval) >= 32 and abs(signedval) <= 126:
                char = chr(abs(signedval))
            elif val == 0:
                char = "\\0"
            elif abs(signedval) == 9:
                char = "\\t"
            elif abs(signedval) == 10:
                char = "\\n"
            elif abs(signedval) == 13:
                char = "\\r"
            if char != "":
                char = f"\'{char}\'"
            if char != "" and signedval < 0:
                char = "-" + char
            if (".fill" in sim.read_mem_line(i).lower()) or (".blkw" in sim.read_mem_line(i).lower()):
                tmp = ""
                if ".blkw" in sim.read_mem_line(i).lower():
                    tmp = sim.read_mem_line(i).lower().split(".blkw")
                elif ".fill" in sim.read_mem_line(i).lower():
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

def display_proc(shm_name, key, run):
    shm = multiprocessing.shared_memory.SharedMemory(name=shm_name)
    image_data = np.ndarray((128,124,3), dtype=np.uint8, buffer=shm.buf)
    pygame.init()
    pygame.display.set_caption("LC3 Display")
    screen = pygame.display.set_mode((256, 248))
    while run.value:
        time.sleep(.01)
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                break
            
            if event.type == pygame.KEYDOWN and event.unicode:
                # Send the key name or unicode to the curses process
                key.value = ord(event.unicode)
        surface = pygame.surfarray.make_surface(image_data.swapaxes(0, 1))
        scaled = pygame.transform.scale(surface, (256, 248))
        screen.blit(scaled, (0, 0))
        pygame.display.flip()
    shm.close()



def sim_proc(reg_lines, mem_lines, breakpoints, console_out, kbd_input, status, locks, disp_key):
    sim = lc3py.Simulator()
    load_args(sim)
    key = 0
    next_screen_update = time.time() + 0.1
    running = False
    step_trap = False
    break_set = False
    local_breakpoints = []
    shm = multiprocessing.shared_memory.SharedMemory(create=True, size=128*124*3)
    image_data = np.ndarray((128, 124, 3), dtype=np.uint8, buffer=shm.buf)
    mgr = multiprocessing.Manager()
    disp_run = mgr.Value(ctypes.c_bool, False)
    p = False
    while(True):

        if sim.read_mem(sim.get_pc()) == 0xf025 and running:
            status['mode'] = 'break'
            running = False
        
        if running:
            if sim.get_pc() in local_breakpoints and not break_set:
                break_set = True
                running = False
                status['mode'] = 'break'
            else:
                break_set = False
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
                    if sim.read_mem(sim.get_pc()) != 0xf025:
                        if sim.read_mem(sim.get_pc()) >> 12 == 0xF or sim.get_pc() < 0x3000:
                            step_trap = True
                            running = True
                            status['mode'] = 'running'
                        sim.step_in()
        
        if time.time() >= next_screen_update:
            #put all interprocess communication in here to not bog down simulator
            if not status['run']:
                break
            next_screen_update += 0.05
            local_breakpoints = breakpoints[:]
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
            if status['reassemble']:
                status['reassemble'] = False
                for f in sys.argv[1:]:
                    sim.assemble(f[:-4] + ".asm")
            stdout = sim.read()
            if len(stdout) > 0:
                with locks['console']:
                    console_out.put(stdout)
            if status['restart']:
                status['restart'] = False
                sim.reinit()
                load_args(sim)
                running = False
                status['mode'] = 'break'
            status['pc'] = sim.get_pc()
            status['rti_pc'] = sim.read_mem(0x2ffe)
            new_reg_lines = registers_str(sim)
            with locks['reg']:
                reg_lines [:] = []
                reg_lines.extend(new_reg_lines)
            new_mem_lines = mem_str(status['mem_maxyx'][0], status['mem_maxyx'][1], sim, breakpoints, status)
            with locks['mem']:
                mem_lines[:] = []
                mem_lines.extend(new_mem_lines)
            if status['display']:
                if not p:
                    p = multiprocessing.Process(target=display_proc, args=[shm.name, disp_key, disp_run])
                    disp_run.value = True
                    p.start()
                for addr in range(0xc000, 0xfe00):
                    y = (addr - 0xc000) // 128
                    x = (addr - 0xc000) % 128
                    data = sim.read_mem(addr)
                    b = data & 0x1f
                    b = b << 3
                    data = data >> 5
                    g = data & 0x1f
                    g = g << 3
                    data = data >> 5
                    r = data & 0x1f
                    r = r << 3
                    image_data[x][y][0] = r
                    image_data[x][y][1] = g
                    image_data[x][y][2] = b
            else:
                if p:
                    p.kill()
                    p = False

    disp_run.value = False 
    shm.close()
    shm.unlink()
    return

def input_handler(stdscr, status, kbd_input, breakpoints, locks, kbdwindow, console, disp_key):
    while(True):
        time.sleep(.01)
        key = kbdwindow.getch()
        if disp_key.value > 0:
            key = disp_key.value
            disp_key.value = -1
        if key == 27:
            status['mode'] = 'break'
        if key > 0: 
            if status['mode'] == 'break':
                if key == ord('q') and status['mode'] == 'break':
                    status['run'] = False
                    break
                if key == ord('r'):
                    status['mode'] = 'running'
                if key == ord('h'):
                    status['col0width'] = max(39,status['col0width'] - 1)
                if key == ord('l'):
                    status['col0width'] = min(status['col0width'] + 1, status['maxx'])
                if key == ord('s'):
                    kbd_input.put(key)
                if key == ord('n'):
                    status['mem_locked'] = not status['mem_locked']
                if key == ord('k'):
                    status['mem_locked'] = True
                    if status['baseaddr'] > 0:
                        status['baseaddr'] -= 1
                if key == ord('j'):
                    status['mem_locked'] = True
                    status['baseaddr'] += 1
                if key == ord('e'):
                    status['restart'] = True
                if key == ord('a'):
                    status['reassemble'] = True
                    status['restart'] = True
                if key == ord('b'):
                    status['mode'] = 'set_breakpoint'
                if key == ord('c'):
                    console.clear()
                if key == ord('g'):
                    status['mode'] = "set_baseaddr"
                    status["new_baseaddr"] = ""
                if key == ord('d'):
                    status['display'] = not status['display']
            elif status['mode'] == 'set_breakpoint':
                if key in [10, 13, curses.KEY_ENTER]:
                    with locks['breakpoint']:
                        try:
                            bp = int(status['breakpoint'], 16)
                            if bp in breakpoints:
                                breakpoints.remove(bp)
                            else:
                                breakpoints.append(bp)
                        except:
                            pass
                    status['breakpoint'] = ""
                    status['mode'] = 'break'
                if curses.ascii.isascii(key) and key != curses.KEY_BACKSPACE and key != curses.ascii.DEL:
                    status['breakpoint'] += chr(key)
                elif key == curses.KEY_BACKSPACE or key == curses.ascii.DEL:
                    if len(status['breakpoint']) > 0:
                        status['breakpoint'] = status['breakpoint'][:-1]
            elif status['mode'] == 'set_baseaddr':
                if key in [10, 13, curses.KEY_ENTER]:
                    try:
                        status['baseaddr'] = int(status["new_baseaddr"], 16)
                        status['mem_locked'] = True
                    except:
                        pass
                    status["new_baseaddr"] = ""
                    status['mode'] = 'break'
                if curses.ascii.isascii(key) and key != curses.KEY_BACKSPACE and key != curses.ascii.DEL:
                    status["new_baseaddr"] += chr(key)
                elif key == curses.KEY_BACKSPACE or key == curses.ascii.DEL:
                    if len(status['new_baseaddr']) > 0:
                        status["new_baseaddr"] = status["new_baseaddr"][:-1]
                        
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
        lockstr = ""
        if status['mem_locked'] == True:
            lockstr = "unlock"
        else:
            lockstr = "lock"
        retstr = f"s:step-in r:run q:quit b:breakpoints g:goto-address a:reassemble h:hsplit-left "
        retstr += f"l:hsplit-right e:restart c:clear-console n:{lockstr}-mem-screen k:mem-scroll-up j:mem-scroll-down" 
        retstr += " d:toggle-display"
    elif status['mode'] == 'set_breakpoint':
        retstr = f"Enter address to toggle breakpoint: " + status['breakpoint']
    elif status['mode'] == 'set_baseaddr':
        retstr = "Enter new starting address for memory window: " + status["new_baseaddr"]
    strwidth = max(5, strwidth)
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
    status['mem_locked'] = False
    status['restart'] = False
    status['reassemble'] = False
    status['breakpoint'] = ""
    status['new_baseaddr'] = ""
    status['display'] = False
    breakpoints = []
    #sim = lc3py.Simulator()
    curses.curs_set(0) # Hide cursor
    maxy, maxx = stdscr.getmaxyx()
    maxx = max(maxx, 80)
    maxy = max(maxy, 20)
    status['maxx'] = maxx
    status['maxy'] = maxy
    status['col0width'] = 45
    last_col0width = 45
    hotkey_prompt = hotkey_str(status, maxx-status['col0width'])
    hotkeyheight = len(hotkey_prompt) + 2
    reg_win = curses.newwin(13, status['col0width'], 0, 0)
    mem_win = curses.newwin(maxy-13, status['col0width'], 13, 0)
    hotkeys_win = curses.newwin(hotkeyheight, maxx-status['col0width'], 0, status['col0width'])
    console_win = curses.newwin(maxy-hotkeyheight, maxx-status['col0width'], hotkeyheight, status['col0width'])
    kbdwindow = curses.newwin(0,0,0,0)
    kbdwindow.nodelay(True)
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

    reg_lines = mgr.list()
    mem_lines = mgr.list()
    breakpoints = mgr.list()
    console_q = mgr.Queue()
    kbd_input = mgr.Queue()
    locks = mgr.dict()
    locks['mem'] = mgr.Lock()
    locks['reg'] = mgr.Lock()
    locks['console'] = mgr.Lock()
    locks['breakpoint'] = mgr.Lock()

    disp_key = mgr.Value('i', -1)

    input_thread = threading.Thread(target=input_handler, args=[stdscr, status, kbd_input, breakpoints, locks, kbdwindow, console_deque, disp_key], daemon=True)
    input_thread.start()


    sim = multiprocessing.Process(target=sim_proc, args=[reg_lines, mem_lines, breakpoints, console_q, kbd_input, status, locks, disp_key])
    sim.start()
    while True:
        #Update size and location of windows
        new_maxy, new_maxx = stdscr.getmaxyx()
        new_maxx = max(80, new_maxx)
        new_maxy = max(20, new_maxy)
        hotkey_prompt = hotkey_str(status, new_maxx-status['col0width'])
        if (new_maxy, new_maxx) != (maxy,maxx) or (len(hotkey_prompt) < hotkeyheight+2) or last_col0width != status['col0width']:
            last_col0width = status['col0width']
            hotkeyheight = len(hotkey_prompt) + 2
            stdscr.erase()
            if (new_maxy, new_maxx) != (maxy,maxx):
                maxy, maxx = (new_maxy, new_maxx)
                curses.resize_term(maxy,maxx)
                status['maxx'] = new_maxx
                status['maxy'] = new_maxy
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

        if not status['mem_locked']:
            if status['pc'] >= 0x3000:
                status['baseaddr'] = status['pc'] - 3
            else:
                status['baseaddr'] = max(0, status['rti_pc'] - 3)

        mem_win.erase()
        mem_win.addstr(0,2, " Memory ")
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
        try:
            hotkeys_win.addstr(0,2, " Hotkeys ")
        except:
            pass
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
        try:
            console_win.addstr(0,2, " Console ")
        except:
            pass
        console_pos = console_win.getmaxyx()[0]-2
        with locks['console']:
            for line in reversed(console_deque):
                if len(line) == 0:
                    console_pos -= 1
                    continue
                wrapped = textwrap.wrap(line, console_win.getmaxyx()[1]-2)
                for subline in reversed(wrapped):
                    try:
                        console_win.addstr(console_pos, 1, subline)
                    except:
                        pass
                    console_pos -= 1
                    if console_pos <= 0:
                        break
                if console_pos <= 0:
                    break
        console_win.noutrefresh()
        
        if status['run'] == False:
            break
        
        stdscr.refresh()
        curses.doupdate()

        time.sleep(0.05)
    input_thread.join()
    sim.join()
            
def lc3pysim():
    curses.wrapper(cli_main)