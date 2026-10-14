#!/usr/bin/env node
/**
 * Validation driver for the DE10-Lite macOS backend (not the student UI).
 *   mixfpga-de10 status | ensure-ready | build <project> [--top <entity>] | detect | program <file.svf> | restart | shutdown | env
 * Add --json for machine-readable output. Exit code 0 only on a real success.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packageRoot } from '../../../core/paths';
import { De10LiteBackend } from './backend';

function usage(): never {
    process.stderr.write('usage: mixfpga-de10 <status|ensure-ready|build <project> [--top T]|detect|program <file.svf>|restart|shutdown|env> [--json]\n');
    process.exit(2);
}

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    const json = argv.includes('--json');
    const args = argv.filter((a) => a !== '--json');
    const cmd = args[0];
    if (!cmd) usage();
    const backend = new De10LiteBackend({ repoRoot: packageRoot(__dirname) });
    const ctl = new AbortController();
    process.on('SIGINT', () => {
        process.stderr.write('\ncancelling…\n');
        ctl.abort();
        void backend.cancelBuild();
    });
    const show = (value: unknown, text: string) => process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
    const diags = (ds: readonly { severity: string; code: string; message: string }[]) => ds.map((d) => `  [${d.severity}] ${d.code}: ${d.message}`).join('\n');

    switch (cmd) {
        case 'status': {
            const s = await backend.status();
            show(s, `engine: ${s.state}${s.toolVersion ? ` (${s.toolVersion})` : ''}\n${diags(s.problems)}`);
            return s.state === 'running' ? 0 : 1;
        }
        case 'ensure-ready': {
            const s = await backend.ensureReady(ctl.signal);
            show(s, `engine: ${s.state}${s.toolVersion ? ` (${s.toolVersion})` : ''}\n${diags(s.problems)}`);
            return s.state === 'running' ? 0 : 1;
        }
        case 'build': {
            const project = args[1];
            if (!project) usage();
            const ti = args.indexOf('--top');
            const r = await backend.build(resolve(project), {
                ...(ti > 0 && args[ti + 1] ? { top: args[ti + 1]! } : {}),
                signal: ctl.signal,
                onProgress: (e) => process.stderr.write(`[${e.kind === 'stage-started' ? 'start' : e.ok ? ' ok  ' : 'FAIL '}] ${e.stage}\n`),
            });
            const res = r.resources;
            const line = (m?: { used: number; available?: number; label: string }) => (m ? `${m.label}: ${m.used}${m.available ? ` / ${m.available}` : ''}` : '');
            show(r, [
                `build: ${r.implementationStatus}${r.failedStage ? ` (at ${r.failedStage})` : ''}  timing: ${r.timingStatus}  ${(r.durationMs / 1000).toFixed(1)} s`,
                ...[res.logic, res.registers, res.memoryBits, res.dsp].map(line).filter(Boolean),
                ...r.clocks.map((c) => `clock ${c.name}: target ${c.targetMHz ?? '?'} MHz, Fmax ${c.fmaxMHz ?? '?'} MHz, setup slack ${c.worstSetupSlackNs ?? '?'} ns, hold slack ${c.worstHoldSlackNs ?? '?'} ns`),
                r.programmingArtifact ? `artifact: ${r.programmingArtifact.path} (${r.programmingArtifact.sizeBytes} B, sha256 ${r.programmingArtifact.sha256})` : '',
                diags(r.diagnostics.filter((d) => d.severity !== 'info')),
            ].filter(Boolean).join('\n'));
            return r.implementationStatus === 'passed' ? 0 : r.implementationStatus === 'cancelled' ? 130 : 1;
        }
        case 'detect': {
            const d = await backend.detectHardware(ctl.signal);
            show(d, `hardware: ${d.status}\n${d.devices.map((x) => `  JTAG ${x.index}: idcode 0x${x.idcode.toString(16)} ${x.family ?? ''} ${x.model ?? ''}`).join('\n')}\n${diags(d.diagnostics)}`);
            return d.status === 'detected' ? 0 : 1;
        }
        case 'program': {
            const file = args[1];
            if (!file) usage();
            const path = resolve(file);
            const bytes = await readFile(path).catch(() => undefined);
            const o = await backend.program(
                { path, format: path.toLowerCase().endsWith('.svf') ? 'svf' : 'bit', sizeBytes: bytes ? (await stat(path)).size : 0, sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : '' },
                { signal: ctl.signal },
            );
            show(o, `program: ${o.status} (software verified: ${o.softwareVerified})\n${diags(o.diagnostics)}`);
            return o.status === 'programmed' ? 0 : 1;
        }
        case 'restart': {
            const s = await backend.restartImplementationEngine(ctl.signal);
            show(s, `engine: ${s.state}\n${diags(s.problems)}`);
            return s.state === 'running' ? 0 : 1;
        }
        case 'shutdown':
            await backend.shutdownImplementationEngine();
            show({ ok: true }, 'engine stopped');
            return 0;
        case 'env': {
            const e = await backend.environment(true);
            show(e, [...e.rows, ...e.details.map((d) => ({ label: `  ${d.label}`, value: d.value }))].map((r) => `${r.label.padEnd(24)} ${r.value}`).join('\n'));
            return e.allReady ? 0 : 1;
        }
        default:
            return usage();
    }
}

main().then(
    (code) => process.exit(code),
    (err) => {
        process.stderr.write(`mixfpga-de10: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    },
);
