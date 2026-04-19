// disassembler.js - LC-3 instruction disassembler
// Converts 16-bit LC-3 instruction values to human-readable assembly strings.

/**
 * Sign-extend a value from the given bit width to a full JS number.
 * @param {number} value - The raw unsigned field value
 * @param {number} bits - The number of bits in the field
 * @returns {number} The sign-extended value
 */
function signExtend(value, bits) {
    const mask = 1 << (bits - 1);
    return (value ^ mask) - mask;
}

/**
 * Format a 16-bit address as a hex string like "x3050".
 * @param {number} addr - The address value
 * @returns {string} Hex-formatted address
 */
function toHex(addr) {
    return 'x' + ((addr & 0xFFFF) >>> 0).toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Get a register name string.
 * @param {number} reg - Register number 0-7
 * @returns {string} Register name like "R0"
 */
function regName(reg) {
    return 'R' + (reg & 0x7);
}

/**
 * Map of known TRAP vectors to their symbolic names.
 */
const TRAP_NAMES = {
    0x20: 'GETC',
    0x21: 'OUT',
    0x22: 'PUTS',
    0x23: 'IN',
    0x24: 'PUTSP',
    0x25: 'HALT',
};

/**
 * Disassemble a single 16-bit LC-3 instruction.
 *
 * @param {number} value - The 16-bit instruction word (0x0000-0xFFFF)
 * @param {number} pc - The PC value *after* fetching this instruction
 *                      (i.e., the address of this instruction + 1).
 *                      PC-relative offsets are computed relative to this value.
 * @returns {string} Human-readable disassembly string
 */
function disassemble(value, pc) {
    value = value & 0xFFFF;
    const opcode = (value >> 12) & 0xF;

    switch (opcode) {
        // BR - Branch
        case 0x0: {
            const n = (value >> 11) & 1;
            const z = (value >> 10) & 1;
            const p = (value >> 9) & 1;
            const offset9 = signExtend(value & 0x1FF, 9);
            const target = (pc + offset9) & 0xFFFF;

            // NOP: BRnzp with offset 0 and no flags is just BR with all flags clear
            if (n === 0 && z === 0 && p === 0) {
                return 'NOP';
            }

            let flags = '';
            if (n) flags += 'n';
            if (z) flags += 'z';
            if (p) flags += 'p';

            return 'BR' + flags + ' ' + toHex(target);
        }

        // ADD
        case 0x1: {
            const dr = (value >> 9) & 0x7;
            const sr1 = (value >> 6) & 0x7;
            const immFlag = (value >> 5) & 1;

            if (immFlag) {
                const imm5 = signExtend(value & 0x1F, 5);
                return 'ADD ' + regName(dr) + ', ' + regName(sr1) + ', #' + imm5;
            } else {
                const sr2 = value & 0x7;
                return 'ADD ' + regName(dr) + ', ' + regName(sr1) + ', ' + regName(sr2);
            }
        }

        // LD
        case 0x2: {
            const dr = (value >> 9) & 0x7;
            const offset9 = signExtend(value & 0x1FF, 9);
            const target = (pc + offset9) & 0xFFFF;
            return 'LD ' + regName(dr) + ', ' + toHex(target);
        }

        // ST
        case 0x3: {
            const sr = (value >> 9) & 0x7;
            const offset9 = signExtend(value & 0x1FF, 9);
            const target = (pc + offset9) & 0xFFFF;
            return 'ST ' + regName(sr) + ', ' + toHex(target);
        }

        // JSR / JSRR
        case 0x4: {
            const flag = (value >> 11) & 1;
            if (flag) {
                const offset11 = signExtend(value & 0x7FF, 11);
                const target = (pc + offset11) & 0xFFFF;
                return 'JSR ' + toHex(target);
            } else {
                const baseR = (value >> 6) & 0x7;
                return 'JSRR ' + regName(baseR);
            }
        }

        // AND
        case 0x5: {
            const dr = (value >> 9) & 0x7;
            const sr1 = (value >> 6) & 0x7;
            const immFlag = (value >> 5) & 1;

            if (immFlag) {
                const imm5 = signExtend(value & 0x1F, 5);
                return 'AND ' + regName(dr) + ', ' + regName(sr1) + ', #' + imm5;
            } else {
                const sr2 = value & 0x7;
                return 'AND ' + regName(dr) + ', ' + regName(sr1) + ', ' + regName(sr2);
            }
        }

        // LDR
        case 0x6: {
            const dr = (value >> 9) & 0x7;
            const baseR = (value >> 6) & 0x7;
            const offset6 = signExtend(value & 0x3F, 6);
            return 'LDR ' + regName(dr) + ', ' + regName(baseR) + ', #' + offset6;
        }

        // STR
        case 0x7: {
            const sr = (value >> 9) & 0x7;
            const baseR = (value >> 6) & 0x7;
            const offset6 = signExtend(value & 0x3F, 6);
            return 'STR ' + regName(sr) + ', ' + regName(baseR) + ', #' + offset6;
        }

        // RTI
        case 0x8: {
            return 'RTI';
        }

        // NOT
        case 0x9: {
            const dr = (value >> 9) & 0x7;
            const sr = (value >> 6) & 0x7;
            return 'NOT ' + regName(dr) + ', ' + regName(sr);
        }

        // LDI
        case 0xA: {
            const dr = (value >> 9) & 0x7;
            const offset9 = signExtend(value & 0x1FF, 9);
            const target = (pc + offset9) & 0xFFFF;
            return 'LDI ' + regName(dr) + ', ' + toHex(target);
        }

        // STI
        case 0xB: {
            const sr = (value >> 9) & 0x7;
            const offset9 = signExtend(value & 0x1FF, 9);
            const target = (pc + offset9) & 0xFFFF;
            return 'STI ' + regName(sr) + ', ' + toHex(target);
        }

        // JMP / RET
        case 0xC: {
            const baseR = (value >> 6) & 0x7;
            if (baseR === 7) {
                return 'RET';
            }
            return 'JMP ' + regName(baseR);
        }

        // Reserved (0xD)
        case 0xD: {
            return '.FILL ' + toHex(value);
        }

        // LEA
        case 0xE: {
            const dr = (value >> 9) & 0x7;
            const offset9 = signExtend(value & 0x1FF, 9);
            const target = (pc + offset9) & 0xFFFF;
            return 'LEA ' + regName(dr) + ', ' + toHex(target);
        }

        // TRAP
        case 0xF: {
            const trapvect8 = value & 0xFF;
            const name = TRAP_NAMES[trapvect8];
            if (name) {
                return name;
            }
            return 'TRAP x' + trapvect8.toString(16).toUpperCase().padStart(2, '0');
        }

        default:
            return '.FILL ' + toHex(value);
    }
}

export { disassemble };
