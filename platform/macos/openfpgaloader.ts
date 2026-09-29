/**
 * Pure parsers for openFPGALoader 1.1.x output, written against real output
 * recorded on the M4 Mac (tests/platform/macos/fixtures). No process calls here.
 */

/** `openFPGALoader v1.1.1` -> `1.1.1` */
export function parseOpenFpgaLoaderVersion(text: string): string | undefined {
    return /openFPGALoader\s+v?(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

/** One USB probe from `openFPGALoader --scan-usb`. */
export interface UsbProbe {
    readonly bus: number;
    readonly device: number;
    /** Lower-case 4-digit hex, e.g. `0403`. */
    readonly vendorId: string;
    readonly productId: string;
    readonly probeType: string;
    readonly manufacturer?: string;
    readonly serialNumber?: string;
    readonly product?: string;
}

/**
 * Rows of `--scan-usb`:
 *   Bus device vid:pid       probe_type manufacturer serial               product
 *   001 004    0x0403:0x6010 FTDI2232   Digilent     210292BCFFE4         Digilent USB Device
 */
export function parseScanUsb(text: string): UsbProbe[] {
    const probes: UsbProbe[] = [];
    const row = /^\s*(\d+)\s+(\d+)\s+0x([0-9a-f]{4}):0x([0-9a-f]{4})\s+(\S+)\s*(.*)$/i;
    for (const line of text.split(/\r?\n/)) {
        const m = row.exec(line);
        if (!m) continue;
        const [manufacturer, serialNumber, ...product] = m[6]!.trim().split(/\s+/).filter(Boolean);
        probes.push({
            bus: Number(m[1]),
            device: Number(m[2]),
            vendorId: m[3]!.toLowerCase(),
            productId: m[4]!.toLowerCase(),
            probeType: m[5]!,
            ...(manufacturer ? { manufacturer } : {}),
            ...(serialNumber ? { serialNumber } : {}),
            ...(product.length ? { product: product.join(' ') } : {}),
        });
    }
    return probes;
}

/** One device on the JTAG chain from `--detect`. */
export interface JtagDevice {
    readonly index: number;
    readonly idcode: number;
    readonly manufacturer?: string;
    readonly family?: string;
    readonly model?: string;
    readonly irLength?: number;
}

/**
 * `--detect` output:
 *   index 0:
 *       idcode 0x3631093
 *       manufacturer xilinx
 *       family artix a7 100t
 *       model  xc7a100
 *       irlength 6
 */
export function parseDetect(text: string): JtagDevice[] {
    const devices: JtagDevice[] = [];
    let current: { index: number; fields: Record<string, string> } | undefined;
    const flush = () => {
        if (!current || current.fields['idcode'] === undefined) return;
        const f = current.fields;
        devices.push({
            index: current.index,
            idcode: Number.parseInt(f['idcode']!, 16),
            ...(f['manufacturer'] ? { manufacturer: f['manufacturer'] } : {}),
            ...(f['family'] ? { family: f['family'] } : {}),
            ...(f['model'] ? { model: f['model'] } : {}),
            ...(f['irlength'] ? { irLength: Number(f['irlength']) } : {}),
        });
    };
    for (const line of text.split(/\r?\n/)) {
        const idx = /^\s*index\s+(\d+):/.exec(line);
        if (idx) {
            flush();
            current = { index: Number(idx[1]), fields: {} };
            continue;
        }
        const field = /^\s*(idcode|manufacturer|family|model|irlength)\s+(.+?)\s*$/.exec(line);
        if (field && current) current.fields[field[1]!] = field[1] === 'idcode' ? field[2]!.replace(/^0x/i, '') : field[2]!;
    }
    flush();
    return devices;
}

/** Xilinx IDCODEs carry a silicon revision in bits 31..28; compare the rest. */
export function sameIdcodeIgnoringRevision(a: number, b: number): boolean {
    return (a & 0x0fffffff) === (b & 0x0fffffff);
}

/** Configuration status line printed after an SRAM load. */
export interface ConfigurationStatus {
    readonly iscDone: number;
    readonly iscEna: number;
    readonly init: number;
    readonly done: number;
}

/** `ir: 1 isc_done 1 isc_ena 0 init 1 done 1` (last occurrence wins). */
export function parseConfigurationStatus(text: string): ConfigurationStatus | undefined {
    const all = [...text.matchAll(/isc_done\s+(\d)\s+isc_ena\s+(\d)\s+init\s+(\d)\s+done\s+(\d)/g)];
    const m = all.at(-1);
    return m ? { iscDone: Number(m[1]), iscEna: Number(m[2]), init: Number(m[3]), done: Number(m[4]) } : undefined;
}

export type OpenFpgaLoaderFailure =
    | 'no-probe' // no matching USB/JTAG probe is connected
    | 'usb-unavailable' // probe present but cannot be opened (busy / access)
    | 'jtag-init-failed' // probe opened but JTAG did not initialise
    | 'no-fpga' // JTAG works but no (or an unexpected) FPGA answered
    | 'bitstream-error' // file missing / unreadable / rejected
    | 'unknown';

/** Classifies an openFPGALoader failure from its output. */
export function classifyOpenFpgaLoaderFailure(text: string): OpenFpgaLoaderFailure {
    if (/unable to open ftdi device:\s*-3\b|device not found|No USB devices found|cable not found/i.test(text)) return 'no-probe';
    if (/unable to open ftdi device:\s*-(4|5|6|8)\b|unable to claim|LIBUSB_ERROR_(ACCESS|BUSY)|Access denied|Resource busy/i.test(text)) return 'usb-unavailable';
    if (/No device found|found 0 device|Unknown device|idcode\s+0x0+\b|idcode\s+0xf{8}\b/i.test(text)) return 'no-fpga';
    if (/JTAG init failed/i.test(text)) return 'jtag-init-failed';
    if (/Error.*(open|parse|read).*file|No such file|file .*not found|Unsupported file|bitstream/i.test(text)) return 'bitstream-error';
    return 'unknown';
}

/** Short user-facing explanation for each failure class. */
export const FAILURE_MESSAGES: Readonly<Record<OpenFpgaLoaderFailure, string>> = {
    'no-probe': 'No board was found on USB. Check the USB cable (use the PROG/UART port) and that the board is switched on.',
    'usb-unavailable': 'The board is visible on USB but its JTAG interface could not be opened. Close other programs using it (e.g. another openFPGALoader or Apio) and reconnect the board.',
    'jtag-init-failed': 'The USB/JTAG interface opened but JTAG did not initialise. Reconnect the board and try again.',
    'no-fpga': 'The JTAG interface responded but the expected FPGA was not found on the chain.',
    'bitstream-error': 'openFPGALoader could not read or accept the bitstream file.',
    unknown: 'openFPGALoader failed; see the raw log for details.',
};

/** Last meaningful error line, for diagnostics (raw output stays in the log). */
export function lastErrorLine(text: string): string | undefined {
    const lines = text.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
    return [...lines].reverse().find((l) => /error|fail|unable|not found|cannot/i.test(l));
}
