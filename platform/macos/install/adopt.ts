import { readdir, lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { compareTree, inventoryTree, treeBytes, treeIsIdentical, describeDifference } from '../../../core/install/tree';
import type { ToolRunner } from '../../../core/process/tool-runner';
import type { De10Paths } from '../de10/config';
import { LimaEngine } from '../de10/engine';
import { compareInstanceConfig, type LimaInstanceJson } from './engine-config';
import type { LoadedExpected } from './expected';
import { LIMA_INSTANCE, type RuntimeLayout } from './layout';
import type { PayloadSource } from './payload';
import { InstallStateStore } from '../../../core/install/state-store';
import { LinuxVmRecordStore } from './engine-provision';
import { QUARTUS_SPEC, QuartusRecordStore, verifyQuartus, type QuartusVerification } from './quartus-install';
import { checkUnit, installToolchain, manifestFileMatches, readMarker } from './toolchain-installer';

/**
 * DRY RUN ONLY. Looks at an existing, already validated development setup (tools in a folder, a running or stopped engine)
 * and reports exactly what adopting it into the installed layout would copy, write, and leave alone. It reads files and asks
 * Lima for its list; it copies, writes, starts and deletes nothing. A later, separately approved step performs it.
 */
export interface AdoptionDeps {
    readonly layout: RuntimeLayout;
    readonly expected: LoadedExpected;
    /** The existing tools (one folder per tool, as the development setup keeps them) and where the support files come from. */
    readonly payload: PayloadSource;
    /** Folder names of the tools inside the existing toolchain folder, by unit id. */
    readonly legacyFolders: Readonly<Record<string, string>>;
    readonly legacyToolsRoot: string;
    readonly legacyPaths: De10Paths;
    readonly runner: ToolRunner;
    /** Things that exist on this machine and are deliberately left as they are. */
    readonly leaveAlone: readonly { path: string; why: string }[];
}

export interface CopyPlan {
    readonly unit: string;
    readonly name: string;
    readonly from: string;
    readonly to: string;
    readonly files: number;
    readonly bytes: number;
    /** The existing copy is byte-for-byte the validated one. */
    readonly identical: boolean;
    readonly problem?: string;
}

export interface EnginePlan {
    readonly found: boolean;
    readonly status?: string;
    /** Same configuration as the validated one (cpus, memory, disk, image digest, mount, Rosetta). */
    readonly matches?: boolean;
    readonly differences: readonly string[];
    /** Read-only checks inside the running engine; undefined when it is stopped (adoption would start it once to check). */
    readonly guest?: { readonly wrapper: boolean; readonly rosettadSocketAbsent: boolean; readonly quartusBanner?: string; readonly quartusIsExpectedBuild: boolean };
}

export type AdoptionStatus = 'adoptable' | 'blocked' | 'nothing-to-do';

export interface AdoptionPlan {
    readonly status: AdoptionStatus;
    readonly installedRoot: string;
    readonly copies: readonly CopyPlan[];
    readonly totalCopyBytes: number;
    readonly engine: EnginePlan;
    /** Everything adoption would create or write, and nothing else. */
    readonly writes: readonly string[];
    readonly untouched: readonly { path: string; bytes: number | undefined; why: string }[];
    readonly blockers: readonly string[];
    readonly notes: readonly string[];
}

async function sizeOf(path: string): Promise<number | undefined> {
    const s = await lstat(path).catch(() => undefined);
    if (!s) return undefined;
    if (!s.isDirectory()) return s.blocks * 512; // bytes really allocated on disk (the engine's disk file is sparse)
    let total = 0;
    for (const e of await readdir(path, { withFileTypes: true })) total += (await sizeOf(join(path, e.name))) ?? 0;
    return total;
}

export async function planAdoption(d: AdoptionDeps): Promise<AdoptionPlan> {
    const { layout, expected } = d;
    const blockers: string[] = [];
    const notes: string[] = [];
    const copies: CopyPlan[] = [];

    const alreadyInstalled = await stat(layout.toolchainMarker).then(() => true, () => false);
    if (alreadyInstalled) notes.push('A completed MIX-FPGA toolchain marker already exists; the toolchain part would be verified, not copied again.');

    for (const u of expected.toolchain.units) {
        const to = layout.unit(u.path);
        if (u.kind === 'tool') {
            const folder = d.legacyFolders[u.id];
            const from = folder ? join(d.legacyToolsRoot, folder) : undefined;
            if (!from || !(await stat(from).then(() => true, () => false))) {
                copies.push({ unit: u.id, name: u.name, from: from ?? '(none)', to, files: 0, bytes: 0, identical: false, problem: 'the existing copy was not found' });
                blockers.push(`${u.name}: not found where the existing setup keeps it.`);
                continue;
            }
            const inv = await inventoryTree(from);
            const diff = compareTree(u, inv);
            const identical = treeIsIdentical(diff);
            copies.push({ unit: u.id, name: u.name, from, to, files: inv.files.length, bytes: treeBytes(inv), identical, ...(identical ? {} : { problem: describeDifference(diff) }) });
            // Unknown binaries are never adopted silently.
            if (!identical) blockers.push(`${u.name}: the existing files differ from the validated ${u.version ?? ''} (${describeDifference(diff)}); they would not be adopted.`);
        } else {
            const has = await d.payload.has(u);
            copies.push({ unit: u.id, name: u.name, from: has ? `${d.payload.describe()} (${u.path})` : '(none)', to, files: u.files.length + u.links.length, bytes: u.bytes, identical: has, ...(has ? {} : { problem: 'the source for this part is missing' }) });
            if (!has) blockers.push(`${u.name}: no source available.`);
        }
    }
    const totalCopyBytes = alreadyInstalled ? 0 : copies.reduce((n, c) => n + c.bytes, 0);

    // The engine: only its description (Lima's list) and, if it is already running, a few read-only checks inside it.
    const lima = new LimaEngine(d.legacyPaths, d.runner);
    const listed = await d.runner.run({ executable: d.legacyPaths.limactl, args: ['list', '--json', LIMA_INSTANCE], env: { LIMA_HOME: d.legacyPaths.limaHome }, timeoutMs: 30_000 });
    const line = listed.stdout.split('\n').find((l) => l.trim().startsWith('{'));
    let engine: EnginePlan = { found: false, differences: [] };
    if (line) {
        const json = JSON.parse(line) as LimaInstanceJson;
        const diffs = compareInstanceConfig(json, layout.shareDir);
        engine = { found: true, status: json.status ?? 'unknown', matches: diffs.length === 0, differences: diffs.map((x) => `${x.field}: expected ${x.expected}, found ${x.actual}`) };
        if (diffs.length > 0) blockers.push(`The existing engine differs from the validated configuration (${diffs.map((x) => x.field).join(', ')}); it would not be adopted.`);
        if (json.status === 'Running') {
            const g = await lima.guest('test -x /usr/local/bin/mixfpga-q && echo WRAPPER_OK; test -S /run/rosettad/rosetta.sock && echo SOCKET_PRESENT || echo SOCKET_ABSENT; mixfpga-q quartus_sh --version 2>&1 | head -3', { timeoutMs: 120_000 });
            const text = `${g.stdout}\n${g.stderr}`;
            const banner = /Version (\S+ Build \d+)/.exec(text)?.[1];
            engine = { ...engine, guest: { wrapper: text.includes('WRAPPER_OK'), rosettadSocketAbsent: text.includes('SOCKET_ABSENT'), ...(banner ? { quartusBanner: banner } : {}), quartusIsExpectedBuild: text.includes(QUARTUS_SPEC.banner) } };
            if (!engine.guest!.quartusIsExpectedBuild) blockers.push('Quartus in the existing engine is not the expected build; it would not be adopted.');
        } else notes.push(`The existing engine is ${json.status}; adoption would start it once to check Quartus, then stop it again.`);
    } else notes.push('No engine named mix-fpga-de10 exists; the normal Install flow would create one.');

    const writes: string[] = [];
    if (!alreadyInstalled) {
        for (const c of copies) writes.push(`${c.to}  (${c.files} files, ${(c.bytes / 1e6).toFixed(1)} MB, copied then verified, made read-only)`);
        writes.push(`${layout.manifestFile}  (the recorded manifest)`, `${layout.toolchainMarker}  (written last)`);
    }
    if (engine.found) writes.push(join(layout.stateDir, 'linux-vm.json') + '  (records that the existing engine was verified; nothing inside it changes)', join(layout.stateDir, 'quartus.json') + '  (records the verified Quartus build; no licence acceptance is invented)');
    writes.push(layout.stateDir + '/  and  ' + layout.logsDir + '/  (created if missing)');

    const untouched = await Promise.all(d.leaveAlone.map(async (l) => ({ path: l.path, bytes: await sizeOf(l.path), why: l.why })));
    if (engine.found) untouched.push({ path: layout.instanceDir, bytes: await sizeOf(layout.instanceDir), why: 'the engine itself: same folder, same name, same configuration; not moved, copied, recreated or edited' });
    notes.push('The engine\'s Quartus licence acceptance was given in the Phase 1 session; no in-app acceptance record exists for it, and none is fabricated.');

    const status: AdoptionStatus = blockers.length > 0 ? 'blocked' : alreadyInstalled && engine.found ? 'nothing-to-do' : 'adoptable';
    return { status, installedRoot: layout.root, copies, totalCopyBytes, engine, writes, untouched, blockers, notes };
}

export function formatAdoptionPlan(p: AdoptionPlan): string {
    const mb = (n: number | undefined) => (n === undefined ? 'absent' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);
    const L: string[] = [`ADOPTION DRY RUN: ${p.status.toUpperCase()}   (nothing was changed)`, `Installed layout: ${p.installedRoot}`, '', 'WOULD COPY (existing tools -> installed toolchain; each verified byte for byte against the recorded manifest):'];
    for (const c of p.copies) L.push(`  ${c.identical ? 'identical' : 'DIFFERENT '}  ${c.name.padEnd(28)} ${String(c.files).padStart(4)} files ${mb(c.bytes).padStart(9)}   ${c.from}${c.problem ? `   [${c.problem}]` : ''}`);
    L.push(`  extra disk use: ${mb(p.totalCopyBytes)}`, '', 'WOULD WRITE (and nothing else):', ...p.writes.map((w) => `  ${w}`), '', 'ENGINE:');
    if (!p.engine.found) L.push('  none found');
    else {
        L.push(`  found, ${p.engine.status}; configuration ${p.engine.matches ? 'matches the validated one' : 'DIFFERS'}${p.engine.differences.length ? `: ${p.engine.differences.join('; ')}` : ''}`);
        if (p.engine.guest) L.push(`  read-only checks inside it: wrapper ${p.engine.guest.wrapper ? 'present' : 'MISSING'}, Rosetta caching socket ${p.engine.guest.rosettadSocketAbsent ? 'absent (good)' : 'PRESENT'}, Quartus ${p.engine.guest.quartusBanner ?? 'not found'} ${p.engine.guest.quartusIsExpectedBuild ? '(expected build)' : '(NOT the expected build)'}`);
    }
    L.push('', 'LEFT UNTOUCHED:', ...p.untouched.map((u) => `  ${mb(u.bytes).padStart(9)}  ${u.path}   (${u.why})`));
    if (p.notes.length) L.push('', 'NOTES:', ...p.notes.map((n) => `  ${n}`));
    if (p.blockers.length) L.push('', 'BLOCKERS (adoption would refuse):', ...p.blockers.map((b) => `  ${b}`));
    return `${L.join('\n')}\n`;
}


export interface AdoptionStep {
    readonly label: string;
    readonly ok: boolean;
    readonly detail?: string;
}

export interface AdoptionResult {
    readonly ok: boolean;
    /** `refused`: the checks differ from the approved plan and nothing was changed. */
    readonly outcome: 'adopted' | 'refused' | 'failed';
    readonly steps: readonly AdoptionStep[];
    readonly plan: AdoptionPlan;
}

/**
 * Performs the adoption the dry run described, and only that. It re-checks everything first and refuses (changing nothing)
 * if anything differs. The engine is adopted by verification only: it is not started, stopped, edited, moved or recreated.
 * The tools are copied through the normal installer (staged, verified against the manifest, read-only, completion marker last).
 */
export async function performAdoption(d: AdoptionDeps & { readonly now?: () => Date }): Promise<AdoptionResult> {
    const steps: AdoptionStep[] = [];
    const step = (label: string, ok: boolean, detail?: string) => steps.push({ label, ok, ...(detail ? { detail } : {}) });
    const { layout, expected } = d;
    const store = new InstallStateStore(layout.installStateFile, layout.lockFile);
    // Look first: a refusal must not create anything, not even folders.
    const plan = await planAdoption(d);
    const identical = plan.copies.every((c) => c.identical);
    const engineOk = plan.engine.found && plan.engine.matches === true && plan.engine.status === 'Running' && plan.engine.guest?.wrapper === true && plan.engine.guest.rosettadSocketAbsent && plan.engine.guest.quartusIsExpectedBuild;
    step('Existing tools match the validated manifest', identical, identical ? `${plan.copies.length} parts identical` : plan.blockers.join('; '));
    step('Existing engine matches the validated configuration and is running with the expected Quartus', engineOk, engineOk ? undefined : (plan.blockers.join('; ') || 'the engine is not running or not as expected'));
    if (!(plan.status === 'adoptable' || plan.status === 'nothing-to-do') || !identical || !engineOk) return { ok: false, outcome: 'refused', steps, plan };
    const release = await store.acquireLock('adopt');
    if (!release) {
        step('Another setup is running', false);
        return { ok: false, outcome: 'refused', steps, plan };
    }
    try {
        // 1. Verify the engine and Quartus (read-only apart from a private scratch folder inside the engine).
        const lima = new LimaEngine(d.legacyPaths, d.runner);
        const v: QuartusVerification = await verifyQuartus(lima, layout.shareDir, QUARTUS_SPEC);
        step('Quartus 25.1 Build 1129, MAX 10 support, device and a test design', v.ok, v.ok ? v.version : v.message);
        if (!v.ok) return { ok: false, outcome: 'failed', steps, plan };

        // 2. Record what was verified. No licence acceptance is invented.
        const at = (d.now ?? (() => new Date()))().toISOString();
        await new LinuxVmRecordStore(join(layout.stateDir, 'linux-vm.json')).merge({ adoptedAt: at, verifiedAt: at, quartusPresent: true });
        await new QuartusRecordStore(join(layout.stateDir, 'quartus.json')).merge({ adoptedAt: at, adoptedFrom: 'existing development engine, verified (not installed by MIX-FPGA)', verifiedAt: at, ...(v.version ? { version: v.version } : {}), device: QUARTUS_SPEC.device });
        step('Recorded the verified engine and Quartus', true);

        // 3. The tools, through the installer; its completion marker is written last.
        if (plan.totalCopyBytes > 0 || !(await readMarker(layout))) {
            const r = await installToolchain({ layout, expected, payload: d.payload, freeBytes: async () => Number.MAX_SAFE_INTEGER }, { progress: () => undefined });
            step('Copied, verified and sealed the toolchain', r.ok, r.ok ? r.detail : r.message);
            if (!r.ok) return { ok: false, outcome: 'failed', steps, plan };
        } else step('Toolchain already installed', true);

        // 4. Full-tree verification of what is now installed.
        const checks = await Promise.all(expected.toolchain.units.map((u) => checkUnit(layout, u, 'full')));
        const allOk = checks.every((c) => c.state === 'ok') && (await manifestFileMatches(layout, expected)) && (await readMarker(layout))?.manifestSha256 === expected.sha256;
        step('Full-tree verification of the installed toolchain', allOk, allOk ? `${checks.length} parts, every file hashed` : checks.filter((c) => c.state !== 'ok').map((c) => c.unit.name).join(', '));
        return { ok: allOk, outcome: allOk ? 'adopted' : 'failed', steps, plan };
    } finally {
        await release();
    }
}
