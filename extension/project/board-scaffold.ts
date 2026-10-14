import { type BoardConstraintFormat, type BoardDefinition, formatNvproj, formatProjectFile, nvprojNameFor, PROJECT_FILE_NAME } from '../../core';
import { de10Paths, de10StarterProjectFile, de10StarterQsf, de10StarterSdc, de10StarterTestbenchVhdl, de10StarterTopVhdl } from './de10-templates';
import { starterGitignore, starterPaths, starterProjectFile, starterTestbenchVhdl, starterTopVhdl, starterXdc } from './templates';

export type ScaffoldTemplate = 'starter' | 'empty';

/** Every file of a new project (project-relative path -> content) for one constraint format. */
type Scaffolder = (name: string, board: BoardDefinition, template: ScaffoldTemplate) => Record<string, string>;

/** XDC boards (Nexys A7): exactly the original project layout. */
const xdcScaffold: Scaffolder = (name, board, template) => {
    const paths = starterPaths(board);
    return template === 'empty'
        ? {
              [nvprojNameFor(name)]: formatNvproj(),
              [PROJECT_FILE_NAME]: formatProjectFile({
                  name, board: board.id, language: 'vhdl', standard: '2008', top: '', sources: [],
                  simulation: { sources: [] }, constraints: paths.constraints,
              }),
              [paths.constraints]: starterXdc(name, board, { starterPorts: false }),
              '.gitignore': starterGitignore(),
          }
        : {
              [nvprojNameFor(name)]: formatNvproj(),
              [PROJECT_FILE_NAME]: formatProjectFile(starterProjectFile(name, board)),
              [paths.top]: starterTopVhdl(name, board),
              [paths.testbench]: starterTestbenchVhdl(),
              [paths.constraints]: starterXdc(name, board),
              '.gitignore': starterGitignore(),
          };
};

/** Quartus boards (DE10-Lite): VHDL structure + a .qsf (device, pins) and a .sdc (clock). No XDC, no "pins". */
const qsfSdcScaffold: Scaffolder = (name, board, template) => {
    const paths = de10Paths(board);
    const blank = template === 'empty';
    return {
        [nvprojNameFor(name)]: formatNvproj(),
        [PROJECT_FILE_NAME]: formatProjectFile(
            blank ? { name, board: board.id, language: 'vhdl', standard: '2008', top: '', sources: [], simulation: { sources: [] } } : de10StarterProjectFile(name, board),
        ),
        ...(blank ? {} : { [paths.top]: de10StarterTopVhdl(name, board), [paths.testbench]: de10StarterTestbenchVhdl() }),
        [paths.qsf]: de10StarterQsf(name, board, { starterPorts: !blank }),
        [paths.sdc]: de10StarterSdc(board, { starterPorts: !blank }),
        '.gitignore': starterGitignore(),
    };
};

const SCAFFOLDS: Readonly<Record<BoardConstraintFormat, Scaffolder>> = { xdc: xdcScaffold, 'qsf-sdc': qsfSdcScaffold };

/** The one place that decides what a new project for a board contains. */
export function scaffoldFiles(name: string, board: BoardDefinition, template: ScaffoldTemplate): Record<string, string> {
    return SCAFFOLDS[board.backend?.constraints ?? 'xdc'](name, board, template);
}
