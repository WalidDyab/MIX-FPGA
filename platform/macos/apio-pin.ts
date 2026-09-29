import { posix } from 'node:path';
import { type Diagnostic, errorDiag, type ToolInvocation, type ToolRunner, type ToolRunResult } from '../../core';
import type { MacosSystem } from './system';

/** Apio's documented variable selecting its remote (package) config. */
export const APIO_REMOTE_CONFIG_ENV = 'APIO_REMOTE_CONFIG_URL';

/** File name template Apio expands with its own version, e.g. apio-1.7.x.jsonc. */
export const APIO_CONFIG_TEMPLATE = 'apio-{major}.{minor}.x.jsonc';

/** Folder holding the tracked pinned configs (toolchains/apio-remote-config). */
export function pinnedConfigDir(toolchainsDir: string): string {
    return posix.join(toolchainsDir, 'apio-remote-config');
}

/**
 * `file://` URL for APIO_REMOTE_CONFIG_URL.
 *
 * Apio 1.7.0 treats the text after `file://` as a literal path and does not
 * percent-decode it (verified: a path with a space works raw and fails as %20),
 * so the path is inserted verbatim rather than URL-encoded.
 */
export function apioRemoteConfigUrl(configDir: string): string {
    if (!configDir.startsWith('/')) throw new Error(`Pinned Apio config folder must be an absolute path: ${configDir}`);
    if (/[{}\n\r]/.test(configDir)) throw new Error(`Pinned Apio config folder contains characters Apio cannot use in a URL template: ${configDir}`);
    return `file://${posix.join(configDir, APIO_CONFIG_TEMPLATE)}`;
}

/** The file Apio will read for a given Apio version (`1.7.0` -> apio-1.7.x.jsonc). */
export function pinnedConfigFile(configDir: string, apioVersion: string): string | undefined {
    const m = /^(\d+)\.(\d+)\./.exec(apioVersion);
    return m ? posix.join(configDir, `apio-${m[1]}.${m[2]}.x.jsonc`) : undefined;
}

/** Removes // and /* *\/ comments outside strings (Apio configs are JSONC). */
export function stripJsonComments(text: string): string {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (inString) {
            out += c;
            if (c === '\\') out += text[++i] ?? '';
            else if (c === '"') inString = false;
        } else if (c === '"') {
            inString = true;
            out += c;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
        } else if (c === '/' && text[i + 1] === '*') {
            i = text.indexOf('*/', i + 2);
            if (i < 0) break;
            i++;
        } else {
            out += c;
        }
    }
    return out;
}

/** Release tags pinned per package, e.g. { openxc7: '2026-09-25', ... }. */
export function parsePinnedTags(jsonc: string): Record<string, string> {
    const data = JSON.parse(stripJsonComments(jsonc)) as { packages?: Record<string, { release?: { tag?: unknown } }> };
    const tags: Record<string, string> = {};
    for (const [name, pkg] of Object.entries(data.packages ?? {})) {
        if (typeof pkg?.release?.tag === 'string') tags[name] = pkg.release.tag;
    }
    return tags;
}

export interface ApioPinStatus {
    readonly configDir: string;
    /** Environment to give every Apio invocation; absent if the pin cannot be used. */
    readonly env?: Readonly<Record<string, string>>;
    /** The config file Apio will read (known once the Apio version is known). */
    readonly file?: string;
    readonly tags: Readonly<Record<string, string>>;
    readonly diagnostics: readonly Diagnostic[];
}

/**
 * Checks that the tracked pin exists for this Apio version and builds the
 * environment override. Missing or unreadable pin = error: running Apio
 * without it lets Apio reinstall the incompatible upstream openXC7 package.
 */
export async function checkApioPin(system: MacosSystem, configDir: string, apioVersion?: string): Promise<ApioPinStatus> {
    const fail = (code: string, message: string, extra: Partial<ApioPinStatus> = {}): ApioPinStatus => ({
        configDir, tags: {}, diagnostics: [errorDiag('toolchain', code, message)], ...extra,
    });
    let url: string;
    try {
        url = apioRemoteConfigUrl(configDir);
    } catch (err) {
        return fail('MACOS_APIO_PIN_PATH_INVALID', (err as Error).message);
    }
    const env = { [APIO_REMOTE_CONFIG_ENV]: url };
    if (apioVersion === undefined) return { configDir, env, tags: {}, diagnostics: [] };

    const file = pinnedConfigFile(configDir, apioVersion);
    if (!file) return fail('MACOS_APIO_PIN_MISSING', `Cannot derive the pinned Apio config name from Apio version "${apioVersion}".`);
    const text = await system.readText(file);
    if (text === undefined) {
        return fail('MACOS_APIO_PIN_MISSING', `No pinned Apio config for Apio ${apioVersion}: ${file} is missing. Apio would fall back to the upstream package list.`, { file });
    }
    try {
        return { configDir, env, file, tags: parsePinnedTags(text), diagnostics: [] };
    } catch (err) {
        return fail('MACOS_APIO_PIN_INVALID', `${file} is not a valid Apio remote config: ${(err as Error).message}`, { file });
    }
}

/** True for invocations of Apio (matched by the executable's file name). */
export function isApioInvocation(invocation: ToolInvocation): boolean {
    return posix.basename(invocation.executable) === 'apio';
}

/**
 * ToolRunner decorator: every Apio invocation gets the pinned
 * APIO_REMOTE_CONFIG_URL (overriding any inherited value). Other tools run
 * unchanged. This is how the pin reaches the shared ApioImplementationProvider
 * and the shared ToolDetector's `apio raw` probes without touching the core.
 */
export class PinnedApioRunner implements ToolRunner {
    constructor(
        private readonly inner: ToolRunner,
        private readonly pinEnv: Readonly<Record<string, string>>,
    ) {}

    run(invocation: ToolInvocation): Promise<ToolRunResult> {
        if (!isApioInvocation(invocation)) return this.inner.run(invocation);
        if (!this.pinEnv[APIO_REMOTE_CONFIG_ENV]) {
            // Never let Apio run unpinned: it would follow upstream and may replace packages.
            return Promise.resolve({
                invocation, outcome: 'spawn-failed', exitCode: null, stdout: '', stderr: '', durationMs: 0,
                errorMessage: `refused to run Apio without ${APIO_REMOTE_CONFIG_ENV} (pinned Apio config unavailable)`,
            });
        }
        return this.inner.run({ ...invocation, env: { ...(invocation.env ?? {}), ...this.pinEnv } });
    }
}
