// Renders toolchain/<target>/THIRD_PARTY_NOTICES.md from the generated toolchain manifest.

const mib = (bytes) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;

export function renderNotices(manifest) {
    const lines = [
        `# Third-party software in the NexysVHDL FPGA toolchain (${manifest.displayPlatform})`,
        '',
        `NexysVHDL toolchain bundle ${manifest.bundleVersion} for ${manifest.target}. NexysVHDL runs these programs privately from this folder; it does not install them on the computer, add them to PATH or change any other installation.`,
        '',
        'Each component is redistributed unmodified from the official release archive listed below (verified by SHA-256 when the bundle was assembled). The license of each component is the license chosen by its authors; license texts are in the files listed for each component, relative to this folder.',
        '',
        '## Source code',
        '',
        'Several components are licensed under the GNU GPL or LGPL. Their complete source code is available from the upstream projects at the exact versions listed under "Source". The NexysVHDL release process must also make the corresponding source available alongside each NexysVHDL package that redistributes these binaries (see docs/phase4b-classroom-bundle.md, "License audit").',
        '',
        '## Components',
        '',
    ];
    for (const c of manifest.components) {
        lines.push(
            `### ${c.name} — ${c.version}`,
            '',
            c.description ? `${c.description}.` : '',
            '',
            `- Folder: \`${c.path}\` (${c.content.files} files, ${mib(c.content.bytes)})`,
            `- License: ${c.license}`,
            `- License evidence: ${c.licenseEvidence}`,
            `- License texts: ${c.licenseFiles.length ? c.licenseFiles.map((f) => `\`${f}\``).join(', ') : 'see license evidence'}`,
            `- Project: ${c.homepage}`,
            `- Source: ${c.sourceCode}`,
            `- Redistributed archive: ${c.archive.url} (SHA-256 \`${c.archive.sha256}\`)`,
            '',
        );
    }
    if (manifest.programmer?.kind === 'system') {
        lines.push(
            '## Not included: board programmer',
            '',
            `${manifest.programmer.name} is not part of this bundle. ${manifest.programmer.reason} Install guide: ${manifest.programmer.installGuide}`,
            '',
        );
    }
    return `${lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')}\n`;
}
