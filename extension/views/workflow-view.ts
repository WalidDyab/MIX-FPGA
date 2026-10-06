import * as vscode from 'vscode';
import type { NexysVhdlService } from '../services/nexys-service';
import type { ActionStatus, BuildStageId, WorkflowAction } from '../services/workflow-state';
import { Node, ServiceTree, stateIcon } from './base';

const STAGE_TEXT: Record<BuildStageId, { label: string; idle: string; tooltip: string }> = {
    synthesis: { label: 'Synthesis', idle: 'VHDL → logic netlist', tooltip: 'Turns your VHDL into a netlist of FPGA logic: LUTs, flip-flops, block RAM and DSP blocks.' },
    implementation: { label: 'Implementation', idle: 'placement · routing · timing', tooltip: 'Places the netlist on the FPGA, routes the wires, assigns your pins and checks that the design meets the clock frequency.' },
    bitstream: { label: 'Bitstream', idle: '→ hardware.bit', tooltip: 'Converts the implemented design into hardware.bit, the file that configures the FPGA.' },
};

const ACTIONS: Record<WorkflowAction, { label: string; command: string; tooltip: string }> = {
    check: { label: 'Check', command: 'nexysvhdl.check', tooltip: 'Analyse and elaborate the VHDL (errors appear in the Problems panel).' },
    simulate: { label: 'Simulate', command: 'nexysvhdl.simulate', tooltip: 'Run the testbench and report pass/fail.' },
    build: { label: 'Build', command: 'nexysvhdl.build', tooltip: 'Synthesis → Implementation → Bitstream.' },
    program: { label: 'Program', command: 'nexysvhdl.program', tooltip: 'Load the bitstream into the FPGA (SRAM: lost when the board is switched off).' },
};

const BUSY_TEXT: Record<WorkflowAction | 'rtl', string> = { check: 'Check is running', simulate: 'Simulation is running', build: 'Build is running', program: 'Programming is running', rtl: 'RTL schematic is generating' };

/** WORKFLOW: Check, Simulate, Build (Synthesis / Implementation / Bitstream), Program. */
export class WorkflowView extends ServiceTree {
    constructor(service: NexysVhdlService) {
        super(service, ['workflow', 'project', 'results', 'rtl', 'busy']);
    }

    private action(id: WorkflowAction, status: ActionStatus, expanded = false): Node {
        const a = ACTIONS[id];
        const n = new Node(a.label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        n.id = `action:${id}`;
        n.iconPath = stateIcon(status.state);
        n.description = status.summary ?? '';
        n.tooltip = `${a.tooltip}${status.summary ? `\n\n${status.summary}` : ''}`;
        // While any pipeline operation runs, the other actions are visibly unavailable and lose their inline buttons.
        const holder = this.service.busyAction;
        n.contextValue = holder ? 'nexysvhdl.action.busy' : `nexysvhdl.action.${id}`;
        if (holder && holder !== id && !status.summary) n.description = `wait — ${BUSY_TEXT[holder]}`;
        n.command = { title: a.label, command: a.command };
        return n;
    }

    protected roots(): Node[] {
        if (!this.service.project) return [];
        const w = this.service.workflow;
        const link = (id: string, label: string, icon: string, command: string, description?: string) => {
            const n = new Node(label);
            n.id = id;
            n.iconPath = new vscode.ThemeIcon(icon);
            n.command = { title: label, command };
            if (description) n.description = description;
            return n;
        };
        const check = this.action('check', w.check, w.check.state === 'passed');
        if (w.check.state === 'passed') {
            const rtl = this.service.rtl;
            check.children = [
                link('action:schematic', 'Open Design Schematic', 'type-hierarchy', 'nexysvhdl.openSchematic', 'structure'),
                link('action:rtl', 'Open RTL Schematic', 'circuit-board', 'nexysvhdl.openRtlSchematic', rtl.status === 'running' ? 'generating…' : this.service.rtlStale ? 'out of date' : 'inferred hardware'),
            ];
        }
        const sim = this.service.lastSimulation;
        const simulate = this.action('simulate', w.simulate, !!sim?.vcd);
        if (sim?.vcd) simulate.children = [link('action:waveform', 'Open Waveform', 'pulse', 'nexysvhdl.openWaveform', `run ${this.service.simulationRun}`)];
        const build = this.action('build', w.build, true);
        build.children = (['synthesis', 'implementation', 'bitstream'] as const).map((id) => {
            const s = w.stages[id];
            const t = STAGE_TEXT[id];
            const n = new Node(t.label);
            n.id = `stage:${id}`;
            n.iconPath = stateIcon(s.state);
            n.description = s.summary ?? (s.state === 'idle' ? t.idle : '');
            n.tooltip = t.tooltip;
            return n;
        });
        return [check, simulate, build, this.action('program', w.program)];
    }
}
