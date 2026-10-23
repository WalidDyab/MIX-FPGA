#!/usr/bin/env node
// Phase 5E validation driver: installs the FINAL Toolchain 1.1 support archives into an ISOLATED root through the product's own
// Setup controller (the same code the Setup page uses), never into ~/Library/MIX-FPGA.
//
//   node scripts/validation/phase5e-isolated-setup.mjs --home <empty folder> --payloads <folder with the two archives> \
//        [--boards nexys-a7-100t,de10-lite] [--accept-altera-licence] [--downloads ~/Downloads]
//
// Quartus (DE10-Lite) is installed from the student's own Altera downloads; its licence is accepted only when
// --accept-altera-licence is passed, which the owner allowed for the isolated validation root only. Needs `npm run build` first.
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const home = resolve(opt('--home', ''));
const payloads = resolve(opt('--payloads', ''));
if (!opt('--home') || !opt('--payloads')) { console.error('usage: --home <folder> --payloads <folder> [--boards a,b] [--accept-altera-licence]'); process.exit(2); }
if (home.startsWith(join(homedir(), 'Library', 'MIX-FPGA'))) { console.error('refusing to use the real MIX-FPGA folder'); process.exit(2); }
const boards = opt('--boards', 'nexys-a7-100t,de10-lite').split(',');
const downloads = resolve(opt('--downloads', join(homedir(), 'Downloads')));
await mkdir(home, { recursive: true });
process.env.MIXFPGA_HOME = home;
process.env.MIXFPGA_DEV_PAYLOAD = payloads;

const { createSetupController, ALTERA_DOWNLOADS } = require(join(repo, 'dist', 'runtime', 'setup.js'));
const controller = await createSetupController({ extensionPath: repo, hardware: () => ({ state: 'not-connected', word: 'Not connected' }), runRosettaCommand: async () => ({ ok: false }) });
if (!controller) { console.error('no Setup controller'); process.exit(1); }

const accept = argv.includes('--accept-altera-licence');
const ui = {
    async chooseBoards() { return boards; },
    async askNexysArchive() { return undefined; },
    async askDe10Archive() { return undefined; },
    async confirmInstall(s) { console.log(`CONFIRM: ${s.items.join('; ')}${s.replacesChanges ? ' (replaces changed files)' : ''}`); return true; },
    async askRosettaConsent() { return { method: 'apple-prompt' }; },
    async askQuartusFiles() {
        return { installerPath: join(downloads, ALTERA_DOWNLOADS.installerName), devicePackagePath: join(downloads, ALTERA_DOWNLOADS.packageName) };
    },
    async showLicense(offer) { console.log(`LICENCE shown (${offer.text?.length ?? 0} chars); accepted=${accept}`); return accept; },
    progress(m) { console.log(`  ${m}`); },
    log(l) { console.log(`  [log] ${l}`); },
};
const out = await controller.install(ui, undefined, boards);
console.log(JSON.stringify({ outcome: out.outcome, message: out.message, headline: out.view.headline, boards: out.view.boards.map((b) => `${b.name}=${b.word}`) }, null, 1));
process.exit(out.outcome === 'complete' ? 0 : 1);
