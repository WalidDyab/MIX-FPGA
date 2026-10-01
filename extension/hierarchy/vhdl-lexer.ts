/**
 * Lightweight VHDL lexer for editor-time structure indexing. It understands
 * enough of the lexical grammar (comments, strings, character and bit-string
 * literals, extended identifiers, compound delimiters) that the structural
 * parser never mistakes commented-out or quoted text for code. It is not a
 * validating lexer: GHDL (Check) stays authoritative for correctness.
 */

export type TokenKind = 'identifier' | 'extended' | 'string' | 'char' | 'bitstring' | 'number' | 'delimiter';

export interface Token {
    readonly kind: TokenKind;
    /** Source text of the token. */
    readonly text: string;
    /** Lower-case text (VHDL basic identifiers and keywords are case-insensitive). */
    readonly lower: string;
    /** 1-based line and column of the first character. */
    readonly line: number;
    readonly col: number;
}

/** VHDL-2008 reserved words. */
export const RESERVED = new Set(
    (
        'abs access after alias all and architecture array assert assume assume_guarantee attribute begin block body buffer bus ' +
        'case component configuration constant context cover default disconnect downto else elsif end entity exit fairness file for ' +
        'force function generate generic group guarded if impure in inertial inout is label library linkage literal loop map mod ' +
        'nand new next nor not null of on open or others out package parameter port postponed procedure process property protected ' +
        'pure range record register reject release rem report restrict restrict_guarantee return rol ror select sequence severity ' +
        'shared signal sla sll sra srl strong subtype then to transport type unaffected units until use variable vmode vprop vunit ' +
        'wait when while with xnor xor'
    ).split(' '),
);

const COMPOUND = ['?/=', '?<=', '?>=', '=>', '<=', ':=', '/=', '>=', '**', '<>', '??', '?=', '?<', '?>', '<<', '>>'];
const BIT_STRING_BASE = /^(?:[bodx]|u[box]|s[box])$/i;

const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentChar = (c: string) => isLetter(c) || isDigit(c) || c === '_';

export function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let line = 1;
    let lineStart = 0;
    const n = text.length;

    const push = (kind: TokenKind, start: number, startLine: number, startCol: number) => {
        const t = text.slice(start, i);
        tokens.push({ kind, text: t, lower: kind === 'extended' ? t : t.toLowerCase(), line: startLine, col: startCol });
    };
    /** Advances over a newline at i, if any; returns true if one was consumed. */
    const newline = (): boolean => {
        if (text[i] === '\r') {
            i += text[i + 1] === '\n' ? 2 : 1;
        } else if (text[i] === '\n') {
            i++;
        } else {
            return false;
        }
        line++;
        lineStart = i;
        return true;
    };
    /** Previous token makes a following `'` an attribute/qualification tick rather than a character literal. */
    const tickContext = (): boolean => {
        const prev = tokens[tokens.length - 1];
        if (!prev) return false;
        if (prev.kind === 'identifier') return !RESERVED.has(prev.lower) || prev.lower === 'all';
        return prev.kind === 'extended' || prev.text === ')' || prev.text === ']';
    };

    while (i < n) {
        const c = text[i]!;
        if (newline()) continue;
        if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === ' ') {
            i++;
            continue;
        }
        // Comments: `-- …` to end of line, `/* … */` (VHDL-2008, may span lines).
        if (c === '-' && text[i + 1] === '-') {
            while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
                if (!newline()) i++;
            }
            i = Math.min(n, i + 2);
            continue;
        }

        const start = i;
        const startLine = line;
        const startCol = i - lineStart + 1;

        if (isLetter(c)) {
            while (i < n && isIdentChar(text[i]!)) i++;
            // Bit-string literal: B"…", X"…", UX"…" etc.
            if (text[i] === '"' && BIT_STRING_BASE.test(text.slice(start, i))) {
                i = scanString(text, i);
                push('bitstring', start, startLine, startCol);
            } else {
                push('identifier', start, startLine, startCol);
            }
            continue;
        }
        if (isDigit(c)) {
            while (i < n && (isIdentChar(text[i]!) || text[i] === '.' || text[i] === '#')) {
                // exponent sign: 1.0e-9
                if ((text[i] === 'e' || text[i] === 'E') && (text[i + 1] === '+' || text[i + 1] === '-')) i++;
                i++;
            }
            if (text[i] === '"') {
                // VHDL-2008 sized bit string, e.g. 8X"FF"
                i = scanString(text, i);
                push('bitstring', start, startLine, startCol);
            } else {
                push('number', start, startLine, startCol);
            }
            continue;
        }
        if (c === '"') {
            i = scanString(text, i);
            push('string', start, startLine, startCol);
            continue;
        }
        if (c === '\\') {
            i++;
            while (i < n && text[i] !== '\n' && text[i] !== '\r') {
                if (text[i] === '\\') {
                    if (text[i + 1] === '\\') i += 2;
                    else {
                        i++;
                        break;
                    }
                } else i++;
            }
            push('extended', start, startLine, startCol);
            continue;
        }
        if (c === "'" && !tickContext() && i + 2 < n && text[i + 2] === "'" && text[i + 1] !== '\n' && text[i + 1] !== '\r') {
            i += 3;
            push('char', start, startLine, startCol);
            continue;
        }
        const compound = COMPOUND.find((d) => text.startsWith(d, i));
        i += compound ? compound.length : 1;
        push('delimiter', start, startLine, startCol);
    }
    return tokens;
}

/** Scans a "…" literal starting at the opening quote; `""` is an escaped quote. Stops at end of line if unterminated. */
function scanString(text: string, quote: number): number {
    let i = quote + 1;
    while (i < text.length) {
        const c = text[i]!;
        if (c === '"') {
            if (text[i + 1] === '"') i += 2;
            else return i + 1;
        } else if (c === '\n' || c === '\r') {
            return i;
        } else i++;
    }
    return i;
}
