import { createSetupController, type HardwareView, type SetupController } from '../../runtime/setup';
import { runRosettaInTerminal } from './setup-ui';

export interface SetupServiceOptions {
    readonly extensionPath: string;
    readonly hardware: () => HardwareView;
}

/** Lazy holder for the Setup controller (created on first use; creating it starts nothing). */
export class SetupService {
    private controllerPromise: Promise<SetupController | undefined> | undefined;

    constructor(private readonly opts: SetupServiceOptions) {}

    controller(): Promise<SetupController | undefined> {
        this.controllerPromise ??= createSetupController({ ...this.opts, runRosettaCommand: (c) => runRosettaInTerminal(c) });
        return this.controllerPromise;
    }
}
