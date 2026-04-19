/**
 * LC-3 Integrated Assembly Editor
 * Live address preview, static checking, memory window integration.
 */

const LC3_MNEMONICS = new Set([
  'ADD','AND','NOT','BR','BRN','BRZ','BRP','BRNZ','BRZP','BRNP','BRNZP',
  'JMP','JSR','JSRR','LD','LDI','LDR','LEA','RET','RTI','NOP',
  'ST','STI','STR','TRAP','GETC','OUT','PUTC','PUTS','IN','PUTSP','HALT'
]);

const DIRECTIVES = new Set(['.ORIG','.END','.FILL','.BLKW','.STRINGZ']);

const TRAP_ALIASES = new Set(['GETC','OUT','PUTC','PUTS','IN','PUTSP','HALT']);

const REGISTERS = new Set(['R0','R1','R2','R3','R4','R5','R6','R7']);

// ── Lightweight analysis ────────────────────────────────────────────────────

function parseNumber(tok) {
  if (!tok) return NaN;
  if (tok.startsWith('#')) return parseInt(tok.slice(1), 10);
  if (tok.startsWith('0x') || tok.startsWith('0X')) return parseInt(tok.slice(2), 16);
  if (tok.startsWith('x') || tok.startsWith('X')) return parseInt(tok.slice(1), 16);
  if (tok.startsWith('b') || tok.startsWith('B')) return parseInt(tok.slice(1), 2);
  return parseInt(tok, 10);
}

function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && (i === 0 || line[i-1] !== '\\')) inString = !inString;
    else if (line[i] === ';' && !inString) return line.substring(0, i);
  }
  return line;
}

function tokenizeLine(line) {
  const stripped = stripComment(line).trim();
  if (!stripped) return [];
  const tokens = [];
  let i = 0;
  while (i < stripped.length) {
    if (stripped[i] === ' ' || stripped[i] === '\t' || stripped[i] === ',') { i++; continue; }
    if (stripped[i] === '"') {
      let s = '';
      i++;
      while (i < stripped.length && stripped[i] !== '"') {
        if (stripped[i] === '\\' && i+1 < stripped.length) { s += stripped[i] + stripped[i+1]; i += 2; }
        else { s += stripped[i]; i++; }
      }
      if (i < stripped.length) i++;
      tokens.push('"' + s + '"');
      continue;
    }
    let start = i;
    while (i < stripped.length && stripped[i] !== ' ' && stripped[i] !== '\t' && stripped[i] !== ',' && stripped[i] !== '"') i++;
    tokens.push(stripped.substring(start, i));
  }
  return tokens;
}

function stringLiteralLength(tok) {
  // Count actual characters in a quoted string token (handle escapes)
  if (!tok.startsWith('"')) return 0;
  const inner = tok.slice(1, tok.endsWith('"') ? -1 : undefined);
  let len = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && i+1 < inner.length) { len++; i++; }
    else len++;
  }
  return len;
}

/**
 * Run lightweight address-tracking pass over source lines.
 * Returns { addrMap: Map<lineNum, addr>, labels: Map<lowerName, {addr, lineNum}>, errors: [] }
 */
function analyze(sourceLines) {
  let pc = -1;
  let inOrig = false;
  const addrMap = new Map(); // lineNum (0-based) → address
  const labels = new Map();  // lowercase label → { addr, lineNum }
  const errors = [];

  for (let lineNum = 0; lineNum < sourceLines.length; lineNum++) {
    const tokens = tokenizeLine(sourceLines[lineNum]);
    if (tokens.length === 0) continue;

    let idx = 0;
    let label = null;
    let op = null;
    let operands = [];

    // Classify first token
    const first = tokens[0];
    const firstUpper = first.toUpperCase();

    if (DIRECTIVES.has(firstUpper) || LC3_MNEMONICS.has(firstUpper)) {
      op = firstUpper;
      idx = 1;
    } else {
      // It's a label
      label = first;
      if (tokens.length > 1) {
        op = tokens[1].toUpperCase();
        idx = 2;
      }
    }

    operands = tokens.slice(idx);

    // Handle directives
    if (op === '.ORIG') {
      const val = operands.length > 0 ? parseNumber(operands[0]) : NaN;
      if (isNaN(val)) {
        errors.push({ line: lineNum, msg: '.ORIG requires a valid address' });
      } else {
        pc = val;
        inOrig = true;
      }
      addrMap.set(lineNum, pc >= 0 ? pc : undefined);
      // Register label if present
      if (label && inOrig && pc >= 0) {
        const lbl = label.toLowerCase();
        if (labels.has(lbl)) errors.push({ line: lineNum, msg: `Duplicate label '${label}'` });
        else labels.set(lbl, { addr: pc, lineNum });
      }
      continue;
    }

    if (op === '.END') {
      inOrig = false;
      addrMap.set(lineNum, undefined);
      continue;
    }

    if (!inOrig) {
      if (op || label) errors.push({ line: lineNum, msg: 'Code outside .ORIG/.END block' });
      continue;
    }

    // Register label
    if (label) {
      const lbl = label.toLowerCase();
      if (labels.has(lbl)) errors.push({ line: lineNum, msg: `Duplicate label '${label}'` });
      else labels.set(lbl, { addr: pc, lineNum });
    }

    // Label-only line (no op)
    if (!op) {
      addrMap.set(lineNum, pc);
      continue;
    }

    // Set address for this line
    addrMap.set(lineNum, pc);

    // Advance PC
    if (op === '.FILL') {
      pc += 1;
    } else if (op === '.BLKW') {
      const n = operands.length > 0 ? parseNumber(operands[0]) : NaN;
      if (isNaN(n) || n <= 0) errors.push({ line: lineNum, msg: '.BLKW requires a positive integer' });
      else pc += n;
    } else if (op === '.STRINGZ') {
      if (operands.length === 0 || !operands[0].startsWith('"')) {
        errors.push({ line: lineNum, msg: '.STRINGZ requires a string literal' });
      } else {
        pc += stringLiteralLength(operands[0]) + 1; // +1 for null
      }
    } else if (DIRECTIVES.has(op)) {
      // Other directives
    } else {
      // Regular instruction or trap alias
      pc += 1;
    }
  }

  // Check for unclosed .ORIG
  if (inOrig) {
    errors.push({ line: sourceLines.length - 1, msg: 'Missing .END' });
  }

  return { addrMap, labels, errors };
}

/**
 * Run static checks after analysis pass.
 */
function staticCheck(sourceLines, analysisResult) {
  const { labels, errors } = analysisResult;
  const newErrors = [...errors];

  for (let lineNum = 0; lineNum < sourceLines.length; lineNum++) {
    const tokens = tokenizeLine(sourceLines[lineNum]);
    if (tokens.length === 0) continue;

    let idx = 0;
    const firstUpper = tokens[0].toUpperCase();

    // Skip label
    if (!DIRECTIVES.has(firstUpper) && !LC3_MNEMONICS.has(firstUpper)) {
      idx = 1;
    }

    // Check each operand token
    for (let i = idx; i < tokens.length; i++) {
      const tok = tokens[i];
      const upper = tok.toUpperCase();

      // Skip known things
      if (DIRECTIVES.has(upper) || LC3_MNEMONICS.has(upper)) continue;
      if (tok.startsWith('"')) continue;
      if (tok.startsWith(';')) break;

      // Check for invalid register
      if (/^R\d+$/i.test(tok) && !REGISTERS.has(upper)) {
        newErrors.push({ line: lineNum, msg: `Invalid register '${tok}'` });
        continue;
      }

      // Skip valid registers
      if (REGISTERS.has(upper)) continue;

      // Check if it's a number
      if (/^[#xXbB0-9\-]/.test(tok)) {
        const val = parseNumber(tok);
        if (isNaN(val)) {
          newErrors.push({ line: lineNum, msg: `Invalid number '${tok}'` });
        }
        continue;
      }

      // Otherwise it should be a label reference
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tok)) {
        if (!labels.has(tok.toLowerCase())) {
          newErrors.push({ line: lineNum, msg: `Undefined label '${tok}'` });
        }
      }
    }
  }

  return newErrors;
}

// ── Syntax highlighting for overlay ──────────────────────────────────────────

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function countLeadingTabs(line) {
  let n = 0;
  while (n < line.length && line[n] === '\t') n++;
  return n;
}

function highlightLine(line) {
  if (!line) return '';

  let result = '';
  let i = 0;

  // Render leading tabs with indent guides (vertical lines at each tab stop if >= 2 tabs)
  const leadingTabs = countLeadingTabs(line);
  if (leadingTabs >= 2) {
    for (let t = 0; t < leadingTabs; t++) {
      result += `<span class="hl-indent-guide">\t</span>`;
    }
    i = leadingTabs;
  }

  while (i < line.length) {
    // Whitespace — preserve exactly
    if (line[i] === ' ' || line[i] === '\t') {
      let start = i;
      while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
      result += esc(line.substring(start, i));
      continue;
    }

    // Comment
    if (line[i] === ';') {
      result += `<span class="hl-comment">${esc(line.substring(i))}</span>`;
      break;
    }

    // String literal
    if (line[i] === '"') {
      let start = i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) i++;
        i++;
      }
      if (i < line.length) i++;
      result += `<span class="hl-string">${esc(line.substring(start, i))}</span>`;
      continue;
    }

    // Comma
    if (line[i] === ',') { result += ','; i++; continue; }

    // Word token
    let start = i;
    while (i < line.length && line[i] !== ' ' && line[i] !== '\t' && line[i] !== ',' && line[i] !== ';' && line[i] !== '"') i++;
    const tok = line.substring(start, i);
    const upper = tok.toUpperCase();

    if (DIRECTIVES.has(upper)) {
      result += `<span class="hl-directive">${esc(tok)}</span>`;
    } else if (LC3_MNEMONICS.has(upper)) {
      result += `<span class="hl-mnemonic">${esc(tok)}</span>`;
    } else if (REGISTERS.has(upper)) {
      result += `<span class="hl-register">${esc(tok)}</span>`;
    } else if (/^[#xXbB0-9\-]/.test(tok) && /^(#-?\d+|[xX][0-9a-fA-F]+|0[xX][0-9a-fA-F]+|[bB][01]+|-?\d+|\d+)$/.test(tok)) {
      result += `<span class="hl-number">${esc(tok)}</span>`;
    } else if (/^\./.test(tok)) {
      result += `<span class="hl-directive">${esc(tok)}</span>`;
    } else {
      // Label definition or label reference
      result += `<span class="hl-label">${esc(tok)}</span>`;
    }
  }

  return result;
}

// ── Editor Pane Class ───────────────────────────────────────────────────────

class EditorPane {
  constructor(containerEl, assembler, onAssemble) {
    this.container = containerEl;
    this.assembler = assembler;
    this.onAssemble = onAssemble;
    this.addrMap = new Map();
    this.lineToAddr = new Map();
    this.addrToLine = new Map();
    this.errors = [];
    this._debounceTimer = null;

    this._build();
    this._bindEvents();
  }

  _build() {
    this.container.innerHTML = `
      <div class="editor-wrap">
        <div class="editor-gutter" id="editor-gutter"></div>
        <div class="editor-code-area">
          <div class="editor-highlight" id="editor-highlight"></div>
          <textarea class="editor-textarea" id="editor-textarea" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
        </div>
      </div>
      <div class="editor-errors" id="editor-errors"></div>
    `;
    this.textarea = this.container.querySelector('#editor-textarea');
    this.highlightEl = this.container.querySelector('#editor-highlight');
    this.gutter = this.container.querySelector('#editor-gutter');
    this.errorsEl = this.container.querySelector('#editor-errors');
  }

  _bindEvents() {
    this.textarea.addEventListener('input', () => {
      // Highlight updates immediately so text doesn't appear to lag
      this._renderHighlight(this.textarea.value.split('\n'));
      // Analysis (gutter addresses, static checks) is debounced
      this._scheduleAnalysis();
    });
    this.textarea.addEventListener('scroll', () => this._syncScroll());
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        // Insert tab character
        e.preventDefault();
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        this.textarea.value = this.textarea.value.substring(0, start) + '\t' + this.textarea.value.substring(end);
        this.textarea.selectionStart = this.textarea.selectionEnd = start + 1;
        this._renderHighlight(this.textarea.value.split('\n'));
        this._scheduleAnalysis();
      } else if (e.key === 'Enter') {
        // Auto-indent: copy leading tabs from current line
        e.preventDefault();
        const val = this.textarea.value;
        const start = this.textarea.selectionStart;
        // Find the start of the current line
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        const currentLine = val.substring(lineStart, start);
        // Extract leading tabs
        const match = currentLine.match(/^(\t*)/);
        const indent = match ? match[1] : '';
        const insert = '\n' + indent;
        this.textarea.value = val.substring(0, start) + insert + val.substring(this.textarea.selectionEnd);
        this.textarea.selectionStart = this.textarea.selectionEnd = start + insert.length;
        this._renderHighlight(this.textarea.value.split('\n'));
        this._scheduleAnalysis();
      }
    });

    // Click on gutter → notify memory pane
    this.gutter.addEventListener('click', (e) => {
      const line = e.target.closest('.gutter-line');
      if (!line) return;
      const addr = parseInt(line.dataset.addr);
      if (!isNaN(addr) && this.onGutterClick) this.onGutterClick(addr);
    });
  }

  setText(text) {
    this.textarea.value = text;
    // Defer highlight to next frame so textarea has reflowed
    requestAnimationFrame(() => {
      this._renderHighlight(text.split('\n'));
      this._syncScroll();
    });
    this._runAnalysis();
  }

  // Call when editor tab becomes visible to fix layout
  refresh() {
    const lines = this.textarea.value.split('\n');
    this._renderHighlight(lines);
    this._renderGutter(lines);
    this._syncScroll();
  }

  getText() {
    return this.textarea.value;
  }

  assemble() {
    const text = this.getText();
    if (!text.trim()) return;
    try {
      const result = this.assembler.assemble(text);
      if (this.onAssemble) this.onAssemble(result, text);
      this._clearErrors();
    } catch (e) {
      this.errors = [{ line: 0, msg: e.message }];
      this._renderErrors();
    }
  }

  scrollToAddr(addr) {
    const lineNum = this.addrToLine.get(addr);
    if (lineNum === undefined) return;
    // Scroll textarea to show that line
    const lines = this.textarea.value.split('\n');
    let charPos = 0;
    for (let i = 0; i < lineNum && i < lines.length; i++) {
      charPos += lines[i].length + 1;
    }
    this.textarea.focus();
    this.textarea.selectionStart = charPos;
    this.textarea.selectionEnd = charPos + (lines[lineNum] || '').length;
    // Scroll the line into view (18px fixed line height, matching CSS)
    this.textarea.scrollTop = lineNum * 18 - this.textarea.clientHeight / 3;
    this._syncScroll();
  }

  getAddrToLineMap() { return this.addrToLine; }
  getErrors() { return this.errors; }

  // ── Internal ──────────────────────────────────────────

  _scheduleAnalysis() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._runAnalysis(), 300);
  }

  _runAnalysis() {
    const lines = this.textarea.value.split('\n');
    const result = analyze(lines);
    this.addrMap = result.addrMap;
    this.errors = staticCheck(lines, result);

    // Build bidirectional maps
    this.lineToAddr = new Map();
    this.addrToLine = new Map();
    for (const [lineNum, addr] of result.addrMap) {
      if (addr !== undefined) {
        this.lineToAddr.set(lineNum, addr);
        // First line for an address wins (for labels on their own line)
        if (!this.addrToLine.has(addr)) {
          this.addrToLine.set(addr, lineNum);
        }
      }
    }

    this._renderGutter(lines);
    this._renderErrors();
  }

  _renderGutter(lines) {
    let html = '';
    for (let i = 0; i < lines.length; i++) {
      const addr = this.addrMap.get(i);
      const addrStr = addr !== undefined ? 'x' + (addr & 0xFFFF).toString(16).toUpperCase().padStart(4, '0') : '';
      const hasError = this.errors.some(e => e.line === i);
      const cls = hasError ? 'gutter-line gutter-error' : 'gutter-line';
      html += `<div class="${cls}" data-addr="${addr !== undefined ? addr : ''}" data-line="${i}">${addrStr}</div>`;
    }
    // Ensure at least as many lines as visible
    this.gutter.innerHTML = html;
    this._syncScroll();
  }

  _syncScroll() {
    this.gutter.scrollTop = this.textarea.scrollTop;
    this.highlightEl.scrollTop = this.textarea.scrollTop;
    this.highlightEl.scrollLeft = this.textarea.scrollLeft;
  }

  _renderHighlight(lines) {
    // Each line is a div with fixed height matching textarea's line-height
    this.highlightEl.innerHTML = lines.map(l =>
      `<div class="hl-line">${highlightLine(l) || '&nbsp;'}</div>`
    ).join('');
    this._syncScroll();
  }

  _renderErrors() {
    if (this.errors.length === 0) {
      this.errorsEl.innerHTML = '';
      this.errorsEl.style.display = 'none';
      return;
    }
    this.errorsEl.style.display = 'block';
    let html = '';
    for (const err of this.errors) {
      html += `<div class="error-item" data-line="${err.line}">Line ${err.line + 1}: ${err.msg}</div>`;
    }
    this.errorsEl.innerHTML = html;

    // Click error → jump to line
    this.errorsEl.querySelectorAll('.error-item').forEach(el => {
      el.addEventListener('click', () => {
        const lineNum = parseInt(el.dataset.line);
        this.scrollToAddr(this.lineToAddr.get(lineNum));
      });
    });
  }

  _clearErrors() {
    this.errors = [];
    this.errorsEl.innerHTML = '';
    this.errorsEl.style.display = 'none';
  }

  // onGutterClick callback — set by main.js
  onGutterClick = null;
}

export { EditorPane };
