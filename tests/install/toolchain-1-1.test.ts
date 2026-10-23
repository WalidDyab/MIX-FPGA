import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadExpectedToolchain } from '../../platform/macos/install/expected';
import { checkCoverage, loadNoticeInventory } from '../../platform/macos/install/notice-inventory';
import { REPO } from '../helpers';
import { ONLY_MACOS } from '../platform';

// Toolchain 1.1 candidates (Phase 5C): the 1.0 records stay as they are; 1.1 is a separate set of files.
const BUNDLE = join(REPO, 'toolchains', 'bundle');
const MIXFPGA = join(REPO, 'toolchains', 'mixfpga');
const INV11 = join(MIXFPGA, 'compliance', 'macos-arm64-1.1.inventory.json');
const MANIFEST11 = join(MIXFPGA, 'toolchain-1.1-macos-arm64.json');
const NOTICES11 = join(MIXFPGA, 'notices', 'macos-arm64-1.1');
const CANDIDATE_TREE = join(REPO, 'toolchain', 'darwin-arm64-1.1');
const CANDIDATE_PAYLOADS = join(REPO, '.artifacts', 'candidates-1.1', 'payloads');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const json = async (p: string) => JSON.parse(await readFile(p, 'utf8')) as any;

describe('Toolchain 1.0 records are untouched by the 1.1 candidates', () => {
    it('the 1.0 requirement, recipe, manifest and pins are the validated ones', async () => {
        const req = await json(join(BUNDLE, 'requirement.json'));
        assert.equal(req.bundleVersion, '1.0');
        assert.equal(req.targets['darwin-arm64'].treeSha256, 'f04022180f9bb746dc5dc467bc7d1d379512f302159763f8c4a8c0ed50b2aac7');
        assert.equal(sha(await readFile(join(MIXFPGA, 'toolchain-1.0-macos-arm64.json'))), '204532e3b49d8edad92a47577982e1bf383904cc3c889e70df63f8c7453fafe9');
        const pins = await json(join(MIXFPGA, 'payloads-1.0.json'));
        assert.equal(pins.payloads['de10-lite'].sha256, 'f8cbe33f56b54018204ba4f3f9c0a6cf4a4ad8e66145e36787c3b8e47f70eebb');
        assert.equal(pins.payloads['nexys-a7-100t'].sha256, 'd8cdf6e2a6c082d05189396b10892b1a6605a267b2f2b884c9911c9140a2359d');
        const r10 = await json(join(BUNDLE, 'darwin-arm64.json'));
        assert.equal(r10.bundleVersion, '1.0');
        assert.equal(r10.status, 'validated');
        assert.ok(!r10.components.some((c: any) => c.postProcess), '1.0 recipe has no post-processing');
    });
});

describe('Nexys A7 recipe for Toolchain 1.1', () => {
    it('pins exactly the archives of 1.0 and changes only the declared components', async () => {
        const r10 = await json(join(BUNDLE, 'darwin-arm64.json'));
        const r11 = await json(join(BUNDLE, 'darwin-arm64-1.1.json'));
        assert.equal(r11.bundleVersion, '1.1');
        assert.equal(r11.status, 'candidate');
        assert.deepEqual(r11.components.map((c: any) => c.id), r10.components.map((c: any) => c.id));
        for (const c of r11.components) {
            const old = r10.components.find((x: any) => x.id === c.id);
            assert.deepEqual(c.archive, old.archive, `${c.id}: same official archive, same hash`);
            assert.equal(c.version, old.version);
            assert.equal(c.dest, old.dest);
        }
        assert.deepEqual(Object.keys(r11.executables), Object.keys(r10.executables));
        assert.deepEqual(r11.executables, r10.executables);
        const pruned = r11.components.filter((c: any) => c.postProcess).map((c: any) => c.id);
        assert.deepEqual(pruned, ['ghdl', 'apio-oss-cad-suite']);
        const kinds = r11.components.flatMap((c: any) => (c.postProcess ?? []).map((p: any) => p.kind));
        assert.deepEqual(kinds.sort(), ['ghdl-prune', 'ghdl-prune', 'remove', 'remove']);
        for (const p of r11.components.flatMap((c: any) => c.postProcess ?? [])) assert.ok(p.reason && p.reason.length > 20);
    });

    it('corrects the licence labels of Toolchain 1.0 and carries the library licence texts', async () => {
        const r11 = await json(join(BUNDLE, 'darwin-arm64-1.1.json'));
        const by = (id: string) => r11.components.find((c: any) => c.id === id);
        assert.match(by('apio').license, /^GPL-3\.0-or-later/);
        assert.equal(by('apio-definitions').license, 'GPL-3.0-only');
        assert.doesNotMatch(JSON.stringify(r11.components.map((c: any) => [c.license, c.licenseEvidence])), /GPL-2\.0\b(?!-or-later)[^;]*Apio|GNU GPL version 2/);
        assert.deepEqual(r11.licenseDirs, ['licenses-1.1', 'licenses-darwin-arm64-1.1']);
        const shared = await readdir(join(BUNDLE, 'licenses-1.1'));
        const mac = await readdir(join(BUNDLE, 'licenses-darwin-arm64-1.1'));
        assert.ok(!shared.concat(mac).some((f) => /libwdi/i.test(f)), 'libwdi text is Windows-only');
        assert.ok(!shared.concat(mac).includes('graphviz-LICENSE.txt'), 'the EPL-2.0 Graphviz text does not match the EPL-1.0 binary');
        assert.ok(mac.includes('compliance'));
        for (const lib of ['ocs-qt-5.15.3', 'ocs-macports-libusb', 'ocs-macports-libftdi1', 'ocs-macports-readline', 'apio-python-runtime']) assert.ok(existsSync(join(BUNDLE, 'licenses-darwin-arm64-1.1', 'compliance', lib)), lib);
    });

    it('the candidate requirement is separate from the 1.0 requirement', async () => {
        const r = await json(join(BUNDLE, 'requirement-1.1.json'));
        assert.equal(r.bundleVersion, '1.1');
        assert.equal(r.targets['darwin-arm64'].status, 'candidate');
        assert.equal(r.targets['darwin-arm64'].archive, 'nexysvhdl-toolchain-1.1-darwin-arm64.tar.gz');
        assert.match(r.targets['darwin-arm64'].treeSha256, /^[0-9a-f]{64}$/);
    });
});

describe('DE10-Lite inventory and notices of Toolchain 1.1', () => {
    it('accounts for every shipped file exactly once, with no stale claims (so nothing removed is still claimed)', async () => {
        const inv = await loadNoticeInventory(INV11);
        const { toolchain } = await loadExpectedToolchain(MANIFEST11);
        assert.equal(toolchain.toolchainVersion, '1.1');
        const c = checkCoverage(inv, toolchain.units);
        assert.deepEqual(c.unclaimed, []);
        assert.deepEqual(c.multiple, []);
        assert.deepEqual(c.deadClaims, []);
    });

    it('drops the removed components, closes what the evidence closes and keeps the counsel items open', async () => {
        const inv = await loadNoticeInventory(INV11);
        assert.equal(inv.status, 'CANDIDATE');
        const ids = inv.components.map((c) => c.id);
        for (const gone of ['ieee-1076-3-1995', 'vital-libraries', 'upf-library', 'ofl-bridge-bitstreams']) assert.ok(!ids.includes(gone), gone);
        const open = inv.legalFlags.filter((f) => f.status !== 'resolved').map((f) => f.id).sort();
        assert.deepEqual(open, ['L3', 'L9'], 'only the items that need counsel stay open');
        const resolved = inv.legalFlags.filter((f) => f.status === 'resolved').map((f) => f.id);
        for (const id of ['L1', 'L2', 'L4', 'L5', 'L6', 'L7', 'L8', 'L10', 'L11']) assert.ok(resolved.includes(id), id);
        for (const f of inv.legalFlags.filter((x) => x.status === 'resolved')) assert.ok(f.resolution && f.resolution.length > 20, f.id);
        for (const c of inv.components) for (const f of c.flags) assert.ok(inv.legalFlags.some((x) => x.id === f), `${c.id} cites ${f}`);
        assert.ok(inv.modifications && inv.modifications.length >= 5);
        assert.match(inv.sourceOffer.status, /No written offer/);
        assert.ok(inv.sourceOffer.mustProvideForRelease.some((s) => /hashicorp\/hcl/.test(s)));
    });

    it('the shipped notices are a CANDIDATE, list the changes, and carry the Lima NOTICE and the Yosys library texts', async () => {
        const text = await readFile(join(NOTICES11, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
        assert.match(text, /CANDIDATE - COUNSEL REVIEW PENDING/);
        assert.doesNotMatch(text, /DRAFT - NOT FOR REDISTRIBUTION/);
        assert.match(text, /CHANGES MADE BY MIX-FPGA TO UPSTREAM CONTENT/);
        assert.match(text, /IEEE 1076\.3-1995/);
        assert.match(text, /LICENSES\/lima\/NOTICE/);
        assert.match(text, /LICENSES\/yosys-libs\/minisat-LICENSE\.txt/);
        assert.match(text, /No written offer/);
        const lima = await readFile(join(NOTICES11, 'LICENSES', 'lima', 'NOTICE'));
        assert.equal(sha(lima), 'a7e0caed1395c49dfa6ce7dc8aa6362e4daa8369917f56fbe80084c1ae8c765c');
        for (const f of ['minisat-LICENSE.txt', 'cxxopts-LICENSE.txt', 'abc-copyright.txt', 'json11-license-header.txt', 'fstapi-license-header.txt']) assert.ok((await stat(join(NOTICES11, 'LICENSES', 'yosys-libs', f))).size > 100, f);
        assert.ok(!existsSync(join(NOTICES11, 'LICENSES', 'ieee-1076.3-1995')), 'the 1995 IEEE header text is no longer needed');
    });

    it('the 1.1 manifest differs from 1.0 only where the compliance changes say so', async () => {
        const m10 = await json(join(MIXFPGA, 'toolchain-1.0-macos-arm64.json'));
        const m11 = await json(MANIFEST11);
        for (const id of ['yosys', 'lima', 'engine']) {
            const a = m10.units.find((u: any) => u.id === id);
            const b = m11.units.find((u: any) => u.id === id);
            assert.equal(b.treeSha256, a.treeSha256, `${id} is byte-identical to 1.0`);
        }
        for (const id of ['ghdl', 'openfpgaloader', 'licenses', 'notices']) {
            assert.notEqual(m11.units.find((u: any) => u.id === id).treeSha256, m10.units.find((u: any) => u.id === id).treeSha256, id);
        }
        const g10 = m10.units.find((u: any) => u.id === 'ghdl').files.map((f: any) => f.path) as string[];
        const g11 = m11.units.find((u: any) => u.id === 'ghdl').files.map((f: any) => f.path) as string[];
        assert.ok(g10.some((p) => p.includes('v93/numeric_std.vhdl')) && !g11.some((p) => /ieee\/v(87|93)\/|vital|\/upf\/|include\/ghdl\/(vpi_user|synth_gates|synth)\.h/.test(p)), 'the 1995, VITAL, UPF and plugin-development header files are gone');
        const o11 = m11.units.find((u: any) => u.id === 'openfpgaloader').files.map((f: any) => f.path) as string[];
        assert.ok(!o11.some((p) => /OverJtag/.test(p)), 'no bridge bitstreams');
        // everything GHDL ships that is left is unchanged, except the two regenerated indexes
        const h10 = new Map(m10.units.find((u: any) => u.id === 'ghdl').files.map((f: any) => [f.path, f.sha256]));
        for (const f of m11.units.find((u: any) => u.id === 'ghdl').files) {
            if (/ieee\/v(08|19)\/ieee-obj(08|19)\.cf$/.test(f.path)) assert.notEqual(f.sha256, h10.get(f.path), f.path);
            else assert.equal(f.sha256, h10.get(f.path), f.path);
        }
    });
});

describe('Toolchain 1.1 candidate payloads and pruned GHDL', () => {
    const built = existsSync(join(CANDIDATE_TREE, 'toolchain-manifest.json'));

    it('the candidate pins match the built archives', { skip: !existsSync(CANDIDATE_PAYLOADS) && 'no candidate payloads built here' }, async () => {
        const pins = (await json(join(MIXFPGA, 'payloads-1.1.json'))).payloads;
        for (const id of ['nexys-a7-100t', 'de10-lite']) {
            const file = join(CANDIDATE_PAYLOADS, pins[id].file);
            assert.equal((await stat(file)).size, pins[id].bytes, id);
            assert.equal(sha(await readFile(file)), pins[id].sha256, id);
        }
    });

    it('the Nexys candidate has no 1995, VITAL, UPF or bridge-bitstream content, and its manifest lists every change', { skip: !built && 'no assembled candidate here' }, async () => {
        const manifest = await json(join(CANDIDATE_TREE, 'toolchain-manifest.json'));
        assert.equal(manifest.bundleVersion, '1.1');
        assert.ok(manifest.modifications.length === 4);
        for (const gone of ['ghdl/include/ghdl/vpi_user.h', 'ghdl/include/ghdl/synth_gates.h', 'ghdl/include/ghdl/synth.h', 'ghdl/lib/ghdl/ieee/v87', 'ghdl/lib/ghdl/ieee/v93', 'ghdl/lib/ghdl/src/ieee', 'ghdl/lib/ghdl/src/vital95', 'ghdl/lib/ghdl/src/vital2000', 'ghdl/lib/ghdl/src/upf', 'apio/packages/oss-cad-suite/lib/ghdl/ieee/v87', 'apio/packages/oss-cad-suite/lib/ghdl/ieee/v93', 'apio/packages/oss-cad-suite/lib/ghdl/src/vital2000']) assert.ok(!existsSync(join(CANDIDATE_TREE, gone)), gone);
        assert.equal((await readdir(join(CANDIDATE_TREE, 'apio/packages/oss-cad-suite/share/openFPGALoader')).catch(() => [])).length, 0);
        for (const cf of ['ghdl/lib/ghdl/ieee/v08/ieee-obj08.cf', 'ghdl/lib/ghdl/ieee/v19/ieee-obj19.cf', 'apio/packages/oss-cad-suite/lib/ghdl/ieee/v08/ieee-obj08.cf', 'apio/packages/oss-cad-suite/lib/ghdl/ieee/v19/ieee-obj19.cf']) {
            assert.doesNotMatch(await readFile(join(CANDIDATE_TREE, cf), 'latin1'), /vital|upf|v87|v93/i, cf);
        }
        // the oss-cad-suite copy of the index is the pruned JIT tree's, except for its own upstream analysis timestamps
        const stamp = (t: string) => t.replace(/"\d{14}\.\d+"/g, '"TS"');
        for (const v of ['08', '19']) {
            const jit = await readFile(join(CANDIDATE_TREE, `ghdl/lib/ghdl/ieee/v${v}/ieee-obj${v}.cf`), 'latin1');
            const ocs = await readFile(join(CANDIDATE_TREE, `apio/packages/oss-cad-suite/lib/ghdl/ieee/v${v}/ieee-obj${v}.cf`), 'latin1');
            assert.equal(stamp(ocs), stamp(jit), `v${v}`);
        }
    });

    it('GHDL --std=08 (what MIX-FPGA runs) still analyses, simulates and synthesizes; removed units fail clearly', { skip: ONLY_MACOS || (!built && 'no assembled candidate here') }, async () => {
        const ghdl = join(CANDIDATE_TREE, 'ghdl', 'bin', 'ghdl');
        const work = await mkdtemp(join(tmpdir(), 'ghdl11-'));
        try {
            const ex = join(REPO, 'examples', 'nexys-a7-counter');
            const run = (args: string[], cwd = work) => spawnSync(ghdl, args, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
            const a = run(['-a', '--std=08', '--workdir=.', join(ex, 'src', 'counter.vhd'), join(ex, 'src', 'top.vhd'), join(ex, 'sim', 'counter_tb.vhd')]);
            assert.equal(a.status, 0, a.stderr);
            assert.equal(run(['-e', '--std=08', '--workdir=.', 'counter_tb']).status, 0);
            const sim = run(['-r', '--std=08', '--workdir=.', 'counter_tb', '--stop-time=3us']);
            assert.match(`${sim.stdout}${sim.stderr}`, /ALL TESTS PASSED/);
            const syn = run(['--synth', '--std=08', '--workdir=.', '--out=verilog', 'top']);
            assert.equal(syn.status, 0, syn.stderr);
            assert.match(syn.stdout, /^module /m);
            // 2008 packages MIX-FPGA students use are present; the removed ones are "not found"
            const { writeFile } = await import('node:fs/promises');
            await writeFile(join(work, 'ok.vhd'), 'library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all; use ieee.math_real.all; use ieee.fixed_pkg.all; entity ok is end; architecture a of ok is begin end;\n');
            assert.equal(run(['-a', '--std=08', 'ok.vhd']).status, 0);
            await writeFile(join(work, 'v.vhd'), 'library ieee; use ieee.vital_timing.all; entity v is end; architecture a of v is begin end;\n');
            const v = run(['-a', '--std=08', 'v.vhd']);
            assert.notEqual(v.status, 0);
            assert.match(v.stderr, /not found in library/);
            // the pruned tree equals a fresh GHDL regeneration
            const check = spawnSync(process.execPath, [join(REPO, 'scripts', 'toolchain', 'ghdl-prune.mjs'), '--lib', join(CANDIDATE_TREE, 'ghdl', 'lib', 'ghdl'), '--ghdl', ghdl, '--check'], { encoding: 'utf8' });
            assert.equal(check.status, 0, check.stderr);
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    });
});
