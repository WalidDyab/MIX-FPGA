import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { copyTree, makeWritable } from '../../../core/install/tree';
import { extractTarGz } from '../../../core/toolchain/tar';
import { sha256File } from '../../../core/util/hash';
import type { ToolchainUnit } from './expected';
import type { PayloadSource } from './payload';

/**
 * A support payload delivered as one archive (the release form). The archive's own sha256 is checked before it is opened;
 * it is extracted once into a private work folder, and the installer then verifies every unit it takes from it against the
 * recorded manifest, exactly as for a folder source. `dispose()` removes the work folder.
 */
export class ArchivePayload implements PayloadSource {
    readonly kind = 'archive' as const;
    private extracted: Promise<string> | undefined;
    private dir: string | undefined;

    constructor(
        private readonly archive: string,
        private readonly sha256: string | undefined,
        private readonly workRoot: string,
    ) {}

    describe(): string {
        return basename(this.archive);
    }

    private ensure(signal?: AbortSignal): Promise<string> {
        this.extracted ??= (async () => {
            if (this.sha256 && (await sha256File(this.archive)) !== this.sha256) throw new Error(`${basename(this.archive)} is damaged or not the validated file.`);
            const dir = join(this.workRoot, `payload-${randomBytes(4).toString('hex')}`);
            await mkdir(dir, { recursive: true });
            this.dir = dir;
            await extractTarGz(this.archive, dir, signal ? { signal } : {});
            return dir;
        })();
        return this.extracted;
    }

    async has(unit: ToolchainUnit): Promise<boolean> {
        const dir = await this.ensure();
        return lstat(join(dir, unit.path)).then(() => true, () => false);
    }

    async materialize(unit: ToolchainUnit, dest: string, signal?: AbortSignal): Promise<void> {
        await copyTree(join(await this.ensure(signal), unit.path), dest);
    }

    async dispose(): Promise<void> {
        if (!this.dir) return;
        await makeWritable(this.dir).catch(() => undefined);
        await rm(this.dir, { recursive: true, force: true });
        this.dir = undefined;
        this.extracted = undefined;
    }
}
