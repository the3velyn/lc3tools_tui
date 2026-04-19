// LC-3 Two-Pass Assembler — ES Module
// Usage: new Assembler().assemble(sourceText)

const MNEMONICS = new Set([
  'add', 'and', 'not', 'br', 'brn', 'brz', 'brp',
  'brnz', 'brzp', 'brnp', 'brnzp',
  'jmp', 'jsr', 'jsrr',
  'ld', 'ldi', 'ldr', 'lea',
  'ret', 'rti',
  'st', 'sti', 'str',
  'trap', 'nop',
]);

const TRAP_ALIASES = {
  getc:  0x20,
  out:   0x21,
  putc:  0x21,
  puts:  0x22,
  in:    0x23,
  putsp: 0x24,
  halt:  0x25,
};

const DIRECTIVES = new Set(['.orig', '.end', '.fill', '.blkw', '.stringz']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMnemonicOrDirective(token) {
  const t = token.toLowerCase();
  return MNEMONICS.has(t) || DIRECTIVES.has(t) || t in TRAP_ALIASES;
}

function parseNumber(tok) {
  if (tok === undefined || tok === null) return NaN;
  let s = tok;

  // #decimal
  if (s.startsWith('#')) {
    return parseInt(s.slice(1), 10);
  }
  // 0xHEX
  if (/^0x/i.test(s)) {
    return parseInt(s.slice(2), 16);
  }
  // xHEX (but not a register like x3000)
  if (/^x[0-9a-fA-F]+$/i.test(s) && s.length > 1) {
    return parseInt(s.slice(1), 16);
  }
  // bBINARY
  if (/^b[01]+$/i.test(s) && s.length > 1) {
    return parseInt(s.slice(1), 2);
  }
  // plain decimal
  if (/^-?\d+$/.test(s)) {
    return parseInt(s, 10);
  }

  return NaN;
}

function parseRegister(tok) {
  if (!tok) return -1;
  const m = tok.match(/^[rR]([0-7])$/);
  return m ? parseInt(m[1], 10) : -1;
}

function toU16(val) {
  return val & 0xFFFF;
}

function signExtendCheck(value, bits) {
  const min = -(1 << (bits - 1));
  const max = (1 << (bits - 1)) - 1;
  if (value < min || value > max) {
    return false;
  }
  return true;
}

function maskBits(value, bits) {
  return value & ((1 << bits) - 1);
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenizeLine(line) {
  const tokens = [];
  let i = 0;
  const len = line.length;

  // Strip comments (respecting string literals)
  let effectiveLen = len;
  {
    let inString = false;
    for (let j = 0; j < len; j++) {
      if (line[j] === '"' && (j === 0 || line[j - 1] !== '\\')) {
        inString = !inString;
      } else if (line[j] === ';' && !inString) {
        effectiveLen = j;
        break;
      }
    }
  }

  while (i < effectiveLen) {
    // Skip whitespace and commas
    if (line[i] === ' ' || line[i] === '\t' || line[i] === ',') {
      i++;
      continue;
    }

    // String literal
    if (line[i] === '"') {
      let str = '';
      i++; // skip opening quote
      while (i < effectiveLen && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < effectiveLen) {
          const next = line[i + 1];
          if (next === '\\') { str += '\\'; i += 2; continue; }
          if (next === '"')  { str += '"';  i += 2; continue; }
          if (next === 'n')  { str += '\n'; i += 2; continue; }
          if (next === 'r')  { str += '\r'; i += 2; continue; }
          if (next === 't')  { str += '\t'; i += 2; continue; }
          if (next === '0')  { str += '\0'; i += 2; continue; }
          // Unknown escape — keep literal
          str += line[i];
          i++;
        } else {
          str += line[i];
          i++;
        }
      }
      if (i < effectiveLen) i++; // skip closing quote
      tokens.push({ type: 'string', value: str });
      continue;
    }

    // Normal token (word, number, register, label, directive)
    let start = i;
    while (i < effectiveLen && line[i] !== ' ' && line[i] !== '\t' &&
           line[i] !== ',' && line[i] !== '"') {
      i++;
    }
    tokens.push({ type: 'token', value: line.substring(start, i) });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Statement parser — extract label, operator, operands from tokens
// ---------------------------------------------------------------------------

function parseStatement(tokens) {
  if (tokens.length === 0) return null;

  let idx = 0;
  let label = null;
  let op = null;
  let operands = [];

  const first = tokens[0].value;
  // Check if first token is a label (not a mnemonic/directive/trap alias)
  if (tokens[0].type === 'token' && !isMnemonicOrDirective(first)) {
    label = first;
    idx = 1;
  }

  if (idx < tokens.length) {
    if (tokens[idx].type === 'token') {
      op = tokens[idx].value;
      idx++;
    }
  }

  // Remaining tokens are operands
  while (idx < tokens.length) {
    operands.push(tokens[idx]);
    idx++;
  }

  return { label, op, operands };
}

// ---------------------------------------------------------------------------
// Assembler class
// ---------------------------------------------------------------------------

class Assembler {

  assemble(sourceText) {
    const lines = sourceText.split(/\r?\n/);
    const statements = [];

    // Tokenize all lines
    for (let i = 0; i < lines.length; i++) {
      const tokens = tokenizeLine(lines[i]);
      const stmt = parseStatement(tokens);
      statements.push({
        lineNum: i + 1,
        lineText: lines[i],
        stmt,
      });
    }

    // -----------------------------------------------------------------------
    // Pass 1: Build symbol table
    // -----------------------------------------------------------------------
    const symbols = new Map();
    let pc = 0;
    let origSeen = false;

    for (const { lineNum, stmt } of statements) {
      if (!stmt) continue;
      const { label, op, operands } = stmt;

      if (op) {
        const opLower = op.toLowerCase();

        if (opLower === '.orig') {
          const val = this._resolveOperandValue(operands, 0, lineNum);
          pc = val;
          origSeen = true;
          // Record label if present (before .orig)
          if (label) {
            if (symbols.has(label.toLowerCase())) {
              throw new Error(`Line ${lineNum}: duplicate label '${label}'`);
            }
            symbols.set(label.toLowerCase(), pc);
          }
          continue;
        }

        if (opLower === '.end') {
          if (label) {
            if (symbols.has(label.toLowerCase())) {
              throw new Error(`Line ${lineNum}: duplicate label '${label}'`);
            }
            symbols.set(label.toLowerCase(), pc);
          }
          origSeen = false;
          continue;
        }

        if (!origSeen) {
          // Only directives .ORIG/.END allowed outside a segment
          continue;
        }

        // Record label at current PC
        if (label) {
          if (symbols.has(label.toLowerCase())) {
            throw new Error(`Line ${lineNum}: duplicate label '${label}'`);
          }
          symbols.set(label.toLowerCase(), pc);
        }

        if (opLower === '.fill') {
          pc += 1;
        } else if (opLower === '.blkw') {
          const n = this._resolveOperandValue(operands, 0, lineNum);
          if (n <= 0) throw new Error(`Line ${lineNum}: .BLKW requires size > 0`);
          pc += n;
        } else if (opLower === '.stringz') {
          if (operands.length === 0 || operands[0].type !== 'string') {
            throw new Error(`Line ${lineNum}: .STRINGZ requires a string literal`);
          }
          pc += operands[0].value.length + 1; // chars + null terminator
        } else if (opLower in TRAP_ALIASES || MNEMONICS.has(opLower)) {
          pc += 1;
        } else {
          throw new Error(`Line ${lineNum}: unknown instruction '${op}'`);
        }
      } else if (label) {
        // Label-only line
        if (origSeen) {
          if (symbols.has(label.toLowerCase())) {
            throw new Error(`Line ${lineNum}: duplicate label '${label}'`);
          }
          symbols.set(label.toLowerCase(), pc);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Pass 2: Generate machine code
    // -----------------------------------------------------------------------
    const entries = [];
    pc = 0;
    origSeen = false;

    for (const { lineNum, lineText, stmt } of statements) {
      if (!stmt) continue;
      const { op, operands } = stmt;
      if (!op) continue;

      const opLower = op.toLowerCase();

      if (opLower === '.orig') {
        pc = this._resolveOperandValue(operands, 0, lineNum);
        origSeen = true;
        continue;
      }

      if (opLower === '.end') {
        origSeen = false;
        continue;
      }

      if (!origSeen) continue;

      // Directives
      if (opLower === '.fill') {
        const val = this._resolveValueOrLabel(operands, 0, symbols, pc, lineNum, null);
        entries.push({ addr: pc, value: toU16(val), line: lineText });
        pc += 1;
        continue;
      }

      if (opLower === '.blkw') {
        const n = this._resolveOperandValue(operands, 0, lineNum);
        if (n <= 0) throw new Error(`Line ${lineNum}: .BLKW requires size > 0`);
        for (let j = 0; j < n; j++) {
          entries.push({ addr: pc + j, value: 0, line: lineText });
        }
        pc += n;
        continue;
      }

      if (opLower === '.stringz') {
        const str = operands[0].value;
        for (let j = 0; j < str.length; j++) {
          // Each char gets a single-character line (matching C++ assembler behavior)
          entries.push({ addr: pc + j, value: str.charCodeAt(j) & 0xFFFF, line: String.fromCharCode(str.charCodeAt(j)) });
        }
        // Null terminator gets the full source line (for label extraction)
        entries.push({ addr: pc + str.length, value: 0, line: lineText });
        pc += str.length + 1;
        continue;
      }

      // Trap aliases
      if (opLower in TRAP_ALIASES) {
        const word = (0xF << 12) | TRAP_ALIASES[opLower];
        entries.push({ addr: pc, value: toU16(word), line: lineText });
        pc += 1;
        continue;
      }

      // Instructions
      let word = 0;

      switch (opLower) {
        case 'add':
        case 'and': {
          const opcode = opLower === 'add' ? 0x1 : 0x5;
          const dr = this._reg(operands, 0, lineNum);
          const sr1 = this._reg(operands, 1, lineNum);
          if (operands.length < 3) {
            throw new Error(`Line ${lineNum}: ${op} requires 3 operands`);
          }
          const third = operands[2];
          const r2 = parseRegister(third.value);
          if (r2 >= 0) {
            word = (opcode << 12) | (dr << 9) | (sr1 << 6) | r2;
          } else {
            const imm = this._parseImm(third.value, 5, lineNum);
            word = (opcode << 12) | (dr << 9) | (sr1 << 6) | (1 << 5) | maskBits(imm, 5);
          }
          break;
        }

        case 'not': {
          const dr = this._reg(operands, 0, lineNum);
          const sr = this._reg(operands, 1, lineNum);
          word = (0x9 << 12) | (dr << 9) | (sr << 6) | 0x3F;
          break;
        }

        case 'br': case 'brn': case 'brz': case 'brp':
        case 'brnz': case 'brzp': case 'brnp': case 'brnzp': {
          let nzp = 0;
          const flags = opLower.slice(2); // after 'br'
          if (flags === '' || flags === 'nzp') {
            nzp = 0x7;
          } else {
            if (flags.includes('n')) nzp |= 0x4;
            if (flags.includes('z')) nzp |= 0x2;
            if (flags.includes('p')) nzp |= 0x1;
          }
          const offset = this._pcOffset(operands, 0, symbols, pc, 9, lineNum);
          word = (0x0 << 12) | (nzp << 9) | maskBits(offset, 9);
          break;
        }

        case 'nop': {
          word = 0;
          break;
        }

        case 'jmp': {
          const baseR = this._reg(operands, 0, lineNum);
          word = (0xC << 12) | (baseR << 6);
          break;
        }

        case 'ret': {
          word = (0xC << 12) | (7 << 6);
          break;
        }

        case 'jsr': {
          const offset = this._pcOffset(operands, 0, symbols, pc, 11, lineNum);
          word = (0x4 << 12) | (1 << 11) | maskBits(offset, 11);
          break;
        }

        case 'jsrr': {
          const baseR = this._reg(operands, 0, lineNum);
          word = (0x4 << 12) | (baseR << 6);
          break;
        }

        case 'ld': {
          const dr = this._reg(operands, 0, lineNum);
          const offset = this._pcOffset(operands, 1, symbols, pc, 9, lineNum);
          word = (0x2 << 12) | (dr << 9) | maskBits(offset, 9);
          break;
        }

        case 'ldi': {
          const dr = this._reg(operands, 0, lineNum);
          const offset = this._pcOffset(operands, 1, symbols, pc, 9, lineNum);
          word = (0xA << 12) | (dr << 9) | maskBits(offset, 9);
          break;
        }

        case 'ldr': {
          const dr = this._reg(operands, 0, lineNum);
          const baseR = this._reg(operands, 1, lineNum);
          const off = this._parseImmOrLabel(operands, 2, symbols, pc, 6, lineNum);
          word = (0x6 << 12) | (dr << 9) | (baseR << 6) | maskBits(off, 6);
          break;
        }

        case 'lea': {
          const dr = this._reg(operands, 0, lineNum);
          const offset = this._pcOffset(operands, 1, symbols, pc, 9, lineNum);
          word = (0xE << 12) | (dr << 9) | maskBits(offset, 9);
          break;
        }

        case 'st': {
          const sr = this._reg(operands, 0, lineNum);
          const offset = this._pcOffset(operands, 1, symbols, pc, 9, lineNum);
          word = (0x3 << 12) | (sr << 9) | maskBits(offset, 9);
          break;
        }

        case 'sti': {
          const sr = this._reg(operands, 0, lineNum);
          const offset = this._pcOffset(operands, 1, symbols, pc, 9, lineNum);
          word = (0xB << 12) | (sr << 9) | maskBits(offset, 9);
          break;
        }

        case 'str': {
          const sr = this._reg(operands, 0, lineNum);
          const baseR = this._reg(operands, 1, lineNum);
          const off = this._parseImmOrLabel(operands, 2, symbols, pc, 6, lineNum);
          word = (0x7 << 12) | (sr << 9) | (baseR << 6) | maskBits(off, 6);
          break;
        }

        case 'trap': {
          const vec = this._resolveOperandValue(operands, 0, lineNum);
          if (vec < 0 || vec > 0xFF) {
            throw new Error(`Line ${lineNum}: trap vector out of range (0-255)`);
          }
          word = (0xF << 12) | vec;
          break;
        }

        case 'rti': {
          word = (0x8 << 12);
          break;
        }

        default:
          throw new Error(`Line ${lineNum}: unknown instruction '${op}'`);
      }

      entries.push({ addr: pc, value: toU16(word), line: lineText });
      pc += 1;
    }

    return { entries, symbols };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  _reg(operands, idx, lineNum) {
    if (idx >= operands.length) {
      throw new Error(`Line ${lineNum}: expected register operand at position ${idx + 1}`);
    }
    const r = parseRegister(operands[idx].value);
    if (r < 0) {
      throw new Error(`Line ${lineNum}: invalid register '${operands[idx].value}'`);
    }
    return r;
  }

  _resolveOperandValue(operands, idx, lineNum) {
    if (idx >= operands.length) {
      throw new Error(`Line ${lineNum}: missing operand`);
    }
    const val = parseNumber(operands[idx].value);
    if (isNaN(val)) {
      throw new Error(`Line ${lineNum}: invalid number '${operands[idx].value}'`);
    }
    return val;
  }

  /** Resolve a value that could be a number or a label (for .FILL). */
  _resolveValueOrLabel(operands, idx, symbols, pc, lineNum, _bits) {
    if (idx >= operands.length) {
      throw new Error(`Line ${lineNum}: missing operand`);
    }
    const tok = operands[idx].value;
    const num = parseNumber(tok);
    if (!isNaN(num)) return num;
    // Try as label
    const addr = symbols.get(tok.toLowerCase());
    if (addr === undefined) {
      throw new Error(`Line ${lineNum}: undefined symbol '${tok}'`);
    }
    return addr;
  }

  /** Parse a PC-relative offset: operand can be label or immediate. */
  _pcOffset(operands, idx, symbols, pc, bits, lineNum) {
    if (idx >= operands.length) {
      throw new Error(`Line ${lineNum}: missing operand for PC offset`);
    }
    const tok = operands[idx].value;

    // Try as number first
    const num = parseNumber(tok);
    if (!isNaN(num)) {
      if (!signExtendCheck(num, bits)) {
        throw new Error(`Line ${lineNum}: offset ${num} out of range for ${bits}-bit signed field`);
      }
      return num;
    }

    // Try as label
    const addr = symbols.get(tok.toLowerCase());
    if (addr === undefined) {
      throw new Error(`Line ${lineNum}: undefined symbol '${tok}'`);
    }
    const offset = addr - (pc + 1);
    if (!signExtendCheck(offset, bits)) {
      throw new Error(`Line ${lineNum}: label '${tok}' is too far away (offset ${offset}, ${bits}-bit range)`);
    }
    return offset;
  }

  /** Parse immediate value (for LDR/STR offset6). */
  _parseImm(tok, bits, lineNum) {
    const val = parseNumber(tok);
    if (isNaN(val)) {
      throw new Error(`Line ${lineNum}: invalid immediate '${tok}'`);
    }
    if (!signExtendCheck(val, bits)) {
      throw new Error(`Line ${lineNum}: immediate ${val} out of range for ${bits}-bit signed field`);
    }
    return val;
  }

  /** Parse immediate or label for offset fields like offset6. */
  _parseImmOrLabel(operands, idx, symbols, pc, bits, lineNum) {
    if (idx >= operands.length) {
      throw new Error(`Line ${lineNum}: missing operand`);
    }
    const tok = operands[idx].value;
    const num = parseNumber(tok);
    if (!isNaN(num)) {
      if (!signExtendCheck(num, bits)) {
        throw new Error(`Line ${lineNum}: immediate ${num} out of range for ${bits}-bit signed field`);
      }
      return num;
    }
    // Label not expected here for offset6, but handle gracefully
    throw new Error(`Line ${lineNum}: invalid immediate '${tok}'`);
  }
}

export { Assembler };
