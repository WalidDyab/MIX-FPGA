/** The CLI uses the shared composition root (runtime/); see runtime/context.ts. */
export {
    type ConfiguredProviders,
    type ContextOverrides,
    controllerFor,
    createContext,
    loadProject,
    programmingFor,
    providersFor,
    type RuntimeContext as CliContext,
    toolLocatorFor,
} from '../runtime/context';
