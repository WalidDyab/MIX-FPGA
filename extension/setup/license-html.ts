import type { LicenseOffer } from '../../runtime/setup';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The page that shows the vendor's licence. The text is the vendor's file, escaped and otherwise untouched, in a scrollable
 * box; the checkbox carries the exact required wording; the Install button stays disabled until it is ticked.
 * Pure (returns HTML) so it can be tested without VS Code.
 */
export function licenseHtml(offer: LicenseOffer, nonce: string, cspSource: string): string {
    const refs = offer.references.map((r) => `<li><a href="${esc(r.url)}" data-url="${esc(r.url)}">${esc(r.label)}</a></li>`).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Altera licence</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 24px; max-width: 980px; margin: 0 auto; }
h1 { font-size: 1.3em; margin: 0 0 4px; }
.meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 12px; }
pre { white-space: pre-wrap; word-wrap: break-word; height: 52vh; overflow: auto; padding: 12px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: 0.85em; }
label { display: flex; gap: 8px; align-items: flex-start; margin: 14px 0; cursor: pointer; }
button { padding: 6px 16px; border: 0; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); margin-left: 8px; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
a { color: var(--vscode-textLink-foreground); }
</style></head><body>
<h1>${esc(offer.product)} ${esc(offer.version)}: licence</h1>
<div class="meta">This is the licence supplied by Altera's own installer (${esc(offer.title)}). MIX-FPGA shows it unchanged; it is Altera's agreement, not MIX-FPGA's.<br>
Source: ${esc(offer.source)} · ${offer.bytes.toLocaleString('en-US')} bytes · sha256 <code>${esc(offer.sha256)}</code></div>
<pre id="text" tabindex="0">${esc(offer.text)}</pre>
<p>For reference, Altera's own pages:</p><ul>${refs}</ul>
<label><input type="checkbox" id="accept"><span>${esc(offer.statement)}</span></label>
<div><button id="go" disabled>Accept and install</button><button class="secondary" id="cancel">Cancel</button></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const box = document.getElementById('accept'), go = document.getElementById('go');
box.addEventListener('change', () => { go.disabled = !box.checked; });
go.addEventListener('click', () => { if (box.checked) vscode.postMessage({ type: 'accept', statement: ${JSON.stringify(offer.statement)} }); });
document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
document.querySelectorAll('a[data-url]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ type: 'open', url: a.dataset.url }); }));
</script></body></html>`;
}
