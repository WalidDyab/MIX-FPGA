import { type Diagnostic, errorDiag, warningDiag } from '../results/diagnostic';

/**
 * Helpers for a project's own XDC file (Phase 4A direct-XDC model).
 *
 * The student's file stays ordinary, Vivado-style XDC. Only the copy staged
 * for implementation is normalized: nextpnr-xilinx's XDC reader asserts on
 * `[get_ports { name }]` (spaces inside the braces, Phase 1), the form the
 * Digilent master files use, so the braces are tightened to `{name}`.
 */
export function normalizeXdcForImplementation(xdc: string): string {
    return xdc.replace(/\[\s*get_ports\s+\{\s*([^{}]*?)\s*\}\s*\]/g, (_m, names: string) => `[get_ports {${names.replace(/\s+/g, ' ')}}]`);
}

/** One `PACKAGE_PIN` assignment found in XDC text. */
export interface XdcPinAssignment {
    /** Port as written (e.g. `led0`, `sw[3]`). */
    readonly port: string;
    readonly pin: string;
    /** 1-based line number. */
    readonly line: number;
}

/** Removes a Tcl comment: `#` at the start of a command (line start or after `;`). */
function stripTclComment(line: string): string {
    if (line.trimStart().startsWith('#')) return '';
    const m = /;\s*#/.exec(line);
    return m ? line.slice(0, m.index) : line;
}

/** Every active (uncommented) PACKAGE_PIN assignment. Pure; tolerant of both brace styles. */
export function xdcPinAssignments(xdc: string): XdcPinAssignment[] {
    const out: XdcPinAssignment[] = [];
    xdc.split(/\r?\n/).forEach((raw, i) => {
        for (const command of stripTclComment(raw).split(';')) {
            const pin = /\bPACKAGE_PIN\s+\{?\s*([A-Za-z0-9]+)/.exec(command);
            if (!pin) continue;
            const ports = /\[\s*get_ports\s+(?:\{([^{}]*)\}|([^\]\s]+))\s*\]/.exec(command);
            if (!ports) continue;
            for (const port of (ports[1] ?? ports[2] ?? '').trim().split(/\s+/)) {
                if (port) out.push({ port, pin: pin[1]!, line: i + 1 });
            }
        }
    });
    return out;
}

/** A top-level port of the synthesized netlist. */
export interface NetlistPort {
    readonly name: string;
    readonly direction: 'input' | 'output' | 'inout';
    /** Bit indices for a vector port; absent for a scalar. */
    readonly bits?: readonly number[];
}

/**
 * Ports of `top` in GHDL's Verilog output (`module top (input clk, output [3:0] led);`).
 * Returns undefined when the header cannot be read with confidence. Pure.
 */
export function verilogTopPorts(verilog: string, top: string): NetlistPort[] | undefined {
    const header = new RegExp(`^\\s*module\\s+${top.toLowerCase().replace(/[^\w$]/g, '')}\\s*\\(([^)]*)\\)\\s*;`, 'm').exec(verilog);
    if (!header) return undefined;
    const body = header[1]!.trim();
    if (body === '') return [];
    const ports: NetlistPort[] = [];
    for (const part of body.split(',')) {
        const m = /^\s*(input|output|inout)\s+(?:(?:wire|reg)\s+)?(?:\[\s*(\d+)\s*:\s*(\d+)\s*\]\s*)?([A-Za-z_][\w$]*)\s*$/.exec(part);
        if (!m) return undefined;
        const [, direction, a, b, name] = m;
        let bits: number[] | undefined;
        if (a !== undefined && b !== undefined) {
            const lo = Math.min(Number(a), Number(b));
            const hi = Math.max(Number(a), Number(b));
            bits = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
        }
        ports.push({ name: name!, direction: direction as NetlistPort['direction'], ...(bits ? { bits } : {}) });
    }
    return ports;
}

/**
 * Checks that every bit of every top-level port has a PACKAGE_PIN, and warns
 * about pins assigned to ports the design does not have. An unconstrained
 * port would otherwise be placed on an arbitrary package pin.
 * `file` (project-relative) locates the diagnostics, if the XDC is a project file.
 */
export function checkPortConstraints(ports: readonly NetlistPort[], xdc: string, file?: string): Diagnostic[] {
    const assigned = xdcPinAssignments(xdc);
    const constrained = new Set(assigned.map((a) => a.port.toLowerCase()));
    const where = file ? ` in ${file}` : '';
    const d: Diagnostic[] = [];
    const known = new Set<string>();
    for (const p of ports) {
        const names = p.bits ? p.bits.map((b) => `${p.name}[${b}]`) : [p.name];
        for (const n of names) known.add(n.toLowerCase());
        const missing = names.filter((n) => !constrained.has(n.toLowerCase()));
        if (missing.length > 0) {
            const what = p.bits && missing.length < names.length ? `bits ${missing.join(', ')} of port "${p.name}" have` : `top-level port "${p.name}" has`;
            d.push(
                errorDiag(
                    'board',
                    'XDC_PORT_UNCONSTRAINED',
                    `The ${what} no PACKAGE_PIN${where}. Add or uncomment a constraint line for it.`,
                    file ? { file } : undefined,
                ),
            );
        }
    }
    for (const a of assigned) {
        if (!known.has(a.port.toLowerCase())) {
            d.push(
                warningDiag(
                    'board',
                    'XDC_PORT_UNKNOWN',
                    `Pin ${a.pin} is assigned to "${a.port}", which is not a port of the top-level entity; the line has no effect.`,
                    file ? { file, line: a.line } : undefined,
                ),
            );
        }
    }
    return d;
}
