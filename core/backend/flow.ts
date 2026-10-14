import type { BoardRegistry } from '../board/board-registry';
import type { Project } from '../project/types';
import type { WorkflowController } from '../workflow/workflow-controller';
import type { ProviderRegistry } from './registry';
import type { BoardEnvironment, EnvironmentVerification } from './environment';
import type { BoardProfile, EngineProvider, ImplementationProvider, ProgrammingProvider } from './types';

/**
 * Everything the multi-board backend needs from the composition root: the providers of every
 * board family, the VHDL front end (GHDL, and Yosys for the RTL view) that belongs to a board,
 * and the engine behind boards that need one. Built once in `runtime/`; consumed by the router
 * in the extension, which therefore never names a board, a vendor or a tool.
 */
export interface BoardFlows {
    /** Host platform key, e.g. `macos-arm64`; undefined when unknown. */
    readonly hostKey: string | undefined;
    readonly boards: BoardRegistry;
    readonly registry: ProviderRegistry;
    /** Profile of a board id, or undefined for an unknown board. */
    profileOf(boardId: string): BoardProfile | undefined;
    /** Check / Simulate / RTL controller with the VHDL tools that belong to the project's board. */
    controllerFor(project: Project): Promise<WorkflowController>;
    /** The hidden engine behind a board's implementation, if it has one. */
    engineFor(board: BoardProfile): EngineProvider | undefined;
    /** The environment of a board that has its own tools and engine; undefined for the original flow. Starts nothing. */
    environmentFor?(board: BoardProfile): Promise<BoardEnvironment | undefined>;
    /** Checks the owned tools' integrity and proves the engine runs (this may start it). */
    verifyEnvironment?(board: BoardProfile, signal?: AbortSignal): Promise<EnvironmentVerification | undefined>;
    /** Where a board's programming files and derived programming files live, for a project. */
    programWorkDir(project: Project, board: BoardProfile): string;
    /** The project's VHDL sources in compile order (project-relative). */
    sourcesOf(project: Project): readonly string[];
}

/**
 * Everything one host brings for a board family that has its own tools (DE10-Lite today): its VHDL tools,
 * implementation and programming providers, the engine behind them, and its Environment page data. The macOS
 * runtime (Quartus in a VM) and the Windows runtime (native Quartus) both implement this; the composition
 * root picks one by host, and nothing else in the product knows which.
 */
export interface FamilyRuntime {
    readonly implementation: ImplementationProvider;
    readonly programmer: ProgrammingProvider;
    readonly engine: EngineProvider;
    /** Check / Simulate / RTL controller using MIX-FPGA's own GHDL and Yosys. Starts nothing by itself. */
    workflow(): WorkflowController;
    /** The environment page's data. Starts nothing. */
    environment(displayName: string, boardId: string): Promise<BoardEnvironment>;
    /** Hash-checks the owned tools, then proves the engine really runs Quartus. */
    verify(signal?: AbortSignal): Promise<EnvironmentVerification>;
}
