import type { DeviceCapacity } from '../board/types';
import type { ResourceUsage, ResourceUtilization } from './types';

/**
 * Replaces placer-internal capacities with the device's engineering capacity
 * from board metadata, so students see the numbers Vivado and the data sheet
 * use. Used counts stay the placer's: LUT cells placed, flip-flops, DSPs,
 * block RAM (36 Kb equivalents: RAMB36 + RAMB18 / 2) and bonded I/O pads.
 * The raw placer figures remain in `device` for engineering views.
 *
 * nextpnr-xilinx reports `SLICE_LUTX` capacity as 126,800 for the XC7A100T:
 * every LUT6 site is two bels (6-input and 5-input halves), 15,850 slices x 4
 * x 2. The device has 63,400 LUTs. Its `PAD` capacity counts all package pads
 * of the die model, not the 210 user I/O of the CSG324 package.
 */
export function applyDeviceCapacity(utilization: ResourceUtilization, capacity: DeviceCapacity): ResourceUtilization {
    const device = utilization.device ?? {};
    const used = (u: ResourceUsage | undefined) => u?.used ?? 0;
    const bram36Used = used(device['RAMB36E1_RAMB36E1']) + used(device['RAMB18E1_RAMB18E1']) / 2;
    const withCapacity = (u: ResourceUsage | undefined, available: number): ResourceUsage => ({ used: used(u), available });
    return {
        ...utilization,
        luts: withCapacity(utilization.luts, capacity.luts),
        flipFlops: withCapacity(utilization.flipFlops, capacity.flipFlops),
        bram: { used: bram36Used, available: capacity.bram36 },
        dsp: withCapacity(utilization.dsp, capacity.dsp),
        io: withCapacity(utilization.io, capacity.userIo),
        ...(capacity.globalClockBuffers !== undefined ? { globalClockBuffers: withCapacity(utilization.globalClockBuffers, capacity.globalClockBuffers) } : {}),
        capacitySource: capacity.source,
    };
}
