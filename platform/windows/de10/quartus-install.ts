import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** A Quartus Prime installation on this computer. */
export interface QuartusInstall {
    /** Install root, e.g. `C:\intelFPGA_lite\25.1std`. */
    readonly root: string;
    /** `<root>\quartus` (the value of QUARTUS_ROOTDIR). */
    readonly quartusDir: string;
    /** `<root>\quartus\bin64`: every command-line tool and the DLLs they load. */
    readonly bin: string;
}

const isFile = (p: string): Promise<boolean> => stat(p).then((s) => s.isFile(), () => false);

export function installAt(root: string): QuartusInstall {
    const quartusDir = join(root, 'quartus');
    return { root, quartusDir, bin: join(quartusDir, 'bin64') };
}

export const quartusTool = (i: QuartusInstall, tool: string): string => join(i.bin, `${tool}.exe`);

/** The first candidate root that really contains the Quartus shell. */
export async function findQuartus(candidates: readonly string[]): Promise<QuartusInstall | undefined> {
    for (const root of candidates) {
        const i = installAt(root);
        if (await isFile(quartusTool(i, 'quartus_sh'))) return i;
    }
    return undefined;
}

/** Other Quartus installs beside the candidates (`C:\intelFPGA_lite\23.1std`), only to explain a version mismatch. */
export async function findOtherQuartus(candidates: readonly string[]): Promise<QuartusInstall[]> {
    const parents = new Set(candidates.map((c) => dirname(c)));
    const out: QuartusInstall[] = [];
    for (const parent of parents) {
        for (const name of await readdir(parent).catch(() => [] as string[])) {
            const i = installAt(join(parent, name));
            if (!candidates.includes(i.root) && (await isFile(quartusTool(i, 'quartus_sh')))) out.push(i);
        }
    }
    return out;
}

/** Environment every Quartus command runs with: the install's own tool folder first, so its DLLs win. */
export function quartusEnv(i: QuartusInstall, basePath: string | undefined = process.env['PATH'] ?? process.env['Path']): Record<string, string> {
    return { QUARTUS_ROOTDIR: i.quartusDir, PATH: `${i.bin};${basePath ?? ''}` };
}
