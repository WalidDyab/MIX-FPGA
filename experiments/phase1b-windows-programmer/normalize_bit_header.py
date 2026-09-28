"""Write a copy of a Xilinx .bit file whose header part name uses Vivado's form.

openXC7's xc7frames2bit writes field 'b' as e.g. 'xc7a100tcsg324-1'; Vivado writes
'7a100tcsg324', which is what Digilent's djtgcfg expects. Only field 'b' is changed;
the configuration payload (field 'e') is copied byte-for-byte and verified.

usage: python normalize_bit_header.py IN.bit OUT.bit
"""
import re
import struct
import sys


def parse(buf):
    """Return (list of (key, value_bytes) for a..d, payload_offset, payload_len)."""
    if buf[:14] != bytes.fromhex("00090ff00ff00ff00ff000000161"):
        raise ValueError("not a Xilinx .bit file (bad magic)")
    o, fields = 14, []
    key = "a"
    while True:
        if key == "e":
            n = struct.unpack_from(">I", buf, o)[0]
            return fields, o + 4, n
        n = struct.unpack_from(">H", buf, o)[0]
        fields.append((key, buf[o + 2:o + 2 + n]))
        o += 2 + n
        key = chr(buf[o])
        o += 1


def vivado_part(part):
    """'xc7a100tcsg324-1' -> '7a100tcsg324'."""
    m = re.fullmatch(r"(?:xc)?(7[a-z]\d+t[a-z]+\d+)(?:-\d+L?)?", part, re.I)
    if not m:
        raise ValueError(f"unrecognised part name {part!r}")
    return m.group(1).lower()


def main(src, dst):
    buf = open(src, "rb").read()
    fields, off, n = parse(buf)
    payload = buf[off:off + n]
    if len(payload) != n or off + n != len(buf):
        raise ValueError("payload length does not match header")

    out = bytearray(buf[:14])
    for i, (key, val) in enumerate(fields):
        if key == "b":
            old = val.rstrip(b"\0").decode()
            val = vivado_part(old).encode() + b"\0"
            print(f"b: {old!r} -> {val[:-1].decode()!r}")
        if i:
            out += key.encode()
        out += struct.pack(">H", len(val)) + val
    out += b"e" + struct.pack(">I", n) + payload
    open(dst, "wb").write(out)

    _, off2, n2 = parse(out)
    assert n2 == n and out[off2:off2 + n2] == payload
    print(f"payload {n} bytes copied and verified identical")


if __name__ == "__main__":
    main(*sys.argv[1:3])
