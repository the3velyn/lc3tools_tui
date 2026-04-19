/**
 * LC-3 Web Simulator — Entry Point
 * Wires together machine, assembler, editor, UI, and file loading.
 */
import { LC3Machine } from './lc3.js';
import { Assembler } from './assembler.js';
import { loadObj } from './objloader.js';
import { UIController } from './ui.js';
import { EditorPane } from './editor.js';
import { LC3_OS_ASM } from './os.js';

const machine = new LC3Machine();
const assembler = new Assembler();
let ui;
let editor;
let lastAsmText = null;
let lastAsmFilename = null;

// Bootstrap: load the OS into memory (traps handled directly by machine)
function loadOS() {
  try {
    const result = assembler.assemble(LC3_OS_ASM);
    for (const entry of result.entries) {
      machine.memory[entry.addr] = entry.value;
      if (entry.line) machine.memLines.set(entry.addr, entry.line);
    }
  } catch (e) {
    console.warn('OS assembly failed (traps still work):', e);
  }
}

function loadAssemblerResult(result, text, filename) {
  // Load into machine memory
  for (const entry of result.entries) {
    machine.memory[entry.addr] = entry.value;
    if (entry.line) machine.memLines.set(entry.addr, entry.line);
  }

  // Set symbols
  const addrToLabel = new Map();
  for (const [label, addr] of result.symbols) {
    addrToLabel.set(addr, label);
  }
  ui.setSymbols(addrToLabel);

  // Reset PC
  machine.pc = 0x3000;
  machine.halted = false;

  lastAsmText = text;
  lastAsmFilename = filename || 'editor';
  ui.statusEl.textContent = `Loaded: ${lastAsmFilename} (${result.symbols.size} symbols)`;
  ui.render();
}

function loadAsmFile(text, filename) {
  try {
    const result = assembler.assemble(text);
    loadAssemblerResult(result, text, filename);
  } catch (e) {
    ui.statusEl.textContent = `Error: ${e.message}`;
    console.error(e);
  }
}

function loadObjFile(buffer, filename) {
  try {
    const result = loadObj(buffer);
    for (const entry of result.entries) {
      machine.memory[entry.addr] = entry.value;
      if (entry.line) machine.memLines.set(entry.addr, entry.line);
    }
    ui.setSymbols(result.symbols);
    machine.pc = 0x3000;
    machine.halted = false;
    ui.statusEl.textContent = `Loaded: ${filename} (${result.symbols.size} symbols)`;
    ui.render();
  } catch (e) {
    ui.statusEl.textContent = `Error: ${e.message}`;
    console.error(e);
  }
}

// File upload handler
document.getElementById('file-input').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'asm') {
      const text = await file.text();
      editor.setText(text);
      loadAsmFile(text, file.name);
      // Switch to editor tab
      switchTab('right', 'editor');
    } else if (ext === 'obj') {
      const buffer = await file.arrayBuffer();
      loadObjFile(buffer, file.name);
    }
  }
  e.target.value = '';
});

// ── Tab switching ───────────────────────────────────────
function switchTab(group, name) {
  // Update tab buttons within the group
  document.querySelectorAll(`.tab-btn[data-tabgroup="${group}"]`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });

  // Show/hide tab content within the parent pane
  const pane = group === 'right' ? document.getElementById('pane-right') : document.getElementById('pane-left-top');
  pane.querySelectorAll('.tab-content').forEach(el => {
    const isActive = el.id === `pane-${name}`;
    el.style.display = isActive ? 'flex' : 'none';
    el.classList.toggle('active', isActive);
  });

  // Right pane: show/hide action button groups
  if (group === 'right') {
    document.getElementById('editor-actions').style.display = name === 'editor' ? 'flex' : 'none';
    document.getElementById('console-actions').style.display = name === 'console' ? 'flex' : 'none';
    if (name === 'editor' && editor) {
      requestAnimationFrame(() => editor.refresh());
    }
  }
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tabgroup, btn.dataset.tab));
});

// ── Initialize ──────────────────────────────────────────
loadOS();
ui = new UIController(machine);

// Editor
editor = new EditorPane(
  document.getElementById('pane-editor'),
  assembler,
  (result, text) => loadAssemblerResult(result, text, 'editor')
);

// Assemble button
document.getElementById('btn-assemble').addEventListener('click', () => editor.assemble());

// Editor gutter click → jump memory window
editor.onGutterClick = (addr) => {
  ui.memLocked = true;
  ui.memBaseAddr = addr - 3;
  ui.render();
};

// Memory line single-click → scroll editor to source
ui.onMemoryClick = (addr) => {
  editor.scrollToAddr(addr);
  switchTab('right', 'editor');
};

// Reset callback
ui.onReset = () => {
  loadOS();
  if (lastAsmText) {
    loadAsmFile(lastAsmText, lastAsmFilename);
  }
};

// Buttons
document.getElementById('btn-reset').addEventListener('click', () => ui.reset());
document.getElementById('btn-load-editor').addEventListener('click', () => editor.assemble());
document.getElementById('btn-clear-output').addEventListener('click', () => ui.clearConsole());

ui.render();
