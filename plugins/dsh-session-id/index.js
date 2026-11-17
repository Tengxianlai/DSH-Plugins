/**
 * dsh-session-id —— 宿主半边。
 *
 * 浏览器半边在会话标题栏显示 session id，点击复制 id、会话存储目录与工作目录。
 * 目录只有宿主算得出来：存储根来自 profile 配置（本机是 `$DSH_HOME/sessions`，
 * 由 `dsh-base` 的 `session-persistence-jsonl.root` 决定），浏览器不知道这个值。
 * 所以这里在 Connection 的认证围栏内注册一条只读路由，把后端解析出的
 * artifact 位置交给浏览器：
 *
 *   GET /api/session.location?sessionId=<id>
 *     200 { sessionId, dir, log, cwd }
 *     400 { error: 'missing-session-id' }
 *     404 { error: 'session-not-found' }
 *     503 { error: 'persistence-unavailable' }
 *     500 { error: 'session-location-failed' }
 *
 * 位置取自 `ctx.sessionPersistence.stat()` 快照里的 `location`（官方为诊断/
 * 导出提供的字段，例如 `/home/x/.dsh-wsl/sessions/--proj--/session-<uuid>/session.v4.jsonl.zstd`），
 * 只读 header 与文件元信息，不读事件日志、不创建 Agent。`dir` 是它的父目录，
 * 也就是这个会话在磁盘上的存储目录；`log` 是当前的日志文件（格式升级后会改名，
 * 所以对外主推 `dir`）。会话已创建但尚未落盘、或日志已删除时 `dir`/`log` 为 null。
 *
 * 出错时不把异常文本回给浏览器：底层错误信息里可能带主机绝对路径。
 */

import { dirname } from 'node:path';

export const name = 'dsh-session-id';

/** Connection 服务的认证围栏（浏览器必须带会话 Cookie）。 */
export const inject = ['connection'];

/** 路由坐标：与官方 `/api/session.*` 家族同形。 */
export const SESSION_LOCATION_PATH = '/api/session.location';

/**
 * 注册查询路由。位置在请求时解析，所以会话开关/持久化服务替换都能跟上。
 * @param {object} ctx - 宿主上下文（含 connection 服务）。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: SESSION_LOCATION_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => respondLocation(ctx, request)
  }), 'dsh-session-id: /api/session.location');
}

/**
 * JSON 响应（不缓存：位置会随落盘/格式升级变化）。
 * @param {object} body - 响应体。
 * @param {number} status - HTTP 状态码。
 * @returns {Response} 响应。
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

/**
 * 回答一次位置查询。
 * @param {object} ctx - 宿主上下文。
 * @param {Request} request - 认证围栏放行后的 Fetch 请求。
 * @returns {Promise<Response>} 位置 JSON 或错误 JSON。
 */
async function respondLocation(ctx, request) {
  let sessionId;
  try {
    sessionId = new URL(request.url).searchParams.get('sessionId');
  } catch {
    return json({ error: 'missing-session-id' }, 400);
  }
  if (sessionId === null || sessionId === '') return json({ error: 'missing-session-id' }, 400);

  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) return json({ error: 'persistence-unavailable' }, 503);

  let snapshot;
  try {
    snapshot = await persistence.stat(sessionId, { signal: request.signal });
  } catch {
    if (request.signal.aborted) return json({ error: 'aborted' }, 499);
    return json({ error: 'session-location-failed' }, 500);
  }
  if (snapshot === undefined) return json({ error: 'session-not-found' }, 404);

  const log = nonEmptyString(snapshot.location?.path);
  return json({
    sessionId,
    log,
    dir: log === null ? null : dirname(log),
    cwd: nonEmptyString(snapshot.header?.cwd)
  });
}

/**
 * 取非空字符串，其余（undefined/null/空串/非字符串）一律 null。
 * @param {unknown} value - 待检查的值。
 * @returns {string|null} 可用的字符串或 null。
 */
function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}
