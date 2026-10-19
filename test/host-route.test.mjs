/**
 * 宿主半体的单元测试（不依赖 DSH 运行时）：用假 ctx 捕获两条路由的处理器，
 * 验证坐标解析、事件/摘要回读、路径核对、响应头与失败映射。
 * 运行：node test/host-route.test.mjs
 */
import assert from 'node:assert/strict';
import { apply, inject, name } from '../lib/index.js';

/** 捕获注册进来的路由处理器，并记录 workspaceFiles.stat 的入参。 */
function harness(overrides = {}) {
  const captured = { routes: new Map(), stats: [], fs: {} };
  const fs = {
    processPathFromHostPath: (p) => p,
    resolve: async (p) => ({ displayPath: p }),
    processPath: (t) => t.displayPath,
    readBytes: async () => new TextEncoder().encode('BYTES'),
    ...overrides.fs
  };
  captured.fs = fs;
  const ctx = {
    effect: (cb) => {
      cb();
      return () => {};
    },
    connection: {
      fetch: {
        register: (route) => {
          captured.routes.set(route.path, route);
          return () => {};
        }
      }
    },
    sessionQuery: {
      readEvent: async () => overrides.read ?? {
        target: { type: 'deliverables/presented', data: { files: [{ path: '.probe/报告 1.pdf', description: 'x' }] } },
        session: { cwd: '/workspace' }
      }
    },
    workspaceChanges: {
      summary: () => ('summary' in overrides ? overrides.summary : {
        cwd: '/workspace',
        files: [{ path: 'src/报告 2.md', added: 3, deleted: 1 }]
      })
    },
    workspaceFiles: {
      stat: async (scope, path) => {
        captured.stats.push([scope.workspaceRoot, path]);
        if (overrides.stat !== undefined) return overrides.stat;
        return { absolutePath: path.startsWith('src/') ? `/workspace/${path}` : '/workspace/.probe/报告 1.pdf' };
      }
    },
    sandboxPolicy: { workspaceRoot: '/fallback-root' },
    fs
  };
  apply(ctx);
  return { captured, ctx };
}

const base = 'http://dsh.invalid';
const get = (captured, path) => captured.routes.get(path);

// 0) 两条路由都注册上了
{
  const { captured } = harness();
  assert.deepEqual([...captured.routes.keys()].sort(), ['/api/changes.download', '/api/present.download']);
  for (const route of captured.routes.values()) {
    assert.deepEqual(route.methods, ['GET']);
    assert.equal(route.requestBody, 'buffered');
  }
  console.log('ok  两条路由注册（GET / buffered）');
}

// 1) 交付卡片：200 + 附件头 + 非 ASCII 文件名走 filename*
{
  const { captured } = harness();
  const res = await get(captured, '/api/present.download').fetch(
    new Request(`${base}/api/present.download?sessionId=s1&seq=5&index=0`)
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-length'), '5');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  // 兼容参数里非 ASCII 换成下划线，真名走 filename*（中文 + 空格都不丢）。
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="__ 1\.pdf"; filename\*=UTF-8''%E6%8A%A5%E5%91%8A%201\.pdf$/u);
  assert.equal(await res.text(), 'BYTES');
  console.log('ok  交付卡片 200 附件响应 / 头 / 非 ASCII 文件名');
}

// 2) 交付卡片：工作区根取 session.cwd；session 没有 cwd 时回退 sandboxPolicy.workspaceRoot
{
  const a = harness();
  await get(a.captured, '/api/present.download').fetch(new Request(`${base}/api/present.download?sessionId=s&seq=1&index=0`));
  assert.deepEqual(a.captured.stats, [['/workspace', '.probe/报告 1.pdf']]);

  const b = harness({ read: { target: { type: 'deliverables/presented', data: { files: [{ path: 'x.png' }] } }, session: {} } });
  await get(b.captured, '/api/present.download').fetch(new Request(`${base}/api/present.download?sessionId=s&seq=1&index=0`));
  assert.deepEqual(b.captured.stats, [['/fallback-root', 'x.png']]);
  console.log('ok  交付卡片工作区根：cwd → 回退 sandboxPolicy');
}

// 3) 变更卡片：走 workspaceChanges.summary 的 cwd 与 files[index]
{
  const { captured } = harness();
  const res = await get(captured, '/api/changes.download').fetch(
    new Request(`${base}/api/changes.download?sessionId=s1&seq=7&index=0`)
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.deepEqual(captured.stats, [['/workspace', 'src/报告 2.md']]);
  console.log('ok  变更卡片 200（用摘要的 cwd 解析第 index 个变更文件）');
}

// 4) 坐标缺失或非法 → 400（两条路由同判据）
for (const qs of ['', '?sessionId=s1', '?sessionId=s1&seq=5', '?sessionId=s1&seq=x&index=0', '?sessionId=&seq=1&index=0']) {
  for (const path of ['/api/present.download', '/api/changes.download']) {
    const { captured } = harness();
    const res = await get(captured, path).fetch(new Request(`${base}${path}${qs}`));
    assert.equal(res.status, 400, `期望 400：${path}${qs}`);
  }
}
console.log('ok  400 非法坐标（两条路由）');

// 5) 事件类型 / 序号 / 摘要不可用 → 404
{
  const a = harness({ read: { target: { type: 'workspace/changes', data: {} }, session: { cwd: '/w' } } });
  assert.equal((await get(a.captured, '/api/present.download').fetch(new Request(`${base}/api/present.download?sessionId=s&seq=1&index=0`))).status, 404);
  const b = harness({ read: { target: { type: 'deliverables/presented', data: { files: [] } }, session: { cwd: '/w' } } });
  assert.equal((await get(b.captured, '/api/present.download').fetch(new Request(`${base}/api/present.download?sessionId=s&seq=1&index=3`))).status, 404);
  const c = harness({ summary: undefined });
  assert.equal((await get(c.captured, '/api/changes.download').fetch(new Request(`${base}/api/changes.download?sessionId=s&seq=1&index=0`))).status, 404);
  const d = harness({ summary: { cwd: '/w', files: [] } });
  assert.equal((await get(d.captured, '/api/changes.download').fetch(new Request(`${base}/api/changes.download?sessionId=s&seq=1&index=9`))).status, 404);
  const e = harness({ summary: { cwd: '/w', files: [{ path: '   ' }] } });
  assert.equal((await get(e.captured, '/api/changes.download').fetch(new Request(`${base}/api/changes.download?sessionId=s&seq=1&index=0`))).status, 404);
  console.log('ok  404 事件类型 / 序号 / 摘要不可用 / 空路径');
}

// 6) 主机路径映射不上 / 往返核对不一致 → 422
{
  const a = harness({ fs: { processPathFromHostPath: () => undefined } });
  assert.equal((await get(a.captured, '/api/present.download').fetch(new Request(`${base}/api/present.download?sessionId=s&seq=1&index=0`))).status, 422);
  const b = harness({ fs: { processPath: () => '/别的/路径' } });
  assert.equal((await get(b.captured, '/api/changes.download').fetch(new Request(`${base}/api/changes.download?sessionId=s&seq=1&index=0`))).status, 422);
  console.log('ok  422 主机路径不可信');
}

// 7) 读取失败：FS 码 → HTTP；未知错误 → 500
{
  const cases = [
    ['FS_NOT_FOUND', 404],
    ['FS_NOT_REGULAR_FILE', 403],
    ['FS_SANDBOX_DENIED', 403],
    ['FS_TOO_LARGE', 413],
    ['什么都不是', 500]
  ];
  for (const [code, want] of cases) {
    const { captured } = harness({ fs: { readBytes: async () => { const e = new Error('x'); e.code = code; throw e; } } });
    assert.equal((await get(captured, '/api/present.download').fetch(new Request(`${base}/api/present.download?sessionId=s&seq=1&index=0`))).status, want, code);
  }
  console.log('ok  FS 失败码映射');
}

// 8) 纯函数边界：MIME 回退与 Content-Disposition 的引号/反斜杠转义
{
  const { captured } = harness({ stat: { absolutePath: '/w/无扩展名' } });
  const res = await get(captured, '/api/present.download').fetch(new Request(`${base}/api/present.download?sessionId=s&seq=1&index=0`));
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /filename="____"; filename\*=UTF-8''%E6%97%A0%E6%89%A9%E5%B1%95%E5%90%8D$/u);
  console.log('ok  MIME 回退与非 ASCII 文件名编码');
}

// 9) 查询层抛错：官方同口径判 404，而不是 500（真机验收时踩到过这个）
{
  const cases = [
    ['SESSION_QUERY_EVENT_NOT_FOUND', 404],
    ['SESSION_QUERY_SESSION_NOT_FOUND', 404],
    ['ENOENT', 404],
    ['别的码', 500]
  ];
  for (const [code, want] of cases) {
    const { captured, ctx } = harness();
    ctx.sessionQuery.readEvent = async () => {
      const error = new Error('no such event');
      error.code = code;
      throw error;
    };
    const res = await get(captured, '/api/present.download').fetch(
      new Request(`${base}/api/present.download?sessionId=s&seq=999&index=0`)
    );
    assert.equal(res.status, want, code);
  }
  // 嵌套一层的码也认（换一层包装不会退化成 500）
  const { captured, ctx } = harness();
  ctx.sessionQuery.readEvent = async () => {
    throw { error: { code: 'session/not-found' } };
  };
  assert.equal((await get(captured, '/api/present.download').fetch(
    new Request(`${base}/api/present.download?sessionId=s&seq=1&index=0`)
  )).status, 404);
  console.log('ok  查询层失败码 → 404（顶层/嵌套都认），未知码仍 500');
}

// 10) 插件面：名字与注入服务
assert.equal(name, 'deliverable-download');
assert.deepEqual(inject, ['connection', 'sessionQuery', 'workspaceChanges', 'workspaceFiles', 'fs', 'sandboxPolicy']);
console.log('ok  插件面 name/inject');
console.log('\n全部通过');
