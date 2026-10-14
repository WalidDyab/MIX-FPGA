// Shared by adoption-dry-run.mjs and adopt-existing.mjs: the real inputs of the adoption of this Mac's development setup.
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const d = (p) => require(join(repo, 'dist', p));
export const adopt = d('platform/macos/install/adopt.js');
const { loadExpectedToolchain } = d('platform/macos/install/expected.js');
const { resolveRuntimeLayout } = d('platform/macos/install/layout.js');
const { devPayload, DEV_TOOL_FOLDERS } = d('platform/macos/install/dev-payload.js');
const { defaultPaths } = d('platform/macos/de10/config.js');
const { NodeToolRunner } = d('core/process/tool-runner.js');

const home = homedir();
export const layout = resolveRuntimeLayout({ home, env: {} });
const toolsRoot = join(repo, 'toolchains', 'experimental');
export const expected = await loadExpectedToolchain(join(repo, 'toolchains', 'mixfpga', 'toolchain-1.0-macos-arm64.json'));
export const deps = {
  layout,
  expected,
  payload: devPayload({ toolsRoot, engineDir: join(repo, 'platform', 'macos', 'lima'), noticesDir: join(repo, 'toolchains', 'mixfpga', 'notices', 'macos-arm64') }),
  legacyFolders: DEV_TOOL_FOLDERS,
  legacyToolsRoot: toolsRoot,
  legacyPaths: defaultPaths({ repoRoot: repo, home }),
  runner: new NodeToolRunner(),
  leaveAlone: [
    { path: join(layout.shareDir, 'vendor'), why: 'Altera installer copies and the stray empty file; not deleted' },
    { path: join(layout.shareDir, 'jobs'), why: 'earlier build jobs' },
    { path: join(home, 'Library', 'Caches', 'lima'), why: 'Lima\'s cache of the Ubuntu image; retention decided later' },
    { path: toolsRoot, why: 'the existing tools, kept as the development fallback until you approve removing them' },
    { path: join(home, 'Downloads', 'QuartusLiteSetup-25.1std.0.1129-linux.run'), why: 'your original Altera download' },
    { path: join(home, 'Downloads', 'max10-25.1std.0.1129.qdz'), why: 'your original Altera download' },
    { path: join(home, 'Library', 'NexysVHDL'), why: 'NexysVHDL Toolchain 1.0; never touched' },
  ],
};
