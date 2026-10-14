/** Pure parsers for Quartus Prime Lite CLI reports and logs. No I/O. */
import type { Diagnostic } from '../../results/diagnostic';
import type { BoardProfile, ClockResult, NormalizedBuildResult, TimingStatus, VendorMetric } from '../../backend/types';

const num = (s: string): number => Number(s.replace(/,/g, ''));

/** `Key : 27 / 49,760 ( < 1 % )` style lines of *.map.summary and *.fit.summary. */
export function parseQuartusSummary(text: string): Map<string, { used?: number; available?: number; text: string }> {
    const out = new Map<string, { used?: number; available?: number; text: string }>();
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/.exec(line);
        if (!m) continue;
        const key = m[1]!;
        const value = m[2]!;
        const n = /^([\d,]+)(?:\s*\/\s*([\d,]+))?/.exec(value);
        out.set(key, n ? { used: num(n[1]!), ...(n[2] ? { available: num(n[2]) } : {}), text: value } : { text: value });
    }
    return out;
}

export interface QuartusStageSummary {
    readonly device?: string;
    readonly topEntity?: string;
    readonly family?: string;
    readonly status?: string;
    readonly resources: NormalizedBuildResult['resources'];
}

function metric(map: ReturnType<typeof parseQuartusSummary>, key: string, label: string): VendorMetric | undefined {
    const v = map.get(key);
    if (!v || v.used === undefined) return undefined;
    return { used: v.used, ...(v.available !== undefined ? { available: v.available } : {}), label, vendorName: key };
}

/** Resources and identity from a map or fit summary. Labels come from the board profile, numbers stay in vendor units. */
export function parseStageSummary(text: string, board: BoardProfile): QuartusStageSummary {
    const m = parseQuartusSummary(text);
    const L = board.metricLabels;
    const r: { -readonly [K in keyof QuartusStageSummary['resources']]: QuartusStageSummary['resources'][K] } = {};
    const set = <K extends keyof typeof r>(k: K, v: VendorMetric | undefined) => {
        if (v) r[k] = v;
    };
    set('logic', metric(m, 'Total logic elements', L.logic));
    set('combinational', metric(m, 'Total combinational functions', 'Combinational functions'));
    set('registers', metric(m, 'Total registers', L.registers));
    set('memoryBits', metric(m, 'Total memory bits', L.memory));
    set('dsp', metric(m, 'Embedded Multiplier 9-bit elements', L.dsp));
    set('pins', metric(m, 'Total pins', 'Pins'));
    const t = (k: string) => m.get(k)?.text;
    return {
        ...(t('Device') ? { device: t('Device')! } : {}),
        ...(t('Top-level Entity Name') ? { topEntity: t('Top-level Entity Name')! } : {}),
        ...(t('Family') ? { family: t('Family')! } : {}),
        ...(t('Fitter Status') ?? t('Analysis & Synthesis Status') ? { status: (t('Fitter Status') ?? t('Analysis & Synthesis Status'))! } : {}),
        resources: r,
    };
}

export interface TimingSummary {
    readonly worstSetupSlackNs?: number;
    readonly worstHoldSlackNs?: number;
    readonly perClock: ReadonlyMap<string, { setup?: number; hold?: number }>;
}

/** `Type : Slow 1200mV 85C Model Setup 'clk_50'` / `Slack : 16.605` blocks of *.sta.summary. */
export function parseStaSummary(text: string): TimingSummary {
    const perClock = new Map<string, { setup?: number; hold?: number }>();
    let worstSetup: number | undefined;
    let worstHold: number | undefined;
    let cur: { kind: 'setup' | 'hold' | 'other'; clock: string } | undefined;
    for (const line of text.split(/\r?\n/)) {
        const t = /^\s*Type\s*:\s*.*Model\s+(Setup|Hold|Recovery|Removal|Minimum Pulse Width)\s+'([^']+)'/i.exec(line);
        if (t) {
            const k = t[1]!.toLowerCase();
            cur = { kind: k === 'setup' ? 'setup' : k === 'hold' ? 'hold' : 'other', clock: t[2]! };
            continue;
        }
        const s = /^\s*Slack\s*:\s*(-?[\d.]+)/.exec(line);
        if (s && cur && cur.kind !== 'other') {
            const v = Number(s[1]);
            const e = perClock.get(cur.clock) ?? {};
            if (cur.kind === 'setup') {
                e.setup = e.setup === undefined ? v : Math.min(e.setup, v);
                worstSetup = worstSetup === undefined ? v : Math.min(worstSetup, v);
            } else {
                e.hold = e.hold === undefined ? v : Math.min(e.hold, v);
                worstHold = worstHold === undefined ? v : Math.min(worstHold, v);
            }
            perClock.set(cur.clock, e);
        }
    }
    return { ...(worstSetup !== undefined ? { worstSetupSlackNs: worstSetup } : {}), ...(worstHold !== undefined ? { worstHoldSlackNs: worstHold } : {}), perClock };
}

/** Rows `; 294.55 MHz ; 250.0 MHz ; clk_50 ; note ;` of every "Fmax Summary" table in *.sta.rpt (min across corners). */
export function parseFmax(rpt: string): Map<string, { fmaxMHz: number; restrictedFmaxMHz: number }> {
    const out = new Map<string, { fmaxMHz: number; restrictedFmaxMHz: number }>();
    for (const line of rpt.split(/\r?\n/)) {
        const m = /^;\s*([\d.]+)\s*MHz\s*;\s*([\d.]+)\s*MHz\s*;\s*([^;\s]+)\s*;/.exec(line);
        if (!m) continue;
        const f = Number(m[1]);
        const rf = Number(m[2]);
        const e = out.get(m[3]!);
        out.set(m[3]!, { fmaxMHz: e ? Math.min(e.fmaxMHz, f) : f, restrictedFmaxMHz: e ? Math.min(e.restrictedFmaxMHz, rf) : rf });
    }
    return out;
}

/** `create_clock -name clk_50 -period 20.000 [get_ports clk_50]` -> target MHz per clock name. */
export function parseSdcClocks(sdc: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const raw of sdc.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '');
        if (!/create_clock\b/.test(line)) continue;
        const period = /-period\s+([\d.]+)/.exec(line);
        const name = /-name\s+(\S+)/.exec(line) ?? /get_ports\s+\{?\s*([^\s\]}]+)/.exec(line);
        if (period && name && Number(period[1]) > 0) out.set(name[1]!, Math.round((1000 / Number(period[1])) * 1000) / 1000);
    }
    return out;
}

export function combineClocks(sta: TimingSummary, fmax: ReturnType<typeof parseFmax>, targets: ReadonlyMap<string, number>): ClockResult[] {
    const names = new Set<string>([...targets.keys(), ...sta.perClock.keys(), ...fmax.keys()]);
    return [...names].sort().map((name) => {
        const s = sta.perClock.get(name);
        const f = fmax.get(name);
        const t = targets.get(name);
        return {
            name,
            ...(t !== undefined ? { targetMHz: t } : {}),
            ...(f ? { fmaxMHz: f.fmaxMHz, restrictedFmaxMHz: f.restrictedFmaxMHz } : {}),
            ...(s?.setup !== undefined ? { worstSetupSlackNs: s.setup } : {}),
            ...(s?.hold !== undefined ? { worstHoldSlackNs: s.hold } : {}),
        };
    });
}

export function timingStatus(sta: TimingSummary | undefined, targets: ReadonlyMap<string, number>): TimingStatus {
    if (!sta) return 'not-run';
    if (targets.size === 0) return 'unconstrained';
    const slacks = [...sta.perClock.values()].flatMap((c) => [c.setup, c.hold]).filter((v): v is number => v !== undefined);
    if (slacks.length === 0) return 'not-run';
    return slacks.every((v) => v >= 0) ? 'met' : 'not-met';
}

/** `Info: Quartus Prime Fitter was successful. 0 errors, 4 warnings` — the tool's own verdict, not just the exit code. */
export function stageSucceeded(log: string): boolean {
    return /^Info: Quartus Prime .+ was successful\. 0 errors?, \d+ warnings?/m.test(log);
}

/** Unique warnings/errors of a Quartus log as diagnostics (`Warning (18236): ...`). */
export function parseQuartusMessages(log: string): { warnings: Diagnostic[]; errors: Diagnostic[] } {
    const seen = new Map<string, { sev: 'warning' | 'error'; id: string; text: string; n: number }>();
    for (const line of log.split(/\r?\n/)) {
        const m = /^\s*(Warning|Error|Critical Warning) \((\d+)\):\s*(.+?)\s*$/.exec(line);
        if (!m) continue;
        const key = `${m[1]}:${m[2]}:${m[3]}`;
        const e = seen.get(key);
        if (e) e.n++;
        else seen.set(key, { sev: m[1] === 'Error' ? 'error' : 'warning', id: m[2]!, text: m[3]!, n: 1 });
    }
    const warnings: Diagnostic[] = [];
    const errors: Diagnostic[] = [];
    for (const e of seen.values()) {
        const d: Diagnostic = { severity: e.sev, source: 'implementation', code: `QUARTUS_${e.sev === 'error' ? 'E' : 'W'}${e.id}`, message: e.n > 1 ? `${e.text} (x${e.n})` : e.text };
        (e.sev === 'error' ? errors : warnings).push(d);
    }
    return { warnings, errors };
}
