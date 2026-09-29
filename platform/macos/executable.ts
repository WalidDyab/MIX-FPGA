import { posix } from 'node:path';
import type { MacosSystem } from './system';

/** What a file on disk turned out to be. */
export interface ExecutableHeader {
    readonly kind: 'mach-o' | 'script' | 'other';
    /** Mach-O CPU architectures (`arm64`, `x86_64`, ...); several for a universal binary. */
    readonly architectures: readonly string[];
    /** `#!` line of a script, without the `#!`. */
    readonly interpreter?: string;
}

export type ArchitectureStatus = 'native' | 'x86_64-only' | 'unknown';

/** Architecture verdict for a located tool. */
export interface ArchitectureReport {
    /** The file that was invoked. */
    readonly path: string;
    /** The Mach-O file actually inspected (the wrapper's target for script wrappers). */
    readonly binary?: string;
    readonly architectures: readonly string[];
    readonly status: ArchitectureStatus;
}

const CPU_TYPES: ReadonlyMap<number, string> = new Map([
    [0x0100000c, 'arm64'],
    [0x01000007, 'x86_64'],
    [0x0000000c, 'arm'],
    [0x00000007, 'i386'],
]);

const cpuName = (cpu: number) => CPU_TYPES.get(cpu) ?? `cpu-0x${cpu.toString(16)}`;

/** Parses the start of a file: thin/universal Mach-O or a `#!` script. Pure. */
export function parseExecutableHeader(head: Uint8Array): ExecutableHeader {
    if (head.length < 8) return { kind: 'other', architectures: [] };
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const magicBE = view.getUint32(0, false);

    // Thin Mach-O, little-endian on disk (0xFEEDFACF 64-bit, 0xFEEDFACE 32-bit).
    if (magicBE === 0xcffaedfe || magicBE === 0xcefaedfe) {
        return { kind: 'mach-o', architectures: [cpuName(view.getUint32(4, true))] };
    }
    // Universal binary, big-endian (0xCAFEBABE 32-bit entries, 0xCAFEBABF 64-bit entries).
    if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
        const count = view.getUint32(4, false);
        const entrySize = magicBE === 0xcafebabe ? 20 : 32;
        // Java class files share 0xCAFEBABE; a real fat header has a small arch count.
        if (count > 0 && count < 16) {
            const architectures: string[] = [];
            for (let i = 0; i < count; i++) {
                const offset = 8 + i * entrySize;
                if (offset + 4 > head.length) break;
                architectures.push(cpuName(view.getUint32(offset, false)));
            }
            return { kind: 'mach-o', architectures };
        }
    }
    if (head[0] === 0x23 && head[1] === 0x21) {
        const text = new TextDecoder('latin1').decode(head);
        return { kind: 'script', architectures: [], interpreter: text.slice(2).split('\n')[0]!.trim() };
    }
    return { kind: 'other', architectures: [] };
}

export function architectureStatus(architectures: readonly string[], nativeArch = 'arm64'): ArchitectureStatus {
    if (architectures.includes(nativeArch)) return 'native';
    if (architectures.includes('x86_64')) return 'x86_64-only';
    return 'unknown';
}

const HEADER_BYTES = 4096;

/**
 * Determines which CPU a tool will run on without executing it.
 * Apio's oss-cad-suite and openXC7 packages ship `bin/<tool>` as a bash
 * wrapper that execs `libexec/<tool>`; for those the wrapped binary is inspected.
 */
export async function inspectArchitecture(system: MacosSystem, path: string): Promise<ArchitectureReport> {
    const head = await system.readHead(path, HEADER_BYTES);
    const header = head ? parseExecutableHeader(head) : undefined;
    if (header?.kind === 'mach-o') {
        return { path, binary: path, architectures: header.architectures, status: architectureStatus(header.architectures) };
    }
    if (header?.kind === 'script') {
        const wrapped = posix.join(posix.dirname(path), '..', 'libexec', posix.basename(path));
        const inner = await system.readHead(wrapped, HEADER_BYTES);
        const innerHeader = inner ? parseExecutableHeader(inner) : undefined;
        if (innerHeader?.kind === 'mach-o') {
            return { path, binary: wrapped, architectures: innerHeader.architectures, status: architectureStatus(innerHeader.architectures) };
        }
    }
    return { path, architectures: [], status: 'unknown' };
}
