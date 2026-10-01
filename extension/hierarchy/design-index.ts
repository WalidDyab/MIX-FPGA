import type { ArchitectureDecl, ComponentDecl, EntityDecl, PackageDecl, ParsedVhdlFile } from './vhdl-parser';

/** Whether a file belongs to the RTL (src/) or to simulation (sim/). */
export type FileRole = 'source' | 'simulation';

export interface IndexedFile {
    /** Project-relative path with `/`. */
    readonly path: string;
    readonly role: FileRole;
    readonly parsed: ParsedVhdlFile;
}

export interface Located<T> {
    readonly decl: T;
    readonly file: string;
    readonly role: FileRole;
    /** Position of the file in compile order (lower = analysed earlier). */
    readonly order: number;
}

export interface IndexProblem {
    readonly severity: 'warning' | 'info';
    readonly message: string;
    readonly file?: string;
    readonly line?: number;
}

const key = (name: string) => name.toLowerCase();

/**
 * Cross-file view of every design unit in the project, keyed by
 * lower-case name. Built from parsed files in compile order.
 */
export class DesignIndex {
    readonly entities = new Map<string, Located<EntityDecl>[]>();
    readonly architectures = new Map<string, Located<ArchitectureDecl>[]>();
    readonly packages = new Map<string, Located<PackageDecl>[]>();
    readonly problems: IndexProblem[] = [];

    constructor(readonly files: readonly IndexedFile[]) {
        files.forEach((f, order) => {
            const at = <T>(decl: T): Located<T> => ({ decl, file: f.path, role: f.role, order });
            for (const e of f.parsed.entities) push(this.entities, key(e.name), at(e));
            for (const a of f.parsed.architectures) push(this.architectures, key(a.entity), at(a));
            for (const p of f.parsed.packages) if (!p.body) push(this.packages, key(p.name), at(p));
        });
        for (const [, decls] of this.entities) {
            if (decls.length > 1) {
                const first = decls[0]!;
                this.problems.push({
                    severity: 'warning',
                    message: `Entity "${first.decl.name}" is declared ${decls.length} times (${decls.map((d) => d.file).join(', ')}); the last one analysed wins.`,
                    file: decls[decls.length - 1]!.file,
                    line: decls[decls.length - 1]!.decl.line,
                });
            }
        }
    }

    /** The entity GHDL would bind: the last one in compile order. */
    entity(name: string): Located<EntityDecl> | undefined {
        const list = this.entities.get(key(name));
        return list?.[list.length - 1];
    }

    /** All architectures of an entity, in compile order. */
    architecturesOf(entity: string): readonly Located<ArchitectureDecl>[] {
        return this.architectures.get(key(entity)) ?? [];
    }

    /**
     * Architecture used for an entity: the named one, otherwise the most
     * recently analysed (VHDL default binding).
     */
    architectureFor(entity: string, name?: string): Located<ArchitectureDecl> | undefined {
        const all = this.architecturesOf(entity);
        if (name !== undefined) return all.find((a) => key(a.decl.name) === key(name));
        return all[all.length - 1];
    }

    /** Component declaration visible in an architecture (its own, then any package's). */
    component(arch: ArchitectureDecl, name: string): ComponentDecl | undefined {
        const own = arch.components.find((c) => key(c.name) === key(name));
        if (own) return own;
        for (const [, pkgs] of this.packages) {
            for (const p of pkgs) {
                const c = p.decl.components.find((x) => key(x.name) === key(name));
                if (c) return c;
            }
        }
        return undefined;
    }

    /** Entities declared in the given role, in compile order (one per name). */
    entitiesIn(role: FileRole): Located<EntityDecl>[] {
        const out: Located<EntityDecl>[] = [];
        for (const [name] of this.entities) {
            const e = this.entity(name)!;
            if (e.role === role) out.push(e);
        }
        return out.sort((a, b) => a.order - b.order || a.decl.line - b.decl.line);
    }

    /** Entity names declared in one file. */
    entitiesInFile(path: string): EntityDecl[] {
        return this.files.find((f) => f.path === path)?.parsed.entities.slice() ?? [];
    }
}

function push<T>(map: Map<string, T[]>, k: string, v: T): void {
    const list = map.get(k);
    if (list) list.push(v);
    else map.set(k, [v]);
}
