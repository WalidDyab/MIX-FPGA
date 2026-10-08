import * as vscode from 'vscode';
import { PROJECT_FILE_NAME } from '../../core';
import type { NexysVhdlService } from '../services/nexys-service';
import { info, Node, openCommand, ServiceTree, tint } from './base';

/**
 * PROJECT: one purpose: which project is open, which board it targets, and the toolchain environment.
 * The design (top entity, testbench, constraints, files) lives in Design; simulation and build in Workflow.
 * New / Open / Close Project are the section's header actions, not rows.
 */
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
        name.contextValue = 'nexysvhdl.project.name';
        nodes.push(name);
        const board = info(snap.boardName?.replace(/^Digilent /, '') ?? `${c.board} (unsupported)`, '', 'chip');
        board.tooltip = 'The board this project targets.';
        nodes.push(board);

        const env = this.service.environment;
        const envNode = info('Environment', env ? env.headline : 'checking…', env ? (env.level === 'ready' ? 'pass' : env.level === 'warning' ? 'warning' : 'error') : 'loading~spin');
        envNode.command = { title: 'Show Environment', command: 'nexysvhdl.showEnvironment' };
        envNode.contextValue = 'nexysvhdl.project.environment';
        if (env?.problems.length) envNode.tooltip = env.problems.join('\n');
        nodes.push(envNode);
        return tint(nodes, 'charts.blue');
    }
}
