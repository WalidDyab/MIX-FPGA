import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from '../results/diagnostic';
import type { BoardProfile, ConstraintFile, ConstraintProvider, ConstraintSet } from './types';

const err = (code: string, message: string): Diagnostic => ({ severity: 'error', source: 'project', code, message });

/** QSF (device, pins, I/O standards) + SDC (clocks) in `<project>/constraints/`. Read-only. */
export class QsfSdcConstraintProvider implements ConstraintProvider {
    readonly format = 'qsf-sdc' as const;

    async collect(projectDir: string): Promise<ConstraintSet> {
        const dir = join(projectDir, 'constraints');
        let names: string[] = [];
        try {
            names = (await readdir(dir)).sort();
        } catch {
            /* missing directory is reported by validate() as "no constraint files" */
        }
        const files: ConstraintFile[] = [];
        for (const n of names) {
            const lower = n.toLowerCase();
            if (lower.endsWith('.qsf')) files.push({ kind: 'qsf', path: join(dir, n) });
            else if (lower.endsWith('.sdc')) files.push({ kind: 'sdc', path: join(dir, n) });
        }
        return { format: this.format, files };
    }

    async validate(set: ConstraintSet, board: BoardProfile): Promise<readonly Diagnostic[]> {
        const out: Diagnostic[] = [];
        const qsf = set.files.filter((f) => f.kind === 'qsf');
        const sdc = set.files.filter((f) => f.kind === 'sdc');
        if (qsf.length === 0) out.push(err('CONSTRAINTS_NO_QSF', 'No .qsf file in constraints/. A QSF assigns the device, pins and I/O standards.'));
        if (sdc.length === 0) out.push(err('CONSTRAINTS_NO_SDC', 'No .sdc file in constraints/. An SDC declares the clock so timing can be checked.'));
        for (const f of qsf) {
            const text = await readFile(f.path, 'utf8');
            const m = /set_global_assignment\s+-name\s+DEVICE\s+("?)([A-Za-z0-9]+)\1/i.exec(text);
            if (!m) out.push(err('CONSTRAINTS_NO_DEVICE', `${f.path}: no DEVICE assignment; expected ${board.fpga.device}.`));
            else if (m[2]!.toUpperCase() !== board.fpga.device.toUpperCase())
                out.push(err('CONSTRAINTS_WRONG_DEVICE', `${f.path}: DEVICE is ${m[2]} but ${board.name} has ${board.fpga.device}.`));
        }
        return out;
    }
}
