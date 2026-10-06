import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { PROJECT_FOLDERS } from '../../core';

/**
 * The student's "+ Add File" workflow, free of the VS Code API: what kinds of
 * file exist, where each goes, which names are acceptable, what a new file
 * contains, and how it is written or copied into the project. The dialogs
 * (commands.ts) only ask the questions; every rule lives here so it can be
 * tested without a window.
 */
export type AddFileKind = 'source' | 'simulation' | 'constraints';
export type AddFileMode = 'new' | 'copy';

export interface AddFileKindInfo {
    readonly kind: AddFileKind;
    /** What the student picks. */
    readonly label: string;
    readonly description: string;
    /** Project folder the file goes to. */
    readonly folder: string;
    /** The one extension accepted, with the dot. */
    readonly extension: '.vhd' | '.xdc';
}

export const ADD_FILE_KINDS: readonly AddFileKindInfo[] = [
    { kind: 'source', label: 'Source', description: 'VHDL design file (.vhd) → src/', folder: PROJECT_FOLDERS.sources, extension: '.vhd' },
    { kind: 'simulation', label: 'Simulation Testbench', description: 'VHDL testbench (.vhd) → sim/', folder: PROJECT_FOLDERS.simulation, extension: '.vhd' },
    { kind: 'constraints', label: 'Constraint', description: 'Pin and clock constraints (.xdc) → constraints/', folder: PROJECT_FOLDERS.constraints, extension: '.xdc' },
];

export function kindInfo(kind: AddFileKind): AddFileKindInfo {
    return ADD_FILE_KINDS.find((k) => k.kind === kind)!;
}

/** VHDL-2008 reserved words: not usable as an entity (and so file) name. */
const RESERVED = new Set(
    `abs access after alias all and architecture array assert assume attribute begin block body buffer bus case component configuration constant context cover default disconnect downto else elsif end entity exit fairness file for force function generate generic group guarded if impure in inertial inout is label library linkage literal loop map mod nand new next nor not null of on open or others out package parameter port postponed procedure process property protected pure range record register reject release rem report restrict return rol ror select sequence severity shared signal sla sll sra srl strong subtype then to transport type unaffected units until use variable vmode vprop vunit wait when while with xnor xor`.split(
        /\s+/,
    ),
);

const VHDL_NAME = /^[A-Za-z](?:[A-Za-z0-9]|_(?!_|$))*$/;
const XDC_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Appends the kind's extension when the name has none; leaves any other extension alone (validateFileName rejects it). */
export function withExtension(kind: AddFileKind, name: string): string {
    const trimmed = name.trim();
    return extname(trimmed) === '' ? `${trimmed}${kindInfo(kind).extension}` : trimmed;
}

/**
 * Checks a file name (with or without the extension). Only `.vhd` is
 * accepted for Source and Testbench and only `.xdc` for Constraint:
 * `.vhdl`, `.txt`, Verilog and every other format are refused. Names are
 * limited to English letters, digits, `_` (and `-`, `.` in XDC names)
 * because GHDL cannot read other characters in its library files.
 * Returns a student-readable problem, or undefined if the name is fine.
 */
export function validateFileName(kind: AddFileKind, name: string): string | undefined {
    const info = kindInfo(kind);
    const full = withExtension(kind, name);
    if (full === info.extension) return 'Enter a file name.';
    const ext = extname(full);
    if (ext.toLowerCase() !== info.extension) {
        return `Only ${info.extension} files can be added here${ext ? ` (not ${ext})` : ''}.`;
    }
    const stem = full.slice(0, -ext.length);
    if (kind === 'constraints') {
        return XDC_NAME.test(stem) ? undefined : 'Use only English letters, digits, "_", "-" and "." in the file name, starting with a letter or digit.';
    }
    if (!VHDL_NAME.test(stem)) {
        return 'The file name becomes the VHDL entity name: start with a letter, then use only English letters, digits and single "_" (no spaces, no "__", no trailing "_").';
    }
    if (RESERVED.has(stem.toLowerCase())) return `"${stem}" is a reserved VHDL word and cannot be used as an entity name.`;
    return undefined;
}

/**
 * Name rule for a file copied in from the computer. The extension must match
 * exactly like validateFileName, but the stem keeps whatever a VHDL file may
 * legitimately be called (`my-design.vhd`); it only has to be something GHDL
 * can read: English letters, digits, "_", "-" and ".".
 */
export function validateCopyName(kind: AddFileKind, name: string): string | undefined {
    const info = kindInfo(kind);
    const ext = extname(name);
    if (ext.toLowerCase() !== info.extension) return `Only ${info.extension} files can be added here${ext ? ` (not ${ext})` : ''}.`;
    const stem = name.slice(0, name.length - ext.length);
    if (!XDC_NAME.test(stem)) return `The file name "${name}" has characters NexysVHDL's tools cannot read. Use only English letters, digits, "_", "-" and "." (no spaces), starting with a letter or digit.`;
    return undefined;
}

/** Normalizes a valid name to its on-disk form: the kind's extension in lower case, the stem untouched. */
export function normalizeFileName(kind: AddFileKind, name: string): string {
    const full = withExtension(kind, name);
    return full.slice(0, full.length - extname(full).length) + kindInfo(kind).extension;
}

/** Project-relative path (`/`-separated) a file of this kind with this name is stored at. */
export function targetPath(kind: AddFileKind, fileName: string): string {
    return `${kindInfo(kind).folder}/${normalizeFileName(kind, fileName)}`;
}

/** Existing entry of the target folder whose name matches `fileName` regardless of case (Windows and macOS file systems are case-insensitive). */
export async function findExisting(root: string, kind: AddFileKind, fileName: string): Promise<string | undefined> {
    const want = normalizeFileName(kind, fileName).toLowerCase();
    const folder = kindInfo(kind).folder;
    try {
        for (const e of await readdir(join(root, folder))) if (e.toLowerCase() === want) return `${folder}/${e}`;
    } catch {
        /* the folder does not exist yet: nothing to collide with */
    }
    return undefined;
}

/** `alu.vhd` -> `alu_2.vhd`, the first name not taken in the target folder. */
export async function suggestFreeName(root: string, kind: AddFileKind, fileName: string): Promise<string> {
    const full = normalizeFileName(kind, fileName);
    const ext = extname(full);
    const stem = full.slice(0, full.length - ext.length);
    for (let n = 2; n < 1000; n++) {
        const candidate = `${stem}_${n}${ext}`;
        if (!(await findExisting(root, kind, candidate))) return candidate;
    }
    return `${stem}_copy${ext}`;
}

/** Whether `candidate` (an absolute path the student chose) already is the file at `relTarget` inside the project. */
export function isSameFile(candidate: string, root: string, relTarget: string): boolean {
    return resolve(candidate).toLowerCase() === resolve(root, ...relTarget.split('/')).toLowerCase();
}

/** Why a chosen file cannot be copied in (wrong format); undefined when its extension is right. */
export function checkCopySource(kind: AddFileKind, chosenPath: string): string | undefined {
    const name = basename(chosenPath);
    const ext = extname(name).toLowerCase();
    const info = kindInfo(kind);
    if (ext === info.extension) return undefined;
    return `"${name}" is not a ${info.extension} file. Only ${info.extension} files can be added here${ext === '.vhdl' ? ' (rename it to .vhd first)' : ''}.`;
}

/** Creates `rel` with `content` (and its folder). Fails if the file exists and `replace` is false. */
export async function writeNewFile(root: string, rel: string, content: string, replace = false): Promise<void> {
    const abs = join(root, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, { encoding: 'utf8', flag: replace ? 'w' : 'wx' });
}

/** Physically copies `from` into the project as `rel`: the project never references a file outside itself. */
export async function copyIntoProject(root: string, rel: string, from: string, replace = false): Promise<void> {
    const abs = join(root, ...rel.split('/'));
    if (!(await stat(from)).isFile()) throw new Error(`${from} is not a file.`);
    await mkdir(dirname(abs), { recursive: true });
    await copyFile(from, abs, replace ? 0 : constants.COPYFILE_EXCL);
}

// ---------------------------------------------------------------- templates

/** Entity name for a file name: the stem, spelled as the student typed it. */
export function entityNameOf(fileName: string): string {
    return fileName.slice(0, fileName.length - extname(fileName).length);
}

/** A VHDL-2008 design file skeleton with the standard IEEE packages. */
export function sourceSkeleton(entity: string): string {
    return `-- ${entity}.vhd: describe what this block does.
--
-- NexysVHDL uses VHDL-2008. Add this entity's ports below. To use it from
-- another file, instantiate it with:
--     u_${entity.toLowerCase()} : entity work.${entity} port map (...);

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ${entity} is
    port (
        clk : in std_logic;  -- 100 MHz board clock (rename or remove as needed)
        rst : in std_logic   -- synchronous reset, active high
        -- Add more ports above: every port except the last ends with ";".
    );
end entity ${entity};

architecture rtl of ${entity} is
    -- Declare signals and constants here.
begin

    -- A clocked process: replace it with your own logic.
    registers : process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                null; -- reset your registers here
            else
                null; -- next-state logic here
            end if;
        end if;
    end process registers;

end architecture rtl;
`;
}

/** A VHDL-2008 testbench skeleton that ends itself with std.env.stop. */
export function testbenchSkeleton(entity: string): string {
    return `-- ${entity}.vhd: testbench. Run it with "NexysVHDL: Simulate".
--
-- A testbench is an entity without ports. The clock below runs forever, so the
-- stimulus process ends the simulation itself with "std.env.stop" (VHDL-2008).
-- Without it Simulate would never finish. (Alternatively, set a fixed length
-- with "Simulation length" in the NexysVHDL Project view.)

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ${entity} is
end entity ${entity};

architecture sim of ${entity} is

    constant CLK_PERIOD : time := 10 ns;  -- 100 MHz

    signal clk : std_logic := '0';
    signal rst : std_logic := '1';

begin

    -- Device under test: replace "your_design" and connect its ports.
    -- dut : entity work.your_design
    --     port map (
    --         clk => clk,
    --         rst => rst
    --     );

    clk <= not clk after CLK_PERIOD / 2;

    stimulus : process
    begin
        -- Hold reset for a few clock cycles.
        wait for 5 * CLK_PERIOD;
        rst <= '0';

        -- Apply inputs and check outputs here, for example:
        --     wait until rising_edge(clk);
        --     assert some_output = '1'
        --         report "some_output should be 1" severity error;
        wait for 20 * CLK_PERIOD;

        report "ALL TESTS PASSED";
        std.env.stop;  -- end the simulation cleanly
        wait;
    end process stimulus;

end architecture sim;
`;
}
