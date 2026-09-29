import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolInvocation, ToolRunResult } from '../../../core';
import type { MacosSystem } from '../../../platform/macos';
import { REPO } from '../../helpers';

/** Real openFPGALoader / openXC7 outputs recorded on the M4 Mac. */
export const MAC_FIXTURES = join(REPO, 'tests', 'platform', 'macos', 'fixtures');
export const fixture = (name: string) => readFileSync(join(MAC_FIXTURES, name), 'utf8');

export const HOME = '/Users/student';
export const APIO = '/Applications/Apio/apio';
export const OFL = `${HOME}/.apio/packages/oss-cad-suite/bin/openFPGALoader`;
export const OFL_BINARY = `${HOME}/.apio/packages/oss-cad-suite/libexec/openFPGALoader`;

/** Thin 64-bit Mach-O header for one CPU type (little-endian on disk). */
export function machO(cpu: 'arm64' | 'x86_64'): Uint8Array {
    const b = new Uint8Array(32);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0xfeedfacf, true);
    v.setUint32(4, cpu === 'arm64' ? 0x0100000c : 0x01000007, true);
    return b;
}

/** Universal (fat) header listing several CPU types (big-endian). */
export function fatMachO(cpus: ReadonlyArray<'arm64' | 'x86_64'>): Uint8Array {
    const b = new Uint8Array(8 + cpus.length * 20);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0xcafebabe, false);
    v.setUint32(4, cpus.length, false);
    cpus.forEach((c, i) => v.setUint32(8 + i * 20, c === 'arm64' ? 0x0100000c : 0x01000007, false));
    return b;
}

export const script = (body = 'exec "$0"') => new TextEncoder().encode(`#!/usr/bin/env bash\n${body}\n`);

export interface FakeFile {
    readonly text?: string;
    readonly head?: Uint8Array;
    readonly executable?: boolean;
    /** Symlink target (absolute). */
    readonly link?: string;
}

/**
 * In-memory MacosSystem: POSIX paths, no disk access. Like a default macOS
 * (APFS) volume it is case-insensitive and case-preserving: lookups ignore
 * case and realpath returns the stored spelling. Symlinks are followed.
 */
export function fakeSystem(files: Record<string, FakeFile>, env: Record<string, string | undefined> = {}, processArch = 'arm64'): MacosSystem {
    const byLower = new Map(Object.keys(files).map((k) => [k.toLowerCase(), k]));
    const resolve = (p: string, depth = 0): string | undefined => {
        const key = byLower.get(p.toLowerCase());
        if (key === undefined || depth > 8) return undefined;
        const link = files[key]!.link;
        return link === undefined ? key : resolve(link, depth + 1);
    };
    const file = (p: string) => {
        const key = resolve(p);
        return key === undefined ? undefined : files[key];
    };
    return {
        env: { PATH: '/usr/bin:/bin', ...env },
        homeDir: HOME,
        processArch,
        async isFile(p) {
            return file(p) !== undefined;
        },
        async isExecutable(p) {
            return file(p)?.executable === true;
        },
        async readText(p) {
            const f = file(p);
            return f === undefined ? undefined : (f.text ?? (f.head ? new TextDecoder().decode(f.head) : ''));
        },
        async readHead(p, bytes) {
            const f = file(p);
            if (!f) return undefined;
            return (f.head ?? new TextEncoder().encode(f.text ?? '')).subarray(0, bytes);
        },
        async realpath(p) {
            return resolve(p);
        },
        async fileId(p) {
            const key = resolve(p);
            return key === undefined ? undefined : `fake:${key}`;
        },
    };
}

/** The validated macOS install, as files. */
export function validatedMacFiles(overrides: Record<string, FakeFile> = {}): Record<string, FakeFile> {
    const pkgs = `${HOME}/.apio/packages`;
    return {
        [APIO]: { head: machO('arm64'), executable: true },
        [OFL]: { head: script(), executable: true },
        [OFL_BINARY]: { head: machO('arm64'), executable: true },
        [`${HOME}/Library/Application Support/NexysVHDL/tools/ghdl/bin/ghdl`]: { head: machO('arm64'), executable: true },
        [`${pkgs}/openxc7/BUILD-INFO.json`]: { text: fixture('openxc7-BUILD-INFO.json') },
        [`${pkgs}/openxc7/XILINX-PARTS-INDEX.json`]: { text: '{ "schema": 7, "release-tag": "2026-09-25" }' },
        [`${pkgs}/installed_packages.json`]: { text: fixture('apio-installed_packages.json') },
        ...overrides,
    };
}

export type Reply = Partial<Omit<ToolRunResult, 'invocation'>>;

/** Answers invocations by `<basename> <args...>` prefix, like a scripted terminal. */
export function scriptedRunner(replies: Array<[match: (inv: ToolInvocation) => boolean, reply: Reply]>) {
    const calls: ToolInvocation[] = [];
    return {
        calls,
        async run(invocation: ToolInvocation): Promise<ToolRunResult> {
            calls.push(invocation);
            const hit = replies.find(([m]) => m(invocation));
            const reply: Reply = hit ? hit[1] : { outcome: 'spawn-failed', errorMessage: 'ENOENT' };
            return { invocation, outcome: 'exited', exitCode: 0, stdout: '', stderr: '', durationMs: 1, ...reply, ...(reply.outcome === 'spawn-failed' ? { exitCode: null } : {}) };
        },
    };
}

export const argsInclude = (...parts: string[]) => (inv: ToolInvocation) => parts.every((p) => inv.args.includes(p));
