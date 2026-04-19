/**
 * LC-3 Simulator — a complete 16-bit educational computer simulator.
 *
 * Implements the full LC-3 ISA including memory-mapped I/O for keyboard
 * and display devices.  Designed for use in web-based tooling.
 *
 * ES module — import with:
 *   import { LC3Machine } from './lc3.js';
 */

// ---------------------------------------------------------------------------
// Memory-mapped I/O addresses
// ---------------------------------------------------------------------------
const KBSR = 0xFE00; // Keyboard status register
const KBDR = 0xFE02; // Keyboard data register
const DSR  = 0xFE04; // Display status register
const DDR  = 0xFE06; // Display data register
const MCR  = 0xFFFE; // Machine control register

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sign-extend a value of `bits` width to a full 16-bit signed range,
 * returned as a uint16.
 *
 * Example: sext(0b11111, 5) => 0xFFFF  (-1 as uint16)
 */
function sext(val, bits) {
  // If the sign bit (top bit of the field) is set, fill upper bits with 1s.
  if ((val >> (bits - 1)) & 1) {
    val |= (0xFFFF << bits);
  }
  return val & 0xFFFF;
}

/**
 * Mask a value to 16 bits.
 */
function u16(val) {
  return val & 0xFFFF;
}

// ---------------------------------------------------------------------------
// LC3Machine
// ---------------------------------------------------------------------------

class LC3Machine {
  constructor() {
    // Core state — allocated once, cleared in reset()
    this.memory    = new Uint16Array(65536);
    this.registers = new Uint16Array(8);
    this.pc        = 0x3000;
    this.psr       = 0x8002; // User mode, Z flag set
    this.ir        = 0;
    this.halted    = false;

    // Source-line annotations keyed by address
    this.memLines = new Map();

    // I/O buffers
    this.kbBuffer     = []; // Pending keyboard input (char codes)
    this.outputBuffer = []; // Pending display output (char codes)

    this.reset();
  }

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  /**
   * Reset the machine to its power-on state.
   * All memory and registers are zeroed, PC is set to 0x3000,
   * PSR indicates user mode with Z condition code.
   */
  reset() {
    this.memory.fill(0);
    this.registers.fill(0);
    this.pc     = 0x3000;
    this.psr    = 0x8002; // User mode, Z flag set
    this.ir     = 0;
    this.halted = false;
    this.kbBuffer.length     = 0;
    this.outputBuffer.length = 0;
  }

  // -----------------------------------------------------------------------
  // Memory access (with MMIO)
  // -----------------------------------------------------------------------

  /**
   * Read a 16-bit value from the given address, dispatching to memory-mapped
   * device registers where appropriate.
   */
  readMem(addr) {
    addr = u16(addr);

    switch (addr) {
      case KBSR:
        // Bit 15 set when there is a character waiting in the keyboard buffer.
        return this.kbBuffer.length > 0 ? 0x8000 : 0x0000;

      case KBDR:
        // Dequeue one character; clear ready status implicitly (next KBSR
        // read will reflect new buffer length).
        if (this.kbBuffer.length > 0) {
          return u16(this.kbBuffer.shift());
        }
        return 0x0000;

      case DSR:
        // Display is always ready.
        return 0x8000;

      case DDR:
        // DDR is write-only; reading it returns 0.
        return 0x0000;

      case MCR:
        return this.memory[MCR];

      default:
        return this.memory[addr];
    }
  }

  /**
   * Write a 16-bit value to the given address, dispatching to memory-mapped
   * device registers where appropriate.
   */
  writeMem(addr, val) {
    addr = u16(addr);
    val  = u16(val);

    switch (addr) {
      case DDR:
        // Push the character to the output buffer.
        this.outputBuffer.push(val);
        break;

      case MCR:
        this.memory[MCR] = val;
        // If bit 15 (clock enable) is cleared, halt the machine.
        if ((val & 0x8000) === 0) {
          this.halted = true;
        }
        break;

      case KBSR:
      case KBDR:
      case DSR:
        // These are read-only device registers; writes are ignored.
        break;

      default:
        this.memory[addr] = val;
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Register access
  // -----------------------------------------------------------------------

  readReg(i) {
    return this.registers[i & 0x7];
  }

  writeReg(i, val) {
    this.registers[i & 0x7] = u16(val);
  }

  // -----------------------------------------------------------------------
  // Condition codes
  // -----------------------------------------------------------------------

  /**
   * Update the NZP condition-code bits (PSR[2:0]) based on a 16-bit value.
   * Bit 15 of val indicates negative (two's-complement).
   */
  setCC(val) {
    val = u16(val);
    // Clear old NZP bits
    this.psr &= ~0x0007;

    if (val === 0) {
      this.psr |= 0x0002; // Z
    } else if (val & 0x8000) {
      this.psr |= 0x0004; // N
    } else {
      this.psr |= 0x0001; // P
    }
  }

  // -----------------------------------------------------------------------
  // Program loading
  // -----------------------------------------------------------------------

  /**
   * Load an array of uint16 values into memory starting at `addr`.
   *
   * @param {number}   addr   - Starting address (uint16).
   * @param {number[]} values - Array of 16-bit words to load.
   * @param {string[]} [lines] - Optional parallel array of source-line
   *                             annotations (one per value).
   */
  loadAt(addr, values, lines) {
    for (let i = 0; i < values.length; i++) {
      const a = u16(addr + i);
      this.memory[a] = u16(values[i]);
      if (lines && lines[i] !== undefined) {
        this.memLines.set(a, lines[i]);
      }
    }
  }

  // -----------------------------------------------------------------------
  // I/O helpers
  // -----------------------------------------------------------------------

  /**
   * Enqueue a character code for the simulated keyboard.
   */
  feedInput(charCode) {
    this.kbBuffer.push(charCode & 0xFFFF);
  }

  /**
   * Return all pending output characters and clear the buffer.
   */
  drainOutput() {
    const out = this.outputBuffer.slice();
    this.outputBuffer.length = 0;
    return out;
  }

  // -----------------------------------------------------------------------
  // Bulk execution helpers (parity with backend `lc3::sim`)
  // -----------------------------------------------------------------------

  /**
   * Zero all memory and registers; equivalent to `lc3::sim::zeroState()`.
   * Alias for reset() — kept under the backend name so upstream-style code
   * can be ported directly.
   */
  reinit() { this.reset(); }

  /**
   * Run instructions until the PC points to HALT (0xF025) or GETC (0xF020),
   * matching upstream `lc3::sim::runUntilHaltOrInput`.
   *
   * @param   {number}  instLimit  Max instructions to execute; 0 = unlimited.
   * @returns {'halt'|'input'|'limit'}
   */
  runUntilHaltOrInput(instLimit = 0) {
    let executed = 0;
    while (!this.halted) {
      const instr = this.memory[this.pc];
      if (instr === 0xF025) return 'halt';
      if (instr === 0xF020) return 'input';
      this.step();
      executed++;
      if (instLimit && executed >= instLimit) return 'limit';
    }
    return 'halt';
  }

  /**
   * Execute one instruction, then run to the same call depth we started at
   * (parity with upstream `lc3::sim::stepOver`: step-in over ordinary
   * instructions, but race through JSR/JSRR/TRAP bodies until they return).
   */
  stepOver() {
    if (this.halted) return;
    const op = (this.memory[this.pc] >> 12) & 0xF;
    const opcode = op;
    const isCall = (opcode === 0x4) || (opcode === 0xF);  // JSR/JSRR/TRAP
    const returnPC = u16(this.pc + 1);
    this.step();
    if (!isCall) return;
    // Step until PC comes back to the instruction after the call, or the
    // machine halts.  Bail out after a generous budget to avoid infinite
    // loops on misbehaving code.
    const BUDGET = 1_000_000;
    let i = 0;
    while (!this.halted && this.pc !== returnPC && i < BUDGET) {
      this.step();
      i++;
    }
  }

  // -----------------------------------------------------------------------
  // Instruction execution
  // -----------------------------------------------------------------------

  /**
   * Execute a single fetch-decode-execute cycle.
   *
   * @returns {boolean} true if the machine is still running after this
   *                    step, false if it has halted.
   */
  step() {
    if (this.halted) return false;

    // -- Fetch --
    this.ir = this.memory[this.pc];
    this.pc = u16(this.pc + 1);

    const ir = this.ir;

    // -- Decode common fields --
    const opcode = (ir >> 12) & 0xF;
    const dr     = (ir >> 9) & 0x7;  // also used as SR for stores / nzp for BR
    const sr1    = (ir >> 6) & 0x7;  // also baseR
    const sr2    = ir & 0x7;
    const imm5   = sext(ir & 0x1F, 5);
    const off6   = sext(ir & 0x3F, 6);
    const off9   = sext(ir & 0x1FF, 9);
    const off11  = sext(ir & 0x7FF, 11);
    const bit5   = (ir >> 5) & 0x1;
    const bit11  = (ir >> 11) & 0x1;

    // -- Execute --
    switch (opcode) {

      // ADD (0001)
      case 0x1: {
        const a = this.registers[sr1];
        const b = bit5 ? imm5 : this.registers[sr2];
        const result = u16(a + b);
        this.writeReg(dr, result);
        this.setCC(result);
        break;
      }

      // AND (0101)
      case 0x5: {
        const a = this.registers[sr1];
        const b = bit5 ? imm5 : this.registers[sr2];
        const result = u16(a & b);
        this.writeReg(dr, result);
        this.setCC(result);
        break;
      }

      // BR (0000)
      case 0x0: {
        const nzp = dr; // bits [11:9] encode the condition test
        if (nzp & (this.psr & 0x7)) {
          this.pc = u16(this.pc + off9);
        }
        break;
      }

      // JMP / RET (1100)
      case 0xC: {
        this.pc = this.registers[sr1]; // baseR
        break;
      }

      // JSR / JSRR (0100)
      case 0x4: {
        const temp = this.pc;
        if (bit11) {
          // JSR — PC-relative
          this.pc = u16(this.pc + off11);
        } else {
          // JSRR — register
          this.pc = this.registers[sr1];
        }
        this.registers[7] = temp;
        break;
      }

      // LD (0010)
      case 0x2: {
        const val = this.readMem(u16(this.pc + off9));
        this.writeReg(dr, val);
        this.setCC(val);
        break;
      }

      // LDI (1010)
      case 0xA: {
        const ptr = this.readMem(u16(this.pc + off9));
        const val = this.readMem(ptr);
        this.writeReg(dr, val);
        this.setCC(val);
        break;
      }

      // LDR (0110)
      case 0x6: {
        const val = this.readMem(u16(this.registers[sr1] + off6));
        this.writeReg(dr, val);
        this.setCC(val);
        break;
      }

      // LEA (1110)
      case 0xE: {
        const val = u16(this.pc + off9);
        this.writeReg(dr, val);
        this.setCC(val);
        break;
      }

      // NOT (1001)
      case 0x9: {
        const val = u16(~this.registers[sr1]);
        this.writeReg(dr, val);
        this.setCC(val);
        break;
      }

      // RTI (1000)
      case 0x8: {
        // Only valid in supervisor mode (bit 15 of PSR clear).
        if ((this.psr & 0x8000) === 0) {
          // Pop PC from supervisor stack (R6)
          this.pc = this.readMem(this.registers[6]);
          this.registers[6] = u16(this.registers[6] + 1);
          // Pop PSR from supervisor stack
          this.psr = this.readMem(this.registers[6]);
          this.registers[6] = u16(this.registers[6] + 1);
        }
        // If in user mode, RTI is a privilege-mode exception (not modelled
        // here — simply ignored).
        break;
      }

      // ST (0011)
      case 0x3: {
        this.writeMem(u16(this.pc + off9), this.registers[dr]);
        break;
      }

      // STI (1011)
      case 0xB: {
        const ptr = this.readMem(u16(this.pc + off9));
        this.writeMem(ptr, this.registers[dr]);
        break;
      }

      // STR (0111)
      case 0x7: {
        this.writeMem(u16(this.registers[sr1] + off6), this.registers[dr]);
        break;
      }

      // TRAP (1111)
      case 0xF: {
        const trapVect = ir & 0xFF;

        // Save return address in R7 (real LC-3 hardware behavior)
        this.registers[7] = this.pc;

        // HALT — print message (matches C++ OS handler), then halt
        if (trapVect === 0x25) {
          const msg = '\n\n--- Halting the LC-3 ---\n\n';
          for (let i = 0; i < msg.length; i++)
            this.outputBuffer.push(msg.charCodeAt(i));
          this.pc = u16(this.pc - 1);
          this.halted = true;
          break;
        }

        // Handle standard traps directly (avoids OS/RTI complexity)
        switch (trapVect) {
          case 0x20: // GETC — read char into R0, no echo, wait for input
            if (this.kbBuffer.length > 0) {
              this.registers[0] = u16(this.kbBuffer.shift());
              this.setCC(this.registers[0]);
            } else {
              // No input available — spin (re-execute this TRAP next step)
              this.pc = u16(this.pc - 1);
            }
            break;

          case 0x21: // OUT / PUTC — write R0[7:0] to display
            this.outputBuffer.push(this.registers[0] & 0xFF);
            break;

          case 0x22: // PUTS — write null-terminated string at R0 to display
          {
            // Preserve R0 (matches C++ OS handler which saves/restores R0 and R1)
            const savedR0 = this.registers[0];
            let addr = this.registers[0];
            let ch = this.memory[addr];
            while (ch !== 0) {
              this.outputBuffer.push(ch & 0xFF);
              addr = u16(addr + 1);
              ch = this.memory[addr];
            }
            this.registers[0] = savedR0;
            break;
          }

          case 0x23: // IN — prompt, read char into R0, echo
          {
            if (this.kbBuffer.length > 0) {
              // Output prompt (matches C++ OS handler)
              const prompt = '\nInput a character> ';
              for (let i = 0; i < prompt.length; i++)
                this.outputBuffer.push(prompt.charCodeAt(i));
              const c = this.kbBuffer.shift();
              this.registers[0] = u16(c);
              this.setCC(this.registers[0]);
              this.outputBuffer.push(c & 0xFF); // echo
              this.outputBuffer.push(10); // newline
            } else {
              // No input — spin
              this.pc = u16(this.pc - 1);
            }
            break;
          }

          case 0x24: // PUTSP — write packed string (2 chars per word) at R0
          {
            let addr = this.registers[0];
            let word = this.memory[addr];
            while (word !== 0) {
              const lo = word & 0xFF;
              if (lo === 0) break;
              this.outputBuffer.push(lo);
              const hi = (word >> 8) & 0xFF;
              if (hi === 0) break;
              this.outputBuffer.push(hi);
              addr = u16(addr + 1);
              word = this.memory[addr];
            }
            break;
          }

          default:
            // Unknown trap — jump through vector table (OS handler)
            this.pc = this.readMem(trapVect);
            break;
        }
        break;
      }

      // Reserved / illegal opcode (0xD) — no operation.
      default:
        break;
    }

    return !this.halted;
  }
}

// ---------------------------------------------------------------------------
// ES module export
// ---------------------------------------------------------------------------
export { LC3Machine };
