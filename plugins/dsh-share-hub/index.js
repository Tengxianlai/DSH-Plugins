/**
 * dsh-share-hub —— 宿主半体。
 *
 * 两条出口，一套快照：
 *   1) 链接：本机只读服务（127.0.0.1:<port>）+ 既有反代/隧道 → <publicBaseUrl><短码>/
 *   2) 文件：本机生成 HTML / Markdown / PDF → 同源认证路由下发（浏览器存盘 / 桌面端保存对话框）
 *
 * 只读服务不代理 GUI、无写接口；导出产物只写本机目录。
 * 配置项（publicBaseUrl / port / ttlHours / chromiumPath / 内容开关）通过插件设置卡或
 * profile patch 的定向覆盖行提供；publicBaseUrl 等运行时字段改动即时生效，port 变更需重载插件。
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { isAppendSurfaceEvent, deriveEventMessage } from '@deepseek-ai/dsh-session'
import { openStore } from './lib/store.js'
import { startShareServer } from './lib/server.js'
import { normalizeMessages, renderHtml, renderPrintHtml, renderMarkdown, deriveTitle } from './lib/render.js'
import { htmlToPdf, findChromium } from './lib/pdf.js'

export const name = 'share-hub'

/** 需要的宿主服务：认证路由 + 会话日志读取。 */
export const inject = ['connection', 'sessionQuery']

/** 配置默认值（设置卡与运行时共用）。 */
export const DEFAULTS = Object.freeze({
  publicBaseUrl: 'https://dsh.soarteng.cn/s/',
  port: 3099,
  chromiumPath: '',
  ttlHours: 72,
  redact: true,
  includeToolCalls: false,
  includeToolResults: false,
  includeReasoning: false
})

/** 插件配置；volatile 字段会出现在 Plugins → Share Hub 的设置卡里。 */
export const Config = Schema.object({
  publicBaseUrl: Schema.string().default(DEFAULTS.publicBaseUrl).volatile()
    .description('分享链接前缀（反代后的公网地址，例如 https://dsh.example.com/s/）。只读服务仍只监听本机。'),
  port: Schema.natural().min(1).max(65535).default(DEFAULTS.port).volatile()
    .description('本机只读分享服务端口；反代/隧道要指向它。改动后需重新加载插件。'),
  chromiumPath: Schema.string().default(DEFAULTS.chromiumPath).volatile()
    .description('导出 PDF 用的 Chromium/Chrome/Edge 路径；留空自动探测（Playwright 缓存 → 系统浏览器）。'),
  ttlHours: Schema.natural().min(1).max(720).default(DEFAULTS.ttlHours).volatile()
    .description('链接默认有效期（小时）。'),
  redact: Schema.boolean().default(DEFAULTS.redact).volatile()
    .description('导出/分享前脱敏（API key、token、私钥、家目录路径）。'),
  includeToolCalls: Schema.boolean().default(DEFAULTS.includeToolCalls).volatile()
    .description('默认包含工具调用摘要。'),
  includeToolResults: Schema.boolean().default(DEFAULTS.includeToolResults).volatile()
    .description('默认包含工具结果正文。'),
  includeReasoning: Schema.boolean().default(DEFAULTS.includeReasoning).volatile()
    .description('默认包含思考过程。')
})

/** 导出格式 → 扩展名。 */
const FORMAT_EXT = Object.freeze({ html: 'html', markdown: 'md', pdf: 'pdf', md: 'md' })

/** 下载文件名白名单：只认本插件生成的形状。 */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,120}\.(html|md|pdf)$/u

/**
 * 解引用 volatile 叶并补默认值（设置卡写入后是 {get()} 包装）。
 * @param {object} [raw] - 原始 config。
 * @returns {object} 扁平配置。
 */
export function readConfig(raw = {}) {
  const unwrap = (value) => {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function' && Object.keys(value).length === 1) return unwrap(value.get())
    return value
  }
  const flat = {}
  for (const [key, value] of Object.entries(raw ?? {})) flat[key] = unwrap(value)
  return { ...DEFAULTS, ...flat }
}

/**
 * 读一个会话并派生消息。
 * @param {object} ctx - 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<{header:object, messages:object[]}>} 快照。
 */
async function readSession(ctx, sessionId) {
  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  const messages = []
  for (const event of snapshot.events ?? []) {
    if (!isAppendSurfaceEvent(event)) continue
    let message
    try {
      message = deriveEventMessage(event)
    } catch {
      continue
    }
    if (message !== null) messages.push(message)
  }
  return { header: snapshot.session ?? {}, messages }
}

/**
 * 组装渲染文档。
 * @param {object} snapshot - readSession 的结果。
 * @param {string} sessionId - 会话 id。
 * @param {object} options - 标题等。
 * @returns {object} 文档。
 */
function documentOf(snapshot, sessionId, options) {
  const messages = normalizeMessages(snapshot.messages, options)
  const title = typeof options.title === 'string' && options.title.trim() !== ''
    ? options.title.trim()
    : deriveTitle(messages, sessionId)
  return {
    title,
    sessionId,
    cwd: typeof snapshot.header?.cwd === 'string' ? snapshot.header.cwd : undefined,
    exportedAt: Date.now(),
    notice: '内容为导出时快照',
    messages
  }
}

/** 公网前缀补尾斜杠。 */
function withSlash(value) {
  const text = String(value)
  return text.endsWith('/') ? text : `${text}/`
}

/**
 * 插件入口。
 * @param {object} ctx - 宿主上下文。
 * @param {object} [config] - profile patch / 设置卡里的配置。
 */
export function apply(ctx, config = {}) {
  let live = readConfig(config)
  const storeReady = openStore()
  let store

  // 设置卡保存后即时生效（port 除外：只读服务已绑定）。
  ctx.effect(() => ctx.on('loader/volatile-update', () => {
    live = readConfig(config)
    ctx.logger?.info?.('[share-hub] 配置已更新')
  }), 'share-hub: live config')

  const ready = storeReady.then((value) => {
    store = value
    return value
  })

  ctx.effect(() => {
    let closed = false
    let server
    ready.then((value) => startShareServer({
      sitesDir: value.sitesDir,
      port: Number(live.port),
      isLive: (id) => value.isLive(id),
      logger: ctx.logger
    })).then((handle) => {
      if (closed) {
        void handle.close()
        return
      }
      server = handle
      ctx.logger?.info?.(`[share-hub] 分享入口：${withSlash(live.publicBaseUrl)}<短码>/（本机端口 ${handle.port}）`)
    }).catch((error) => {
      ctx.logger?.warn?.(`[share-hub] 只读服务启动失败：${String(error?.message ?? error)}`)
    })
    return () => {
      closed = true
      if (server !== undefined) void server.close()
    }
  }, 'share-hub: readonly server')

  // 每分钟清理过期分享（服务端 isLive 也会复核，清理只是回收磁盘）。
  ctx.effect(() => {
    const timer = setInterval(() => {
      ready.then((value) => value.sweep()).catch(() => {})
    }, 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'share-hub: sweeper')

  /**
   * 注册一条同源路由；跨站请求直接拒绝。
   * @param {string} path - 路由。
   * @param {string[]} methods - 方法。
   * @param {(request: Request) => Promise<Response>} handler - 处理函数。
   */
  const route = (path, methods, handler) => {
    ctx.effect(() => ctx.connection.fetch.register({
      path,
      methods,
      requestBody: 'buffered',
      fetch: async (request) => {
        if (!sameOrigin(request)) return json({ error: 'cross-origin request rejected' }, 403)
        try {
          return await handler(request)
        } catch (error) {
          ctx.logger?.warn?.(`[share-hub] ${path} 失败：${String(error?.message ?? error)}`)
          return json({ error: String(error?.message ?? error) }, 400)
        }
      }
    }), `share-hub: ${path}`)
  }

  route('/api/share-hub/status', ['GET'], async () => {
    const chromium = await findChromium(live.chromiumPath).catch(() => null)
    return json({
      publicBaseUrl: withSlash(live.publicBaseUrl),
      port: Number(live.port),
      chromium,
      ttlHours: Number(live.ttlHours),
      redact: live.redact === true
    })
  })

  route('/api/share-hub/export', ['POST'], async (request) => {
    const body = await readJson(request)
    const sessionId = requireSessionId(body.sessionId)
    const format = String(body.format ?? 'html')
    const extension = FORMAT_EXT[format]
    if (extension === undefined) return json({ error: `不支持的格式：${format}` }, 400)
    const options = optionsOf(live, body.options)
    const snapshot = await readSession(ctx, sessionId)
    const doc = documentOf(snapshot, sessionId, options)
    const base = `${String(sessionId).slice(-12).replace(/[^a-zA-Z0-9-]/gu, '')}-${Date.now().toString(36)}`
    const fileName = `${base}.${extension}`
    const outPath = join((await ready).exportsDir, fileName)
    let bytes
    if (extension === 'pdf') {
      const result = await htmlToPdf({ html: renderPrintHtml(doc), outPath, chromiumPath: live.chromiumPath })
      bytes = result.bytes
    } else if (extension === 'html') {
      const content = renderHtml(doc)
      await writeFile(outPath, content, 'utf8')
      bytes = Buffer.byteLength(content)
    } else {
      const content = renderMarkdown(doc)
      await writeFile(outPath, content, 'utf8')
      bytes = Buffer.byteLength(content)
    }
    return json({ name: fileName, bytes, url: `api/share-hub/download?name=${encodeURIComponent(fileName)}` })
  })

  route('/api/share-hub/download', ['GET'], async (request) => {
    const url = new URL(request.url)
    const fileName = url.searchParams.get('name') ?? ''
    if (!SAFE_NAME.test(fileName)) return new Response('bad name', { status: 400 })
    const exportsDir = (await ready).exportsDir
    const path = join(exportsDir, fileName)
    const info = await stat(path).catch(() => null)
    if (info === null || !info.isFile()) return new Response('not found', { status: 404 })
    const bytes = await readFile(path)
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': contentTypeOf(fileName),
        'Content-Length': String(bytes.length),
        'Content-Disposition': contentDisposition(fileName),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  })

  route('/api/share-hub/link', ['POST'], async (request) => {
    const body = await readJson(request)
    const sessionId = requireSessionId(body.sessionId)
    const options = optionsOf(live, body.options)
    const snapshot = await readSession(ctx, sessionId)
    const doc = documentOf(snapshot, sessionId, options)
    const html = renderHtml(doc)
    const item = await (await ready).create({
      title: doc.title,
      sessionId,
      ttlHours: Number(body.ttlHours ?? live.ttlHours),
      bytes: Buffer.byteLength(html),
      files: 1
    })
    await writeFile(join((await ready).sitesDir, item.id, 'index.html'), html, 'utf8')
    return json({ ...item, url: `${withSlash(live.publicBaseUrl)}${item.id}/` })
  })

  route('/api/share-hub/list', ['GET'], async () => {
    const base = withSlash(live.publicBaseUrl)
    return json({ items: (await ready).list().map((item) => ({ ...item, url: `${base}${item.id}/` })) })
  })

  route('/api/share-hub/revoke', ['POST'], async (request) => {
    const body = await readJson(request)
    const revoked = await (await ready).revoke(String(body.id ?? ''))
    return json({ revoked })
  })

  ctx.provide('shareHub', {
    createSessionShare: async (sessionId, options = {}) => {
      const snapshot = await readSession(ctx, sessionId)
      const doc = documentOf(snapshot, sessionId, optionsOf(live, options))
      const item = await (await ready).create({ title: doc.title, sessionId, ttlHours: options.ttlHours })
      await writeFile(join((await ready).sitesDir, item.id, 'index.html'), renderHtml(doc), 'utf8')
      return { ...item, url: `${withSlash(live.publicBaseUrl)}${item.id}/` }
    },
    list: () => store?.list() ?? [],
    revoke: (id) => store?.revoke(id) ?? Promise.resolve(false)
  })
}

/**
 * 运行时选项：请求里的显式值优先，否则用配置默认。
 * @param {object} live - 当前配置。
 * @param {object} [options] - 请求选项。
 * @returns {object} 渲染选项。
 */
function optionsOf(live, options = {}) {
  const merged = {
    redact: live.redact,
    includeToolCalls: live.includeToolCalls,
    includeToolResults: live.includeToolResults,
    includeReasoning: live.includeReasoning
  }
  for (const key of ['redact', 'includeToolCalls', 'includeToolResults', 'includeReasoning']) {
    if (typeof options?.[key] === 'boolean') merged[key] = options[key]
  }
  if (typeof options?.title === 'string' && options.title.trim() !== '') merged.title = options.title.trim()
  if (Number.isFinite(options?.ttlHours) && options.ttlHours > 0) merged.ttlHours = options.ttlHours
  return merged
}

/**
 * 校验会话 id。
 * @param {unknown} value - 请求里的 sessionId。
 * @returns {string} 合法 id。
 */
function requireSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) throw new Error('sessionId 不合法')
  return value
}

/**
 * 同源判定（与 share-link 的做法一致）：没有 Origin 头视为同源（同源 GET 不带）。
 * @param {Request} request - 请求。
 * @returns {boolean} 是否放行。
 */
function sameOrigin(request) {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  if (origin === null) return true
  if (host === null) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Content-Disposition：非 ASCII 走 filename*，其余字符只留安全子集。
 * @param {string} name - 文件名。
 * @returns {string} 头部值。
 */
function contentDisposition(name) {
  const ascii = name.replace(/[^\u0020-\u007e]/gu, '_').replace(/["\\]/gu, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * 文件名 → Content-Type。
 * @param {string} name - 文件名。
 * @returns {string} MIME。
 */
function contentTypeOf(name) {
  if (name.endsWith('.pdf')) return 'application/pdf'
  if (name.endsWith('.md')) return 'text/markdown; charset=utf-8'
  return 'text/html; charset=utf-8'
}

/**
 * 读 JSON 请求体。
 * @param {Request} request - 请求。
 * @returns {Promise<object>} 负载。
 */
async function readJson(request) {
  const text = await request.text()
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * JSON 响应。
 * @param {unknown} payload - 负载。
 * @param {number} [status] - 状态码。
 * @returns {Response} 响应。
 */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  })
}
