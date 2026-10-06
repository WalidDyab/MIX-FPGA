import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createProject } from '../../extension/project/scaffold';
import {
    ADD_FILE_KINDS,
    checkCopySource,
    copyIntoProject,
    entityNameOf,
    findExisting,
    isSameFile,
    normalizeFileName,
    sourceSkeleton,
    suggestFreeName,
    targetPath,
    testbenchSkeleton,
    validateCopyName,
    validateFileName,
    writeNewFile,
} from '../../extension/project/add-file';
import { parseVhdl } from '../../extension/hierarchy/vhdl-parser';
import { starterTestbenchVhdl, starterXdc } from '../../extension/project/templates';
import { NexysError, NexysVhdlService } from '../../extension/services/nexys-service';
import { repoBoards, tempDir } from '../helpers';
import { FakeBackend, OK, successfulBuild } from './fake-backend';

async function newProject(t: TestContext, name = 'Demo') {
    const parent = await tempDir(t);
    const r = await createProject({ parentDir: parent, name, board: (await repoBoards()).get('nexys-a7-100t')! });
    assert.ok(r.ok);
    return r.root;
}

async function openService(t: TestContext, root: string, backend = new FakeBackend()) {
    const service = new NexysVhdlService({ backend, debounceMs: 5 });
    t.after(() => service.dispose());
    await service.open(root);
    return { service, backend };
}

async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), 'condition not reached');
}

const readConfig = async (root: string) => JSON.parse(await readFile(join(root, 'nexysvhdl.json'), 'utf8')) as Record<string, any>;

describe('service: one pipeline operation per project at a time', () => {
    it('four simultaneous Builds start one backend build; the rest get "Build is already running."', async (t) => {
        const root = await newProject(t);
        const { service, backend } = await openService(t, root);
        backend.buildResult = successfulBuild(join(root, 'hardware.bit'));
        let release!: () => void;
        backend.gate = new Promise((r) => (release = r));
        const settled = [1, 2, 3, 4].map(() => service.build().then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e })));
        await until(() => backend.calls.length >= 1);
        await new Promise((r) => setTimeout(r, 30));
        assert.deepEqual(backend.calls, ['build'], 'exactly one build reached the backend');
        assert.equal(service.busyAction, 'build');
        release();
        const results = await Promise.all(settled);
        assert.equal(results.filter((x) => x.ok).length, 1);
        const refused = results.filter((x): x is { ok: false; e: unknown } => !x.ok);
        assert.equal(refused.length, 3);
        for (const x of refused) {
            assert.ok(x.e instanceof NexysError);
            assert.equal((x.e as Error).message, 'Build is already running.');
        }
        assert.equal(service.busyAction, undefined, 'released');
    });

    it('Check, Simulate, Build, Program and the RTL schematic exclude each other', async (t) => {
        const root = await newProject(t);
        const { service, backend } = await openService(t, root);
        backend.buildResult = successfulBuild(join(root, 'hardware.bit'));
        backend.checkResult = { ...OK, elaborated: ['top'] };
        await service.check(); // RTL needs a passed Check
        let release!: () => void;
        backend.gate = new Promise((r) => (release = r));
        const build = service.build();
        await until(() => service.busy === 'build');
        await assert.rejects(service.simulate(), /Build is still running/);
        await assert.rejects(service.check(), /Build is still running/);
        await assert.rejects(service.generateRtl(), /Build is still running/);
        await assert.rejects(service.program({ allowStale: true }), /Build is still running/);
        assert.throws(() => service.ensureFree('check'), /Build is still running/);
        assert.throws(() => service.ensureFree('build'), /Build is already running\./);
        release();
        await build;
        assert.deepEqual(backend.calls.filter((c) => c !== 'check:top'), ['build'], 'nothing else reached the backend');
    });

    it('releases after a failed result, a thrown backend error, and a cancellation', async (t) => {
        const root = await newProject(t);
        const { service, backend } = await openService(t, root);
        backend.buildResult = { ...successfulBuild(join(root, 'hardware.bit')), success: false };
        await service.build();
        assert.equal(service.busyAction, undefined, 'after a failed build');

        const original = backend.build.bind(backend);
        backend.build = async () => {
            throw new Error('EBUSY: resource busy or locked');
        };
        await assert.rejects(service.build(), /EBUSY/);
        assert.equal(service.busyAction, undefined, 'after a thrown error');
        backend.build = original;

        backend.buildResult = successfulBuild(join(root, 'hardware.bit'));
        let release!: () => void;
        backend.gate = new Promise((r) => (release = r));
        const running = service.build();
        await until(() => service.busy === 'build');
        service.cancel();
        release();
        await running;
        assert.equal(service.busyAction, undefined, 'after a cancellation');

        backend.gate = undefined as never;
        assert.equal((await service.build()).success, true, 'the project is usable again');
    });

    it('announces claim changes so views can disable or mark the other actions', async (t) => {
        const root = await newProject(t);
        const { service, backend } = await openService(t, root);
        backend.buildResult = successfulBuild(join(root, 'hardware.bit'));
        const kinds: string[] = [];
        service.onDidChange((k) => k === 'busy' && kinds.push(`${service.busyAction ?? 'free'}`));
        await service.build();
        assert.deepEqual(kinds, ['build', 'free']);
    });
});

describe('service: simulation stop time', () => {
    it('writes simulation.stopTime into nexysvhdl.json, keeps the rest, and clears it again', async (t) => {
        const root = await newProject(t);
        const { service } = await openService(t, root);
        const before = (await readConfig(root)).simulation;
        assert.equal(before.stopTime, undefined, 'a new project does not impose a stop time');
        assert.equal(await service.setStopTime(' 2 US '), '2us');
        let sim = (await readConfig(root)).simulation;
        assert.equal(sim.stopTime, '2us');
        assert.equal(sim.testbench, before.testbench);
        assert.deepEqual(sim.sources, before.sources);
        await service.setStopTime(undefined);
        sim = (await readConfig(root)).simulation;
        assert.equal('stopTime' in sim, false);
    });

    it('refuses units GHDL does not know, with a message that lists the valid ones', async (t) => {
        const root = await newProject(t);
        const { service } = await openService(t, root);
        await assert.rejects(service.setStopTime('3 weeks'), /fs, ps, ns, us, ms, sec/);
        assert.equal((await readConfig(root)).simulation.stopTime, undefined);
    });

    it('existing project files with no stopTime still open and validate without migration', async (t) => {
        const root = await newProject(t);
        const config = await readConfig(root);
        delete config.simulation.stopTime;
        await writeFile(join(root, 'nexysvhdl.json'), JSON.stringify(config, null, 2));
        const { service } = await openService(t, root);
        assert.deepEqual(service.snapshot!.validation, []);
        assert.deepEqual(await readConfig(root), config, 'opening does not rewrite the file');
    });
});

describe('Add File: names, folders and formats', () => {
    it('goes to src/, sim/ and constraints/ and accepts only .vhd, .vhd and .xdc', () => {
        assert.deepEqual(ADD_FILE_KINDS.map((k) => [k.label, k.folder, k.extension]), [
            ['Source', 'src', '.vhd'],
            ['Simulation Testbench', 'sim', '.vhd'],
            ['Constraint', 'constraints', '.xdc'],
        ]);
        assert.equal(targetPath('source', 'alu'), 'src/alu.vhd');
        assert.equal(targetPath('simulation', 'alu_tb.VHD'), 'sim/alu_tb.vhd');
        assert.equal(targetPath('constraints', 'pins'), 'constraints/pins.xdc');
    });

    it('does not silently accept .vhdl, .txt, Verilog, SystemVerilog or unrelated formats', () => {
        for (const kind of ['source', 'simulation'] as const) {
            for (const name of ['alu.vhdl', 'alu.txt', 'alu.v', 'alu.sv', 'alu.xdc', 'alu.vhd.txt', 'alu.json']) {
                assert.ok(validateFileName(kind, name), `${kind}: ${name} must be refused`);
                assert.ok(validateCopyName(kind, name), `${kind} copy: ${name} must be refused`);
                assert.ok(checkCopySource(kind, `C:/x/${name}`), `${kind} copy source: ${name}`);
            }
        }
        for (const name of ['pins.txt', 'pins.sdc', 'pins.vhd', 'pins.XDC.bak']) {
            assert.ok(validateFileName('constraints', name), name);
            assert.ok(checkCopySource('constraints', `/tmp/${name}`), name);
        }
        assert.match(checkCopySource('source', '/tmp/alu.vhdl')!, /rename it to \.vhd/);
        assert.equal(checkCopySource('source', '/tmp/ALU.VHD'), undefined);
        assert.equal(checkCopySource('constraints', '/tmp/a.Xdc'), undefined);
    });

    it('new VHDL files are named like entities; reserved words, spaces and non-ASCII are refused', () => {
        for (const ok of ['alu', 'DigitDisplay', 'seven_seg_decoder', 'a1', 'Counter8.vhd']) assert.equal(validateFileName('source', ok), undefined, ok);
        for (const bad of ['', '1alu', '_alu', 'alu_', 'a__b', 'my alu', 'alú', '王小明', 'entity', 'Process', 'a-b', '.vhd']) assert.ok(validateFileName('source', bad), `"${bad}" must be refused`);
        assert.equal(validateFileName('constraints', 'my-pins_v2'), undefined);
        assert.ok(validateFileName('constraints', 'pins 1'));
        assert.equal(normalizeFileName('source', 'Alu.VHD'), 'Alu.vhd');
        assert.equal(entityNameOf('Alu.vhd'), 'Alu');
    });

    it('detects a name collision without regard to case, and suggests a free name', async (t) => {
        const root = await newProject(t);
        await writeNewFile(root, 'src/DigitDisplay.vhd', '-- x\n');
        assert.equal(await findExisting(root, 'source', 'digitdisplay'), 'src/DigitDisplay.vhd');
        assert.equal(await findExisting(root, 'source', 'other'), undefined);
        assert.equal(await findExisting(root, 'simulation', 'digitdisplay'), undefined, 'a different folder is a different file');
        assert.equal(await suggestFreeName(root, 'source', 'DigitDisplay'), 'DigitDisplay_2.vhd');
        await writeNewFile(root, 'src/DigitDisplay_2.vhd', '-- y\n');
        assert.equal(await suggestFreeName(root, 'source', 'DigitDisplay'), 'DigitDisplay_3.vhd');
        await assert.rejects(writeNewFile(root, 'src/DigitDisplay.vhd', 'new'), /EEXIST/, 'never overwrites without Replace');
        await writeNewFile(root, 'src/DigitDisplay.vhd', 'replaced\n', true);
        assert.equal(await readFile(join(root, 'src', 'DigitDisplay.vhd'), 'utf8'), 'replaced\n');
    });

    it('copies physically into the project and never overwrites without Replace', async (t) => {
        const root = await newProject(t);
        const elsewhere = await tempDir(t, 'outside ');
        const from = join(elsewhere, 'Seg Decoder.vhd');
        await writeFile(from, 'entity x is end;\r\n');
        await copyIntoProject(root, 'src/seg_decoder.vhd', from);
        assert.equal(await readFile(join(root, 'src', 'seg_decoder.vhd'), 'utf8'), 'entity x is end;\r\n', 'byte for byte');
        await writeFile(from, 'entity y is end;\n');
        await assert.rejects(copyIntoProject(root, 'src/seg_decoder.vhd', from), /EEXIST/);
        await copyIntoProject(root, 'src/seg_decoder.vhd', from, true);
        assert.equal(await readFile(join(root, 'src', 'seg_decoder.vhd'), 'utf8'), 'entity y is end;\n');
        await assert.rejects(copyIntoProject(root, 'src/dir.vhd', elsewhere), /not a file/);
    });

    it('recognizes a chosen file that already is the project copy (no self-copy)', async (t) => {
        const root = await newProject(t);
        assert.equal(isSameFile(join(root, 'src', 'top.vhd'), root, 'src/top.vhd'), true);
        assert.equal(isSameFile(join(root, 'src', 'TOP.vhd'), root, 'src/top.vhd'), true, 'Windows and macOS are case-insensitive');
        assert.equal(isSameFile(join(root, 'sim', 'top.vhd'), root, 'src/top.vhd'), false);
    });
});

describe('Add File: templates', () => {
    it('a new source is a VHDL-2008 skeleton with ieee.std_logic_1164 and ieee.numeric_std, entity named like the file', () => {
        const text = sourceSkeleton('Alu');
        assert.match(text, /library ieee;/);
        assert.match(text, /use ieee\.std_logic_1164\.all;/);
        assert.match(text, /use ieee\.numeric_std\.all;/);
        const parsed = parseVhdl(text);
        assert.deepEqual(parsed.entities.map((e) => e.name), ['Alu']);
        assert.deepEqual(parsed.architectures.map((a) => a.entity.toLowerCase()), ['alu']);
        assert.deepEqual(parsed.entities[0]!.ports.map((p) => p.name), ['clk', 'rst']);
        assert.doesNotMatch(text, /--std|standard/i, 'no standards-selection: VHDL-2008 is the default');
    });

    it('a new testbench has no ports, a clock, and ends itself with std.env.stop (like the starter)', () => {
        const text = testbenchSkeleton('alu_tb');
        const parsed = parseVhdl(text);
        assert.deepEqual(parsed.entities.map((e) => [e.name, e.ports.length]), [['alu_tb', 0]]);
        assert.match(text, /^\s*std\.env\.stop;/m);
        assert.match(text, /use ieee\.numeric_std\.all;/);
        assert.match(starterTestbenchVhdl(), /std\.env\.stop;/, 'the starter project already terminates cleanly');
    });

    it('a blank XDC lists every board resource commented out, so nothing is tied to the starter design', async () => {
        const board = (await repoBoards()).get('nexys-a7-100t')!;
        const blank = starterXdc('Demo', board, { starterPorts: false });
        assert.doesNotMatch(blank, /^set_property/m, 'no active pin lines');
        assert.doesNotMatch(blank, /^create_clock/m);
        assert.match(blank, /^#set_property -dict \{ PACKAGE_PIN [A-Z0-9]+ IOSTANDARD LVCMOS33 \} \[get_ports \{ sw0 \}\]/m);
        assert.match(starterXdc('Demo', board), /^set_property -dict \{ PACKAGE_PIN [A-Z0-9]+ IOSTANDARD LVCMOS33 \} \[get_ports \{ clk \}\]/m, 'the starter file is unchanged');
    });
});

describe('Add File: the project model follows (nexysvhdl.json, hierarchy, active XDC)', () => {
    it('a created source and testbench are listed in dependency order and no external path is ever written', async (t) => {
        const root = await newProject(t);
        const { service } = await openService(t, root);
        await writeNewFile(root, 'src/Alu.vhd', sourceSkeleton('Alu'));
        assert.deepEqual(await service.fileAdded('source', 'src/Alu.vhd'), {});
        await writeNewFile(root, 'sim/alu_tb.vhd', testbenchSkeleton('alu_tb'));
        await service.fileAdded('simulation', 'sim/alu_tb.vhd');
        const config = await readConfig(root);
        assert.ok(config.sources.includes('src/Alu.vhd') && config.sources.includes('src/top.vhd'), JSON.stringify(config.sources));
        assert.ok(config.simulation.sources.includes('sim/alu_tb.vhd'));
        assert.equal(config.simulation.testbench, 'top_tb', 'an existing testbench selection is not changed');
        assert.doesNotMatch(JSON.stringify(config), /[A-Za-z]:\\|\.\.\/|^\//, 'only project-relative paths');
        assert.equal(service.snapshot!.index.entity('Alu')?.role, 'source');
        assert.equal(service.snapshot!.files.sources.some((f) => f.path === 'src/Alu.vhd'), true);
    });

    it('the first testbench of a project without one becomes the selected testbench', async (t) => {
        const root = await newProject(t);
        const config = await readConfig(root);
        await rm(join(root, 'sim'), { recursive: true });
        delete config.simulation;
        await writeFile(join(root, 'nexysvhdl.json'), JSON.stringify(config, null, 2));
        const { service } = await openService(t, root);
        await mkdir(join(root, 'sim'), { recursive: true });
        await writeNewFile(root, 'sim/first_tb.vhd', testbenchSkeleton('first_tb'));
        assert.deepEqual(await service.fileAdded('simulation', 'sim/first_tb.vhd'), { testbench: 'first_tb' });
        assert.equal((await readConfig(root)).simulation.testbench, 'first_tb');
    });

    it('with an active XDC, adding another does not switch silently: it asks, and nothing changes until told', async (t) => {
        const root = await newProject(t);
        const { service } = await openService(t, root);
        const active = (await readConfig(root)).constraints as string;
        await writeNewFile(root, 'constraints/second.xdc', '## second\n');
        assert.deepEqual(await service.fileAdded('constraints', 'constraints/second.xdc'), { constraints: 'ask' });
        assert.equal((await readConfig(root)).constraints, active, 'the active constraints file is unchanged');
        await service.useConstraints('constraints/second.xdc');
        assert.equal((await readConfig(root)).constraints, 'constraints/second.xdc');
        assert.equal(service.snapshot!.files.constraints.find((f) => f.path === 'constraints/second.xdc')?.inUse, true);
    });

    it('replacing the active XDC keeps it active; the first XDC of a project without one becomes active', async (t) => {
        const root = await newProject(t);
        const { service } = await openService(t, root);
        const active = (await readConfig(root)).constraints as string;
        assert.deepEqual(await service.fileAdded('constraints', active), { constraints: 'already-active' });

        const config = await readConfig(root);
        delete config.constraints;
        await writeFile(join(root, 'nexysvhdl.json'), JSON.stringify(config, null, 2));
        await rm(join(root, active));
        await service.refreshNow();
        await writeNewFile(root, 'constraints/mine.xdc', '## mine\n');
        assert.deepEqual(await service.fileAdded('constraints', 'constraints/mine.xdc'), { constraints: 'activated' });
        assert.equal((await readConfig(root)).constraints, 'constraints/mine.xdc');
    });

    it('a project that generates its XDC from "pins" asks too (switching removes the pins only on confirmation)', async (t) => {
        const root = await newProject(t);
        const config = await readConfig(root);
        delete config.constraints;
        config.pins = { clk: 'CLK100MHZ' };
        await writeFile(join(root, 'nexysvhdl.json'), JSON.stringify(config, null, 2));
        const { service } = await openService(t, root);
        await writeNewFile(root, 'constraints/mine.xdc', '## mine\n');
        assert.deepEqual(await service.fileAdded('constraints', 'constraints/mine.xdc'), { constraints: 'ask' });
        await assert.rejects(service.useConstraints('constraints/mine.xdc'), /pins/);
        await service.useConstraints('constraints/mine.xdc', true);
        const after = await readConfig(root);
        assert.equal(after.constraints, 'constraints/mine.xdc');
        assert.equal(after.pins, undefined);
    });
});
