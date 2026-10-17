import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import type { ComponentDefinition, ComponentStatus, SetupStepResult } from '../../../core/install/model';
import type { ToolRunner } from '../../../core/process/tool-runner';
import { sha256File } from '../../../core/util/hash';
import { ACCEPT_STATEMENT, checkAlteraFile, isQuartusInput, type LicenseOffer, type QuartusFiles, QuartusRecordStore, type VendorSpec } from '../../shared/install/quartus-vendor';
import type { NativeQuartusEngine } from '../de10/native-quartus-engine';
import { findOtherQuartus, quartusTool } from '../de10/quartus-install';
import { ElevatedHelper, type HelperFailure, type HelperResponse } from './elevation';
import type { WindowsRuntimeLayout } from './layout';

/**
 * Altera Quartus Prime Lite and the MAX 10 device package are NOT MIX-FPGA's and are never redistributed. On Windows the student
 * downloads two files from Altera; MIX-FPGA verifies them, shows the licence Altera's own installer provides, and runs that
 * installer (after Windows' one permission prompt) only once the student has explicitly accepted it. An existing correct Quartus
 * is only verified, never reinstalled.
 */
export const WINDOWS_QUARTUS_SPEC = {
    version: '25.1std.0',
    build: 1129,
    banner: '25.1std.0 Build 1129',
    device: '10M50DAF484C7G',
    family: 'MAX 10',
    installer: { name: 'QuartusLiteSetup-25.1std.0.1129-windows.exe', sha256: '97a82c195ee1a42799cd2b376446500e1ebd305bf55b5b1fb845baf7e65c24cc', bytes: 1_752_505_168 },
    devicePackage: { name: 'max10-25.1std.0.1129.qdz', sha256: '8057844b0b91c2ba7ef2b37b1986d198ec4f1831cc9be0a52d18e5feb4c19ce9', bytes: 302_078_437 },
    product: 'Quartus Prime Lite Edition',
    /**
     * The licence the installer itself provides (`--install_lic`). The Windows installer writes the same text as the macOS one with
     * Windows line endings; `sha256` is the hash of the text with line endings normalised to LF (equal to the macOS licence hash),
     * `rawSha256` the hash of the file exactly as the installer writes it (57,560 bytes, measured in Phase 4C from the installed copy).
     */
    license: {
        source: 'the installer\'s own --install_lic output',
        file: 'licenses/license.txt',
        title: 'QUARTUS PRIME AND INTEL FPGA IP LICENSE AGREEMENT, VERSION 25.1std',
        installerName: 'Altera End User License Agreement',
        sha256: '0b1173f88d318001f865ae71d8fb46ad3cb08fc36598fff52325d1f10ddc62ab',
        bytes: 56500,
        rawSha256: '3cf19164cfc099dfecdd98c07f5a7e2a50241fdc99c9c00205afa3925496b63b',
        rawBytes: 57560,
        references: [{ label: 'Altera: Quartus Prime software licensing questions and answers', url: 'https://www.altera.com/support/support-resources/licensing/q-and-a' }],
    },
    installDir: 'C:\\intelFPGA_lite\\25.1std',
    /** Only quartus, devinfo and max10 are installed (Phase 1 and 3). */
    disabledComponents: 'quartus_help,arria_lite,cyclone,cyclone10lp,cyclonev,max,quartus_update,riscfree,questa_fse,questa_fe',
    requiredTools: ['quartus_sh', 'quartus_map', 'quartus_fit', 'quartus_asm', 'quartus_sta', 'quartus_cpf', 'quartus_pgm'],
    /** Free space to ask for: temporary copies (2.1 GB) plus the installation (8.8 GB) with margin. */
    requiredFreeGB: 13,
} as const;

type FileSpec = { name: string; sha256: string; bytes: number };
export type WindowsQuartusSpec = Omit<typeof WINDOWS_QUARTUS_SPEC, 'installer' | 'devicePackage' | 'license'> & {
    installer: FileSpec;
    devicePackage: FileSpec;
    license: { source: string; file: string; title: string; installerName: string; sha256: string; bytes: number; rawSha256: string; rawBytes: number; references: readonly { label: string; url: string }[] };
};

const vendor = (s: WindowsQuartusSpec): VendorSpec => s;

type Failure = { readonly ok: false; readonly code: string; readonly message: string };
const fail = (code: string, message: string): Failure => ({ ok: false, code, message });
const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`;

/** Result of the proof that Quartus really works. */
export interface QuartusVerification {
    readonly ok: boolean;
    readonly code?: string;
    readonly message?: string;
    readonly version?: string;
}

const SMOKE_QSF = (device: string) => `set_global_assignment -name TOP_LEVEL_ENTITY smoke\nset_global_assignment -name VHDL_FILE smoke.vhd\nset_global_assignment -name FAMILY "MAX 10"\nset_global_assignment -name DEVICE ${device}\nset_location_assignment PIN_P11 -to clk\nset_location_assignment PIN_A8 -to led\nset_global_assignment -name RESERVE_ALL_UNUSED_PINS_WEAK_PULLUP "AS INPUT TRI-STATED WITH WEAK PULL-UP"\n`;
const SMOKE_VHD = 'library ieee;\nuse ieee.std_logic_1164.all;\nuse ieee.numeric_std.all;\nentity smoke is port (clk : in std_logic; led : out std_logic); end entity;\narchitecture rtl of smoke is signal c : unsigned(25 downto 0) := (others => \'0\'); begin\n process (clk) begin if rising_edge(clk) then c <= c + 1; end if; end process;\n led <= c(25);\nend architecture;\n';

/**
 * Proves that the installed Quartus is exactly Build 1129, that every command-line tool exists, that the MAX 10 package and the
 * exact part are there (asked of Quartus itself), and that a tiny design really goes through synthesis, fitting and assembly for
 * the DE10-Lite's device. Never starts the Quartus GUI. `scratch` is a private folder the test design is built in, then removed.
 */
export async function verifyQuartus(engine: NativeQuartusEngine, scratchRoot: string, spec: WindowsQuartusSpec = WINDOWS_QUARTUS_SPEC, signal?: AbortSignal, opts: { smoke?: boolean } = {}): Promise<QuartusVerification> {
    const i = await engine.install();
    if (!i) return { ok: false, code: 'QUARTUS_NOT_FOUND', message: `Quartus Prime Lite ${spec.banner} was not found on this computer.` };
    const probe = await engine.probe(i, signal);
    if (probe.kind === 'wrong-version') return { ok: false, code: 'VERSION_MISMATCH', message: probe.detail, ...(probe.version ? { version: probe.version } : {}) };
    if (probe.kind !== 'ok') return { ok: false, code: 'QUARTUS_NOT_RUNNING', message: `Quartus does not start: ${probe.detail}` };
    const version = probe.version;
    const missing: string[] = [];
    for (const t of spec.requiredTools) if (!(await stat(quartusTool(i, t)).then((s) => s.isFile(), () => false))) missing.push(t);
    if (missing.length > 0) return { ok: false, code: 'TOOLS_MISSING', message: `Quartus is missing command-line tools: ${missing.join(', ')}.`, ...(version ? { version } : {}) };
    const part = await engine.checkPart(i, signal);
    if (part.kind === 'max10-missing') return { ok: false, code: 'MAX10_MISSING', message: 'The MAX 10 device support is not installed in Quartus.', ...(version ? { version } : {}) };
    if (part.kind === 'part-missing') return { ok: false, code: 'DEVICE_MISSING', message: `Quartus does not know the DE10-Lite's device ${spec.device}.`, ...(version ? { version } : {}) };
    if (part.kind !== 'ok') return { ok: false, code: 'PART_CHECK_FAILED', message: 'Quartus could not be asked which devices it supports.', ...(version ? { version } : {}) };
    if (opts.smoke === false) return { ok: true, ...(version ? { version } : {}) };

    // Smoke test: a private scratch project, removed afterwards.
    const work = join(scratchRoot, `verify-${createHash('sha1').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 8)}`);
    try {
        await mkdir(work, { recursive: true });
        await writeFile(join(work, 'smoke.vhd'), SMOKE_VHD);
        await writeFile(join(work, 'smoke.qsf'), SMOKE_QSF(spec.device));
        await writeFile(join(work, 'smoke.qpf'), 'PROJECT_REVISION = "smoke"\n');
        for (const [tool, args] of [['quartus_map', ['smoke', '--read_settings_files=on']], ['quartus_fit', ['smoke']], ['quartus_asm', ['smoke']]] as const) {
            const r = await engine.run(i, tool, [...args], { cwd: work, ...(signal ? { signal } : {}), timeoutMs: 900_000 });
            if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: 'Verification was cancelled.' };
            if (r.outcome !== 'exited' || r.exitCode !== 0 || !/was successful/.test(`${r.stdout}${r.stderr}`)) return { ok: false, code: 'SMOKE_TEST_FAILED', message: `A test design did not go through ${tool} for ${spec.device}.`, ...(version ? { version } : {}) };
        }
        return { ok: true, ...(version ? { version } : {}) };
    } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
}

export interface WindowsQuartusDeps {
    readonly layout: WindowsRuntimeLayout;
    readonly runner: ToolRunner;
    readonly engine: NativeQuartusEngine;
    readonly freeBytes: (path: string) => Promise<number>;
    readonly spec?: WindowsQuartusSpec;
    /** Test seam: the elevated helper (default: the real one, which shows Windows' permission prompt). */
    readonly helper?: ElevatedHelper;
    readonly parentPid?: number;
    readonly now?: () => Date;
}

/** Installs and verifies Quartus on Windows. One instance per Setup run; call `dispose()` when it is over. */
export class WindowsQuartusSetup {
    private readonly spec: WindowsQuartusSpec;
    readonly record: QuartusRecordStore;
    private helperInstance: ElevatedHelper | undefined;

    constructor(private readonly deps: WindowsQuartusDeps) {
        this.spec = deps.spec ?? WINDOWS_QUARTUS_SPEC;
        this.record = new QuartusRecordStore(win32.join(deps.layout.stateDir, 'quartus.json'));
        this.helperInstance = deps.helper;
    }

    private helper(): ElevatedHelper {
        this.helperInstance ??= new ElevatedHelper({
            runner: this.deps.runner,
            dir: this.deps.layout.helperDir,
            ...(this.deps.parentPid !== undefined ? { parentPid: this.deps.parentPid } : {}),
            params: {
                installers: this.deps.layout.installersDir,
                installerName: this.spec.installer.name,
                installerSha256: this.spec.installer.sha256,
                packageName: this.spec.devicePackage.name,
                packageSha256: this.spec.devicePackage.sha256,
                installDir: this.spec.installDir,
                disabledComponents: this.spec.disabledComponents,
                licenseSha256: this.spec.license.rawSha256,
            },
        });
        return this.helperInstance;
    }

    /** `quartus` and `max10`, from what Quartus itself answers (version, then the device list). */
    definitions(): ComponentDefinition[] {
        const engine = this.deps.engine;
        return [
            {
                id: 'quartus',
                label: 'Quartus Prime Lite',
                async inspect() {
                    const i = await engine.install();
                    if (!i) {
                        const others = await findOtherQuartus(engine.candidateRoots());
                        return { state: 'not-installed', ownership: 'external', ...(others.length > 0 ? { code: 'OTHER_VERSION', detail: `another Quartus is installed (${others.map((o) => o.root).join(', ')}); MIX-FPGA needs ${WINDOWS_QUARTUS_SPEC.banner} and leaves it alone` } : {}) };
                    }
                    const p = await engine.probe(i);
                    if (p.kind === 'wrong-version') return { state: 'incompatible', ownership: 'external', code: 'WRONG_VERSION', detail: p.detail, ...(p.version ? { version: p.version } : {}) };
                    if (p.kind !== 'ok') return { state: 'repairable', ownership: 'external', code: 'QUARTUS_NOT_RUNNING', detail: p.detail };
                    const missing = [];
                    for (const t of WINDOWS_QUARTUS_SPEC.requiredTools) if (!(await stat(quartusTool(i, t)).then((s) => s.isFile(), () => false))) missing.push(t);
                    if (missing.length > 0) return { state: 'incompatible', ownership: 'external', code: 'TOOLS_MISSING', detail: `Quartus is missing command-line tools: ${missing.join(', ')}`, ...(p.version ? { version: p.version } : {}) };
                    return { state: 'ready', ownership: 'external', ...(p.version ? { version: p.version } : {}) };
                },
                // `max10` is not covered: Altera's package is only ever observed, never patched by MIX-FPGA; it simply becomes Ready (or not) once Quartus is.
                install: { requires: ['toolchain'], userInput: 'files', run: (request) => this.install(request) },
            },
            {
                id: 'max10',
                label: 'MAX 10 support',
                inspectAfter: ['quartus'],
                async inspect(deps: ReadonlyMap<string, ComponentStatus>) {
                    const q = deps.get('quartus');
                    if (!q || q.state === 'not-installed') return { state: 'not-installed', ownership: 'external', code: 'NEEDS_QUARTUS' };
                    if (q.state !== 'ready') return { state: 'incompatible', ownership: 'external', code: 'NEEDS_QUARTUS', detail: 'Quartus itself is not usable' };
                    const i = await engine.install();
                    if (!i) return { state: 'not-installed', ownership: 'external' };
                    // The question is asked with MIX-FPGA's own support script, which arrives with the toolchain.
                    if (!(await stat(engine.partCheckScript).then((s) => s.isFile(), () => false))) return { state: 'not-installed', ownership: 'external', code: 'NEEDS_TOOLCHAIN', detail: 'waiting for the MIX-FPGA tools' };
                    const part = await engine.checkPart(i);
                    if (part.kind === 'ok') return { state: 'ready', ownership: 'external', version: WINDOWS_QUARTUS_SPEC.device };
                    // The package belongs to Altera's installation; MIX-FPGA does not patch someone else's Quartus.
                    return { state: 'incompatible', ownership: 'external', code: part.kind === 'max10-missing' ? 'MAX10_MISSING' : part.kind === 'part-missing' ? 'DEVICE_MISSING' : 'PART_CHECK_FAILED', detail: part.kind === 'max10-missing' ? 'The MAX 10 device support is not installed in this Quartus.' : part.kind === 'part-missing' ? `Quartus does not list ${WINDOWS_QUARTUS_SPEC.device}.` : 'Quartus could not be asked which devices it supports.' };
                },
            },
        ];
    }

    /** Removes only the two temporary copies MIX-FPGA made. The student's downloads are never touched. */
    async removeInstallerCopies(): Promise<void> {
        for (const f of [this.spec.installer.name, this.spec.devicePackage.name]) {
            await rm(win32.join(this.deps.layout.installersDir, f), { force: true });
            await rm(win32.join(this.deps.layout.installersDir, `${f}.part`), { force: true });
        }
    }

    private async copyVerified(src: string, name: string, sha256: string): Promise<void> {
        const dest = win32.join(this.deps.layout.installersDir, name);
        if ((await stat(dest).then((s) => s.isFile(), () => false)) && (await sha256File(dest)) === sha256) return;
        const part = `${dest}.part`;
        await rm(part, { force: true });
        await copyFile(src, part);
        if ((await sha256File(part)) !== sha256) {
            await rm(part, { force: true });
            throw new Error(`The copy of ${name} did not match the original (is the disk damaged?).`);
        }
        await rename(part, dest);
    }

    /** Checks the student's two files, then makes the verified temporary copies the installer will use. Reads the downloads; never changes them. */
    private async stageFiles(files: QuartusFiles, say: (m: string) => void): Promise<Failure | undefined> {
        const { layout } = this.deps;
        say('Checking the downloaded files…');
        for (const [path, want] of [[files.installerPath, 'installer'], [files.devicePackagePath, 'devicePackage']] as const) {
            const c = await checkAlteraFile(path, want, vendor(this.spec));
            if (!c.ok) return fail(c.code, c.message);
        }
        const free = await this.deps.freeBytes(layout.root);
        if (free < this.spec.requiredFreeGB * 1e9) return fail('INSUFFICIENT_DISK', `Installing Quartus needs about ${this.spec.requiredFreeGB} GB free; only ${gb(free)} is available.`);
        say('Preparing the installation files…');
        await mkdir(layout.installersDir, { recursive: true });
        try {
            await this.copyVerified(files.installerPath, this.spec.installer.name, this.spec.installer.sha256);
            await this.copyVerified(files.devicePackagePath, this.spec.devicePackage.name, this.spec.devicePackage.sha256);
        } catch (err) {
            return fail('COPY_FAILED', err instanceof Error ? err.message : String(err));
        }
        return undefined;
    }

    private elevationFailure(f: HelperFailure): Failure {
        return fail(f.code, f.message);
    }

    /**
     * Step 1 of the guided install: the student's files are checked and copied, Windows' permission prompt appears once, and the
     * installer is asked for its own licence files (which installs nothing). The result is the vendor's licence text, with its hash.
     * If the text is not the one established for this exact build, nothing is offered: stop rather than guess.
     */
    async prepareLicense(files: QuartusFiles, signal?: AbortSignal, onProgress?: (m: string) => void): Promise<{ ok: true; offer: LicenseOffer } | Failure> {
        const say = onProgress ?? (() => undefined);
        const staged = await this.stageFiles(files, say);
        if (staged) return staged;
        say('Windows will ask for permission to install…');
        const h = this.helper();
        const started = await h.start(signal);
        if (!started.ok) return this.elevationFailure(started);
        say('Reading the licence from the installer…');
        const r = await h.request('license', 240_000, signal);
        if (!('exitCode' in r)) return this.elevationFailure(r);
        if (signal?.aborted) return fail('CANCELLED', 'Cancelled.');
        if (!r.ok) return fail('LICENSE_NOT_AVAILABLE', 'The installer did not provide its licence text. Nothing was installed. Try again, or download the installer again from Altera.');
        const raw = await readFile(h.licenseFile).catch(() => undefined);
        if (!raw) return fail('LICENSE_NOT_AVAILABLE', 'The licence text could not be read.');
        // The vendor's text exactly as written is hashed (Windows line endings); the pinned LF form is the same text.
        const rawHash = createHash('sha256').update(raw).digest('hex');
        const text = raw.toString('utf8').replace(/\r\n/g, '\n');
        const lfHash = createHash('sha256').update(text).digest('hex');
        if (rawHash !== this.spec.license.rawSha256 || lfHash !== this.spec.license.sha256) {
            return fail('LICENSE_UNVERIFIED', `The licence provided by this installer is not the one MIX-FPGA verified for Quartus ${this.spec.banner}, so it cannot be offered for acceptance. Nothing was installed.`);
        }
        await mkdir(this.deps.layout.stateDir, { recursive: true });
        await writeFile(win32.join(this.deps.layout.stateDir, 'quartus-license.txt'), raw);
        await this.record.merge({ licenseOffered: { sha256: lfHash, installerSha256: this.spec.installer.sha256, offeredAt: (this.deps.now ?? (() => new Date()))().toISOString() } });
        return {
            ok: true,
            offer: { product: this.spec.product, version: this.spec.banner, title: this.spec.license.title, text, sha256: lfHash, bytes: Buffer.byteLength(text), source: this.spec.license.source, installerSha256: this.spec.installer.sha256, references: this.spec.license.references, statement: ACCEPT_STATEMENT },
        };
    }

    /** The student turned the licence down, or Setup was stopped: the helper ends and the temporary copies go. Nothing was installed. */
    async abandon(): Promise<void> {
        await this.helperInstance?.stop().catch(() => undefined);
        await this.removeInstallerCopies().catch(() => undefined);
    }

    async install(request: { input?: unknown; signal?: AbortSignal; progress: (p: { message: string; fraction?: number }) => void }): Promise<SetupStepResult> {
        const signal = request.signal;
        const say = (message: string) => request.progress({ message });
        const input = request.input;
        if (!isQuartusInput(input, vendor(this.spec))) return fail('INPUT_REQUIRED', 'Choose the two files you downloaded from Altera, read the licence, and tick the box to accept it.');

        // The acceptance only counts for the licence that this computer's installer actually produced and offered.
        const rec = await this.record.read();
        if (rec.licenseOffered?.sha256 !== input.eula.licenseSha256 || rec.licenseOffered.installerSha256 !== input.eula.installerSha256) {
            return fail('LICENSE_NOT_SHOWN', 'The licence has not been shown to you on this computer yet. Open the licence first, then accept it.');
        }
        try {
            const staged = await this.stageFiles(input, say);
            if (staged) return staged;
            // The acceptance is written down before the installer may be told to accept anything.
            await this.record.merge({ eula: input.eula });

            // Never install over a working Quartus: if exactly this build already answers, it is only verified.
            const existing = await this.deps.engine.install();
            const alreadyThere = existing ? (await this.deps.engine.probe(existing, signal)).kind === 'ok' : false;
            if (!alreadyThere) {
                const h = this.helper();
                const started = await h.start(signal);
                if (!started.ok) return this.elevationFailure(started);
                await h.recordAcceptance({ licenseSha256: this.spec.license.rawSha256, installerSha256: this.spec.installer.sha256, acceptedAt: input.eula.acceptedAt });
                await this.record.merge({ installAttemptAt: (this.deps.now ?? (() => new Date()))().toISOString() });
                say('Installing Quartus…');
                const r = await h.request('install', 2_700_000, signal);
                if (!('exitCode' in r)) return this.elevationFailure(r);
                if (signal?.aborted) return fail('CANCELLED', 'Installation was cancelled.');
                if (!r.ok) return fail('QUARTUS_INSTALL_FAILED', `The Quartus installer did not finish (${(r as HelperResponse).message}).`);
                await this.record.merge({ installedAt: (this.deps.now ?? (() => new Date()))().toISOString() });
            }

            say('Verifying installation…');
            const v = await verifyQuartus(this.deps.engine, this.deps.layout.stagingDir, this.spec, signal);
            if (!v.ok) return fail(v.code ?? 'VERIFY_FAILED', v.message ?? 'Quartus did not pass its check.');
            await this.record.merge({ verifiedAt: (this.deps.now ?? (() => new Date()))().toISOString(), ...(v.version ? { version: v.version } : {}), device: this.spec.device });
            await this.removeInstallerCopies();
            return { ok: true, detail: alreadyThere ? 'already installed; verified' : 'installed and verified' };
        } finally {
            // Administrator rights end here: everything after this runs as the student.
            await this.helperInstance?.stop().catch(() => undefined);
        }
    }
}
