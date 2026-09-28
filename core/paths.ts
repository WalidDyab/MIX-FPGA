import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PACKAGE_NAME = 'nexysvhdl';

/**
 * Directory containing NexysVHDL's package.json, found by walking up from this
 * module. Works from both the TypeScript sources and the compiled dist/ tree.
 */
export function packageRoot(start: string = __dirname): string {
    let dir = start;
    for (;;) {
        const candidate = join(dir, 'package.json');
        if (existsSync(candidate)) {
            try {
                if ((JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }).name === PACKAGE_NAME) return dir;
            } catch {
                /* keep walking */
            }
        }
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`Cannot locate the ${PACKAGE_NAME} package root from ${start}`);
        dir = parent;
    }
}

/** Bundled data directories. */
export function dataPaths(root: string = packageRoot()): { boards: string; toolchains: string } {
    return { boards: join(root, 'boards'), toolchains: join(root, 'toolchains') };
}

export function packageVersion(root: string = packageRoot()): string {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
}
