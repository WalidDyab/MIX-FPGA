#!/bin/bash
# MIX-FPGA guest provisioning (runs inside mix-fpga-de10 as root). Idempotent.
# Rosetta needs the x86-64 ELF loader and shared libs: enable the amd64 dpkg
# architecture (served by archive.ubuntu.com; ports.ubuntu.com is arm64-only).
set -euo pipefail
dpkg --add-architecture amd64
f=/etc/apt/sources.list.d/ubuntu.sources
grep -q '^Architectures:' $f || sed -i 's/^Components:.*/&\nArchitectures: arm64/' $f
cat > /etc/apt/sources.list.d/ubuntu-amd64.sources <<'EOS'
Types: deb
URIs: http://archive.ubuntu.com/ubuntu
Suites: noble noble-updates
Components: main universe
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu
Suites: noble-security
Components: main universe
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOS
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  libc6:amd64 libstdc++6:amd64 zlib1g:amd64 libx11-6:amd64 libxext6:amd64 \
  libxft2:amd64 libxtst6:amd64 libxi6:amd64 libxrender1:amd64 libsm6:amd64 \
  libice6:amd64 libfreetype6:amd64 libfontconfig1:amd64 libpng16-16t64:amd64 \
  libxcb1:amd64 libglib2.0-0t64:amd64 libudev1:amd64 libncurses6:amd64 \
  libtinfo6:amd64 libcrypt1:amd64 locales file unzip
