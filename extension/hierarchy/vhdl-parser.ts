import { RESERVED, type Token, tokenize } from './vhdl-lexer';

/**
 * Structural VHDL parser for editor-time indexing (Design Hierarchy,
 * schematic, compile order). It recognises design units, interface lists,
 * component/signal declarations and component instantiations; everything
 * else is skipped. See docs/phase4a-vscode-workspace.md for the supported
 * subset. It never rejects a file: unknown constructs are ignored.
 */

export interface SourcePosition {
    readonly line: number;
    readonly col: number;
}

export type PortMode = 'in' | 'out' | 'inout' | 'buffer' | 'linkage';

export interface InterfaceItem extends SourcePosition {
    readonly name: string;
    /** Port mode; generics and mode-less ports default to `in`. */
    readonly mode: PortMode;
    /** Subtype indication as written, e.g. `std_logic_vector(7 downto 0)`. */
    readonly type: string;
}

export interface EntityDecl extends SourcePosition {
    readonly name: string;
    readonly generics: readonly InterfaceItem[];
    readonly ports: readonly InterfaceItem[];
}

export interface ComponentDecl extends SourcePosition {
    readonly name: string;
    readonly generics: readonly InterfaceItem[];
    readonly ports: readonly InterfaceItem[];
}

export interface SignalDecl extends SourcePosition {
    readonly name: string;
    readonly type: string;
}

/** One element of a port map. */
export interface Association {
    /** Formal (the instantiated block's port) for named association; absent for positional. */
    readonly formal?: string;
    /** 0-based position in the association list. */
    readonly position: number;
    /** Actual as written, e.g. `count(26)`, `not rst`, `open`. */
    readonly actual: string;
    /** `open` keyword. */
    readonly open: boolean;
    /**
     * First identifier of an actual that is a plain, indexed, sliced or
     * selected name (`sig`, `sig(3)`, `bus(7 downto 0)`, `rec.field`).
     * Absent for literals and operator expressions. Whether it is really a
     * signal/port (not a function call) is decided by the consumer.
     */
    readonly actualName?: string;
    /** True when the actual is exactly one identifier. */
    readonly simple: boolean;
}

export type InstanceKind = 'entity' | 'component' | 'configuration';

export interface InstanceDecl extends SourcePosition {
    readonly label: string;
    readonly kind: InstanceKind;
    /** Library prefix for `entity lib.name`; absent otherwise. */
    readonly library?: string;
    /** Entity, component or configuration name as written. */
    readonly target: string;
    readonly targetPosition: SourcePosition;
    /** Explicit architecture: `entity work.x(rtl)`. */
    readonly architecture?: string;
    /** `u : name port map …` without the `component` keyword. */
    readonly implicitComponent: boolean;
    /** Whether a port map / generic map was present. */
    readonly hasPortMap: boolean;
    readonly hasGenericMap: boolean;
    readonly portMap: readonly Association[];
    /** Labels of enclosing generate statements, outermost first. */
    readonly generate: readonly string[];
}

export interface ArchitectureDecl extends SourcePosition {
    readonly name: string;
    readonly entity: string;
    readonly components: readonly ComponentDecl[];
    readonly signals: readonly SignalDecl[];
    readonly instances: readonly InstanceDecl[];
}

export interface PackageDecl extends SourcePosition {
    readonly name: string;
    readonly body: boolean;
    readonly components: readonly ComponentDecl[];
}

export interface UseClause extends SourcePosition {
    readonly library: string;
    readonly unit: string;
}

export interface ParsedVhdlFile {
    readonly entities: readonly EntityDecl[];
    readonly architectures: readonly ArchitectureDecl[];
    readonly packages: readonly PackageDecl[];
    /** `configuration c of e is` units (entity names). */
    readonly configurations: readonly { readonly name: string; readonly entity: string }[];
    readonly uses: readonly UseClause[];
}

const isId = (t: Token | undefined): t is Token => t !== undefined && (t.kind === 'extended' || (t.kind === 'identifier' && !RESERVED.has(t.lower)));
const isKw = (t: Token | undefined, kw: string) => t !== undefined && t.kind === 'identifier' && t.lower === kw;
const isDelim = (t: Token | undefined, d: string) => t !== undefined && t.kind === 'delimiter' && t.text === d;
/** Names keep the spelling of their declaration; consumers compare them case-insensitively. */
const nameOf = (t: Token) => t.text;
const pos = (t: Token): SourcePosition => ({ line: t.line, col: t.col });

/** Joins tokens for display: `std_logic_vector(7 downto 0)`. */
export function joinTokens(tokens: readonly Token[]): string {
    let out = '';
    tokens.forEach((t, k) => {
        const prev = tokens[k - 1];
        const tight = !prev || t.text === ')' || t.text === ',' || t.text === '(' && prev.kind !== 'delimiter' || prev.text === '(' || t.text === '.' || prev.text === '.' || t.text === "'" || prev.text === "'";
        out += (tight ? '' : ' ') + t.text;
    });
    return out;
}

class Cursor {
    constructor(
        readonly t: readonly Token[],
        public i = 0,
    ) {}
    at(k = 0): Token | undefined {
        return this.t[this.i + k];
    }
    /** Index of the token closing the parenthesis opened at `open`, or the end. */
    matching(open: number): number {
        let depth = 0;
        for (let k = open; k < this.t.length; k++) {
            if (isDelim(this.t[k], '(')) depth++;
            else if (isDelim(this.t[k], ')') && --depth === 0) return k;
        }
        return this.t.length;
    }
}

/** Splits t[from, to) at depth-0 occurrences of `sep`. */
function splitTop(t: readonly Token[], from: number, to: number, sep: string): Token[][] {
    const parts: Token[][] = [];
    let cur: Token[] = [];
    let depth = 0;
    for (let k = from; k < to; k++) {
        const tok = t[k]!;
        if (isDelim(tok, '(')) depth++;
        else if (isDelim(tok, ')')) depth--;
        if (depth === 0 && isDelim(tok, sep)) {
            parts.push(cur);
            cur = [];
        } else cur.push(tok);
    }
    if (cur.length > 0) parts.push(cur);
    return parts;
}

const MODES = new Set(['in', 'out', 'inout', 'buffer', 'linkage']);
const NON_OBJECT_GENERICS = new Set(['type', 'package', 'function', 'procedure', 'impure', 'pure']);

/** Parses `( a, b : in std_logic; … )` whose `(` is at index `open`. */
function parseInterfaceList(c: Cursor, open: number): { items: InterfaceItem[]; end: number } {
    const close = c.matching(open);
    const items: InterfaceItem[] = [];
    for (const element of splitTop(c.t, open + 1, close, ';')) {
        let k = 0;
        if (element[k] && NON_OBJECT_GENERICS.has(element[k]!.lower)) continue; // VHDL-2008 type/package/subprogram generics
        if (element[k] && ['signal', 'constant', 'variable', 'file'].includes(element[k]!.lower)) k++;
        const names: Token[] = [];
        while (k < element.length && !isDelim(element[k], ':')) {
            if (isId(element[k])) names.push(element[k]!);
            k++;
        }
        if (!isDelim(element[k], ':')) continue;
        k++;
        let mode: PortMode = 'in';
        if (element[k] && MODES.has(element[k]!.lower) && element[k]!.kind === 'identifier') {
            mode = element[k]!.lower as PortMode;
            k++;
        }
        const typeTokens: Token[] = [];
        while (k < element.length && !isDelim(element[k], ':=')) typeTokens.push(element[k++]!);
        const type = joinTokens(typeTokens);
        for (const n of names) items.push({ name: nameOf(n), mode, type, ...pos(n) });
    }
    return { items, end: close };
}

/** Parses an optional `generic ( … )` and `port ( … )` sequence starting at c.i (entity/component header). */
function parseHeader(c: Cursor, stop: number): { generics: InterfaceItem[]; ports: InterfaceItem[] } {
    let generics: InterfaceItem[] = [];
    let ports: InterfaceItem[] = [];
    while (c.i < stop) {
        const tok = c.at();
        if ((isKw(tok, 'generic') || isKw(tok, 'port')) && isDelim(c.at(1), '(')) {
            const { items, end } = parseInterfaceList(c, c.i + 1);
            if (isKw(tok, 'generic')) generics = items;
            else ports = items;
            c.i = end + 1;
            continue;
        }
        if (isKw(tok, 'end') || isKw(tok, 'begin')) break;
        c.i++;
    }
    return { generics, ports };
}

/** Parses a port map `( … )` whose `(` is at index `open`. */
function parseAssociations(c: Cursor, open: number): { associations: Association[]; end: number } {
    const close = c.matching(open);
    const associations: Association[] = [];
    splitTop(c.t, open + 1, close, ',').forEach((element, position) => {
        let arrow = -1;
        let depth = 0;
        element.forEach((tok, k) => {
            if (isDelim(tok, '(')) depth++;
            else if (isDelim(tok, ')')) depth--;
            else if (depth === 0 && arrow < 0 && isDelim(tok, '=>')) arrow = k;
        });
        const formalTokens = arrow >= 0 ? element.slice(0, arrow) : [];
        const actualTokens = arrow >= 0 ? element.slice(arrow + 1) : element;
        const formal = formalTokens.find((t) => isId(t));
        const open_ = actualTokens.length === 1 && isKw(actualTokens[0], 'open');
        const first = actualTokens[0];
        // A name: identifier followed only by (…) index/slice groups or .field selections.
        let actualName: string | undefined;
        if (isId(first)) {
            let k = 1;
            let ok = true;
            while (k < actualTokens.length && ok) {
                if (isDelim(actualTokens[k], '(')) {
                    let d = 0;
                    for (; k < actualTokens.length; k++) {
                        if (isDelim(actualTokens[k], '(')) d++;
                        else if (isDelim(actualTokens[k], ')') && --d === 0) break;
                    }
                    k++;
                } else if (isDelim(actualTokens[k], '.') && isId(actualTokens[k + 1])) {
                    k += 2;
                } else ok = false;
            }
            if (ok) actualName = nameOf(first);
        }
        associations.push({
            ...(formal ? { formal: nameOf(formal) } : {}),
            position,
            actual: joinTokens(actualTokens),
            open: open_,
            ...(actualName !== undefined ? { actualName } : {}),
            simple: actualTokens.length === 1 && isId(first),
        });
    });
    return { associations, end: close };
}

/** Index after the `;` that ends the construct starting at or after `from` (depth 0). */
function skipToSemicolon(c: Cursor, from: number, stop: number): number {
    let depth = 0;
    for (let k = from; k < stop; k++) {
        if (isDelim(c.t[k], '(')) depth++;
        else if (isDelim(c.t[k], ')')) depth--;
        else if (depth === 0 && isDelim(c.t[k], ';')) return k + 1;
    }
    return stop;
}

/** Index after `end <kw> … ;` for a construct like `component`/`record`, or after `end … ;` generally. */
function skipToEnd(c: Cursor, from: number, stop: number, kw: string): number {
    for (let k = from; k < stop; k++) {
        if (isKw(c.t[k], 'end') && isKw(c.t[k + 1], kw)) return skipToSemicolon(c, k, stop);
    }
    return stop;
}

function parseComponent(c: Cursor, stop: number): ComponentDecl | undefined {
    const name = c.at(1);
    if (!isId(name)) return undefined;
    c.i += 2;
    if (isKw(c.at(), 'is')) c.i++;
    const { generics, ports } = parseHeader(c, stop);
    c.i = skipToEnd(c, c.i, stop, 'component');
    return { name: nameOf(name), generics, ports, ...pos(name) };
}

/** Statement-region tokens after which a `label :` starts a concurrent statement. */
const STATEMENT_START = new Set([';', 'begin', 'generate', 'then', 'else', '=>']);

function startsStatement(prev: Token | undefined): boolean {
    if (!prev) return false;
    return STATEMENT_START.has(prev.kind === 'delimiter' ? prev.text : prev.lower);
}

/** After `label : for|if|case`, true if `generate` comes before `loop`/`then`/`is` (depth 0). */
function isGenerate(c: Cursor, from: number, stop: number): boolean {
    let depth = 0;
    for (let k = from; k < stop; k++) {
        const tok = c.t[k]!;
        if (isDelim(tok, '(')) depth++;
        else if (isDelim(tok, ')')) depth--;
        else if (depth === 0 && tok.kind === 'identifier') {
            if (tok.lower === 'generate') return true;
            if (tok.lower === 'loop' || tok.lower === 'then' || tok.lower === 'is' || isDelim(c.t[k], ';')) return false;
        } else if (depth === 0 && isDelim(tok, ';')) return false;
    }
    return false;
}

function parseArchitecture(c: Cursor, start: number, stop: number): ArchitectureDecl {
    const nameTok = c.t[start + 1]!;
    const entityTok = c.t[start + 3]!;
    const components: ComponentDecl[] = [];
    const signals: SignalDecl[] = [];
    const instances: InstanceDecl[] = [];
    const generate: string[] = [];
    c.i = start + 5; // after `is`

    while (c.i < stop) {
        const tok = c.at()!;
        if (isDelim(tok, '(')) {
            c.i = c.matching(c.i) + 1;
            continue;
        }
        if (isKw(tok, 'component') && isId(c.at(1))) {
            const comp = parseComponent(c, stop);
            if (comp) components.push(comp);
            continue;
        }
        if (isKw(tok, 'record')) {
            c.i = skipToEnd(c, c.i, stop, 'record');
            continue;
        }
        if (isKw(tok, 'signal') && isId(c.at(1))) {
            const end = skipToSemicolon(c, c.i, stop);
            const names: Token[] = [];
            let k = c.i + 1;
            for (; k < end && !isDelim(c.t[k], ':'); k++) if (isId(c.t[k])) names.push(c.t[k]!);
            const typeTokens: Token[] = [];
            for (k++; k < end - 1 && !isDelim(c.t[k], ':='); k++) typeTokens.push(c.t[k]!);
            const type = joinTokens(typeTokens);
            for (const n of names) signals.push({ name: nameOf(n), type, ...pos(n) });
            c.i = end;
            continue;
        }
        if (isKw(tok, 'end') && isKw(c.at(1), 'generate')) {
            generate.pop();
            c.i += 2;
            continue;
        }
        if (isId(tok) && isDelim(c.at(1), ':') && startsStatement(c.t[c.i - 1])) {
            const next = c.at(2);
            if (isKw(next, 'for') || isKw(next, 'if') || isKw(next, 'case')) {
                // A generate statement, or a labelled sequential loop/if/case inside a process.
                if (isGenerate(c, c.i + 3, stop)) generate.push(nameOf(tok));
                c.i += 3;
                continue;
            }
            const inst = parseInstance(c, stop, tok, generate);
            if (inst) {
                instances.push(inst);
                continue;
            }
        }
        c.i++;
    }
    return { name: nameOf(nameTok), entity: nameOf(entityTok), components, signals, instances, ...pos(nameTok) };
}

/** Parses `label : [entity lib.name[(arch)] | component name | configuration name | name] [generic map (…)] [port map (…)] ;`. */
function parseInstance(c: Cursor, stop: number, label: Token, generate: readonly string[]): InstanceDecl | undefined {
    let k = c.i + 2;
    const head = c.t[k];
    let kind: InstanceKind;
    let library: string | undefined;
    let target: Token | undefined;
    let architecture: string | undefined;
    let implicitComponent = false;

    if (isKw(head, 'entity')) {
        kind = 'entity';
        const a = c.t[k + 1];
        if (isId(a) && isDelim(c.t[k + 2], '.') && isId(c.t[k + 3])) {
            library = nameOf(a);
            target = c.t[k + 3];
            k += 4;
        } else if (isId(a)) {
            target = a;
            k += 2;
        } else return undefined;
        if (isDelim(c.t[k], '(') && isId(c.t[k + 1]) && isDelim(c.t[k + 2], ')')) {
            architecture = nameOf(c.t[k + 1]!);
            k += 3;
        }
    } else if (isKw(head, 'component') || isKw(head, 'configuration')) {
        kind = isKw(head, 'component') ? 'component' : 'configuration';
        const a = c.t[k + 1];
        if (!isId(a)) return undefined;
        // `lib.name` is allowed for both; keep the last identifier.
        if (isDelim(c.t[k + 2], '.') && isId(c.t[k + 3])) {
            library = nameOf(a);
            target = c.t[k + 3];
            k += 4;
        } else {
            target = a;
            k += 2;
        }
    } else if (isId(head)) {
        const after = c.t[k + 1];
        if (!(isKw(after, 'generic') || isKw(after, 'port') || isDelim(after, ';'))) return undefined;
        kind = 'component';
        implicitComponent = true;
        target = head;
        k += 1;
    } else return undefined;

    let portMap: Association[] = [];
    let hasPortMap = false;
    let hasGenericMap = false;
    for (;;) {
        const t = c.t[k];
        if ((isKw(t, 'generic') || isKw(t, 'port')) && isKw(c.t[k + 1], 'map') && isDelim(c.t[k + 2], '(')) {
            if (isKw(t, 'port')) {
                const parsed = parseAssociations(c, k + 2);
                portMap = parsed.associations;
                hasPortMap = true;
                k = parsed.end + 1;
            } else {
                hasGenericMap = true;
                k = c.matching(k + 2) + 1;
            }
            continue;
        }
        break;
    }
    if (!isDelim(c.t[k], ';')) {
        // Not an instantiation after all (e.g. a labelled procedure call); let the caller continue.
        if (implicitComponent) return undefined;
        k = skipToSemicolon(c, k, stop) - 1;
    }
    c.i = Math.min(stop, k + 1);
    return {
        label: nameOf(label),
        kind,
        ...(library !== undefined ? { library } : {}),
        target: nameOf(target!),
        targetPosition: pos(target!),
        ...(architecture !== undefined ? { architecture } : {}),
        implicitComponent,
        hasPortMap,
        hasGenericMap,
        portMap,
        generate: [...generate],
        ...pos(label),
    };
}

type UnitStart =
    | { kind: 'entity' | 'package' | 'package-body' | 'context'; at: number }
    | { kind: 'architecture' | 'configuration'; at: number };

/** Positions where design units begin, recognised by their header pattern. */
function unitStarts(t: readonly Token[]): UnitStart[] {
    const starts: UnitStart[] = [];
    for (let k = 0; k < t.length; k++) {
        const tok = t[k]!;
        if (tok.kind !== 'identifier' || isKw(t[k - 1], 'end')) continue;
        if (tok.lower === 'entity' && isId(t[k + 1]) && isKw(t[k + 2], 'is')) starts.push({ kind: 'entity', at: k });
        else if ((tok.lower === 'architecture' || tok.lower === 'configuration') && isId(t[k + 1]) && isKw(t[k + 2], 'of') && isId(t[k + 3]) && isKw(t[k + 4], 'is')) {
            starts.push({ kind: tok.lower, at: k });
        } else if (tok.lower === 'package' && isKw(t[k + 1], 'body') && isId(t[k + 2]) && isKw(t[k + 3], 'is')) starts.push({ kind: 'package-body', at: k });
        else if (tok.lower === 'package' && isId(t[k + 1]) && isKw(t[k + 2], 'is')) starts.push({ kind: 'package', at: k });
        else if (tok.lower === 'context' && isId(t[k + 1]) && isKw(t[k + 2], 'is')) starts.push({ kind: 'context', at: k });
    }
    return starts;
}

function parseUses(t: readonly Token[]): UseClause[] {
    const uses: UseClause[] = [];
    for (let k = 0; k < t.length; k++) {
        if (!(isKw(t[k], 'use') || (isKw(t[k], 'context') && isId(t[k + 1]) && isDelim(t[k + 2], '.')))) continue;
        // use lib.unit[.item], lib.unit…;   context lib.ctx;
        let j = k + 1;
        while (j < t.length && !isDelim(t[j], ';')) {
            if (isId(t[j]) && isDelim(t[j + 1], '.') && (isId(t[j + 2]) || isKw(t[j + 2], 'all'))) {
                uses.push({ library: t[j]!.lower, unit: t[j + 2]!.lower, ...pos(t[j]!) });
                j += 3;
                while (j < t.length && !isDelim(t[j], ',') && !isDelim(t[j], ';')) j++;
            } else j++;
        }
        k = j;
    }
    return uses;
}

export function parseVhdl(text: string): ParsedVhdlFile {
    const t = tokenize(text);
    const c = new Cursor(t);
    const entities: EntityDecl[] = [];
    const architectures: ArchitectureDecl[] = [];
    const packages: PackageDecl[] = [];
    const configurations: { name: string; entity: string }[] = [];
    const starts = unitStarts(t);

    starts.forEach((s, idx) => {
        const stop = idx + 1 < starts.length ? starts[idx + 1]!.at : t.length;
        switch (s.kind) {
            case 'entity': {
                const name = t[s.at + 1]!;
                c.i = s.at + 3;
                const { generics, ports } = parseHeader(c, stop);
                entities.push({ name: nameOf(name), generics, ports, ...pos(name) });
                break;
            }
            case 'architecture':
                architectures.push(parseArchitecture(c, s.at, stop));
                break;
            case 'configuration':
                configurations.push({ name: nameOf(t[s.at + 1]!), entity: nameOf(t[s.at + 3]!) });
                break;
            case 'package':
            case 'package-body': {
                const body = s.kind === 'package-body';
                const name = t[s.at + (body ? 2 : 1)]!;
                const components: ComponentDecl[] = [];
                for (c.i = s.at + 1; c.i < stop; ) {
                    if (isKw(c.at(), 'component') && isId(c.at(1))) {
                        const comp = parseComponent(c, stop);
                        if (comp) components.push(comp);
                    } else c.i++;
                }
                packages.push({ name: nameOf(name), body, components, ...pos(name) });
                break;
            }
            case 'context':
                break;
        }
    });
    return { entities, architectures, packages, configurations, uses: parseUses(t) };
}
