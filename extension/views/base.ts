import * as vscode from 'vscode';
import type { ChangeKind, NexysVhdlService } from '../services/nexys-service';
import type { ActionState } from '../services/workflow-state';

/** A tree view node: a TreeItem plus optional children and a payload for commands. */
export class Node extends vscode.TreeItem {
    children?: Node[];
    /** What context-menu commands receive (e.g. an entity name or file path). */
    payload?: unknown;

    constructor(label: string | vscode.TreeItemLabel, collapsible = vscode.TreeItemCollapsibleState.None) {
        super(label, collapsible);
    }
}

/** TreeDataProvider that rebuilds its nodes when the service reports one of `kinds`. */
export abstract class ServiceTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly sub: { dispose(): void };

    constructor(
        protected readonly service: NexysVhdlService,
        kinds: readonly ChangeKind[],
    ) {
        this.sub = service.onDidChange((k) => {
            if (kinds.includes(k)) this.changed.fire(undefined);
        });
    }

    protected abstract roots(): Node[];

    getTreeItem(node: Node): vscode.TreeItem {
        return node;
    }

    getChildren(node?: Node): Node[] {
        return node ? (node.children ?? []) : this.roots();
    }

    refresh(): void {
        this.changed.fire(undefined);
    }

    dispose(): void {
        this.sub.dispose();
        this.changed.dispose();
    }
}

export function info(label: string, description?: string, icon?: string): Node {
    const n = new Node(label);
    if (description !== undefined) n.description = description;
    if (icon) n.iconPath = new vscode.ThemeIcon(icon);
    return n;
}

/** Icon for a workflow state: circle, spinner, green check, red cross. */
export function stateIcon(state: ActionState): vscode.ThemeIcon {
    switch (state) {
        case 'running':
            return new vscode.ThemeIcon('loading~spin');
        case 'passed':
            return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
        case 'failed':
            return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        case 'unavailable':
            return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
        case 'idle':
            return new vscode.ThemeIcon('circle-large-outline');
    }
}

/** Command that opens a project-relative file, optionally at a 1-based line/column. */
export function openCommand(root: string, file: string, line?: number, col?: number): vscode.Command {
    return { title: 'Open', command: 'nexysvhdl.openLocation', arguments: [root, file, line, col] };
}
