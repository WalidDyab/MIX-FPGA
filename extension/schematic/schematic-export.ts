import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { type DiagramKind, exportFileName, pngSize, type SchematicAppearance, standaloneSvg, svgSize } from './schematic-chrome';

/** What the exporter needs from the schematic panel that owns it. */
export interface ExportSource {
    readonly kind: DiagramKind;
    webview(): vscode.Webview | undefined;
    projectRoot(): string | undefined;
    /** The complete drawing currently shown (every block and wire, not the visible part) and its entity name. */
    current(): { svg: string; entity: string } | undefined;
    appearance(): SchematicAppearance;
}

export interface ExportRecord {
    readonly file: string;
    readonly format: 'svg' | 'png';
    readonly bytes: number;
    readonly width?: number;
    readonly height?: number;
    readonly appearance: SchematicAppearance;
}

/**
 * Export SVG… / Export PNG… of a schematic. The extension owns the Save dialog and writes the file (a webview cannot download);
 * the whole drawing is exported, in the Dark/Light mode on screen, whatever the zoom. SVG is true vector output. For PNG the
 * page rasterizes the complete standalone SVG at up to 3× and hands the bytes back. Nothing but the chosen file is written.
 */
export class SchematicExporter {
    private pending = new Map<string, { uri: vscode.Uri; appearance: SchematicAppearance }>();
    /** Validation seam: replaces the Save dialog (never set in a normal session). */
    chooseTarget: (suggested: vscode.Uri, format: 'svg' | 'png') => PromiseLike<vscode.Uri | undefined> = (suggested, format) =>
        vscode.window.showSaveDialog({
            defaultUri: suggested,
            saveLabel: `Export ${format.toUpperCase()}`,
            title: `MIX-FPGA: export the ${this.source.kind === 'rtl' ? 'RTL' : 'Design'} Schematic as ${format.toUpperCase()}`,
            filters: format === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] },
        });
    lastExport: ExportRecord | undefined;
    lastError: string | undefined;

    constructor(private readonly source: ExportSource) {}

    async request(format: 'svg' | 'png'): Promise<void> {
        const cur = this.source.current();
        const webview = this.source.webview();
        if (!cur || !webview) {
            void vscode.window.showInformationMessage('There is no schematic to export yet.');
            return;
        }
        const root = this.source.projectRoot();
        const name = exportFileName(cur.entity, this.source.kind, format);
        const target = await this.chooseTarget(vscode.Uri.file(root ? join(root, name) : name), format);
        if (!target) return;
        const appearance = this.source.appearance();
        const svg = standaloneSvg(cur.svg, this.source.kind, appearance);
        if (format === 'svg') {
            await this.write(target, Buffer.from(svg, 'utf8'), 'svg', appearance, svgSize(svg));
            return;
        }
        const size = svgSize(svg) ?? { width: 1200, height: 800 };
        const px = pngSize(size.width, size.height);
        const id = randomBytes(6).toString('hex');
        this.pending.set(id, { uri: target, appearance });
        void webview.postMessage({ type: 'rasterize', id, svg, width: px.width, height: px.height });
    }

    /** The page's answer to a PNG request. */
    async png(m: { id: string; width?: number; height?: number; data?: string; error?: string }): Promise<void> {
        const job = this.pending.get(m.id);
        if (!job) return;
        this.pending.delete(m.id);
        if (m.error || !m.data) {
            this.lastError = m.error ?? 'no image data';
            void vscode.window.showWarningMessage(`MIX-FPGA: the PNG could not be created (${this.lastError}). Try Export SVG… instead.`);
            return;
        }
        await this.write(job.uri, Buffer.from(m.data, 'base64'), 'png', job.appearance, m.width && m.height ? { width: m.width, height: m.height } : undefined);
    }

    private async write(uri: vscode.Uri, bytes: Buffer, format: 'svg' | 'png', appearance: SchematicAppearance, size?: { width: number; height: number }): Promise<void> {
        try {
            await writeFile(uri.fsPath, bytes);
        } catch (err) {
            this.lastError = (err as Error).message;
            void vscode.window.showErrorMessage(`MIX-FPGA: could not save ${uri.fsPath}: ${this.lastError}`);
            return;
        }
        this.lastError = undefined;
        this.lastExport = { file: uri.fsPath, format, bytes: bytes.length, appearance, ...(size ?? {}) };
        void vscode.window.showInformationMessage(`Schematic exported: ${uri.fsPath}`, 'Reveal in File Explorer').then((c) => c && vscode.commands.executeCommand('revealFileInOS', uri));
    }
}
