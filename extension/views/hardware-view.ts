import * as vscode from 'vscode';
import { hardwareHeadline } from '../services/hardware-state';
import type { NexysVhdlService } from '../services/nexys-service';
import { info, Node, ServiceTree, tint } from './base';

/** HARDWARE: connected boards, the student's choice among several, detection problems. */
export class HardwareView extends ServiceTree {
    constructor(service: NexysVhdlService) {
        super(service, ['hardware', 'project']);
    }

    protected roots(): Node[] {
        const snap = this.service.snapshot;
        if (!snap?.project) return [];
        const hw = this.service.hardware;
        const boardName = (snap.boardName ?? 'board').replace(/^Digilent /, '');
        const short = boardName.replace(/-\d+T$/, '');
        const nodes: Node[] = [];
        const refresh: vscode.Command = { title: 'Detect Boards', command: 'nexysvhdl.detectBoards' };

        switch (hw.status) {
            case 'unknown': {
                const n = info('Not checked yet', 'click to detect', 'circle-large-outline');
                n.command = refresh;
                nodes.push(n);
                break;
            }
            case 'detecting':
                nodes.push(info('Looking for boards…', '', 'loading~spin'));
                break;
            case 'unavailable': {
                const n = info('Programmer not set up', 'Show Environment', 'circle-slash');
                n.command = { title: 'Show Environment', command: 'nexysvhdl.showEnvironment' };
                nodes.push(n);
                break;
            }
            case 'none': {
                const n = info(hardwareHeadline(hw, short), '', 'circle-large-outline');
                n.command = refresh;
                nodes.push(n, info('Connect your board by USB and turn it on.', '', 'info'));
                break;
            }
            case 'one': {
                const b = hw.boards[0]!;
                const n = info(boardName, b.serialNumber ?? '', 'circle-filled');
                n.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
                n.tooltip = `${b.productName ?? boardName}${b.serialNumber ? `\nSerial ${b.serialNumber}` : ''}${b.transport ? `\n${b.transport}` : ''}`;
                nodes.push(n);
                break;
            }
            case 'many': {
                nodes.push(info(hardwareHeadline(hw, short), hw.selectedSerial ? `using ${hw.selectedSerial}` : 'choose one', 'circuit-board'));
                for (const b of hw.boards) {
                    const serial = b.serialNumber ?? b.selector;
                    const selected = serial === hw.selectedSerial;
                    const n = info(serial, b.productName ?? '', selected ? 'circle-filled' : 'circle-large-outline');
                    if (selected) n.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
                    n.contextValue = selected ? 'nexysvhdl.board' : 'nexysvhdl.board.selectable';
                    n.command = { title: 'Use This Board', command: 'nexysvhdl.selectBoard', arguments: [serial] };
                    n.tooltip = selected ? 'Program will use this board.' : 'Click to program this board.';
                    nodes.push(n);
                }
                break;
            }
        }
        for (const d of hw.diagnostics) {
            const n = info(d.message, '', d.severity === 'error' ? 'error' : 'warning');
            n.tooltip = d.message;
            nodes.push(n);
        }
        return tint(nodes, 'charts.orange');
    }
}
