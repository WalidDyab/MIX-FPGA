"""Reads an RPM database (rpmdb.sqlite, Fedora 33+) and prints, as JSON, every
installed package that owns a file matching a path prefix: name, epoch,
version, release, arch, source RPM, license, URL, build time and the per-file
SHA-256 digests the package header records. Build-time compliance evidence
only (never shipped); reads the database, never runs rpm.

    python scripts/compliance/rpmdb-files.py <rpmdb.sqlite> <path prefix> [out.json]
"""
import json
import sqlite3
import struct
import sys

TAGS = {1000: 'name', 1001: 'version', 1002: 'release', 1003: 'epoch', 1006: 'buildtime', 1007: 'buildhost', 1011: 'vendor',
        1014: 'license', 1020: 'url', 1022: 'arch', 1044: 'sourcerpm', 1035: 'filedigests', 1116: 'dirindexes', 1117: 'basenames',
        1118: 'dirnames', 5011: 'filedigestalgo', 273: 'sha256header', 5092: 'payloaddigest'}


def header(blob):
    il, dl = struct.unpack('>ii', blob[:8])
    store = 8 + 16 * il
    out = {}
    for i in range(il):
        tag, typ, off, cnt = struct.unpack('>iiii', blob[8 + 16 * i:24 + 16 * i])
        if tag not in TAGS:
            continue
        p = store + off
        if typ in (6, 9):  # STRING, I18NSTRING
            val = blob[p:blob.index(b'\0', p)].decode('utf-8', 'replace')
        elif typ == 8:  # STRING_ARRAY
            val = []
            for _ in range(cnt):
                e = blob.index(b'\0', p)
                val.append(blob[p:e].decode('utf-8', 'replace'))
                p = e + 1
        elif typ == 4:  # INT32
            val = list(struct.unpack('>%di' % cnt, blob[p:p + 4 * cnt]))
            val = val[0] if cnt == 1 and TAGS[tag] not in ('dirindexes',) else val
        else:
            continue
        out[TAGS[tag]] = val
    return out


def main():
    db, prefix = sys.argv[1], sys.argv[2]
    con = sqlite3.connect('file:%s?mode=ro&immutable=1' % db.replace('\\', '/'), uri=True)
    pkgs = []
    for (blob,) in con.execute('select blob from Packages'):
        h = header(bytes(blob))
        names = h.get('basenames') or []
        if isinstance(names, str):
            names = [names]
        dirs = h.get('dirnames') or []
        idx = h.get('dirindexes') or []
        if isinstance(idx, int):
            idx = [idx]
        digests = h.get('filedigests') or []
        if isinstance(digests, str):
            digests = [digests]
        files = []
        for i, b in enumerate(names):
            path = dirs[idx[i]] + b
            if path.startswith(prefix):
                files.append({'path': path, 'sha256': digests[i] if i < len(digests) else ''})
        if not files:
            continue
        pkgs.append({k: h.get(k) for k in ('name', 'epoch', 'version', 'release', 'arch', 'sourcerpm', 'license', 'url', 'buildtime', 'buildhost', 'vendor', 'filedigestalgo', 'sha256header', 'payloaddigest')} | {'files': files})
    pkgs.sort(key=lambda p: p['name'])
    text = json.dumps(pkgs, indent=1)
    if len(sys.argv) > 3:
        open(sys.argv[3], 'w', encoding='utf-8').write(text + '\n')
    else:
        print(text)


main()
