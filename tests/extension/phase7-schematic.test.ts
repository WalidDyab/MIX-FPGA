import './install-vscode-fake';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createProject } from '../../extension/project/scaffold';
import { buildSchematic } from '../../extension/schematic/schematic-model';
import { SchematicPanel } from '../../extension/schematic/schematic-panel';
import { layoutSchematic } from '../../extension/schematic/schematic-svg';
import { clampScale, computeScale, FIT_CEILING, MAX_SCALE, MIN_READABLE_FIT, MIN_SCALE, sanitizeViewState } from '../../extension/schematic/schematic-view';
import { NexysVhdlService } from '../../extension/services/nexys-service';
import { REPO, repoBoards, tempDir } from '../helpers';
import { FakeBackend } from './fake-backend';
import { commandLog, panels, ViewColumn } from './vscode-fake';

/** The multi-file mixed-case DigitDisplay project used in the pilot: a top with a clock divider, display mux and decoder. */
const FILES: Record<string, string> = {
    'src/clock_divider.vhd': `library ieee;
use ieee.std_logic_1164.all;
entity clock_divider is
    generic (BITS : natural := 17);
    port (clk : in std_logic; tick : out std_logic);
end entity clock_divider;
architecture rtl of clock_divider is begin tick <= clk; end architecture rtl;
`,
    'src/seven_seg_decoder.vhd': `library ieee;
use ieee.std_logic_1164.all;
entity seven_seg_decoder is
    port (digit : in std_logic_vector(3 downto 0); seg : out std_logic_vector(6 downto 0));
end entity seven_seg_decoder;
architecture rtl of seven_seg_decoder is begin seg <= (others => '0'); end architecture rtl;
`,
    'src/display_mux.vhd': `library ieee;
use ieee.std_logic_1164.all;
entity display_mux is
    port (tick : in std_logic; value : in std_logic_vector(31 downto 0); an : out std_logic_vector(7 downto 0); digit : out std_logic_vector(3 downto 0));
end entity display_mux;
architecture rtl of display_mux is begin an <= (others => '1'); digit <= value(3 downto 0); end architecture rtl;
`,
    'src/DigitDisplay.vhd': `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity DigitDisplay is
    port (clk : in std_logic; an : out std_logic_vector(7 downto 0); seg : out std_logic_vector(6 downto 0));
end entity DigitDisplay;
architecture rtl of DigitDisplay is
    signal tick  : std_logic;
    signal digit : std_logic_vector(3 downto 0);
begin
    u_clock   : entity work.clock_divider generic map (BITS => 17) port map (clk => clk, tick => tick);
    u_mux     : entity work.display_mux port map (tick => tick, value => x"76543210", an => an, digit => digit);
    u_decoder : entity work.seven_seg_decoder port map (digit => digit, seg => seg);
end architecture rtl;
`,
};

async function digitDisplay(t: TestContext) {
    const parent = await tempDir(t);
    const r = await createProject({ parentDir: parent, name: 'DigitDisplay', board: (await repoBoards()).get('nexys-a7-100t')!, template: 'empty' });
    assert.ok(r.ok);
    for (const [rel, text] of Object.entries(FILES)) {
        await mkdir(join(r.root, ...rel.split('/').slice(0, -1)), { recursive: true });
        await writeFile(join(r.root, ...rel.split('/')), text);
    }
    const service = new NexysVhdlService({ backend: new FakeBackend(), debounceMs: 5 });
    t.after(() => service.dispose());
    await service.open(r.root);
    await service.setTop('DigitDisplay');
    return { service, root: r.root };
}

describe('Design Schematic: zoom model', () => {
    const content = { w: 1400, h: 400 };
    const window = { w: 700, h: 500 };

    it('opens in Fit All by default; 100% and Fit Width are explicit choices', () => {
        assert.deepEqual(sanitizeViewState(undefined).view, { mode: 'all', scale: 1 });
        assert.equal(computeScale('100', content, window, 0.3), 1);
        assert.equal(computeScale('width', content, window, 1), 0.5);
        // Everything fits: the scale is the true fit.
        assert.equal(computeScale('all', { w: 1000, h: 300 }, window, 1), 0.7);
        assert.equal(computeScale('custom', content, window, 2.5), 2.5);
    });

    it('Fit All never goes below a readable scale: a huge design opens as a scrollable overview instead', () => {
        assert.equal(computeScale('all', { w: 1400, h: 1400 }, window, 1), MIN_READABLE_FIT);
        assert.equal(computeScale('all', { w: 9000, h: 4000 }, window, 1), MIN_READABLE_FIT);
        assert.ok(MIN_READABLE_FIT * 12 >= 7, 'a 12 px label is still about 7 px at the floor');
        assert.equal(computeScale('width', { w: 9000, h: 400 }, window, 1), Math.max(MIN_SCALE, window.w / 9000), 'Fit Width is literal (down to the zoom limit): the student asked for it');
    });

    it('never magnifies a small schematic past the ceiling, and clamps zoom to sensible limits', () => {
        assert.equal(computeScale('all', { w: 100, h: 50 }, window, 1), FIT_CEILING);
        assert.equal(computeScale('width', { w: 100, h: 50 }, window, 1), FIT_CEILING);
        assert.equal(clampScale(100), MAX_SCALE);
        assert.equal(clampScale(0), MIN_SCALE);
        assert.equal(clampScale(Number.NaN), 1);
        assert.equal(computeScale('all', { w: 0, h: 0 }, window, 1), 1, 'an empty schematic does not divide by zero');
    });

    it('stored view state is sanitized: unknown modes, junk positions and huge maps are dropped', () => {
        const s = sanitizeViewState({ view: { mode: 'bogus', scale: 'x' }, pans: { a: { x: 10.4, y: -5 }, b: { x: 'q' }, c: null }, notesOpen: 'yes' });
        assert.deepEqual(s, { view: { mode: 'all', scale: 1 }, pans: { a: { x: 10, y: 0 } }, notesOpen: false });
        const wide = sanitizeViewState({ view: { mode: 'custom', scale: 9 }, pans: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`n${i}`, { x: 1, y: 1 }])) });
        assert.equal(wide.view.scale, MAX_SCALE);
        assert.equal(Object.keys(wide.pans).length, 200);
    });
});

describe('Design Schematic: DigitDisplay stays readable', () => {
    it('opens as a normal tab in the active editor group in Fit All, not in a narrow side column', async (t) => {
        const { service } = await digitDisplay(t);
        const panel = new SchematicPanel(service);
        t.after(() => panel.dispose());
        panel.show();
        const p = panels[panels.length - 1]!;
        assert.equal(p.viewColumn, ViewColumn.Active);
        assert.notEqual(p.viewColumn, ViewColumn.Beside);
        assert.notEqual(p.viewColumn, ViewColumn.Two);
        assert.match(p.webview.html, /const INIT = \{"mode":"all","scale":1,"x":0,"y":0,"notesOpen":false,"appearance":"dark"\}/, 'the first view is Fit All from the top left');
        panel.show(); // a second request reveals the same tab and takes focus
        assert.equal(panels.filter((x) => x === p).length, 1);
        assert.equal(p.revealed[p.revealed.length - 1]!.preserveFocus, false);
    });

    it('offers 100%, Fit Width, Fit All, zoom in and out, Reset and Maximize, and keeps the drill-down, breadcrumb and source navigation', async (t) => {
        const { service, root } = await digitDisplay(t);
        const panel = new SchematicPanel(service);
        t.after(() => panel.dispose());
        panel.show();
        const p = panels[panels.length - 1]!;
        const html = p.webview.html;
        for (const label of ['>100%<', '>Fit Width<', '>Fit All<', 'id="zin"', 'id="zout"', '>Reset<', '>Maximize<']) assert.ok(html.includes(label), label);
        assert.match(html, /<svg[^>]*class="schematic"/, 'the schematic is still vector SVG');
        assert.match(html, /id="canvas"[^>]*>/);
        assert.match(html, /overflow: auto/, 'a design larger than the window is scrolled, not shrunk');
        assert.match(html, /<details class="notes" id="notes">/, 'the notes pane is collapsible');
        // Instances are present as blocks with drill-down and a source location.
        for (const label of ['u_clock', 'u_mux', 'u_decoder']) assert.ok(html.includes(label), label);
        // Source navigation: opens beside, so the schematic keeps the full editor width.
        commandLog.length = 0;
        p.receive({ type: 'open', file: 'src/DigitDisplay.vhd', line: 13, col: 5 });
        assert.deepEqual(commandLog[0], { command: 'nexysvhdl.openLocation', args: [root, 'src/DigitDisplay.vhd', 13, 5, { beside: true }] });
        p.receive({ type: 'maximize' });
        assert.equal(commandLog[1]!.command, 'workbench.action.toggleMaximizeEditorGroup');
    });

    it('drills down, shows the breadcrumb, and goes back up', async (t) => {
        const { service } = await digitDisplay(t);
        const panel = new SchematicPanel(service);
        t.after(() => panel.dispose());
        panel.show();
        const p = panels[panels.length - 1]!;
        const snap = service.snapshot!;
        const root = snap.hierarchy.root!;
        const child = root.children.find((c) => c.label === 'u_mux')!;
        p.receive({ type: 'drill', id: child.id });
        assert.match(p.title, /Schematic: display_mux/);
        assert.match(p.webview.html, /data-hid="[^"]+">DigitDisplay<\/a> › <span class="here">u_mux/);
        p.receive({ type: 'drill', id: root.id });
        assert.match(p.title, /Schematic: DigitDisplay/);
    });

    it('text and block sizes never fall below readable minimums at 100%', async (t) => {
        const { service } = await digitDisplay(t);
        const snap = service.snapshot!;
        const model = buildSchematic(snap.index, snap.hierarchy.root!)!;
        const layout = layoutSchematic(model);
        for (const b of layout.blocks) {
            assert.ok(b.width >= 180, `${b.block.label} width ${b.width}`);
            assert.ok(b.height >= 50 + 22, `${b.block.label} height ${b.height}`);
        }
        const chrome = readFileSync(join(REPO, 'extension', 'schematic', 'schematic-chrome.ts'), 'utf8');
        const css = chrome.slice(chrome.indexOf("kind === 'design'"), chrome.indexOf('.rtl text'));
        const sizes = [...css.matchAll(/font-size: (\d+)px/g)].map((m) => Number(m[1]));
        assert.ok(sizes.length >= 6 && Math.min(...sizes) >= 12, `diagram text sizes ${sizes}`);
        // Pins keep a comfortable spacing, so port labels never overlap.
        const pitch = new Set<number>();
        for (const b of layout.blocks) {
            const ys = [...b.pins.values()].filter((p) => p.side === 'left').map((p) => p.y).sort((a, c) => a - c);
            for (let i = 1; i < ys.length; i++) pitch.add(ys[i]! - ys[i - 1]!);
        }
        for (const d of pitch) assert.ok(d >= 22, `pin pitch ${d}`);
    });

    it('the layout is wider at 100% than a side column, which is exactly why panning exists', async (t) => {
        const { service } = await digitDisplay(t);
        const snap = service.snapshot!;
        const layout = layoutSchematic(buildSchematic(snap.index, snap.hierarchy.root!)!);
        assert.ok(layout.width > 1000, `DigitDisplay is ${layout.width}px wide at 100%`);
    });
});
