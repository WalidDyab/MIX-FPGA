import { createHash } from 'node:crypto';
import { copyFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComponentDefinition, ComponentStatus, SetupStepResult } from '../../../core/install/model';
import type { ToolRunResult, ToolRunner } from '../../../core/process/tool-runner';
import { writeFileAtomic } from '../../../core/util/atomic-write';
import { sha256File } from '../../../core/util/hash';
import { LimaEngine } from '../de10/engine';
import { LIMA_INSTANCE, type RuntimeLayout } from './layout';
import { installedDe10Paths } from './paths';
import { LinuxVmRecordStore } from './engine-provision';

/**
 * Altera Quartus Prime Lite and the MAX 10 device package are NOT MIX-FPGA's and are never redistributed.
 * The student downloads them from Altera; MIX-FPGA verifies the two files, shows Altera's licence requirement,
 * and installs them into the student's own engine only after the student explicitly accepts it.
 */
export const QUARTUS_SPEC = {
    version: '25.1std.0',
    build: 1129,
    banner: '25.1std.0 Build 1129',
    device: '10M50DAF484C7G',
    family: 'MAX 10',
    installer: { name: 'QuartusLiteSetup-25.1std.0.1129-linux.run', sha256: '518433ec7dcd61725560af653353f7a5c320cce9e528b22747b8a8df3674c4eb', bytes: 1_982_715_698 },
    devicePackage: { name: 'max10-25.1std.0.1129.qdz', sha256: '8057844b0b91c2ba7ef2b37b1986d198ec4f1831cc9be0a52d18e5feb4c19ce9', bytes: 302_078_437 },
    product: 'Quartus Prime Lite Edition',
    /**
     * The licence the installer itself presents. Established read-only in Phase 4 from the exact installer:
     * `--install_lic <dir>` (documented in its --help) writes licenses/license.txt, byte-identical to the text its own
     * wizard shows and to the file it installs. The student is shown that file, never a paraphrase.
     */
    license: {
        source: 'the installer\'s own --install_lic output',
        file: 'licenses/license.txt',
        title: 'QUARTUS PRIME AND INTEL FPGA IP LICENSE AGREEMENT, VERSION 25.1std',
        /** What the installer calls it when it refuses to run without acceptance. */
        installerName: 'Altera End User License Agreement',
        sha256: '0b1173f88d318001f865ae71d8fb46ad3cb08fc36598fff52325d1f10ddc62ab',
        bytes: 56500,
        /** Official Altera pages for reference only (found on altera.com; the exact agreement URL for this build could not be confirmed). */
        references: [{ label: 'Altera: Quartus Prime software licensing questions and answers', url: 'https://www.altera.com/support/support-resources/licensing/q-and-a' }],
    },
    guestInstallDir: '/opt/mixfpga/quartus/25.1std',
    /** Only quartus, devinfo and max10 are installed (Phase 1). */
    disabledComponents: 'quartus_help,arria_lite,cyclone,cyclone10lp,cyclonev,max,quartus_update,riscfree,questa_fse,questa_fe',
    requiredTools: ['quartus_sh', 'quartus_map', 'quartus_fit', 'quartus_asm', 'quartus_sta', 'quartus_cpf'],
    /** Free space to ask for: temporary copies (2.3 GB) plus the installation (about 9.5 GB inside the engine) with margin. */
    requiredFreeGB: 14,
} as const;

/** The words next to the checkbox. Exact; the acceptance is only valid with this text. */
export const ACCEPT_STATEMENT = 'I have reviewed and accept the Altera Quartus Prime Software License Agreement.';

type FileSpec = { name: string; sha256: string; bytes: number };
export type QuartusSpec = Omit<typeof QUARTUS_SPEC, 'installer' | 'devicePackage' | 'license'> & { installer: FileSpec; devicePackage: FileSpec; license: { source: string; file: string; title: string; installerName: string; sha256: string; bytes: number; references: readonly { label: string; url: string }[] } };

/** What the student was shown, from the vendor's own file. */
export interface LicenseOffer {
    readonly product: string;
    readonly version: string;
    readonly title: string;
    /** The vendor's licence text, unchanged. */
    readonly text: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly source: string;
    readonly installerSha256: string;
    readonly references: readonly { label: string; url: string }[];
    /** The exact words next to the checkbox. */
    readonly statement: string;
}

/**
 * The student's explicit acceptance. It is only valid for the licence that was actually shown on this Mac
 * (same hash), for this installer, with the exact checkbox wording.
 */
export interface EulaAcceptance {
    readonly accepted: true;
    readonly acceptedAt: string;
    readonly statement: string;
    readonly product: string;
    readonly version: string;
    readonly installerSha256: string;
    readonly licenseSource: string;
    readonly licenseSha256: string;
    readonly referenceUrls: readonly string[];
}

/** Built by the Setup page when the student ticks the box and continues. */
export function acceptanceFor(offer: LicenseOffer, now: Date = new Date()): EulaAcceptance {
    return { accepted: true, acceptedAt: now.toISOString(), statement: offer.statement, product: offer.product, version: offer.version, installerSha256: offer.installerSha256, licenseSource: offer.source, licenseSha256: offer.sha256, referenceUrls: offer.references.map((r) => r.url) };
}

/** What the Setup page collects: the two files the student downloaded, and (after the licence was shown) their acceptance. */
export interface QuartusFiles {
    readonly installerPath: string;
    readonly devicePackagePath: string;
}

export interface QuartusInput extends QuartusFiles {
    readonly eula: EulaAcceptance;
}

export function isQuartusInput(x: unknown, spec: QuartusSpec = QUARTUS_SPEC): x is QuartusInput {
    const i = x as Partial<QuartusInput> | null;
    if (typeof i !== 'object' || i === null || typeof i.installerPath !== 'string' || typeof i.devicePackagePath !== 'string' || typeof i.eula !== 'object' || i.eula === null) return false;
    const e = i.eula;
    return (
        e.accepted === true &&
        typeof e.acceptedAt === 'string' &&
        e.statement === ACCEPT_STATEMENT &&
        e.product === spec.product &&
        e.version === spec.banner &&
        e.installerSha256 === spec.installer.sha256 &&
        e.licenseSha256 === spec.license.sha256 &&
        typeof e.licenseSource === 'string' &&
        e.licenseSource.length > 0 &&
        Array.isArray(e.referenceUrls)
    );
}

export interface QuartusRecord {
    readonly schemaVersion: 1;
    /** The licence text was produced by the vendor installer on this Mac and offered to the student. */
    readonly licenseOffered?: { readonly sha256: string; readonly installerSha256: string; readonly offeredAt: string };
    readonly eula?: EulaAcceptance;
    readonly installAttemptAt?: string;
    readonly installedAt?: string;
    readonly verifiedAt?: string;
    readonly version?: string;
    readonly device?: string;
    /** Found already installed and verified; MIX-FPGA did not install it and holds no acceptance record for it. */
    readonly adoptedAt?: string;
    readonly adoptedFrom?: string;
}

export class QuartusRecordStore {
    constructor(private readonly file: string) {}
    async read(): Promise<QuartusRecord> {
        try {
            const r = JSON.parse(await readFile(this.file, 'utf8')) as QuartusRecord;
            return r.schemaVersion === 1 ? r : { schemaVersion: 1 };
        } catch {
            return { schemaVersion: 1 };
        }
    }
    async merge(patch: Partial<QuartusRecord>): Promise<void> {
        await mkdir(join(this.file, '..'), { recursive: true });
        await writeFileAtomic(this.file, `${JSON.stringify({ ...(await this.read()), ...patch }, null, 2)}\n`);
    }
}

export interface QuartusDeps {
    readonly layout: RuntimeLayout;
    readonly runner: ToolRunner;
    readonly freeBytes: (path: string) => Promise<number>;
    readonly spec?: QuartusSpec;
    /** Test seam: called at named points; throwing simulates a crash. */
    readonly hook?: (point: 'before-install' | 'after-install') => void | Promise<void>;
}

const OK = (r: ToolRunResult): boolean => r.outcome === 'exited' && r.exitCode === 0;
type Failure = { readonly ok: false; readonly code: string; readonly message: string };
const fail = (code: string, message: string): Failure => ({ ok: false, code, message });
const tail = (r: ToolRunResult): string => `${r.stderr || r.stdout}`.trim().split('\n').slice(-2).join(' ').slice(0, 240);
const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`;

export type FileCheck = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Is this the file Altera publishes? The name alone is never trusted: size and sha256 must match.
 * Reads the file; never modifies it.
 */
export async function checkAlteraFile(path: string, want: 'installer' | 'devicePackage', spec: QuartusSpec = QUARTUS_SPEC): Promise<FileCheck> {
    const exp = spec[want];
    const other = spec[want === 'installer' ? 'devicePackage' : 'installer'];
    const s = await stat(path).catch(() => undefined);
    if (!s?.isFile()) return { ok: false, code: 'FILE_NOT_FOUND', message: `${path} was not found.` };
    const label = want === 'installer' ? 'the Quartus installer' : 'the MAX 10 device package';
    const looksRight = path.endsWith(exp.name) || path.split('/').pop() === exp.name;
    if (s.size !== exp.bytes) {
        if (s.size === other.bytes) return { ok: false, code: 'FILES_SWAPPED', message: `This looks like ${want === 'installer' ? 'the MAX 10 device package' : 'the Quartus installer'}; ${label} (${exp.name}) is needed here.` };
        return { ok: false, code: looksRight ? 'FILE_DIFFERENT_VERSION' : 'WRONG_FILE', message: looksRight ? `${exp.name} has an unexpected size (${s.size} bytes); it may be incomplete or a different version. Download ${exp.name} again from Altera.` : `This is not ${label}. MIX-FPGA needs ${exp.name} from Altera.` };
    }
    if ((await sha256File(path)) !== exp.sha256) return { ok: false, code: 'FILE_HASH_MISMATCH', message: `${exp.name} does not match the version MIX-FPGA supports (Quartus ${QUARTUS_SPEC.banner}). Download it again from Altera.` };
    return { ok: true };
}

/** Result of the proof that Quartus really works. */
export interface QuartusVerification {
    readonly ok: boolean;
    readonly code?: string;
    readonly message?: string;
    readonly version?: string;
}

const SMOKE_QSF = (device: string) => `set_global_assignment -name TOP_LEVEL_ENTITY smoke\nset_global_assignment -name VHDL_FILE smoke.vhd\nset_global_assignment -name FAMILY "MAX 10"\nset_global_assignment -name DEVICE ${device}\nset_location_assignment PIN_P11 -to clk\nset_location_assignment PIN_A8 -to led\nset_global_assignment -name RESERVE_ALL_UNUSED_PINS_WEAK_PULLUP "AS INPUT TRI-STATED WITH WEAK PULL-UP"\n`;
const SMOKE_VHD = 'library ieee;\nuse ieee.std_logic_1164.all;\nuse ieee.numeric_std.all;\nentity smoke is port (clk : in std_logic; led : out std_logic); end entity;\narchitecture rtl of smoke is signal c : unsigned(25 downto 0) := (others => \'0\'); begin\n process (clk) begin if rising_edge(clk) then c <= c + 1; end if; end process;\n led <= c(25);\nend architecture;\n';
const DEVICE_TCL = (device: string, family: string) => `load_package device\nputs "MIXFPGA_FAMILY=[expr {[lsearch -exact [get_family_list] {${family}}] >= 0}]"\nputs "MIXFPGA_DEVICE=[expr {[lsearch -exact [get_part_list] {${device}}] >= 0}]"\n`;

/**
 * Proves, inside the running engine, that the installed Quartus is exactly Build 1129, that the MAX 10 package and
 * the device are present, that every command-line tool exists, and that a tiny design really goes through
 * synthesis, fitting and assembly for the DE10-Lite's device. Never starts the Quartus GUI. The engine must be running.
 */
export async function verifyQuartus(engine: LimaEngine, _shareDir: string, spec: QuartusSpec = QUARTUS_SPEC, signal?: AbortSignal): Promise<QuartusVerification> {
    const g = (script: string, timeoutMs: number) => engine.guest(script, { ...(signal ? { signal } : {}), timeoutMs });
    const ver = await g('mixfpga-q quartus_sh --version', 120_000);
    const text = `${ver.stdout}\n${ver.stderr}`;
    if (!OK(ver)) return { ok: false, code: 'QUARTUS_NOT_RUNNING', message: `Quartus does not start in the engine: ${tail(ver)}` };
    const version = /Version (\S+ Build \d+)/.exec(text)?.[1];
    if (!text.includes(spec.banner)) return { ok: false, code: 'VERSION_MISMATCH', message: `Quartus ${version ?? 'of unknown version'} is installed; MIX-FPGA needs ${spec.banner}.`, ...(version ? { version } : {}) };
    const tools = await g(`for t in ${spec.requiredTools.join(' ')}; do test -x ${spec.guestInstallDir}/quartus/bin/$t || echo MISSING_$t; done`, 30_000);
    const missing = [...tools.stdout.matchAll(/MISSING_(\w+)/g)].map((m) => m[1]);
    if (missing.length > 0) return { ok: false, code: 'TOOLS_MISSING', message: `Quartus is missing command-line tools: ${missing.join(', ')}.`, ...(version ? { version } : {}) };

    // The device check runs from a private scratch file inside the engine; nothing is written to the shared staging folder.
    const dev = await g(`t=$HOME/.mixfpga-verify-device.tcl; printf '%s' ${shq(DEVICE_TCL(spec.device, spec.family))} > $t; mixfpga-q quartus_sh -t $t; rc=$?; rm -f $t; exit $rc`, 180_000);
    const devText = `${dev.stdout}\n${dev.stderr}`;
    if (!/MIXFPGA_FAMILY=1/.test(devText)) return { ok: false, code: 'MAX10_MISSING', message: `The MAX 10 device support is not installed in Quartus.`, ...(version ? { version } : {}) };
    if (!/MIXFPGA_DEVICE=1/.test(devText)) return { ok: false, code: 'DEVICE_MISSING', message: `Quartus does not know the DE10-Lite's device ${spec.device}.`, ...(version ? { version } : {}) };

    // Smoke test: a private scratch project inside the engine, removed afterwards.
    const w = '$HOME/.mixfpga-smoke';
    const files = `mkdir -p ${w} && cd ${w} && printf '%s' ${shq(SMOKE_VHD)} > smoke.vhd && printf '%s' ${shq(SMOKE_QSF(spec.device))} > smoke.qsf && printf 'PROJECT_REVISION = "smoke"\\n' > smoke.qpf`;
    const run = `${files} && mixfpga-q quartus_map smoke --read_settings_files=on && mixfpga-q quartus_fit smoke && mixfpga-q quartus_asm smoke && echo MIXFPGA_SMOKE_OK; rc=$?; rm -rf ${w}; exit $rc`;
    const smoke = await g(run, 900_000);
    if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: 'Verification was cancelled.' };
    if (!OK(smoke) || !smoke.stdout.includes('MIXFPGA_SMOKE_OK')) return { ok: false, code: 'SMOKE_TEST_FAILED', message: `A test design did not go through Quartus for ${spec.device}: ${tail(smoke)}`, ...(version ? { version } : {}) };
    return { ok: true, ...(version ? { version } : {}) };
}

function shq(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The unattended install command, run inside the engine. `--accept_eula 1` is added here and nowhere else. */
export function installerCommand(spec: QuartusSpec = QUARTUS_SPEC): string {
    return `cd /mnt/mixfpga/installers && sudo -n ./${spec.installer.name} --mode unattended --unattendedmodeui minimal --accept_eula 1 --installdir ${spec.guestInstallDir} --disable-components ${spec.disabledComponents} --create_desktop_shortcuts 0`;
}

export class QuartusInstaller {
    private readonly spec: QuartusSpec;
    private readonly paths;
    private readonly engine;
    readonly record;
    readonly vmRecord;

    constructor(private readonly deps: QuartusDeps) {
        this.spec = deps.spec ?? QUARTUS_SPEC;
        this.paths = installedDe10Paths(deps.layout);
        this.engine = new LimaEngine(this.paths, deps.runner);
        this.record = new QuartusRecordStore(join(deps.layout.stateDir, 'quartus.json'));
        this.vmRecord = new LinuxVmRecordStore(join(deps.layout.stateDir, 'linux-vm.json'));
    }

    /** `quartus` and `max10`: from the recorded verification only, so opening MIX-FPGA never starts the engine. */
    definitions(): ComponentDefinition[] {
        const fromRecord = async (deps: ReadonlyMap<string, ComponentStatus>, what: 'quartus' | 'max10') => {
            const vm = deps.get('linux-vm');
            if (!vm || vm.state === 'not-installed') return { state: 'not-installed' as const, ownership: 'external' as const, code: 'NEEDS_ENGINE', detail: 'the FPGA engine is not set up yet' };
            const r = await this.record.read();
            if (r.verifiedAt) return { state: 'ready' as const, ownership: 'external' as const, version: what === 'quartus' ? r.version ?? this.spec.banner : this.spec.device, detail: `verified ${r.verifiedAt}` };
            if (r.installAttemptAt) return { state: 'repairable' as const, ownership: 'external' as const, code: 'PARTIAL_INSTALL', detail: 'a previous installation did not finish' };
            return { state: 'not-installed' as const, ownership: 'external' as const };
        };
        return [
            {
                id: 'quartus',
                label: 'Quartus Prime Lite',
                inspectAfter: ['linux-vm'],
                inspect: (deps) => fromRecord(deps, 'quartus'),
                install: { requires: ['linux-vm'], userInput: 'files', covers: ['max10'], run: (request) => this.install(request) },
            },
            { id: 'max10', label: 'MAX 10 support', inspectAfter: ['linux-vm'], inspect: (deps) => fromRecord(deps, 'max10') },
        ];
    }

    private lima(args: string[], signal?: AbortSignal, timeoutMs = 120_000): Promise<ToolRunResult> {
        return this.deps.runner.run({ executable: this.paths.limactl, args, env: { LIMA_HOME: this.paths.limaHome }, timeoutMs, ...(signal ? { signal } : {}) });
    }

    /** Removes only the two temporary copies MIX-FPGA made. The student's downloads are never touched. */
    async removeInstallerCopies(): Promise<void> {
        for (const f of [this.spec.installer.name, this.spec.devicePackage.name]) await rm(join(this.deps.layout.installersDir, f), { force: true });
        for (const f of [this.spec.installer.name, this.spec.devicePackage.name]) await rm(join(this.deps.layout.installersDir, `${f}.part`), { force: true });
    }

    private async copyVerified(src: string, name: string, sha256: string): Promise<void> {
        const dest = join(this.deps.layout.installersDir, name);
        if ((await stat(dest).then((s) => s.isFile(), () => false)) && (await sha256File(dest)) === sha256) return;
        const part = `${dest}.part`;
        await rm(part, { force: true });
        await copyFile(src, part);
        await chmod(part, name.endsWith('.run') ? 0o755 : 0o644);
        if ((await sha256File(part)) !== sha256) {
            await rm(part, { force: true });
            throw new Error(`The copy of ${name} did not match the original (is the disk damaged?).`);
        }
        await rename(part, dest);
    }

    /** Checks the student's two files, then makes the temporary copies the engine can see. Reads the downloads; never changes them. */
    private async stageFiles(files: QuartusFiles, say: (m: string) => void): Promise<Failure | undefined> {
        const { layout } = this.deps;
        say('Checking the downloaded files…');
        for (const [path, want] of [[files.installerPath, 'installer'], [files.devicePackagePath, 'devicePackage']] as const) {
            const c = await checkAlteraFile(path, want, this.spec);
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

    /** Runs `body` with the engine running, and puts it back the way it was found. */
    private async withEngine<T>(signal: AbortSignal | undefined, say: (m: string) => void, body: () => Promise<T>): Promise<{ failed: Failure } | { value: T }> {
        const vm = await this.engine.vmState();
        if (vm === 'not-installed') return { failed: fail('ENGINE_MISSING', 'The FPGA engine is not set up.') };
        const wasRunning = vm === 'running';
        if (!wasRunning) {
            say('Starting the FPGA engine…');
            const s = await this.lima(['start', LIMA_INSTANCE, '--tty=false'], signal, 300_000);
            if (!OK(s)) return { failed: fail('ENGINE_START_FAILED', `The FPGA engine did not start: ${tail(s)}`) };
        }
        try {
            return { value: await body() };
        } finally {
            if (!wasRunning) await this.lima(['stop', LIMA_INSTANCE], undefined, 120_000);
        }
    }

    /**
     * Step 1 of the guided install: the student's files are checked and copied, and the installer is asked for its own
     * licence files (`--install_lic`, which installs nothing). The result is the vendor's licence text to show, with its hash.
     * If the text is not the one established for this exact build, nothing is offered: stop rather than guess.
     */
    async prepareLicense(files: QuartusFiles, signal?: AbortSignal, onProgress?: (m: string) => void): Promise<{ ok: true; offer: LicenseOffer } | Failure> {
        const say = onProgress ?? (() => undefined);
        const staged = await this.stageFiles(files, say);
        if (staged) return staged;
        const { layout } = this.deps;
        const outDir = join(layout.shareDir, 'provision', 'license-out');
        const w = await this.withEngine(signal, say, async () => {
            say('Reading the licence from the installer…');
            await rm(outDir, { recursive: true, force: true });
            await mkdir(join(layout.shareDir, 'provision'), { recursive: true });
            // The installer waits for a key after writing its licence files; it is stopped as soon as they exist. Nothing is installed.
            // The installer waits for a key after writing its licence files, so it runs in the background and is stopped by its own
            // process id as soon as they exist (a name-based kill would also match this very script). Nothing is installed.
            const script = `d=/mnt/mixfpga/provision/license-out; rm -rf "$d"; mkdir -p "$d"; cd /mnt/mixfpga/installers && { timeout 120 ./${this.spec.installer.name} --mode text --install_lic "$d" < /dev/null > /dev/null 2>&1 & p=$!; for i in $(seq 1 200); do [ -s "$d/${this.spec.license.file}" ] && break; sleep 0.5; done; kill $p 2>/dev/null; pkill -P $p 2>/dev/null; wait $p 2>/dev/null; }; test -s "$d/${this.spec.license.file}" && echo MIXFPGA_LICENSE_OK`;
            return this.engine.guest(script, { ...(signal ? { signal } : {}), timeoutMs: 180_000 });
        });
        if ('failed' in w) return w.failed;
        const run = w.value;
        if (signal?.aborted) return fail('CANCELLED', 'Cancelled.');
        if (!run.stdout.includes('MIXFPGA_LICENSE_OK')) return fail('LICENSE_NOT_AVAILABLE', 'The installer did not provide its licence text. Nothing was installed. Try again, or download the installer again from Altera.');
        const bytes = await readFile(join(outDir, this.spec.license.file)).catch(() => undefined);
        await rm(outDir, { recursive: true, force: true });
        if (!bytes) return fail('LICENSE_NOT_AVAILABLE', 'The licence text could not be read.');
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (hash !== this.spec.license.sha256) return fail('LICENSE_UNVERIFIED', `The licence provided by this installer is not the one MIX-FPGA verified for Quartus ${this.spec.banner}, so it cannot be offered for acceptance. Nothing was installed.`);
        await mkdir(layout.stateDir, { recursive: true });
        await writeFile(join(layout.stateDir, 'quartus-license.txt'), bytes);
        await this.record.merge({ licenseOffered: { sha256: hash, installerSha256: this.spec.installer.sha256, offeredAt: new Date().toISOString() } });
        return {
            ok: true,
            offer: { product: this.spec.product, version: this.spec.banner, title: this.spec.license.title, text: bytes.toString('utf8'), sha256: hash, bytes: bytes.length, source: this.spec.license.source, installerSha256: this.spec.installer.sha256, references: this.spec.license.references, statement: ACCEPT_STATEMENT },
        };
    }

    async install(request: { input?: unknown; signal?: AbortSignal; progress: (p: { message: string; fraction?: number }) => void }): Promise<SetupStepResult> {
        const signal = request.signal;
        const say = (message: string) => request.progress({ message });
        const input = request.input;
        if (!isQuartusInput(input, this.spec)) return fail('INPUT_REQUIRED', 'Choose the two files you downloaded from Altera, read the licence, and tick the box to accept it.');

        // The acceptance only counts for the licence that this Mac's installer actually produced and offered.
        const rec = await this.record.read();
        if (rec.licenseOffered?.sha256 !== input.eula.licenseSha256 || rec.licenseOffered.installerSha256 !== input.eula.installerSha256) {
            return fail('LICENSE_NOT_SHOWN', 'The licence has not been shown to you on this computer yet. Open the licence first, then accept it.');
        }
        const staged = await this.stageFiles(input, say);
        if (staged) return staged;

        // The acceptance is written down before the installer may be told to accept anything.
        await this.record.merge({ eula: input.eula });
        const w = await this.withEngine(signal, say, () => this.installInEngine(signal, say, input));
        return 'failed' in w ? w.failed : w.value;
    }

    private async installInEngine(signal: AbortSignal | undefined, say: (m: string) => void, _input: QuartusInput): Promise<SetupStepResult> {
        const { layout } = this.deps;
        const guest = (script: string, timeoutMs: number) => this.engine.guest(script, { ...(signal ? { signal } : {}), timeoutMs });

        // Never reinstall over a working Quartus: if exactly this build already answers, it is only verified.
        const existing = await guest('mixfpga-q quartus_sh --version', 120_000);
        const alreadyThere = OK(existing) && `${existing.stdout}${existing.stderr}`.includes(this.spec.banner);
        if (!alreadyThere) {
            const attempted = (await this.record.read()).installAttemptAt;
            if (attempted) {
                say('Removing the unfinished installation…');
                // Only MIX-FPGA's own install folder, and only because an earlier attempt never completed.
                const clean = await guest(`d=${this.spec.guestInstallDir}; [ "$d" = /opt/mixfpga/quartus/25.1std ] && sudo -n rm -rf "$d"`, 300_000);
                if (!OK(clean)) return fail('CLEANUP_FAILED', `The unfinished installation could not be removed: ${tail(clean)}`);
            }
            await this.record.merge({ installAttemptAt: new Date().toISOString() });
            await this.deps.hook?.('before-install');
            say('Installing Quartus…');
            const inst = await guest(installerCommand(this.spec), 2_400_000);
            if (signal?.aborted) return fail('CANCELLED', 'Installation was cancelled.');
            if (!OK(inst)) return fail('QUARTUS_INSTALL_FAILED', `The Quartus installer did not finish: ${tail(inst)}`);
            await this.deps.hook?.('after-install');
            await this.record.merge({ installedAt: new Date().toISOString() });
        }

        say('Adding MAX 10 support…');
        say('Verifying installation…');
        const v = await verifyQuartus(this.engine, layout.shareDir, this.spec, signal);
        if (!v.ok) return fail(v.code ?? 'VERIFY_FAILED', v.message ?? 'Quartus did not pass its check.');
        await this.record.merge({ verifiedAt: new Date().toISOString(), ...(v.version ? { version: v.version } : {}), device: this.spec.device });
        await this.vmRecord.merge({ quartusInstalledAt: new Date().toISOString() });
        await this.removeInstallerCopies();
        return { ok: true, detail: alreadyThere ? 'already installed; verified' : 'installed and verified' };
    }
}
