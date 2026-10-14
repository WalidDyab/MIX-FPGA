import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkLimaSocketLength, HOME_OVERRIDE_VARIABLE, isInsideForeignProduct, resolveRuntimeLayout, UNIX_SOCKET_PATH_LIMIT } from '../../platform/macos/install/layout';

describe('macOS runtime layout', () => {
    it('lives under ~/Library/MIX-FPGA and keeps the proven LIMA_HOME', () => {
        const l = resolveRuntimeLayout({ home: '/Users/s', env: {} });
        assert.equal(l.root, '/Users/s/Library/MIX-FPGA');
        assert.equal(l.limaHome, '/Users/s/Library/MIX-FPGA/lima');
        assert.equal(l.instanceDir, '/Users/s/Library/MIX-FPGA/lima/mix-fpga-de10');
        assert.equal(l.shareDir, '/Users/s/Library/MIX-FPGA/staging');
        assert.equal(l.toolchainDir, '/Users/s/Library/MIX-FPGA/toolchains/1.0/macos-arm64');
        assert.equal(l.unit('ghdl'), '/Users/s/Library/MIX-FPGA/toolchains/1.0/macos-arm64/ghdl');
        assert.ok(l.toolchainMarker.startsWith(l.stateDir), 'the completion marker is outside the immutable toolchain folder');
    });

    it('MIXFPGA_HOME is the only override and relocates everything', () => {
        const l = resolveRuntimeLayout({ home: '/Users/s', env: { [HOME_OVERRIDE_VARIABLE]: '/tmp/m' } });
        for (const p of [l.root, l.toolchainDir, l.limaHome, l.shareDir, l.stateDir, l.logsDir, l.downloadsDir, l.toolchainMarker]) assert.ok(p.startsWith('/tmp/m'), p);
        // Old and unrelated variables change nothing.
        const same = resolveRuntimeLayout({ home: '/Users/s', env: { MIXFPGA_TOOLCHAIN_ROOT: '/x', MIXFPGA_DEV_PAYLOAD: '/y', LIMA_HOME: '/z' } });
        assert.equal(same.root, '/Users/s/Library/MIX-FPGA');
    });

    it('detects a Lima socket path that is too long, without working around it', () => {
        const ok = checkLimaSocketLength(resolveRuntimeLayout({ home: '/Users/nohafahmy', env: {} }));
        assert.equal(ok.ok, true);
        assert.ok(ok.length < UNIX_SOCKET_PATH_LIMIT);
        const long = checkLimaSocketLength(resolveRuntimeLayout({ home: `/Users/${'a'.repeat(60)}`, env: {} }));
        assert.equal(long.ok, false);
        assert.equal(long.over, long.length - UNIX_SOCKET_PATH_LIMIT);
        assert.match(long.path, /default_fd\.sock$/);
    });

    it('measures the socket limit exactly at its boundary', () => {
        const base = checkLimaSocketLength(resolveRuntimeLayout({ home: '/h', env: {} }));
        const pad = UNIX_SOCKET_PATH_LIMIT - base.length;
        const at = checkLimaSocketLength(resolveRuntimeLayout({ home: `/h${'a'.repeat(pad)}`, env: {} }));
        assert.deepEqual([at.length, at.ok], [UNIX_SOCKET_PATH_LIMIT, true]);
        const over = checkLimaSocketLength(resolveRuntimeLayout({ home: `/h${'a'.repeat(pad + 1)}`, env: {} }));
        assert.deepEqual([over.length, over.ok, over.over], [UNIX_SOCKET_PATH_LIMIT + 1, false, 1]);
    });

    it('counts bytes, not characters (a non-ASCII home folder is longer than it looks)', () => {
        const a = checkLimaSocketLength(resolveRuntimeLayout({ home: '/Users/abc', env: {} }));
        const b = checkLimaSocketLength(resolveRuntimeLayout({ home: '/Users/ÄÖÜ', env: {} }));
        assert.equal(b.length - a.length, 3);
    });

    it('recognises other products\' folders so it never installs into them', () => {
        assert.equal(isInsideForeignProduct(join('/Users/s/Library/NexysVHDL/toolchains')), true);
        assert.equal(isInsideForeignProduct('/Users/s/Library/MIX-FPGA/toolchains'), false);
    });
});
