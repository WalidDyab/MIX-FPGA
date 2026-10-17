import { copyTree } from '../../../core/install/tree';
import type { ToolchainUnit } from './expected';
import { stat } from 'node:fs/promises';

/**
 * Where the installer gets the bytes from. The installer verifies everything it receives against
 * the committed manifest, so a source is only a supplier, never trusted. A release will provide an
 * archive source; this phase's only source is a folder of already-validated tools.
 */
export interface PayloadSource {
    readonly kind: 'directory' | 'archive';
    describe(): string;
    has(unit: ToolchainUnit): Promise<boolean>;
    /** Copy the unit to `dest` (a folder for most units, a single file for file units). */
    materialize(unit: ToolchainUnit, dest: string, signal?: AbortSignal): Promise<void>;
}

/** Units supplied from folders on disk: `sources` maps a unit id to the folder (or file) to copy. */
export class DirectoryPayload implements PayloadSource {
    readonly kind = 'directory' as const;
    constructor(
        private readonly sources: Readonly<Record<string, string>>,
        private readonly label = 'folder',
    ) {}

    describe(): string {
        return this.label;
    }

    async has(unit: ToolchainUnit): Promise<boolean> {
        const src = this.sources[unit.id];
        return src !== undefined && (await stat(src).then(() => true, () => false));
    }

    async materialize(unit: ToolchainUnit, dest: string, signal?: AbortSignal): Promise<void> {
        const src = this.sources[unit.id];
        if (!src) throw new Error(`the payload does not contain ${unit.id}`);
        if (signal?.aborted) throw new Error('cancelled');
        await copyTree(src, dest);
    }
}
