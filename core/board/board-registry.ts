import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Diagnostic, errorDiag } from '../results/diagnostic';
import type { BoardDefinition, BoardResource } from './types';

export interface BoardLoadResult {
    readonly boards: readonly BoardDefinition[];
    readonly diagnostics: readonly Diagnostic[];
}

/** Structural validation of one board.json; returns problems, never throws. */
export function validateBoardDefinition(data: unknown, origin: string): Diagnostic[] {
    const problems: Diagnostic[] = [];
    const fail = (code: string, message: string) => problems.push(errorDiag('board', code, `${origin}: ${message}`));
    const b = data as Partial<BoardDefinition> | null;

    if (typeof b !== 'object' || b === null) {
        fail('BOARD_NOT_OBJECT', 'board definition is not a JSON object');
        return problems;
    }
    if (b.schemaVersion !== 1) fail('BOARD_SCHEMA_VERSION', `unsupported schemaVersion ${String(b.schemaVersion)}`);
    for (const key of ['id', 'name', 'vendor'] as const) {
        if (typeof b[key] !== 'string' || b[key] === '') fail('BOARD_FIELD_MISSING', `missing "${key}"`);
    }
    if (!b.fpga || typeof b.fpga.part !== 'string' || typeof b.fpga.device !== 'string') {
        fail('BOARD_FPGA_MISSING', 'missing fpga.part / fpga.device');
    } else if (b.fpga.capacity !== undefined) {
        const c = b.fpga.capacity as unknown as Record<string, unknown>;
        for (const k of ['luts', 'flipFlops', 'bram36', 'dsp', 'userIo']) {
            if (typeof c[k] !== 'number' || !Number.isInteger(c[k]) || (c[k] as number) <= 0) fail('BOARD_CAPACITY_INVALID', `fpga.capacity.${k} must be a positive integer`);
        }
        if (typeof c['source'] !== 'string' || c['source'] === '') fail('BOARD_CAPACITY_INVALID', 'fpga.capacity.source must name the data sheet');
    }
    if (!b.backendIds || typeof b.backendIds !== 'object') fail('BOARD_FIELD_MISSING', 'missing "backendIds"');
    if (b.backend !== undefined) {
        const be = b.backend as Partial<NonNullable<BoardDefinition['backend']>>;
        if (be.constraints !== 'xdc' && be.constraints !== 'qsf-sdc') fail('BOARD_BACKEND_INVALID', 'backend.constraints must be "xdc" or "qsf-sdc"');
        for (const k of ['implementation', 'programming'] as const) if (typeof be[k] !== 'string' || be[k] === '') fail('BOARD_BACKEND_INVALID', `backend.${k} is required`);
        if (be.programmingFormat !== 'bit' && be.programmingFormat !== 'svf' && be.programmingFormat !== 'sof') fail('BOARD_BACKEND_INVALID', 'backend.programmingFormat must be "bit", "svf" or "sof"');
        if (be.jtagIdcode !== undefined && !/^0x[0-9a-fA-F]{1,8}$/.test(String(be.jtagIdcode))) fail('BOARD_BACKEND_INVALID', 'backend.jtagIdcode must be hex text like "0x031050dd"');
    }
    if (!Array.isArray(b.resources)) {
        fail('BOARD_FIELD_MISSING', 'missing "resources" array');
        return problems;
    }

    const seen = new Set<string>();
    for (const r of b.resources as Partial<BoardResource>[]) {
        const rid = typeof r.id === 'string' ? r.id : '<unnamed>';
        if (typeof r.id !== 'string' || r.id === '') fail('BOARD_RESOURCE_INVALID', 'resource without id');
        else if (seen.has(r.id)) fail('BOARD_RESOURCE_DUPLICATE', `duplicate resource "${r.id}"`);
        else seen.add(r.id);
        if (!Array.isArray(r.pins) || r.pins.length === 0 || r.pins.some((p) => typeof p !== 'string' || p === '')) {
            fail('BOARD_RESOURCE_INVALID', `resource "${rid}" needs a non-empty "pins" array`);
        }
        if (typeof r.ioStandard !== 'string' || r.ioStandard === '') {
            fail('BOARD_RESOURCE_INVALID', `resource "${rid}" needs "ioStandard"`);
        }
        if (r.clock !== undefined && !(typeof r.clock.frequencyHz === 'number' && r.clock.frequencyHz > 0)) {
            fail('BOARD_RESOURCE_INVALID', `resource "${rid}" has an invalid clock.frequencyHz`);
        }
    }
    return problems;
}

/** Loads every boards/<id>/board.json under a directory. */
export class BoardRegistry {
    private constructor(private readonly byId: ReadonlyMap<string, BoardDefinition>) {}

    static fromDefinitions(boards: readonly BoardDefinition[]): BoardRegistry {
        return new BoardRegistry(new Map(boards.map((b) => [b.id, b])));
    }

    static async loadDirectory(boardsDir: string): Promise<{ registry: BoardRegistry } & BoardLoadResult> {
        const boards: BoardDefinition[] = [];
        const diagnostics: Diagnostic[] = [];
        let entries: string[];
        try {
            entries = (await readdir(boardsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
        } catch (err) {
            diagnostics.push(errorDiag('board', 'BOARD_DIR_UNREADABLE', `cannot read boards directory ${boardsDir}: ${String(err)}`));
            return { registry: BoardRegistry.fromDefinitions([]), boards, diagnostics };
        }

        for (const dir of entries.sort()) {
            const file = join(boardsDir, dir, 'board.json');
            let data: unknown;
            try {
                data = JSON.parse(await readFile(file, 'utf8'));
            } catch (err) {
                diagnostics.push(errorDiag('board', 'BOARD_FILE_INVALID', `${file}: ${String(err)}`));
                continue;
            }
            const problems = validateBoardDefinition(data, file);
            if (problems.length > 0) {
                diagnostics.push(...problems);
                continue;
            }
            const board = data as BoardDefinition;
            if (board.id !== dir) {
                diagnostics.push(errorDiag('board', 'BOARD_ID_MISMATCH', `${file}: id "${board.id}" does not match folder "${dir}"`));
                continue;
            }
            boards.push(board);
        }
        return { registry: BoardRegistry.fromDefinitions(boards), boards, diagnostics };
    }

    get(id: string): BoardDefinition | undefined {
        return this.byId.get(id);
    }

    ids(): string[] {
        return [...this.byId.keys()].sort();
    }

    all(): BoardDefinition[] {
        return this.ids().map((id) => this.byId.get(id)!);
    }
}
