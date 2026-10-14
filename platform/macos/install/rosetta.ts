import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ComponentDefinition, SetupStepResult } from '../../../core/install/model';

const run = promisify(execFile);

/** Apple's own installer for Rosetta 2. MIX-FPGA neither bundles nor redistributes Rosetta. */
export const SOFTWAREUPDATE = '/usr/sbin/softwareupdate';
/** Present once Rosetta is installed; the Linux engine's x86-64 translation reads Rosetta from here. */
export const ROSETTA_RUNTIME = '/Library/Apple/usr/share/rosetta/rosetta';

/** What can be observed about Rosetta on this Mac. Tests replace it. */
export interface RosettaHost {
    appleSilicon(): Promise<boolean>;
    /** The Rosetta runtime Apple installs is on disk. */
    runtimePresent(): Promise<boolean>;
    /** An x86-64 program actually starts (`arch -x86_64 /usr/bin/true`). */
    translates(): Promise<boolean>;
}

export function systemRosettaHost(): RosettaHost {
    return {
        appleSilicon: async () => (await run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']).then((r) => r.stdout.trim(), () => '0')) === '1',
        runtimePresent: () => stat(ROSETTA_RUNTIME).then((s) => s.isFile(), () => false),
        translates: () => run('/usr/bin/arch', ['-x86_64', '/usr/bin/true']).then(() => true, () => false),
    };
}

/**
 * How the student agrees to Apple's licence. There is no silent default:
 *  `apple-prompt`      Apple's own installer runs in a terminal the student can see; Apple shows its licence and the
 *                      student types the agreement and the administrator password there. MIX-FPGA never sees or passes either.
 *  `agree-to-license`  Only after MIX-FPGA has shown Apple's licence reference and the student explicitly ticked
 *                      "I have read and agree to Apple's software licence agreement". Passes Apple's `--agree-to-license`.
 */
export type RosettaConsent = { readonly method: 'apple-prompt' } | { readonly method: 'agree-to-license'; readonly studentAcceptedAppleLicense: true };

export interface RosettaCommand {
    readonly executable: string;
    readonly args: readonly string[];
    /** Needs an administrator: the operating system asks the student, MIX-FPGA does not handle the password. */
    readonly elevated: true;
    /** The student interacts with it (Apple's licence prompt). */
    readonly interactive: boolean;
}

export function isRosettaConsent(x: unknown): x is RosettaConsent {
    if (typeof x !== 'object' || x === null) return false;
    const c = x as { method?: unknown; studentAcceptedAppleLicense?: unknown };
    return c.method === 'apple-prompt' || (c.method === 'agree-to-license' && c.studentAcceptedAppleLicense === true);
}

/** The exact command for a consent. `--agree-to-license` appears only when the student explicitly accepted. */
export function rosettaInstallCommand(consent: RosettaConsent): RosettaCommand {
    return consent.method === 'apple-prompt'
        ? { executable: SOFTWAREUPDATE, args: ['--install-rosetta'], elevated: true, interactive: true }
        : { executable: SOFTWAREUPDATE, args: ['--install-rosetta', '--agree-to-license'], elevated: true, interactive: false };
}

/** Runs the command where the student can see and answer it (a terminal), or with the OS administrator prompt. Supplied by the UI. */
export type RosettaCommandRunner = (command: RosettaCommand, signal?: AbortSignal) => Promise<{ readonly exitCode: number | undefined; readonly output: string }>;

export function rosettaDefinition(deps: { host: RosettaHost; runCommand: RosettaCommandRunner }): ComponentDefinition {
    return {
        id: 'rosetta',
        label: 'Rosetta',
        async inspect() {
            if (!(await deps.host.appleSilicon())) return { state: 'incompatible', ownership: 'system', code: 'NOT_APPLE_SILICON', detail: 'Rosetta is only used on Apple silicon Macs' };
            const present = await deps.host.runtimePresent();
            if (!present) return { state: 'not-installed', ownership: 'system' };
            if (!(await deps.host.translates())) return { state: 'repairable', ownership: 'system', code: 'NOT_TRANSLATING', detail: 'Rosetta is installed but x86-64 programs do not start' };
            return { state: 'ready', ownership: 'system', version: 'system' };
        },
        install: {
            requires: [],
            userInput: 'consent',
            run: async (request): Promise<SetupStepResult> => {
                // The engine only calls this with input, but the shape is checked anyway: no consent, no command.
                if (!isRosettaConsent(request.input)) return { ok: false, code: 'CONSENT_REQUIRED', message: 'Installing Rosetta needs the student to agree to Apple\'s licence.' };
                request.progress({ message: 'Waiting for Apple\'s Rosetta installer…' });
                const r = await deps.runCommand(rosettaInstallCommand(request.input), request.signal);
                if (r.exitCode !== 0) return { ok: false, code: 'ROSETTA_INSTALL_FAILED', message: `Apple's installer did not finish${r.exitCode === undefined ? '' : ` (exit ${r.exitCode})`}. ${r.output.trim().split('\n').slice(-1)[0] ?? ''}`.trim() };
                return { ok: true };
            },
        },
    };
}
