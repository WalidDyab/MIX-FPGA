import type { BoardProfile } from './types';

/**
 * Terasic DE10-Lite. Device and pins: Terasic DE10-Lite User Manual v1.7 (Tables 3-2, 3-5, section 1).
 * JTAG IDCODE 0x031050DD = 10M50DA, read from the real board in Phase 1.
 */
export const DE10_LITE_PROFILE: BoardProfile = {
    id: 'de10-lite',
    name: 'Terasic DE10-Lite',
    displayName: 'DE10-Lite',
    vendor: 'Terasic',
    fpga: { family: 'MAX 10', device: '10M50DAF484C7G', jtagIdcode: 0x031050dd },
    constraintFormat: 'qsf-sdc',
    implementationProviderId: 'quartus',
    programmingProviderId: 'native-jtag',
    programmingFormat: 'svf',
    programmerBoardKey: 'de10lite',
    metricLabels: { logic: 'Logic Elements', registers: 'Registers', memory: 'Memory Bits', dsp: 'DSP Blocks' },
    hosts: ['macos-arm64', 'windows-x64'],
    identification: { usb: { vendorId: '09fb', productId: '6001' }, productNames: ['USB-Blaster'] },
};

export const BOARD_PROFILES: Readonly<Record<string, BoardProfile>> = { [DE10_LITE_PROFILE.id]: DE10_LITE_PROFILE };
