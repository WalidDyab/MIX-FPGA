// Shared helpers for the NexysVHDL toolchain-bundle scripts (build time only;
// never shipped to students). Node built-ins only.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { lstat, readdir, readlink, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RECIPE_DIR = join(REPO_ROOT, 'toolchains', 'bundle');
export const ARCHIVE_DIR = join(REPO_ROOT, '.artifacts', 'archives');
export const TOOLCHAIN_DIR = join(REPO_ROOT, 'toolchain');
export const MANIFEST_NAME = 'toolchain-manifest.json';
export const NOTICES_NAME = 'THIRD_PARTY_NOTICES.md';

export const SUPPORTED_TARGETS = ['win32-x64', 'darwin-arm64'];

export function hostTarget() {
    return `${process.platform}-${process.arch}`;
}

export function fail(message) {
    console.error(`error: ${message}`);
    process.exit(1);
}

export function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) args._.push(a);
        else if (a.includes('=')) args[a.slice(2, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
        else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) args[a.slice(2)] = argv[++i];
        else args[a.slice(2)] = true;
    }
    return args;
}

export function loadRecipe(target) {
    if (!SUPPORTED_TARGETS.includes(target)) fail(`unsupported target "${target}" (supported: ${SUPPORTED_TARGETS.join(', ')})`);
    const file = join(RECIPE_DIR, `${target}.json`);
    if (!existsSync(file)) fail(`no recipe ${relative(REPO_ROOT, file)}`);
    const recipe = JSON.parse(readFileSync(file, 'utf8'));
    const problems = validateRecipe(recipe, target);
    if (problems.length) fail(`${relative(REPO_ROOT, file)}:\n  ${problems.join('\n  ')}`);
    return recipe;
}

/** Structural checks; a recipe that is not fully pinned (sha256, size, version) is refused. */
export function validateRecipe(r, target) {
    const p = [];
    if (r.schemaVersion !== 1) p.push('schemaVersion must be 1');
    if (r.target !== target) p.push(`target "${r.target}" does not match file name`);
    if (`${r.platform}-${r.arch}` !== target) p.push('platform/arch do not match target');
    if (r.status !== 'validated') p.push(`status is "${r.status}": only a validated recipe can be assembled`);
    if (!r.bundleVersion) p.push('missing bundleVersion');
    for (const [tool, rel] of Object.entries(r.executables ?? {})) if (!safeRelative(rel)) p.push(`executable ${tool}: unsafe path ${rel}`);
    if (!r.executables?.ghdl || !r.executables?.apio) p.push('executables.ghdl and executables.apio are required');
    if (!r.apio?.packagesDir?.split('/').includes('packages')) p.push('apio.packagesDir must contain a "packages" segment (Apio requirement)');
    for (const rel of r.environment?.pathPrepend ?? []) if (!safeRelative(rel)) p.push(`environment.pathPrepend: unsafe path ${rel}`);
    for (const s of r.shims ?? []) if (!safeRelative(s.file) || !safeRelative(s.target)) p.push(`shim ${s.file}: unsafe path`);
    if (!/^\d+\.\d+(\.\d+)?$/.test(r.bundleVersion ?? '')) p.push(`bundleVersion "${r.bundleVersion}" must look like 1.0 or 1.0.1`);
    const ids = new Set();
    for (const c of r.components ?? []) {
        if (ids.has(c.id)) p.push(`duplicate component ${c.id}`);
        ids.add(c.id);
        for (const k of ['name', 'version', 'license', 'licenseEvidence', 'homepage', 'sourceCode', 'dest']) if (!c[k]) p.push(`${c.id}: missing ${k}`);
        if (!safeRelative(c.dest ?? '')) p.push(`${c.id}: unsafe dest ${c.dest}`);
        if (c.placeholder) {
            // An Apio package Apio requires but nothing uses: an empty folder, nothing redistributed.
            if (!c.apioPackage) p.push(`${c.id}: a placeholder must be an Apio package`);
            if (!c.placeholder.reason || !Array.isArray(c.placeholder.evidence) || c.placeholder.evidence.length === 0) p.push(`${c.id}: a placeholder needs a reason and evidence`);
            if (c.archive) p.push(`${c.id}: a placeholder must not have an archive`);
            continue;
        }
        const a = c.archive ?? {};
        if (!/^https:\/\//.test(a.url ?? '')) p.push(`${c.id}: archive.url must be https`);
        if (!/^[0-9a-f]{64}$/.test(a.sha256 ?? '')) p.push(`${c.id}: archive.sha256 missing or malformed`);
        if (!Number.isInteger(a.size) || a.size <= 0) p.push(`${c.id}: archive.size missing`);
        if (!a.file || a.file.includes('/') || a.file.includes('\\')) p.push(`${c.id}: archive.file must be a plain file name`);
        for (const f of c.licenseFiles ?? []) {
            if (!f.startsWith('licenses/')) continue;
            const name = f.slice('licenses/'.length);
            if (!existsSync(join(RECIPE_DIR, 'licenses', name)) && !existsSync(join(RECIPE_DIR, `licenses-${target}`, name))) p.push(`${c.id}: license text ${f} not found in toolchains/bundle/licenses or licenses-${target}`);
        }
    }
    if (!(r.components ?? []).length) p.push('no components');
    return p;
}

export function safeRelative(rel) {
    return typeof rel === 'string' && rel.length > 0 && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !rel.includes('\\') && !rel.split('/').includes('..');
}

export async function sha256File(path) {
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
        createReadStream(path).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject);
    });
    return hash.digest('hex');
}

/**
 * Every regular file and symbolic link under `dir` (links are not followed),
 * as POSIX paths relative to `dir`, sorted.
 */
export async function listFiles(dir) {
    const out = [];
    const walk = async (d) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
            const full = join(d, e.name);
            if (e.isDirectory()) await walk(full);
            else if (e.isFile() || e.isSymbolicLink()) out.push(relative(dir, full).split(sep).join('/'));
            else throw new Error(`unexpected non-regular file in toolchain: ${full}`);
        }
    };
    await walk(dir);
    return out.sort();
}

/**
 * The target of a symbolic link in archive (POSIX) form, or undefined for a
 * regular file. Same normalization as core/toolchain/tar.ts posixLinkTarget():
 * Windows reads relative targets back with backslashes.
 */
export async function linkTarget(path) {
    if (!(await lstat(path)).isSymbolicLink()) return undefined;
    const raw = await readlink(path);
    return sep === '/' ? raw : raw.split(sep).join('/');
}

/**
 * Content inventory of a directory: file count, bytes, and a tree hash over
 * "<path>\0<size>\0<sha256>\n" lines, or "<path>\0->\0<target>\n" for a
 * symbolic link (independent of timestamps, so two stagings of the same
 * archives hash identically). Same definition as core/toolchain/tar.ts treeHash().
 */
export async function inventory(dir, { exclude = [] } = {}) {
    const files = (await listFiles(dir)).filter((f) => !exclude.some((x) => f === x || f.startsWith(`${x}/`)));
    const tree = createHash('sha256');
    let bytes = 0;
    const hashes = {};
    for (const f of files) {
        const full = join(dir, ...f.split('/'));
        const link = await linkTarget(full);
        if (link !== undefined) {
            hashes[f] = `-> ${link}`;
            tree.update(`${f}\0->\0${link}\n`);
            continue;
        }
        const size = (await stat(full)).size;
        const h = await sha256File(full);
        hashes[f] = h;
        bytes += size;
        tree.update(`${f}\0${size}\0${h}\n`);
    }
    return { files: files.length, bytes, treeSha256: tree.digest('hex'), hashes };
}

/** Apio's remote config for this recipe: every Apio package pinned to the validated release tag. */
export function apioRemoteConfig(recipe) {
    const packages = {};
    for (const c of recipe.components) {
        if (!c.apioPackage) continue;
        packages[c.apioPackage.name] = {
            repository: { name: c.apioPackage.repository.name, organization: c.apioPackage.repository.organization },
            release: { tag: c.apioPackage.releaseTag, package: c.apioPackage.packageTemplate },
        };
    }
    return { packages };
}

export function apioRemoteConfigFileName(apioVersion) {
    const m = /^(\d+)\.(\d+)\./.exec(apioVersion);
    if (!m) fail(`cannot derive the Apio remote-config file name from version ${apioVersion}`);
    return `apio-${m[1]}.${m[2]}.x.jsonc`;
}

/** Apio's installed_packages.json, exactly as Apio writes it after installing each package. */
export function apioInstalledPackages(recipe) {
    const out = {};
    for (const c of recipe.components) {
        if (!c.apioPackage) continue;
        out[c.apioPackage.name] = {
            version: c.apioPackage.releaseTag.replaceAll('-', '.'),
            platform: recipe.apio.platformId,
            'loaded-by': recipe.apio.version,
            'loaded-at': recipe.apio.installedAt,
            'loaded-from': c.placeholder ? `nexysvhdl-placeholder:${c.notRedistributed?.archive?.file ?? c.apioPackage.name} (not redistributed; unused by NexysVHDL)` : c.archive.url,
        };
    }
    return out;
}
