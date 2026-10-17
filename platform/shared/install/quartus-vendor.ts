import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { writeFileAtomic } from '../../../core/util/atomic-write';
import { sha256File } from '../../../core/util/hash';

/**
 * The host-neutral part of installing Altera's Quartus Prime Lite: the licence offer and the student's acceptance of it, the record
 * of what happened, and the check that a downloaded file is really the one Altera publishes. Altera's files are never redistributed;
 * the student supplies them. Each host has its own spec (file names, hashes) and its own installer.
 */
export interface VendorFileSpec {
    readonly name: string;
    readonly sha256: string;
    readonly bytes: number;
}

/** What a host's Quartus spec must say for the shared logic: product, build, the two files, and the licence that was verified. */
export interface VendorSpec {
    readonly product: string;
    readonly banner: string;
    readonly installer: VendorFileSpec;
    readonly devicePackage: VendorFileSpec;
    readonly license: { readonly sha256: string };
}

/** The words next to the checkbox. Exact; the acceptance is only valid with this text. */
export const ACCEPT_STATEMENT = 'I have reviewed and accept the Altera Quartus Prime Software License Agreement.';


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
 * The student's explicit acceptance. It is only valid for the licence that was actually shown on this computer
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

export function isQuartusInput(x: unknown, spec: VendorSpec): x is QuartusInput {
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
    /** The licence text was produced by the vendor installer on this computer and offered to the student. */
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

export type FileCheck = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Is this the file Altera publishes? The name alone is never trusted: size and sha256 must match.
 * Reads the file; never modifies it.
 */
export async function checkAlteraFile(path: string, want: 'installer' | 'devicePackage', spec: VendorSpec): Promise<FileCheck> {
    const exp = spec[want];
    const other = spec[want === 'installer' ? 'devicePackage' : 'installer'];
    const s = await stat(path).catch(() => undefined);
    if (!s?.isFile()) return { ok: false, code: 'FILE_NOT_FOUND', message: `${path} was not found.` };
    const label = want === 'installer' ? 'the Quartus installer' : 'the MAX 10 device package';
    const looksRight = path.endsWith(exp.name) || basename(path) === exp.name;
    if (s.size !== exp.bytes) {
        if (s.size === other.bytes) return { ok: false, code: 'FILES_SWAPPED', message: `This looks like ${want === 'installer' ? 'the MAX 10 device package' : 'the Quartus installer'}; ${label} (${exp.name}) is needed here.` };
        return { ok: false, code: looksRight ? 'FILE_DIFFERENT_VERSION' : 'WRONG_FILE', message: looksRight ? `${exp.name} has an unexpected size (${s.size} bytes); it may be incomplete or a different version. Download ${exp.name} again from Altera.` : `This is not ${label}. MIX-FPGA needs ${exp.name} from Altera.` };
    }
    if ((await sha256File(path)) !== exp.sha256) return { ok: false, code: 'FILE_HASH_MISMATCH', message: `${exp.name} does not match the version MIX-FPGA supports (Quartus ${spec.banner}). Download it again from Altera.` };
    return { ok: true };
}
