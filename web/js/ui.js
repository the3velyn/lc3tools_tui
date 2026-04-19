/**
 * LC-3 Web UI Controller
 * Manages rendering, keyboard events, mode state machine.
 */

const MODES = { BREAK: 'BREAK', RUNNING: 'RUNNING', SLOW_RUN: 'SLOW_RUN', SET_BREAKPOINT: 'SET_BREAKPOINT', GOTO_ADDRESS: 'GOTO_ADDRESS' };

const LC3_MNEMONICS = new Set([
  'ADD','AND','NOT','BR','BRN','BRZ','BRP','BRNZ','BRZP','BRNP','BRNZP',
  'JMP','JSR','JSRR','LD','LDI','LDR','LEA','RET','RTI',
  'ST','STI','STR','TRAP','NOP','GETC','OUT','PUTC','PUTS','IN','PUTSP','HALT',
  '.ORIG','.END','.FILL','.BLKW','.STRINGZ'
]);

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function hex4(n) { return 'x' + (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'); }
function toSigned(v) { return v >= 0x8000 ? v - 0x10000 : v; }

function charRepr(val, uval) {
  const av = Math.abs(val);
  let ch = '';
  if (av >= 32 && av <= 126) ch = "'" + String.fromCharCode(av) + "'";
  else if (uval === 0) ch = "'\\0'";
  else if (av === 9) ch = "'\\t'";
  else if (av === 10) ch = "'\\n'";
  else if (av === 13) ch = "'\\r'";
  if (ch && val < 0) ch = '-' + ch;
  return ch;
}

function splitLabel(line) {
  if (!line) return ['', ''];
  const trimmed = line.trimStart();
  if (!trimmed) return ['', ''];
  const spaceIdx = trimmed.search(/[\s]/);
  const firstToken = spaceIdx === -1 ? trimmed : trimmed.substring(0, spaceIdx);
  if (LC3_MNEMONICS.has(firstToken.toUpperCase())) return ['', trimmed];
  if (spaceIdx === -1) return [firstToken, ''];
  return [firstToken, trimmed.substring(spaceIdx).trimStart()];
}

// Syntax highlighting for instruction text
function highlightInstr(instr) {
  if (!instr) return '';
  const tokens = tokenizeInstr(instr);
  return tokens.map(tok => {
    if (!tok.trim() || tok === ',') return esc(tok);
    if (tok.startsWith(';')) return `<span class="syn-comment">${esc(tok)}</span>`;
    if (tok.startsWith('"')) return `<span class="syn-string">${esc(tok)}</span>`;
    const upper = tok.toUpperCase();
    if (tok.startsWith('.')) return `<span class="syn-directive">${esc(tok)}</span>`;
    if (LC3_MNEMONICS.has(upper)) return `<span class="syn-mnemonic">${esc(tok)}</span>`;
    if (/^R[0-7]$/i.test(tok)) return `<span class="syn-register">${esc(tok)}</span>`;
    if (/^[#xXbB0-9-]/.test(tok) && /^(#-?\d+|[xX][0-9a-fA-F]+|0[xX][0-9a-fA-F]+|[bB][01]+|-?\d+)$/.test(tok))
      return `<span class="syn-number">${esc(tok)}</span>`;
    return esc(tok);
  }).join('');
}

function tokenizeInstr(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ' || s[i] === '\t') {
      let start = i;
      while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
      tokens.push(s.substring(start, i));
    } else if (s[i] === ';') {
      tokens.push(s.substring(i));
      break;
    } else if (s[i] === '"') {
      let start = i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) i++;
        i++;
      }
      if (i < s.length) i++;
      tokens.push(s.substring(start, i));
    } else if (s[i] === ',') {
      tokens.push(',');
      i++;
    } else {
      let start = i;
      while (i < s.length && s[i] !== ' ' && s[i] !== '\t' && s[i] !== ',' && s[i] !== ';') i++;
      tokens.push(s.substring(start, i));
    }
  }
  return tokens;
}

class UIController {
  constructor(machine) {
    this.machine = machine;
    this.mode = MODES.BREAK;
    this.breakpoints = new Set();
    this.symbols = new Map();       // addr → label
    this.symbolsByName = new Map();  // lowercase label → addr
    this.prevRegs = new Uint16Array(8);
    this.prevPC = 0;
    this.memBaseAddr = 0x3000 - 3;
    this.memLocked = false;
    this.memRows = 30;
    this.raceSubroutines = true;
    this.consoleLines = [];
    this.inputEntry = '';
    this.skipBpOnce = false;
    this.racingSub = false;
    this.slowTimer = null;
    this.runRAF = null;

    // B8: display peripheral panel state
    this.displayVisible = false;
    this.displayCanvas = null;
    this.displayCtx = null;
    // Parity with upstream pygame display: 128×124 @ 0xC000, 5-6-5 RGB.
    this.DISP_BASE = 0xC000;
    this.DISP_W = 128;
    this.DISP_H = 124;

    this._bindElements();
    this._bindKeys();
    this._bindButtons();
    this._bindScroll();
    this._bindMemoryClick();
    this._memLineHeight = 0;
    window.addEventListener('resize', () => {
      this._memLineHeight = 0; // recalculate on resize
      this.render();
    });
    this.render();
  }

  setSymbols(symbols) {
    this.symbols = symbols instanceof Map ? symbols : new Map(Object.entries(symbols));
    this.symbolsByName = new Map();
    for (const [addr, name] of this.symbols) {
      this.symbolsByName.set(name.toLowerCase(), addr);
    }
  }

  _bindElements() {
    this.regsEl = document.getElementById('regs-content');
    this.memEl = document.getElementById('memory-content');
    this.hotkeysEl = document.getElementById('hotkeys-content');
    this.consoleEl = document.getElementById('console-content');
    this.statusEl = document.getElementById('status');
    this.overlayEl = document.getElementById('input-overlay');
    this.inputPromptEl = document.getElementById('input-prompt');
    this.inputFieldEl = document.getElementById('input-field');
  }

  _bindScroll() {
    const memPane = document.getElementById('pane-memory');
    memPane.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = Math.sign(e.deltaY); // +1 = scroll down, -1 = scroll up
      this.memLocked = true;
      this.memBaseAddr += delta;
      this.render();
    }, { passive: false });
  }

  _bindButtons() {
    document.getElementById('btn-run').addEventListener('click', () => this._setMode(MODES.RUNNING));
    document.getElementById('btn-slow').addEventListener('click', () => this._setMode(MODES.SLOW_RUN));
    document.getElementById('btn-pause').addEventListener('click', () => this._setMode(MODES.BREAK));
    document.getElementById('btn-restart').addEventListener('click', () => this._restart());

    this.followPcBtn = document.getElementById('btn-follow-pc');
    this.followPcBtn.addEventListener('click', () => {
      this.memLocked = !this.memLocked;
      this.render();
    });
  }

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      // If focus is in the editor textarea, let the browser handle everything
      // (typing, Ctrl+Z undo, Ctrl+Shift+Z redo, Tab, etc.)
      const active = document.activeElement;
      if (active && (active.classList.contains('editor-textarea') || active.closest('#pane-editor'))) {
        return;
      }

      // Input overlay active
      if (this.mode === MODES.SET_BREAKPOINT || this.mode === MODES.GOTO_ADDRESS) {
        if (e.key === 'Escape') {
          this._hideOverlay();
          this._setMode(MODES.BREAK);
          e.preventDefault();
          return;
        }
        if (e.key === 'Enter') {
          this._submitInput();
          e.preventDefault();
          return;
        }
        return; // let input field handle typing
      }

      // Running modes: Esc pauses, chars go to LC3
      if (this.mode === MODES.RUNNING || this.mode === MODES.SLOW_RUN) {
        if (e.key === 'Escape') {
          this._setMode(MODES.BREAK);
          e.preventDefault();
          return;
        }
        if (e.key.length === 1) {
          this.machine.feedInput(e.key.charCodeAt(0));
          e.preventDefault();
        } else if (e.key === 'Enter') {
          this.machine.feedInput(10);
          e.preventDefault();
        }
        return;
      }

      // Break mode keybinds
      if (this.mode === MODES.BREAK) {
        switch (e.key) {
          case 's': this._setMode(MODES.SLOW_RUN); break;
          case 'r': this._setMode(MODES.RUNNING); break;
          case 'i': this.machine.step(); this._drainOutput(); this.render(); break;
          case 'o': this.machine.stepOver(); this._drainOutput(); this.render(); break;
          case 'e': this._restart(); break;
          case 'E': this.reset(); break;                           // B3: reinit
          case 'c': this.clearConsole(); break;                    // B4: clear console
          case 'd': this.displayVisible = !this.displayVisible;    // B8: toggle display
                    this._toggleDisplayPanel(); this.render(); break;
          case 'b': this._showOverlay('Toggle breakpoint (hex addr or label):', MODES.SET_BREAKPOINT); break;
          case 'z': this._showOverlay('Jump to (hex addr or label):', MODES.GOTO_ADDRESS); break;
          case 'n': this.memLocked = !this.memLocked; this.render(); break;
          case 'j': this.memLocked = true; this.memBaseAddr++; this.render(); break;
          case 'k': this.memLocked = true; this.memBaseAddr--; this.render(); break;
          case 't': this.raceSubroutines = !this.raceSubroutines; this.render(); break;
          default: return;
        }
        e.preventDefault();
      }
    });
  }

  _setMode(mode) {
    const wasBreak = this.mode === MODES.BREAK;
    this.mode = mode;
    this._stopExecution();

    if (mode === MODES.RUNNING) {
      if (wasBreak) this.skipBpOnce = true;
      this._startRun();
    } else if (mode === MODES.SLOW_RUN) {
      if (wasBreak) this.skipBpOnce = true;
      this.racingSub = false;
      this._startSlowRun();
    } else {
      this.render();
    }
  }

  _stopExecution() {
    if (this.runRAF) { cancelAnimationFrame(this.runRAF); this.runRAF = null; }
    if (this.slowTimer) { clearTimeout(this.slowTimer); this.slowTimer = null; }
  }

  _startRun() {
    const frame = () => {
      if (this.mode !== MODES.RUNNING) return;
      const BATCH = 50000;
      for (let i = 0; i < BATCH; i++) {
        if (this.machine.halted) { this._setMode(MODES.BREAK); return; }
        const pc = this.machine.pc;
        if (!this.skipBpOnce && this.breakpoints.has(pc)) {
          this._setMode(MODES.BREAK);
          return;
        }
        this.skipBpOnce = false;
        this.machine.step();
        this._drainOutput();
      }
      this.render();
      this.runRAF = requestAnimationFrame(frame);
    };
    this.runRAF = requestAnimationFrame(frame);
  }

  _startSlowRun() {
    const tick = () => {
      if (this.mode !== MODES.SLOW_RUN) return;
      if (this.machine.halted) { this._setMode(MODES.BREAK); return; }

      const pc = this.machine.pc;
      if (!this.skipBpOnce && this.breakpoints.has(pc)) {
        this._setMode(MODES.BREAK);
        return;
      }
      this.skipBpOnce = false;

      const instr = this.machine.memory[this.machine.pc];
      const opcode = (instr >> 12) & 0xF;
      const isTrap = opcode === 0xF && instr !== 0xF025;
      const isCall = opcode === 0x4;

      this.machine.step();
      this._drainOutput();

      if (this.machine.halted) { this._setMode(MODES.BREAK); return; }
      if (this.breakpoints.has(this.machine.pc)) {
        this._setMode(MODES.BREAK);
        return;
      }

      // Race through trap/subroutine bodies at full speed when enabled.
      // Traps always race (they're internal); JSR/JSRR race only if toggle is on.
      if (isTrap || (this.raceSubroutines && isCall)) {
        this.racingSub = true;
        this._raceLoop();
        return;
      }

      this.render();
      this.slowTimer = setTimeout(tick, 500);
    };
    tick();
  }

  _raceLoop() {
    const BATCH = 10000;
    const frame = () => {
      if (this.mode !== MODES.SLOW_RUN || !this.racingSub) return;
      for (let i = 0; i < BATCH; i++) {
        if (this.machine.halted) {
          this.racingSub = false;
          this._setMode(MODES.BREAK);
          return;
        }
        if (this.machine.pc >= 0x3000) {
          this.racingSub = false;
          this._drainOutput();
          this.render();
          this.slowTimer = setTimeout(() => this._startSlowRun(), 500);
          return;
        }
        if (this.breakpoints.has(this.machine.pc)) {
          this.racingSub = false;
          this._setMode(MODES.BREAK);
          return;
        }
        this.machine.step();
        this._drainOutput();
      }
      this.render();
      this.runRAF = requestAnimationFrame(frame);
    };
    this.runRAF = requestAnimationFrame(frame);
  }

  _restart() {
    this._stopExecution();
    this.machine.pc = 0x3000;
    this.machine.halted = false;
    this.mode = MODES.BREAK;
    this._snapshot();
    this.render();
  }

  // Full reset: clear machine, console, reload last assembly. Called via onReset callback.
  reset() {
    this._stopExecution();
    this.machine.reset();
    this.consoleLines = [];
    this.breakpoints.clear();
    this.mode = MODES.BREAK;
    this._snapshot();
    // Notify main.js to reload OS + last file
    if (this.onReset) this.onReset();
    this.render();
  }

  clearConsole() {
    this.consoleLines = [];
    this.render();
  }

  _drainOutput() {
    const chars = this.machine.drainOutput();
    for (const c of chars) {
      const ch = String.fromCharCode(c);
      if (ch === '\n') {
        this.consoleLines.push('');
      } else {
        if (this.consoleLines.length === 0) this.consoleLines.push('');
        this.consoleLines[this.consoleLines.length - 1] += ch;
      }
    }
    while (this.consoleLines.length > 500) this.consoleLines.shift();
  }

  _snapshot() {
    this.prevRegs = new Uint16Array(this.machine.registers);
    this.prevPC = this.machine.pc;
  }

  // ── Overlay for breakpoint/goto input ──────────────────
  _showOverlay(prompt, mode) {
    this.overlayEl.classList.remove('hidden');
    this.inputPromptEl.textContent = prompt;
    this.inputFieldEl.value = '';
    this.inputFieldEl.focus();
    this.mode = mode;
  }

  _hideOverlay() {
    this.overlayEl.classList.add('hidden');
    this.inputFieldEl.blur();
  }

  _submitInput() {
    const input = this.inputFieldEl.value.trim();
    this._hideOverlay();

    if (input) {
      const addr = this._resolveInput(input);
      if (addr !== null) {
        if (this.mode === MODES.SET_BREAKPOINT) {
          if (this.breakpoints.has(addr)) this.breakpoints.delete(addr);
          else this.breakpoints.add(addr);
        } else if (this.mode === MODES.GOTO_ADDRESS) {
          this.memLocked = true;
          this.memBaseAddr = addr - 3;
        }
      }
    }
    this._setMode(MODES.BREAK);
  }

  _resolveInput(input) {
    const findLabel = (name) => {
      const lower = name.toLowerCase();
      const addr = this.symbolsByName.get(lower);
      return addr !== undefined ? addr : null;
    };
    const parseHex = (s) => {
      if (!s) return null;
      const n = parseInt(s, 16);
      if (isNaN(n) || n.toString(16).length > s.replace(/^0+/, '').length + 1) {
        // Check that entire string was consumed
        if (/^[0-9a-fA-F]+$/.test(s)) return n & 0xFFFF;
        return null;
      }
      return n & 0xFFFF;
    };

    if (input.startsWith('0x') || input.startsWith('0X')) {
      return parseHex(input.slice(2));
    } else if (input.startsWith('x') || input.startsWith('X')) {
      return findLabel(input) ?? parseHex(input.slice(1));
    } else {
      return findLabel(input) ?? parseHex(input);
    }
  }

  // ── Rendering ──────────────────────────────────────────

  render() {
    this._updateMemBase();
    this._renderRegs();
    this._renderMemory();
    this._renderHotkeys();
    this._renderConsole();
    this._renderDisplay();
    this._updateButtons();
    // Snapshot AFTER render so next render can detect changes
    this._snapshot();
  }

  // B8: toggle — create (or hide) a <canvas> overlay for the LC-3 display
  // peripheral.  Inserted into #display-pane if present, else appended to body
  // as a fixed-position panel the user can move out of the way.
  _toggleDisplayPanel() {
    if (this.displayVisible && !this.displayCanvas) {
      const c = document.createElement('canvas');
      c.id = 'lc3-display';
      c.width = this.DISP_W;
      c.height = this.DISP_H;
      c.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px',
        'border:1px solid #888', 'background:#000',
        'image-rendering:pixelated',
        'width:' + (this.DISP_W * 3) + 'px',
        'height:' + (this.DISP_H * 3) + 'px',
        'z-index:999',
      ].join(';');
      document.body.appendChild(c);
      this.displayCanvas = c;
      this.displayCtx = c.getContext('2d');
    } else if (!this.displayVisible && this.displayCanvas) {
      this.displayCanvas.remove();
      this.displayCanvas = null;
      this.displayCtx = null;
    }
  }

  _renderDisplay() {
    if (!this.displayVisible || !this.displayCtx) return;
    const ctx = this.displayCtx;
    const img = ctx.createImageData(this.DISP_W, this.DISP_H);
    const data = img.data;
    const mem = this.machine.memory;
    for (let y = 0; y < this.DISP_H; y++) {
      for (let x = 0; x < this.DISP_W; x++) {
        const v = mem[this.DISP_BASE + y * this.DISP_W + x];
        const r5 = (v >> 11) & 0x1F;
        const g6 = (v >>  5) & 0x3F;
        const b5 =  v        & 0x1F;
        const idx = (y * this.DISP_W + x) * 4;
        data[idx]     = (r5 << 3) | (r5 >> 2);
        data[idx + 1] = (g6 << 2) | (g6 >> 4);
        data[idx + 2] = (b5 << 3) | (b5 >> 2);
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  _updateMemBase() {
    if (!this.memLocked) {
      const pc = this.machine.pc;
      this.memBaseAddr = pc - 3;
    }
    // Calculate visible rows to exactly fill the pane (no scrollbar)
    const body = this.memEl;
    if (body) {
      // Measure one line height using a temp element
      if (!this._memLineHeight) {
        const probe = document.createElement('div');
        probe.className = 'mem-line';
        probe.textContent = 'X';
        body.appendChild(probe);
        this._memLineHeight = probe.offsetHeight || 18;
        body.removeChild(probe);
      }
      const availH = body.clientHeight;
      this.memRows = Math.max(5, Math.floor(availH / this._memLineHeight));
    }
  }

  _renderRegs() {
    const m = this.machine;
    let html = '<div class="reg-header">Reg   Hex    uint    int   char</div>';

    for (let i = 0; i < 8; i++) {
      const v = m.registers[i];
      const sv = toSigned(v);
      const ch = charRepr(sv, v);
      const changed = v !== this.prevRegs[i];
      const cls = changed ? 'reg-changed' : '';

      let line = `R${i}:  ${hex4(v)}  ${String(v).padStart(5)}  ${String(sv).padStart(6)}  ${ch}`;

      // Symbol lookup
      const sym = this.symbols.get(v);
      const symHtml = sym ? `<span class="reg-sym">@${esc(sym)}</span>` : '';

      html += `<div class="reg-line ${cls}">${esc(line)}${symHtml}</div>`;
    }

    html += '<div class="reg-line">&nbsp;</div>';

    // PC + CC
    const pcChanged = m.pc !== this.prevPC;
    const pcCls = pcChanged ? 'pc-changed' : 'pc-line';
    const psr = m.psr;
    let ccChar = ' ', ccCls = '';
    if (psr & 4) { ccChar = 'N'; ccCls = 'cc-n'; }
    else if (psr & 2) { ccChar = 'Z'; ccCls = 'cc-z'; }
    else if (psr & 1) { ccChar = 'P'; ccCls = 'cc-p'; }

    html += `<div class="${pcCls}">PC: ${hex4(m.pc)}   CC: <span class="${ccCls}">${ccChar}</span></div>`;

    this.regsEl.innerHTML = html;
  }

  _renderMemory() {
    const m = this.machine;
    let html = '';
    const pc = m.pc;

    for (let i = 0; i < this.memRows; i++) {
      const addr = (this.memBaseAddr + i) & 0xFFFF;
      const val = m.memory[addr];
      const sourceLine = m.memLines.get(addr) || '';

      // Markers
      let marker = ' ';
      if (pc === addr) marker = '>';

      const bp = this.breakpoints.has(addr) ? 'B' : ' ';

      // Label from symbol table
      let label = this.symbols.get(addr) || '';
      if (label.length > 12) label = label.substring(0, 12);
      label = label.padEnd(12);

      // Instruction display
      let instrHtml;
      let isStrData = false;

      if (sourceLine.length === 1) {
        // .STRINGZ character data
        const c = sourceLine.charCodeAt(0);
        instrHtml = `<span class="syn-strdata">'${c >= 32 && c <= 126 ? esc(sourceLine) : hex4(val)}'</span>`;
        isStrData = true;
      } else if (!sourceLine) {
        // No source — raw value
        const sv = toSigned(val);
        instrHtml = `<span class="syn-raw">${hex4(val)} ${String(val).padStart(5)} ${String(sv).padStart(6)} ${charRepr(sv, val)}</span>`;
      } else {
        const [lbl, remainder] = splitLabel(sourceLine);
        const instr = remainder || sourceLine;
        const lower = instr.toLowerCase();

        if (lower.includes('.stringz') && lbl) {
          instrHtml = `<span class="syn-strdata">'\\0'</span>`;
          isStrData = true;
        } else if (lower.includes('.fill') || lower.includes('.blkw') || !remainder) {
          const sv = toSigned(val);
          instrHtml = `<span class="syn-raw">${hex4(val)} ${String(val).padStart(5)} ${String(sv).padStart(6)} ${charRepr(sv, val)}</span>`;
        } else {
          instrHtml = highlightInstr(remainder);
        }
      }

      // Compose line
      let cls = 'mem-line';
      if (marker === '>') cls += ' mem-pc';
      else if (bp === 'B') cls += ' mem-bp';
      else if (marker === 'T') cls += ' mem-trap';

      html += `<div class="${cls}" data-addr="${addr}">${esc(marker)}${esc(bp)}${hex4(addr)}: <span class="mem-label">${esc(label)}</span> ${instrHtml}</div>`;
    }

    this.memEl.innerHTML = html;
  }

  _bindMemoryClick() {
    // Double-click → toggle breakpoint
    this.memEl.addEventListener('dblclick', (e) => {
      const line = e.target.closest('.mem-line');
      if (!line) return;
      const addr = parseInt(line.dataset.addr, 10);
      if (isNaN(addr)) return;
      if (this.breakpoints.has(addr)) this.breakpoints.delete(addr);
      else this.breakpoints.add(addr);
      this.render();
    });
    // Single-click → notify editor to scroll to source
    this.memEl.addEventListener('click', (e) => {
      const line = e.target.closest('.mem-line');
      if (!line) return;
      const addr = parseInt(line.dataset.addr, 10);
      if (isNaN(addr)) return;
      if (this.onMemoryClick) this.onMemoryClick(addr);
    });
  }

  jumpToAddr(addr) {
    this.memLocked = true;
    this.memBaseAddr = addr - 3;
    this.render();
  }

  // Callback set by main.js
  onMemoryClick = null;

  _renderHotkeys() {
    let html = '';

    if (this.mode === MODES.RUNNING) {
      html = `<div class="hotkey-mode">RUNNING (full speed)</div>
<div>Input forwarded to LC3 keyboard. Press <span class="hotkey-key">Esc</span> to pause.</div>`;
    } else if (this.mode === MODES.SLOW_RUN) {
      const race = this.raceSubroutines;
      html = `<div class="hotkey-mode">SLOW RUN</div>
<div>Press <span class="hotkey-key">Esc</span> to pause.
Race subs: <span class="${race ? 'toggle-on' : 'toggle-off'}">${race ? 'ON' : 'OFF'}</span></div>`;
    } else if (this.mode === MODES.BREAK) {
      const lock = this.memLocked ? 'unlock' : 'lock';
      const race = this.raceSubroutines;
      const disp = this.displayVisible;
      html = `<div class="hotkey-mode">BREAK</div>
<div><span class="hotkey-key">s</span><span class="hotkey-desc">:slow-run</span> <span class="hotkey-key">r</span><span class="hotkey-desc">:run</span> <span class="hotkey-key">i</span><span class="hotkey-desc">:step-in</span> <span class="hotkey-key">o</span><span class="hotkey-desc">:step-over</span> <span class="hotkey-key">b</span><span class="hotkey-desc">:bp</span> <span class="hotkey-key">e</span><span class="hotkey-desc">:restart</span> <span class="hotkey-key">E</span><span class="hotkey-desc">:reinit</span> <span class="hotkey-key">z</span><span class="hotkey-desc">:jump</span></div>
<div><span class="hotkey-key">j</span>/<span class="hotkey-key">k</span><span class="hotkey-desc">:scroll</span> <span class="hotkey-key">n</span><span class="hotkey-desc">:${lock}-mem</span> <span class="hotkey-key">c</span><span class="hotkey-desc">:clear-console</span> <span class="hotkey-key">d</span><span class="hotkey-desc">:display[<span class="${disp ? 'toggle-on' : 'toggle-off'}">${disp ? 'ON' : 'OFF'}</span>]</span> <span class="hotkey-key">t</span><span class="hotkey-desc">:race[<span class="${race ? 'toggle-on' : 'toggle-off'}">${race ? 'ON' : 'OFF'}</span>]</span></div>`;
    }

    if (this.machine.halted) {
      html += '<div style="color:var(--red);margin-top:4px;font-weight:bold">HALTED</div>';
    }

    this.hotkeysEl.innerHTML = html;
  }

  _renderConsole() {
    const html = this.consoleLines.map(l => esc(l || ' ')).join('\n');
    this.consoleEl.textContent = this.consoleLines.join('\n');
    this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
  }

  _updateButtons() {
    const running = this.mode === MODES.RUNNING;
    const slow = this.mode === MODES.SLOW_RUN;
    document.getElementById('btn-run').classList.toggle('active', running);
    document.getElementById('btn-slow').classList.toggle('active', slow);
    // Follow PC button: active (cyan) when following, dim when locked
    if (this.followPcBtn) {
      this.followPcBtn.classList.toggle('follow-active', !this.memLocked);
    }
  }
}

export { UIController, MODES };
