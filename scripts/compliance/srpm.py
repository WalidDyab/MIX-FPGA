"""Source-RPM evidence for the compliance review (build time only; never shipped).

    python scripts/compliance/srpm.py verify <file.src.rpm>...            -> JSON per SRPM
    python scripts/compliance/srpm.py extract <file.src.rpm> <tarball-member> <path-in-tarball> <out>

verify: name/version/release from the main header; the main header's SHA-256
equals the signature header's RPMSIGTAG_SHA256 (tag 273) and the payload's
SHA-256 equals RPMTAG_PAYLOADDIGEST (tag 5092); lists the cpio members (spec,
patches, upstream tarballs) with sizes and SHA-256.
extract: one file from an upstream tarball inside the SRPM (e.g. its COPYING).
"""
import gzip
import hashlib
import io
import json
import lzma
import struct
import sys
import tarfile

try:
    from compression import zstd  # Python 3.14+
except ImportError:  # pragma: no cover
    zstd = None


def read_header(buf, off):
    if buf[off:off + 3] != b'\x8e\xad\xe8':
        raise ValueError('bad header magic at %d' % off)
    il, dl = struct.unpack('>ii', buf[off + 8:off + 16])
    end = off + 16 + 16 * il + dl
    store = off + 16 + 16 * il
    tags = {}
    for i in range(il):
        tag, typ, o, cnt = struct.unpack('>iiii', buf[off + 16 + 16 * i:off + 32 + 16 * i])
        p = store + o
        if typ in (6, 9):
            tags[tag] = buf[p:buf.index(b'\0', p)].decode('utf-8', 'replace')
        elif typ == 8:
            vals = []
            for _ in range(cnt):
                e = buf.index(b'\0', p)
                vals.append(buf[p:e].decode('utf-8', 'replace'))
                p = e + 1
            tags[tag] = vals
    return tags, off, end


def parse(path):
    buf = open(path, 'rb').read()
    if buf[:4] != b'\xed\xab\xee\xdb':
        raise ValueError('not an RPM')
    sig, s0, s1 = read_header(buf, 96)
    h0 = s1 + (-s1 % 8)
    main, _, h1 = read_header(buf, h0)
    payload = buf[h1:]
    comp = main.get(1125, 'gzip')
    raw = {'zstd': lambda b: zstd.decompress(b), 'xz': lzma.decompress, 'lzma': lzma.decompress, 'gzip': gzip.decompress}[comp](payload)
    members = []
    p = 0
    while p < len(raw):
        if raw[p:p + 6] != b'070701':
            raise ValueError('bad cpio magic')
        fields = [int(raw[p + 6 + 8 * i:p + 14 + 8 * i], 16) for i in range(13)]
        size, namesize = fields[6], fields[11]
        name = raw[p + 110:p + 110 + namesize - 1].decode()
        q = p + 110 + namesize
        q += -q % 4
        data = raw[q:q + size]
        p = q + size
        p += -p % 4
        if name == 'TRAILER!!!':
            break
        members.append((name, data))
    digest = main.get(5092)
    return {
        'file': path.replace('\\', '/').split('/')[-1],
        'sha256': hashlib.sha256(buf).hexdigest(),
        'size': len(buf),
        'name': main.get(1000), 'version': main.get(1001), 'release': main.get(1002),
        'license': main.get(1014), 'url': main.get(1020),
        'headerSha256Ok': sig.get(273) == hashlib.sha256(buf[h0:h1]).hexdigest(),
        'payloadDigestOk': (digest[0] if isinstance(digest, list) else digest) == hashlib.sha256(payload).hexdigest() if digest else None,
        'payloadCompressor': comp,
        'members': [{'name': n, 'size': len(d), 'sha256': hashlib.sha256(d).hexdigest()} for n, d in members],
    }, dict(members)


def main():
    if sys.argv[1] == 'verify':
        print(json.dumps([parse(p)[0] for p in sys.argv[2:]], indent=1))
    elif sys.argv[1] == 'extract':
        _, members = parse(sys.argv[2])
        tarball = members[sys.argv[3]]
        with tarfile.open(fileobj=io.BytesIO(tarball)) as t:
            data = t.extractfile(sys.argv[4]).read()
        open(sys.argv[5], 'wb').write(data)
        print(hashlib.sha256(data).hexdigest(), len(data))


main()
