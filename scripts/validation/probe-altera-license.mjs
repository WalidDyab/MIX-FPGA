#!/usr/bin/env node
// Phase 4C probe: does Altera's real Windows installer hand over its licence with `--install_lic`, and nothing else?
// Uses MIX-FPGA's real elevated helper (Windows shows ONE permission prompt, answered by a person), asks only for the licence,
// verifies it against the pinned hashes, and stops the helper. The Altera files are read in place and never copied or changed.
//   node scripts/validation/probe-altera-license.mjs <folder with the two Altera files> <scratch folder> <result.json>
// Needs `npm run build` first. Snapshots of the system before and after are taken by probe-altera-license.ps1.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { ElevatedHelper } = require(join(repo, 'dist', 'platform', 'windows', 'install', 'elevation.js'));
const { WINDOWS_QUARTUS_SPEC: spec } = require(join(repo, 'dist', 'platform', 'windows', 'install', 'quartus-install.js'));
const { NodeToolRunner } = require(join(repo, 'dist', 'core', 'process', 'tool-runner.js'));

const [altera, scratch, resultFile] = process.argv.slice(2).map((p) => resolve(p));
const result = { startedAt: new Date().toISOString(), installer: spec.installer.name };
const helper = new ElevatedHelper({
  runner: new NodeToolRunner(),
  dir: join(scratch, 'ctl'),
  readyTimeoutMs: 300_000,
  params: {
    installers: altera,
    installerName: spec.installer.name,
    installerSha256: spec.installer.sha256,
    packageName: spec.devicePackage.name,
    packageSha256: spec.devicePackage.sha256,
    installDir: join(scratch, 'never-installed'),
    disabledComponents: spec.disabledComponents,
    licenseSha256: spec.license.rawSha256,
  },
});
try {
  await mkdir(scratch, { recursive: true });
  console.log('PERMISSION PROMPT NOW: Windows asks once; the helper then only asks the installer for its licence.');
  const started = await helper.start();
  result.started = started;
  if (!started.ok) throw new Error(`helper did not start: ${started.code}`);
  const t0 = Date.now();
  const r = await helper.request('license', 300_000);
  result.licenseRequest = { ...r, seconds: (Date.now() - t0) / 1000 };
  const raw = await readFile(helper.licenseFile).catch(() => undefined);
  if (raw) {
    const text = raw.toString('utf8').replace(/\r\n/g, '\n');
    result.license = {
      rawBytes: raw.length,
      rawSha256: createHash('sha256').update(raw).digest('hex'),
      normalizedBytes: Buffer.byteLength(text),
      normalizedSha256: createHash('sha256').update(text).digest('hex'),
      pinnedRaw: spec.license.rawSha256,
      pinnedNormalized: spec.license.sha256,
      matchesRaw: createHash('sha256').update(raw).digest('hex') === spec.license.rawSha256,
      matchesNormalized: createHash('sha256').update(text).digest('hex') === spec.license.sha256,
      title: text.split('\n').find((l) => l.trim()) ?? '',
    };
  } else result.license = null;
  result.helperLog = await readFile(join(scratch, 'ctl', 'helper.log'), 'utf8').catch(() => '');
} catch (err) {
  result.error = String(err?.stack ?? err);
} finally {
  await helper.stop().catch(() => undefined);
  result.stoppedAt = new Date().toISOString();
  await writeFile(resultFile, JSON.stringify(result, null, 2));
  // Only the probe's own temporary files go.
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
console.log(JSON.stringify({ license: result.license, request: result.licenseRequest, error: result.error }, null, 2));
