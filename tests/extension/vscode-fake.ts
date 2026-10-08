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
    static joinPath(base: Uri, ...parts: string[]): Uri {
        return new Uri([base.fsPath, ...parts].join('/'));
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

export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two = 2,
}

/** Every command executed through the fake, for assertions. */
export const commandLog: Array<{ command: string; args: unknown[] }> = [];
/** Handlers registered through the fake, so a test can invoke a command as VS Code would. */
export const registered = new Map<string, (...args: never[]) => unknown>();
export const commands = {
    executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
        commandLog.push({ command, args });
        const handler = registered.get(command);
        return Promise.resolve(handler ? handler(...(args as never[])) : undefined);
    },
    registerCommand(id: string, handler: (...args: never[]) => unknown): { dispose(): void } {
        registered.set(id, handler);
        return { dispose: () => registered.delete(id) };
    },
};

/** A webview panel that records what the extension sends and lets a test play the page's side. */
export class FakeWebviewPanel {
    title: string;
    iconPath: unknown;
    disposed = false;
    readonly revealed: Array<{ column: number | undefined; preserveFocus: boolean | undefined }> = [];
    private handler: ((m: unknown) => void) | undefined;
    private disposeHandler: (() => void) | undefined;
    readonly webview = {
        html: '',
        cspSource: 'fake-csp:',
        sent: [] as unknown[],
        asWebviewUri: (u: Uri) => u,
        postMessage: (m: unknown) => {
            this.webview.sent.push(m);
            return Promise.resolve(true);
        },
        onDidReceiveMessage: (l: (m: unknown) => void) => {
            this.handler = l;
            return { dispose: () => undefined };
        },
    };
    constructor(
        readonly viewType: string,
        title: string,
        readonly viewColumn: number,
        readonly options: Record<string, unknown>,
    ) {
        this.title = title;
    }
    onDidDispose(l: () => void): { dispose(): void } {
        this.disposeHandler = l;
        return { dispose: () => undefined };
    }
    private viewStateHandler: ((e: { webviewPanel: FakeWebviewPanel }) => void) | undefined;
    visible = true;
    onDidChangeViewState(l: (e: { webviewPanel: FakeWebviewPanel }) => void): { dispose(): void } {
        this.viewStateHandler = l;
        return { dispose: () => undefined };
    }
    /** The tab is hidden or shown again. */
    setVisible(visible: boolean): void {
        this.visible = visible;
        this.viewStateHandler?.({ webviewPanel: this });
    }
    reveal(column?: number, preserveFocus?: boolean): void {
        this.revealed.push({ column, preserveFocus });
    }
    /** The page posts a message to the extension. */
    receive(message: unknown): void {
        this.handler?.(message);
    }
    dispose(): void {
        this.disposed = true;
        this.disposeHandler?.();
    }
}

export const panels: FakeWebviewPanel[] = [];
/** Messages the extension showed, for assertions. */
export const messages: Array<{ kind: 'info' | 'warning' | 'error'; text: string }> = [];
const show = (kind: 'info' | 'warning' | 'error') => (text: string): Promise<undefined> => {
    messages.push({ kind, text });
    return Promise.resolve(undefined);
};
export const window = {
    showInformationMessage: show('info'),
    showWarningMessage: show('warning'),
    showErrorMessage: show('error'),
    setStatusBarMessage: (_text: string, _ms?: number) => ({ dispose: () => undefined }),
    createWebviewPanel(viewType: string, title: string, column: number, options: Record<string, unknown>): FakeWebviewPanel {
        const p = new FakeWebviewPanel(viewType, title, column, options);
        panels.push(p);
        return p;
    },
};
