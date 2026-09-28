"""Read-only probe: enumerate Digilent devices via the installed Adept Runtime (dmgr.dll)."""
import ctypes as C

dmgr = C.WinDLL("dmgr.dll")

ver = C.create_string_buffer(64)
dmgr.DmgrGetVersion(ver)
print("dmgr version:", ver.value.decode())

class DVC(C.Structure):  # dpcdefs.h: DVC
    _pack_ = 16
    _fields_ = [("szName", C.c_char * 64), ("szConn", C.c_char * 261), ("dtp", C.c_uint32)]

n = C.c_int(0)
if not dmgr.DmgrEnumDevices(C.byref(n)):
    print("DmgrEnumDevices failed, erc =", dmgr.DmgrGetLastError()); raise SystemExit(1)
print("devices:", n.value)
for i in range(n.value):
    d = DVC()
    dmgr.DmgrGetDvc(i, C.byref(d))
    print(f"  [{i}] name={d.szName.decode()!r} conn={d.szConn.decode()!r} dtp=0x{d.dtp:08x}")
dmgr.DmgrFreeDvcEnum()
