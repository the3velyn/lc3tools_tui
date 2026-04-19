/**
 * LC-3 .obj binary file loader.
 * Parses the binary format produced by lc3tools assembler.
 *
 * Format:
 *   - Magic header: 5 bytes [0x1c, 0x30, 0x15, 0xc0, 0x01]
 *   - Version: 2 bytes [0x01, 0x01]
 *   - Entries (repeating until EOF):
 *     - uint16 value (2 bytes, little-endian)
 *     - uint8 is_orig (1 byte, 0 or 1)
 *     - uint32 num_chars (4 bytes, little-endian)
 *     - char[num_chars] source_line (UTF-8, not null-terminated)
 */

const MAGIC = [0x1c, 0x30, 0x15, 0xc0, 0x01];
const VERSION = [0x01, 0x01];

const LC3_MNEMONICS = new Set([
  'ADD','AND','NOT','BR','BRN','BRZ','BRP','BRNZ','BRZP','BRNP','BRNZP',
  'JMP','JSR','JSRR','LD','LDI','LDR','LEA','RET','RTI',
  'ST','STI','STR','TRAP','NOP','GETC','OUT','PUTC','PUTS','IN','PUTSP','HALT',
  '.ORIG','.END','.FILL','.BLKW','.STRINGZ'
]);

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

function loadObj(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 0;

  // Verify magic header
  for (let i = 0; i < MAGIC.length; i++) {
    if (offset >= bytes.length || bytes[offset] !== MAGIC[i]) {
      throw new Error('Not a valid lc3tools .obj file (bad magic header)');
    }
    offset++;
  }

  // Verify version
  for (let i = 0; i < VERSION.length; i++) {
    if (offset >= bytes.length || bytes[offset] !== VERSION[i]) {
      throw new Error('Version mismatch in .obj file — try re-assembling');
    }
    offset++;
  }

  const entries = [];
  let currentAddr = 0x3000;

  while (offset + 7 <= buffer.byteLength) {
    const value = view.getUint16(offset, true); // little-endian
    const isOrig = view.getUint8(offset + 2);
    const numChars = view.getUint32(offset + 3, true); // little-endian
    offset += 7;

    let line = '';
    if (numChars > 0) {
      if (offset + numChars > buffer.byteLength) break;
      line = new TextDecoder().decode(new Uint8Array(buffer, offset, numChars));
      offset += numChars;
    }

    if (isOrig) {
      currentAddr = value;
    } else {
      entries.push({ addr: currentAddr, value, line });
      currentAddr = (currentAddr + 1) & 0xFFFF;
    }
  }

  // Build symbol table from source lines
  const symbols = new Map();
  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    if (!entry.line || entry.line.length === 1) continue;

    const [label, instr] = splitLabel(entry.line);
    if (!label) continue;

    const lowerInstr = (instr || '').toLowerCase();

    if (!instr) {
      // Standalone label — belongs to next address
      const nextAddr = (entry.addr + 1) & 0xFFFF;
      if (!symbols.has(nextAddr)) {
        symbols.set(nextAddr, label.toLowerCase());
      }
    } else if (lowerInstr.includes('.stringz')) {
      // .STRINGZ: label belongs to start of string (scan backward)
      let startAddr = entry.addr;
      for (let i = idx - 1; i >= 0; i--) {
        if (entries[i].line && entries[i].line.length === 1 && entries[i].addr === startAddr - 1) {
          startAddr--;
        } else {
          break;
        }
      }
      if (!symbols.has(startAddr)) {
        symbols.set(startAddr, label.toLowerCase());
      }
    } else {
      if (!symbols.has(entry.addr)) {
        symbols.set(entry.addr, label.toLowerCase());
      }
    }
  }

  return { entries, symbols };
}

export { loadObj };
