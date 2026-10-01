import type { ProjectFile, ProjectFilePatch } from '../../core';
import { compileOrder } from '../hierarchy/compile-order';
import type { IndexedFile } from '../hierarchy/design-index';
import type { ScannedFiles } from './project-layout';

const same = (a: readonly string[] | undefined, b: readonly string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Keeps the source lists in nexysvhdl.json in step with the folder
 * contract: every `src/` file is an RTL source and every `sim/` file a
 * simulation source, in dependency (compile) order. Listed files that no
 * longer exist are dropped; listed files outside the standard folders that
 * still exist are kept. Returns the patch to apply, or undefined if the
 * project is already in sync. Pure.
 *
 * `parsed` holds the parsed VHDL of every file to order; `existing` tells
 * which listed paths outside the standard folders exist.
 */
export function computeSourceSync(
    config: Pick<ProjectFile, 'sources' | 'simulation'>,
    scanned: ScannedFiles,
    parsed: ReadonlyMap<string, IndexedFile>,
    existing: ReadonlySet<string> = new Set(),
): ProjectFilePatch | undefined {
    const listedSources = Array.isArray(config.sources) ? config.sources.filter((p) => typeof p === 'string') : [];
    const listedSim = Array.isArray(config.simulation?.sources) ? config.simulation!.sources.filter((p) => typeof p === 'string') : [];

    const collect = (found: readonly string[], listed: readonly string[]) => {
        const set = new Set(found);
        for (const p of listed) if (existing.has(p)) set.add(p);
        return [...set];
    };
    const order = (paths: readonly string[], preferred: readonly string[]) => {
        const files = paths.map((p) => parsed.get(p) ?? { path: p, role: 'source' as const, parsed: { entities: [], architectures: [], packages: [], configurations: [], uses: [] } });
        return compileOrder(files, preferred).order;
    };

    const sources = order(collect(scanned.sources, listedSources), listedSources);
    const simSources = order(collect(scanned.simulation, listedSim), listedSim);

    const patch: ProjectFilePatch = {};
    if (!same(config.sources, sources)) patch.sources = sources;
    if (config.simulation === undefined) {
        if (simSources.length > 0) patch.simulation = { sources: simSources };
    } else if (!same(config.simulation.sources, simSources)) {
        patch.simulation = { ...config.simulation, sources: simSources };
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
}
