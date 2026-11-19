/**
 * 只读分享服务：只绑回环，只认 `GET /s/<短码>/…`。
 *
 * 对外由宿主机既有反代/隧道挂到 https://<域名>/s/<短码>/。
 * 无写接口、无目录列表、不代理 DSH GUI（3080）。
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** 扩展名 → Content-Type。 */
const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2'
})

/** 只读页面的安全响应头。 */
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"
})

/**
 * 启动只读服务。
 * @param {object} options - 参数。
 * @param {string} options.sitesDir - 分享目录根。
 * @param {number} [options.port] - 端口，0 表示随机；被占用时自动退到随机端口。
 * @param {(id: string) => boolean} options.isLive - 短码是否仍有效。
 * @param {object} [options.logger] - 宿主 logger。
 * @returns {Promise<{port:number, close:() => Promise<void>}>} 服务句柄。
 */
export async function startShareServer({ sitesDir, port = 3099, isLive, logger }) {
  const server = createServer(async (request, response) => {
    try {
      await handle(request, response, { sitesDir, isLive })
    } catch (error) {
      logger?.warn?.(`[share-hub] 服务请求失败：${String(error?.message ?? error)}`)
      send(response, 500, 'text/plain; charset=utf-8', 'internal error')
    }
  })

  const listen = (candidate) => new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolvePromise(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(candidate, '127.0.0.1')
  })

  let actual
  try {
    actual = await listen(port)
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error
    logger?.warn?.(`[share-hub] 端口 ${port} 被占用，改用随机端口`)
    actual = await listen(0)
  }
  logger?.info?.(`[share-hub] 只读分享服务监听 127.0.0.1:${actual}`)

  return {
    port: actual,
    close: () => new Promise((resolvePromise) => {
      server.close(() => resolvePromise())
      server.closeAllConnections?.()
    })
  }
}

/**
 * 处理一个请求。
 * @param {import('node:http').IncomingMessage} request - 请求。
 * @param {import('node:http').ServerResponse} response - 响应。
 * @param {object} context - {sitesDir, isLive}。
 * @returns {Promise<void>} 完成。
 */
async function handle(request, response, context) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'text/plain; charset=utf-8', 'method not allowed')
    return
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/healthz') {
    send(response, 200, 'application/json; charset=utf-8', '{"ok":true}')
    return
  }
  const match = url.pathname.match(/^\/s\/([a-z0-9]{6,16})(?:\/(.*))?$/u)
  if (match === null) {
    send(response, 404, 'text/plain; charset=utf-8', 'not found')
    return
  }
  const id = match[1]
  if (!context.isLive(id)) {
    send(response, 404, 'text/plain; charset=utf-8', 'not found')
    return
  }
  const base = resolve(join(context.sitesDir, id))
  let relative = match[2] === undefined || match[2] === '' ? 'index.html' : decodeURIComponent(match[2])
  if (relative.endsWith('/')) relative += 'index.html'
  const target = resolve(base, relative)
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    send(response, 403, 'text/plain; charset=utf-8', 'forbidden')
    return
  }
  let info
  try {
    info = await stat(target)
  } catch {
    send(response, 404, 'text/plain; charset=utf-8', 'not found')
    return
  }
  if (info.isDirectory()) {
    send(response, 404, 'text/plain; charset=utf-8', 'not found')
    return
  }
  const extension = target.slice(target.lastIndexOf('.'))
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': String(info.size),
    'Cache-Control': 'no-store'
  }
  response.writeHead(200, headers)
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(target).pipe(response)
}

/**
 * 发一个短响应。
 * @param {import('node:http').ServerResponse} response - 响应。
 * @param {number} status - 状态码。
 * @param {string} type - Content-Type。
 * @param {string} body - 正文。
 */
function send(response, status, type, body) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS })
  response.end(body)
}
