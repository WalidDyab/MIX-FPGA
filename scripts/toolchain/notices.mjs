// Renders toolchain/<target>/THIRD_PARTY_NOTICES.md from the generated toolchain manifest.
//
// Two formats: a recipe with `compliance` (win32-x64 since the Toolchain 1.0
// redistribution review) gets the compliance format; a recipe without it keeps
// the original format byte for byte, so an already validated toolchain (the
// macOS Toolchain 1.0) still assembles to identical content.

const mib = (bytes) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;

export function renderNotices(manifest) {
    if (manifest.modifications) return renderModifiedNotices(manifest);
    return manifest.compliance ? renderComplianceNotices(manifest) : renderOriginalNotices(manifest);
}

const collapse = (lines) => `${lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')}\n`;

function renderOriginalNotices(manifest) {
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
    lines.push(...programmerSection(manifest));
    return collapse(lines);
}

function programmerSection(manifest) {
    if (manifest.programmer?.kind === 'bundled') {
        return ['## Board programmer', '', `${manifest.programmer.name} ${manifest.programmer.testedVersion ?? ''} is included in this bundle. ${manifest.programmer.reason ?? ''}`.trim(), ''];
    }
    if (manifest.programmer?.kind === 'system') {
        return ['## Not included: board programmer', '', `${manifest.programmer.name} is not part of this bundle. ${manifest.programmer.reason} Install guide: ${manifest.programmer.installGuide}`, ''];
    }
    return [];
}

function renderComplianceNotices(manifest) {
    const k = manifest.compliance;
    const shipped = manifest.components.filter((c) => !c.placeholder);
    const placeholders = manifest.components.filter((c) => c.placeholder);
    const lines = [
        `# Third-party software in the NexysVHDL FPGA toolchain (${manifest.displayPlatform})`,
        '',
        `NexysVHDL Toolchain ${manifest.bundleVersion} for ${manifest.target}. NexysVHDL runs these programs privately from this folder; it does not install them on the computer, add them to PATH or change any other installation.`,
        '',
        '## Licensing of this toolchain',
        '',
        `This toolchain is an aggregation of separate programs and data, each distributed under its own license, listed below. It is **not** licensed under the NexysVHDL license. NexysVHDL itself is licensed under the Apache License 2.0 (${k.nexysvhdl}); that license covers only NexysVHDL's own code and the files NexysVHDL generates in this folder (\`toolchain-manifest.json\`, this file, the pinned Apio configuration, the shims and the placeholder notes).`,
        '',
        'Each component is redistributed unmodified from the official release archive listed below (verified by SHA-256 when the toolchain was assembled). NexysVHDL does not modify, patch or rebuild any third-party program. License texts are in the files listed for each component, relative to this folder; `licenses/` holds texts for components whose archives ship none.',
        '',
        '## Source code',
        '',
        `Several components are licensed under the GNU GPL, the GNU LGPL or other licenses that require source code to be available. The source code of those components, at the exact revisions these binaries were built from, is published by NexysVHDL as **${k.sourcePackage}**, next to every NexysVHDL release that includes this toolchain. Its \`manifest.json\` lists each source archive with its SHA-256 and the upstream repository and revision it was taken from.`,
        '',
        'If you redistribute this toolchain (for example to a classroom), redistribute the source package with it, unchanged.',
        '',
        `The complete inventory (every bundled program, library and Python package, with its license and source) is the compliance manifest \`${k.manifest}\` in the NexysVHDL repository at the release tag; the source package includes a copy. Items that manifest lists under "unresolved" are still under review.`,
        '',
        '## Components',
        '',
    ];
    for (const c of shipped) {
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
            `- Upstream source: ${c.sourceCode}`,
            `- Redistributed archive: ${c.archive.url} (SHA-256 \`${c.archive.sha256}\`)`,
            '',
        );
    }
    if (placeholders.length) {
        lines.push(
            '## Not included: unused Apio packages',
            '',
            'Apio requires these packages to be present before it runs any command, but NexysVHDL never uses them. Their folders are empty placeholders holding only a `NEXYSVHDL-PLACEHOLDER.txt` note; none of their content is redistributed.',
            '',
        );
        for (const c of placeholders) {
            const a = c.notRedistributed?.archive;
            lines.push(`### ${c.name} — not included`, '', `- Folder: \`${c.path}\` (placeholder)`, `- Why: ${c.placeholder.reason}`, ...(a ? [`- Upstream package (not redistributed): ${a.url}`] : []), '');
        }
    }
    lines.push(...programmerSection(manifest));
    return collapse(lines);
}

/**
 * Toolchain 1.1 and later: the components are the official upstream archives with the deliberate omissions and
 * regenerations recorded in `manifest.modifications`. Says exactly what changed, ships the source with the binaries
 * (no written offer) and keeps legal conclusions that still need counsel marked.
 */
function renderModifiedNotices(manifest) {
    const k = manifest.compliance ?? {};
    const prod = k.productName ?? 'MIX-FPGA';
    const shipped = manifest.components.filter((c) => !c.placeholder);
    const lines = [
        `# Third-party software in the ${prod} Nexys A7 support (${manifest.displayPlatform})`,
        '',
        ...(k.status ? [`**Status: ${k.status}.**`, ''] : []),
        `${prod} toolchain ${manifest.bundleVersion} for ${manifest.target}. ${prod} runs these programs privately from this folder; it does not install them on the computer, add them to PATH or change any other installation.`,
        '',
        '## Licensing of this toolchain',
        '',
        `This toolchain is an aggregation of separate programs and data, each distributed under its own license, listed below. It is **not** licensed under the ${prod} license. ${prod} itself is licensed under the Apache License 2.0 (${k.nexysvhdl}); that license covers only ${prod}'s own code and the files ${prod} generates in this folder (\`toolchain-manifest.json\`, this file, the pinned Apio configuration).`,
        '',
        '## What was changed',
        '',
        `Every component is the official release archive listed below, verified by SHA-256 when the toolchain was assembled. ${prod} patches and rebuilds no third-party program. The only changes are the omissions and regenerations below, made for licensing reasons:`,
        '',
    ];
    for (const m of manifest.modifications) {
        lines.push(`- **${m.component}** (\`${m.path}\`), ${m.kind}: ${m.reason}. ${m.removedFiles} files removed${m.added ? `, ${m.added.length} added` : ''}${m.regenerated ? `; regenerated: ${m.regenerated.map((f) => `\`${f}\``).join(', ')}` : ''}. The complete list is in \`toolchain-manifest.json\`.`);
    }
    lines.push(
        '',
        `${prod} always runs GHDL with \`--std=08\`. The omitted packages are not needed for that: a design that uses \`ieee.vital_timing\`, \`ieee.vital_primitives\`, \`ieee.vital_memory\`, \`upf\` or the VHDL-87/93 \`ieee\` library gets a normal "unit not found" error.`,
        '',
        '## Source code',
        '',
        `The source code of every component whose license requires it (GNU GPL, GNU LGPL, MPL, EPL, EUPL), at the exact revisions these binaries were built from, is the **${k.sourcePackage}** that is distributed together with this toolchain, at the same place and time. Its \`manifest.json\` lists each source archive with its SHA-256 and the upstream repository and revision, and maps every shipped binary to its source. If you redistribute this toolchain (for example to a classroom), redistribute that package with it, unchanged.`,
        '',
        `The inventory of every bundled program, library and Python package, with its license and source, is the compliance manifest \`${k.manifest}\`; the source package includes a copy. Items it lists under "unresolved" are still under review.`,
        '',
        '## Your right to modify and replace components',
        '',
        'The GPL and LGPL components are separate files, loaded at run time, which you may replace with your own builds made from the corresponding source, for your own use, and reverse-engineer for debugging. The installed folder is read-only by default; make a file writable, replace it, and on Apple silicon re-sign it (`codesign -f -s - <file>`). The tools keep working with replaced files. The Setup page and Verify report a changed file as "changed", and Repair puts the original back only when you choose Repair. The integrity check is a support aid, not a technical restriction. A configuration with replaced files is not supported.',
        '',
        '## Components',
        '',
    );
    for (const c of shipped) {
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
            `- Upstream source: ${c.sourceCode}`,
            `- Redistributed archive: ${c.archive.url} (SHA-256 \`${c.archive.sha256}\`)`,
            '',
        );
    }
    lines.push('## Not included', '', 'Digilent Adept Runtime, Adept Utilities and drivers (not needed on macOS: the board programmer in this toolchain talks to the board over USB), Vivado and other Xilinx/AMD software, Apple Xcode and Command Line Tools.', '');
    lines.push(...programmerSection(manifest));
    return collapse(lines);
}
