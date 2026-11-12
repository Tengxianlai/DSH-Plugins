/**
 * 宿主半边的契约自测：导出形状与注入声明（不连 MCP 服务器）。
 * 运行：node test/host.test.mjs
 */
import assert from 'node:assert/strict';
import host, { apply, inject, name } from '../index.js';

assert.equal(name, 'playwright-per-agent');
assert.deepEqual(inject, ['agents', 'subagents']);
assert.equal(typeof apply, 'function');
assert.equal(host.name, name);
assert.equal(host.apply, apply);
assert.equal(host.inject, inject);
console.log('dsh-playwright-per-agent host contract: ok');
