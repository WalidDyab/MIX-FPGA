import * as vscode from 'vscode';
import type { HierarchyNode } from '../hierarchy/hierarchy';
import type { NexysVhdlService } from '../services/nexys-service';
import { info, Node, openCommand, ServiceTree } from './base';

/** What hierarchy context-menu commands receive. */
export interface HierarchyPayload {
    readonly entity: string;
    /** Hierarchy node id (for the schematic). */
    readonly id?: string;
    readonly entityFile?: string;
    readonly entityLine?: number;
}

/**
 * DESIGN HIERARCHY: logical VHDL structure from the configured top entity,
 * built by the editor-time indexer (refreshed on save; no FPGA tools run).
 */
export class HierarchyView extends ServiceTree {
    constructor(service: NexysVhdlService) {
        super(service, ['project', 'workflow', 'rtl']);
    }

    private node(root: string, h: HierarchyNode, isTop: boolean, simulation = false): Node {
        const label = h.kind === 'instance' ? `${h.label} : ${h.entityName}` : h.entityName;
        const n = new Node(label, h.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        n.id = `${simulation ? 'sim:' : ''}${h.id}`;
        const tags: string[] = [];
        if (isTop) tags.push('TOP');
        if (h.status === 'unresolved') tags.push('not found');
        if (h.status === 'external') tags.push(h.note ?? 'external');
        if (h.status === 'recursive') tags.push('recursive');
        if (h.instance?.generate.length) tags.push(`in ${h.instance.generate.join('/')}`);
        n.description = tags.join('  ');
        n.iconPath =
            h.status === 'unresolved'
                ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
                : h.status === 'external'
                  ? new vscode.ThemeIcon('library')
                  : h.status === 'recursive'
                    ? new vscode.ThemeIcon('sync')
                    : new vscode.ThemeIcon(isTop ? 'circuit-board' : h.kind === 'instance' ? 'symbol-module' : 'symbol-class');
        const where = h.location;
        n.tooltip = new vscode.MarkdownString(
            [
                h.kind === 'instance' ? `**${h.label}** — instance of \`${h.entityName}\`` : `**${h.entityName}**${isTop ? ' — top entity' : ''}`,
                h.entity ? `Entity in \`${h.entity.file}\`${h.architecture ? `, architecture \`${h.architecture.decl.name}\`` : ''}` : '',
                h.note ?? '',
            ]
                .filter(Boolean)
                .join('\n\n'),
        );
        if (where) n.command = openCommand(root, where.file, where.line, where.col);
        if (h.entity) {
            const payload: HierarchyPayload = { entity: h.entity.decl.name, id: h.id, entityFile: h.entity.file, entityLine: h.entity.decl.line };
            n.payload = payload;
            n.contextValue = isTop ? 'nexysvhdl.topEntity' : simulation || h.entity.role === 'simulation' ? 'nexysvhdl.simEntity' : 'nexysvhdl.entity';
        }
        n.children = h.children.map((c) => this.node(root, c, false, simulation));
        return n;
    }

    protected roots(): Node[] {
        const snap = this.service.snapshot;
        if (!snap?.project) return [];
        const { hierarchy, root } = snap;
        const nodes: Node[] = [];
        if (hierarchy.root) {
            nodes.push(this.node(root, hierarchy.root, true));
        } else {
            const missing = info(hierarchy.top.trim() === '' ? 'No top entity is set' : `Top entity "${hierarchy.top}" not found`, 'Set Top Entity…', 'warning');
            missing.command = { title: 'Set Top Entity', command: 'nexysvhdl.setTopEntity' };
            nodes.push(missing);
        }
        if (hierarchy.unreachable.length > 0) {
            const g = new Node(`Not used by ${hierarchy.top}`, vscode.TreeItemCollapsibleState.Collapsed);
            g.id = 'group:unreachable';
            g.description = String(hierarchy.unreachable.length);
            g.iconPath = new vscode.ThemeIcon('circle-slash');
            g.tooltip = 'Entities in src/ that the top entity does not instantiate (directly or indirectly).';
            g.children = hierarchy.unreachable.map((e) => {
                const n = info(e.decl.name, e.file, 'symbol-class');
                n.id = `unreachable:${e.decl.name}`;
                n.command = openCommand(root, e.file, e.decl.line, e.decl.col);
                const payload: HierarchyPayload = { entity: e.decl.name, entityFile: e.file, entityLine: e.decl.line };
                n.payload = payload;
                n.contextValue = 'nexysvhdl.entity';
                return n;
            });
            nodes.push(g);
        }
        if (hierarchy.testbenches.length > 0) {
            const g = new Node('Testbenches', vscode.TreeItemCollapsibleState.Collapsed);
            g.id = 'group:testbenches';
            g.iconPath = new vscode.ThemeIcon('beaker');
            g.children = hierarchy.testbenches.map((tb) => this.node(root, tb, false, true));
            nodes.push(g);
        }
        // Both schematic views, side by side with the tree they illustrate.
        const design = info('Design Schematic', 'structure: instances and port maps', 'type-hierarchy');
        design.id = 'open:design-schematic';
        design.command = { title: 'Open Design Schematic', command: 'nexysvhdl.openSchematic' };
        const checked = this.service.workflow.check.state === 'passed';
        const rtl = info('RTL Schematic', checked ? 'inferred hardware (synthesis)' : 'available after a passed Check', 'circuit-board');
        rtl.id = 'open:rtl-schematic';
        rtl.command = { title: 'Open RTL Schematic', command: 'nexysvhdl.openRtlSchematic' };
        nodes.push(design, rtl);
        for (const p of snap.index.problems) {
            const n = info(p.message, '', 'warning');
            n.tooltip = p.message;
            if (p.file) n.command = openCommand(root, p.file, p.line);
            nodes.push(n);
        }
        return nodes;
    }
}
