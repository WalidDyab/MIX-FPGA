import type {
    CompatibilityStatus,
    DetectedTool,
    ToolCompatibility,
    ToolExpectation,
    ToolId,
    ToolVersionInfo,
    ToolchainManifest,
} from './types';

/**
 * Compares one expectation with one detection result. Pure.
 *
 * - missing:      the tool was looked for and not found
 * - unknown:      not looked for, version unreadable, or nothing tested to compare with
 * - compatible:   detected version equals a tested version
 * - incompatible: detected version differs from every tested version
 */
export function evaluateCompatibility(
    tool: ToolId,
    expected: ToolExpectation | undefined,
    detected: DetectedTool | undefined,
): ToolCompatibility {
    const result = (status: CompatibilityStatus, reason: string): ToolCompatibility => ({
        tool,
        status,
        reason,
        ...(expected ? { expected } : {}),
        ...(detected ? { detected } : {}),
    });

    if (!detected) return result('unknown', 'not checked');
    if (!detected.found) return result('missing', `not found (${detected.method})`);
    if (detected.version === undefined) return result('unknown', 'found, but its version could not be determined');
    if (!expected || expected.testedVersions.length === 0) return result('unknown', 'no tested version recorded');
    if (expected.testedVersions.includes(detected.version)) return result('compatible', `matches tested ${detected.version}`);
    return result('incompatible', `${detected.version} is not a tested version (${expected.testedVersions.join(', ')})`);
}

export function expectationFor(manifest: ToolchainManifest | undefined, tool: ToolId): ToolExpectation | undefined {
    return manifest?.tools.find((t) => t.tool === tool);
}

export function toVersionInfo(c: ToolCompatibility): ToolVersionInfo {
    return {
        tool: c.tool,
        expected: c.expected?.testedVersions ?? [],
        status: c.status,
        ...(c.detected?.version !== undefined ? { detected: c.detected.version } : {}),
    };
}

/** Evaluates every tool; the overall status is the worst individual status. */
export function evaluateToolchain(
    manifest: ToolchainManifest | undefined,
    detected: ReadonlyMap<ToolId, DetectedTool>,
    tools: readonly ToolId[],
): { readonly overall: CompatibilityStatus; readonly tools: readonly ToolCompatibility[] } {
    const results = tools.map((t) => evaluateCompatibility(t, expectationFor(manifest, t), detected.get(t)));
    const rank: Record<CompatibilityStatus, number> = { compatible: 0, unknown: 1, incompatible: 2, missing: 3 };
    const overall = results.reduce<CompatibilityStatus>((worst, r) => (rank[r.status] > rank[worst] ? r.status : worst), 'compatible');
    return { overall, tools: results };
}
