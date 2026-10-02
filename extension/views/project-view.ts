import * as vscode from 'vscode';
import { PROJECT_FILE_NAME } from '../../core';
import type { NexysVhdlService } from '../services/nexys-service';
import { info, Node, openCommand, ServiceTree } from './base';

/** PROJECT: name, board, standard, top, constraints, testbench, environment. */
export class ProjectView extends ServiceTree {
    constructor(service: NexysVhdlService) {
        super(service, ['project', 'environment']);
    }

    protected roots(): Node[] {
        const snap = this.service.snapshot;
        if (!snap) return [];
        if (!snap.project) {
            const err = info('Project file has a problem', PROJECT_FILE_NAME, 'error');
            err.tooltip = snap.loadDiagnostics.map((d) => d.message).join('\n');
            err.command = openCommand(snap.root, PROJECT_FILE_NAME);
            const details = snap.loadDiagnostics.map((d) => {
                const n = info(d.message);
                n.tooltip = d.message;
                return n;
            });
            err.children = details;
            err.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            return [err];
        }
        const c = snap.project.config;
        const nodes: Node[] = [];
        const name = info(c.name, '', 'circuit-board');
        name.tooltip = snap.root;
        name.command = { title: 'Open Project Settings', command: 'nexysvhdl.openProjectSettings' };
        nodes.push(name);
        nodes.push(info('Board', snap.boardName?.replace(/^Digilent /, '') ?? `${c.board} (unsupported)`, 'chip'));
        nodes.push(info('Standard', `VHDL-${c.standard}`, 'book'));

        const top = info('Top', c.top, 'symbol-class');
        top.tooltip = 'Top-level entity for synthesis. Click to change.';
        top.command = { title: 'Set Top Entity', command: 'nexysvhdl.setTopEntity' };
        if (!snap.index.entity(c.top)) {
            top.description = `${c.top} (not found)`;
            top.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        }
        nodes.push(top);

        if (c.constraints !== undefined) {
            const xdc = info('Constraints', c.constraints.split('/').pop(), 'pinned');
            xdc.tooltip = c.constraints;
            xdc.command = openCommand(snap.root, c.constraints);
            nodes.push(xdc);
        } else if (c.pins) {
            nodes.push(info('Constraints', 'generated from "pins"', 'pinned'));
        }
        if (c.simulation?.testbench) {
            const tb = info('Testbench', c.simulation.testbench, 'beaker');
            tb.command = { title: 'Set Testbench', command: 'nexysvhdl.setTestbench' };
            nodes.push(tb);
        }

        const env = this.service.environment;
        if (env?.toolchain && env.toolchain.state !== 'ready') {
            const tc = info('FPGA toolchain', env.toolchain.state === 'not-installed' ? `not installed — click to install ${env.toolchain.requiredVersion}` : 'needs attention', 'desktop-download');
            tc.tooltip = env.problems.join('\n');
            tc.command = { title: 'Install FPGA Toolchain', command: env.toolchain.state === 'not-installed' ? 'nexysvhdl.installToolchain' : 'nexysvhdl.showEnvironment' };
            nodes.push(tc);
        }
        const envNode = info('Environment', env ? env.headline : 'checking…', env ? (env.level === 'ready' ? 'pass' : env.level === 'warning' ? 'warning' : 'error') : 'loading~spin');
        envNode.command = { title: 'Show Environment', command: 'nexysvhdl.showEnvironment' };
        if (env?.problems.length) envNode.tooltip = env.problems.join('\n');
        nodes.push(envNode);

        const problems = snap.validation.filter((d) => d.severity !== 'info');
        if (problems.length > 0) {
            const p = info(`${problems.length} project setting problem${problems.length === 1 ? '' : 's'}`, '', 'warning');
            p.tooltip = problems.map((d) => d.message).join('\n');
            p.command = { title: 'Show Problems', command: 'workbench.actions.view.problems' };
            nodes.push(p);
        }
        return nodes;
    }
}
