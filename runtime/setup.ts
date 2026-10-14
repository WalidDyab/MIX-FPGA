import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeToolRunner } from '../core/process/tool-runner';
import { httpDownloader } from '../platform/macos/install/download';
import { devPayloadFromEnv } from '../platform/macos/install/dev-payload';
import { loadExpectedToolchain } from '../platform/macos/install/expected';
import { resolveRuntimeLayout } from '../platform/macos/install/layout';
import { QUARTUS_SPEC } from '../platform/macos/install/quartus-install';
import { type RosettaCommandRunner, systemRosettaHost } from '../platform/macos/install/rosetta';
import { SetupController } from '../platform/macos/install/setup-controller';
import type { HardwareView } from '../platform/macos/install/setup-view';

// What the extension's Setup screens need, re-exported so extension/ reaches platform code only through runtime/.
export type { LicenseOffer, QuartusFiles } from '../platform/macos/install/quartus-install';
export type { RosettaCommand, RosettaConsent } from '../platform/macos/install/rosetta';
export type { InstallSummary, SetupInteraction, SetupResult, VerifyResult } from '../platform/macos/install/setup-controller';
export type { HardwareView, SetupView } from '../platform/macos/install/setup-view';
export { SetupController };

/** The two Altera downloads the student is asked for (names only; they are Altera's files). */
export const ALTERA_DOWNLOADS = { version: QUARTUS_SPEC.version, installerName: QUARTUS_SPEC.installer.name, packageName: QUARTUS_SPEC.devicePackage.name } as const;

export interface SetupOptions {
    readonly extensionPath: string;
    readonly hardware: () => HardwareView;
    /** Runs Apple's Rosetta installer where the student can see and answer it. */
    readonly runRosettaCommand: RosettaCommandRunner;
}

async function freeBytes(path: string): Promise<number> {
    const s = await statfs(path).catch(() => statfs('/'));
    return Number(s.bavail) * Number(s.bsize);
}

/**
 * The Setup controller for this computer, or undefined where it does not apply (anything but an Apple-silicon Mac) or
 * when this build does not carry the Toolchain 1.0 manifest. Creating it starts nothing.
 */
export async function createSetupController(opts: SetupOptions): Promise<SetupController | undefined> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return undefined;
    try {
        const expected = await loadExpectedToolchain(join(opts.extensionPath, 'toolchains', 'mixfpga', 'toolchain-1.0-macos-arm64.json'));
        return new SetupController({
            layout: resolveRuntimeLayout(),
            expected,
            // Installer development only: a release supplies its own archive. Never consulted when MIX-FPGA looks for a tool to run.
            payload: devPayloadFromEnv(process.env, opts.extensionPath),
            runner: new NodeToolRunner(),
            downloader: httpDownloader,
            freeBytes,
            rosettaHost: systemRosettaHost(),
            runRosettaCommand: opts.runRosettaCommand,
            hardware: async () => opts.hardware(),
        });
    } catch {
        return undefined;
    }
}
