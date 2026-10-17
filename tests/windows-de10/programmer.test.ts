import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DE10_LITE_PROFILE, type ProgramRequest, type ProgrammingArtifactRef } from '../../core/backend';
import { NativeQuartusEngine } from '../../platform/windows/de10/native-quartus-engine';
import { parseCables, parseChains, QuartusPgmProgrammer } from '../../platform/windows/de10/quartus-programmer';
import { REPO, tempDir, writeFiles } from '../helpers';
import { makeHarness, MAC } from '../multiboard/harness';
import { harness } from './harness';
import { FakeQuartusRunner, windowsEnv, type Hardware, type QuartusOptions } from './fake-quartus';

async function direct(t: import('node:test').TestContext, hardware: Hardware = {}, o: QuartusOptions = {}) {
    const env = await windowsEnv(t, { ...o, hardware });
    const runner = new FakeQuartusRunner(env, { ...o, hardware });
    const programmer = new QuartusPgmProgrammer(new NativeQuartusEngine(env.paths, runner));
    const dir = await tempDir(t);
    await writeFiles(dir, { 'out/blink.sof': 'SOF-BYTES-123', 'out/blink.svf': 'SVF' });
    const sof = join(dir, 'out', 'blink.sof');
    const ref = (over: Partial<ProgrammingArtifactRef> = {}): ProgrammingArtifactRef => ({ path: sof, format: 'sof', sizeBytes: 13, sha256: createHash('sha256').update('SOF-BYTES-123').digest('hex'), ...over });
    const req = (over: Partial<ProgramRequest> = {}): ProgramRequest => ({ artifact: ref(), board: DE10_LITE_PROFILE, ...over });
    return { env, runner, programmer, dir, sof, ref, req };
}

describe('Windows DE10-Lite programmer: parsing Quartus output', () => {
    it('lists cables and chains exactly as Quartus prints them', () => {
        assert.deepEqual(parseCables('1) USB-Blaster [USB-0]\r\n2) USB-Blaster [USB-1]\r\nInfo: ok'), ['USB-Blaster [USB-0]', 'USB-Blaster [USB-1]']);
        const chains = parseChains('1) USB-Blaster [USB-0]\r\n  031050DD   10M50DA(.|ES)/10M50DC\r\n\r\n2) USB-Blaster [USB-1]\r\n  Unable to read device chain - JTAG chain broken\r\n');
        assert.equal(chains.length, 2);
        assert.deepEqual(chains[0]!.devices.map((d) => [d.index, d.idcode, d.model]), [[1, 0x031050dd, '10M50DA(.|ES)/10M50DC']]);
        assert.equal(chains[1]!.devices.length, 0);
        assert.match(chains[1]!.problem!, /JTAG chain broken/);
    });
});

describe('Windows DE10-Lite programmer: detect', () => {
    it('the expected USB-Blaster with the MAX 10 on its chain is detected', async (t) => {
        const { programmer } = await direct(t);
        const d = await programmer.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'detected');
        assert.deepEqual(d.probes.map((p) => p.description), ['USB-Blaster [USB-0]']);
        assert.equal(d.devices[0]?.idcode, 0x031050dd);
    });

    it('cable absent: no cable at all', async (t) => {
        const d = await (await direct(t, { cables: [] })).programmer.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'board-absent');
        assert.equal(d.diagnostics[0]?.code, 'CABLE_ABSENT');
    });

    it('cable absent: only some other cable is connected', async (t) => {
        const d = await (await direct(t, { cables: ['JTAG-ICE [USB-0]'] })).programmer.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'board-absent');
        assert.equal(d.diagnostics[0]?.code, 'CABLE_ABSENT');
        assert.match(d.diagnostics[0]!.message, /JTAG-ICE/);
    });

    it('board absent: the cable is there but the board is off, so the chain is empty', async (t) => {
        const d = await (await direct(t, { chains: { 'USB-Blaster [USB-0]': 'none' } })).programmer.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'board-absent');
        assert.equal(d.diagnostics[0]?.code, 'BOARD_ABSENT');
        assert.match(d.diagnostics[0]!.message, /switched on/);
    });

    it('wrong IDCODE: another FPGA on the cable is reported, not programmed', async (t) => {
        const d = await (await direct(t, { chains: { 'USB-Blaster [USB-0]': ['020F10DD'] } })).programmer.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'unexpected-device');
        assert.equal(d.diagnostics[0]?.code, 'UNEXPECTED_DEVICE');
        assert.match(d.diagnostics[0]!.message, /0x020f10dd.*expected 0x031050dd/);
    });

    it('several USB-Blasters are ambiguous: refused with an instruction, no guessing', async (t) => {
        const d = await (await direct(t, { cables: ['USB-Blaster [USB-0]', 'USB-Blaster [USB-1]'] })).programmer.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'error');
        assert.equal(d.diagnostics[0]?.code, 'CABLE_AMBIGUOUS');
        assert.match(d.diagnostics[0]!.message, /Disconnect all but/);
    });

    it('a JTAG server / Quartus failure is reported as such', async (t) => {
        const d = await (await direct(t, { serverFails: true })).programmer.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'error');
        assert.equal(d.diagnostics[0]?.code, 'JTAG_SERVER_FAILED');
    });

    it('no Quartus: programmer missing', async (t) => {
        const d = await (await direct(t, {}, { install: 'none' })).programmer.detect(DE10_LITE_PROFILE);
        assert.equal(d.status, 'programmer-missing');
        const a = await (await direct(t, {}, { install: 'none' })).programmer.availability();
        assert.equal(a.available, false);
    });

    it('availability reports the Quartus programmer version', async (t) => {
        const a = await (await direct(t)).programmer.availability();
        assert.equal(a.available, true);
        assert.match(a.detail, /Quartus Programmer 25\.1std\.0 Build 1129/);
    });
});

describe('Windows DE10-Lite programmer: program', () => {
    it('valid .sof: checks the target first, programs SRAM over JTAG with quartus_pgm, checks the chain again', async (t) => {
        const { programmer, runner, req, dir } = await direct(t);
        const r = await programmer.program(req());
        assert.equal(r.status, 'programmed', JSON.stringify(r.diagnostics));
        assert.equal(r.softwareVerified, true);
        assert.equal(r.diagnostics.find((d) => d.code === 'PROGRAMMED_SRAM')?.severity, 'info');
        const order = runner.calls.map((c) => `${/(\w+)\.exe$/.exec(c.executable)![1]}:${c.args[0] ?? ''}`);
        const prog = order.findIndex((o) => o === 'quartus_pgm:-c');
        assert.ok(order.slice(0, prog).includes('jtagconfig:'), 'chain read before programming');
        assert.ok(order.slice(prog + 1).includes('jtagconfig:'), 'chain read after programming');
        assert.deepEqual(runner.programRuns, [['-c', 'USB-Blaster [USB-0]', '-m', 'jtag', '-o', 'p;blink.sof@1']]);
        const call = runner.calls.find((c) => c.args.includes('-o'))!;
        assert.equal(call.cwd, join(dir, 'out'), 'the file is addressed by name from its own folder');
        assert.equal(call.env?.['QUARTUS_ROOTDIR']?.endsWith('quartus'), true);
    });

    it('SRAM only: the only operation ever requested is p (program) on a .sof; never flash, never a conversion', async (t) => {
        const { programmer, runner, req } = await direct(t);
        await programmer.program(req());
        for (const c of runner.calls) {
            assert.ok(!c.args.some((a) => /\.(pof|jic|rbf|rpd|svf)/i.test(a)), c.args.join(' '));
            assert.doesNotMatch(c.executable, /quartus_(cpf|asm|map|fit|sta)|openFPGALoader/i);
        }
        for (const run of runner.programRuns) assert.match(run[run.indexOf('-o') + 1]!, /^p;[^;]+\.sof@\d$/);
    });

    it('rejects a wrong artifact type before touching the cable', async (t) => {
        const { programmer, runner, req, dir } = await direct(t);
        const svf = join(dir, 'out', 'blink.svf');
        const r = await programmer.program(req({ artifact: { path: svf, format: 'svf', sizeBytes: 3, sha256: createHash('sha256').update('SVF').digest('hex') } }));
        assert.equal(r.status, 'rejected');
        assert.equal(r.diagnostics[0]?.code, 'UNSUPPORTED_ARTIFACT');
        const r2 = await programmer.program(req({ artifact: { ...(await (async () => ({ path: svf, format: 'sof' as const, sizeBytes: 3, sha256: 'x' }))()) } }));
        assert.equal(r2.status, 'rejected', 'a .svf is refused even when labelled .sof');
        assert.equal(runner.calls.length, 0);
    });

    it('rejects a tampered or missing .sof', async (t) => {
        const { programmer, runner, req, sof } = await direct(t);
        await writeFile(sof, 'TAMPERED');
        const r = await programmer.program(req());
        assert.equal(r.status, 'rejected');
        assert.equal(r.diagnostics[0]?.code, 'ARTIFACT_CHANGED');
        const gone = await programmer.program(req({ artifact: { path: join(sof, '..', 'nope.sof'), format: 'sof', sizeBytes: 1, sha256: 'x' } }));
        assert.equal(gone.diagnostics[0]?.code, 'ARTIFACT_MISSING');
        assert.equal(runner.calls.length, 0);
    });

    it('does not program when the board or target is wrong', async (t) => {
        for (const [hw, code] of [[{ cables: [] }, 'CABLE_ABSENT'], [{ chains: { 'USB-Blaster [USB-0]': ['020F10DD'] } }, 'UNEXPECTED_DEVICE'], [{ cables: ['USB-Blaster [USB-0]', 'USB-Blaster [USB-1]'] }, 'CABLE_AMBIGUOUS'], [{ chains: { 'USB-Blaster [USB-0]': 'none' } }, 'BOARD_ABSENT']] as const) {
            const { programmer, runner, req } = await direct(t, hw as Hardware);
            const r = await programmer.program(req());
            assert.equal(r.status, 'failed', code);
            assert.equal(r.diagnostics[0]?.code, code);
            assert.deepEqual(runner.programRuns, [], `${code}: nothing was programmed`);
        }
    });

    it('a quartus_pgm failure (non-zero exit) is a failed program, not a success', async (t) => {
        const { programmer, req } = await direct(t, { programExit: 2 });
        const r = await programmer.program(req());
        assert.equal(r.status, 'failed');
        assert.equal(r.softwareVerified, false);
        assert.equal(r.diagnostics[0]?.code, 'PROGRAM_FAILED');
    });

    it('exit 0 without Quartus saying the device was configured is not trusted', async (t) => {
        const { programmer, req } = await direct(t, { programQuiet: true });
        const r = await programmer.program(req());
        assert.equal(r.status, 'failed');
        assert.match(r.diagnostics[0]!.message, /without reporting that the device was configured/);
    });

    it('the chain must still be readable afterwards, else the program is not reported as successful', async (t) => {
        const { programmer, req } = await direct(t, { chainLostAfterProgram: true });
        const r = await programmer.program(req());
        assert.equal(r.status, 'failed');
        assert.equal(r.softwareVerified, false);
        assert.ok(r.diagnostics.some((d) => d.severity === 'error'));
    });

    it('cancellation while programming is reported as cancelled, with the board state called undefined', async (t) => {
        const ac = new AbortController();
        const { programmer, req } = await direct(t, { onProgram: () => ac.abort() });
        const r = await programmer.program(req({ signal: ac.signal }));
        assert.equal(r.status, 'cancelled');
        assert.equal(r.diagnostics[0]?.code, 'PROGRAM_CANCELLED');
    });
});

describe('Windows selects the .sof, macOS keeps the .svf, through the common backend', () => {
    it('Windows: Build records both artifacts, hashed and typed; the programmer picks the .sof; Program works', async (t) => {
        const h = await harness(t);
        const p = await h.project();
        const r = await h.backend.build(p, () => undefined);
        assert.equal(r.success, true);
        assert.deepEqual(r.normalized?.programmingArtifacts?.map((a) => a.format).sort(), ['sof', 'svf']);
        assert.equal(r.normalized?.programmingArtifact?.format, 'sof', 'the Windows primary artifact is the one its programmer loads');
        const info = JSON.parse(await readFile(join(p.root, '.mix-fpga', 'build', 'de10-lite', 'build-info.json'), 'utf8'));
        assert.equal(info.schema, 2);
        assert.equal(info.artifacts.sof.sha256, createHash('sha256').update(await readFile(join(p.root, '.mix-fpga', 'build', 'de10-lite', 'blink.sof'))).digest('hex'));
        assert.equal(info.artifacts.svf.sha256, createHash('sha256').update(await readFile(join(p.root, '.mix-fpga', 'build', 'de10-lite', 'blink.svf'))).digest('hex'));
        assert.match((await h.backend.bitstream(p))!.path, /blink\.sof$/);
        const prog = await h.backend.program(p, undefined);
        assert.equal(prog.status, 'succeeded', JSON.stringify(prog.diagnostics));
        assert.ok(h.router.quartus.programRuns[0]![5]!.startsWith('p;blink.sof@'));
        assert.ok(h.router.calls.every((c) => !/openFPGALoader/i.test(c.executable)));
    });

    it('macOS: the same build still selects the .svf and programs it with the native programmer', async (t) => {
        const h = await makeHarness(t, { host: MAC });
        const p = await h.de10Project();
        const r = await h.backend.build(p, () => undefined);
        assert.equal(r.success, true);
        assert.equal(r.normalized?.programmingArtifact?.format, 'svf');
        assert.deepEqual(r.normalized?.programmingArtifacts?.map((a) => a.format).sort(), ['sof', 'svf']);
        assert.match((await h.backend.bitstream(p))!.path, /blink\.svf$/);
        const prog = await h.backend.program(p, undefined);
        assert.equal(prog.status, 'succeeded', JSON.stringify(prog.diagnostics));
        assert.equal(h.runner.programmer.programCalls.length, 1);
        assert.ok(h.runner.programmer.programCalls[0]!.args.some((a) => a.endsWith('.svf')));
    });

    it('Program rejects an artifact of another board', async (t) => {
        const h = await harness(t);
        const p = await h.project();
        await h.backend.build(p, () => undefined);
        const f = join(p.root, '.mix-fpga', 'build', 'de10-lite', 'build-info.json');
        await writeFile(f, (await readFile(f, 'utf8')).replace('"board": "de10-lite"', '"board": "nexys-a7-100t"'));
        const r = await h.backend.program(p, undefined);
        assert.equal(r.status, 'failed');
        assert.equal(r.diagnostics[0]?.code, 'PROGRAM_ARTIFACT_WRONG_BOARD');
        assert.deepEqual(h.router.quartus.programRuns, []);
    });

    it('Program rejects an artifact built from sources or constraints that have since changed', async (t) => {
        const h = await harness(t);
        const p = await h.project();
        await h.backend.build(p, () => undefined);
        await writeFile(join(p.root, 'constraints', 'de10-lite.sdc'), 'create_clock -name clk_50 -period 10.000 [get_ports clk_50]\n');
        const r = await h.backend.program(p, undefined);
        assert.equal(r.diagnostics[0]?.code, 'PROGRAM_ARTIFACT_STALE');
        await h.backend.build(p, () => undefined);
        await writeFile(join(p.root, 'src', 'blink.vhd'), (await readFile(join(p.root, 'src', 'blink.vhd'), 'utf8')) + '-- edit\n');
        assert.equal((await h.backend.program(p, undefined)).diagnostics[0]?.code, 'PROGRAM_ARTIFACT_STALE');
        assert.deepEqual(h.router.quartus.programRuns, []);
    });

    it('Program rejects a .sof overwritten after its build: the manifest hash no longer matches the file', async (t) => {
        const h = await harness(t);
        const p = await h.project();
        await h.backend.build(p, () => undefined);
        const sof = join(p.root, '.mix-fpga', 'build', 'de10-lite', 'blink.sof');
        await writeFile(sof, 'A DIFFERENT BUILD OVERWROTE THIS');
        const r = await h.backend.program(p, undefined);
        assert.equal(r.status, 'failed');
        assert.equal(r.diagnostics[0]?.code, 'ARTIFACT_CHANGED');
        assert.deepEqual(h.router.quartus.programRuns, [], 'the cable was never used');
    });

    it('Program with no build says to build first', async (t) => {
        const h = await harness(t);
        const r = await h.backend.program(await h.project(), undefined);
        assert.equal(r.diagnostics[0]?.code, 'PROGRAM_NO_BITSTREAM');
    });
});

describe('No driver management anywhere', () => {
    it('no source file can install, replace, switch or configure a USB driver', async () => {
        const dirs = ['core', 'platform', 'runtime', 'extension'];
        // pnputil is allowed only on a line that merely enumerates the driver store (read only: Setup reports whether Altera's driver is present).
        const bad = /zadig|libwdi|winusb|pnputil(?!.*\/enum-drivers)|devcon|InstallHinfSection|DriverStore|SetupAPI|UpdateDriver|Set-ItemProperty|reg(?:\.exe)?\s+add|sc(?:\.exe)?\s+(?:config|create)|bcdedit/i;
        for (const d of dirs) {
            for (const f of (await readdir(join(REPO, d), { recursive: true })).filter((x) => x.endsWith('.ts'))) {
                // The Windows programmer's own explanation of the driver in comments is allowed; code is not.
                const text = (await readFile(join(REPO, d, f), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
                assert.doesNotMatch(text, bad, `${d}/${f}`);
            }
        }
    });

    it('the Windows backend never starts openFPGALoader', async () => {
        for (const f of (await readdir(join(REPO, 'platform', 'windows'), { recursive: true })).filter((x) => x.endsWith('.ts'))) {
            const text = (await readFile(join(REPO, 'platform', 'windows', f), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            if (f.includes('digilent') || f === 'windows-platform.ts') continue;
            assert.doesNotMatch(text, /openfpgaloader|OPENFPGALOADER/i, f);
        }
    });
});
