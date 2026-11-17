import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyWithCompatibility } from './lib/compat.js';

// Resolve host packages from the running DSH installation, never a plugin-local
// dependency copy. Pin the adapter because it relies on its registration contract.
if (!process.env.DSH_INSTALL_DIR) throw new Error('subagent-model-compat requires DSH_INSTALL_DIR');
const runtimeRequire = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'));
const manifest = runtimeRequire('@deepseek-ai/dsh-tool-subagent/package.json');
if (manifest.version !== '0.2.2-rc.3') {
  throw new Error(`subagent-model-compat supports dsh-tool-subagent 0.2.2-rc.3; found ${manifest.version}`);
}
const official = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-tool-subagent')).href);

export const name = 'subagent-model-compat';
export const Config = official.Config;
export const inject = official.inject;
export function apply(ctx, config) {
  return applyWithCompatibility(ctx, config, official.apply);
}
