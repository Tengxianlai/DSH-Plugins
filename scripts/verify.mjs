/**
 * 全仓体检：遍历 plugins/*，逐个检查 manifest、bundle 补丁、语法，并跑插件自带的自测。
 * 任何一项失败即非零退出。
 *
 * 用法：node scripts/verify.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = join(ROOT, 'plugins');
const failures = [];
const checked = [];

const fail = (plugin, message) => {
  failures.push(`${plugin}: ${message}`);
  console.error(`  ✗ ${message}`);
};
const ok = (message) => console.log(`  ✓ ${message}`);

const run = (plugin, label, args, cwd) => {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) fail(plugin, `${label} 失败（退出码 ${result.status ?? 'null'}）`);
  else ok(label);
  return result.status === 0;
};

const listPlugins = () => {
  if (!existsSync(PLUGINS)) return [];
  return readdirSync(PLUGINS)
    .map((name) => join(PLUGINS, name))
    .filter((dir) => statSync(dir).isDirectory());
};

const plugins = listPlugins();
if (plugins.length === 0) {
  console.error(`没有找到任何插件目录：${PLUGINS}`);
  process.exit(1);
}

for (const dir of plugins) {
  const id = dir.slice(PLUGINS.length + 1);
  console.log(`\n=== ${id}`);

  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    fail(id, '缺少 package.json');
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(id, `package.json 不是合法 JSON：${error.message}`);
    continue;
  }
  checked.push(manifest.name ?? id);

  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('dsh-')) fail(id, 'name 必须是 dsh-* 包名');
  else if (manifest.name !== id) fail(id, `目录名与包名不一致（包名 ${manifest.name}）`);
  else ok(`name ${manifest.name}@${manifest.version ?? '?'}`);

  if (manifest.private !== true) fail(id, '对外发布前必须 private: true');
  else ok('private: true');

  const patch = manifest.dsh?.bundle?.patch;
  if (typeof patch !== 'string') {
    fail(id, '未声明 dsh.bundle.patch（无此声明无法托管安装）');
  } else {
    const patchPath = join(dir, patch);
    if (!existsSync(patchPath)) fail(id, `dsh.bundle.patch 指向的文件不存在：${patch}`);
    else {
      const text = readFileSync(patchPath, 'utf8');
      if (!text.includes(`name: ${manifest.name}`)) fail(id, `bundle 补丁里没有挂载 ${manifest.name} 的 insert 行`);
      else ok(`bundle 补丁 ${patch}`);
    }
  }

  const entries = new Set();
  if (typeof manifest.main === 'string') entries.add(manifest.main);
  const clientExport = manifest.exports?.['./client'];
  if (typeof clientExport === 'string') entries.add(clientExport);
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    if (!existsSync(entryPath)) fail(id, `入口文件不存在：${entry}`);
    else run(id, `语法 ${entry}`, ['--check', entryPath], dir);
  }

  if (typeof manifest.dsh?.client?.platform === 'string' && ![...entries].some((entry) => entry.includes('client'))) {
    fail(id, '声明了 dsh.client 却没有 client 入口');
  }

  if (existsSync(join(dir, 'README.md'))) ok('README.md');
  else fail(id, '缺少 README.md');

  const hasSelfTest = typeof manifest.scripts?.verify === 'string' && existsSync(join(dir, 'scripts/verify.mjs'));
  const testDir = join(dir, 'test');
  if (hasSelfTest) run(id, '插件自测', [join(dir, 'scripts/verify.mjs')], dir);
  else if (existsSync(testDir)) {
    const tests = readdirSync(testDir).filter((file) => file.endsWith('.test.mjs'));
    if (tests.length === 0) fail(id, 'test/ 里没有 *.test.mjs');
    for (const test of tests) run(id, `自测 ${test}`, [join(testDir, test)], dir);
  } else fail(id, '缺少 test/ 或 scripts/verify.mjs');
}

console.log('\n' + '-'.repeat(48));
if (failures.length > 0) {
  console.error(`体检失败：${failures.length} 项`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`体检全绿：${checked.length} 个插件（${checked.join(', ')}）`);
