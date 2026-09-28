import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { REPO } from './helpers';

/** Rules apply to code, not to explanatory comments. */
function stripComments(ts: string): string {
    return ts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

async function coreSources(): Promise<Array<{ file: string; text: string }>> {
    const out: Array<{ file: string; text: string }> = [];
    for (const e of await readdir(join(REPO, 'core'), { withFileTypes: true, recursive: true })) {
        if (e.isFile() && e.name.endsWith('.ts')) {
            const abs = join(e.parentPath, e.name);
            out.push({ file: relative(REPO, abs).split('\\').join('/'), text: stripComments(await readFile(abs, 'utf8')) });
        }
    }
    return out;
}

/** Architectural rule 1: the shared core is platform-neutral (see docs/architecture.md). */
describe('architecture rules for core/', () => {
    it('never names a platform programming backend or driver', async () => {
        const forbidden = /djtgcfg|adept|openfpgaloader|ftdi|winusb|zadig|vivado|digilent/i;
        for (const { file, text } of await coreSources()) {
            assert.doesNotMatch(text, forbidden, file);
        }
    });

    it('does not branch on the host platform (only host.ts reads it)', async () => {
        for (const { file, text } of await coreSources()) {
            if (file === 'core/host.ts') continue;
            assert.doesNotMatch(text, /process\.platform|os\.platform\(|process\.arch/, file);
            assert.doesNotMatch(text, /'win32'|"win32"|'darwin'|"darwin"/, file);
        }
    });

    it('never imports from platform/ or cli/', async () => {
        for (const { file, text } of await coreSources()) {
            assert.doesNotMatch(text, /from '(\.\.\/)+(platform|cli)(\/|')/, file);
        }
    });

    it('never runs tools through a shell', async () => {
        for (const { file, text } of await coreSources()) {
            assert.doesNotMatch(text, /shell:\s*true|powershell|cmd\.exe|\/bin\/(ba)?sh/i, file);
            // child_process.exec/execSync always go through a shell; spawn with an argument array is required.
            assert.doesNotMatch(text, /import\s*\{[^}]*\bexec(Sync)?\b[^}]*\}\s*from\s*'node:child_process'/, file);
        }
    });
});
