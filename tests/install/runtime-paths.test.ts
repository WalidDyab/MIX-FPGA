import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BoardRegistry } from '../../core';
import { De10LiteBackend } from '../../platform/macos/de10/backend';
import { De10Runtime } from '../../platform/macos/de10/runtime';
import { REPO } from '../helpers';
import { ONLY_MACOS } from '../platform';

const boards = BoardRegistry.fromDefinitions([]);

describe('normal runtime resolves tools from the installed MIX-FPGA Toolchain only', () => {
    const tools = (p: { ghdl: string; yosys: string; limactl: string; programmer: string; programmerDataDir: string; provisionScript: string; toolchainRoot: string }) => [p.ghdl, p.yosys, p.limactl, p.programmer, p.programmerDataDir, p.provisionScript, p.toolchainRoot];

    it('the DE10 runtime and backend default to ~/Library/MIX-FPGA/toolchains/1.1/macos-arm64', () => {
        const root = join('/Users/s', 'Library', 'MIX-FPGA', 'toolchains', '1.1', 'macos-arm64');
        for (const paths of [new De10Runtime({ repoRoot: '/some/repo', boards, home: '/Users/s' }).paths, new De10LiteBackend({ repoRoot: '/some/repo', home: '/Users/s' }).paths]) {
            for (const p of tools(paths)) assert.ok(p.startsWith(root), p);
            assert.equal(paths.ghdl, join(root, 'ghdl', 'bin', 'ghdl'));
            assert.equal(paths.limactl, join(root, 'lima', 'bin', 'limactl'));
            assert.equal(paths.programmer, join(root, 'openfpgaloader', 'libexec', 'openFPGALoader'));
            assert.equal(paths.yosys, join(root, 'yosys', 'libexec', 'yosys'));
            assert.equal(paths.limaHome, join('/Users/s', 'Library', 'MIX-FPGA', 'lima'));
        }
    });

    it('no repository path, development variable or old override changes them', { skip: ONLY_MACOS }, () => {
        const saved = { ...process.env };
        try {
            process.env['MIXFPGA_TOOLCHAIN_ROOT'] = '/repo/toolchains/experimental';
            process.env['MIXFPGA_DEV_PAYLOAD'] = '/repo/toolchains/experimental';
            const p = new De10Runtime({ repoRoot: '/repo', boards, home: '/Users/s' }).paths;
            for (const x of tools(p)) assert.doesNotMatch(x, /experimental|\/repo\//, x);
            process.env['MIXFPGA_HOME'] = '/tmp/mf';
            for (const x of tools(new De10Runtime({ repoRoot: '/repo', boards, home: '/Users/s' }).paths)) assert.ok(x.startsWith('/tmp/mf/'), x);
        } finally {
            for (const k of ['MIXFPGA_TOOLCHAIN_ROOT', 'MIXFPGA_DEV_PAYLOAD', 'MIXFPGA_HOME']) if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('the macOS runtime composition does not mention the development folder or the old override', async () => {
        for (const f of ['platform/macos/de10/runtime.ts', 'platform/macos/de10/backend.ts', 'platform/macos/de10/cli.ts', 'platform/macos/de10/engine.ts', 'platform/macos/de10/quartus-lima-provider.ts']) {
            const text = (await readFile(join(REPO, f), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            assert.doesNotMatch(text, /experimental|defaultPaths|MIXFPGA_TOOLCHAIN_ROOT|MIXFPGA_DEV_PAYLOAD|toolchainRoot\?:/, f);
        }
        const multi = await readFile(join(REPO, 'runtime', 'multiboard.ts'), 'utf8');
        const mac = multi.slice(multi.indexOf('de10 = new De10Runtime({'), multi.indexOf('if (!de10 && hostKey === \'windows-x64\')'));
        assert.doesNotMatch(mac, /experimental|toolchainRoot|MIXFPGA_TOOLCHAIN_ROOT/);
        assert.match(mac, /resolveRuntimeLayout\(\)/);
    });
});
