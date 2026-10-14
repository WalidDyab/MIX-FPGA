import { type Diagnostic, errorDiag } from '../results/diagnostic';
import type { BoardProfile, ConstraintProvider, ImplementationProvider, ProgrammingProvider } from './types';

/** What a board's providers resolve to on this host. */
export type Resolution<T> = { readonly ok: true; readonly provider: T } | { readonly ok: false; readonly diagnostic: Diagnostic };

/**
 * The one place that maps a board profile to its providers. UI code and commands never test
 * which board is open; they ask the registry (through the backend) and call the contract.
 */
export class ProviderRegistry {
    private readonly implementations = new Map<string, ImplementationProvider>();
    private readonly programmers = new Map<string, ProgrammingProvider>();
    private readonly constraints = new Map<string, ConstraintProvider>();

    constructor(private readonly host: string | undefined) {}

    addImplementation(p: ImplementationProvider): this {
        this.implementations.set(p.id, p);
        return this;
    }

    addProgramming(p: ProgrammingProvider): this {
        this.programmers.set(p.id, p);
        return this;
    }

    addConstraints(p: ConstraintProvider): this {
        this.constraints.set(p.format, p);
        return this;
    }

    /** `host` is a platform key like `macos-arm64`; a board without `hosts` runs wherever the base flow does. */
    supportsHost(board: BoardProfile): boolean {
        // A host this product does not know is not a supported host for a board that lists its hosts.
        return !board.hosts || (this.host !== undefined && board.hosts.includes(this.host));
    }

    private unsupported(board: BoardProfile): Diagnostic {
        return errorDiag('workflow', 'BOARD_HOST_UNSUPPORTED', `${board.displayName} is not supported on this computer yet.`);
    }

    implementation(board: BoardProfile): Resolution<ImplementationProvider> {
        if (!this.supportsHost(board)) return { ok: false, diagnostic: this.unsupported(board) };
        const p = this.implementations.get(board.implementationProviderId);
        return p ? { ok: true, provider: p } : { ok: false, diagnostic: errorDiag('workflow', 'IMPLEMENTATION_PROVIDER_MISSING', `No build engine is available for ${board.displayName}.`) };
    }

    programming(board: BoardProfile): Resolution<ProgrammingProvider> {
        if (!this.supportsHost(board)) return { ok: false, diagnostic: this.unsupported(board) };
        const p = this.programmers.get(board.programmingProviderId);
        return p ? { ok: true, provider: p } : { ok: false, diagnostic: errorDiag('workflow', 'PROGRAMMING_PROVIDER_MISSING', `No programmer is available for ${board.displayName}.`) };
    }

    constraint(board: BoardProfile): Resolution<ConstraintProvider> {
        const p = this.constraints.get(board.constraintFormat);
        return p ? { ok: true, provider: p } : { ok: false, diagnostic: errorDiag('workflow', 'CONSTRAINT_PROVIDER_MISSING', `Constraint files for ${board.displayName} are not supported.`) };
    }
}
