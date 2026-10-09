#!/usr/bin/env node
// macOS counterpart of phase7-validate.ps1: runs the integration stages in a real VS Code against the PACKAGED extension
// (installed from the .vsix into a private extensions folder), never the source tree.
//
//   node scripts/validation/phase8-validate-macos.mjs --vsix .artifacts/dist/nexysvhdl-0.6.0-darwin-arm64.vsix \
//        --sandbox .artifacts/validation/sandbox --project .artifacts/validation/projects/DigitDisplay --fresh --stages a,b,r
//
// Stages are those of tests/integration/phase7-suite.ts (a, b, r, n, s, c, d, u, e, w, v); --suite picks phase6/phase6b/phase6c instead.
// Needs: npm run build first, VS Code in /Applications, the installed FPGA toolchain (~/Library/NexysVHDL).
// Nothing outside --sandbox is read or written except the toolchain store. Screenshots (<sandbox>/png) are best effort: they need
// the Screen Recording permission for the terminal; without it the stage still runs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../toolchain/lib.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const fail = (m) => { console.error(`error: ${m}`); process.exit(1); };
if (!args.vsix || !args.sandbox) fail('usage: --vsix <file> --sandbox <folder> [--project <folder> --fresh] [--stages a,b,r] [--suite phase7] [--timeout 600]');
const sandbox = resolve(args.sandbox);
const vsix = resolve(args.vsix);
const suite = args.suite ?? 'phase7';
const timeoutSec = Number(args.timeout ?? 600);
const stages = String(args.stages ?? 'a,b,r').split(',');
const codeApp = process.env.NEXYS_VSCODE ?? '/Applications/Visual Studio Code.app';
const codeExe = join(codeApp, 'Contents', 'MacOS', 'Code');
const cli = join(codeApp, 'Contents', 'Resources', 'app', 'out', 'cli.js');
const env0 = { ...process.env };
delete env0.ELECTRON_RUN_AS_NODE;

if (args.fresh || !existsSync(sandbox)) {
    if (!args.project) fail('a fresh sandbox needs --project <folder to copy as the workspace>');
    rmSync(sandbox, { recursive: true, force: true });
    for (const d of ['ext', 'user', 'host', 'scratch', 'shots', 'ws']) mkdirSync(join(sandbox, d), { recursive: true });
    writeFileSync(join(sandbox, 'host', 'package.json'), '{ "name": "p7host", "version": "0.0.0", "publisher": "p7", "engines": { "vscode": "*" } }\n');
    cpSync(resolve(args.project), join(sandbox, 'ws', basename(resolve(args.project))), { recursive: true });
    const r = spawnSync(codeExe, [cli, '--install-extension', vsix, '--extensions-dir', join(sandbox, 'ext'), '--user-data-dir', join(sandbox, 'user'), '--force'], { env: { ...env0, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
    if (r.status !== 0) fail(`installing the VSIX failed:\n${r.stdout}${r.stderr}`);
    console.log(r.stdout.trim());
}
const workspace = join(sandbox, 'ws', readdirSync(join(sandbox, 'ws'))[0]);

// Best-effort screenshots: the suite writes <name>.shot and waits for <name>.done.
function startShotWatcher() {
    const shots = join(sandbox, 'shots');
    const png = join(sandbox, 'png');
    mkdirSync(png, { recursive: true });
    const seen = new Set();
    const timer = setInterval(() => {
        for (const f of readdirSync(shots)) {
            if (!f.endsWith('.shot') || seen.has(f + statKey(join(shots, f)))) continue;
            seen.add(f + statKey(join(shots, f)));
            const name = f.slice(0, -5);
            spawnSync('screencapture', ['-x', '-t', 'png', join(png, `${name}.png`)]);
            writeFileSync(join(shots, `${name}.done`), new Date().toISOString());
        }
    }, 250);
    return () => clearInterval(timer);
}
const statKey = (f) => { try { return String(readFileSync(f)); } catch { return ''; } };

for (const stage of stages) {
    const reportFile = join(sandbox, `report-${stage}.json`);
    rmSync(reportFile, { force: true });
    rmSync(join(sandbox, 'shots', 'finished'), { force: true });
    const env = {
        ...env0,
        NEXYS_P6_SUITE: suite, NEXYS_P7_STAGE: stage, NEXYS_P7_SCRATCH: join(sandbox, 'scratch'), NEXYS_P7_USERDATA: join(sandbox, 'user'),
        NEXYS_P7_SHOTS: join(sandbox, 'shots'), NEXYS_P6_USER_DATA: join(sandbox, 'user'), NEXYSVHDL_P6_EXTENSIONS_DIR: join(sandbox, 'ext'),
        NEXYSVHDL_P6_HOST_DIR: join(sandbox, 'host'), NEXYS_EDH_REPORT: reportFile,
    };
    const stopShots = startShotWatcher();
    const out = join(sandbox, `run-${stage}.out`);
    const child = spawn(process.execPath, [join(repo, 'dist', 'tests', 'integration', 'run-phase6.js'), codeExe, workspace, reportFile, join(sandbox, 'shots')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const timedOut = await new Promise((done) => {
        const t = setTimeout(() => { child.kill('SIGKILL'); done(true); }, timeoutSec * 1000);
        child.on('exit', () => { clearTimeout(t); done(false); });
    });
    stopShots();
    writeFileSync(out, text);
    // A window closed by the suite itself (stage a) leaves Code's helper processes a moment to exit.
    await new Promise((r) => setTimeout(r, 2000));
    let result = timedOut ? 'TIMEOUT' : 'no report';
    if (existsSync(reportFile)) { try { result = JSON.parse(readFileSync(reportFile, 'utf8')).report.result; } catch { result = 'unreadable report'; } }
    console.log(`stage ${stage}: ${result}`);
}
