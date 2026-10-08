/**
 * Zoom and pan of the Design Schematic. Pure and import-free so the very same functions are tested
 * here and embedded (via Function.prototype.toString) in the webview page.
 *
 * Readability first: the schematic opens at 100% and the student moves around it; "Fit All" is a
 * deliberate choice, never the default. A design larger than the window is panned, not shrunk
 * until its text cannot be read.
 */

export type ZoomMode = '100' | 'width' | 'all' | 'custom';

/** Smallest and largest zoom the controls reach (Fit All may go down to the minimum on request). */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;
/** "Fit Width" and "Fit All" never magnify a small schematic beyond this. */
export const FIT_CEILING = 1.5;

export interface SchematicView {
    readonly mode: ZoomMode;
    readonly scale: number;
}

export interface PanPosition {
    readonly x: number;
    readonly y: number;
}

/** What is remembered for a project: the zoom choice, the scroll position per hierarchy level, and whether the notes are open. */
export interface SchematicViewState {
    readonly view: SchematicView;
    readonly pans: Readonly<Record<string, PanPosition>>;
    readonly notesOpen: boolean;
}

export const DEFAULT_VIEW: SchematicView = { mode: '100', scale: 1 };

export function clampScale(scale: number): number {
    if (typeof scale !== 'number' || !Number.isFinite(scale)) return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The scale a zoom mode gives for a schematic of `content` pixels in a window of `viewport` pixels.
 * `100`: always 1. `width`: the whole width fits. `all`: the whole schematic fits. `custom`: `current`.
 */
export function computeScale(mode: ZoomMode, content: { w: number; h: number }, viewport: { w: number; h: number }, current: number): number {
    if (mode === 'custom') return clampScale(current);
    if (mode === '100') return 1;
    if (!(content.w > 0) || !(content.h > 0) || !(viewport.w > 0) || !(viewport.h > 0)) return 1;
    const byWidth = viewport.w / content.w;
    const fit = mode === 'width' ? byWidth : Math.min(byWidth, viewport.h / content.h);
    return clampScale(Math.min(fit, FIT_CEILING));
}

/** Stored state with anything malformed replaced by the defaults. */
export function sanitizeViewState(value: unknown): SchematicViewState {
    const v = (typeof value === 'object' && value !== null ? value : {}) as { view?: { mode?: unknown; scale?: unknown }; pans?: unknown; notesOpen?: unknown };
    const mode: ZoomMode = v.view?.mode === 'width' || v.view?.mode === 'all' || v.view?.mode === 'custom' || v.view?.mode === '100' ? v.view.mode : '100';
    const scale = typeof v.view?.scale === 'number' ? clampScale(v.view.scale) : 1;
    const pans: Record<string, PanPosition> = {};
    if (typeof v.pans === 'object' && v.pans !== null && !Array.isArray(v.pans)) {
        for (const [id, p] of Object.entries(v.pans as Record<string, unknown>).slice(0, 200)) {
            const q = p as { x?: unknown; y?: unknown };
            if (typeof q?.x === 'number' && typeof q?.y === 'number' && Number.isFinite(q.x) && Number.isFinite(q.y)) {
                pans[id] = { x: Math.max(0, Math.round(q.x)), y: Math.max(0, Math.round(q.y)) };
            }
        }
    }
    return { view: { mode, scale: mode === '100' ? 1 : scale }, pans, notesOpen: v.notesOpen === true };
}
