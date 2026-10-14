import type { HardwareView } from '../../runtime/setup';
import { boardRow } from '../services/environment-summary';
import type { HardwareState } from '../services/hardware-state';

/** The Setup page's Hardware row, from the same hardware state the Hardware view uses. */
export function hardwareViewOf(hardware: HardwareState): HardwareView {
    const row = boardRow(hardware, 'Hardware');
    switch (row.state) {
        case 'ready':
            return { state: 'ready', word: hardware.boards.map((b) => b.productName ?? 'Board').join(', ') || 'Connected' };
        case 'not-connected':
            return { state: 'not-connected', word: 'Not connected', hint: 'Connect the board by USB and turn it on to program it.' };
        default:
            return { state: 'not-checked', word: 'Not checked' };
    }
}
