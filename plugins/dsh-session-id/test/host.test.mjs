/**
 * 宿主半边的契约自测：这个插件不该在宿主侧注册任何服务/工具/路由。
 * 运行：node test/host.test.mjs
 */
import assert from 'node:assert/strict';
import { apply, inject, name } from '../index.js';

assert.equal(name, 'dsh-session-id');
assert.ok(Array.isArray(inject), 'inject 必须是数组');
assert.equal(inject.length, 0, '宿主半边不注入任何服务');
assert.equal(typeof apply, 'function');
assert.doesNotThrow(() => apply(), 'apply 必须是空实现且不抛错');
console.log('dsh-session-id host contract: ok');
