// Phase 5H diagnosis: how fast does this JavaScript runtime hash a big file? (plain Node vs Visual Studio Code's Electron-as-Node)
//   node scripts/validation/p5h-hash-speed.cjs <file>
const { createHash } = require('node:crypto');
const { createReadStream, statSync } = require('node:fs');
const file = process.argv[2];
const t0 = Date.now();
const h = createHash('sha256');
createReadStream(file, { highWaterMark: 1 << 20 })
    .on('data', (c) => h.update(c))
    .on('end', () => {
        const s = (Date.now() - t0) / 1000;
        const mb = statSync(file).size / 1e6;
        console.log(`${process.versions.electron ? 'electron ' + process.versions.electron : 'node ' + process.versions.node}: ${mb.toFixed(0)} MB in ${s.toFixed(1)} s = ${(mb / s).toFixed(0)} MB/s, sha256 ${h.digest('hex').slice(0, 12)}`);
    });
