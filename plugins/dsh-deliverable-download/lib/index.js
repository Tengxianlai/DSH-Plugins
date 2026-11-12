/**
 * dsh-deliverable-download —— 宿主半体（Node 侧）。
 *
 * 为什么需要它
 * ------------
 * DSH 原本只有两条"打开文件"的动作，对远程浏览器（Mac/PC 访问跑在 WSL 上的 DSH）
 * 都拿不到文件：
 *   · 侧边栏预览 —— 只能在浏览器里看，且 HTML 预览受 iframe 沙箱限制
 *     （blob 文档里相对路径解析不了；不透明源带不上 SameSite=Strict 的会话
 *     Cookie，`/api/file` 直接 401，实测）；
 *   · 「在本地打开 / 显示文件位置」—— **主机侧**动作，在 WSL/Windows 那台机器上
 *     跑 explorer.exe，远程浏览器只会看到「当前工作区或本地应用不可用」。
 * 本插件补一条经认证的只读路由，把文件当附件交给浏览器，浏览器直接存盘。
 *
 * 两条路由（坐标都照抄官方同族路由，只把最后一步从"调原生程序打开"换成"读字节"）
 * ---------------------------------------------------------------------------
 *   GET /api/present.download?sessionId=&seq=&index=
 *      —— 同 `/api/present.open`：读回 `deliverables/presented` 事件，
 *         取第 index 个被声明的文件。
 *   GET /api/changes.download?sessionId=&seq=&index=
 *      —— 同 `/api/changes.open`：读 `workspace/changes` 摘要，
 *         取第 index 个变更文件（工作区根用摘要里的 cwd）。
 *
 * 响应始终带 `Content-Disposition: attachment` → 浏览器存盘而不是导航过去；
 * 非 ASCII 文件名同时给 RFC 5987 的 `filename*`，中文/空格不会乱码。
 *
 * 安全
 * ----
 * 两条路由都注册在 Connection 的认证围栏内（与 /api/file、/api/present.open 同层）：
 * 没有会话 Cookie 一律 401，Host/Origin 不匹配一律 403。只读，不改任何状态，
 * 不新增可写入面。单次响应上限见 MAX_BYTES。
 *
 * @module dsh-deliverable-download
 */

/** 交付卡片（present）的下载路由。 */
const PRESENT_ROUTE = '/api/present.download';
/** 变更文件卡片（git 变更摘要）的下载路由。 */
const CHANGES_ROUTE = '/api/changes.download';

/**
 * 单次响应的字节上限（512 MiB）。
 * 刻意不引配置依赖：本包不 import 任何第三方模块，只依赖调用方注入的服务，
 * 这样它不需要在 profile 的 node_modules 里额外装依赖。需要下调时改这里。
 */
const MAX_BYTES = 512 * 1024 * 1024;

/** 未识别扩展名时的回退类型。 */
const FALLBACK_TYPE = 'application/octet-stream';

/** 常见交付物的扩展名 → MIME。下载场景够用即可，不引 mime 库。 */
const TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.yml': 'application/yaml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.apk': 'application/vnd.android.package-archive',
  '.log': 'text/plain; charset=utf-8'
};

/** 文件系统失败码 → HTTP 状态；与官方 /api/file 的映射保持一致。 */
const FAILURE_STATUSES = {
  FS_NOT_FOUND: 404,
  FS_NOT_REGULAR_FILE: 403,
  FS_PERMISSION_DENIED: 403,
  FS_SANDBOX_DENIED: 403,
  FS_TOO_LARGE: 413,
  FS_ABORTED: 499,
  // 事件/会话/工作区文件不存在：官方 present.open 的 failureStatus 同判为 404
  SESSION_QUERY_SESSION_NOT_FOUND: 404,
  SESSION_QUERY_EVENT_NOT_FOUND: 404,
  ENOENT: 404,
  ENOTDIR: 404,
  'session/not-found': 404,
  'workspace-file/not-found': 404,
  'workspace-file/not-regular-file': 404
};

/**
 * 从一个抛出的错误里取失败码。
 * typert 的 RemoteError 把码放在顶层 `code`；另容错读一层嵌套，
 * 免得换一层包装就退化成 500。
 * @param {unknown} error - 捕获到的错误。
 * @returns {string} 失败码，取不到时空串。
 */
function failureCodeOf(error) {
  if (typeof error !== 'object' || error === null) return '';
  for (const candidate of [error.code, error.error?.code, error.cause?.code]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return '';
}

/**
 * 统一的不缓存响应头。
 * @returns {Record<string, string>} 响应头。
 */
function noStore() {
  return { 'cache-control': 'private, no-store' };
}

/**
 * 构造失败响应。
 * @param {string} text - 给调用方看的短原因（与官方路由同风格）。
 * @param {number} status - HTTP 状态。
 * @returns {Response} 响应。
 */
function fail(text, status) {
  return new Response(text, { status, headers: noStore() });
}

/**
 * 取路径的最后一段（不引 node:path，保持零依赖）。
 * @param {string} path - POSIX 或 Windows 拼写的路径。
 * @returns {string} 最后一段；只有分隔符时返回原串。
 */
function basename(path) {
  const trimmed = path.replace(/[/\\]+$/u, '');
  if (trimmed === '') return path;
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return trimmed.slice(cut + 1);
}

/**
 * 按扩展名取 MIME。
 * @param {string} name - 文件名。
 * @returns {string} MIME，未识别时回退。
 */
function contentTypeOf(name) {
  const at = name.lastIndexOf('.');
  if (at < 0) return FALLBACK_TYPE;
  return TYPES[name.slice(at).toLowerCase()] ?? FALLBACK_TYPE;
}

/**
 * 构造强制存盘且对非 ASCII 文件名安全的 Content-Disposition。
 * @param {string} name - 原始文件名。
 * @returns {string} 响应头值。
 */
function contentDisposition(name) {
  // 兼容参数只允许 latin1：非 ASCII 与控制字符一律替换掉，真名走 filename*。
  const ascii = name.replace(/[^\u0020-\u007e]/gu, '_').replace(/["\\]/gu, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * 校验一条交付声明（与官方 isPresentedFile 同判据）。
 * @param {unknown} value - 事件里的一项文件声明。
 * @returns {boolean} 是否可用。
 */
function isPresentedFile(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { path, description } = /** @type {Record<string, unknown>} */ (value);
  return typeof path === 'string' && path.trim().length > 0
    && (description === undefined || typeof description === 'string');
}

/**
 * 解析一个非负整数坐标。
 * @param {string | null} value - 查询串里的原文。
 * @returns {number | undefined} 合法坐标，否则 undefined。
 */
function coordinate(value) {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * 读请求坐标。
 * @param {Request} request - 已过认证围栏的请求。
 * @returns {{sessionId: string, seq: number, index: number} | undefined} 坐标，或 undefined。
 */
function coordinatesOf(request) {
  const query = new URL(request.url).searchParams;
  const sessionId = query.get('sessionId');
  const seq = coordinate(query.get('seq'));
  const index = coordinate(query.get('index'));
  if (sessionId === null || sessionId === '' || seq === undefined || index === undefined) return undefined;
  return { sessionId, seq, index };
}

/**
 * 交付卡片：读回 `deliverables/presented` 拿被声明的路径。
 * @param {object} ctx - 宿主上下文。
 * @param {{sessionId: string, seq: number, index: number}} at - 坐标。
 * @param {AbortSignal} signal - 请求生命周期。
 * @returns {Promise<{absolutePath: string} | Response>} 目标路径，或失败响应。
 */
async function targetOfPresented(ctx, at, signal) {
  const read = await ctx.sessionQuery.readEvent(
    { sessionId: at.sessionId, seq: at.seq, before: 0, after: 0 },
    signal
  );
  const { target, session } = read;
  const file = target.type === 'deliverables/presented' && Array.isArray(target.data?.files)
    ? target.data.files[at.index]
    : undefined;
  if (!isPresentedFile(file)) return fail('Presented file not found in this Session result.', 404);
  const { absolutePath } = await ctx.workspaceFiles.stat(
    { sessionId: at.sessionId, workspaceRoot: session.cwd ?? ctx.sandboxPolicy.workspaceRoot },
    file.path,
    signal
  );
  return { absolutePath };
}

/**
 * 变更文件卡片：读 `workspace/changes` 摘要拿第 index 个变更文件。
 * @param {object} ctx - 宿主上下文。
 * @param {{sessionId: string, seq: number, index: number}} at - 坐标。
 * @param {AbortSignal} signal - 请求生命周期。
 * @returns {Promise<{absolutePath: string} | Response>} 目标路径，或失败响应。
 */
async function targetOfChanges(ctx, at, signal) {
  const changes = ctx.workspaceChanges.summary(at.sessionId, at.seq);
  if (changes === undefined) return fail('Change summary unavailable.', 404);
  const file = Array.isArray(changes.files) ? changes.files[at.index] : undefined;
  if (file === undefined || typeof file.path !== 'string' || file.path.trim() === '') {
    return fail('Changed file not found in this summary.', 404);
  }
  const { absolutePath } = await ctx.workspaceFiles.stat(
    { sessionId: at.sessionId, workspaceRoot: changes.cwd },
    file.path,
    signal
  );
  return { absolutePath };
}

/**
 * 服务一次下载：解析坐标 → 解析主机路径 → 往返核对 → 读字节 → 附件响应。
 * @param {object} ctx - 宿主上下文（connection / sessionQuery / workspaceChanges / workspaceFiles / fs / sandboxPolicy）。
 * @param {Request} request - 已过认证围栏的请求。
 * @param {(ctx: object, at: object, signal: AbortSignal) => Promise<{absolutePath: string} | Response>} resolveTarget
 *   该族路由的目标解析器（present / changes）。
 * @returns {Promise<Response>} 附件响应或带原因的失败响应。
 */
async function serveDownload(ctx, request, resolveTarget) {
  const at = coordinatesOf(request);
  if (at === undefined) return fail('Invalid file coordinates.', 400);

  try {
    // 1) 坐标 → 主机绝对路径（各族路由自己的那一步，照抄官方实现）。
    const resolvedTarget = await resolveTarget(ctx, at, request.signal);
    if (resolvedTarget instanceof Response) return resolvedTarget;
    const { absolutePath } = resolvedTarget;

    // 2) 往返核对：解析出来的目标必须真的落在这一条主机路径上，
    //    避免符号链接之类的错位（与官方 openVerified 同判据）。
    const mapped = ctx.fs.processPathFromHostPath(absolutePath);
    if (mapped === undefined) return fail('Path has no verified Host path.', 422);
    const resolved = await ctx.fs.resolve(mapped, { signal: request.signal });
    if (ctx.fs.processPath(resolved) !== absolutePath) return fail('Path has no verified Host path.', 422);

    // 3) 读字节并以附件返回。
    const bytes = await ctx.fs.readBytes(resolved, request.signal, MAX_BYTES);
    const name = basename(absolutePath);
    return new Response(bytes.slice(), {
      headers: {
        ...noStore(),
        'content-type': contentTypeOf(name),
        'content-length': String(bytes.byteLength),
        'content-disposition': contentDisposition(name),
        'x-content-type-options': 'nosniff',
        // 即便被当成文档打开也只是个沙箱，不执行脚本、不外联。
        'content-security-policy': "sandbox; default-src 'none'"
      }
    });
  } catch (error) {
    if (request.signal.aborted) return fail('Download aborted.', 499);
    const code = failureCodeOf(error);
    const status = FAILURE_STATUSES[code] ?? 500;
    return fail(status === 500 ? 'File download unavailable.' : code, status);
  }
}

/** cordis 插件名。 */
export const name = 'deliverable-download';

/**
 * 需要的服务：认证围栏（connection）、事件回读（sessionQuery）、变更摘要
 * （workspaceChanges）、工作区解析（workspaceFiles）、执行世界文件系统（fs）、
 * 工作区根回退（sandboxPolicy）。
 */
export const inject = ['connection', 'sessionQuery', 'workspaceChanges', 'workspaceFiles', 'fs', 'sandboxPolicy'];

/**
 * 注册两条下载路由。都进 Connection 的认证围栏，所以浏览器必须带会话 Cookie。
 * @param {object} ctx - 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: PRESENT_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => serveDownload(ctx, request, targetOfPresented)
  }), 'deliverable-download: /api/present.download');

  ctx.effect(() => ctx.connection.fetch.register({
    path: CHANGES_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => serveDownload(ctx, request, targetOfChanges)
  }), 'deliverable-download: /api/changes.download');
}

export default { name, inject, apply };
