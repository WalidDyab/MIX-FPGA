import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { defaultPaths } from '../../platform/macos/de10/config';
import { REPO } from '../helpers';

async function ts(dir: string): Promise<string[]> {
    return (await readdir(join(REPO, dir), { recursive: true })).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f));
}

describe('MIX-FPGA DE10 backend independence', () => {
    it('defaults every tool path to MIX-FPGA\'s own locations', () => {
        const p = defaultPaths({ repoRoot: '/repo', home: '/home/u' });
        for (const v of [p.limactl, p.programmer, p.programmerDataDir, p.provisionScript, p.limaHome, p.shareDir]) assert.doesNotMatch(v, /nexys/i, v);
        // join(): the same expectations hold on a host whose path separator is a backslash.
        assert.equal(p.limactl, join('/repo', 'toolchains', 'experimental', 'lima-2.2.1', 'bin', 'limactl'));
        assert.equal(p.programmer, join('/repo', 'toolchains', 'experimental', 'openfpgaloader-1.1.1', 'libexec', 'openFPGALoader'));
        assert.equal(p.limaHome, join('/home/u', 'Library', 'MIX-FPGA', 'lima'));
        assert.equal(p.shareDir, join('/home/u', 'Library', 'MIX-FPGA', 'staging'));
    });

    it('has no reference to the NexysVHDL toolchain in the backend sources', async () => {
        const files = [...(await ts('core/backend')), ...(await ts('platform/macos/de10')), 'core/implementation/quartus/parsers.ts'];
        assert.ok(files.length >= 8);
        for (const f of files) {
            const text = (await readFile(join(REPO, f), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            assert.doesNotMatch(text, /NexysVHDL|nexys-?toolchain|Library\/NexysVHDL|\.apio/i, relative(REPO, join(REPO, f)));
        }
    });

    it('does not import the Nexys implementation or programming code (only the dedicated Nexys adapter file may)', async () => {
        const files = [...(await ts('platform/macos/de10')), ...(await ts('core/backend'))].filter((f) => !f.endsWith('core/backend/nexys.ts'));
        assert.ok(files.length >= 8);
        for (const f of files) {
            // Type-only imports (`import type`) carry no runtime dependency and are allowed (the `native` result bridge).
            // The vendor-neutral WorkflowController (Check / Simulate / RTL over GHDL and Yosys) is shared on purpose.
            const text = (await readFile(join(REPO, f), 'utf8')).replace(/^import type .*$/gm, '');
            assert.doesNotMatch(text, /from '[./]*(?:core\/)?(implementation\/apio|programming|platform\/macos\/(?:apio|programmer|openxc7|openfpgaloader))/, f);
        }
    });

    it('never runs tools through a shell on the host', async () => {
        for (const f of await ts('platform/macos/de10')) {
            const text = await readFile(join(REPO, f), 'utf8');
            assert.doesNotMatch(text, /shell:\s*true|child_process/, f);
        }
    });
});
