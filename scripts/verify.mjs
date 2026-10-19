/**
 * 质量门：跑两个半边各自的自测 + 对账检查。任何一项失败即非零退出。
 * 提交前跑它；.githooks/pre-commit 也调用它。
 *
 * 用法：node scripts/verify.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const steps = [
  ['宿主半体自测', [join(ROOT, 'test/host-route.test.mjs')]],
  ['浏览器半体自测', [join(ROOT, 'test/client-href.test.mjs')]],
  ['语法检查 lib/index.js', ['--check', join(ROOT, 'lib/index.js')]],
  ['语法检查 client.js', ['--check', join(ROOT, 'client.js')]],
  ['对账检查', [join(ROOT, 'scripts/check-docs-drift.mjs')]]
];

for (const [label, args] of steps) {
  process.stdout.write(`\n=== ${label}\n`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0) {
    console.error(`\n质量门失败：${label}`);
    process.exit(result.status ?? 1);
  }
}
console.log('\n质量门全绿');
