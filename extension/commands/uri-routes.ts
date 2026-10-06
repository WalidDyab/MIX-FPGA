/**
 * What `vscode://emxplore.nexysvhdl/<path>` may ask the extension to do. The
 * NexysVHDL launcher (a normal desktop application) uses these to reach
 * commands that already exist, instead of duplicating them. Only a fixed list
 * is accepted: a link on a web page can never run an arbitrary command.
 * Pure (no VS Code API) so it is unit-tested.
 */
const ROUTES: Readonly<Record<string, string>> = {
    '/newproject': 'nexysvhdl.createProject',
    '/gettingstarted': 'nexysvhdl.gettingStarted',
    '/showenvironment': 'nexysvhdl.showEnvironment',
};

/** The command a URI path maps to, or undefined for anything not on the list. */
export function routeUri(path: string): string | undefined {
    return ROUTES[path.replace(/\/+$/, '').toLowerCase()];
}
