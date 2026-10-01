/**
 * Makes `require('vscode')` resolve to tests/extension/vscode-fake. Import
 * this first in a test file that loads extension modules using the VS Code
 * API. VS Code itself is never started by `npm test`.
 */
import Module = require('node:module');

type Resolver = (request: string, ...rest: unknown[]) => string;
const mod = Module as unknown as { _resolveFilename: Resolver };
const original = mod._resolveFilename;
const fake = require.resolve('./vscode-fake');
if (!(original as Resolver & { nexysFake?: true }).nexysFake) {
    const patched: Resolver & { nexysFake?: true } = function (this: unknown, request: string, ...rest: unknown[]) {
        return request === 'vscode' ? fake : original.call(this, request, ...rest);
    };
    patched.nexysFake = true;
    mod._resolveFilename = patched;
}
