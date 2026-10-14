#!/bin/bash
# MIX-FPGA: install the Rosetta compatibility wrapper `mixfpga-q` (run as root in the guest).
# Quartus' adm/qenv.sh decides 32/64-bit from `uname -m` and requires "sse" in /proc/cpuinfo;
# both are false on an aarch64 guest even though Rosetta runs the x86-64 binaries fine.
# Instead of patching vendor files, run each Quartus command in a private mount namespace
# where /proc/cpuinfo is an x86-looking file and `uname -m` reports x86_64.
set -euo pipefail
d=/usr/local/lib/mixfpga; mkdir -p $d/shim
printf 'processor\t: 0\nvendor_id\t: GenuineIntel\nmodel name\t: x86-64 (Rosetta)\nflags\t\t: fpu sse sse2 ssse3 sse4_1 sse4_2 lm\n\n' > $d/cpuinfo
cat > $d/shim/uname <<'EOS'
#!/bin/bash
if [ "$1" = -m ]; then echo x86_64; else exec /usr/bin/uname "$@"; fi
EOS
cat > /usr/local/bin/mixfpga-q <<'EOS'
#!/bin/bash
# usage: mixfpga-q <quartus tool> [args...]   (e.g. mixfpga-q quartus_sh --version)
Q=${MIXFPGA_QUARTUS:-/opt/mixfpga/quartus/25.1std/quartus}
[ -d "$Q/bin" ] || { echo "mixfpga-q: Quartus not found at $Q" >&2; exit 127; }
[ "$(id -u)" = 0 ] && { echo "mixfpga-q: do not run as root" >&2; exit 2; }
exec sudo -n unshare -m bash -c '
  mount --bind /usr/local/lib/mixfpga/cpuinfo /proc/cpuinfo || exit 126
  cd "$0"
  exec setpriv --reuid '"$(id -u)"' --regid '"$(id -g)"' --init-groups \
    env HOME="'"$HOME"'" QUARTUS_ROOTDIR_OVERRIDE="'"$Q"'" LC_ALL=C.UTF-8 \
        PATH="/usr/local/lib/mixfpga/shim:'"$Q"'/bin:/usr/local/bin:/usr/bin:/bin" "$@"
' "$PWD" "$@"
EOS
chmod +x /usr/local/bin/mixfpga-q $d/shim/uname

# Rosetta AOT caching daemon: with rosettad serving, every Quartus binary dies with SIGBUS
# (Rosetta mmaps its ~/.cache/rosetta/*.flu file past its 33-byte EOF). Quartus runs fine on
# Rosetta's plain translation path without the AOT socket. Lima 2.2.1's boot script rewrites
# rosettad.service on every boot and re-enables it, so mask/disable do not stick; a drop-in does:
# the unit "runs" (so Lima's `systemctl enable --now` succeeds) but never creates the socket.
# (Observed Lima 2.2.1, Ubuntu 24.04.5, macOS 27.0.1.)
mkdir -p /etc/systemd/system/rosettad.service.d
cat > /etc/systemd/system/rosettad.service.d/mixfpga-no-aot.conf <<'EOS'
[Service]
ExecStartPre=
ExecStart=
ExecStart=/usr/bin/sleep infinity
ExecStartPost=
EOS
systemctl daemon-reload
systemctl restart rosettad
rm -f /run/rosettad/rosetta.sock /var/cache/rosettad/*.aotcache
rm -rf /var/cache/rosettad/uds
