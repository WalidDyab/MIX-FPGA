import { readFile, readdir, stat } from 'node:fs/promises';
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
    if (board?.backend?.constraints === 'qsf-sdc') {
        // Quartus boards: constraints are the .qsf (device, pins) and .sdc (clocks) files of constraints/.
        d.push(...(await validateQsfSdc(project, board.fpga.device, board.name, hasPins)));
        return { valid: !d.some((x) => x.severity === 'error'), diagnostics: d };
    }
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

/** QSF + SDC constraint check for boards whose backend is `qsf-sdc` (top level of `constraints/`). */
async function validateQsfSdc(project: Project, device: string, boardName: string, hasPins: boolean): Promise<Diagnostic[]> {
    const d: Diagnostic[] = [];
    const loc = { file: project.file };
    const c = project.config;
    if (hasPins) d.push(errorDiag('project', 'PROJECT_PINS_UNSUPPORTED', `${boardName} takes its pin assignments from a .qsf file in constraints/, not from "pins".`, loc));
    if (c.constraints !== undefined) d.push(errorDiag('project', 'PROJECT_CONSTRAINTS_WRONG_FORMAT', `${boardName} uses .qsf and .sdc files in constraints/, not an .xdc file ("constraints").`, loc));
    let names: string[] = [];
    // Files the student removed from the project stay on disk but do not count (and are never built).
    const excluded = new Set(Array.isArray(c.exclude) ? c.exclude : []);
    try {
        names = (await readdir(resolve(project.root, 'constraints'))).filter((n) => !excluded.has(`constraints/${n}`)).sort();
    } catch {
        /* reported below as missing files */
    }
    const qsf = names.filter((n) => /\.qsf$/i.test(n));
    const sdc = names.filter((n) => /\.sdc$/i.test(n));
    const xdc = names.filter((n) => /\.xdc$/i.test(n));
    if (qsf.length === 0) d.push(errorDiag('project', 'PROJECT_NO_QSF', 'No .qsf file in constraints/. A QSF assigns the FPGA device, pins and I/O standards.', loc));
    if (sdc.length === 0) d.push(errorDiag('project', 'PROJECT_NO_SDC', 'No .sdc file in constraints/. An SDC declares the clock so timing can be checked.', loc));
    if (xdc.length > 0) d.push(warningDiag('project', 'PROJECT_XDC_IGNORED', `${xdc.join(', ')}: .xdc files are for the Nexys A7 and are ignored for ${boardName}.`, loc));
    for (const n of qsf) {
        let text = '';
        try {
            text = await readFile(resolve(project.root, 'constraints', n), 'utf8');
        } catch {
            d.push(errorDiag('project', 'PROJECT_CONSTRAINTS_NOT_FOUND', `Cannot read constraints/${n}.`, loc));
            continue;
        }
        // Quartus ignores `#` comments, so they must not count (a comment may mention DEVICE).
        const m = /^\s*set_global_assignment\s+-name\s+DEVICE\s+("?)([A-Za-z0-9]+)\1/im.exec(text.replace(/^\s*#.*$/gm, ''));
        if (!m) d.push(errorDiag('project', 'PROJECT_QSF_NO_DEVICE', `constraints/${n} has no DEVICE assignment; ${boardName} is ${device}.`, loc));
        else if (m[2]!.toUpperCase() !== device.toUpperCase()) d.push(errorDiag('project', 'PROJECT_QSF_WRONG_DEVICE', `constraints/${n} targets ${m[2]} but ${boardName} has ${device}.`, loc));
    }
    return d;
}
