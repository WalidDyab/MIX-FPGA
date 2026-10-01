import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { NexysVhdlService } from '../services/nexys-service';
import { collectProblems, type ProblemEntry, squiggleEnd } from './problems';

const SEVERITY = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
} as const;

/** Converts one problem entry into a vscode.Diagnostic; `lineText` widens the range to the token at the column. */
export function toVsDiagnostic(entry: ProblemEntry, lineText: string | undefined): vscode.Diagnostic {
    let range: vscode.Range;
    if (entry.column !== undefined) {
        const end = lineText !== undefined ? squiggleEnd(lineText, entry.column) : entry.column + 1;
        range = new vscode.Range(entry.line, entry.column, entry.line, end);
    } else {
        range = new vscode.Range(entry.line, 0, entry.line, lineText?.length ?? Number.MAX_SAFE_INTEGER);
    }
    const d = new vscode.Diagnostic(range, entry.message, SEVERITY[entry.severity]);
    d.source = entry.source;
    d.code = entry.code;
    return d;
}

function lineOf(file: string, line: number, cache: Map<string, string[] | undefined>): string | undefined {
    if (!cache.has(file)) {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
        try {
            cache.set(file, (open ? open.getText() : readFileSync(file, 'utf8')).split(/\r?\n/));
        } catch {
            cache.set(file, undefined);
        }
    }
    return cache.get(file)?.[line];
}

/** Publishes the service's structured diagnostics to the Problems panel and editor squiggles. */
export class ProblemsPublisher implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('nexysvhdl');
    private readonly sub: { dispose(): void };

    constructor(private readonly service: NexysVhdlService) {
        this.sub = service.onDidChange((k) => {
            if (k === 'problems' || k === 'project') this.publish();
        });
    }

    publish(): void {
        this.collection.clear();
        const root = this.service.projectRoot;
        if (!root) return;
        const cache = new Map<string, string[] | undefined>();
        for (const [file, entries] of collectProblems(root, this.service.problems)) {
            this.collection.set(
                vscode.Uri.file(file),
                entries.map((e) => toVsDiagnostic(e, lineOf(file, e.line, cache))),
            );
        }
    }

    dispose(): void {
        this.sub.dispose();
        this.collection.dispose();
    }
}
