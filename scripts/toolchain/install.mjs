#!/usr/bin/env node
// Installs a NexysVHDL toolchain archive into a per-user toolchain store with
// the same installer the extension uses (Install FPGA Toolchain…). For
// developers and lab administrators; students use the extension command.
//
//   node scripts/toolchain/install.mjs [archive] [--data-root <dir>]
//
// Default archive: .artifacts/dist/<requirement archive for this host>.
// Default data root: the platform's NexysVHDL folder (e.g. %LOCALAPPDATA%\NexysVHDL).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fail, hostTarget, parseArgs, REPO_ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const dist = join(REPO_ROOT, 'dist');
if (!existsSync(join(dist, 'runtime', 'classroom.js'))) fail('run `npm run build` first');
const { loadRequirement } = require(join(dist, 'runtime', 'classroom.js'));
const { installToolchainArchive } = require(join(dist, 'core', 'index.js'));
const { platformHostFacts } = require(join(dist, 'platform', 'index.js'));

const args = parseArgs(process.argv.slice(2));
const target = hostTarget();
const { requirement, diagnostics } = loadRequirement(REPO_ROOT);
if (!requirement) fail(diagnostics.map((d) => d.message).join('\n'));
const want = requirement.targets[target];
if (!want || want.status !== 'validated') fail(`no validated toolchain ${requirement.bundleVersion} for ${target}`);
const archive = args._[0] ?? join(REPO_ROOT, '.artifacts', 'dist', want.archive);
const dataRoot = args['data-root'] ?? platformHostFacts({ platform: process.platform, arch: process.arch, nodeVersion: process.version })?.userDataRoot(process.env);
if (!dataRoot) fail('cannot determine the NexysVHDL data root on this host');

console.log(`Installing ${archive}\n  into ${dataRoot} (toolchain ${requirement.bundleVersion}, ${target})`);
let last = 0;
const started = Date.now();
const r = await installToolchainArchive({
    archive,
    dataRoot,
    target,
    requirement,
    onProgress: (p) => {
        if (p.files - last >= 2000) {
            last = p.files;
            process.stdout.write(`  ${p.files} files\r`);
        }
    },
});
if (r.status === 'failed') fail(r.diagnostics.map((d) => d.message).join('\n'));
console.log(`${r.status}: ${r.paths.versionDir} (${r.marker.files} files, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
