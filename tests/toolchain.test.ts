import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ConfiguredToolLocator,
    dataPaths,
    type DetectedTool,
    evaluateCompatibility,
    evaluateToolchain,
    loadManifests,
    parseApioVersion,
    parseGhdlVersion,
    parseNextpnrVersion,
    parseOpenXc7ReleaseTag,
    parseYosysVersion,
    selectManifest,
    ToolDetector,
    type ToolExpectation,
    toVersionInfo,
} from '../core';
import { FakeRunner, REPO } from './helpers';

const GHDL_EXPECT: ToolExpectation = { tool: 'ghdl', testedVersions: ['6.0.0'] };
const found = (version?: string): DetectedTool => ({ tool: 'ghdl', found: true, method: 'test', ...(version ? { version } : {}) });

describe('compatibility evaluation', () => {
    it('compatible: detected version is a tested version', () => {
        assert.equal(evaluateCompatibility('ghdl', GHDL_EXPECT, found('6.0.0')).status, 'compatible');
    });
    it('incompatible: detected version differs from every tested version', () => {
        const c = evaluateCompatibility('ghdl', GHDL_EXPECT, found('5.1.1'));
        assert.equal(c.status, 'incompatible');
        assert.match(c.reason, /5\.1\.1/);
    });
    it('missing: tool looked for and not found', () => {
        assert.equal(evaluateCompatibility('ghdl', GHDL_EXPECT, { tool: 'ghdl', found: false, method: 'test' }).status, 'missing');
    });
    it('unknown: not checked, version unreadable, or nothing tested', () => {
        assert.equal(evaluateCompatibility('ghdl', GHDL_EXPECT, undefined).status, 'unknown');
        assert.equal(evaluateCompatibility('ghdl', GHDL_EXPECT, found()).status, 'unknown');
        assert.equal(evaluateCompatibility('ghdl', { tool: 'ghdl', testedVersions: [] }, found('6.0.0')).status, 'unknown');
        assert.equal(evaluateCompatibility('ghdl', undefined, found('6.0.0')).status, 'unknown');
    });

    it('keeps expected and detected versions as separate values', () => {
        const info = toVersionInfo(evaluateCompatibility('ghdl', GHDL_EXPECT, found('5.1.1')));
        assert.deepEqual(info.expected, ['6.0.0']);
        assert.equal(info.detected, '5.1.1');
        assert.deepEqual(GHDL_EXPECT.testedVersions, ['6.0.0'], 'evaluation never mutates the expectation');
    });

    it('overall toolchain status is the worst individual status', () => {
        const manifest = { schemaVersion: 1 as const, id: 'm', description: '', host: { platform: 'p', arch: 'a' }, status: 'reference' as const, tools: [GHDL_EXPECT, { tool: 'apio' as const, testedVersions: ['1.6.0'] }] };
        const ok = new Map([['ghdl', found('6.0.0')], ['apio', { tool: 'apio', found: true, version: '1.6.0', method: 't' }]] as const);
        assert.equal(evaluateToolchain(manifest, ok, ['ghdl', 'apio']).overall, 'compatible');
        const bad = new Map([['ghdl', found('6.0.0')], ['apio', { tool: 'apio', found: false, method: 't' }]] as const);
        assert.equal(evaluateToolchain(manifest, bad, ['ghdl', 'apio']).overall, 'missing');
    });
});

describe('version parsers (real tool output from Phases 1–2)', () => {
    it('parses each tool', () => {
        assert.equal(parseGhdlVersion('GHDL 6.0.0 (6.0.0.r0.ge589c698c.dirty) [Dunoon edition]\n Compiled with GNAT Version: 15.2.0'), '6.0.0');
        assert.equal(parseApioVersion('Apio CLI version 1.6.0 (pyinst-windows-amd64-2026-09-15)'), '1.6.0');
        assert.equal(parseYosysVersion('Yosys 0.63+173 (git sha1 66306a8ca-dirty, x86_64-w64-mingw32-g++ 13.2.1 -O3)'), '0.63+173');
        assert.equal(parseNextpnrVersion('"nextpnr-xilinx" -- Next Generation Place and Route (Version 0eae9fb)'), '0eae9fb');
        assert.equal(parseOpenXc7ReleaseTag('{ "package-name": "openxc7", "release-tag": "2026-09-24" }'), '2026-09-24');
    });
    it('returns undefined for unrecognised text', () => {
        assert.equal(parseGhdlVersion('something else'), undefined);
        assert.equal(parseOpenXc7ReleaseTag('not json'), undefined);
    });
});

describe('toolchain manifests', () => {
    it('loads the reference manifests and selects by host', async () => {
        const { manifests, diagnostics } = await loadManifests(dataPaths(REPO).toolchains);
        assert.deepEqual(diagnostics, []);
        assert.equal(selectManifest(manifests, { platform: 'win32', arch: 'x64' })?.id, 'reference-phase2-windows-x64');
        assert.equal(selectManifest(manifests, { platform: 'darwin', arch: 'arm64' })?.id, 'reference-phase2-macos-arm64');
        assert.equal(selectManifest(manifests, { platform: 'linux', arch: 'x64' }), undefined);
        assert.equal(selectManifest(manifests, { platform: 'win32', arch: 'x64' }, 'reference-phase2-macos-arm64')?.id, 'reference-phase2-macos-arm64');
    });
});

describe('ToolDetector (fake runner, no real tools)', () => {
    it('runs version probes on located executables; Yosys/nextpnr go through Apio', async () => {
        const runner = new FakeRunner((inv) => {
            const a = inv.args.join(' ');
            if (a === '--version' && inv.executable === 'ghdl-path') return { stdout: 'GHDL 6.0.0 (x) [Dunoon edition]\n' };
            if (a === '--version') return { stdout: 'Apio CLI version 1.6.0 (x)\n' };
            if (a.includes('yosys')) return { stdout: 'Yosys 0.63+173 (git sha1 x)\n' };
            if (a.includes('nextpnr')) return { stdout: '"nextpnr-xilinx" -- Next Generation Place and Route (Version 0eae9fb)\n' };
            return { exitCode: 1 };
        });
        const detector = new ToolDetector(new ConfiguredToolLocator({ ghdl: 'ghdl-path', apio: 'apio path with spaces' }), runner);
        const found = await detector.detectAll(['ghdl', 'apio', 'yosys', 'nextpnr-xilinx', 'openxc7', 'programmer']);
        assert.equal(found.get('ghdl')?.version, '6.0.0');
        assert.equal(found.get('apio')?.version, '1.6.0');
        assert.equal(found.get('yosys')?.version, '0.63+173');
        assert.equal(found.get('nextpnr-xilinx')?.version, '0eae9fb');
        assert.equal(found.has('openxc7'), false, 'left to platform adapters');
        assert.equal(found.has('programmer'), false, 'left to platform adapters');
        const yosysCall = runner.calls.find((c) => c.args.includes('yosys'))!;
        assert.equal(yosysCall.executable, 'apio path with spaces');
        assert.deepEqual(yosysCall.args, ['raw', '--', 'yosys', '-V']);
    });

    it('reports a located-but-unstartable tool as not found', async () => {
        const runner = new FakeRunner(() => ({ outcome: 'spawn-failed', exitCode: null, errorMessage: 'ENOENT' }));
        const d = await new ToolDetector(new ConfiguredToolLocator({ ghdl: 'missing.exe' }), runner).detect('ghdl');
        assert.equal(d?.found, false);
    });

    it('does not run anything for tools with no configured location', async () => {
        const runner = new FakeRunner();
        assert.equal(await new ToolDetector(new ConfiguredToolLocator(), runner).detect('ghdl'), undefined);
        assert.equal(runner.calls.length, 0);
    });

    it('reads explicit locations from NEXYSVHDL_* environment variables', async () => {
        const loc = await new ConfiguredToolLocator({}, { NEXYSVHDL_NEXTPNR_XILINX: '/x/nextpnr' }).locate('nextpnr-xilinx');
        assert.deepEqual(loc, { path: '/x/nextpnr', method: 'NEXYSVHDL_NEXTPNR_XILINX' });
    });
});
