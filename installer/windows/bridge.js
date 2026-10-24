// MIX-FPGA Setup bridge (Windows). Runs under Visual Studio Code's own Node (ELECTRON_RUN_AS_NODE) and calls the Setup code that ships
// INSIDE the installed MIX-FPGA extension, so the installer and the extension install the support exactly the same way (same pinned
// hashes, same verification, same layout, same path-length check). It never touches Altera or Windows' permission prompt: Quartus and the
// MAX 10 package stay in the extension's own Setup flow, behind the student's explicit acceptance of Altera's licence.
//
//   Code.exe bridge.js --ext <installed extension folder> --support <folder with the support archives> --boards nexys,de10 [--verify]
//
// Output: one JSON object per line: {type:'progress'|'log'|'result', ...}.
'use strict';
const path = require('node:path');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const ext = opt('--ext');
const support = opt('--support');
const boards = (opt('--boards') ?? '').split(',').filter(Boolean).map((b) => (b === 'nexys' ? 'nexys-a7-100t' : b === 'de10' ? 'de10-lite' : b));
const NEXYS = 'nexysvhdl-toolchain-1.1-win32-x64.tar.gz';
const DE10 = 'mixfpga-de10-lite-support-1.1-windows-x64.tar.gz';

async function main() {
    if (!ext || !support || boards.length === 0) throw new Error('usage: --ext <dir> --support <dir> --boards nexys,de10');
    const { createSetupController } = require(path.join(ext, 'dist', 'runtime', 'setup.js'));
    const controller = await createSetupController({ extensionPath: ext, hardware: () => ({ state: 'not-connected', word: 'Not connected' }) });
    if (!controller) throw new Error('This MIX-FPGA build has no Setup controller for this computer.');
    const abort = new AbortController();
    for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => abort.abort());
    let last = '';
    const needs = { stoppedFor: undefined };
    const ui = {
        async chooseBoards() { return boards; },
        async askNexysArchive() { return path.join(support, NEXYS); },
        async askDe10Archive() { return path.join(support, DE10); },
        async confirmInstall() { return true; },
        async askRosettaConsent() { needs.stoppedFor = 'rosetta'; return undefined; },
        async askQuartusFiles() { needs.stoppedFor = 'altera'; return undefined; },
        async showLicense() { return false; },
        progress(m) { if (m !== last) { last = m; emit({ type: 'progress', message: m }); } },
        log(l) { emit({ type: 'log', line: l }); },
    };
    if (argv.includes('--verify')) {
        const v = await controller.verify(abort.signal);
        emit({ type: 'result', action: 'verify', ok: v.ok, modified: v.modified === true, steps: v.steps.map((s) => ({ label: s.label, ok: s.ok, detail: s.detail })) });
        return;
    }
    const r = await controller.install(ui, abort.signal, boards);
    emit({ type: 'result', action: 'install', outcome: r.outcome, message: r.message, stoppedFor: needs.stoppedFor, headline: r.view.headline, boards: r.view.boards.map((b) => ({ id: b.id, name: b.name, word: b.word })) });
}
main().catch((e) => { emit({ type: 'result', action: 'error', message: String(e && e.message ? e.message : e) }); process.exitCode = 1; });
