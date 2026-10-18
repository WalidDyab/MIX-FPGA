import { createHash } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { installToolchainArchive, NodeToolRunner, type ToolInvocation, type ToolRunResult, type ToolRunner, type ToolchainRequirement, writeTarGz } from '../../core';
import { copyTree } from '../../core/install/tree';
import type { BoardSupportId } from '../../platform/macos/install/boards';
import type { Downloader } from '../../platform/macos/install/download';
import type { RuntimeLayout } from '../../platform/macos/install/layout';
import { installedDe10Paths } from '../../platform/macos/install/paths';
import { QUARTUS_SPEC, type LicenseOffer, type QuartusSpec } from '../../platform/macos/install/quartus-install';
import type { RosettaConsent } from '../../platform/macos/install/rosetta';
import { SetupController, type InstallSummary, type SetupInteraction } from '../../platform/macos/install/setup-controller';
import type { HardwareView } from '../../platform/macos/install/setup-view';
import { SimulatedCrash } from '../../platform/macos/install/toolchain-installer';
import { fakeArchive, writeFakeBundle } from '../bundle-fixture';
import { FakeMachine } from './fake-machine';
import { type Fixture, fixture } from './fixtures';

export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const DE10: HardwareView = { state: 'ready', word: 'DE10-Lite' };

/** Answers every Setup question from fields the test sets, and records what was asked. */
export class ScriptedUi implements SetupInteraction {
    summaries: InstallSummary[] = [];
    questions: string[] = [];
    messages: string[] = [];
    logs: string[] = [];
    boards: BoardSupportId[] | undefined = ['de10-lite'];
    offeredBoards: { id: BoardSupportId; name: string; installed: boolean }[][] = [];
    confirm = true;
    rosetta: RosettaConsent | undefined = { method: 'apple-prompt' };
    files: { installerPath: string; devicePackagePath: string } | undefined;
    nexysArchive: string | undefined;
    /** What the student picks for the DE10-Lite support file (production flow); undefined = Cancel. */
    de10Archive: string | undefined;
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
    async askDe10Archive() {
        this.questions.push('de10-file');
        return this.de10Archive;
    }
    async confirmInstall(s: InstallSummary) {
        this.summaries.push(s);
        this.questions.push('confirm');
        return this.confirm;
    }
    async askRosettaConsent() {
        this.questions.push('rosetta');
        return this.rosetta;
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

/** limactl and the engine go to the fake machine; the real `cp -c` clone runs for real inside the test folder. */
class RoutingRunner implements ToolRunner {
    readonly copies: ToolInvocation[] = [];
    private readonly real = new NodeToolRunner();
    constructor(private readonly m: FakeMachine) {}
    run(inv: ToolInvocation): Promise<ToolRunResult> {
        if (inv.executable === '/bin/cp') {
            this.copies.push(inv);
            return this.real.run(inv);
        }
        return this.m.run(inv);
    }
}

export interface Rig {
    ctl: SetupController;
    f: Fixture;
    m: FakeMachine;
    runner: RoutingRunner;
    ui: ScriptedUi;
    layout: RuntimeLayout;
    downloads: string;
    free: number;
    hardware: HardwareView;
    crashToolchainOnce: boolean;
    nexysRequirement: ToolchainRequirement;
    nexysRoot: string;
    legacyRoot: string;
    payloadDir: string;
    nexysArchive: string;
    rebuild: (over?: Partial<RigOptions>) => void;
}

export interface RigOptions {
    /** A NexysVHDL 0.6.0 store with the validated Nexys toolchain exists (upgrade case). */
    readonly legacyNexys: boolean;
    /** The Nexys archive sits in the payload folder (pinned); otherwise the student is asked for it. */
    readonly pinnedNexys: boolean;
    /** The DE10 tools come from a pinned archive instead of the development folder. */
    readonly de10Archive: boolean;
    /** The DE10 support file is pinned (name, size, sha256) but NOT beside the extension, and there is no development payload: the student must pick it. */
    readonly de10Picked: boolean;
}

export async function rig(t: TestContext, opts: Partial<RigOptions> = {}): Promise<Rig> {
    const o: RigOptions = { legacyNexys: false, pinnedNexys: true, de10Archive: false, de10Picked: false, ...opts };
    const f = await fixture(t, {}, { realEngine: true, shortRoot: true });
    const downloads = join(f.dir, 'Downloads');
    await mkdir(downloads);
    const installer = Buffer.from('#!/bin/sh\nfake quartus installer'.repeat(40));
    const pkg = Buffer.from('fake max10 package'.repeat(60));
    const licenseBytes = Buffer.from('QUARTUS PRIME AND INTEL FPGA IP LICENSE AGREEMENT (test text)\n');
    await writeFile(join(downloads, QUARTUS_SPEC.installer.name), installer);
    await writeFile(join(downloads, QUARTUS_SPEC.devicePackage.name), pkg);
    const spec: QuartusSpec = { ...QUARTUS_SPEC, license: { ...QUARTUS_SPEC.license, sha256: sha(licenseBytes), bytes: licenseBytes.length }, installer: { name: QUARTUS_SPEC.installer.name, sha256: sha(installer), bytes: installer.length }, devicePackage: { name: QUARTUS_SPEC.devicePackage.name, sha256: sha(pkg), bytes: pkg.length } };

    // Nexys A7 support: a small stand-in for the NexysVHDL Toolchain 1.0 bundle, as an archive.
    const bundle = join(f.dir, 'nexys-bundle');
    await writeFakeBundle(bundle, { target: 'darwin-arm64', programmer: true });
    const made = await fakeArchive(f.dir, bundle, { target: 'darwin-arm64' });
    const payloadDir = join(f.dir, 'payloads');
    await mkdir(payloadDir);
    const nexysArchive = join(payloadDir, 'nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz');
    await cp(made.archive, nexysArchive);
    const pins: Record<string, { file: string; sha256: string; bytes?: number }> = {};
    if (o.pinnedNexys) pins['nexys-a7-100t'] = { file: 'nexysvhdl-toolchain-1.0-darwin-arm64.tar.gz', sha256: sha(await import('node:fs/promises').then((x) => x.readFile(nexysArchive))) };
    if (o.de10Archive) {
        const tree = join(f.dir, 'de10-tree');
        for (const u of f.ctx.expected.toolchain.units) await copyTree(f.sources[u.id]!, join(tree, u.path));
        await mkdir(tree, { recursive: true });
        await writeFile(join(tree, 'manifest.json'), f.ctx.expected.text);
        const de10 = join(payloadDir, 'mixfpga-de10-lite-support-1.0-macos-arm64.tar.gz');
        await writeTarGz(tree, de10);
        pins['de10-lite'] = { file: 'mixfpga-de10-lite-support-1.0-macos-arm64.tar.gz', sha256: sha(await import('node:fs/promises').then((x) => x.readFile(de10))) };
    }
    let course: string | undefined;
    if (o.de10Picked) {
        const tree = join(f.dir, 'de10-tree-picked');
        for (const u of f.ctx.expected.toolchain.units) await copyTree(f.sources[u.id]!, join(tree, u.path));
        await writeFile(join(tree, 'manifest.json'), f.ctx.expected.text);
        const dir = join(f.dir, 'course');
        await mkdir(dir);
        course = join(dir, 'mixfpga-de10-lite-support-1.0-macos-arm64.tar.gz');
        await writeTarGz(tree, course);
        const bytes = await import('node:fs/promises').then((x) => x.readFile(course!));
        pins['de10-lite'] = { file: 'mixfpga-de10-lite-support-1.0-macos-arm64.tar.gz', sha256: sha(bytes), bytes: bytes.length };
    }
    const legacyRoot = join(f.dir, 'old-home', 'Library', 'NexysVHDL');
    if (o.legacyNexys) await installToolchainArchive({ archive: nexysArchive, dataRoot: legacyRoot, target: 'darwin-arm64', requirement: made.requirement });

    const m = new FakeMachine(installedDe10Paths(f.ctx.layout).limactl, f.ctx.layout.shareDir);
    const runner = new RoutingRunner(m);
    const ui = new ScriptedUi();
    ui.files = { installerPath: join(downloads, spec.installer.name), devicePackagePath: join(downloads, spec.devicePackage.name) };
    ui.nexysArchive = nexysArchive;
    ui.de10Archive = course;
    const nexysRoot = join(f.ctx.layout.root, 'support', 'nexys-a7');
    const r = { f, m, runner, ui, downloads, free: 1e12, hardware: DE10, crashToolchainOnce: false, layout: f.ctx.layout, nexysRequirement: made.requirement, nexysRoot, legacyRoot, payloadDir, nexysArchive } as Rig;
    const downloader: Downloader = async () => ({ ok: true, reused: false });
    r.rebuild = (over = {}) => {
        const oo = { ...o, ...over };
        r.ctl = new SetupController({
            layout: f.ctx.layout,
            expected: f.ctx.expected,
            payload: oo.de10Archive || oo.de10Picked ? undefined : f.ctx.payload,
            payloadDir,
            payloadPins: pins,
            nexys: { requirement: made.requirement, dataRoot: nexysRoot, legacyRoots: oo.legacyNexys ? [legacyRoot] : [] },
            runner,
            downloader,
            freeBytes: async () => r.free,
            rosettaHost: m,
            runRosettaCommand: (c) => m.runRosetta(c),
            hardware: async () => r.hardware,
            host: { platform: 'darwin', arch: 'arm64' },
            quartusSpec: spec,
            toolchainHooks: { beforeActivate: () => { if (r.crashToolchainOnce) { r.crashToolchainOnce = false; throw new SimulatedCrash('power cut'); } } },
        });
    };
    r.rebuild();
    return r;
}

export const word = (v: { rows: readonly { id: string; word: string }[] }, id: string) => v.rows.find((x) => x.id === id)?.word;
export const boardWord = (v: { boards: readonly { id: string; word: string }[] }, id: string) => v.boards.find((x) => x.id === id)!.word;
