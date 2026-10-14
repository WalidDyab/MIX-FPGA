/**
 * The FPGA engine (a hidden Linux VM run by Lima) exactly as validated in Phase 1. Nothing here is
 * tuned or changed in Phase 4; the installer only creates what this describes.
 */
export const ENGINE_SPEC = {
    lima: '2.2.1',
    vmType: 'vz',
    arch: 'aarch64',
    cpus: 4,
    memory: '8GiB',
    /** A sparse maximum: the disk file grows only as the guest writes. It is never preallocated. */
    disk: '60GiB',
    image: {
        release: 'ubuntu-24.04-server-cloudimg-arm64 release-20260926',
        url: 'https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-arm64.img',
        sha256: '1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55',
        bytes: 620_224_512,
        fileName: 'ubuntu-24.04-server-cloudimg-arm64-release-20260926.img',
    },
    mountPoint: '/mnt/mixfpga',
} as const;

/** Real disk use, measured on the validated Phase 1 machine (GB = 10^9 bytes). Used only to tell the student what to expect. */
export const EXPECTED_STORAGE = {
    /** Ubuntu image download (kept as a verified cache; its retention policy is decided later). */
    imageDownloadGB: 0.62,
    /** The VM's disk file after the Linux system and libraries are installed. */
    vmAfterLinuxGB: 2.4,
    /** The VM's disk file after Quartus Prime Lite and MAX 10 are installed (measured: 11.9). */
    vmAfterQuartusGB: 12,
    /** The student's two Altera downloads, copied temporarily during installation and removed afterwards (1.98 + 0.30). */
    temporaryInstallersGB: 2.3,
    /** Free space to ask for before starting, so the whole setup fits with margin. */
    requiredFreeGB: 20,
    /** The most the VM disk may ever grow to; shown as a limit, never as space taken. */
    vmDiskLimitGB: 60,
} as const;

export interface TemplateValues {
    readonly imageLocation: string;
    readonly shareDir: string;
}

/** Fills the engine template. Values are double-quoted YAML scalars in the template, so quotes and backslashes are escaped. */
export function renderEngineTemplate(template: string, v: TemplateValues): string {
    const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const out = template.replaceAll('{{IMAGE_LOCATION}}', q(v.imageLocation)).replaceAll('{{SHARE_DIR}}', q(v.shareDir));
    if (/\{\{[A-Z_]+\}\}/.test(out)) throw new Error('the engine template has an unfilled placeholder');
    return out;
}

/** `limactl list --json <instance>` fields the comparison reads. */
export interface LimaInstanceJson {
    readonly name?: string;
    readonly status?: string;
    readonly vmType?: string;
    readonly arch?: string;
    readonly cpus?: number;
    readonly errors?: readonly string[] | null;
    readonly config?: {
        readonly cpus?: number;
        readonly memory?: string;
        readonly disk?: string;
        readonly vmType?: string;
        readonly arch?: string;
        readonly images?: readonly { readonly location?: string; readonly digest?: string }[];
        readonly mounts?: readonly { readonly location?: string; readonly mountPoint?: string; readonly writable?: boolean }[];
        readonly vmOpts?: { readonly vz?: { readonly rosetta?: { readonly enabled?: boolean; readonly binfmt?: boolean } } };
    };
}

export interface ConfigDifference {
    readonly field: string;
    readonly expected: string;
    readonly actual: string;
    /** `fixable`: Lima can edit it on a stopped instance. `critical`: a different VM; MIX-FPGA will not touch it. */
    readonly severity: 'fixable' | 'critical';
}

/** Does an existing Lima instance have the validated configuration? Read-only; starts nothing. */
export function compareInstanceConfig(j: LimaInstanceJson, shareDir: string): ConfigDifference[] {
    const c = j.config ?? {};
    const diffs: ConfigDifference[] = [];
    const want = (field: string, expected: string | number | boolean, actual: unknown, severity: ConfigDifference['severity']) => {
        if (actual !== expected) diffs.push({ field, expected: String(expected), actual: String(actual), severity });
    };
    want('vmType', ENGINE_SPEC.vmType, c.vmType ?? j.vmType, 'critical');
    want('arch', ENGINE_SPEC.arch, c.arch ?? j.arch, 'critical');
    want('image digest', `sha256:${ENGINE_SPEC.image.sha256}`, c.images?.[0]?.digest, 'critical');
    want('rosetta', true, c.vmOpts?.vz?.rosetta?.enabled === true && c.vmOpts.vz.rosetta.binfmt === true, 'critical');
    const mount = c.mounts?.[0];
    want('mounts', 1, c.mounts?.length, 'critical');
    want('mount location', shareDir, mount?.location, 'critical');
    want('mount point', ENGINE_SPEC.mountPoint, mount?.mountPoint, 'critical');
    want('mount writable', true, mount?.writable, 'critical');
    want('cpus', ENGINE_SPEC.cpus, c.cpus, 'fixable');
    want('memory', ENGINE_SPEC.memory, c.memory, 'fixable');
    // A larger disk is harmless (and cannot be shrunk back safely), so only a smaller one is reported.
    if ((gib(c.disk) ?? 0) < (gib(ENGINE_SPEC.disk) ?? 0)) diffs.push({ field: 'disk', expected: ENGINE_SPEC.disk, actual: String(c.disk), severity: 'fixable' });
    return diffs;
}

/** "60GiB" -> 60. Other units are not used by the validated template. */
export function gib(text: string | undefined): number | undefined {
    const m = /^(\d+(?:\.\d+)?)\s*GiB$/i.exec(text ?? '');
    return m ? Number(m[1]) : undefined;
}
