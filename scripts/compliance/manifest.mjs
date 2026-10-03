#!/usr/bin/env node
// Generates the machine-readable compliance manifest of a NexysVHDL toolchain
// version (toolchains/compliance/toolchain-<version>.json) from:
//   - the validated recipes (toolchains/bundle/<target>.json) and requirement.json;
//   - the curated review data (toolchains/compliance/curation.json);
//   - the evidence inventories of each assembled payload
//     (.artifacts/compliance/inventory-<platform>.json, scripts/compliance/inventory.mjs).
// Build time only; never shipped. Fails when a copyleft item has no pinned source.
//
//   node scripts/compliance/manifest.mjs [--check]
//
// --check: do not write; fail if the committed manifest differs from a fresh generation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fail, parseArgs, RECIPE_DIR, REPO_ROOT, SUPPORTED_TARGETS } from '../toolchain/lib.mjs';

export const COMPLIANCE_DIR = join(REPO_ROOT, 'toolchains', 'compliance');
const EVIDENCE_DIR = join(REPO_ROOT, '.artifacts', 'compliance');
const INVENTORY = { 'win32-x64': 'inventory-win32.json', 'darwin-arm64': 'inventory-darwin.json' };

/** License identifiers whose terms make source availability a condition of binary redistribution. */
export const SOURCE_REQUIRED = /\b(A?GPL|LGPL|EUPL|EPL|MPL|CDDL|Artistic)-/;

export function requiresSource(licenses) {
    return licenses.some((l) => SOURCE_REQUIRED.test(l) && !/GCC-exception|LLVM-exception/.test(l));
}

export function buildManifest({ recipes, requirement, curation, inventories }) {
    const sourceByPin = new Map(curation.sources.filter((s) => s.kind === 'git').map((s) => [`${s.url} ${s.revision}`, s.id]));
    const sourceIds = new Set(curation.sources.map((s) => s.id));
    const unresolvedIds = new Set(curation.unresolved.map((u) => u.id));
    const problems = [];
    const targets = {};
    for (const target of SUPPORTED_TARGETS) {
        const recipe = recipes[target];
        const review = curation.components[target] ?? {};
        const req = requirement.targets[target];
        const components = recipe.components.map((c) => {
            const r = review[c.id];
            if (!r) {
                problems.push(`${target}/${c.id}: no review entry in curation.json`);
                return { id: c.id };
            }
            for (const s of r.sources) if (!sourceIds.has(s)) problems.push(`${target}/${c.id}: unknown source ${s}`);
            for (const u of r.unresolved ?? []) if (!unresolvedIds.has(u)) problems.push(`${target}/${c.id}: unknown unresolved item ${u}`);
            return {
                id: c.id,
                name: c.name,
                version: c.version,
                path: c.dest,
                redistributed: !c.placeholder,
                license: r.spdx,
                licenseAsRecorded: c.license,
                licenseEvidence: c.licenseEvidence,
                licenseFiles: c.licenseFiles ?? [],
                homepage: c.homepage,
                upstreamSource: c.sourceCode,
                ...(c.archive ? { binaryArchive: { file: c.archive.file, url: c.archive.url, sha256: c.archive.sha256, size: c.archive.size } } : {}),
                ...(c.placeholder ? { placeholder: c.placeholder, notRedistributed: c.notRedistributed } : {}),
                modifications: c.placeholder ? 'Replaced by an empty placeholder folder (NEXYSVHDL-PLACEHOLDER.txt only).' : 'None: extracted unmodified from the archive above.',
                usage: r.usage,
                sources: r.sources,
                status: r.status,
                ...(r.unresolved ? { unresolved: r.unresolved } : {}),
                ...(r.note ? { note: r.note } : {}),
            };
        });
        const inv = inventories[target];
        const placeholderDirs = recipe.components.filter((c) => c.placeholder).map((c) => `${c.dest}/`);
        const ossCadSuiteTools = (inv?.ossCadSuite ?? []).filter((t) => !placeholderDirs.some((d) => t.file.startsWith(d))).map((t) => {
            const sources = t.sources.filter((s) => s.revision).map((s) => ({ url: s.url, revision: s.revision, source: sourceByPin.get(`${s.url} ${s.revision}`) ?? null }));
            const sourceRequired = requiresSource(t.licenses);
            if (sourceRequired && !sources.some((s) => s.source)) problems.push(`${target}: oss-cad-suite tool ${t.name} (${t.licenses.join(', ')}) has no pinned source in curation.json`);
            return { name: t.name, licenses: t.licenses, licenseFile: `apio/packages/oss-cad-suite/license/${t.file.split('/').pop()}`, sources, sourceRequired };
        });
        if (!inv) problems.push(`${target}: missing evidence inventory .artifacts/compliance/${INVENTORY[target]}`);
        targets[target] = {
            displayPlatform: recipe.displayPlatform,
            bundleVersion: recipe.bundleVersion,
            payload: req ? { treeSha256: req.treeSha256, files: req.files, bytes: req.bytes, archive: req.archive } : null,
            programmer: recipe.programmer,
            components,
            ossCadSuiteTools,
            apioPythonPackages: curation.apioPythonPackages[target],
            nativeLibraries: inv ? inv.nativeLibraries.filter((l) => !placeholderDirs.some((d) => l.startsWith(d))).length : null,
        };
    }
    for (const u of curation.unresolved) if (!u.resolution) problems.push(`unresolved ${u.id}: no resolution path`);
    return {
        manifest: {
            schemaVersion: 1,
            toolchainVersion: curation.toolchainVersion,
            generatedBy: 'scripts/compliance/manifest.mjs',
            statement: curation.statement,
            nexysvhdl: curation.nexysvhdl,
            digilent: curation.digilent,
            licenseClasses: curation.licenseClasses,
            targets,
            sources: curation.sources,
            unresolved: curation.unresolved.map((u) => ({ blocking: u.blocking !== false, ...u })),
        },
        problems,
    };
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const curation = readJson(join(COMPLIANCE_DIR, 'curation.json'));
    const recipes = Object.fromEntries(SUPPORTED_TARGETS.map((t) => [t, readJson(join(RECIPE_DIR, `${t}.json`))]));
    const requirement = readJson(join(RECIPE_DIR, 'requirement.json'));
    const inventories = Object.fromEntries(SUPPORTED_TARGETS.map((t) => [t, existsSync(join(EVIDENCE_DIR, INVENTORY[t])) ? readJson(join(EVIDENCE_DIR, INVENTORY[t])) : undefined]));
    const { manifest, problems } = buildManifest({ recipes, requirement, curation, inventories });
    if (problems.length) fail(`compliance manifest:\n  ${problems.join('\n  ')}`);
    const out = join(COMPLIANCE_DIR, `toolchain-${curation.toolchainVersion}.json`);
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (args.check) {
        if (!existsSync(out) || readFileSync(out, 'utf8') !== text) fail(`${relative(REPO_ROOT, out)} is out of date: run node scripts/compliance/manifest.mjs`);
        console.log(`${relative(REPO_ROOT, out)} is up to date`);
        return;
    }
    writeFileSync(out, text);
    const blocking = manifest.unresolved.filter((u) => u.blocking).length;
    console.log(`Wrote ${relative(REPO_ROOT, out)}: ${manifest.sources.length} pinned sources, ${manifest.unresolved.length} open items (${blocking} blocking).`);
}

if (process.argv[1] && import.meta.url.endsWith('/scripts/compliance/manifest.mjs') && process.argv[1].replaceAll('\\', '/').endsWith('scripts/compliance/manifest.mjs')) await main();
