import { readFile } from 'node:fs/promises';
import type { ToolchainUnit } from './expected';

/**
 * The third-party inventory of a toolchain payload (toolchains/mixfpga/compliance/<target>.inventory.json):
 * which component every shipped file belongs to, under which licence, with which obligations, and what is
 * still open. The notices shipped with the toolchain are generated from it.
 */
export type NoticeStatus = 'verified' | 'inherited' | 'pending' | 'unclear';
export type ObligationClass = 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'runtime-exception' | 'unclear';

export interface LicenseTextRef {
    readonly dest: string;
    readonly from: string;
    readonly note?: string;
}

export interface NoticeSource {
    readonly id: string;
    readonly url?: string;
    readonly revision?: string;
    readonly archive?: string;
    readonly sha256?: string;
    readonly note?: string;
}

export interface NoticeComponent {
    readonly id: string;
    readonly unit: string;
    readonly name: string;
    readonly version: string;
    readonly kind: string;
    readonly role?: string;
    readonly license: string;
    readonly election?: string;
    readonly claims?: readonly string[];
    readonly embeddedIn?: readonly string[];
    readonly usage?: string;
    readonly linking?: string;
    readonly evidence?: string;
    readonly obligation: { readonly class: ObligationClass; readonly licenseText: boolean; readonly notice: boolean; readonly source: string; readonly note?: string };
    readonly licenseTexts: readonly LicenseTextRef[];
    /** Name of a collection file next to the inventory whose texts belong to this component (the Go modules). */
    readonly licenseCollection?: string;
    readonly sources: readonly NoticeSource[];
    readonly status: NoticeStatus;
    readonly openItems?: readonly string[];
    readonly flags: readonly string[];
}

export interface LegalFlag {
    readonly id: string;
    readonly severity: 'blocking-release' | 'needs-decision' | 'minor';
    readonly title: string;
    readonly detail: string;
    /** Absent means open. */
    readonly status?: 'open' | 'resolved';
    /** How a resolved flag was closed. */
    readonly resolution?: string;
}

export interface NoticeInventory {
    readonly schemaVersion: 1;
    readonly toolchainVersion: string;
    readonly target: string;
    /** CANDIDATE: complete, but counsel review of the remaining open flags is pending. */
    readonly status: 'DRAFT' | 'CANDIDATE' | 'FINAL';
    readonly statusReason: string;
    /** Deliberate changes made to upstream content (omissions, regenerated files), printed in the notices. */
    readonly modifications?: readonly string[];
    readonly components: readonly NoticeComponent[];
    readonly notRedistributed: readonly { readonly id: string; readonly name: string; readonly owner: string; readonly treatment: string }[];
    readonly legalFlags: readonly LegalFlag[];
    readonly sourceOffer: { readonly status: string; readonly mustProvideForRelease: readonly string[]; readonly notRequired: readonly string[] };
}

export async function loadNoticeInventory(file: string): Promise<NoticeInventory> {
    return JSON.parse(await readFile(file, 'utf8')) as NoticeInventory;
}

/** `dir/**` = everything below dir, `**` = everything, `*` = any characters inside one path segment. */
export function globToRegExp(glob: string): RegExp {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]!;
        if (c === '*' && glob[i + 1] === '*') {
            re += '.*';
            i++;
        } else if (c === '*') re += '[^/]*';
        else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}

export interface Coverage {
    /** Shipped paths (`<unit>/<path>`) that no component claims. */
    readonly unclaimed: readonly string[];
    /** Shipped paths claimed by more than one component. */
    readonly multiple: readonly { path: string; by: readonly string[] }[];
    /** Components with a claim that matches no shipped file. */
    readonly deadClaims: readonly { component: string; claim: string }[];
}

/** Does every file and link of the payload belong to exactly one inventory component? */
export function checkCoverage(inventory: NoticeInventory, units: readonly ToolchainUnit[], inventoried: readonly string[] = ['ghdl', 'yosys', 'openfpgaloader', 'lima', 'engine']): Coverage {
    const claimers = inventory.components.flatMap((c) => (c.claims ?? []).map((g) => ({ c, g, re: globToRegExp(g) })));
    const used = new Set<string>();
    const unclaimed: string[] = [];
    const multiple: { path: string; by: string[] }[] = [];
    for (const u of units.filter((x) => inventoried.includes(x.id))) {
        for (const p of [...u.files.map((f) => f.path), ...u.links.map((l) => l.path)]) {
            const by = claimers.filter((x) => x.c.unit === u.id && x.re.test(p));
            for (const b of by) used.add(`${b.c.id}\u0000${b.g}`);
            if (by.length === 0) unclaimed.push(`${u.id}/${p}`);
            else if (new Set(by.map((b) => b.c.id)).size > 1) multiple.push({ path: `${u.id}/${p}`, by: [...new Set(by.map((b) => b.c.id))] });
        }
    }
    const deadClaims = claimers.filter((x) => !used.has(`${x.c.id}\u0000${x.g}`)).map((x) => ({ component: x.c.id, claim: x.g }));
    return { unclaimed, multiple, deadClaims };
}

/** The notices are a draft while anything is pending or unclear, or a flag is open. */
export function isDraft(inventory: NoticeInventory): boolean {
    return inventory.status === 'DRAFT' || (inventory.status !== 'CANDIDATE' && inventory.components.some((c) => c.status === 'pending' || c.status === 'unclear'));
}
