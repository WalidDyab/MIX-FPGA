/**
 * The NexysVHDL Console: one place where a student reads what a workflow action is doing and why
 * it passed or failed. Free of the VS Code API: it writes tagged lines to a sink (the extension
 * hands it an Output channel named "NexysVHDL Console") and decides when to reveal it.
 *
 *   [Check] Analysing VHDL files...
 *   [Check] PASS
 *
 *   [Build] ERROR
 *   Top entity "DigitDisplay" could not be elaborated.
 *   src/DigitDisplay.vhd:42
 *
 * Default output is short and student-readable. `detailed` additionally streams the raw output of
 * the FPGA tools line by line (indented under a `|`), for people who want every diagnostic.
 *
 * Reveal policy: an action reveals the console when it BEGINS, and once more if it hits an error
 * or an important warning. Nothing else reveals it, so a student who closes the panel is never
 * fought mid-run; the next action reveals it again.
 */

export type ConsoleVerbosity = 'normal' | 'detailed';

export type ConsoleTag = 'Project' | 'Check' | 'Simulate' | 'Build' | 'Program' | 'RTL' | 'Environment' | 'Toolchain' | 'Tool';

export interface ConsoleSink {
    appendLine(line: string): void;
    /** Bring the console into view without taking keyboard focus. */
    reveal(): void;
}

export interface ConsoleLocation {
    readonly file: string;
    readonly line?: number;
    readonly column?: number;
}

export interface ConsoleDiagnostic {
    readonly severity: 'error' | 'warning' | 'info';
    readonly message: string;
    readonly location?: ConsoleLocation;
    readonly code?: string;
}

/** Diagnostics listed per action before the rest are summarised (the Problems panel has them all). */
const MAX_LISTED = 25;

const RUNTIME_LINE = /^(?:.*?:\d+:\d+:)?@([^:]+):\((report|assertion) (note|warning|error|failure)\):\s?(.*)$/;

/** A testbench `report`/`assert` line from simulator output as one readable line, or undefined for anything else. Pure. */
export function simulationReportLine(line: string): string | undefined {
    const m = RUNTIME_LINE.exec(line.trim());
    if (!m) return undefined;
    const [, time, kind, level, text] = m as unknown as [string, string, string, string, string];
    return `@${time}  ${kind === 'assertion' ? 'assert ' : ''}${level}: ${text}`;
}

export function formatLocation(l: ConsoleLocation): string {
    return `${l.file}${l.line ? `:${l.line}${l.column ? `:${l.column}` : ''}` : ''}`;
}

export class NexysConsole {
    private active: ConsoleTag | undefined;
    private errorRevealed = false;
    private partial = '';
    private blankPending = false;
    private wrote = false;
    private streamed = 0;

    constructor(
        private readonly sink: ConsoleSink,
        private readonly verbosity: () => ConsoleVerbosity = () => 'normal',
    ) {}

    get detailed(): boolean {
        return this.verbosity() === 'detailed';
    }

    /** Lines of live tool output written for the current action (so a summary does not repeat them). */
    get streamedLines(): number {
        return this.streamed;
    }

    /** The action currently writing, if any. */
    get current(): ConsoleTag | undefined {
        return this.active;
    }

    private write(line: string): void {
        if (this.blankPending && this.wrote) this.sink.appendLine('');
        this.blankPending = false;
        this.wrote = true;
        this.sink.appendLine(line);
    }

    private reveal(): void {
        this.sink.reveal();
    }

    /** A project was opened: the console exists from now on (nothing is revealed). */
    initialize(projectName: string, root: string): void {
        this.endAction();
        this.blankPending = true;
        this.write(`MIX-FPGA Console — project ${projectName}`);
        this.write(root);
        this.blankPending = true;
    }

    /** A workflow action starts: reveals the console and starts a new block. */
    begin(tag: ConsoleTag, message: string): void {
        this.endAction();
        this.active = tag;
        this.errorRevealed = false;
        this.streamed = 0;
        this.blankPending = true;
        this.reveal();
        this.write(`[${tag}] ${message}`);
    }

    /** A progress line for the running action (or any tag). */
    say(tag: ConsoleTag, message: string): void {
        for (const l of message.split(/\r?\n/)) this.write(`[${tag}] ${l}`);
    }

    pass(tag: ConsoleTag, message = 'PASS'): void {
        this.write(`[${tag}] ${message}`);
    }

    fail(tag: ConsoleTag, message = 'FAIL'): void {
        this.write(`[${tag}] ${message}`);
        this.revealOnce();
    }

    /** An error or important warning brings the console back, once per action: never a reveal per line. */
    private revealOnce(): void {
        if (this.errorRevealed) return;
        this.errorRevealed = true;
        this.reveal();
    }

    warning(tag: ConsoleTag, message: string, where?: ConsoleLocation): void {
        this.write(`[${tag}] WARNING`);
        this.write(message);
        if (where) this.write(formatLocation(where));
        this.revealOnce();
    }

    error(tag: ConsoleTag, message: string, where?: ConsoleLocation): void {
        this.write(`[${tag}] ERROR`);
        this.write(message);
        if (where) this.write(formatLocation(where));
        this.revealOnce();
    }

    /** Lists an action's diagnostics: errors and warnings in full, notes only when detailed. */
    diagnostics(tag: ConsoleTag, list: readonly ConsoleDiagnostic[]): void {
        const shown = list.filter((d) => d.severity !== 'info' || this.detailed);
        for (const d of shown.slice(0, MAX_LISTED)) {
            if (d.severity === 'error') this.error(tag, d.message, d.location);
            else if (d.severity === 'warning') this.warning(tag, d.message, d.location);
            else this.say(tag, `${d.message}${d.location ? `  (${formatLocation(d.location)})` : ''}`);
        }
        if (shown.length > MAX_LISTED) this.say(tag, `… and ${shown.length - MAX_LISTED} more (see the Problems panel).`);
    }

    /** Raw tool output as it arrives. Normal: only testbench reports during Simulate. Detailed: everything, under a `|`. */
    raw(text: string): void {
        const lines = (this.partial + text).split(/\r?\n/);
        this.partial = lines.pop() ?? '';
        for (const l of lines) this.rawLine(l);
    }

    private rawLine(line: string): void {
        if (line.trim() === '') return;
        if (this.detailed) {
            this.streamed++;
            this.write(`  | ${line.trimEnd()}`);
            return;
        }
        if (this.active === 'Simulate') {
            const r = simulationReportLine(line);
            if (r) {
                this.streamed++;
                this.write(`[Simulate]   ${r}`);
            }
        }
    }

    /** The action is over: flushes a last unterminated line of tool output. */
    endAction(): void {
        if (this.partial !== '') {
            const rest = this.partial;
            this.partial = '';
            this.rawLine(rest);
        }
        this.active = undefined;
        this.errorRevealed = false;
    }

    /** Brings the console into view (the Show Console command). */
    show(): void {
        this.reveal();
    }
}

/** A console that writes nowhere (tests, headless use). */
export const silentConsole = new NexysConsole({ appendLine: () => undefined, reveal: () => undefined });
