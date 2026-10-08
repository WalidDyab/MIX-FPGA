import * as vscode from 'vscode';
import { EMPTY_PROJECT_MESSAGE } from '../project/empty-project';
import type { NexysVhdlService } from '../services/nexys-service';
import type { StateStore } from '../services/project-state';
import { FilesView } from './files-view';
import { HierarchyView } from './hierarchy-view';
import { info, Node, ServiceTree } from './base';

export type DesignMode = 'files' | 'hierarchy';

/** Project-state key of the remembered Design mode. */
export const DESIGN_MODE_STATE_KEY = 'nexysvhdl.design.mode';
export const DESIGN_MODE_KEY = 'nexysvhdl.designMode';
const STORED_MODE = DESIGN_MODE_STATE_KEY;

/**
 * DESIGN: the single student-facing view of the design, in two modes. Files
 * (the default: it is where a project starts) lists Sources, Simulation and
 * Constraints with a prominent "+ Add File"; Hierarchy shows the structure
 * from the top entity and the schematics. Both modes are the former Project
 * Files and Design Hierarchy trees, reused unchanged, so every capability
 * (set top, use XDC, open schematic, go to entity, ...) is still there.
 * The last mode is remembered with the project.
 */
export class DesignView extends ServiceTree {
    private readonly files: FilesView;
    private readonly hierarchy: HierarchyView;
    private current: DesignMode;
    private readonly modeChanged = new vscode.EventEmitter<DesignMode>();
    readonly onDidChangeMode = this.modeChanged.event;

    constructor(
        service: NexysVhdlService,
        private readonly state?: StateStore,
    ) {
        super(service, ['project', 'workflow', 'rtl']);
        this.files = new FilesView(service);
        this.hierarchy = new HierarchyView(service);
        const stored = state?.get<string>(STORED_MODE);
        this.current = stored === 'hierarchy' ? 'hierarchy' : 'files';
    }

    /** The project's remembered state was (re)loaded: show the remembered mode. */
    reload(): void {
        const stored = this.state?.get<string>(STORED_MODE) === 'hierarchy' ? 'hierarchy' : 'files';
        if (stored === this.current) return;
        this.current = stored;
        this.modeChanged.fire(stored);
        this.refresh();
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

    /** The one primary file action, shown first in both modes. It runs the same command: Add File. */
    private addFileNode(): Node {
        const add = info('+ Add File', 'source · testbench · constraint', 'add');
        add.id = 'design:add-file';
        add.tooltip = 'Create a new VHDL source, testbench or XDC constraints file, or copy files into the project.';
        add.command = { title: 'Add File', command: 'nexysvhdl.addFile' };
        return add;
    }

    protected roots(): Node[] {
        if (!this.service.snapshot) return [];
        const hint: Node[] = [];
        if (this.service.snapshot.emptyProject) {
            const n = info(EMPTY_PROJECT_MESSAGE, 'no top entity yet', 'lightbulb');
            n.id = 'design:empty-hint';
            hint.push(n);
        }
        return [this.addFileNode(), ...hint, ...(this.current === 'hierarchy' ? this.hierarchy : this.files).getChildren()];
    }

    override dispose(): void {
        this.files.dispose();
        this.hierarchy.dispose();
        this.modeChanged.dispose();
        super.dispose();
    }
}
