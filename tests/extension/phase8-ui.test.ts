import './install-vscode-fake';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import * as vm from 'node:vm';
import type { Diagnostic } from '../../core';
import { ProblemsPublisher } from '../../extension/diagnostics/vscode-diagnostics';
import { createProject } from '../../extension/project/scaffold';
import { renderRtlHtml } from '../../extension/rtl/rtl-html';
import { RTL_STATE_KEY, RtlPanel } from '../../extension/rtl/rtl-panel';
import {
    APPEARANCE_STATE_KEY,
    AppearanceStore,
    commonScript,
    exportFileName,
    PALETTES,
    pngSize,
    standaloneSvg,
    svgSize,
} from '../../extension/schematic/schematic-chrome';
import { SchematicPanel } from '../../extension/schematic/schematic-panel';
import { ConsoleSink, NexysConsole } from '../../extension/services/console';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import { ProjectState } from '../../extension/services/project-state';
import { DesignView } from '../../extension/views/design-view';
import type { Node } from '../../extension/views/base';
import { ProjectView } from '../../extension/views/project-view';
import { renderWaveHtml } from '../../extension/waveform/waveform-html';
import { WaveformPanel } from '../../extension/waveform/waveform-panel';
import { REPO, repoBoards, tempDir } from '../helpers';
import { FakeBackend } from './fake-backend';
import { collections, commandLog, messages, panels, Uri, ViewColumn } from './vscode-fake';

const DESIGN: Record<string, string> = {
    'src/leaf.vhd': 'library ieee;\nuse ieee.std_logic_1164.all;\nentity leaf is port (a : in std_logic; y : out std_logic); end entity leaf;\narchitecture r of leaf is begin y <= a; end architecture r;\n',
    'src/Top.vhd':
        'library ieee;\nuse ieee.std_logic_1164.all;\nentity Top is port (clk : in std_logic; q : out std_logic); end entity Top;\narchitecture r of Top is\n    signal s : std_logic;\nbegin\n    u1 : entity work.leaf port map (a => clk, y => s);\n    u2 : entity work.leaf port map (a => s, y => q);\nend architecture r;\n',
};

async function project(t: TestContext, template: 'empty' | 'starter' = 'empty') {
    const parent = await tempDir(t);
    const r = await createProject({ parentDir: parent, name: 'Demo', board: (await repoBoards()).get('nexys-a7-100t')!, template });
    assert.ok(r.ok);
    for (const [rel, text] of Object.entries(DESIGN)) {
        await mkdir(join(r.root, ...rel.split('/').slice(0, -1)), { recursive: true });
        await writeFile(join(r.root, ...rel.split('/')), text);
    }
    const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
    t.after(() => service.dispose());
    await service.open(r.root);
    await service.setTop('Top');
    return { root: r.root, service };
}

/** Every inline script of a page must at least parse: a typo inside a template string is otherwise invisible to the tests. */
function assertScriptsParse(html: string, what: string): void {
    const scripts = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    assert.ok(scripts.length >= 1, `${what} has scripts`);
    scripts.forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code), `${what}: script ${i} must parse`));
}

describe('page scripts parse (all three viewers, with and without test hooks)', () => {
    it('Design Schematic, RTL Schematic and Waveform pages', async (t) => {
        const { service } = await project(t);
        for (const testHooks of [false, true]) {
            const panel = new SchematicPanel(service);
            panel.testHooks = testHooks;
            panel.show();
            assertScriptsParse(panels[panels.length - 1]!.webview.html, `design (hooks ${testHooks})`);
            panel.dispose();
            assertScriptsParse(renderRtlHtml({ nonce: 'n', state: { kind: 'message', message: 'x' }, testHooks }), `rtl (hooks ${testHooks})`);
            assertScriptsParse(renderWaveHtml({ nonce: 'n', cspSource: '', rendererUri: 'r.js', testHooks }), `waveform (hooks ${testHooks})`);
        }
        assert.doesNotThrow(() => new vm.Script(commonScript(true)));
    });
});

describe('panels open in the active editor group; nothing splits the editor', () => {
    it('Design Schematic, RTL Schematic and Waveform ask for ViewColumn.Active (never Beside or a fixed column)', async (t) => {
        const { service } = await project(t);
        const before = panels.length;
        const design = new SchematicPanel(service);
        design.show();
        const wave = new WaveformPanel(service, Uri.file('/ext') as never);
        wave.show();
        const rtl = new RtlPanel(service);
        await rtl.show().catch(() => undefined); // RTL generation needs the real tools; the panel itself is created first
        const created = panels.slice(before);
        assert.equal(created.length, 3);
        for (const p of created) assert.equal(p.viewColumn, ViewColumn.Active, p.viewType);
        // A second request reveals the same tab (in its own column) instead of opening another.
        design.show();
        wave.show();
        await rtl.show().catch(() => undefined);
        assert.equal(panels.length, before + 3, 'existing panels are reused, not duplicated');
        for (const p of created) assert.ok(p.revealed.length >= 1 && p.revealed.every((r) => r.column === undefined), 'revealed where they already are');
        design.dispose();
        wave.dispose();
        rtl.dispose();
    });

    it('no source file under extension/ creates a panel in Beside or a fixed column', () => {
        for (const f of ['schematic/schematic-panel.ts', 'rtl/rtl-panel.ts', 'waveform/waveform-panel.ts']) {
            const text = readFileSync(join(REPO, 'extension', f), 'utf8');
            assert.doesNotMatch(text, /ViewColumn\.(Beside|Two|One)/, f);
            assert.match(text, /ViewColumn\.Active/, f);
        }
    });
});

describe('Dark / Light appearance of the schematics', () => {
    it('one choice shared by both schematics, kept with the project, applied live', async (t) => {
        const { root, service } = await project(t);
        const state = new ProjectState({ debounceMs: 60_000 });
        t.after(() => state.dispose());
        await state.attach(root);
        const store = new AppearanceStore(state);
        const design = new SchematicPanel(service, undefined, state, store);
        const rtl = new RtlPanel(service, undefined, state, store);
        t.after(() => {
            design.dispose();
            rtl.dispose();
        });
        design.show();
        await rtl.show().catch(() => undefined);
        const [dp, rp] = panels.slice(-2) as [(typeof panels)[number], (typeof panels)[number]];
        assert.equal(store.get(), 'dark', 'dark by default');
        assert.match(dp.webview.html, /"appearance":"dark"/);
        // The student flips it in the Design Schematic ...
        dp.receive({ type: 'appearance', value: 'light' });
        assert.equal(store.get(), 'light');
        // ... and BOTH open pages are told, without a reload.
        for (const p of [dp, rp]) assert.deepEqual(p.webview.sent.filter((m) => (m as { action?: string }).action === 'appearance').pop(), { type: 'command', action: 'appearance', value: 'light' });
        // From the RTL Schematic too.
        rp.receive({ type: 'appearance', value: 'dark' });
        assert.equal(store.get(), 'dark');
        rp.receive({ type: 'appearance', value: 'light' });
        await state.flush();
        // A new session reads it back.
        const state2 = new ProjectState({ debounceMs: 60_000 });
        t.after(() => state2.dispose());
        await state2.attach(root);
        assert.equal(new AppearanceStore(state2).get(), 'light');
        assert.equal(state2.get(APPEARANCE_STATE_KEY), 'light');
        // The page's own HTML starts in the stored mode.
        design.dispose();
        const again = new SchematicPanel(service, undefined, state2);
        again.show();
        assert.match(panels[panels.length - 1]!.webview.html, /"appearance":"light"/);
        again.dispose();
    });

    it('a tab shown again after being hidden gets its page rebuilt with the current choice (a hidden page is gone, and stale HTML would show the old mode)', async (t) => {
        const { root, service } = await project(t);
        const state = new ProjectState({ debounceMs: 60_000 });
        t.after(() => state.dispose());
        await state.attach(root);
        const store = new AppearanceStore(state);
        const design = new SchematicPanel(service, undefined, state, store);
        t.after(() => design.dispose());
        design.show();
        const p = panels[panels.length - 1]!;
        assert.match(p.webview.html, /"appearance":"dark"/);
        p.setVisible(false);
        store.set('light'); // changed while the tab is hidden: the live command cannot reach a page that does not exist
        assert.match(p.webview.html, /"appearance":"dark"/, 'nothing is rebuilt while hidden');
        p.receive({ type: 'view', mode: 'width', scale: 0.8, x: 5, y: 6, notesOpen: false });
        p.setVisible(true);
        assert.match(p.webview.html, /"appearance":"light"/, 'rebuilt on show with the current choice');
        assert.match(p.webview.html, /"mode":"width","scale":0\.8/, 'and the current zoom');
    });

    it('both palettes define every token and keep text legible against the background', () => {
        const luminance = (hex: string) => {
            const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
            return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
        };
        const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
        assert.deepEqual(Object.keys(PALETTES.dark).sort(), Object.keys(PALETTES.light).sort());
        for (const a of ['dark', 'light'] as const) {
            const p = PALETTES[a];
            for (const token of ['fg', 'muted', 'blue', 'green', 'red', 'orange', 'purple', 'warn', 'link']) assert.ok(contrast(p[token]!, p['bg']!) >= 4.5, `${a}.${token} on the background`);
            assert.ok(contrast(p['fg']!, p['fill']!) >= 7, `${a} label on a block`);
            assert.ok(contrast(p['stroke']!, p['fill']!) >= 3, `${a} block outline on a block`);
        }
        assert.notEqual(PALETTES.dark['bg'], PALETTES.light['bg']);
    });

    it('neither page uses the VS Code theme for the drawing (so Dark/Light is independent of it) and the global theme is never written', () => {
        const chrome = readFileSync(join(REPO, 'extension', 'schematic', 'schematic-chrome.ts'), 'utf8');
        const diagram = chrome.slice(chrome.indexOf('export function diagramCss'), chrome.indexOf('/** CSS of the page'));
        assert.doesNotMatch(diagram, /--vscode-/, 'the drawing uses only schematic tokens');
        assert.doesNotMatch(chrome, /colorTheme|workbench\.colorCustomizations/);
    });
});

describe('export: SVG and PNG of the complete schematic', () => {
    it('standalone SVG: vector, complete, self-contained, in the chosen palette', async (t) => {
        const { service } = await project(t);
        const panel = new SchematicPanel(service);
        t.after(() => panel.dispose());
        panel.show();
        const html = panels[panels.length - 1]!.webview.html;
        const svg = /<svg[\s\S]*<\/svg>/.exec(html)![0]!;
        const dark = standaloneSvg(svg, 'design', 'dark');
        const light = standaloneSvg(svg, 'design', 'light');
        for (const out of [dark, light]) {
            assert.match(out, /^<\?xml/);
            assert.match(out, /<svg[^>]*viewBox="0 0 \d+ \d+"/, 'the viewBox is the full content bounds');
            assert.doesNotMatch(out, /var\(--/, 'no page variables: it looks right in any viewer');
            assert.doesNotMatch(out, /<image|<canvas|data:image/, 'true vector output');
            assert.ok(out.includes('class="block'), 'every block is in it');
            assert.ok((out.match(/class="wire/g) ?? []).length >= 2, 'the wires are in it');
        }
        assert.ok(dark.includes(PALETTES.dark['bg']!) && !dark.includes(PALETTES.light['bg']!));
        assert.ok(light.includes(PALETTES.light['bg']!) && !light.includes(PALETTES.dark['bg']!));
        assert.deepEqual(svgSize(dark), svgSize(svg), 'the export is the whole drawing whatever the zoom');
        assert.ok(svgSize(svg)!.width > 500);
        // The RTL kind carries its own rules.
        const rtl = standaloneSvg('<svg xmlns="http://www.w3.org/2000/svg" class="rtl" viewBox="0 0 400 300" width="400" height="300"><g class="node"><rect class="shape"/></g></svg>', 'rtl', 'light');
        assert.match(rtl, /\.rtl \.shape \{ fill: #eef3f9/);
    });

    it('PNG size keeps labels readable, never exceeds 8192 px, and file names follow the entity', () => {
        assert.deepEqual(pngSize(1280, 272), { width: 3840, height: 816, factor: 3 });
        const huge = pngSize(20000, 4000);
        assert.ok(Math.max(huge.width, huge.height) <= 8192 && huge.factor < 1, 'a huge drawing is scaled down to the canvas limit, never beyond it');
        assert.equal(exportFileName('DigitDisplay', 'design', 'svg'), 'digitdisplay-design.svg');
        assert.equal(exportFileName('DigitDisplay', 'rtl', 'png'), 'digitdisplay-rtl.png');
        assert.equal(exportFileName('a b:c', 'design', 'png'), 'a_b_c-design.png');
    });

    it('Export SVG… writes exactly the chosen file through the extension (no download from the page), in the current mode', async (t) => {
        const { root, service } = await project(t);
        const panel = new SchematicPanel(service);
        t.after(() => panel.dispose());
        panel.show();
        const target = join(root, '..', 'out.svg');
        let suggested = '';
        panel.exporter.chooseTarget = (u) => {
            suggested = u.fsPath;
            return Promise.resolve(Uri.file(target) as never);
        };
        panel.appearance.set('light');
        panels[panels.length - 1]!.receive({ type: 'export', format: 'svg' });
        await new Promise((r) => setTimeout(r, 50));
        assert.match(suggested, /top-design\.svg$/);
        const text = await readFile(target, 'utf8');
        assert.match(text, /^<\?xml/);
        assert.ok(text.includes(PALETTES.light['bg']!));
        assert.equal(panel.exporter.lastExport?.format, 'svg');
        assert.equal(panel.exporter.lastExport?.appearance, 'light');
        assert.ok(messages.some((m) => /Schematic exported/.test(m.text)));
    });

    it('Export PNG… asks the page to rasterize the complete SVG at a high resolution and writes what comes back', async (t) => {
        const { root, service } = await project(t);
        const panel = new SchematicPanel(service);
        t.after(() => panel.dispose());
        panel.show();
        const p = panels[panels.length - 1]!;
        const target = join(root, '..', 'out.png');
        panel.exporter.chooseTarget = () => Promise.resolve(Uri.file(target) as never);
        p.receive({ type: 'export', format: 'png' });
        await new Promise((r) => setTimeout(r, 50));
        const job = p.webview.sent.find((m) => (m as { type?: string }).type === 'rasterize') as { id: string; svg: string; width: number; height: number };
        assert.ok(job, 'a rasterize job was sent');
        const size = svgSize(job.svg)!;
        assert.equal(job.width, Math.round(size.width * 3));
        assert.equal(job.height, Math.round(size.height * 3));
        assert.match(job.svg, /^<\?xml/);
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
        p.receive({ type: 'png', id: job.id, width: job.width, height: job.height, data: png.toString('base64') });
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(await readFile(target), png);
        assert.equal(panel.exporter.lastExport?.width, job.width);
        // A rendering failure is explained, never a silent empty file.
        const before = messages.length;
        p.receive({ type: 'export', format: 'png' });
        await new Promise((r) => setTimeout(r, 50));
        const job2 = p.webview.sent.filter((m) => (m as { type?: string }).type === 'rasterize').pop() as { id: string };
        p.receive({ type: 'png', id: job2.id, error: 'boom' });
        await new Promise((r) => setTimeout(r, 20));
        assert.ok(messages.slice(before).some((m) => m.kind === 'warning' && /PNG could not be created/.test(m.text)));
    });

    it('exporting never touches project files', async (t) => {
        const { root, service } = await project(t);
        const before = await readFile(join(root, 'nexysvhdl.json'), 'utf8');
        const panel = new SchematicPanel(service);
        t.after(() => panel.dispose());
        panel.show();
        panel.exporter.chooseTarget = () => Promise.resolve(undefined); // the student cancels the dialog
        panels[panels.length - 1]!.receive({ type: 'export', format: 'svg' });
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(await readFile(join(root, 'nexysvhdl.json'), 'utf8'), before);
        assert.equal(panel.exporter.lastExport, undefined);
    });

    it('the page can hand a PNG back: CSP allows data images only, and no other source', () => {
        const html = renderRtlHtml({ nonce: 'n', state: { kind: 'message', message: 'x' } });
        assert.match(html, /img-src data:;/);
        assert.doesNotMatch(html, /img-src[^;]*(https?:|\*)/);
    });
});

describe('RTL Schematic view state', () => {
    it('opens in Fit All by default and remembers its zoom with the project', async (t) => {
        const { root, service } = await project(t);
        const state = new ProjectState({ debounceMs: 60_000 });
        t.after(() => state.dispose());
        await state.attach(root);
        const rtl = new RtlPanel(service, undefined, state);
        t.after(() => rtl.dispose());
        await rtl.show().catch(() => undefined);
        const p = panels[panels.length - 1]!;
        assert.match(p.webview.html, /const INIT = \{"mode":"all","scale":1,"x":0,"y":0,"notesOpen":false,"appearance":"dark"\}/);
        p.receive({ type: 'view', mode: '100', scale: 1, x: 10, y: 20, notesOpen: false });
        await state.flush();
        assert.equal((state.get(RTL_STATE_KEY) as { view: { mode: string } }).view.mode, '100');
    });
});

describe('Clear NexysVHDL Problems', () => {
    const diag = (file: string): Diagnostic => ({ severity: 'error', source: 'vhdl', code: 'GHDL_ERROR', message: 'boom', location: { file, line: 1, column: 1 } });

    it('clears only the diagnostics NexysVHDL owns; others, the Console and the Log are untouched; new results report again', async (t) => {
        const { root, service } = await project(t);
        const publisher = new ProblemsPublisher(service);
        t.after(() => publisher.dispose());
        const mine = collections.find((c) => c.name === 'nexysvhdl')!;
        const other = collections[collections.push(new (collections[0]!.constructor as new (n: string) => (typeof collections)[number])('some-other-extension')) - 1]!;
        other.set(Uri.file(join(root, 'src', 'Top.vhd')) as never, [{ message: 'from another extension' } as never]);
        service.problems.set('vhdl', [diag(join(root, 'src', 'Top.vhd'))]);
        publisher.publish();
        assert.equal(mine.entries.size, 1);
        const sink: string[] = [];
        const co = new NexysConsole({ appendLine: (l) => sink.push(l), reveal: () => undefined } satisfies ConsoleSink);
        co.say('Check', 'earlier output');
        let events = 0;
        service.onDidChange((k) => k === 'problems' && events++);
        commandLog.length = 0;

        service.clearProblems();

        assert.equal(mine.entries.size, 0, 'NexysVHDL problems are gone');
        assert.equal(other.entries.size, 1, 'another extension keeps its diagnostics');
        assert.equal(events, 1);
        assert.deepEqual(sink, ['[Check] earlier output'], 'the Console is not cleared');
        // The next result populates Problems again, normally.
        service.problems.set('vhdl', [diag(join(root, 'src', 'Top.vhd'))]);
        publisher.publish();
        assert.equal(mine.entries.size, 1);
    });

    it('is a command-palette and Workflow/Results "..." menu command, not a toolbar button; the Problems panel itself offers no menu contribution point', () => {
        const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }>; menus: Record<string, Array<{ command: string; group?: string; when?: string }>> } };
        assert.ok(pkg.contributes.commands.some((c) => c.command === 'nexysvhdl.clearProblems' && c.title === 'Clear NexysVHDL Problems'));
        const entries = Object.entries(pkg.contributes.menus).flatMap(([menu, items]) => items.filter((i) => i.command === 'nexysvhdl.clearProblems').map((i) => ({ menu, ...i })));
        assert.ok(entries.some((e) => e.menu === 'commandPalette'));
        for (const e of entries.filter((x) => x.menu === 'view/title')) assert.ok(!e.group?.startsWith('navigation'), 'in the overflow menu, never an inline toolbar button');
        assert.ok(!Object.keys(pkg.contributes.menus).some((m) => /problems|markers/i.test(m)), 'VS Code has no such contribution point');
    });
});

describe('Design view: Add File shows a single plus; rows carry their own actions', () => {
    it('Files and Hierarchy both start with "Add File" (the codicon is the plus) running the same command', async (t) => {
        const { service } = await project(t);
        const design = new DesignView(service);
        t.after(() => design.dispose());
        for (const mode of ['files', 'hierarchy'] as const) {
            design.setMode(mode);
            const first = design.getChildren()[0]!;
            assert.equal(first.label, 'Add File');
            assert.equal(first.command?.command, 'nexysvhdl.addFile');
            assert.equal((first.iconPath as { id: string }).id, 'add');
            assert.doesNotMatch(String(first.label), /\+/);
        }
    });

    it('Project rows that own a setting carry a context value, and every menu entry targets a context value that exists', async (t) => {
        const { service } = await project(t, 'starter');
        const view = new ProjectView(service);
        t.after(() => view.dispose());
        const values = new Map(view.getChildren().map((n: Node) => [String(n.label), n.contextValue]));
        assert.equal(values.get('Top'), 'nexysvhdl.project.top');
        assert.equal(values.get('Environment'), 'nexysvhdl.project.environment');
        const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { contributes: { menus: Record<string, Array<{ when?: string; group?: string; command: string }>> } };
        const src = ['project-view.ts', 'files-view.ts', 'hierarchy-view.ts', 'hardware-view.ts', 'workflow-view.ts', 'design-view.ts'].map((f) => readFileSync(join(REPO, 'extension', 'views', f), 'utf8')).join('\n');
        for (const m of pkg.contributes.menus['view/item/context']!) {
            for (const v of [...(m.when ?? '').matchAll(/viewItem == (nexysvhdl\.project\.\w+)/g)].map((x) => x[1]!)) assert.ok(src.includes(`'${v}'`), `${v} is set by the Project view`);
        }
        const inline = pkg.contributes.menus['view/item/context']!.filter((m) => m.group === 'inline' && /project\.(top|testbench|stopTime|name|environment|fileMissing)/.test(m.when ?? ''));
        assert.ok(inline.length >= 6, 'inline actions on the Project rows');
    });
});

describe('Waveform: Start Over and the time marker', () => {
    const page = (hooks = false) => renderWaveHtml({ nonce: 'n', cspSource: '', rendererUri: 'r.js', testHooks: hooks });

    it('the toolbar is Run, Stop, Start Over, Run for; Start Over starts disabled and reuses the Run path', () => {
        const html = page();
        assert.match(html, /id="run"[\s\S]*id="stop"[\s\S]*id="restart"[\s\S]*Run for:/);
        assert.match(html, /id="restart"[^>]*disabled>&#8635; Start Over/);
        assert.match(html, /restartBtn\.disabled = sim\.running \|\| !!sim\.other \|\| !valid \|\| !sim\.hasRun/);
        assert.match(html, /restartBtn\.onclick = \(\) => \{ if \(!restartBtn\.disabled\) doRun\(\); \}/, 'the same doRun: from time 0, current duration, no resume');
    });

    it('the panel tells the page whether a simulation has run, and reuses the one run command', async (t) => {
        const { service } = await project(t);
        const wave = new WaveformPanel(service, Uri.file('/ext') as never);
        t.after(() => wave.dispose());
        wave.show();
        const p = panels[panels.length - 1]!;
        p.receive({ type: 'ready' });
        const last = () => p.webview.sent.filter((m) => (m as { type?: string }).type === 'simState').pop() as { hasRun: boolean; running: boolean };
        assert.equal(last().hasRun, false);
        commandLog.length = 0;
        p.receive({ type: 'run', duration: '5us' });
        assert.deepEqual(commandLog[0], { command: 'nexysvhdl.runSimulation', args: [{ duration: '5us' }] });
    });

    it('a persistent marker spans every row with a time flag, moves with clicks and arrow keys, and survives a rerun', () => {
        const html = page();
        assert.match(html, /The time marker: a halo and a bright line through every row, a flag with the selected time at the top/);
        assert.match(html, /ctx\.moveTo\(cx, 0\); ctx\.lineTo\(cx, h\)/, 'from the top to the bottom of all rows');
        assert.match(html, /ctx\.lineWidth = 2\.5/);
        assert.match(html, /const tag = fmtT\(cursor\)/, 'the selected time is printed on the marker');
        assert.match(html, /setCursor\(timeAt\(e\.clientX\)\)/, 'clicking moves it');
        assert.match(html, /e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'\) && data/, 'arrow keys move it');
        assert.match(html, /cursor = keptCursor <= data\.endTime \? keptCursor : 0/, 'kept across a rerun when the time still exists');
        assert.match(html, /\/\^\(INPUT\|SELECT\|TEXTAREA\)\$\//, 'typing a duration does not move the marker');
    });
});

describe('sidebar: Classroom theme separates the sections; sections show a status', () => {
    it('section headers are visibly different from the sidebar and carry a border line', () => {
        const theme = JSON.parse(readFileSync(join(REPO, 'resources', 'themes', 'nexysvhdl-classroom-color-theme.json'), 'utf8')) as { colors: Record<string, string> };
        const c = theme.colors;
        assert.notEqual(c['sideBarSectionHeader.background'], c['sideBar.background']);
        assert.notEqual(c['sideBarSectionHeader.border'], c['sideBar.border']);
        assert.equal(c['sideBarSectionHeader.foreground'], '#ffffff');
    });

    it('Project, Hardware and Results rows carry their section colour (state icons keep theirs)', async (t) => {
        const { service } = await project(t, 'starter');
        const view = new ProjectView(service);
        t.after(() => view.dispose());
        const colours = view.getChildren().map((n: Node) => (n.iconPath as { color?: { id: string } }).color?.id).filter(Boolean);
        assert.ok(colours.length >= 4 && colours.every((c) => c === 'charts.blue'));
    });

    it('each section has its own icon, and the extension never injects CSS or edits the global theme', () => {
        const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { contributes: { views: Record<string, Array<{ id: string; icon?: string }>> } };
        const icons = pkg.contributes.views['nexysvhdl']!.map((v) => v.icon);
        assert.equal(new Set(icons).size, icons.length);
        assert.ok(icons.every(Boolean));
        const ext = readFileSync(join(REPO, 'extension', 'extension.ts'), 'utf8');
        assert.doesNotMatch(ext, /injectCss|workbench\.desktop\.main|\.css'/);
    });
});
