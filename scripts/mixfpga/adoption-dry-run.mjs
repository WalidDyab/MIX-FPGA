#!/usr/bin/env node
// DRY RUN: reports what adopting the existing development setup into ~/Library/MIX-FPGA (the installed layout) would
// copy, write and leave alone. Reads files and asks Lima for its list; changes nothing. Needs `npm run build` first.
//   node scripts/mixfpga/adoption-dry-run.mjs [--json]
import { adopt, deps } from './adoption-inputs.mjs';

const plan = await adopt.planAdoption(deps);
console.log(process.argv.includes('--json') ? JSON.stringify(plan, null, 2) : adopt.formatAdoptionPlan(plan));
