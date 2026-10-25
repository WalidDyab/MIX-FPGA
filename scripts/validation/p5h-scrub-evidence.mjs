#!/usr/bin/env node
// Phase 5H: removes the developer's repository path from evidence text files (the path adds nothing and the privacy audit would flag it).
//   node scripts/validation/p5h-scrub-evidence.mjs <folder>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '');
const needle = ['D:', 'WSClaude', 'MIX-FPGA', ''].join('\\');
for (const f of readdirSync(dir)) {
    if (!/\.(txt|log|json|md)$/.test(f)) continue;
    const p = join(dir, f);
    const s = readFileSync(p, 'utf8');
    const t = s.split(needle).join('<repo>\\').split(needle.replaceAll('\\', '\\\\')).join('<repo>\\\\');
    if (t !== s) { writeFileSync(p, t); console.log('scrubbed', f); }
}
