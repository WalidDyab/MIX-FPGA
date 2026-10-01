import type { IndexedFile } from './design-index';

export interface CompileOrder {
    readonly order: readonly string[];
    /** Files involved in a dependency cycle (kept in their preferred order). */
    readonly cycle: readonly string[];
}

/**
 * Orders VHDL files so every file is analysed after the files it needs:
 * packages before their users (`use work.pkg`), entities before their
 * architectures in other files, and entities before files that instantiate
 * them directly (`entity work.x`). Component instantiation needs no order.
 *
 * The sort is stable: among independent files the `preferred` order is kept
 * (then alphabetical), so a student's existing list changes only when it
 * must. Dependencies on files outside `files` (e.g. RTL needed by
 * testbenches ordered separately) are treated as already satisfied.
 */
export function compileOrder(files: readonly IndexedFile[], preferred: readonly string[] = []): CompileOrder {
    const providers = new Map<string, string>();
    for (const f of files) {
        for (const e of f.parsed.entities) providers.set(`entity:${e.name.toLowerCase()}`, f.path);
        for (const p of f.parsed.packages) if (!p.body) providers.set(`package:${p.name.toLowerCase()}`, f.path);
    }

    const deps = new Map<string, Set<string>>();
    for (const f of files) {
        const need = new Set<string>();
        const add = (k: string) => {
            const p = providers.get(k);
            if (p && p !== f.path) need.add(p);
        };
        for (const u of f.parsed.uses) if (u.library === 'work') add(`package:${u.unit}`);
        for (const a of f.parsed.architectures) {
            add(`entity:${a.entity.toLowerCase()}`);
            for (const i of a.instances) {
                if (i.kind === 'entity' && (i.library === undefined || i.library.toLowerCase() === 'work')) add(`entity:${i.target.toLowerCase()}`);
            }
        }
        for (const p of f.parsed.packages) if (p.body) add(`package:${p.name.toLowerCase()}`);
        for (const c of f.parsed.configurations) add(`entity:${c.entity.toLowerCase()}`);
        deps.set(f.path, need);
    }

    const rank = (p: string) => {
        const i = preferred.indexOf(p);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const byPreference = (a: string, b: string) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);

    const remaining = new Set(files.map((f) => f.path));
    const order: string[] = [];
    while (remaining.size > 0) {
        const ready = [...remaining].filter((p) => [...deps.get(p)!].every((d) => !remaining.has(d))).sort(byPreference);
        if (ready.length === 0) break;
        const next = ready[0]!;
        order.push(next);
        remaining.delete(next);
    }
    const cycle = [...remaining].sort(byPreference);
    return { order: [...order, ...cycle], cycle };
}
