#!/usr/bin/env node
// Evidence inventory of an assembled (or extracted) toolchain folder, for the
// Toolchain 1.0 compliance audit. Build time only; never shipped.
//
//   node scripts/compliance/inventory.mjs <toolchain folder> [--out inventory.json]
//
// Reports, from the files themselves (never from memory):
//  - every license/copying/notice file, with the licenses its text identifies;
//  - oss-cad-suite license/LICENSE.* entries: upstream source (git URL + exact
//    revision) and the licenses identified in the text;
//  - Python *.dist-info / *.egg-info metadata (name, version, license fields);
//  - native libraries (.dll, .dylib, .so, .framework) with their location.
import { readFileSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { parseArgs } from '../toolchain/lib.mjs';

/** License identification by the license text itself (first match per family; several may apply). */
const SIGNATURES = [
    ['AGPL-3.0', /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i],
    ['LGPL-3.0', /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i],
    ['LGPL-2.1', /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/i],
    ['LGPL-2.0', /GNU LIBRARY GENERAL PUBLIC LICENSE\s+Version 2|GNU Library General Public License version 2/i],
    ['GPL-3.0', /GNU GENERAL PUBLIC LICENSE\s+Version 3/i],
    ['GPL-2.0', /GNU GENERAL PUBLIC LICENSE\s+Version 2/i],
    ['GCC-exception-3.1', /GCC RUNTIME LIBRARY EXCEPTION/i],
    ['LLVM-exception', /LLVM Exceptions to the Apache 2\.0 License/i],
    ['Apache-2.0', /Apache License,?\s+Version 2\.0/i],
    ['MPL-2.0', /Mozilla Public License,? (Version|v\.?) ?2\.0/i],
    ['MPL-1.1', /MOZILLA PUBLIC LICENSE\s+Version 1\.1/i],
    ['EPL-2.0', /Eclipse Public License - v 2\.0/i],
    ['EPL-1.0', /Eclipse Public License - v 1\.0/i],
    ['EUPL-1.2', /EUROPEAN UNION PUBLIC LICEN[CS]E v\. ?1\.2/i],
    ['CDDL-1.0', /COMMON DEVELOPMENT AND DISTRIBUTION LICENSE/i],
    ['PSF-2.0', /PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2/i],
    ['BSL-1.0', /Boost Software License - Version 1\.0/i],
    ['CC0-1.0', /CC0 1\.0 Universal|Creative Commons Legal Code\s+CC0/i],
    ['Artistic-2.0', /The Artistic License 2\.0/i],
    ['Unlicense', /This is free and unencumbered software released into the public domain/i],
    ['ISC', /ISC License|Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i],
    ['MIT', /MIT License|Permission is hereby granted, free of charge, to any person obtaining a copy/i],
    // UC Berkeley-style notice (ABC, AVY): permissive, keep the copyright and notice.
    ['LicenseRef-Berkeley-permissive', /Permission is hereby granted, without written agreement and without license or royalty fees/i],
    ['BSD-3-Clause', /Neither the name of .{0,200}?(may|nor the names)|names of (its|their) contributors may (not )?be used to endorse/i],
    ['BSD-2-Clause', /Redistribution and use in source and binary forms, with or without modification, are permitted/i],
    ['Zlib', /This software is provided 'as-is', without any express or implied\s+warranty/i],
    ['OpenSSL', /OpenSSL License|This product includes software developed by the OpenSSL Project/i],
    ['curl', /COPYRIGHT AND PERMISSION NOTICE\s+Copyright \(c\) .{0,40}Daniel Stenberg/is],
    ['Qt-LGPL-exception-1.1', /The Qt Company Qt LGPL Exception version 1\.1/i],
];

export function identifyLicenses(text) {
    // Line wrapping differs between copies of the same license: match on collapsed whitespace.
    const flat = text.replace(/\s+/g, ' ');
    const found = SIGNATURES.filter(([, re]) => re.test(flat)).map(([id]) => id);
    // A BSD-3 text also matches the BSD-2 phrase; keep the more specific one.
    return found.includes('BSD-3-Clause') ? found.filter((f) => f !== 'BSD-2-Clause') : found;
}

const LICENSE_NAME = /^(licen[cs]e|copying|notice|copyright|unlicense|authors?)([._-].*)?$/i;

/** Parses an oss-cad-suite license/LICENSE.<name> file. */
export function parseOssCadSuiteLicense(name, text) {
    const sources = [];
    const block = text.split(/Build is based on folowing sources:/i)[1]?.split(/Software is under following license/i)[0] ?? '';
    for (const m of block.matchAll(/^(git|svn|hg|wget|curl|tar|archive|file)\s+(\S+)(?:\s+checkout revision\s+([0-9a-f]{7,40}))?/gim)) {
        sources.push({ kind: m[1].toLowerCase(), url: m[2], ...(m[3] ? { revision: m[3] } : {}) });
    }
    const embeds = /embeds '([^']+)'/.exec(text)?.[1];
    const usesPackages = /built using packages: (.+)$/m.exec(text)?.[1]?.split(/[ ,']+/).filter(Boolean) ?? [];
    const licenseText = text.split(/Software is under following license :\s*=*\s*/i)[1] ?? text;
    return { name, embeds: embeds ?? name, sources, builtWith: usesPackages, licenses: identifyLicenses(licenseText) };
}

function readMetadata(text) {
    const field = (k) => [...text.matchAll(new RegExp(`^${k}: (.*)$`, 'gim'))].map((m) => m[1].trim());
    return {
        name: field('Name')[0],
        version: field('Version')[0],
        license: field('License')[0],
        licenseExpression: field('License-Expression')[0],
        licenseFiles: field('License-File'),
        classifiers: field('Classifier').filter((c) => c.startsWith('License ::')),
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const root = args._[0];
    if (!root) {
        console.error('usage: inventory.mjs <toolchain folder> [--out file.json]');
        process.exit(2);
    }
    const licenseFiles = [];
    const ossCadSuite = [];
    const pythonPackages = [];
    const nativeLibraries = [];
    const frameworks = new Set();
    let files = 0;
    for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
        const full = join(e.parentPath, e.name);
        const rel = relative(root, full).split(sep).join('/');
        if (e.isDirectory()) {
            if (e.name.endsWith('.framework')) frameworks.add(rel);
            if (/\.(dist|egg)-info$/.test(e.name)) {
                for (const m of ['METADATA', 'PKG-INFO']) {
                    try {
                        pythonPackages.push({ path: rel, ...readMetadata(readFileSync(join(full, m), 'utf8')) });
                        break;
                    } catch {
                        /* try the next metadata file name */
                    }
                }
            }
            continue;
        }
        if (!e.isFile()) continue;
        files++;
        // The oss-cad-suite package keeps one license/LICENSE.<tool> per embedded tool.
        if (/(^|\/)license\/LICENSE\.[^/]+$/.test(rel)) {
            ossCadSuite.push({ file: rel, ...parseOssCadSuiteLicense(e.name.slice('LICENSE.'.length), readFileSync(full, 'latin1')) });
            continue;
        }
        if (LICENSE_NAME.test(e.name) && (await stat(full)).size < 2_000_000) {
            licenseFiles.push({ path: rel, licenses: identifyLicenses(readFileSync(full, 'latin1')) });
        }
        if (/\.(dll|dylib|pyd)$|\.so(\.\d+)*$/i.test(e.name)) nativeLibraries.push(rel);
    }
    const out = {
        root: basename(root),
        files,
        licenseFiles: licenseFiles.sort((a, b) => a.path.localeCompare(b.path)),
        ossCadSuite: ossCadSuite.sort((a, b) => a.name.localeCompare(b.name)),
        pythonPackages: pythonPackages.sort((a, b) => a.path.localeCompare(b.path)),
        frameworks: [...frameworks].sort(),
        nativeLibraries: nativeLibraries.sort(),
    };
    if (args.out) writeFileSync(args.out, `${JSON.stringify(out, null, 1)}\n`);
    else console.log(JSON.stringify(out, null, 1));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).join('/').split('/').pop())) await main();
