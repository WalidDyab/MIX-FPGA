import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { dataPaths, evaluateCompatibility, evaluateToolchain, expectationFor, loadManifests, selectManifest, ALL_TOOL_IDS, type ToolchainManifest } from '../../../core';
import {
    APIO_REMOTE_CONFIG_ENV,
    apioRemoteConfigUrl,
    checkApioPin,
    checkOpenXc7Package,
    MacosToolchainDetector,
    MacosToolLocator,
    normalizeOpenXc7Version,
    openXc7Detected,
    parsePinnedTags,
    PinnedApioRunner,
    pinnedConfigDir,
    pinnedConfigFile,
    readOpenXc7Package,
    reportedOpenXc7Version,
} from '../../../platform/macos';
import { REPO } from '../../helpers';
import { APIO, argsInclude, fakeSystem, fixture, HOME, OFL, scriptedRunner, validatedMacFiles } from './macos-fakes';

const PIN_DIR = pinnedConfigDir(dataPaths(REPO).toolchains);
const PIN_FILE_TEXT = readFileSync(join(PIN_DIR, 'apio-1.7.x.jsonc'), 'utf8');
/** The repo's pin, placed at a POSIX path as it would be on a Mac. */
const MAC_PIN_DIR = '/Users/student/My Projects/NexysVHDL/toolchains/apio-remote-config';

async function macManifest(): Promise<ToolchainManifest> {
    const { manifests } = await loadManifests(dataPaths(REPO).toolchains);
    return selectManifest(manifests, { platform: 'darwin', arch: 'arm64' })!;
}

describe('pinned Apio config', () => {
    it('builds a raw file:// URL (Apio 1.7.0 does not percent-decode; spaces stay literal)', () => {
        assert.equal(
            apioRemoteConfigUrl(MAC_PIN_DIR),
            'file:///Users/student/My Projects/NexysVHDL/toolchains/apio-remote-config/apio-{major}.{minor}.x.jsonc',
        );
        assert.doesNotMatch(apioRemoteConfigUrl(MAC_PIN_DIR), /%20/);
    });

    it('rejects relative folders and folders Apio cannot template', () => {
        assert.throws(() => apioRemoteConfigUrl('toolchains/apio-remote-config'), /absolute/);
        assert.throws(() => apioRemoteConfigUrl('/Users/x/{odd}/apio-remote-config'), /characters/);
    });

    it('maps an Apio version to the file Apio reads', () => {
        assert.equal(pinnedConfigFile('/p', '1.7.0'), '/p/apio-1.7.x.jsonc');
        assert.equal(pinnedConfigFile('/p', 'garbage'), undefined);
    });

    it('reads the tracked pin: openxc7 2026-09-25', () => {
        assert.equal(parsePinnedTags(PIN_FILE_TEXT)['openxc7'], '2026-09-25');
    });

    it('builds the environment when the pin for this Apio version exists', async () => {
        const system = fakeSystem({ [`${MAC_PIN_DIR}/apio-1.7.x.jsonc`]: { text: PIN_FILE_TEXT } });
        const pin = await checkApioPin(system, MAC_PIN_DIR, '1.7.0');
        assert.deepEqual(pin.diagnostics, []);
        assert.equal(pin.env?.[APIO_REMOTE_CONFIG_ENV], apioRemoteConfigUrl(MAC_PIN_DIR));
        assert.equal(pin.tags['openxc7'], '2026-09-25');
    });

    it('reports a missing pin for another Apio minor version', async () => {
        const system = fakeSystem({ [`${MAC_PIN_DIR}/apio-1.7.x.jsonc`]: { text: PIN_FILE_TEXT } });
        const pin = await checkApioPin(system, MAC_PIN_DIR, '1.8.0');
        assert.equal(pin.diagnostics[0]?.code, 'MACOS_APIO_PIN_MISSING');
    });

    it('adds the pin to Apio invocations only, overriding an inherited value', async () => {
        const inner = scriptedRunner([[() => true, {}]]);
        const runner = new PinnedApioRunner(inner, { [APIO_REMOTE_CONFIG_ENV]: 'file:///pin/apio-{major}.{minor}.x.jsonc' });
        await runner.run({ executable: APIO, args: ['build'], env: { [APIO_REMOTE_CONFIG_ENV]: 'https://upstream', KEEP: '1' } });
        await runner.run({ executable: OFL, args: ['--Version'] });
        assert.deepEqual(inner.calls[0]!.env, { [APIO_REMOTE_CONFIG_ENV]: 'file:///pin/apio-{major}.{minor}.x.jsonc', KEEP: '1' });
        assert.equal(inner.calls[1]!.env, undefined);
    });
});

describe('openXC7 version normalization', () => {
    it('treats 2026-09-25, 2026.09.25 and 20260925 as the same release', () => {
        for (const v of ['2026-09-25', '2026.09.25', '20260925', ' 2026.09.25 ']) assert.equal(normalizeOpenXc7Version(v), '2026.09.25');
        assert.equal(normalizeOpenXc7Version('2026-13-01'), undefined);
        assert.equal(normalizeOpenXc7Version('e860c9c8'), undefined);
    });

    it('reports the manifest spelling of a matching release, in either form', () => {
        assert.equal(reportedOpenXc7Version('2026-09-25', ['2026.09.25']), '2026.09.25');
        assert.equal(reportedOpenXc7Version('2026.09.24', ['2026-09-24']), '2026-09-24');
        assert.equal(reportedOpenXc7Version('2026-09-27', ['2026.09.25']), '2026.09.27');
    });

    it('makes the dash-form BUILD-INFO tag compatible with the dot-form macOS manifest', async () => {
        const expected = expectationFor(await macManifest(), 'openxc7');
        assert.deepEqual(expected?.testedVersions, ['2026.09.25']);
        const pkg = await readOpenXc7Package(fakeSystem(validatedMacFiles()), `${HOME}/.apio`);
        assert.equal(pkg?.releaseTag, '2026-09-25');
        const detected = openXc7Detected(pkg, expected!.testedVersions);
        assert.equal(detected.rawVersion, '2026-09-25');
        assert.equal(evaluateCompatibility('openxc7', expected, detected).status, 'compatible');
        assert.deepEqual(checkOpenXc7Package(pkg!, { apioVersion: '1.7.0', pinnedTag: '2026-09-25', expectedPlatform: 'darwin-arm64' }), []);
    });

    it('flags the upstream 2026-09-27 package: incompatible, not the pin, parts-index schema 8', async () => {
        const buildInfo = fixture('openxc7-BUILD-INFO.json').replace('"2026-09-25"', '"2026-09-27"');
        const files = validatedMacFiles({
            [`${HOME}/.apio/packages/openxc7/BUILD-INFO.json`]: { text: buildInfo },
            [`${HOME}/.apio/packages/openxc7/XILINX-PARTS-INDEX.json`]: { text: '{ "schema": 8 }' },
            [`${HOME}/.apio/packages/installed_packages.json`]: { text: '{ "openxc7": { "version": "2026.09.27" } }' },
        });
        const pkg = (await readOpenXc7Package(fakeSystem(files), `${HOME}/.apio`))!;
        const expected = expectationFor(await macManifest(), 'openxc7');
        assert.equal(evaluateCompatibility('openxc7', expected, openXc7Detected(pkg, expected!.testedVersions)).status, 'incompatible');
        const codes = checkOpenXc7Package(pkg, { apioVersion: '1.7.0', pinnedTag: '2026-09-25' }).map((d) => d.code);
        assert.deepEqual(codes, ['MACOS_OPENXC7_NOT_PINNED_RELEASE', 'MACOS_OPENXC7_SCHEMA_INCOMPATIBLE']);
    });

    it('reports a missing openXC7 package as not found', async () => {
        const pkg = await readOpenXc7Package(fakeSystem({}), `${HOME}/.apio`);
        assert.equal(pkg, undefined);
        assert.equal(openXc7Detected(pkg, []).found, false);
    });
});

describe('macOS toolchain detection', () => {
    const files = () =>
        validatedMacFiles({ [`${MAC_PIN_DIR}/apio-1.7.x.jsonc`]: { text: PIN_FILE_TEXT } });
    const replies = () =>
        scriptedRunner([
            [argsInclude('yosys'), { stdout: 'Yosys 0.63+173 (git sha1 66306a8ca-dirty, aarch64-apple-darwin23.5-clang++ 18.1.8 -fPIC -O3)\n' }],
            [argsInclude('nextpnr-xilinx'), { stdout: '"nextpnr-xilinx" -- Next Generation Place and Route (Version e860c9c8)\n' }],
            [(i) => i.executable === APIO, { stdout: 'Apio CLI version 1.7.0 (pyinst-darwin-arm64-2026-09-27)\n' }],
            [(i) => i.executable.endsWith('/ghdl'), { stdout: 'GHDL 6.0.0 (6.0.0.r0.ge589c698c) [Dunoon edition]\n' }],
            [(i) => i.executable === OFL, { stdout: fixture('ofl-version.txt') }],
        ]);

    it('detects the validated toolchain as compatible, running every Apio call with the pin', async () => {
        const system = fakeSystem(files());
        const runner = replies();
        const report = await new MacosToolchainDetector(system, new MacosToolLocator(system), runner, MAC_PIN_DIR).detect(await macManifest());
        const versions = Object.fromEntries([...report.tools].map(([k, v]) => [k, v.version]));
        assert.deepEqual(versions, {
            apio: '1.7.0', ghdl: '6.0.0', yosys: '0.63+173', 'nextpnr-xilinx': 'e860c9c8', openxc7: '2026.09.25', programmer: '1.1.1',
        });
        assert.deepEqual(report.diagnostics, []);
        assert.equal(evaluateToolchain(await macManifest(), report.tools, ALL_TOOL_IDS).overall, 'compatible');
        const apioCalls = runner.calls.filter((c) => c.executable === APIO);
        assert.equal(apioCalls.length, 3);
        for (const c of apioCalls) assert.equal(c.env?.[APIO_REMOTE_CONFIG_ENV], apioRemoteConfigUrl(MAC_PIN_DIR));
    });

    it('does not run Yosys/nextpnr probes when the pin file is missing', async () => {
        const system = fakeSystem(validatedMacFiles());
        const runner = replies();
        const report = await new MacosToolchainDetector(system, new MacosToolLocator(system), runner, MAC_PIN_DIR).detect(await macManifest());
        assert.ok(report.diagnostics.some((d) => d.code === 'MACOS_APIO_PIN_MISSING'));
        assert.equal(report.tools.has('yosys'), false);
        assert.ok(runner.calls.every((c) => !c.args.includes('raw')));
    });

    it('reports Node running under Rosetta (x64) as unsupported', async () => {
        const system = fakeSystem(files(), {}, 'x64');
        const report = await new MacosToolchainDetector(system, new MacosToolLocator(system), replies(), MAC_PIN_DIR).detect();
        assert.equal(report.diagnostics[0]?.code, 'MACOS_UNSUPPORTED_ARCH');
    });
});
