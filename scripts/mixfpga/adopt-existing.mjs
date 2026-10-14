#!/usr/bin/env node
// PERFORMS the adoption of this Mac's existing development setup (see adoption-dry-run.mjs). Refuses to run without --yes,
// and refuses (changing nothing) if any check differs from the validated manifest / engine configuration.
//   node scripts/mixfpga/adopt-existing.mjs --yes
import { adopt, deps } from './adoption-inputs.mjs';

if (!process.argv.includes('--yes')) {
  console.error('This performs the adoption. Run the dry run first, then pass --yes.');
  process.exit(2);
}
const r = await adopt.performAdoption(deps);
for (const s of r.steps) console.log(`${s.ok ? 'OK  ' : 'FAIL'}  ${s.label}${s.detail ? ` — ${s.detail}` : ''}`);
console.log(`\nResult: ${r.outcome.toUpperCase()}`);
process.exit(r.ok ? 0 : 1);
