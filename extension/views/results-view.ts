import * as vscode from 'vscode';
import type { LogRef } from '../../core';
import type { NexysVhdlService } from '../services/nexys-service';
import { buildResultsModel, type ResultRow } from '../services/results-model';
import { info, Node, ServiceTree, tint } from './base';

/** RESULTS: latest Check, Simulation and Build results, from the Phase 3 result objects. */
export class ResultsView extends ServiceTree {
    constructor(service: NexysVhdlService) {
        super(service, ['results', 'project']);
    }

    private rows(rows: readonly ResultRow[]): Node[] {
        return rows.map((r) => {
            const n = info(r.label, r.value);
            if (r.good === true) n.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
            else if (r.good === false) n.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
            return n;
        });
    }

    private logs(logs: readonly LogRef[]): Node[] {
        if (logs.length === 0) return [];
        const g = new Node('Logs', vscode.TreeItemCollapsibleState.Collapsed);
        g.iconPath = new vscode.ThemeIcon('output');
        g.children = logs.map((l) => {
            const n = info(l.label, '', 'file-text');
            n.tooltip = l.path;
            n.command = { title: 'Open Log', command: 'vscode.open', arguments: [vscode.Uri.file(l.path)] };
            return n;
        });
        return [g];
    }

    private section(id: string, label: string, ok: boolean, summary: string, children: Node[]): Node {
        const n = new Node(label, vscode.TreeItemCollapsibleState.Expanded);
        n.id = `results:${id}`;
        n.description = summary;
        n.iconPath = ok ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed')) : new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        n.children = children;
        return n;
    }

    protected roots(): Node[] {
        if (!this.service.project) return [];
        const m = buildResultsModel(this.service.lastCheck, this.service.lastSimulation, this.service.lastBuild);
        const nodes: Node[] = [];
        if (m.build) {
            const b = m.build;
            const children: Node[] = [...this.rows(b.timing)];
            if (b.resources.length > 0) {
                const res = new Node('Resources', vscode.TreeItemCollapsibleState.Expanded);
                res.iconPath = new vscode.ThemeIcon('dashboard');
                res.children = this.rows(b.resources);
                children.push(res);
            }
            if (b.bitstream) children.push(...this.rows([b.bitstream]));
            children.push(...this.logs(b.logs));
            nodes.push(this.section('build', 'Build', b.success, b.success ? 'BUILD COMPLETE' : 'BUILD FAILED', children));
        }
        if (m.simulation) {
            const s = m.simulation;
            const children = this.rows(s.rows);
            if (s.messages.length > 0) {
                const msgs = new Node('Testbench messages', vscode.TreeItemCollapsibleState.Collapsed);
                msgs.iconPath = new vscode.ThemeIcon('comment');
                msgs.children = s.messages.map((t) => {
                    const n = info(t);
                    n.tooltip = t;
                    return n;
                });
                children.push(msgs);
            }
            children.push(...this.logs(s.logs));
            nodes.push(this.section('simulation', 'Simulation', s.passed, s.passed ? 'Passed' : 'Failed', children));
        }
        if (m.check) {
            nodes.push(this.section('check', 'Check', m.check.passed, m.check.passed ? 'No VHDL errors' : 'Errors found', [...this.rows(m.check.rows), ...this.logs(m.check.logs)]));
        }
        if (nodes.length === 0) nodes.push(info('No results yet', 'run Check, Simulate or Build', 'info'));
        return tint(nodes, 'charts.purple');
    }
}
