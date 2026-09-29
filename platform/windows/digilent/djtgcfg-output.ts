/**
 * Pure parsers for Digilent `djtgcfg` output. Written against real output of
 * djtgcfg 2.6.1 (Adept Utilities 2.7.1) recorded in Phases 1B and 2; see
 * tests/fixtures/windows/djtgcfg/.
 */

/** One device from `djtgcfg enum`. */
export interface DigilentDevice {
    /** Name after `Device:` (the user name / alias). */
    readonly name: string;
    readonly productName?: string;
    readonly userName?: string;
    readonly serialNumber?: string;
    /** e.g. `USB` from `Device Transport Type: 00020001 (USB)`. */
    readonly transport?: string;
}

export type EnumParse =
    | { readonly ok: true; readonly devices: readonly DigilentDevice[]; readonly reportedCount: number }
    | { readonly ok: false; readonly reason: string };

/**
 * `djtgcfg enum`:
 *
 *   Found 1 device(s)
 *
 *   Device: NexysA7
 *       Device Transport Type: 00020001 (USB)
 *       Product Name:          Digilent Nexys A7 -100T
 *       User Name:             NexysA7
 *       Serial Number:         210292BCFFE4
 *
 * or `No devices found`.
 */
export function parseEnumOutput(text: string): EnumParse {
    const lines = text.split(/\r?\n/);
    if (lines.some((l) => /^\s*No devices found\s*$/i.test(l))) return { ok: true, devices: [], reportedCount: 0 };

    const countLine = lines.map((l) => /^\s*Found\s+(\d+)\s+device\(s\)/i.exec(l)).find((m) => m);
    if (!countLine) return { ok: false, reason: 'no "Found N device(s)" or "No devices found" line' };

    const devices: DigilentDevice[] = [];
    let current: { name: string; props: Map<string, string> } | undefined;
    const flush = () => {
        if (!current) return;
        const p = current.props;
        const transport = /\(([^)]+)\)/.exec(p.get('device transport type') ?? '')?.[1];
        const optional = (key: string, value: string | undefined) => (value ? { [key]: value } : {});
        devices.push({
            name: current.name,
            ...optional('productName', p.get('product name')),
            ...optional('userName', p.get('user name')),
            ...optional('serialNumber', p.get('serial number')),
            ...optional('transport', transport),
        });
    };
    for (const line of lines) {
        const dev = /^Device:\s*(.*?)\s*$/.exec(line);
        if (dev) {
            flush();
            current = { name: dev[1]!, props: new Map() };
            continue;
        }
        const prop = /^\s+([A-Za-z][A-Za-z ]*?)\s*:\s*(.*?)\s*$/.exec(line);
        if (prop && current) current.props.set(prop[1]!.toLowerCase(), prop[2]!);
    }
    flush();
    return { ok: true, devices, reportedCount: Number(countLine[1]) };
}

export interface ScanChain {
    /** IDCODEs as printed (hex digits, no prefix), e.g. `13631093`. */
    readonly idcodes: readonly string[];
    /** Device names by chain index, e.g. `['XC7A100T']`. */
    readonly devices: readonly string[];
}

/**
 * `djtgcfg init -d <sel>`:
 *
 *   Initializing scan chain...
 *   Found Device ID: 13631093
 *
 *   Found 1 device(s):
 *       Device 0: XC7A100T
 */
export function parseInitOutput(text: string): ScanChain | undefined {
    const idcodes = [...text.matchAll(/Found Device ID:\s*([0-9a-f]+)/gi)].map((m) => m[1]!.toLowerCase());
    const devices: string[] = [];
    for (const m of text.matchAll(/^\s*Device\s+(\d+):\s*(\S+)\s*$/gim)) devices[Number(m[1])] = m[2]!;
    if (idcodes.length === 0 && devices.length === 0) return undefined;
    return { idcodes, devices };
}

/** `Digilent JTAG Config Utility v2.6.1` -> `2.6.1` */
export function parseDjtgcfgVersion(text: string): string | undefined {
    return /JTAG Config Utility\s+v?(\d+\.\d+(?:\.\d+)?)/i.exec(text)?.[1];
}

/** `<<<<< Digilent Adept Runtime 2.30.4 >>>>>` (install log) -> `2.30.4`; the last install wins. */
export function parseAdeptRuntimeVersion(installLog: string): string | undefined {
    const all = [...installLog.matchAll(/Adept Runtime\s+(\d+\.\d+(?:\.\d+)?)\s*>{3,}/gi)];
    return all.at(-1)?.[1];
}

/**
 * Coarse classes of djtgcfg failures. djtgcfg exits 1 for every error and
 * offers no machine-readable code, so its `ERROR:` text is the only signal;
 * callers combine it with context (e.g. the device *was* enumerated).
 */
export type DjtgcfgFailure =
    /** Device opened, JTAG scan chain could not be initialised (typically board power off). */
    | 'scan-chain'
    /** Device could not be opened (unplugged, wrong selector, or held by another program). */
    | 'open-device'
    /** The .bit file was rejected (e.g. an unsupported header part name). */
    | 'file-rejected'
    /** The .bit file could not be read. */
    | 'file-unreadable'
    /** Programming started but did not complete. */
    | 'programming-failed'
    | 'unknown';

export function classifyDjtgcfgError(text: string): DjtgcfgFailure {
    if (/failed to initiali[sz]e scan chain/i.test(text)) return 'scan-chain';
    if (/unable to open device/i.test(text)) return 'open-device';
    if (/failed to set programming file/i.test(text)) return 'file-rejected';
    if (/could not open\s+".*"\s+for reading/i.test(text)) return 'file-unreadable';
    if (/programming failed|failed to program/i.test(text)) return 'programming-failed';
    return 'unknown';
}

/** The `ERROR: ...` lines of djtgcfg output, for messages. */
export function errorLines(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^ERROR:|^Received error:/i.test(l));
}

export function programmingSucceeded(text: string): boolean {
    return /^\s*Programming succeeded\.?\s*$/im.test(text);
}
