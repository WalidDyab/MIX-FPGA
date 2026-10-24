import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { NodeToolRunner } from '../core/process/tool-runner';
import { httpDownloader } from '../platform/macos/install/download';
import { devPayloadDirFromEnv, devPayloadFromEnv } from '../platform/macos/install/dev-payload';
import { loadExpectedToolchain } from '../platform/shared/install/expected';
import { resolveRuntimeLayout } from '../platform/macos/install/layout';
import { QUARTUS_SPEC } from '../platform/macos/install/quartus-install';
import { type RosettaCommandRunner, systemRosettaHost } from '../platform/macos/install/rosetta';
import { SetupController as MacSetupController } from '../platform/macos/install/setup-controller';
import { windowsDevPayloadDirFromEnv, windowsDevPayloadFromEnv } from '../platform/windows/install/dev-payload';
import { resolveWindowsLayout } from '../platform/windows/install/layout';
import { WINDOWS_QUARTUS_SPEC } from '../platform/windows/install/quartus-install';
import { WindowsSetupController } from '../platform/windows/install/setup-controller';
import { macosLegacyDataRoots, macosUserDataRoot } from '../platform/macos';
import { windowsLegacyDataRoots, windowsUserDataRoot } from '../platform/windows';
import { loadRequirement } from './classroom';
import type { HardwareView, SetupView } from '../platform/macos/install/setup-view';
import type { BoardSupportId } from '../platform/macos/install/boards';
import type { SetupInteraction, SetupResult, VerifyResult } from '../platform/macos/install/setup-controller';
import type { NexysAdoptionPlan } from '../platform/macos/install/nexys-support';
import type { ComponentStatus } from '../core/install/model';

// What the extension's Setup screens need, re-exported so extension/ reaches platform code only through runtime/.
export type { LicenseOffer, QuartusFiles } from '../platform/macos/install/quartus-install';
export type { RosettaCommand, RosettaConsent } from '../platform/macos/install/rosetta';
export { MODIFIED_HINT } from '../platform/macos/install/setup-view';
export type { InstallSummary, SetupInteraction, SetupResult, VerifyResult } from '../platform/macos/install/setup-controller';
export type { HardwareView, SetupView, BoardRowView } from '../platform/macos/install/setup-view';
export type { BoardSupportId } from '../platform/macos/install/boards';
export { isBoardSupportId } from '../platform/macos/install/boards';

/**
 * The Setup controller of this computer, whichever host it is: the extension calls these methods and nothing else. macOS and
 * Windows each have their own implementation (their components differ); the Setup page, the dialogs and the commands are shared.
 */
export interface SetupController {
    /** What the Setup page shows. Never starts a build or a long-running engine. */
    status(): Promise<{ statuses: ComponentStatus[]; view: SetupView }>;
    isBoardReady(board: string): Promise<boolean>;
    /** Installed and usable, but a file differs from the supported release because the user changed it. */
    isBoardModified(board: string): Promise<boolean>;
    adoptNexysVhdl(opts: { dryRun: boolean; progress?: (m: string) => void; signal?: AbortSignal }): Promise<{ plan: NexysAdoptionPlan; result?: { ok: boolean; message: string } }>;
    install(ui: SetupInteraction, signal?: AbortSignal, boards?: readonly BoardSupportId[]): Promise<SetupResult>;
    repair(ui: SetupInteraction, signal?: AbortSignal, boards?: readonly BoardSupportId[]): Promise<SetupResult>;
    verify(signal?: AbortSignal): Promise<VerifyResult>;
}

/** The two Altera downloads the student is asked for (names only; they are Altera's files), for this computer. */
export const ALTERA_DOWNLOADS = (
    process.platform === 'win32'
        ? { version: WINDOWS_QUARTUS_SPEC.version, installerName: WINDOWS_QUARTUS_SPEC.installer.name, packageName: WINDOWS_QUARTUS_SPEC.devicePackage.name, system: 'Windows', installerExtension: 'exe' }
        : { version: QUARTUS_SPEC.version, installerName: QUARTUS_SPEC.installer.name, packageName: QUARTUS_SPEC.devicePackage.name, system: 'Linux', installerExtension: 'run' }
) as { readonly version: string; readonly installerName: string; readonly packageName: string; readonly system: string; readonly installerExtension: string };

/** The Nexys A7 support file a student without a NexysVHDL installation is asked for, for this computer. */
/** The DE10-Lite support file the course provides (macOS). */
export const DE10_SUPPORT_FILE = 'mixfpga-de10-lite-support-1.1-macos-arm64.tar.gz';
export const NEXYS_SUPPORT_FILE = process.platform === 'win32' ? 'nexysvhdl-toolchain-1.1-win32-x64.tar.gz' : 'nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz';

export interface SetupOptions {
    readonly extensionPath: string;
    readonly hardware: () => HardwareView;
    /** macOS only: runs Apple's Rosetta installer where the student can see and answer it. */
    readonly runRosettaCommand?: RosettaCommandRunner;
}

async function freeBytes(path: string): Promise<number> {
    const root = process.platform === 'win32' ? path.slice(0, 3) : '/';
    const s = await statfs(path).catch(() => statfs(root));
    return Number(s.bavail) * Number(s.bsize);
}

function readPins(file: string): Record<string, { file: string; sha256: string; bytes?: number }> | undefined {
    try {
        return (JSON.parse(readFileSync(file, 'utf8')) as { payloads: Record<string, { file: string; sha256: string; bytes?: number }> }).payloads;
    } catch {
        return undefined;
    }
}

/**
 * The Setup controller for this computer, or undefined where it does not apply (anything but an Apple-silicon Mac or 64-bit
 * Windows) or when this build does not carry the Toolchain 1.1 manifest. Creating it starts nothing.
 */
export async function createSetupController(opts: SetupOptions): Promise<SetupController | undefined> {
    if (process.platform === 'darwin' && process.arch === 'arm64' && opts.runRosettaCommand) return createMacController({ ...opts, runRosettaCommand: opts.runRosettaCommand });
    if (process.platform === 'win32' && process.arch === 'x64') return createWindowsController(opts);
    return undefined;
}

async function createMacController(opts: SetupOptions & { runRosettaCommand: RosettaCommandRunner }): Promise<SetupController | undefined> {
    try {
        const expected = await loadExpectedToolchain(join(opts.extensionPath, 'toolchains', 'mixfpga', 'toolchain-1.1-macos-arm64.json'));
        const { requirement } = loadRequirement(opts.extensionPath);
        const nexysRoot = macosUserDataRoot(process.env);
        const pins = readPins(join(opts.extensionPath, 'toolchains', 'mixfpga', 'payloads-1.1.json'));
        // Installer development only (a release carries its own payload folder).
        const payloadDir = devPayloadDirFromEnv(process.env);
        return new MacSetupController({
            ...(requirement && nexysRoot ? { nexys: { requirement, dataRoot: nexysRoot, legacyRoots: macosLegacyDataRoots(process.env) } } : {}),
            ...(pins ? { payloadPins: pins } : {}),
            ...(payloadDir ? { payloadDir } : {}),
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

async function createWindowsController(opts: SetupOptions): Promise<SetupController | undefined> {
    try {
        const expected = await loadExpectedToolchain(join(opts.extensionPath, 'toolchains', 'mixfpga', 'toolchain-1.1-windows-x64.json'));
        const { requirement } = loadRequirement(opts.extensionPath);
        const nexysRoot = windowsUserDataRoot(process.env);
        const pins = readPins(join(opts.extensionPath, 'toolchains', 'mixfpga', 'payloads-1.1-windows-x64.json'));
        // Installer development only (a release carries its own payload folder).
        const payloadDir = windowsDevPayloadDirFromEnv(process.env);
        return new WindowsSetupController({
            ...(requirement && nexysRoot ? { nexys: { requirement, dataRoot: nexysRoot, legacyRoots: windowsLegacyDataRoots(process.env) } } : {}),
            ...(pins ? { payloadPins: pins } : {}),
            ...(payloadDir ? { payloadDir } : {}),
            layout: resolveWindowsLayout(),
            expected,
            // Installer development only: a release supplies its own archive. Never consulted when MIX-FPGA looks for a tool to run.
            payload: windowsDevPayloadFromEnv(process.env, opts.extensionPath),
            runner: new NodeToolRunner(),
            freeBytes,
            hardware: async () => opts.hardware(),
        });
    } catch {
        return undefined;
    }
}
