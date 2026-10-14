import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { LicenseOffer } from '../../runtime/setup';
import { licenseHtml } from './license-html';

/** Shows the vendor's licence and resolves true only if the student ticked the box and chose to continue. */
export function showLicensePanel(offer: LicenseOffer): Promise<boolean> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel('nexysvhdl.altera-license', 'Altera licence', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
        let done = false;
        const finish = (v: boolean) => {
            if (done) return;
            done = true;
            resolve(v);
            panel.dispose();
        };
        panel.webview.html = licenseHtml(offer, randomBytes(16).toString('hex'), panel.webview.cspSource);
        panel.webview.onDidReceiveMessage((m: { type?: string; statement?: string; url?: string }) => {
            if (m.type === 'accept' && m.statement === offer.statement) finish(true);
            else if (m.type === 'cancel') finish(false);
            else if (m.type === 'open' && typeof m.url === 'string' && offer.references.some((r) => r.url === m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url));
        });
        panel.onDidDispose(() => finish(false));
    });
}
