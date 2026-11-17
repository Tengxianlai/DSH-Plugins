/**
 * 宿主半边的契约自测（不依赖 DSH 运行时）：用假 ctx 捕获 /api/session.location
 * 的处理器，验证坐标、路由形状、正常快照的 JSON，以及缺参/查无/服务缺失/
 * 读取失败/已取消这几种失败映射。
 * 运行：node test/host.test.mjs
 */
import assert from 'node:assert/strict';
import { apply, inject, name, SESSION_LOCATION_PATH } from '../index.js';

const BASE = 'http://dsh.invalid';

/**
 * 装一个假宿主上下文，捕获注册进来的路由。
 * @param {object} options - `persistence` 假 sessionPersistence 服务；缺省表示服务不存在。
 * @returns {{routes: Map<string, object>, registered: object[]}} 捕获结果。
 */
function harness({ persistence } = {}) {
  const routes = new Map();
  const registered = [];
  const ctx = {
    effect: (cb) => {
      const dispose = cb();
      return dispose === undefined ? () => {} : dispose;
    },
    connection: {
      fetch: {
        register: (route) => {
          registered.push(route);
          routes.set(route.path, route);
          return () => {};
        }
      }
    },
    get: (serviceName) => (serviceName === 'sessionPersistence' ? persistence : undefined)
  };
  apply(ctx);
  return { routes, registered };
}

/** 一条能被解析的 sessionPersistence.stat 快照。 */
const SNAPSHOT = {
  header: { id: 'session-abc', cwd: '/home/me/proj' },
  revision: 'r1',
  sizeBytes: 42,
  location: {
    kind: 'jsonl',
    path: '/home/me/.dsh-wsl/sessions/--home-me-proj--/session-abc/session.v4.jsonl.zstd'
  }
};

const get = (routes, query) => routes.get(SESSION_LOCATION_PATH).fetch(new Request(`${BASE}${SESSION_LOCATION_PATH}${query}`));

// 0) 插件身份 + 只注册一条路由
{
  assert.equal(name, 'dsh-session-id');
  assert.deepEqual(inject, ['connection'], '需要 Connection 的认证围栏');
  const { routes, registered } = harness({ persistence: { stat: async () => SNAPSHOT } });
  assert.equal(registered.length, 1);
  assert.deepEqual([...routes.keys()], [SESSION_LOCATION_PATH]);
  assert.equal(SESSION_LOCATION_PATH, '/api/session.location');
  const route = routes.get(SESSION_LOCATION_PATH);
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.requestBody, 'buffered');
  assert.equal(typeof route.fetch, 'function');
  console.log('ok  路由注册：GET /api/session.location（buffered）');
}

// 1) 正常快照：dir 是 log 的父目录，cwd 一并返回；不缓存
{
  const { routes } = harness({ persistence: { stat: async () => SNAPSHOT } });
  const response = await get(routes, '?sessionId=session-abc');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    sessionId: 'session-abc',
    log: '/home/me/.dsh-wsl/sessions/--home-me-proj--/session-abc/session.v4.jsonl.zstd',
    dir: '/home/me/.dsh-wsl/sessions/--home-me-proj--/session-abc',
    cwd: '/home/me/proj'
  });
  console.log('ok  200：dir/log/cwd 原样解析');
}

// 2) 会话还没落盘（快照无 location）→ dir/log 为 null，cwd 仍在
{
  const { routes } = harness({
    persistence: { stat: async () => ({ header: { id: 'session-new' }, revision: 'r0' }) }
  });
  const response = await get(routes, '?sessionId=session-new');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    sessionId: 'session-new',
    log: null,
    dir: null,
    cwd: null
  });
  console.log('ok  未落盘会话：dir/log/cwd 均 null，不编造路径');
}

// 3) 缺参 / 空参 → 400；stat 不会被调用
{
  let calls = 0;
  const { routes } = harness({ persistence: { stat: async () => { calls += 1; return SNAPSHOT; } } });
  for (const query of ['', '?sessionId=']) {
    const response = await get(routes, query);
    assert.equal(response.status, 400, `期望 400：${query}`);
    assert.deepEqual(await response.json(), { error: 'missing-session-id' });
  }
  assert.equal(calls, 0);
  console.log('ok  缺 sessionId → 400，不触达存储');
}

// 4) 查无此会话 → 404
{
  const { routes } = harness({ persistence: { stat: async () => undefined } });
  const response = await get(routes, '?sessionId=session-gone');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'session-not-found' });
  console.log('ok  查无会话 → 404');
}

// 5) 没有 sessionPersistence 服务 → 503
{
  const { routes } = harness({});
  const response = await get(routes, '?sessionId=session-abc');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'persistence-unavailable' });
  console.log('ok  持久化服务缺失 → 503');
}

// 6) 读取失败 → 500，且不回显异常文本（可能带主机路径）
{
  const { routes } = harness({
    persistence: { stat: async () => { throw new Error('/home/me/secret/session.v4.jsonl.zstd is locked'); } }
  });
  const response = await get(routes, '?sessionId=session-abc');
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(text.includes('/home/me/secret'), false, '不能把底层异常里的绝对路径回给浏览器');
  assert.deepEqual(JSON.parse(text), { error: 'session-location-failed' });
  console.log('ok  读取失败 → 500 且不回显异常文本');
}

// 7) 请求已取消 → 499（不再继续等底层读取）
{
  const controller = new AbortController();
  controller.abort();
  const { routes } = harness({
    persistence: { stat: async (id, options) => { options?.signal?.throwIfAborted(); return SNAPSHOT; } }
  });
  const response = await routes.get(SESSION_LOCATION_PATH).fetch(
    new Request(`${BASE}${SESSION_LOCATION_PATH}?sessionId=session-abc`, { signal: controller.signal })
  );
  assert.equal(response.status, 499);
  console.log('ok  客户端已取消 → 499');
}

console.log('dsh-session-id host contract: ok');
