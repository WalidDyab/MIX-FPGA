import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { BoardRegistry } from '../board/board-registry';
import { generateXdc } from '../board/constraints';
import { type Diagnostic, errorDiag, warningDiag } from '../results/diagnostic';
import { normalizeStopTime, type Project, STOP_TIME_UNITS } from './types';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface ProjectValidation {
    readonly valid: boolean;
    readonly diagnostics: readonly Diagnostic[];
}

/** A project-relative path must stay inside the project and use `/`. */
function checkRelativePath(root: string, p: string, field: string): Diagnostic | undefined {
    if (p.trim() === '') return errorDiag('project', 'PROJECT_PATH_INVALID', `${field}: empty path`);
    if (isAbsolute(p) || /^[A-Za-z]:/.test(p)) {
        return errorDiag('project', 'PROJECT_PATH_ABSOLUTE', `${field}: "${p}" must be relative to the project folder`);
    }
    if (p.includes('\\')) {
        return errorDiag('project', 'PROJECT_PATH_BACKSLASH', `${field}: "${p}" must use "/" so the project works on every platform`);
    }
    const rel = relative(root, resolve(root, p));
    if (rel.startsWith('..') || isAbsolute(rel)) {
        return errorDiag('project', 'PROJECT_PATH_OUTSIDE', `${field}: "${p}" points outside the project folder`);
    }
    return undefined;
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

/**
 * Validates a loaded project against the board registry and the file system.
 * Collects every problem instead of stopping at the first.
 */
export async function validateProject(project: Project, boards: BoardRegistry): Promise<ProjectValidation> {
    const d: Diagnostic[] = [];
    const c = project.config;
    const loc = { file: project.file };

    if (typeof c.name !== 'string' || c.name.trim() === '') {
        d.push(errorDiag('project', 'PROJECT_MISSING_NAME', 'Project name is missing.', loc));
    }
    if (typeof c.top !== 'string' || c.top.trim() === '') {
        d.push(errorDiag('project', 'PROJECT_MISSING_TOP', 'Top entity is missing ("top").', loc));
    } else if (!IDENTIFIER.test(c.top)) {
        d.push(errorDiag('project', 'PROJECT_TOP_INVALID', `Top entity "${c.top}" is not a valid VHDL identifier.`, loc));
    }
    if (c.language !== 'vhdl') {
        d.push(errorDiag('project', 'PROJECT_LANGUAGE_UNSUPPORTED', `Language "${String(c.language)}" is not supported; use "vhdl".`, loc));
    }
    if (c.standard !== '2008') {
        d.push(errorDiag('project', 'PROJECT_STANDARD_UNSUPPORTED', `VHDL standard "${String(c.standard)}" is not supported; use "2008".`, loc));
    }

    const board = typeof c.board === 'string' ? boards.get(c.board) : undefined;
    if (!board) {
        d.push(
            errorDiag(
                'project',
                'PROJECT_BOARD_UNSUPPORTED',
                `Board "${String(c.board)}" is not supported. Supported: ${boards.ids().join(', ') || '(none loaded)'}.`,
                loc,
            ),
        );
    }

    const sources = Array.isArray(c.sources) ? c.sources : [];
    if (sources.length === 0) {
        d.push(errorDiag('project', 'PROJECT_NO_SOURCES', 'No RTL source files are listed ("sources").', loc));
    }
    const simSources = Array.isArray(c.simulation?.sources) ? c.simulation.sources : [];

    const seen = new Set<string>();
    for (const [field, list] of [['sources', sources], ['simulation.sources', simSources]] as const) {
        for (const p of list) {
            if (typeof p !== 'string') {
                d.push(errorDiag('project', 'PROJECT_PATH_INVALID', `${field}: entries must be strings`, loc));
                continue;
            }
            const pathProblem = checkRelativePath(project.root, p, field);
            if (pathProblem) {
                d.push(pathProblem);
                continue;
            }
            if (seen.has(p)) d.push(errorDiag('project', 'PROJECT_SOURCE_DUPLICATE', `"${p}" is listed more than once.`, loc));
            seen.add(p);
            if (!/\.(vhd|vhdl)$/i.test(p)) {
                d.push(errorDiag('project', 'PROJECT_SOURCE_NOT_VHDL', `"${p}" is not a .vhd/.vhdl file.`, loc));
            } else if (!(await isFile(resolve(project.root, p)))) {
                d.push(errorDiag('project', 'PROJECT_SOURCE_NOT_FOUND', `Source file "${p}" does not exist.`, loc));
            }
        }
    }

    if (c.simulation?.testbench !== undefined && !IDENTIFIER.test(c.simulation.testbench)) {
        d.push(errorDiag('project', 'PROJECT_TESTBENCH_INVALID', `Testbench "${c.simulation.testbench}" is not a valid VHDL identifier.`, loc));
    }
    if (c.simulation?.stopTime !== undefined && (typeof c.simulation.stopTime !== 'string' || normalizeStopTime(c.simulation.stopTime) === undefined)) {
        d.push(errorDiag('project', 'PROJECT_STOP_TIME_INVALID', `Simulation stop time "${String(c.simulation.stopTime)}" is not valid; use a whole number and a unit, e.g. "1us" (units: ${STOP_TIME_UNITS.join(', ')}).`, loc));
    }
    if (c.simulation?.testbench !== undefined && simSources.length === 0) {
        d.push(warningDiag('project', 'PROJECT_TESTBENCH_NO_SOURCES', 'A testbench is selected but no simulation sources are listed.', loc));
    }

    const hasPins = typeof c.pins === 'object' && c.pins !== null && Object.keys(c.pins).length > 0;
    if (c.constraints !== undefined) {
        if (hasPins) {
            d.push(errorDiag('project', 'PROJECT_CONSTRAINTS_AND_PINS', 'Use either a constraints file ("constraints") or pin mappings ("pins"), not both.', loc));
        }
        if (typeof c.constraints !== 'string') {
            d.push(errorDiag('project', 'PROJECT_PATH_INVALID', 'constraints: must be a project-relative path string', loc));
        } else {
            const pathProblem = checkRelativePath(project.root, c.constraints, 'constraints');
            if (pathProblem) d.push(pathProblem);
            else if (!/\.xdc$/i.test(c.constraints)) {
                d.push(errorDiag('project', 'PROJECT_CONSTRAINTS_NOT_XDC', `"${c.constraints}" is not an .xdc file.`, loc));
            } else if (!(await isFile(resolve(project.root, c.constraints)))) {
                d.push(errorDiag('project', 'PROJECT_CONSTRAINTS_NOT_FOUND', `Constraints file "${c.constraints}" does not exist.`, loc));
            }
        }
    } else if (!hasPins) {
        d.push(errorDiag('project', 'PROJECT_NO_PINS', 'No constraints: set "constraints" to an XDC file or define pin mappings ("pins").', loc));
    } else if (board) {
        d.push(...generateXdc(board, c.pins!).diagnostics);
    }

    return { valid: !d.some((x) => x.severity === 'error'), diagnostics: d };
}
