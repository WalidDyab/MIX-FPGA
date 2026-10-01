import { stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type ToolRunner, succeeded } from '../process/tool-runner';
import { type Diagnostic, errorDiag, type LogRef } from '../results/diagnostic';
import type { RtlProvider, RtlProviderResult, RtlRequest } from './types';

const RTL_TIMEOUT_MS = 120_000;

/** Name of the RTL netlist inside the workspace rtl directory. */
export const RTL_NETLIST = 'rtl.json';

/**
 * The Yosys script for the RTL view: read the GHDL netlist, check the
 * hierarchy, turn processes into registers and multiplexers, drop unused
 * wires and write JSON. Deliberately no `synth*`, `flatten`, techmap,
 * nextpnr or bitstream step: cells stay generic ($add, $mux, $dff, ...)
 * and the module hierarchy is retained.
 */
export function rtlYosysScript(verilogFile: string, top: string): string {
    return `read_verilog ${verilogFile}; hierarchy -check -top ${top.toLowerCase()}; proc; opt_clean; write_json ${RTL_NETLIST}`;
}

/**
 * RtlProvider running the Yosys that ships with Apio/openXC7 through
 * `apio raw -- yosys` (the same way the toolchain detector reaches it).
 * Platform-neutral: needs only the Apio executable; the platform-configured
 * runner applies any platform environment (e.g. the macOS Apio pin).
 */
export class ApioYosysRtlProvider implements RtlProvider {
    readonly id = 'apio-yosys-rtl';

    constructor(
        private readonly apio: string,
        private readonly runner: ToolRunner,
    ) {}

    async elaborate(req: RtlRequest): Promise<RtlProviderResult> {
        const started = Date.now();
        const logs: LogRef[] = [];
        const dir = req.workspace.paths.rtl;
        const fail = (diagnostics: Diagnostic[]): RtlProviderResult => ({ status: 'failed', diagnostics, logs, durationMs: Date.now() - started });

        const run = await this.runner.run({
            executable: this.apio,
            args: ['raw', '--', 'yosys', '-q', '-p', rtlYosysScript(basename(req.verilog.path), req.top)],
            cwd: dir,
            timeoutMs: RTL_TIMEOUT_MS,
            ...(req.signal ? { signal: req.signal } : {}),
        });
        const logPath = join(req.workspace.paths.logs, 'yosys-rtl.log');
        await writeFile(logPath, `${run.stdout}\n${run.stderr}`, 'utf8');
        logs.push({ label: 'yosys-rtl', path: logPath });

        if (run.outcome === 'spawn-failed') return fail([errorDiag('implementation', 'RTL_NOT_STARTED', `Could not start the RTL analysis (${this.apio}): ${run.errorMessage ?? 'unknown error'}`)]);
        if (run.outcome !== 'exited') return fail([errorDiag('implementation', `RTL_${run.outcome.toUpperCase().replace('-', '_')}`, `RTL analysis ${run.outcome}.`)]);
        if (!succeeded(run)) {
            const reason = `${run.stdout}\n${run.stderr}`.split(/\r?\n/).find((l) => /ERROR/i.test(l))?.trim();
            return fail([errorDiag('implementation', 'RTL_FAILED', `RTL analysis failed${reason ? `: ${reason}` : ` (exit code ${run.exitCode})`}.`)]);
        }
        const path = join(dir, RTL_NETLIST);
        try {
            const s = await stat(path);
            return { status: 'succeeded', diagnostics: [], logs, durationMs: Date.now() - started, netlist: { kind: 'rtl-netlist', path, canonical: false, sizeBytes: s.size } };
        } catch {
            return fail([errorDiag('implementation', 'RTL_NO_NETLIST', `RTL analysis reported success but ${path} is missing.`)]);
        }
    }
}
