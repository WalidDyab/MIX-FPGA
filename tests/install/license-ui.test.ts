import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { licenseHtml } from '../../extension/setup/license-html';
import { hardwareViewOf } from '../../extension/setup/hardware-view';
import { initialHardware } from '../../extension/services/hardware-state';
import type { LicenseOffer } from '../../runtime/setup';

const offer: LicenseOffer = {
    product: 'Quartus Prime Lite Edition',
    version: '25.1std.0 Build 1129',
    title: 'QUARTUS PRIME AND INTEL FPGA IP LICENSE AGREEMENT, VERSION 25.1std',
    text: 'Vendor text with <script>alert(1)</script> & "quotes" — unchanged.\nSecond line.',
    sha256: 'a'.repeat(64),
    bytes: 71,
    source: 'the installer\'s own --install_lic output',
    installerSha256: 'b'.repeat(64),
    references: [{ label: 'Altera: licensing', url: 'https://www.altera.com/support/support-resources/licensing/q-and-a' }],
    statement: 'I have reviewed and accept the Altera Quartus Prime Software License Agreement.',
};

describe('Altera licence page', () => {
    const html = licenseHtml(offer, 'NONCE', 'vscode-resource:');

    it('shows the vendor text escaped and otherwise unchanged, with its hash and source', () => {
        assert.ok(html.includes('Vendor text with &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; — unchanged.\nSecond line.'));
        assert.doesNotMatch(html, /<script>alert/);
        assert.ok(html.includes('a'.repeat(64)));
        assert.match(html, /--install_lic output/);
    });

    it('has the exact checkbox wording, and the install button starts disabled', () => {
        assert.ok(html.includes('<span>I have reviewed and accept the Altera Quartus Prime Software License Agreement.</span>'));
        assert.match(html, /<button id="go" disabled>/);
        assert.match(html, /go\.disabled = !box\.checked/);
        assert.match(html, /<input type="checkbox" id="accept">/);
        assert.doesNotMatch(html, /checked>|checked=/, 'never pre-ticked');
    });

    it('offers the official reference link and locks the page down', () => {
        assert.match(html, /href="https:\/\/www\.altera\.com\/support\/support-resources\/licensing\/q-and-a"/);
        assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src vscode-resource: 'nonce-NONCE'; script-src 'nonce-NONCE';"/);
        assert.doesNotMatch(html, /<script(?![^>]*nonce)/);
    });
});

describe('Setup page hardware row', () => {
    it('is not a setup problem when no board is connected', () => {
        assert.deepEqual(hardwareViewOf({ ...initialHardware, status: 'none', boards: [] }).state, 'not-connected');
        const v = hardwareViewOf({ ...initialHardware, status: 'one', boards: [{ productName: 'DE10-Lite' } as never] });
        assert.deepEqual([v.state, v.word], ['ready', 'DE10-Lite']);
        assert.equal(hardwareViewOf(initialHardware).state, 'not-checked');
    });
});
