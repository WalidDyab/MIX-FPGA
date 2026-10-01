/** Minimal typed event emitter, so services stay independent of the VS Code API. */
export class Emitter<T> {
    private listeners = new Set<(value: T) => void>();

    /** Subscribes; returns a disposer. */
    readonly event = (listener: (value: T) => void): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    fire(value: T): void {
        for (const l of [...this.listeners]) {
            try {
                l(value);
            } catch {
                /* one broken view must not stop the others */
            }
        }
    }

    dispose(): void {
        this.listeners.clear();
    }
}

/** Sink for the NexysVHDL output channel. */
export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
