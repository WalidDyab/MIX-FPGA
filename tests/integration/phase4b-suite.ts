/**
 * Phase 4B/4C Setup validation inside a real VS Code (NOT part of `npm test`). Run with run-phase6.ts (NEXYS_P6_SUITE=phase4b), always with
 * MIXFPGA_HOME pointing at an isolated root (or HOME at a private home): it refuses to run against the real MIX-FPGA root
 * (~/Library/MIX-FPGA on macOS, %LOCALAPPDATA%\MIX-FPGA on Windows). The same scenarios run on both; the Windows-only parts are the
 * Altera file dialogs (P4B_ALTERA_DIR holds the two files) and the damaged file of the repair scenario.
 *
 * It drives the REAL extension commands (Show Environment, Install, New Project, Verify) and the real controller, installer, Lima and
 * Quartus. VS Code's native dialogs (quick picks, modal messages, file pickers) are answered by script, because a test cannot click
 * them; every question and every list the student would see is recorded. The Altera licence page is NEVER scripted: it is the real
 * webview, and the run waits for a person to read it and tick the box.
 *
 *   P4B_SCENARIO=nexys-only  first run: choose Nexys A7 only, install, New Project (DE10-Lite offers support first, Nexys is created).
 *   P4B_SCENARIO=de10-only   choose DE10-Lite only (engine, Quartus, licence page), then New Project for it.
 *   P4B_SCENARIO=add-nexys   from Board Support: add the Nexys A7 later; create a Nexys project.
 *   P4B_SCENARIO=upgrade     after updating NexysVHDL 0.6.0: Nexys A7 Installed (reused), DE10-Lite offered; install it; both New Project choices.
 *   P4B_SCENARIO=page        only show the Setup page and record it.
 *   P4B_SCENARIO=modified-nexys | modified-de10   (Phase 5F) change an installed file, then Setup page, New Project, Verify, declined and accepted
 *                            Repair, and a genuinely missing file, all through the real commands.
 *   P4B_NEXYS_ARCHIVE / P4B_DE10_ARCHIVE   the support files the student picks in the file dialogs (release artifacts).
 *   P4B_WORK=<folder for created projects>   P4B_MARKERS=<folder for marker files>
 */
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { NexysVhdlApi } from '../../extension/extension';
import { EXTENSION_ID, log, report, step, waitFor } from './edh-suite';

const scenario = process.env['P4B_SCENARIO'] ?? 'page';
const ALTERA_INSTALLER = process.platform === 'win32' ? 'QuartusLiteSetup-25.1std.0.1129-windows.exe' : 'QuartusLiteSetup-25.1std.0.1129-linux.run';
const ALTERA_PACKAGE = 'max10-25.1std.0.1129.qdz';
const work = process.env['P4B_WORK'] ?? join(homedir(), 'MF', 'projects');
const markers = process.env['P4B_MARKERS'] ?? join(work, '.markers');
/**
 * The installed extension gets its OWN `vscode` API object (VS Code 1.143 gives every extension one), so prompts are answered on that
 * object: a require() issued from a file inside the extension folder returns it. The extension's code is not changed in any way.
 */
let extApi: typeof vscode = vscode;
let w = vscode.window as unknown as Record<string, unknown>;
function bindToExtension(extensionPath: string): void {
    extApi = createRequire(join(extensionPath, 'dist', 'extension', 'extension.js'))('vscode') as typeof vscode;
    w = extApi.window as unknown as Record<string, unknown>;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Prompt {
    readonly kind: string;
    readonly title: string;
    readonly text: string;
    readonly items: readonly string[];
    readonly modal: boolean;
    readonly answered: string;
}
const transcript: Prompt[] = [];
type Answer = (ctx: { items: readonly { label: string; id?: string; description?: string; detail?: string }[]; buttons: readonly string[] }) => unknown;
interface Handler {
    readonly when: RegExp;
    readonly kind: string | undefined;
    readonly answer: Answer;
    used: number;
}
let handlers: Handler[] = [];
const on = (when: RegExp, answer: Answer, kind?: string): void => void handlers.push({ when, answer, used: 0, kind });

function dispatch(kind: string, title: string, text: string, items: readonly { label: string; id?: string; description?: string; detail?: string }[], buttons: readonly string[], modal: boolean): unknown {
    const hay = `${title}\n${text}`;
    const h = handlers.find((x) => (x.kind === undefined || x.kind === kind) && x.when.test(hay));
    let answer: unknown;
    if (h) {
        h.used++;
        answer = h.answer({ items, buttons });
    }
    const shown = typeof answer === 'string' ? answer : Array.isArray(answer) ? answer.map((a) => (a as { label?: string }).label ?? String(a)).join(' + ') : answer && typeof answer === 'object' ? ((answer as { label?: string; fsPath?: string }).label ?? (answer as { fsPath?: string }).fsPath ?? 'object') : h ? String(answer) : '(unanswered)';
    transcript.push({ kind, title, text, items: items.map((i) => `${i.label}${i.description ? `  [${i.description}]` : ''}${i.detail ? `  — ${i.detail}` : ''}`), modal, answered: shown });
    if (!h) step('prompt.UNEXPECTED', { kind, title, text });
    return answer;
}

function installPrompts(): void {
    const message = (kind: string) => async (msg: string, ...rest: unknown[]) => {
        const opts = rest[0] && typeof rest[0] === 'object' ? (rest.shift() as { modal?: boolean; detail?: string }) : undefined;
        return dispatch(kind, msg, opts?.detail ?? '', [], rest.filter((r): r is string => typeof r === 'string'), opts?.modal === true);
    };
    w['showInformationMessage'] = message('info');
    w['showWarningMessage'] = message('warning');
    w['showErrorMessage'] = message('error');
    w['showQuickPick'] = async (items: unknown, options?: { title?: string; placeHolder?: string; canPickMany?: boolean }) => {
        const list = (await items) as readonly { label: string; id?: string; description?: string; detail?: string; kind?: number }[];
        const real = list.filter((i) => i.kind !== vscode.QuickPickItemKind.Separator);
        const seps = list.filter((i) => i.kind === vscode.QuickPickItemKind.Separator).map((i) => `── ${i.label} ──`);
        const out = dispatch('quickpick', options?.title ?? '', options?.placeHolder ?? '', [...seps.map((label) => ({ label })), ...real], [], false);
        // the answer is an item (or items) of this list, matched by label
        const pick = (a: unknown) => real.find((i) => i.label === (a as { label?: string })?.label) ?? a;
        return Array.isArray(out) ? out.map(pick) : out ? pick(out) : undefined;
    };
    w['showOpenDialog'] = async (o?: { title?: string }) => dispatch('opendialog', o?.title ?? '', '', [], [], false);
    w['showInputBox'] = async (o?: { title?: string; prompt?: string }) => dispatch('inputbox', o?.title ?? '', o?.prompt ?? '', [], [], false);
    // Creating a project asks VS Code to switch this window to it; the test keeps this window (the next session opens the project).
    const exec = extApi.commands.executeCommand.bind(extApi.commands);
    (extApi.commands as unknown as Record<string, unknown>)['executeCommand'] = (command: string, ...args: unknown[]) => {
        if (command === 'vscode.openFolder') {
            step('openFolder.requested', String((args[0] as vscode.Uri | undefined)?.fsPath));
            return Promise.resolve(undefined);
        }
        return exec(command, ...args);
    };
}

/** The licence page is real: report when it opens and when it closes, so the person running the test knows to act. */
function watchLicensePanel(): () => void {
    let open = false;
    const timer = setInterval(() => {
        const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === 'Altera licence');
        if (tab && !open) {
            open = true;
            step('licensePanel', 'OPEN: waiting for a person to read the licence, tick the box and choose Accept and install (or Cancel)');
            void mkdir(markers, { recursive: true }).then(() => writeFile(join(markers, 'LICENSE_PANEL_OPEN'), new Date().toISOString()));
        } else if (!tab && open) {
            open = false;
            step('licensePanel', 'CLOSED');
        }
    }, 500);
    return () => clearInterval(timer);
}

const label = (re: RegExp): Answer => ({ items }) => items.find((i) => re.test(i.label));
const page = (): Prompt | undefined => [...transcript].reverse().find((p) => p.kind === 'quickpick' && /MIX-FPGA Setup/.test(p.title));

async function showPage(choice: RegExp | undefined, label2: string): Promise<void> {
    handlers = handlers.filter((h) => !/MIX-FPGA Setup/.test(h.when.source));
    on(/MIX-FPGA Setup/, choice ? label(choice) : () => undefined);
    await vscode.commands.executeCommand('nexysvhdl.showEnvironment');
    const p = page();
    step(`setupPage.${label2}`, p ? { headline: p.text, shown: p.items, chose: p.answered } : 'no setup page (the older Environment list was used)');
}



/** Answers shared by every install: the confirmation, the Altera files from Downloads, and result messages. */
function commonAnswers(): void {
    on(/Install board support/, ({ buttons }) => buttons.find((b) => b === 'Continue'));
    // The support files a course hands out: the student chooses them in the file dialog.
    on(/^Nexys A7 support file/, ({ buttons }) => buttons.find((b) => /Choose File/.test(b)), 'info');
    on(/^DE10-Lite support file/, ({ buttons }) => buttons.find((b) => /Choose File/.test(b)), 'info');
    on(/^Choose the Nexys A7 support file/, () => (process.env['P4B_NEXYS_ARCHIVE'] === 'cancel' ? undefined : [vscode.Uri.file(process.env['P4B_NEXYS_ARCHIVE'] ?? '')]), 'opendialog');
    on(/^Choose the DE10-Lite support file/, () => (process.env['P4B_DE10_ARCHIVE'] === 'cancel' ? undefined : [vscode.Uri.file(process.env['P4B_DE10_ARCHIVE'] ?? '')]), 'opendialog');
    on(/Altera's files found/, ({ buttons }) => buttons.find((b) => /Use These Files/.test(b)));
    // Windows (and a Mac whose Downloads folder does not hold them): the student chooses the two files.
    on(/Altera's free software is needed/, ({ buttons }) => buttons.find((b) => /Choose Files/.test(b)));
    on(/^Choose QuartusLiteSetup/, () => [vscode.Uri.file(join(process.env['P4B_ALTERA_DIR'] ?? '', ALTERA_INSTALLER))], 'opendialog');
    on(/^Choose max10/, () => [vscode.Uri.file(join(process.env['P4B_ALTERA_DIR'] ?? '', ALTERA_PACKAGE))], 'opendialog');
    on(/^MIX-FPGA: /, () => undefined, 'info');
    on(/^MIX-FPGA: /, () => undefined, 'warning');
    on(/Welcome to MIX-FPGA\. Choose the FPGA boards/, () => undefined, 'info');
}

const boardsChoice = (...names: RegExp[]): void => on(/which FPGA boards/, ({ items }) => items.filter((i) => names.some((n) => n.test(i.label))));

async function newProject(boardPattern: RegExp, name: string, expectGate: boolean, installOnGate = false): Promise<string | undefined> {
    const parent = join(work, 'ws');
    await mkdir(parent, { recursive: true });
    handlers = handlers.filter((h) => !/choose the folder|project name|New MIX-FPGA Project|support is not installed|what should the new project/.test(h.when.source));
    on(/choose the folder that will contain/, () => [vscode.Uri.file(parent)]);
    on(/project name/, () => name);
    on(/New MIX-FPGA Project: board/, label(boardPattern));
    on(/support is not installed/, ({ buttons }) => (installOnGate ? buttons.find((b) => /Install Support/.test(b)) : undefined));
    on(/what should the new project contain/, ({ items }) => items.find((i) => /Starter/i.test(i.label)) ?? items.find((i) => !/^──/.test(i.label)));
    const before = transcript.length;
    await vscode.commands.executeCommand('nexysvhdl.createProject');
    const asked = transcript.slice(before);
    const boards = asked.find((p) => /New MIX-FPGA Project: board/.test(p.title));
    const gate = asked.find((p) => /support is not installed/.test(`${p.title}\n${p.text}`));
    step(`newProject.${name}`, { boardsOffered: boards?.items, gate: gate ? { message: gate.title, detail: gate.text, answered: gate.answered } : null });
    if (expectGate) step(`newProject.${name}.gateShown`, gate !== undefined);
    const root = join(parent, name);
    const made = await readFile(join(root, 'nexysvhdl.json'), 'utf8').then((t) => JSON.parse(t) as { board: string }, () => undefined);
    step(`newProject.${name}.created`, made ? { board: made.board, root } : false);
    return made ? root : undefined;
}

const sha = async (f: string): Promise<string> => createHash('sha256').update(await readFile(f)).digest('hex');
const writable = async (f: string): Promise<void> => {
    // sealed (read-only) tree: make the folders on the way and the file writable, as a student who replaces a library does
    const parts = f.split('/');
    for (let i = 3; i < parts.length; i++) await chmod(parts.slice(0, i).join('/') || '/', 0o755).catch(() => undefined);
    await chmod(f, 0o644).catch(() => undefined);
};

/** Phase 5F: the modified-toolchain behaviour through the real commands and the real Setup page. */
async function modifiedScenario(nexys: boolean): Promise<void> {
    const home = process.env['HOME'] ?? '';
    const root = nexys ? join(home, 'Library', 'MIX-FPGA', 'support', 'nexys-a7', 'toolchains', 'darwin-arm64', '1.1') : join(home, 'Library', 'MIX-FPGA', 'toolchains', '1.1', 'macos-arm64');
    const victim = nexys ? join(root, 'apio', 'packages', 'oss-cad-suite', 'lib', 'libreadline.8.2.dylib') : join(root, 'openfpgaloader', 'lib', 'libftdi1.2.5.0.dylib');
    const board = nexys ? /Nexys A7-100T/ : /DE10-Lite/;
    const required = nexys ? join(root, 'ghdl', 'bin', 'ghdl') : join(root, 'yosys', 'libexec', 'yosys');
    const shipped = await sha(victim);
    step('modified.shippedSha256', { file: victim.replace(home, '~'), sha256: shipped });
    const exec = (c: string, ...a: unknown[]) => vscode.commands.executeCommand(c, ...a);
    await showPage(undefined, 'cleanBefore');
    // 1. modify without deleting
    await writable(victim);
    await appendFile(victim, Buffer.from('a library the student replaced'));
    const changed = await sha(victim);
    step('modified.changedSha256', changed);
    // 2. refresh state
    await showPage(undefined, 'modified');
    // 3. New Project continues (the note is non-blocking; here it is dismissed)
    const before = transcript.length;
    const created = await newProject(board, nexys ? 'NexysModified' : 'De10Modified', false);
    step('modified.newProject', { created: created !== undefined, prompts: transcript.slice(before).map((p) => `${p.kind}: ${p.title}${p.text ? ` — ${p.text}` : ''} [answered: ${p.answered}]`) });
    // 4. Verify reports the modification
    const warned = transcript.length;
    const v = (await exec('nexysvhdl.setup.verify')) as { ok?: boolean; modified?: boolean; steps?: { label: string; ok: boolean; detail?: string }[] } | undefined;
    await sleep(300);
    step('modified.verify', { ok: v?.ok, modified: v?.modified, modifiedSteps: (v?.steps ?? []).filter((x) => /modified/.test(x.detail ?? '')).map((x) => `${x.label}: ${x.detail}`), failedSteps: (v?.steps ?? []).filter((x) => !x.ok).map((x) => x.label), messages: transcript.slice(warned).map((p) => `${p.kind}: ${p.title} [${p.answered}]`) });
    step('modified.afterVerifySha256Unchanged', (await sha(victim)) === changed);
    // 5. decline Repair: the confirmation dialog is answered with Cancel
    handlers = handlers.filter((h) => !/Install board support/.test(h.when.source));
    on(/Install board support/, () => undefined);
    const declinePrompt = transcript.length;
    await exec('nexysvhdl.setup.repair', nexys ? 'nexys-a7-100t' : 'de10-lite');
    step('modified.declinedRepair', { prompts: transcript.slice(declinePrompt).map((p) => `${p.title} — ${p.text} [answered: ${p.answered}]`), fileUnchanged: (await sha(victim)) === changed });
    // 6. choose Repair
    handlers = handlers.filter((h) => !/Install board support/.test(h.when.source));
    on(/Install board support/, ({ buttons }) => buttons.find((b) => b === 'Continue'));
    await exec('nexysvhdl.setup.repair', nexys ? 'nexys-a7-100t' : 'de10-lite');
    step('modified.repairedSha256', { restored: (await sha(victim)) === shipped });
    await showPage(undefined, 'afterRepair');
    // 7. a genuinely required file is missing: Needs repair, not modified
    await writable(required);
    await chmod(join(required, '..'), 0o755);
    await rm(required);
    await showPage(undefined, 'missingRequiredFile');
    const mv = (await exec('nexysvhdl.setup.verify')) as { ok?: boolean; modified?: boolean } | undefined;
    step('modified.missingVerify', { ok: mv?.ok, modified: mv?.modified });
    await exec('nexysvhdl.setup.repair', nexys ? 'nexys-a7-100t' : 'de10-lite');
    await showPage(undefined, 'afterMissingRepair');
}

export async function run(): Promise<void> {
    const out = process.env['NEXYS_EDH_REPORT']!;
    try {
        if (!process.env['MIXFPGA_HOME'] && !(process.env['HOME'] ?? '').includes('/MFU')) throw new Error('refusing to run: MIXFPGA_HOME (or a private HOME) must point at an isolated root');
        if (process.env['MIXFPGA_HOME'] && /[\\/]AppData[\\/]Local[\\/]MIX-FPGA$/i.test(process.env['MIXFPGA_HOME'])) throw new Error('refusing to run against the real MIX-FPGA root');
        const ext = vscode.extensions.getExtension<NexysVhdlApi>(EXTENSION_ID)!;
        const pkg = ext.packageJSON as { version: string; displayName: string };
        step('product', { displayName: pkg.displayName, version: pkg.version, extensionPath: ext.extensionPath, mixfpgaHome: process.env['MIXFPGA_HOME'] ?? null, home: process.env['HOME'], scenario });
        const requirement = JSON.parse(await readFile(join(ext.extensionPath, 'toolchains', 'bundle', 'requirement.json'), 'utf8')) as { bundleVersion: string; targets: Record<string, { treeSha256: string; archive: string }> };
        step('requiredToolchain', { version: requirement.bundleVersion, archive: requirement.targets['darwin-arm64']?.archive, tree: requirement.targets['darwin-arm64']?.treeSha256 });
        bindToExtension(ext.extensionPath);
        step('apiBinding', { sameObject: extApi.window === vscode.window });
        installPrompts();
        await ext.activate();
        const stopWatching = watchLicensePanel();
        commonAnswers();
        try {
            if (scenario === 'page') {
                await showPage(undefined, 'now');
            } else if (scenario === 'nexys-only') {
                await showPage(undefined, 'fresh');
                boardsChoice(/Nexys/);
                await showPage(/Install FPGA Toolchain/, 'install');
                await showPage(undefined, 'afterInstall');
                await newProject(/DE10/, 'GateOnly', true, false);
                await newProject(/Nexys/, 'NexysClean', false);
            } else if (scenario === 'nexys-projects') {
                await showPage(undefined, 'now');
                await newProject(/DE10/, 'GateOnly', true, false);
                await newProject(/Nexys/, 'NexysClean', false);
            } else if (scenario === 'de10-only') {
                await showPage(undefined, 'fresh');
                boardsChoice(/DE10/);
                await showPage(/Install FPGA Toolchain/, 'install');
                await showPage(undefined, 'afterInstall');
                await newProject(/DE10/, 'De10Clean', false);
            } else if (scenario === 'verify') {
                await showPage(undefined, 'before');
                await vscode.commands.executeCommand('nexysvhdl.setup.verify');
            } else if (scenario === 'repair-nexys') {
                // Damage one file of this root's Nexys A7 tools (a changed byte only a full check can see), then Verify, Repair, Verify.
                const win = process.platform === 'win32';
                const victim = join(process.env['MIXFPGA_HOME']!, 'support', 'nexys-a7', 'toolchains', win ? 'win32-x64' : 'darwin-arm64', '1.0', 'ghdl', 'bin', win ? 'ghdl.exe' : 'ghdl');
                await chmod(join(victim, '..'), 0o755);
                await chmod(victim, 0o755);
                // Same size is not needed: any change is found by a full check (the quick check compares sizes, so keep the length).
                const size = (await stat(victim)).size;
                await writeFile(victim, win ? Buffer.alloc(size, 0x41) : '#!/bin/sh\necho damaged\n');
                step('damaged', victim.replace(process.env['HOME'] ?? '', '~'));
                await showPage(undefined, 'beforeVerify');
                await vscode.commands.executeCommand('nexysvhdl.setup.verify');
                await showPage(/^\$\(tools\) Repair$|Repair$/, 'repair');
                await vscode.commands.executeCommand('nexysvhdl.setup.verify');
                await showPage(undefined, 'afterRepair');
            } else if (scenario === 'modified-nexys' || scenario === 'modified-de10') {
                await modifiedScenario(scenario === 'modified-nexys');
            } else if (scenario === 'de10-resume') {
                // An interrupted DE10-Lite setup: the board row offers to continue it.
                await showPage(/DE10-Lite/, 'resume');
                await showPage(undefined, 'afterInstall');
                await newProject(/DE10/, 'De10Clean', false);
            } else if (scenario === 'add-de10') {
                await showPage(/DE10-Lite/, 'addDe10');
                await showPage(undefined, 'afterAdd');
                await newProject(/DE10/, 'De10After', false);
            } else if (scenario === 'add-nexys') {
                await showPage(/Nexys A7-100T/, 'addNexys');
                await showPage(undefined, 'afterAdd');
                await newProject(/Nexys/, 'NexysAfter', false);
            } else if (scenario === 'upgrade') {
                await showPage(undefined, 'afterUpdate');
                await newProject(/DE10/, 'De10Upgrade', true, true);
                await newProject(/Nexys/, 'NexysUpgrade', false);
                await showPage(undefined, 'afterAddingDe10');
            } else throw new Error(`unknown scenario ${scenario}`);
        } finally {
            stopWatching();
        }
        step('unansweredPrompts', transcript.filter((p) => p.answered === '(unanswered)').map((p) => `${p.kind}: ${p.title} ${p.text}`.slice(0, 160)));
        step('result', 'PASS');
    } catch (err) {
        step('result', `FAILED: ${(err as Error).stack ?? String(err)}`);
        throw err;
    } finally {
        await mkdir(markers, { recursive: true }).catch(() => undefined);
        await writeFile(out, JSON.stringify({ report, log, prompts: transcript }, null, 2));
    }
}
export { run as runPhase4b, waitFor, sleep };
