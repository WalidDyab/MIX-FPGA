/**
 * One editor per project file: finds the tab that already shows a file.
 * Pure (no VS Code API) so it can be unit-tested; the command layer feeds it
 * the editor tabs and then reveals that tab instead of opening another.
 */
export interface OpenTab {
    /** Absolute path of the text file the tab shows (undefined for non-text tabs, e.g. webviews). */
    readonly fsPath: string | undefined;
    readonly viewColumn: number;
}

/** Paths are compared case-insensitively and with either separator: Windows and macOS file systems are case-insensitive. */
const key = (p: string) => p.split('\\').join('/').replace(/\/+$/, '').toLowerCase();

/** The first tab showing `fsPath`, or undefined if the file is not open. */
export function findOpenTab(tabs: readonly OpenTab[], fsPath: string): OpenTab | undefined {
    const want = key(fsPath);
    return tabs.find((t) => t.fsPath !== undefined && key(t.fsPath) === want);
}
