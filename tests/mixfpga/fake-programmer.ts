import type { ToolInvocation, ToolRunResult, ToolRunner } from '../../core';

export const SCAN = 'empty\nBus device vid:pid       probe_type  manufacturer serial   product\n001 004 0x09fb:0x6001 usb-blaster Altera 91d28408 USB-Blaster\n';
export const DETECT = 'empty\nindex 0:\n\tidcode 0x31050dd\n\tmanufacturer altera\n\tfamily MAX 10\n\tmodel  10M50D\n\tirlength 10\n';
export const PROGRAM_OK = 'empty\nUSB-BlasterI has a 24MHz fixed frequency\nend of SVF file\n';

export interface Script {
    scan?: string;
    detect?: string | string[];
    detectExit?: number;
    program?: Partial<ToolRunResult>;
    version?: string;
}

export class FakeProgrammerBinary implements ToolRunner {
    readonly calls: ToolInvocation[] = [];
    private detects = 0;
    constructor(private readonly s: Script = {}) {}
    async run(inv: ToolInvocation): Promise<ToolRunResult> {
        this.calls.push(inv);
        const r = (o: Partial<ToolRunResult>): ToolRunResult => ({ invocation: inv, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1, ...o });
        const a = inv.args;
        if (a[0] === '--Version') return r({ stdout: this.s.version ?? 'openFPGALoader v1.1.1\n' });
        if (a[0] === '--scan-usb') return r({ stdout: this.s.scan ?? SCAN });
        if (a[0] === '--detect') {
            const d = this.s.detect ?? DETECT;
            const text = Array.isArray(d) ? d[Math.min(this.detects, d.length - 1)]! : d;
            this.detects++;
            return r({ stdout: text, exitCode: this.s.detectExit ?? 0 });
        }
        return r({ stdout: PROGRAM_OK, ...this.s.program });
    }
    get programCalls() {
        return this.calls.filter((c) => !c.args[0]?.startsWith('--'));
    }
}

