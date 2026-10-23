/**
 * Multi-board validation inside a real VS Code (NOT part of `npm test`; needs VS Code, the MIX-FPGA toolchain,
 * the FPGA engine and, for Program, a connected board). Run with run-phase6.ts (NEXYS_P6_SUITE=multiboard):
 *
 *   MIXFPGA_STAGE=de10    workspace = a DE10-Lite project: engine stays off for Check / Simulate / schematics, Build starts it,
 *                         Results/Hardware/Environment are DE10-Lite's. MIXFPGA_PROGRAM=1 also programs the board (SRAM).
 *   MIXFPGA_STAGE=nexys   workspace = a Nexys A7-100T project: the original flow, XDC files, LUT words; the engine is never started.
 *
 * Both stages write facts to the report; nothing here edits a student file except the scripted Add File round trip.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { NexysVhdlApi } from '../../extension/extension';
import { EXTENSION_ID, log, report, step, waitFor } from './edh-suite';

const run = promisify(execFile);
const stage = process.env['MIXFPGA_STAGE'] ?? 'de10';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run_(): Promise<void> {
    const ext = vscode.extensions.getExtension<NexysVhdlApi>(EXTENSION_ID)!;
    const out = process.env['NEXYS_EDH_REPORT']!;
    const exec = (cmd: string, ...args: unknown[]) => vscode.commands.executeCommand(cmd, ...args) as Promise<any>;
    const repo = ext.extensionPath;
    const mixfpgaRoot = process.env['MIXFPGA_HOME'] || join(process.env['HOME'] ?? '', 'Library', 'MIX-FPGA');
    const limactl = join(mixfpgaRoot, 'toolchains', '1.1', 'macos-arm64', 'lima', 'bin', 'limactl');
    const isMac = process.platform === 'darwin';
    const limaHome = join(mixfpgaRoot, 'lima');
    // The Linux engine exists only on macOS; on Windows there is nothing to ask (and it must never be needed).
    const vmState = async (): Promise<string> => {
        if (!isMac) return 'not-applicable';
        try {
            const r = await run(limactl, ['list', '--format', '{{.Status}}', 'mix-fpga-de10'], { env: { ...process.env, LIMA_HOME: limaHome } });
            return r.stdout.trim() || 'missing';
        } catch {
            return 'missing';
        }
    };
    try {
        const pkg = ext.packageJSON as { version: string; displayName: string };
        step('product', { displayName: pkg.displayName, version: pkg.version });
        const { service } = await ext.activate();
        await waitFor('project open', () => service.project, 30_000);
        await service.refreshNow();
        const snap = service.snapshot!;
        const resultsModule = require(join(repo, 'dist', 'extension', 'services', 'results-model.js')) as typeof import('../../extension/services/results-model');
        step('project', {
            stage,
            name: snap.project?.config.name,
            board: snap.project?.config.board,
            boardName: snap.boardName,
            constraintFormat: snap.constraintFormat,
            constraintFiles: snap.scanned.constraints,
            groupExtensions: snap.files.constraintExtensions,
            errors: snap.validation.filter((d) => d.severity === 'error').map((d) => d.code),
            legacyDefault: snap.project?.legacyBoardDefault ?? false,
        });

        // ---- MIXFPGA_STAGE=hardware: Detect, Program (SRAM, .svf) and Detect again, on the artifact already built. Builds nothing, starts nothing.
        if (stage === 'hardware') {
            const { createHash } = await import('node:crypto');
            const shaOf = async (f: string) => createHash('sha256').update(await readFile(f)).digest('hex');
            if (process.env['MIXFPGA_HW_BOARD'] === 'nexys') {
                // Nexys A7: the bitstream already built by Build (Apio), hashed before and after; Program loads it into SRAM only.
                const bit = join(service.projectRoot ?? '', '.nexysvhdl', 'impl', '_build', 'default', 'hardware.bit');
                const bitInfo = await stat(bit);
                step('artifactBefore', { bitstream: bit, sizeBytes: bitInfo.size, modified: bitInfo.mtime.toISOString(), sha256: await shaOf(bit) });
            } else {
                const buildDir = join(service.projectRoot ?? '', '.mix-fpga', 'build', 'de10-lite');
                const info = JSON.parse(await readFile(join(buildDir, 'build-info.json'), 'utf8')) as { builtAt: string; artifact: { sha256: string; sizeBytes: number }; artifacts?: Record<string, { sha256: string; sizeBytes: number }>; inputs: Record<string, string> };
                // The file this computer's programmer loads: .sof through quartus_pgm on Windows, .svf through the native programmer on macOS.
                const ext = process.platform === 'win32' ? 'sof' : 'svf';
                const svfName = (await readdir(buildDir)).find((f) => f.endsWith(`.${ext}`)) ?? `blink.${ext}`;
                const recorded = info.artifacts?.[ext]?.sha256 ?? info.artifact.sha256;
                const inputsNow: Record<string, string> = {};
                for (const f of Object.keys(info.inputs)) inputsNow[f] = await shaOf(join(service.projectRoot ?? '', f));
                step('artifactBefore', { builtAt: info.builtAt, svfFile: svfName, svfSha256: await shaOf(join(buildDir, svfName)), recordedSha256: recorded, hashMatches: (await shaOf(join(buildDir, svfName))) === recorded, builtAtOlderThanNow: info.builtAt, inputsUnchangedSinceBuild: Object.entries(info.inputs).every(([f, h]) => inputsNow[f] === h) });
            }
            step('vmBefore', await vmState());
            const detect = async (label: string) => {
                await exec('nexysvhdl.detectBoards');
                await waitFor('detection finished', () => (service.hardware.status !== 'detecting' && service.hardware.status !== 'unknown' ? service.hardware : undefined), 60_000);
                step(label, { status: service.hardware.status, count: service.hardware.boards.length, boards: service.hardware.boards.map((b) => `${b.productName} ${b.serialNumber ?? ''}`), diagnostics: service.hardware.diagnostics.map((d) => `${d.severity}:${d.code}:${d.message}`) });
            };
            await detect('detectBefore');
            await exec('nexysvhdl.program');
            await waitFor('program done', () => (service.workflow.program.state === 'passed' || service.workflow.program.state === 'failed' ? service.workflow.program : undefined), 180_000);
            step('program', service.workflow.program);
            const lp = service.lastProgram;
            step('programResult', { status: lp?.status, destination: lp?.destination, durationMs: lp?.durationMs, target: lp?.target, diagnostics: lp?.diagnostics.map((d) => `${d.severity}:${d.code}:${d.message}`) });
            await detect('detectAfter');
            step('vmAfter', await vmState());
            step('result', 'PASS');
            return;
        }

        // ---- Add File offers the active board's constraint types only
        const addFile = require(join(repo, 'dist', 'extension', 'project', 'add-file.js')) as typeof import('../../extension/project/add-file');
        step('addFileKinds', addFile.addFileKindsFor(snap.constraintFormat).map((k) => k.label));

        // ---- environment (normal mode) before anything starts
        const vmBefore = await vmState();
        step('vmBeforeEnvironment', vmBefore);
        const env = await service.refreshEnvironment();
        step('environment', { headline: env?.headline, level: env?.level, rows: env?.setup.map((r) => `${r.label}=${r.status}`), details: env?.items.map((i) => `${i.label}: ${i.detail}`), hasToolchainPrompt: env?.toolchain !== undefined });
        step('vmAfterEnvironment', await vmState());

        // ---- Check / Simulate / schematics must not start the engine (DE10)
        if (stage === 'de10' && isMac) {
            await run(limactl, ['stop', 'mix-fpga-de10'], { env: { ...process.env, LIMA_HOME: limaHome } }).catch(() => undefined);
            step('vmStoppedForTest', await vmState());
        }
        await exec('nexysvhdl.check');
        await waitFor('check done', () => (service.workflow.check.state === 'passed' || service.workflow.check.state === 'failed' ? service.workflow.check : undefined), 60_000);
        step('check', service.workflow.check);
        await exec('nexysvhdl.simulate');
        await waitFor('simulate done', () => (service.workflow.simulate.state === 'passed' || service.workflow.simulate.state === 'failed' ? service.workflow.simulate : undefined), 90_000);
        step('simulate', service.workflow.simulate);
        await exec('nexysvhdl.openSchematic');
        await sleep(500);
        await exec('nexysvhdl.openRtlSchematic');
        await waitFor('rtl schematic generated', () => (service.rtl.status === 'ready' || service.rtl.status === 'failed' || service.rtl.status === 'unavailable' ? service.rtl : undefined), 90_000);
        step('rtl', { status: service.rtl.status, message: 'message' in service.rtl ? service.rtl.message : undefined });
        step('vmAfterCheckSimulateSchematics', await vmState());

        // ---- Build (DE10: starts the engine; Nexys: only with MIXFPGA_NEXYS_BUILD=1)
        if ((stage === 'de10' || process.env['MIXFPGA_NEXYS_BUILD'] === '1') && process.env['MIXFPGA_SKIP_BUILD'] !== '1') {
            for (const label of stage === 'de10' ? ['cold', 'warm'] : ['build']) {
                const seen: string[] = [];
                const stages: string[] = [];
                const sub = service.onDidChange((k) => {
                    if (k !== 'workflow') return;
                    const s = service.workflow.build.summary;
                    if (s && seen[seen.length - 1] !== s) seen.push(s);
                    const st = (['synthesis', 'implementation', 'bitstream'] as const).find((id) => service.workflow.stages[id].state === 'running');
                    if (st && stages[stages.length - 1] !== st) stages.push(st);
                });
                const t0 = Date.now();
                await exec('nexysvhdl.build');
                await waitFor('build done', () => (service.workflow.build.state === 'passed' || service.workflow.build.state === 'failed' ? service.workflow.build : undefined), 600_000);
                sub.dispose();
                const b = service.lastBuild!;
                const model = resultsModule.buildResultsModel(undefined, undefined, b).build!;
                step(`build.${label}`, {
                    seconds: Math.round((Date.now() - t0) / 100) / 10,
                    success: b.success,
                    summary: service.workflow.build.summary,
                    statusLines: seen,
                    stageOrder: stages,
                    stageSummaries: Object.fromEntries(Object.entries(service.workflow.stages).map(([k, v]) => [k, `${v.state}${v.summary ? `: ${v.summary}` : ''}`])),
                    boardId: b.normalized?.boardId,
                    resourceRows: model.resources.map((r) => `${r.label}=${r.value}`),
                    timingRows: model.timing.map((r) => `${r.label}=${r.value}`),
                    artifactRow: model.bitstream && `${model.bitstream.label}=${model.bitstream.value}`,
                });
                if (label === 'cold') step('vmAfterBuild', await vmState());
            }
        }

        // ---- Hardware (MIXFPGA_SKIP_HARDWARE=1: no board is connected yet; Detect and Program are validated separately)
        if (process.env['MIXFPGA_SKIP_HARDWARE'] !== '1') {
            await exec('nexysvhdl.detectBoards');
            await waitFor('detection finished', () => (service.hardware.status !== 'detecting' && service.hardware.status !== 'unknown' ? service.hardware : undefined), 60_000);
            step('hardware', { status: service.hardware.status, boards: service.hardware.boards.map((b) => `${b.productName} ${b.serialNumber ?? ''}`), diagnostics: service.hardware.diagnostics.map((d) => d.code) });
        }

        // ---- Verify Environment and Restart FPGA Engine (boards with an engine)
        if (stage === 'de10') {
            const v = await exec('nexysvhdl.verifyEnvironment');
            step('verifyEnvironment', { ok: v?.ok, steps: v?.steps?.map((s: { label: string; ok: boolean }) => `${s.ok ? 'OK' : 'FAIL'} ${s.label}`) });
            const r = await exec('nexysvhdl.restartFpgaEngine');
            step('restartFpgaEngine', { state: r?.state, vm: await vmState() });
        } else {
            const v = await vscode.commands.executeCommand('nexysvhdl.verifyEnvironment').then(() => 'ran', (e: Error) => e.message);
            step('verifyEnvironmentOnNexys', v);
        }

        // ---- Program (physical; opt-in)
        if (stage === 'de10' && process.env['MIXFPGA_PROGRAM'] === '1') {
            await exec('nexysvhdl.program');
            await waitFor('program done', () => (service.workflow.program.state === 'passed' || service.workflow.program.state === 'failed' ? service.workflow.program : undefined), 120_000);
            step('program', service.workflow.program);
            const lp = service.lastProgram;
            step('programResult', { status: lp?.status, destination: lp?.destination, durationMs: lp?.durationMs, target: lp?.target, diagnostics: lp?.diagnostics.map((d) => `${d.severity}:${d.code}`) });
        }
        step('result', 'PASS');
    } catch (err) {
        step('result', `FAILED: ${(err as Error).stack ?? String(err)}`);
        throw err;
    } finally {
        await writeFile(out, JSON.stringify({ report, log }, null, 2));
        void rm; void readFile;
    }
}
export { run_ as run };
