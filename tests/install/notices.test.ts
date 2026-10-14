import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadExpectedToolchain } from '../../platform/macos/install/expected';
import { checkCoverage, globToRegExp, isDraft, loadNoticeInventory } from '../../platform/macos/install/notice-inventory';
import { REPO } from '../helpers';

const COMPLIANCE = join(REPO, 'toolchains', 'mixfpga', 'compliance', 'macos-arm64.inventory.json');
const NOTICES = join(REPO, 'toolchains', 'mixfpga', 'notices', 'macos-arm64');
const MANIFEST = join(REPO, 'toolchains', 'mixfpga', 'toolchain-1.0-macos-arm64.json');
/** Components whose licence text is shipped with the program they belong to (same licence, same upstream project). */
const COVERED_BY_PROGRAM_TEXT = new Set(['ghdl-libs', 'ghdl-gpl-headers', 'ghdl-std-library', 'ghdl-vendor-scripts', 'ieee-compiled', 'lima-plugins', 'lima-guest-agents', 'lima-templates', 'ofl-bridge-bitstreams']);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('third-party inventory of Toolchain 1.0 (macOS)', () => {
    it('accounts for every shipped file exactly once, with no stale claims', async () => {
        const inv = await loadNoticeInventory(COMPLIANCE);
        const { toolchain } = await loadExpectedToolchain(MANIFEST);
        const c = checkCoverage(inv, toolchain.units);
        assert.deepEqual(c.unclaimed, [], 'files no component claims');
        assert.deepEqual(c.multiple, [], 'files claimed by several components');
        assert.deepEqual(c.deadClaims, [], 'claims that match nothing');
    });

    it('matches globs the way the inventory uses them', () => {
        assert.ok(globToRegExp('license/**').test('license/x/y'));
        assert.ok(globToRegExp('lib/ghdl/src/ieee/v93/numeric_*.vhdl').test('lib/ghdl/src/ieee/v93/numeric_std-body.vhdl'));
        assert.ok(!globToRegExp('lib/ghdl/src/ieee/*.vhdl').test('lib/ghdl/src/ieee/v93/numeric_std.vhdl'));
        assert.ok(globToRegExp('**').test('anything/at/all'));
    });

    it('every redistributed component states licence, ownership of obligations, and evidence of where it was checked', async () => {
        const inv = await loadNoticeInventory(COMPLIANCE);
        const ids = new Set<string>();
        for (const c of inv.components) {
            assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
            ids.add(c.id);
            assert.ok(c.license && c.name && c.version, c.id);
            assert.ok(['verified', 'inherited', 'pending', 'unclear'].includes(c.status), c.id);
            assert.ok(c.claims?.length || c.embeddedIn?.length, `${c.id} has neither files nor a host program`);
            for (const h of c.embeddedIn ?? []) assert.ok(inv.components.some((x) => x.id === h), `${c.id} embedded in unknown ${h}`);
            // Components whose licence is known and requires a text must ship one.
            if (c.obligation.licenseText && c.status !== 'pending' && c.license !== 'UNCLEAR' && !/^derived|^per /.test(c.license) && !COVERED_BY_PROGRAM_TEXT.has(c.id)) assert.ok(c.licenseTexts.length > 0 || c.licenseCollection !== undefined, `${c.id} needs a licence text`);
            for (const f of c.flags) assert.ok(inv.legalFlags.some((x) => x.id === f), `${c.id} cites unknown flag ${f}`);
        }
    });

    it('copyleft components carry a source plan, or are reported open', async () => {
        const inv = await loadNoticeInventory(COMPLIANCE);
        for (const c of inv.components) {
            if (c.obligation.class === 'strong-copyleft' || c.obligation.class === 'weak-copyleft') {
                assert.ok(c.sources.length > 0, `${c.id}: copyleft but no source pinned`);
                for (const s of c.sources.filter((x) => x.url)) assert.ok(s.revision || s.sha256, `${c.id}/${s.id}: source is not pinned`);
            }
        }
        // The programs and libraries the task calls out are all present.
        const names = inv.components.map((c) => `${c.name} ${c.id}`.toLowerCase()).join('\n');
        for (const want of ['ghdl', 'yosys', 'lima', 'openfpgaloader', 'libusb', 'libftdi', 'hidapi', 'zlib', 'zstd', 'readline', 'tcl', 'ncurses', 'libffi', 'llvm', 'gnat']) assert.ok(names.includes(want), want);
    });

    it('never claims Altera, Rosetta, macOS or Ubuntu as MIX-FPGA-owned or redistributed', async () => {
        const inv = await loadNoticeInventory(COMPLIANCE);
        const redistributed = inv.components.map((c) => `${c.name} ${c.id}`).join('\n');
        assert.doesNotMatch(redistributed, /quartus|altera|rosetta|ubuntu|canonical/i);
        const notShipped = inv.notRedistributed.map((n) => n.id);
        for (const id of ['altera-quartus', 'apple-rosetta', 'apple-system', 'ubuntu-image']) assert.ok(notShipped.includes(id), id);
        const generated = await readFile(join(NOTICES, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
        assert.match(generated, /Altera Quartus Prime Lite/);
        assert.match(generated, /not redistributed/i);
    });

    it('stays marked DRAFT while anything is pending or unclear, and says so in the shipped file', async () => {
        const inv = await loadNoticeInventory(COMPLIANCE);
        const open = inv.components.filter((c) => c.status === 'pending' || c.status === 'unclear');
        assert.ok(open.length > 0 === isDraft(inv));
        const text = await readFile(join(NOTICES, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
        assert.equal(text.startsWith('='.repeat(78)), isDraft(inv));
        if (isDraft(inv)) assert.match(text, /DRAFT - NOT FOR REDISTRIBUTION/);
        // Every flag is listed in the shipped text.
        for (const f of inv.legalFlags) assert.ok(text.includes(`${f.id} [${f.severity}]`), f.id);
    });

    it('ships every licence text unchanged and lists its hash', async () => {
        const inv = await loadNoticeInventory(COMPLIANCE);
        const text = await readFile(join(NOTICES, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
        const dests = [...new Set(inv.components.flatMap((c) => c.licenseTexts.map((t) => t.dest)))];
        assert.ok(dests.length >= 20);
        for (const d of dests) {
            const bytes = await readFile(join(NOTICES, 'LICENSES', d));
            assert.ok(bytes.length > 0, d);
            assert.ok(text.includes(`LICENSES/${d}  ${sha(bytes)}`), `${d}: hash line`);
        }
        const onDisk = (await readdir(join(NOTICES, 'LICENSES'), { recursive: true })).filter((f) => !f.endsWith('/') && f.includes('.') || f.endsWith('COPYING') || f.endsWith('LICENSE'));
        assert.ok(onDisk.length >= dests.length);
        // Repo-curated texts are byte-identical to their sources.
        for (const c of inv.components) for (const t of c.licenseTexts.filter((x) => x.from.startsWith('repo:'))) assert.deepEqual(await readFile(join(NOTICES, 'LICENSES', t.dest)), await readFile(join(REPO, t.from.slice(5))), t.dest);
    });

    it('ships the licence texts of the Go standard library and all 100 Go modules compiled into Lima, hash-verified against the binaries', async () => {
        const go = JSON.parse(await readFile(join(REPO, 'toolchains', 'mixfpga', 'compliance', 'go-licenses.json'), 'utf8')) as {
            stdlib: { version: string; dir: string; files: { name: string; sha256: string }[] };
            modules: { module: string; version: string; goSum: string; sumVerified: boolean; license: string; url: string; zipSha256: string; files: { name: string; sha256: string }[] }[];
        };
        assert.equal(go.modules.length, 100);
        assert.equal(go.stdlib.version, 'go1.27.1');
        for (const m of go.modules) {
            assert.ok(m.sumVerified && /^h1:/.test(m.goSum), `${m.module}: archive hash not verified against the binary`);
            assert.notEqual(m.license, 'NONE-FOUND', m.module);
            assert.match(m.url, /^https:\/\/proxy\.golang\.org\//);
            assert.ok(m.files.length > 0, m.module);
            for (const f of m.files) {
                const shipped = await readFile(join(NOTICES, 'LICENSES', 'lima-go', `${m.module}@${m.version}`, f.name));
                assert.equal(sha(shipped), f.sha256, `${m.module}/${f.name}`);
            }
        }
        for (const f of go.stdlib.files) assert.equal(sha(await readFile(join(NOTICES, 'LICENSES', 'lima-go', `_stdlib@${go.stdlib.version}`, f.name))), f.sha256);
        // The one file-level-copyleft module is called out with a pinned source pointer.
        const mpl = go.modules.filter((m) => m.license.includes('MPL'));
        assert.deepEqual(mpl.map((m) => m.module), ['github.com/hashicorp/hcl/v2']);
        const inv = await loadNoticeInventory(COMPLIANCE);
        const comp = inv.components.find((c) => c.id === 'lima-go-dependencies')!;
        assert.ok(comp.sources.some((x) => x.sha256 === mpl[0]!.zipSha256));
        const text = await readFile(join(NOTICES, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
        assert.match(text, /GO MODULES COMPILED INTO LIMA \(100\)/);
        assert.ok(isDraft(inv), 'the overall notices stay DRAFT');
    });
});
