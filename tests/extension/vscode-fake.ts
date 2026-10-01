/**
 * The subset of the `vscode` API the extension's adapters use, as plain
 * classes, so they can be unit-tested under node:test without launching
 * VS Code. Installed by install-vscode-fake.ts.
 */

export class Position {
    constructor(
        readonly line: number,
        readonly character: number,
    ) {}
}

export class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
        if (typeof a === 'number') {
            this.start = new Position(a, b as number);
            this.end = new Position(c!, d!);
        } else {
            this.start = a;
            this.end = b as Position;
        }
    }
}

export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3,
}

export class Diagnostic {
    source?: string;
    code?: string | number;
    constructor(
        readonly range: Range,
        readonly message: string,
        readonly severity: DiagnosticSeverity = DiagnosticSeverity.Error,
    ) {}
}

export class Uri {
    private constructor(readonly fsPath: string) {}
    readonly scheme = 'file';
    static file(path: string): Uri {
        return new Uri(path);
    }
    toString(): string {
        return `file://${this.fsPath}`;
    }
}

export class ThemeColor {
    constructor(readonly id: string) {}
}

export class ThemeIcon {
    static readonly File = new ThemeIcon('file');
    constructor(
        readonly id: string,
        readonly color?: ThemeColor,
    ) {}
}

export class MarkdownString {
    constructor(readonly value = '') {}
}

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
}

export class TreeItem {
    description?: string;
    tooltip?: unknown;
    iconPath?: unknown;
    command?: { command: string; arguments?: unknown[] };
    contextValue?: string;
    resourceUri?: Uri;
    id?: string;
    constructor(
        readonly label: string,
        public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
    ) {}
}

export class EventEmitter<T> {
    private listeners: Array<(v: T) => void> = [];
    readonly event = (l: (v: T) => void) => {
        this.listeners.push(l);
        return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
    };
    fire(v: T): void {
        this.listeners.forEach((l) => l(v));
    }
    dispose(): void {
        this.listeners = [];
    }
}

/** Every DiagnosticCollection created, for assertions. */
export const collections: FakeDiagnosticCollection[] = [];

export class FakeDiagnosticCollection {
    readonly entries = new Map<string, Diagnostic[]>();
    constructor(readonly name: string) {}
    set(uri: Uri, diagnostics: Diagnostic[]): void {
        this.entries.set(uri.fsPath, diagnostics);
    }
    clear(): void {
        this.entries.clear();
    }
    dispose(): void {
        this.entries.clear();
    }
}

export const languages = {
    createDiagnosticCollection(name: string): FakeDiagnosticCollection {
        const c = new FakeDiagnosticCollection(name);
        collections.push(c);
        return c;
    },
};

export const workspace = {
    textDocuments: [] as Array<{ uri: Uri; getText(): string }>,
};
