import { type HostInfo, NodeToolRunner, packageRoot, type ToolRunner } from '../../core';
import type { PlatformFactory, PlatformServices } from '../types';
import { DigilentProgrammer, type DigilentProgrammerOptions } from './digilent/digilent-programmer';
import { nodeWindowsFileSystem, type WindowsHostEnvironment } from './host-environment';
import { WindowsToolchainInspector } from './toolchain-inspector';
import { WindowsToolLocator } from './tool-locator';

export interface WindowsPlatformOptions {
    readonly environment?: WindowsHostEnvironment;
    readonly runner?: ToolRunner;
    readonly programmer?: DigilentProgrammerOptions;
}

export interface WindowsPlatformServices extends PlatformServices {
    readonly toolLocator: WindowsToolLocator;
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

/**
 * The real Windows x64 adapter: tool discovery (GHDL, Apio, djtgcfg), Windows
 * version detection (openXC7 package, Adept Utilities/Runtime) and a
 * ProgrammerProvider for Digilent Adept (`djtgcfg`) that keeps the standard
 * FTDI/Digilent driver. No Vivado, no driver changes, FPGA SRAM only.
 *
 * Windows needs no per-tool environment, so the base runner is used unchanged
 * (in particular, the macOS Apio pin is never applied here).
 */
export function createWindowsPlatformServices(_host: HostInfo, options: WindowsPlatformOptions = {}): WindowsPlatformServices {
    const environment = options.environment ?? defaultWindowsEnvironment();
    const runner = options.runner ?? new NodeToolRunner();
    const toolLocator = new WindowsToolLocator(environment);
    return {
        id: 'windows',
        displayName: 'Windows',
        status: 'Digilent Adept programmer (djtgcfg, FPGA SRAM); tool discovery for GHDL, Apio/openXC7',
        toolLocator,
        programmer: new DigilentProgrammer(toolLocator, runner, environment, options.programmer),
        inspector: new WindowsToolchainInspector(toolLocator, runner, environment),
        async inspectToolchain(request) {
            // The composition root's locator puts project settings and NEXYSVHDL_* first.
            const tools = await new WindowsToolchainInspector(request.locator, runner, environment).detectAll(request.tools);
            return { tools, diagnostics: [] };
        },
    };
}

/** The factory registered in platform/index.ts for win32/x64. */
export const createWindowsPlatform: PlatformFactory = (host, context) =>
    createWindowsPlatformServices(host, { runner: context.runner, environment: { ...defaultWindowsEnvironment(), env: context.env } });
