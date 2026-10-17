import { win32 } from 'node:path';
import {
    type BundledToolchain,
    BundledToolLocator,
    ChainedToolLocator,
    type HostInfo,
    type LocatedTool,
    NodeToolRunner,
    packageRoot,
    type ToolId,
    type ToolLocator,
    type ToolRunner,
} from '../../core';
import type { PlatformFactory, PlatformServices } from '../types';
import { DigilentProgrammer, type DigilentProgrammerOptions } from './digilent/digilent-programmer';
import { type EnvironmentVariables, getEnv, nodeWindowsFileSystem, type WindowsHostEnvironment } from './host-environment';
import { WindowsToolchainInspector } from './toolchain-inspector';
import { digilentUtilityFolders, WindowsToolLocator } from './tool-locator';

export interface WindowsPlatformOptions {
    readonly environment?: WindowsHostEnvironment;
    readonly runner?: ToolRunner;
    readonly programmer?: DigilentProgrammerOptions;
    /** Classroom mode: user-space tools come only from the installed bundle (no discovery). */
    readonly classroom?: { readonly toolchain?: BundledToolchain };
}

export interface WindowsPlatformServices extends PlatformServices {
    readonly toolLocator: ToolLocator;
    readonly programmer: DigilentProgrammer;
    /** openXC7/programmer-aware version detection with the adapter's own locator. */
    readonly inspector: WindowsToolchainInspector;
}

export function defaultWindowsEnvironment(): WindowsHostEnvironment {
    let root: string | undefined;
    try {
        root = packageRoot();
    } catch {
        root = undefined;
    }
    return { env: process.env, fs: nodeWindowsFileSystem, ...(root ? { packageRoot: root } : {}) };
}

/** Operating-system folders bundled tools may need (cmd.exe for Apio's SCons scripts, system DLLs incl. the Digilent runtime). */
export function windowsSystemPath(env: EnvironmentVariables): string[] {
    const root = getEnv(env, 'SystemRoot') ?? getEnv(env, 'windir') ?? 'C:\\Windows';
    return [win32.join(root, 'System32'), root, win32.join(root, 'System32', 'Wbem')];
}

/**
 * Per-user NexysVHDL data root: %LOCALAPPDATA%\NexysVHDL. Local (not
 * Roaming) AppData, so a multi-GB toolchain never travels with a roaming
 * classroom profile, and it is shared by every VS Code flavour/profile.
 */
export function windowsUserDataRoot(env: EnvironmentVariables): string | undefined {
    const root = windowsMixFpgaRoot(env);
    return root ? win32.join(root, 'support', 'nexys-a7') : undefined;
}

/** The one runtime override. Relocates the whole MIX-FPGA root (tests, lab images). Students never set it. */
export const MIXFPGA_HOME_VARIABLE = 'MIXFPGA_HOME';

/** MIX-FPGA's per-user root: %LOCALAPPDATA%\MIX-FPGA, or $MIXFPGA_HOME. */
export function windowsMixFpgaRoot(env: EnvironmentVariables): string | undefined {
    const override = getEnv(env, MIXFPGA_HOME_VARIABLE);
    if (override && override.length > 0) return override;
    const local = getEnv(env, 'LOCALAPPDATA');
    return local ? win32.join(local, 'MIX-FPGA') : undefined;
}

/**
 * Writable state of the Nexys tools (Apio's home and caches): under the MIX-FPGA state area, never inside the immutable
 * toolchain folder and never in a NexysVHDL folder.
 */
export function windowsToolStateRoot(env: EnvironmentVariables): string | undefined {
    const root = windowsMixFpgaRoot(env);
    return root ? win32.join(root, 'state', 'nexys-a7') : undefined;
}

/**
 * Where a NexysVHDL 0.6.0 installation keeps the same validated toolchain (%LOCALAPPDATA%\NexysVHDL). MIX-FPGA is its update: it may
 * reuse that toolchain read-only (the installed marker must match the validated content hash) until it is taken over into the
 * MIX-FPGA store. Never written to. Not consulted when MIXFPGA_HOME relocates MIX-FPGA (isolated and fresh-install tests).
 */
export function windowsLegacyDataRoots(env: EnvironmentVariables): string[] {
    if (getEnv(env, MIXFPGA_HOME_VARIABLE)) return [];
    const local = getEnv(env, 'LOCALAPPDATA');
    return local ? [win32.join(local, 'NexysVHDL')] : [];
}

/**
 * The Digilent programmer in classroom mode: only the official Adept Utilities
 * install locations (Program Files). Never PATH, never an override: Digilent
 * support is a system prerequisite that NexysVHDL detects but does not ship.
 */
export class DigilentSystemLocator implements ToolLocator {
    constructor(private readonly host: WindowsHostEnvironment) {}

    async locate(tool: ToolId): Promise<LocatedTool | undefined> {
        if (tool !== 'programmer') return undefined;
        for (const dir of digilentUtilityFolders(this.host.env)) {
            const path = win32.join(dir, 'djtgcfg.exe');
            if (await this.host.fs.isFile(path)) return { path, method: 'Digilent Adept Utilities (official install)' };
        }
        return undefined;
    }
}

/**
 * The real Windows x64 adapter: tool discovery (GHDL, Apio, djtgcfg), Windows
 * version detection (openXC7 package, Adept Utilities/Runtime) and a
 * ProgrammerProvider for Digilent Adept (`djtgcfg`) that keeps the standard
 * FTDI/Digilent driver. No Vivado, no driver changes, FPGA SRAM only.
 *
 * With a bundled toolchain (classroom mode) GHDL/Apio come only from the
 * bundle and djtgcfg only from the official Digilent install folders.
 * Windows needs no per-tool environment beyond the composition root's runner
 * (in particular, the macOS Apio pin is never applied here).
 */
export function createWindowsPlatformServices(_host: HostInfo, options: WindowsPlatformOptions = {}): WindowsPlatformServices {
    const environment = options.environment ?? defaultWindowsEnvironment();
    const runner = options.runner ?? new NodeToolRunner();
    const bundle = options.classroom?.toolchain;
    const toolLocator: ToolLocator = options.classroom
        ? new ChainedToolLocator([...(bundle ? [new BundledToolLocator(bundle)] : []), new DigilentSystemLocator(environment)])
        : new WindowsToolLocator(environment);
    const inspectorOptions = bundle ? { apioPackagesDir: bundle.apioPackagesDir } : {};
    return {
        id: 'windows',
        displayName: 'Windows',
        status: options.classroom
            ? `NexysVHDL toolchain ${bundle ? bundle.manifest.bundleVersion : '(not installed)'}; Digilent Adept programmer (djtgcfg, FPGA SRAM)`
            : 'Digilent Adept programmer (djtgcfg, FPGA SRAM); tool discovery for GHDL, Apio/openXC7',
        toolLocator,
        programmer: new DigilentProgrammer(toolLocator, runner, environment, options.programmer),
        inspector: new WindowsToolchainInspector(toolLocator, runner, environment, inspectorOptions),
        programmerSetup: {
            name: 'Digilent USB/JTAG Support',
            bundled: false,
            guide: 'https://digilent.com/reference/software/adept/start',
            instructions: 'Install the official Digilent Adept Runtime and Adept Utilities from Digilent, then run Show Environment again.',
        },
        async inspectToolchain(request) {
            // The composition root's locator puts project settings and NEXYSVHDL_* first (discovery mode only).
            const tools = await new WindowsToolchainInspector(request.locator, runner, environment, inspectorOptions).detectAll(request.tools);
            return { tools, diagnostics: [] };
        },
    };
}

/** The factory registered in platform/index.ts for win32/x64. */
export const createWindowsPlatform: PlatformFactory = (host, context) =>
    createWindowsPlatformServices(host, {
        runner: context.runner,
        environment: { ...defaultWindowsEnvironment(), env: context.env },
        ...(context.classroom ? { classroom: context.classroom } : {}),
    });
