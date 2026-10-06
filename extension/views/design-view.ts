import * as vscode from 'vscode';
import type { NexysVhdlService } from '../services/nexys-service';
import { FilesView } from './files-view';
import { HierarchyView } from './hierarchy-view';
import { info, Node, ServiceTree } from './base';

export type DesignMode = 'files' | 'hierarchy';

export const DESIGN_MODE_KEY = 'nexysvhdl.designMode';
const STORED_MODE = 'nexysvhdl.design.mode';

/**
 * DESIGN: the single student-facing view of the design, in two modes. Files
 * (the default: it is where a project starts) lists Sources, Simulation and
 * Constraints with a prominent "+ Add File"; Hierarchy shows the structure
 * from the top entity and the schematics. Both modes are the former Project
 * Files and Design Hierarchy trees, reused unchanged, so every capability
 * (set top, use XDC, open schematic, go to entity, ...) is still there.
 * The last mode is remembered per workspace.
 */
export class DesignView extends ServiceTree {
    private readonly files: FilesView;
    private readonly hierarchy: HierarchyView;
    private current: DesignMode;
    private readonly modeChanged = new vscode.EventEmitter<DesignMode>();
    readonly onDidChangeMode = this.modeChanged.event;

    constructor(
        service: NexysVhdlService,
        private readonly state?: vscode.Memento,
    ) {
        super(service, ['project', 'workflow', 'rtl']);
        this.files = new FilesView(service);
        this.hierarchy = new HierarchyView(service);
        const stored = state?.get<string>(STORED_MODE);
        this.current = stored === 'hierarchy' ? 'hierarchy' : 'files';
    }

    get mode(): DesignMode {
        return this.current;
    }

    setMode(mode: DesignMode): void {
        if (mode === this.current) return;
        this.current = mode;
        void this.state?.update(STORED_MODE, mode);
        this.modeChanged.fire(mode);
        this.refresh();
    }

    protected roots(): Node[] {
        if (!this.service.snapshot) return [];
        if (this.current === 'hierarchy') return this.hierarchy.getChildren();
        const add = info('+ Add File', 'source · testbench · constraint', 'add');
        add.id = 'design:add-file';
        add.tooltip = 'Create a new VHDL source, testbench or XDC constraints file, or copy one into the project.';
        add.command = { title: 'Add File', command: 'nexysvhdl.addFile' };
        return [add, ...this.files.getChildren()];
    }

    override dispose(): void {
        this.files.dispose();
        this.hierarchy.dispose();
        this.modeChanged.dispose();
        super.dispose();
    }
}
