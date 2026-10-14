import { join } from 'node:path';
import {
    type BoardFlows,
    LegacyProgrammingProvider,
    OpenXC7ImplementationProvider,
    ProviderRegistry,
    QsfSdcConstraintProvider,
    XdcConstraintProvider,
    profileFromBoardDefinition,
    type BoardProfile,
    type EngineProvider,
} from '../core/backend';
import { loadProject, packageRoot, type HostInfo, type Project, type ToolInvocation } from '../core';
import { De10Runtime } from '../platform/macos/de10/runtime';
import { loadCanonicalBitstream, workspacePaths } from './bitstream';
import { controllerFor, programmingFor, type RuntimeContext } from './context';

/** Key of the host in board data (`hosts`): macOS on Apple silicon is `macos-arm64`. */
export function hostKeyOf(host: HostInfo): string | undefined {
    if (host.platform === 'darwin' && host.arch === 'arm64') return 'macos-arm64';
    if (host.platform === 'win32' && host.arch === 'x64') return 'windows-x64';
    return undefined;
}

export interface BoardFlowOptions {
    readonly ctx: RuntimeContext;
    /** Receives everything every MIX-FPGA-owned tool prints, as it prints it (the console). */
    readonly onToolOutput?: (text: string, invocation: ToolInvocation) => void;
    /** Tests inject a ready-made DE10 runtime (fake runner); production builds one. */
    readonly de10?: De10Runtime;
    readonly repoRoot?: string;
}

/**
 * The composition root for every board family. The original open-source flow stays exactly what
 * `runtime/context` builds; each other family brings its own VHDL tools, implementation provider,
 * programmer and engine. Nothing here starts a process or the Linux engine.
 */
export function createBoardFlows(opts: BoardFlowOptions): BoardFlows {
    const { ctx } = opts;
    const hostKey = hostKeyOf(ctx.host);
    const profiles = new Map<string, BoardProfile>(ctx.boards.all().map((b) => [b.id, profileFromBoardDefinition(b)]));
    const registry = new ProviderRegistry(hostKey);

    // Original flow (reference implementation): adapters around the existing controller and programming service.
    registry.addConstraints(new XdcConstraintProvider(ctx.boards));
    registry.addImplementation(
        new OpenXC7ImplementationProvider({
            controllerFor: (project) => controllerFor(ctx, project),
            bitstreamFor: async (projectDir) => {
                const loaded = await loadProject(projectDir);
                if (!loaded.ok) return undefined;
                const b = await loadCanonicalBitstream(loaded.project);
                return b ? { path: b.path, ...(b.sizeBytes !== undefined ? { sizeBytes: b.sizeBytes } : {}), modifiedMs: b.modifiedMs } : undefined;
            },
        }),
    );
    registry.addProgramming(
        new LegacyProgrammingProvider({
            boards: ctx.boards,
            service: programmingFor(ctx),
            programDirFor: (bitstreamPath) => join(bitstreamPath, '..', '..', 'program'),
            describe: async () => {
                const p = ctx.platform.programmer;
                if (!p) return { available: false, detail: 'not configured on this platform' };
                const a = await p.availability();
                return { available: a.available, detail: `${p.displayName}: ${a.detail}` };
            },
        }),
    );

    // Quartus family (DE10-Lite): only on hosts that support it.
    let de10: De10Runtime | undefined = opts.de10;
    if (!de10 && hostKey === 'macos-arm64') {
        de10 = new De10Runtime({
            repoRoot: opts.repoRoot ?? packageRoot(__dirname),
            boards: ctx.boards,
            ...(process.env['MIXFPGA_TOOLCHAIN_ROOT'] ? { toolchainRoot: process.env['MIXFPGA_TOOLCHAIN_ROOT'] } : {}),
            ...(opts.onToolOutput ? { onToolOutput: opts.onToolOutput } : {}),
        });
    }
    if (de10) {
        registry.addConstraints(new QsfSdcConstraintProvider());
        registry.addImplementation(de10.implementation);
        registry.addProgramming(de10.programmer);
    }

    return {
        hostKey,
        boards: ctx.boards,
        registry,
        profileOf: (boardId) => profiles.get(boardId),
        controllerFor: async (project: Project) => {
            const profile = profiles.get(project.config.board);
            // The family that brings its own VHDL tools uses them; everything else is the original flow.
            if (de10 && profile && profile.implementationProviderId === de10.implementation.id) return de10.workflow();
            return controllerFor(ctx, project);
        },
        engineFor: (board): EngineProvider | undefined => (de10 && board.implementationProviderId === de10.implementation.id ? de10.engine : undefined),
        environmentFor: async (board) => (de10 && board.implementationProviderId === de10.implementation.id ? de10.environment(board.displayName, board.id) : undefined),
        verifyEnvironment: async (board, signal) => (de10 && board.implementationProviderId === de10.implementation.id ? de10.verify(signal) : undefined),
        programWorkDir: (project, board) => (board.programmingFormat === 'svf' ? join(project.root, '.mix-fpga', 'build', 'de10-lite', 'program') : workspacePaths(project).program),
        sourcesOf: (project) => (Array.isArray(project.config.sources) ? project.config.sources.filter((s): s is string => typeof s === 'string') : []),
    };
}
