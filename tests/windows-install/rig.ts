import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import type { TestContext } from 'node:test';
import { installToolchainArchive, writeTarGz, type ToolchainRequirement, type ToolInvocation, type ToolRunResult, type ToolRunner } from '../../core';
import { inventoryTree, makeWritable, treeBytes, treeDigest } from '../../core/install/tree';
import { copyTree } from '../../core/install/tree';
import type { BoardSupportId } from '../../platform/macos/install/boards';
import type { InstallSummary, SetupInteraction } from '../../platform/macos/install/setup-controller';
import type { HardwareView } from '../../platform/macos/install/setup-view';
import { type ExpectedToolchain, type LoadedExpected, type ToolchainUnit } from '../../platform/shared/install/expected';
import { DirectoryPayload } from '../../platform/shared/install/payload';
import type { LicenseOffer } from '../../platform/shared/install/quartus-vendor';
import { NativeQuartusEngine } from '../../platform/windows/de10/native-quartus-engine';
import { ElevatedHelper, type HelperFailure, type HelperResponse } from '../../platform/windows/install/elevation';
import { resolveWindowsLayout, type WindowsRuntimeLayout } from '../../platform/windows/install/layout';
import { installedWindowsDe10Paths } from '../../platform/windows/install/paths';
import { WINDOWS_QUARTUS_SPEC, type WindowsQuartusSpec } from '../../platform/windows/install/quartus-install';
import { WindowsSetupController } from '../../platform/windows/install/setup-controller';
import { fakeArchive, writeFakeBundle } from '../bundle-fixture';
import { REPO } from '../helpers';
import { FakeQuartusRunner, windowsEnv } from '../windows-de10/fake-quartus';

export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const DE10: HardwareView = { state: 'ready', word: 'DE10-Lite' };
export const NONE: HardwareView = { state: 'not-connected', word: 'Not connected' };

const TOOLS = ['ghdl', 'yosys'] as const;

/** A small stand-in for the validated Windows tools: real files in the real layout (bin\*.exe, DLLs, data) so hashes, trees and the part-check script are real. */
async function makeSourceTools(root: string): Promise<Record<string, string>> {
    const sources: Record<string, string> = {};
    for (const id of TOOLS) {
        const dir = join(root, `${id}-src`);
        await mkdir(join(dir, 'bin'), { recursive: true });
        await mkdir(join(dir, 'share', 'deep'), { recursive: true });
        await writeFile(join(dir, 'bin', `${id}.exe`), `MZ fake ${id} 1.0 ${'x'.repeat(2048)}`);
        await writeFile(join(dir, 'bin', 'libgcc_s_seh-1.dll'), `dll-${id}-${'y'.repeat(2048)}`);
        await writeFile(join(dir, 'share', 'deep', 'data.txt'), `data for ${id}`);
        sources[id] = dir;
    }
    // The real support script, so the engine's part check reads exactly what ships.
    const scripts = join(root, 'scripts-src');
    await mkdir(scripts, { recursive: true });
    await cp(join(REPO, 'platform', 'windows', 'scripts', 'part-check.tcl'), join(scripts, 'part-check.tcl'));
    const lic = join(root, 'licenses-src');
    await mkdir(join(lic, 'ghdl'), { recursive: true });
    await writeFile(join(lic, 'ghdl', 'COPYING'), 'GPL text');
    await writeFile(join(root, 'notices-src.txt'), 'notices');
    Object.assign(sources, { scripts, licenses: lic, notices: join(root, 'notices-src.txt') });
    return sources;
}

async function expectedFor(sources: Record<string, string>): Promise<LoadedExpected> {
    const units: ToolchainUnit[] = [];
    const add = async (u: Omit<ToolchainUnit, 'files' | 'links' | 'treeSha256' | 'bytes'>, src: string) => {
        const inv = await inventoryTree(src);
        units.push({ ...u, files: inv.files, links: inv.links, treeSha256: treeDigest(inv), bytes: treeBytes(inv) });
    };
    for (const id of TOOLS) await add({ id, kind: 'tool', name: id.toUpperCase(), version: '1.0.0', path: id, executable: `bin/${id}.exe` }, sources[id]!);
    await add({ id: 'scripts', kind: 'support', name: 'Support scripts', path: 'scripts' }, sources['scripts']!);
    await add({ id: 'licenses', kind: 'support', name: 'Licences', path: 'LICENSES' }, sources['licenses']!);
    await add({ id: 'notices', kind: 'support', name: 'Notices', path: 'THIRD_PARTY_NOTICES.txt' }, sources['notices']!);
    const toolchain: ExpectedToolchain = { schemaVersion: 1, product: 'MIX-FPGA', toolchainVersion: '1.0', target: 'windows-x64', units };
    const text = `${JSON.stringify(toolchain, null, 1)}\n`;
    return { toolchain, text, sha256: sha(text) };
}

/** Answers every Setup question from fields the test sets, and records what was asked. */
export class ScriptedUi implements SetupInteraction {
    summaries: InstallSummary[] = [];
    questions: string[] = [];
    messages: string[] = [];
    logs: string[] = [];
    boards: BoardSupportId[] | undefined = ['de10-lite'];
    offeredBoards: { id: BoardSupportId; name: string; installed: boolean }[][] = [];
    confirm = true;
    files: { installerPath: string; devicePackagePath: string } | undefined;
    nexysArchive: string | undefined;
    accept = true;
    offers: LicenseOffer[] = [];
    async chooseBoards(b: readonly { id: BoardSupportId; name: string; installed: boolean }[]) {
        this.questions.push('boards');
        this.offeredBoards.push([...b]);
        return this.boards;
    }
    async askNexysArchive() {
        this.questions.push('nexys-file');
        return this.nexysArchive;
    }
    async confirmInstall(s: InstallSummary) {
        this.summaries.push(s);
        this.questions.push('confirm');
        return this.confirm;
    }
    async askRosettaConsent(): Promise<undefined> {
        this.questions.push('rosetta');
        return undefined;
    }
    async askQuartusFiles() {
        this.questions.push('files');
        return this.files;
    }
    async showLicense(o: LicenseOffer) {
        this.questions.push('license');
        this.offers.push(o);
        return this.accept;
    }
    progress(m: string) {
        this.messages.push(m);
    }
    log(l: string) {
        this.logs.push(l);
    }
}

/** The text a Windows Altera installer writes: CRLF line endings. */
export const LICENSE_TEXT = 'QUARTUS PRIME AND INTEL FPGA IP LICENSE AGREEMENT (test text)\nLine two\n';
export const LICENSE_RAW = Buffer.from(LICENSE_TEXT.replace(/\n/g, '\r\n'));

/** A stand-in for the elevated helper: no prompt, no PowerShell, no real installer. Records the order of everything it is asked. */
export class FakeHelper extends ElevatedHelper {
    events: string[] = [];
    declinePrompt = false;
    installExit = 0;
    licenseMissing = false;
    /** A licence file the installer wrote that is not the one verified for this build. */
    licenseOverride: Buffer | undefined;
    private acceptance: { licenseSha256: string } | undefined;
    private on = false;
    constructor(private readonly rig: { quartusRoot: string; dir: string; makeQuartus: () => Promise<void>; spec: () => WindowsQuartusSpec }) {
        super({ runner: { run: async () => { throw new Error('the fake helper never runs a process'); } }, dir: join(rig.dir, 'helper-fake'), params: { installers: '', installerName: '', installerSha256: '', packageName: '', packageSha256: '', installDir: '', disabledComponents: '', licenseSha256: '' } });
    }
    override get running(): boolean {
        return this.on;
    }
    override async start(): Promise<{ ok: true } | HelperFailure> {
        // Like the real helper: once running it stays running (one permission prompt), and starting it again asks nothing.
        if (this.on) return { ok: true };
        this.events.push('start');
        if (this.declinePrompt) return { ok: false, code: 'ELEVATION_DECLINED', message: 'Windows did not give permission to install.' };
        this.on = true;
        return { ok: true };
    }
    override get licenseFile(): string {
        return join(this.rig.dir, 'helper-fake', 'license-out', 'licenses', 'license.txt');
    }
    override async request(op: 'license' | 'install' | 'quit'): Promise<HelperResponse | HelperFailure> {
        this.events.push(op);
        if (op === 'license') {
            if (this.licenseMissing) return { id: '1', ok: false, exitCode: 4, message: 'the installer did not write its licence' };
            await mkdir(join(this.licenseFile, '..'), { recursive: true });
            await writeFile(this.licenseFile, this.licenseOverride ?? LICENSE_RAW);
            return { id: '1', ok: true, exitCode: 0, message: 'licence written' };
        }
        if (op === 'install') {
            // Exactly what the real helper enforces: no recorded acceptance of this licence, no installation.
            if (!this.acceptance || this.acceptance.licenseSha256 !== this.rig.spec().license.rawSha256) return { id: '2', ok: false, exitCode: 5, message: 'no recorded acceptance' };
            if (this.installExit !== 0) return { id: '2', ok: false, exitCode: this.installExit, message: `installer exit ${this.installExit}` };
            await this.rig.makeQuartus();
            return { id: '2', ok: true, exitCode: 0, message: 'installer exit 0' };
        }
        return { id: '3', ok: true, exitCode: 0, message: 'bye' };
    }
    override async recordAcceptance(a: { licenseSha256: string; installerSha256: string; acceptedAt: string }): Promise<void> {
        this.events.push('accepted');
        this.acceptance = a;
    }
    override async stop(): Promise<void> {
        if (!this.on) return;
        this.events.push('stop');
        this.on = false;
    }
}

/** Counts what is run; Quartus tools go to the fake Quartus, everything else to a scripted answer. */
class RoutingRunner implements ToolRunner {
    readonly calls: ToolInvocation[] = [];
    constructor(private readonly rig: () => Rig) {}
    async run(inv: ToolInvocation): Promise<ToolRunResult> {
        this.calls.push(inv);
        const ok = (o: Partial<ToolRunResult> = {}): ToolRunResult => ({ invocation: inv, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1, ...o });
        if (/[\\/](quartus_\w+)\.exe$/.test(inv.executable)) return this.rig().quartusRunner.run(inv);
        if (inv.executable === 'reg.exe') return ok({ exitCode: 1 });
        if (inv.executable === 'pnputil.exe') return ok({ stdout: this.rig().driver ? 'Original Name:      usbblstr.inf\r\n' : 'Original Name:      other.inf\r\n' });
        return ok({ outcome: 'spawn-failed', exitCode: null, errorMessage: `unexpected executable ${inv.executable}` });
    }
}

export interface Rig {
    ctl: WindowsSetupController;
    dir: string;
    layout: WindowsRuntimeLayout;
    sources: Record<string, string>;
    expected: LoadedExpected;
    ui: ScriptedUi;
    helper: FakeHelper;
    runner: RoutingRunner;
    quartusRunner: FakeQuartusRunner;
    /** Where the fake Quartus lives, and whether it is installed. */
    quartusRoot: string;
    quartusInstalled: boolean;
    driver: boolean;
    downloads: string;
    free: number;
    longPaths: boolean | undefined;
    hardware: HardwareView;
    nexysRequirement: ToolchainRequirement;
    nexysRoot: string;
    legacyRoot: string;
    payloadDir: string;
    nexysArchive: string;
    de10Archive: string;
    digilent: boolean;
    spec: WindowsQuartusSpec;
    /** Units the DE10 payload was asked to copy. */
    copied: string[];
    makeQuartus: () => Promise<void>;
    rebuild: (over?: Partial<RigOptions>) => void;
}

export interface RigOptions {
    /** A NexysVHDL 0.6.0 store with the validated Nexys toolchain exists (upgrade case). */
    readonly legacyNexys: boolean;
    /** The Nexys archive sits in the payload folder (pinned); otherwise the student is asked for it. */
    readonly pinnedNexys: boolean;
    /** The DE10 tools come from a pinned archive instead of the development folder. */
    readonly de10Archive: boolean;
    /** Quartus 25.1 with MAX 10 is already installed (the development machine). */
    readonly quartusPresent: boolean;
    /** What Quartus's own device list says (default: the MAX 10 part is there). */
    readonly parts: 'ok' | 'no-max10' | 'part-missing' | 'command-fails';
    /** MIXFPGA_HOME for the layout (default: a short folder in the test directory). */
    readonly home: string | undefined;
}

export async function rig(t: TestContext, opts: Partial<RigOptions> = {}): Promise<Rig> {
    const o: RigOptions = { legacyNexys: false, pinnedNexys: true, de10Archive: true, quartusPresent: false, parts: 'ok', home: undefined, ...opts };
    const dir = await mkdtemp(join(tmpdir(), 'mfw '));
    t.after(async () => {
        await makeWritable(dir).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
    });
    const sources = await makeSourceTools(dir);
    const expected = await expectedFor(sources);
    const layout = resolveWindowsLayout({ env: { MIXFPGA_HOME: o.home ?? join(dir, 'home', 'MIX-FPGA') } });

    const downloads = join(dir, 'Downloads');
    await mkdir(downloads);
    const installer = Buffer.from('MZ fake quartus installer'.repeat(40));
    const pkg = Buffer.from('fake max10 package'.repeat(60));
    await writeFile(join(downloads, WINDOWS_QUARTUS_SPEC.installer.name), installer);
    await writeFile(join(downloads, WINDOWS_QUARTUS_SPEC.devicePackage.name), pkg);
    const spec: WindowsQuartusSpec = {
        ...WINDOWS_QUARTUS_SPEC,
        license: { ...WINDOWS_QUARTUS_SPEC.license, sha256: sha(LICENSE_TEXT), bytes: Buffer.byteLength(LICENSE_TEXT), rawSha256: sha(LICENSE_RAW), rawBytes: LICENSE_RAW.length },
        installer: { name: WINDOWS_QUARTUS_SPEC.installer.name, sha256: sha(installer), bytes: installer.length },
        devicePackage: { name: WINDOWS_QUARTUS_SPEC.devicePackage.name, sha256: sha(pkg), bytes: pkg.length },
    };

    // Nexys A7 support: a small stand-in for the NexysVHDL Toolchain 1.0 bundle, as an archive.
    const bundle = join(dir, 'nexys-bundle');
    await writeFakeBundle(bundle, { target: 'win32-x64' });
    const made = await fakeArchive(dir, bundle, { target: 'win32-x64' });
    const payloadDir = join(dir, 'payloads');
    await mkdir(payloadDir);
    const nexysArchive = join(payloadDir, 'nexysvhdl-toolchain-1.0-win32-x64.tar.gz');
    await cp(made.archive, nexysArchive);
    const pins: Record<string, { file: string; sha256: string }> = {};
    if (o.pinnedNexys) pins['nexys-a7-100t'] = { file: 'nexysvhdl-toolchain-1.0-win32-x64.tar.gz', sha256: sha(await readFile(nexysArchive)) };
    // DE10 support archive (the release form).
    const tree = join(dir, 'de10-tree');
    for (const u of expected.toolchain.units) await copyTree(sources[u.id]!, join(tree, u.path));
    await writeFile(join(tree, 'manifest.json'), expected.text);
    const de10Archive = join(payloadDir, 'mixfpga-de10-lite-support-1.0-windows-x64.tar.gz');
    await writeTarGz(tree, de10Archive);
    if (o.de10Archive) pins['de10-lite'] = { file: 'mixfpga-de10-lite-support-1.0-windows-x64.tar.gz', sha256: sha(await readFile(de10Archive)) };
    const legacyRoot = join(dir, 'LocalAppData', 'NexysVHDL');
    if (o.legacyNexys) await installToolchainArchive({ archive: nexysArchive, dataRoot: legacyRoot, target: 'win32-x64', requirement: made.requirement });

    const quartusRoot = join(dir, 'intelFPGA_lite', '25.1std');
    const env = await windowsEnv(t, { install: 'none' });
    const r = {
        dir, layout, sources, expected, nexysRequirement: made.requirement, nexysRoot: layout.nexysRoot, legacyRoot, payloadDir, nexysArchive, de10Archive, downloads,
        quartusRoot, quartusInstalled: o.quartusPresent, driver: true, free: 1e12, longPaths: true, hardware: DE10, digilent: true, spec, copied: [] as string[],
    } as Rig;
    r.makeQuartus = async () => {
        const bin = join(quartusRoot, 'quartus', 'bin64');
        await mkdir(bin, { recursive: true });
        for (const tool of WINDOWS_QUARTUS_SPEC.requiredTools) await writeFile(join(bin, `${tool}.exe`), 'MZ');
        await mkdir(join(quartusRoot, 'quartus', 'common', 'devinfo'), { recursive: true });
        r.quartusInstalled = true;
    };
    if (o.quartusPresent) await r.makeQuartus();
    r.ui = new ScriptedUi();
    r.ui.files = { installerPath: join(downloads, spec.installer.name), devicePackagePath: join(downloads, spec.devicePackage.name) };
    r.ui.nexysArchive = nexysArchive;
    r.helper = new FakeHelper({ quartusRoot, dir, makeQuartus: () => r.makeQuartus(), spec: () => r.spec });
    r.quartusRunner = new FakeQuartusRunner({ ...env, root: dir, quartusRoot, paths: { ...env.paths, quartusCandidates: [quartusRoot] } }, { parts: o.parts });
    r.runner = new RoutingRunner(() => r);
    const inner = new DirectoryPayload(sources, 'test payload');
    const devPayload = { kind: 'directory' as const, describe: () => inner.describe(), has: (u: ToolchainUnit) => inner.has(u), materialize: async (u: ToolchainUnit, dest: string, signal?: AbortSignal) => { r.copied.push(u.id); await inner.materialize(u, dest, signal); } };
    r.rebuild = (over = {}) => {
        const oo = { ...o, ...over };
        const paths = { ...installedWindowsDe10Paths(layout), quartusCandidates: [quartusRoot] };
        r.ctl = new WindowsSetupController({
            layout,
            expected,
            payload: oo.de10Archive ? undefined : devPayload,
            payloadDir,
            payloadPins: pins,
            nexys: { requirement: made.requirement, dataRoot: layout.nexysRoot, legacyRoots: oo.legacyNexys ? [legacyRoot] : [] },
            runner: r.runner,
            freeBytes: async () => r.free,
            hardware: async () => r.hardware,
            host: { platform: 'win32', arch: 'x64' },
            quartusSpec: spec,
            helper: r.helper,
            longPaths: async () => r.longPaths,
            engine: new NativeQuartusEngine(paths, r.runner),
            driverPresent: async () => r.driver,
            digilent: async () => r.digilent,
        });
    };
    r.rebuild();
    void win32;
    return r;
}

export const word = (v: { rows: readonly { id: string; word: string }[] }, id: string) => v.rows.find((x) => x.id === id)?.word;
export const boardWord = (v: { boards: readonly { id: string; word: string }[] }, id: string) => v.boards.find((x) => x.id === id)!.word;
