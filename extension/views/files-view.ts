import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ProjectFileEntry } from '../project/project-layout';
import type { NexysVhdlService } from '../services/nexys-service';
import { info, Node, openCommand, ServiceTree } from './base';

type Group = 'source' | 'simulation' | 'constraints';

/**
 * PROJECT FILES: the logical FPGA-project view (Sources, Simulation,
 * Constraints) — not a second Explorer. `.nexysvhdl/` is never shown.
 */
export class FilesView extends ServiceTree {
    constructor(service: NexysVhdlService) {
        super(service, ['project']);
    }

    private fileNode(root: string, f: ProjectFileEntry, group: Group): Node {
        const n = new Node(f.name);
        n.resourceUri = vscode.Uri.file(join(root, ...f.path.split('/')));
        n.iconPath = vscode.ThemeIcon.File;
        n.tooltip = f.path;
        n.payload = f.path;
        const tags: string[] = [];
        if (f.folder) tags.push(f.folder);
        if (f.top) tags.push('TOP');
        if (f.testbench) tags.push('TESTBENCH');
        if (group === 'constraints') tags.push(f.inUse ? 'IN USE' : 'not used');
        if (f.outside) tags.push('outside the standard folder');
        if (f.missing) tags.push('missing');
        n.description = tags.join('  ');
        n.contextValue = `nexysvhdl.${group}`;
        if (!f.missing) n.command = openCommand(root, f.path);
        else n.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        return n;
    }

    protected roots(): Node[] {
        const snap = this.service.snapshot;
        if (!snap) return [];
        const { files, root } = snap;
        const group = (label: string, icon: string, entries: readonly ProjectFileEntry[], kind: Group, empty: string): Node => {
            const g = new Node(label, vscode.TreeItemCollapsibleState.Expanded);
            g.iconPath = new vscode.ThemeIcon(icon);
            g.contextValue = 'nexysvhdl.group';
            g.children = entries.length ? entries.map((f) => this.fileNode(root, f, kind)) : [info(empty)];
            return g;
        };
        const constraints = group('Constraints', 'pinned', files.constraints, 'constraints', `No ${files.constraintExtensions} files in constraints/`);
        if (files.generatedConstraints) {
            const gen = info('Generated from "pins" in nexysvhdl.json', '', 'gear');
            gen.tooltip = 'This project lists pin mappings instead of an XDC file. Right-click an .xdc file and choose "Use This Constraints File" to switch.';
            constraints.children = [gen, ...(files.constraints.length ? constraints.children! : [])];
        }
        const nodes = [
            group('Sources', 'file-code', files.sources, 'source', 'No .vhd files in src/'),
            group('Simulation', 'beaker', files.simulation, 'simulation', 'No .vhd files in sim/'),
            constraints,
        ];
        if (snap.excluded.length > 0) {
            const g = new Node('Removed from project', vscode.TreeItemCollapsibleState.Collapsed);
            g.id = 'group:removed';
            g.description = String(snap.excluded.length);
            g.iconPath = new vscode.ThemeIcon('circle-slash');
            g.tooltip = 'These files are still on disk but are not part of the project. Right-click a file and choose "Add Back to Project".';
            g.children = snap.excluded.map((p) => {
                const n = new Node(p.slice(p.lastIndexOf('/') + 1));
                n.id = `removed:${p}`;
                n.resourceUri = vscode.Uri.file(join(root, ...p.split('/')));
                n.iconPath = vscode.ThemeIcon.File;
                n.tooltip = p;
                n.description = p.slice(0, p.lastIndexOf('/'));
                n.payload = p;
                n.contextValue = 'nexysvhdl.removed';
                n.command = openCommand(root, p);
                return n;
            });
            nodes.push(g);
        }
        return nodes;
    }
}
