import { type Diagnostic, type DiagnosticSeverity, diagnostic } from '../../results/diagnostic';

/** One runtime `report`/`assert` line from a GHDL simulation. */
export interface GhdlRuntimeMessage {
    readonly file: string;
    readonly line: number;
    readonly time: string;
    readonly kind: 'report' | 'assertion';
    readonly level: 'note' | 'warning' | 'error' | 'failure';
    readonly text: string;
}

export interface ParsedGhdlOutput {
    readonly diagnostics: readonly Diagnostic[];
    readonly runtime: readonly GhdlRuntimeMessage[];
    /** From `simulation stopped @280ns`. */
    readonly stoppedAt?: string;
}

// `src/top.vhd:8:8:rest` (optional Windows drive prefix)
const LOCATED = /^((?:[A-Za-z]:)?[^:\r\n]+):(\d+):(\d+):(.*)$/;
const RUNTIME = /^@([^:]+):\((report|assertion) (note|warning|error|failure)\):\s?(.*)$/;
const COMPILE = /^(error|warning|note):\s?(.*)$/;
const TOOL_ERROR = /^(?:.*[\\/])?ghdl(?:\.exe)?:error:\s*(.*)$/i;
const STOPPED = /simulation (?:stopped|finished) @(\S+)/;

const LEVEL_SEVERITY: Record<GhdlRuntimeMessage['level'], DiagnosticSeverity> = {
    note: 'info',
    warning: 'warning',
    error: 'error',
    failure: 'error',
};

/**
 * Converts GHDL analysis/elaboration/simulation output into structured
 * diagnostics. Formats verified against GHDL 6.0.0.
 */
export function parseGhdlOutput(text: string): ParsedGhdlOutput {
    const diagnostics: Diagnostic[] = [];
    const runtime: GhdlRuntimeMessage[] = [];
    let stoppedAt: string | undefined;

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (line === '') continue;

        const stopped = STOPPED.exec(line);
        if (stopped) {
            stoppedAt = stopped[1];
            continue;
        }

        const located = LOCATED.exec(line);
        if (located) {
            const [, file, l, c, rest] = located as unknown as [string, string, string, string, string];
            const location = { file, line: Number(l), column: Number(c) };
            const rt = RUNTIME.exec(rest);
            if (rt) {
                const [, time, kind, level, msg] = rt as unknown as [string, string, GhdlRuntimeMessage['kind'], GhdlRuntimeMessage['level'], string];
                runtime.push({ file, line: location.line, time, kind, level, text: msg });
                diagnostics.push(diagnostic(LEVEL_SEVERITY[level], 'vhdl', `GHDL_${kind.toUpperCase()}_${level.toUpperCase()}`, `@${time}: ${msg}`, location));
                continue;
            }
            const comp = COMPILE.exec(rest);
            if (comp) {
                const [, level, msg] = comp as unknown as [string, 'error' | 'warning' | 'note', string];
                const severity: DiagnosticSeverity = level === 'note' ? 'info' : level;
                diagnostics.push(diagnostic(severity, 'vhdl', `GHDL_${level.toUpperCase()}`, msg, location));
                continue;
            }
        }

        const tool = TOOL_ERROR.exec(line);
        if (tool) diagnostics.push(diagnostic('error', 'vhdl', 'GHDL_ERROR', tool[1]!));
        // Anything else (source echo, caret lines, `instance:` lines) stays in the raw log only.
    }

    return stoppedAt === undefined ? { diagnostics, runtime } : { diagnostics, runtime, stoppedAt };
}

/** Module names declared in a Verilog netlist, in order. */
export function listVerilogModules(verilog: string): string[] {
    return [...verilog.matchAll(/^\s*module\s+([A-Za-z_][\w$]*)/gm)].map((m) => m[1]!);
}
