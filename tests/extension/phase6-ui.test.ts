import './install-vscode-fake';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { AppearanceManager, CLASSROOM_THEME, KEEP_MINE, type Remembered, type ThemeSettings, USE_CLASSROOM } from '../../extension/appearance/appearance-manager';
import { createProject } from '../../extension/project/scaffold';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import { buildRtlModel, parseYosysJson } from '../../extension/rtl/rtl-model';
import { parseVcd, extendVectorRaw } from '../../extension/waveform/vcd-parser';
import { effectiveRadix, formatValue, isRadix, RADIX_CHOICES, type Radix, sanitizeRadixState, traceSegments } from '../../extension/waveform/wave-render';
import { renderWaveHtml, toWaveData } from '../../extension/waveform/waveform-html';
import type { Node } from '../../extension/views/base';
import { DesignView } from '../../extension/views/design-view';
import { ProjectView } from '../../extension/views/project-view';
import { WorkflowView } from '../../extension/views/workflow-view';
import { REPO, repoBoards, tempDir, writeFiles } from '../helpers';
import { FakeBackend, successfulBuild } from './fake-backend';
import { DESIGN_FILES } from './fixtures';

async function setup(t: TestContext) {
    const parent = await tempDir(t);
    const r = await createProject({ parentDir: parent, name: 'Views', board: (await repoBoards()).get('nexys-a7-100t')! });
    assert.ok(r.ok);
    const backend = new FakeBackend();
    const service = new NexysVhdlService({ backend, debounceMs: 5 });
    t.after(() => service.dispose());
    await service.open(r.root);
    return { root: r.root, service, backend };
}

function render(nodes: Node[], view: { getChildren(n?: Node): Node[] }, depth = 0): string[] {
    return nodes.flatMap((n) => [`${'  '.repeat(depth)}${String(n.label)}${n.description ? ` | ${n.description}` : ''}`, ...render(view.getChildren(n), view, depth + 1)]);
}
const tree = (view: { getChildren(n?: Node): Node[] }) => render(view.getChildren(), view);

class Memory implements Remembered {
    readonly data = new Map<string, unknown>();
    get<T>(key: string): T | undefined {
        return this.data.get(key) as T | undefined;
    }
    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) this.data.delete(key);
        else this.data.set(key, value);
    }
}

describe('RTL schematic model with a mixed-case top (DigitDisplay)', () => {
    it('selects the top module however its name is spelled, instead of falling back to the first module', () => {
        const mod = (cells: Record<string, unknown> = {}) => ({ ports: { clk: { direction: 'input', bits: [2] } }, cells });
        // GHDL lists sub-entities first and names the top exactly as in the VHDL source; no `top` attribute is relied on.
        const netlist = JSON.stringify({ modules: { seven_seg_decoder_Brtl: mod(), clock_divider_Brtl_17: mod(), DigitDisplay: mod() } });
        for (const configured of ['DigitDisplay', 'digitdisplay', 'DIGITDISPLAY']) {
            assert.equal(buildRtlModel(parseYosysJson(netlist), { top: configured, entities: ['DigitDisplay', 'seven_seg_decoder', 'clock_divider'] }).top, 'DigitDisplay', configured);
        }
        assert.equal(buildRtlModel(parseYosysJson(netlist), { top: 'other' }).top, 'seven_seg_decoder_Brtl', 'unchanged: an unknown top falls back as before');
    });
});

describe('Design view: Project Files and Design Hierarchy as one view with two modes', () => {
    it('opens in Files mode with a prominent "+ Add File" followed by the three file groups', async (t) => {
        const { service } = await setup(t);
        const view = new DesignView(service);
        t.after(() => view.dispose());
        assert.equal(view.mode, 'files');
        const roots = view.getChildren();
        assert.equal(roots[0]!.label, '+ Add File');
        assert.equal(roots[0]!.command?.command, 'nexysvhdl.addFile');
        assert.deepEqual(tree(view).slice(1), ['Sources', '  top.vhd | TOP', 'Simulation', '  top_tb.vhd | TESTBENCH', 'Constraints', '  nexys-a7-100t.xdc | IN USE']);
    });

    it('Hierarchy mode keeps everything the old Design Hierarchy view offered', async (t) => {
        const { root, service } = await setup(t);
        await writeFiles(root, DESIGN_FILES);
        await service.refreshNow();
        const view = new DesignView(service);
        t.after(() => view.dispose());
        view.setMode('hierarchy');
        const lines = tree(view);
        assert.equal(lines[0], '+ Add File | source · testbench · constraint');
        assert.deepEqual(lines.slice(1, 7), ['Top | TOP', '  u_clock : clock_divider', '  U_Counter : counter', '  u_display : display_driver', '    u_mux : display_mux', '    u_decoder : seven_seg_decoder']);
        assert.ok(lines.includes('Not used by top | 1'));
        assert.ok(lines.includes('Testbenches'));
        assert.ok(lines.includes('Design Schematic | structure: instances and port maps'));
        assert.ok(lines.some((l) => l.startsWith('RTL Schematic')));
        const top = view.getChildren()[1]!;
        assert.equal(top.contextValue, 'nexysvhdl.topEntity', 'context-menu commands (schematic here, go to entity) still apply');
        assert.equal(top.command?.command, 'nexysvhdl.openLocation');
    });

    it('Files mode keeps set-top / use-this-XDC / set-testbench context values', async (t) => {
        const { service } = await setup(t);
        const view = new DesignView(service);
        t.after(() => view.dispose());
        const contexts = render(view.getChildren(), view).length;
        assert.ok(contexts > 0);
        const groups = view.getChildren().slice(1);
        const values = groups.flatMap((g) => view.getChildren(g).map((c) => c.contextValue));
        assert.deepEqual(values, ['nexysvhdl.source', 'nexysvhdl.simulation', 'nexysvhdl.constraints']);
    });

    it('remembers the last mode in the workspace and fires a mode event', async (t) => {
        const { service } = await setup(t);
        const memory = new Map<string, unknown>();
        const state = { get: <T>(k: string) => memory.get(k) as T | undefined, update: async (k: string, v: unknown) => void memory.set(k, v), keys: () => [...memory.keys()] };
        const first = new DesignView(service, state);
        const modes: string[] = [];
        first.onDidChangeMode((m) => modes.push(m));
        first.setMode('hierarchy');
        first.setMode('hierarchy');
        assert.deepEqual(modes, ['hierarchy'], 'no event when nothing changes');
        first.dispose();
        const second = new DesignView(service, state);
        t.after(() => second.dispose());
        assert.equal(second.mode, 'hierarchy');
    });

    it('is one permanent section: Project Files and Design Hierarchy are gone, Project/Workflow/Hardware/Results remain', async () => {
        const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { contributes: { views: Record<string, Array<{ id: string; name: string }>> } };
        const views = pkg.contributes.views['nexysvhdl']!;
        assert.deepEqual(views.map((v) => [v.id, v.name]), [
            ['nexysvhdl.project', 'Project'],
            ['nexysvhdl.design', 'Design'],
            ['nexysvhdl.workflow', 'Workflow'],
            ['nexysvhdl.hardware', 'Hardware'],
            ['nexysvhdl.results', 'Results'],
        ]);
    });
});

describe('package contributions for the new features', () => {
    it('Design toolbar, command palette, appearance and stop-time commands are contributed consistently', async () => {
        const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as {
            contributes: {
                commands: Array<{ command: string; title: string }>;
                menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
                themes: Array<{ label: string; uiTheme: string; path: string }>;
                configuration: { properties: Record<string, { default: unknown }> };
            };
        };
        const c = pkg.contributes;
        const titles = Object.fromEntries(c.commands.map((x) => [x.command, x.title]));
        assert.equal(titles['nexysvhdl.addFile'], 'Add File…');
        assert.equal(titles['nexysvhdl.useClassroomAppearance'], 'Use NexysVHDL Classroom Appearance');
        assert.equal(titles['nexysvhdl.useMyAppearance'], 'Use My VS Code Appearance');
        assert.equal(titles['nexysvhdl.setSimulationStopTime'], 'Set Simulation Stop Time…');
        const design = c.menus['view/title']!.filter((m) => m.when?.includes('view == nexysvhdl.design'));
        assert.ok(design.some((m) => m.command === 'nexysvhdl.addFile'), '+ Add File in the Design title bar');
        assert.ok(design.some((m) => m.command === 'nexysvhdl.design.showHierarchy') && design.some((m) => m.command === 'nexysvhdl.design.showFiles'));
        assert.ok(!c.menus['view/title']!.some((m) => /nexysvhdl\.(files|hierarchy)\b/.test(m.when ?? '')), 'no menu refers to the removed views');
        // While an operation runs, its command-palette siblings are hidden.
        for (const id of ['check', 'simulate', 'build', 'program']) {
            assert.match(c.menus['commandPalette']!.find((m) => m.command === `nexysvhdl.${id}`)!.when!, /!nexysvhdl\.busy/);
        }
        assert.deepEqual(c.themes, [{ label: CLASSROOM_THEME, uiTheme: 'vs-dark', path: './resources/themes/nexysvhdl-classroom-color-theme.json' }]);
        assert.equal(c.configuration.properties['nexysvhdl.promptForClassroomAppearance']!.default, true);
    });

    it('the version is unchanged by Phase 6 work (the public number is decided after pilot validation)', async () => {
        const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { version: string };
        assert.equal(pkg.version, '0.5.0');
    });
});

describe('Workflow view while an operation runs', () => {
    it('marks the other actions unavailable and drops their inline buttons; back to normal afterwards', async (t) => {
        const { root, service, backend } = await setup(t);
        backend.buildResult = successfulBuild(join(root, 'hardware.bit'));
        const view = new WorkflowView(service);
        t.after(() => view.dispose());
        const byId = () => Object.fromEntries(view.getChildren().map((n) => [String(n.label), n]));
        assert.equal(byId()['Check']!.contextValue, 'nexysvhdl.action.check');
        let release!: () => void;
        backend.gate = new Promise((r) => (release = r));
        const build = service.build();
        for (let i = 0; i < 100 && service.busyAction !== 'build'; i++) await new Promise((r) => setTimeout(r, 5));
        const busy = byId();
        for (const label of ['Check', 'Simulate', 'Build', 'Program']) assert.equal(busy[label]!.contextValue, 'nexysvhdl.action.busy', label);
        assert.match(String(busy['Simulate']!.description), /Build is running/);
        release();
        await build;
        assert.equal(byId()['Simulate']!.contextValue, 'nexysvhdl.action.simulate');
    });
});

describe('Project view: simulation length', () => {
    it('shows "until the testbench stops" by default and the fixed time once set', async (t) => {
        const { service } = await setup(t);
        const view = new ProjectView(service);
        t.after(() => view.dispose());
        const row = () => view.getChildren().find((n) => n.label === 'Simulation length')!;
        assert.equal(row().description, 'until the testbench stops');
        assert.equal(row().command?.command, 'nexysvhdl.setSimulationStopTime');
        await service.setStopTime('1us');
        assert.equal(row().description, 'stops at 1us');
    });
});

describe('NexysVHDL Classroom appearance', () => {
    function fixture(initialWorkspaceTheme?: string, userTheme = 'Solarized Light') {
        const writes: Array<{ scope: 'workspace'; value: string | undefined }> = [];
        let workspaceTheme = initialWorkspaceTheme;
        const settings: ThemeSettings = {
            workspaceTheme: () => workspaceTheme,
            async setWorkspaceTheme(v) {
                workspaceTheme = v;
                writes.push({ scope: 'workspace', value: v });
            },
        };
        const workspaceState = new Memory();
        const globalState = new Memory();
        return { manager: new AppearanceManager(settings, workspaceState, globalState), writes, workspaceTheme: () => workspaceTheme, userTheme, workspaceState, globalState };
    }

    it('asks once on first use; the port can only write workspace scope, so the user theme is never overwritten', async () => {
        const f = fixture();
        assert.equal(f.manager.shouldAsk(), true);
        assert.equal(f.manager.shouldAsk(false), false, 'the setting can turn the question off');
        assert.equal(await f.manager.answer(USE_CLASSROOM), 'classroom');
        assert.deepEqual(f.writes, [{ scope: 'workspace', value: CLASSROOM_THEME }]);
        assert.equal(f.manager.active, true);
        assert.equal(f.manager.shouldAsk(), false, 'never asked twice');
        assert.equal(f.userTheme, 'Solarized Light', 'the user-level theme is not even reachable from the manager');
    });

    it('"Keep My VS Code Appearance" changes nothing and is not asked again, in any workspace', async () => {
        const f = fixture();
        assert.equal(await f.manager.answer(KEEP_MINE), 'keep');
        assert.deepEqual(f.writes, []);
        assert.equal(f.manager.shouldAsk(), false);
        const other = new AppearanceManager({ workspaceTheme: () => undefined, setWorkspaceTheme: async () => undefined }, new Memory(), f.globalState);
        assert.equal(other.shouldAsk(), false, 'the refusal is remembered for the user, not just the folder');
    });

    it('dismissing the question is not an answer: it will be asked again next time', async () => {
        const f = fixture();
        assert.equal(await f.manager.answer(undefined), undefined);
        assert.equal(f.manager.shouldAsk(), true);
        assert.deepEqual(f.writes, []);
    });

    it('switching back removes the workspace override, restoring the user\'s normal theme', async () => {
        const f = fixture();
        await f.manager.useClassroom();
        await f.manager.useMine();
        assert.equal(f.workspaceTheme(), undefined);
        assert.deepEqual(f.writes.map((w) => w.value), [CLASSROOM_THEME, undefined]);
        await f.manager.useClassroom(); // and on again by command
        assert.equal(f.workspaceTheme(), CLASSROOM_THEME);
    });

    it('a folder that already chose its own workspace theme gets it back', async () => {
        const f = fixture('Quiet Light');
        assert.equal(f.manager.shouldAsk(), true);
        await f.manager.useClassroom();
        assert.equal(f.workspaceTheme(), CLASSROOM_THEME);
        await f.manager.useMine();
        assert.equal(f.workspaceTheme(), 'Quiet Light');
    });

    it('"use my appearance" when the classroom theme was never applied writes nothing', async () => {
        const f = fixture('Quiet Light');
        await f.manager.useMine();
        assert.deepEqual(f.writes, []);
        assert.equal(f.workspaceTheme(), 'Quiet Light');
    });

    it('the theme file is valid, covers every VHDL scope of the grammar, and keeps readable contrast', async () => {
        const theme = JSON.parse(await readFile(join(REPO, 'resources', 'themes', 'nexysvhdl-classroom-color-theme.json'), 'utf8')) as {
            type: string;
            colors: Record<string, string>;
            tokenColors: Array<{ scope: string | string[]; settings: { foreground?: string } }>;
        };
        assert.equal(theme.type, 'dark');
        const luminance = (hex: string) => {
            const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const contrast = (a: string, b: string) => {
            const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
            return (hi + 0.05) / (lo + 0.05);
        };
        const bg = theme.colors['editor.background']!;
        assert.ok(contrast(theme.colors['editor.foreground']!, bg) >= 7, 'body text');
        assert.ok(contrast(theme.colors['sideBar.foreground']!, theme.colors['sideBar.background']!) >= 7);
        assert.ok(contrast(theme.colors['statusBar.foreground']!, theme.colors['statusBar.background']!) >= 7);
        assert.ok(contrast(theme.colors['button.foreground']!, theme.colors['button.background']!) >= 7);
        assert.ok(contrast(theme.colors['tab.activeForeground']!, theme.colors['tab.activeBackground']!) >= 7);
        const grammar = await readFile(join(REPO, 'resources', 'vhdl', 'vhdl.tmLanguage.json'), 'utf8');
        const scopes = [...new Set([...grammar.matchAll(/"name": "([^"]+\.vhdl)"/g)].map((m) => m[1]!))];
        assert.ok(scopes.length > 30);
        for (const scope of scopes) {
            const rules = theme.tokenColors.filter((r) => [r.scope].flat().some((s) => scope === s || scope.startsWith(`${s}.`)));
            assert.ok(rules.length > 0, `${scope} has a rule`);
            const color = rules[rules.length - 1]!.settings.foreground;
            assert.ok(color && contrast(color, bg) >= 4.5, `${scope} is readable (${color})`);
        }
    });
});

describe('waveform: Display As', () => {
    const fmt = (value: string, radix: Radix, raw?: string) => formatValue(value, value.length, radix, raw ? { raw } : {});

    it('offers Binary, Hex, Unsigned Decimal and Signed Decimal', () => {
        assert.deepEqual(RADIX_CHOICES.map((c) => [c.radix, c.label]), [['bin', 'Binary'], ['hex', 'Hex'], ['udec', 'Unsigned Decimal'], ['sdec', 'Signed Decimal']]);
    });

    it('decimal distinguishes unsigned from signed (a std_logic_vector is never assumed signed)', () => {
        assert.equal(fmt('1111', 'udec'), '15');
        assert.equal(fmt('1111', 'sdec'), '-1');
        assert.equal(fmt('1000', 'sdec'), '-8');
        assert.equal(fmt('0111', 'sdec'), '7');
        assert.equal(fmt('0111', 'udec'), '7');
        assert.equal(fmt('00000000', 'udec'), '0');
        assert.equal(fmt('10000000', 'udec'), '128');
        assert.equal(fmt('10000000', 'sdec'), '-128');
        assert.equal(fmt('0101', 'bin'), '0101');
        assert.equal(fmt('0101', 'hex'), '5');
    });

    it('is exact beyond 32 and 53 bits (BigInt, no overflow)', () => {
        assert.equal(fmt('1'.repeat(32), 'udec'), '4294967295');
        assert.equal(fmt('1' + '0'.repeat(31), 'sdec'), '-2147483648');
        assert.equal(fmt('1'.repeat(64), 'udec'), '18446744073709551615');
        assert.equal(fmt('1'.repeat(64), 'sdec'), '-1');
        assert.equal(fmt('1' + '0'.repeat(63), 'sdec'), '-9223372036854775808');
        assert.equal(fmt('0' + '1'.repeat(63), 'sdec'), '9223372036854775807');
        assert.equal(fmt('0'.repeat(52) + '1'.repeat(12), 'udec'), '4095');
        assert.equal(fmt('1' + '0'.repeat(127), 'udec'), '170141183460469231731687303715884105728');
        assert.equal(fmt('1' + '0'.repeat(127), 'sdec'), '-170141183460469231731687303715884105728');
        assert.equal(fmt('1' + '0'.repeat(54), 'udec'), (2n ** 54n).toString(), 'above Number.MAX_SAFE_INTEGER');
        assert.equal(fmt('1' + '0'.repeat(52) + '1', 'udec'), (2n ** 53n + 1n).toString(), '2^53 + 1 is not representable as a double');
    });

    it('never fabricates a number from metavalues: U X Z W L H - stay visible', () => {
        assert.equal(fmt('xxxx', 'udec'), 'X');
        assert.equal(fmt('zzzz', 'sdec'), 'Z');
        assert.equal(fmt('01x1', 'udec'), 'X');
        assert.equal(fmt('0z01', 'sdec'), 'X');
        assert.equal(fmt('xxxx', 'udec', 'uuuu'), 'U', 'uninitialized is not the same as unknown');
        assert.equal(fmt('xxxx', 'sdec', 'wwww'), 'W');
        assert.equal(fmt('xxxx', 'udec', '----'), '-');
        assert.equal(fmt('0000', 'udec', 'llll'), 'L', 'weak 0 is not shown as the number 0');
        assert.equal(fmt('1111', 'sdec', 'hhhh'), 'H');
        assert.equal(fmt('0101', 'udec', '01l1'), 'X', 'one weak bit spoils the number');
        assert.equal(fmt('0000', 'bin', 'uuuu'), 'UUUU');
        assert.equal(fmt('xxxx0001', 'hex'), 'X1');
        assert.equal(fmt('xxxx0001', 'hex', 'uuuu0001'), 'U1');
        assert.equal(fmt('zzzz', 'hex'), 'Z');
        assert.equal(fmt('0x1z', 'hex'), 'X');
        assert.equal(formatValue('x', 1, 'udec'), 'x', 'scalars stay as they are');
        assert.equal(formatValue('x', 1, 'udec', { raw: 'u' }), 'U');
        assert.equal(formatValue(undefined, 8, 'sdec'), '—');
        assert.equal(formatValue('3.25', 64, 'sdec'), '3.25', 'reals pass through');
    });

    it('integer-typed signals are numeric by default; others follow the Buses setting; a choice wins', () => {
        const state = sanitizeRadixState({ buses: 'bin', signals: { 'tb.dut.count[7:0]': 'udec', 'tb.x': 'bogus' } });
        assert.deepEqual(state, { buses: 'bin', signals: { 'tb.dut.count[7:0]': 'udec' } });
        assert.equal(effectiveRadix(state, 'tb.dut.count[7:0]', 'reg'), 'udec');
        assert.equal(effectiveRadix(state, 'tb.dut.data[7:0]', 'reg'), 'bin');
        assert.equal(effectiveRadix(state, 'tb.dut.n', 'integer'), 'sdec');
        assert.equal(effectiveRadix({ buses: 'hex', signals: { 'tb.dut.n': 'hex' } }, 'tb.dut.n', 'integer'), 'hex');
        assert.deepEqual(sanitizeRadixState(undefined), { buses: 'hex', signals: {} });
        assert.deepEqual(sanitizeRadixState('junk'), { buses: 'hex', signals: {} });
        assert.deepEqual(sanitizeRadixState({ signals: [1, 2] }), { buses: 'hex', signals: {} });
        assert.ok(isRadix('sdec') && !isRadix('oct'));
    });

    it('an integer signal from the VCD shows as a number with no user action', () => {
        const model = parseVcd('$timescale 1 fs $end\n$scope module tb $end\n$var integer 32 ! n $end\n$var reg 8 " v [7:0] $end\n$upscope $end\n$enddefinitions $end\n#0\nb11111111111111111111111111111011 !\nb11111011 "\n');
        const data = toWaveData(model);
        const n = data.signals.find((s) => s.name === 'n')!;
        const v = data.signals.find((s) => s.name.startsWith('v'))!;
        assert.equal(n.varType, 'integer');
        const state = sanitizeRadixState(undefined);
        assert.equal(formatValue(data.traces[n.code]!.values[0], n.width, effectiveRadix(state, n.path, n.varType)), '-5');
        assert.equal(formatValue(data.traces[v.code]!.values[0], v.width, effectiveRadix(state, v.path, v.varType)), 'FB');
    });

    it('real GHDL output: integers, wide vectors and metavalues display correctly in every radix', async () => {
        const model = parseVcd(await readFile(join(REPO, 'tests', 'fixtures', 'ghdl', 'numeric-types.vcd'), 'utf8'));
        const data = toWaveData(model);
        const state = sanitizeRadixState({ signals: { 't.u[63:0]': 'udec', 't.s[7:0]': 'sdec' } });
        const at = (name: string, index: number, radix?: Radix) => {
            const s = data.signals.find((x) => x.path === `t.${name}`)!;
            const tr = data.traces[s.code]!;
            return formatValue(tr.values[index], s.width, radix ?? effectiveRadix(state, s.path, s.varType), tr.raw ? { raw: tr.raw[index] } : {});
        };
        assert.equal(at('i', 0), '-5', 'integer: numeric with no choice made');
        assert.equal(at('i', 1), '2147483647', 'a positive 31-bit dump is not read as negative');
        assert.equal(at('n', 0), '7');
        assert.equal(at('s[7:0]', 0), '-3', 'signed(7 downto 0) read as Signed Decimal on request');
        assert.equal(at('s[7:0]', 0, 'udec'), '253', 'the same bits as Unsigned Decimal');
        assert.equal(at('s[7:0]', 0, 'hex'), 'FD');
        assert.equal(at('u[63:0]', 0), '18446744073709551615', '64 bits do not overflow');
        assert.equal(at('u[63:0]', 0, 'sdec'), '-1');
        assert.equal(at('v[3:0]', 0, 'udec'), 'U', 'UUUU is shown as U, not 0 or 15');
        assert.equal(at('v[3:0]', 0, 'bin'), 'UUUU');
        assert.equal(at('v[3:0]', 1, 'udec'), 'X', '01LH has weak bits: no number');
        assert.equal(at('v[3:0]', 1, 'bin'), '01LH');
        assert.equal(at('v[3:0]', 2, 'udec'), '5');
        assert.equal(at('b', 0), 'U');
        assert.equal(at('b', 1), 'W');
        assert.equal(at('b', 2), '1');
        const real = data.signals.find((x) => x.name === 'r')!;
        assert.equal(formatValue(data.traces[real.code]!.values[0], real.width, 'sdec'), '1.5', 'a real is shown as itself');
    });

    it('the VCD parser keeps VHDL metavalues apart from the drawing form', () => {
        const model = parseVcd(
            '$timescale 1 ns $end\n$scope module tb $end\n$var reg 1 ! s $end\n$var reg 4 " v [3:0] $end\n$upscope $end\n$enddefinitions $end\n#0\nu!\nbuuuu "\n#1\nl!\nb01lh "\n#2\n0!\nb0101 "\n',
        );
        const s = model.signals.find((x) => x.name === 's')!;
        const v = model.signals.find((x) => x.name === 'v')!;
        assert.deepEqual(model.traces.get(s.code)!.values, ['x', '0', '0'], 'drawing form: U is x, L is 0');
        assert.deepEqual(model.raw.get(s.code), ['u', 'l', '0']);
        assert.deepEqual(model.traces.get(v.code)!.values, ['xxxx', '0101', '0101']);
        assert.deepEqual(model.raw.get(v.code), ['uuuu', '01lh', '0101']);
        assert.equal(extendVectorRaw('u1', 4), '00u1');
        const data = toWaveData(model);
        assert.deepEqual(data.traces[s.code]!.raw, ['u', 'l', '0']);
        // An ordinary dump pays nothing for this.
        const plain = toWaveData(parseVcd('$timescale 1 ns $end\n$scope module tb $end\n$var reg 1 ! s $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n#1\n1!\nx!\n'));
        assert.equal(plain.traces['!']!.raw, undefined);
    });

    it('draws segments with their metavalue so a label can show U instead of a number', () => {
        const segs = traceSegments([0, 10], ['xxxx', '0101'], 0, 20, 200, 2, ['uuuu', '0101']);
        assert.deepEqual(segs.map((s) => [s.value, s.raw]), [['xxxx', 'uuuu'], ['0101', '0101']]);
        assert.deepEqual(traceSegments([0, 10], ['0', '1'], 0, 20, 200).map((s) => 'raw' in s), [false, false], 'unchanged without raws');
    });

    it('the viewer page offers a per-signal Display As control and remembers it through the extension', () => {
        const html = renderWaveHtml({ nonce: 'n', cspSource: 'vscode-resource:', rendererUri: 'r.js' });
        for (const label of ['Binary', 'Hex', 'Unsigned Decimal', 'Signed Decimal']) assert.ok(html.includes(label), label);
        assert.match(html, /class="rx"[^>]*title="Display As"/);
        assert.match(html, /type: 'radix', state: rstate/, 'choices are posted to the extension');
        assert.match(html, /m\.radix\) \{ rstate = W\.sanitizeRadixState/, 'and restored from it on load');
        assert.match(html, /action === 'signalRadix'/);
        assert.doesNotMatch(html, /parseInt\(value|Number\(value/, 'no 32-bit parsing in the page');
    });
});
