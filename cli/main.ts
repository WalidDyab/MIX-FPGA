#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadProject, packageVersion, type Project } from '../core';
import { doctor } from './commands/doctor';
import { boards, projectInfo } from './commands/info';
import { program } from './commands/program';
import { build, check, simulate } from './commands/workflow';
import { type ContextOverrides, createContext } from './context';
import { consoleOutput, EXIT, type ExitCode, type Output, printDiagnostics } from './output';

const HELP = `nexysvhdl — VHDL workflow for the Digilent Nexys A7-100T (in development)

Usage:
  nexysvhdl doctor                       Report host, toolchain and provider state
  nexysvhdl boards                       List supported boards and their resources
  nexysvhdl project info                 Show and validate the project
  nexysvhdl check                        Analyze and elaborate the VHDL
  nexysvhdl simulate [--testbench <tb>]  Run a testbench
  nexysvhdl build [--simulate] [--json]  VHDL -> bitstream
  nexysvhdl program [--serial <sn>]      Program the board (FPGA SRAM)

Options:
  --project <dir>   Project folder containing nexysvhdl.json (default: current folder)
  --version         Print the version
  --help            Show this help

Exit codes: 0 ok, 1 failed, 2 usage/project error, 3 provider not configured.
`;

async function requireProject(dir: string, out: Output): Promise<Project | undefined> {
    const loaded = await loadProject(dir);
    if (loaded.ok) return loaded.project;
    printDiagnostics(out, loaded.diagnostics);
    return undefined;
}

/** Runs one CLI invocation; returns the exit code instead of exiting (testable). */
export async function runCli(argv: readonly string[], out: Output = consoleOutput, overrides: ContextOverrides = {}): Promise<ExitCode> {
    let parsed;
    try {
        parsed = parseArgs({
            args: [...argv],
            allowPositionals: true,
            strict: true,
            options: {
                project: { type: 'string' },
                testbench: { type: 'string' },
                serial: { type: 'string' },
                simulate: { type: 'boolean' },
                json: { type: 'boolean' },
                help: { type: 'boolean', short: 'h' },
                version: { type: 'boolean', short: 'v' },
            },
        });
    } catch (err) {
        out.error((err as Error).message);
        out.error('Run "nexysvhdl --help" for usage.');
        return EXIT.usage;
    }
    const { values, positionals } = parsed;
    const [command, sub] = positionals;

    if (values.version) {
        out.line(packageVersion());
        return EXIT.ok;
    }
    if (values.help || command === undefined || command === 'help') {
        out.line(HELP);
        return EXIT.ok;
    }

    const ctx = await createContext(overrides);
    const projectDir = values.project ?? process.cwd();

    switch (command) {
        case 'doctor': {
            // A project is optional for doctor; use it only if one is present.
            const loaded = await loadProject(projectDir);
            return doctor(ctx, out, loaded.ok ? loaded.project : undefined);
        }
        case 'boards':
            return boards(ctx, out);
        case 'project': {
            if (sub !== 'info') break;
            const project = await requireProject(projectDir, out);
            return project ? projectInfo(ctx, out, project) : EXIT.usage;
        }
        case 'check':
        case 'simulate':
        case 'build':
        case 'program': {
            const project = await requireProject(projectDir, out);
            if (!project) return EXIT.usage;
            if (command === 'check') return check(ctx, out, project);
            if (command === 'simulate') return simulate(ctx, out, project, values.testbench);
            if (command === 'build') return build(ctx, out, project, values.simulate ?? false, values.json ?? false);
            return program(ctx, out, project, values.serial);
        }
    }
    out.error(`Unknown command: ${positionals.join(' ')}`);
    out.error('Run "nexysvhdl --help" for usage.');
    return EXIT.usage;
}

if (require.main === module) {
    runCli(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (err: unknown) => {
            process.stderr.write(`Internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
            process.exitCode = EXIT.failed;
        },
    );
}
