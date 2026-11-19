/**
 * 分享状态与目录。
 *
 *   $DSH_HOME/share-hub/sites/<短码>/   只读链接的静态目录（本机服务直接 serve）
 *   $DSH_HOME/share-hub/exports/        导出产物（HTML/MD/PDF），经认证路由下载
 *   $DSH_HOME/share-hub/state.json      分享索引（原子写）
 */

import { mkdir, readFile, rename, rm, writeFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 短码字符集：小写 base36，8 位 ≈ 41 bit。 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * 生成一个短码。
 * @param {number} [length] - 长度。
 * @returns {string} 短码。
 */
export function shortCode(length = 8) {
  const bytes = randomBytes(length)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}

/**
 * 打开状态存储。
 * @param {object} [options] - 参数。
 * @param {string} [options.home] - DSH home，默认 $DSH_HOME 或 ~/.dsh。
 * @returns {object} 存储句柄。
 */
export async function openStore({ home } = {}) {
  const root = join(home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'share-hub')
  const sitesDir = join(root, 'sites')
  const exportsDir = join(root, 'exports')
  const stateFile = join(root, 'state.json')
  await mkdir(sitesDir, { recursive: true })
  await mkdir(exportsDir, { recursive: true })

  let state = { version: 1, items: {} }
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.items === 'object') state = parsed
  } catch {
    // 首次运行或文件损坏：从空状态开始（不覆盖磁盘上已有的 sites）
  }

  /** 原子写索引。 */
  async function persist() {
    const tmp = `${stateFile}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, stateFile)
  }

  /** 找一个新的、磁盘上没占用的短码。 */
  async function allocateId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = shortCode(8)
      if (state.items[id] !== undefined) continue
      try {
        await mkdir(join(sitesDir, id))
        return id
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    throw new Error('无法分配分享短码：连续冲突')
  }

  return {
    root,
    sitesDir,
    exportsDir,
    stateFile,
    state,

    /**
     * 新建一条分享。
     * @param {object} input - {title, sessionId, ttlHours, files, bytes, source}
     * @returns {Promise<object>} 记录。
     */
    async create(input) {
      const id = await allocateId()
      const now = Date.now()
      const ttlHours = input.ttlHours > 0 ? input.ttlHours : 72
      const item = {
        id,
        title: input.title ?? 'DSH 会话',
        sessionId: input.sessionId ?? null,
        createdAt: now,
        expiresAt: now + ttlHours * 3600 * 1000,
        files: input.files ?? 1,
        bytes: input.bytes ?? 0,
        source: input.source ?? 'session'
      }
      state.items[id] = item
      await persist()
      return item
    },

    /**
     * 列出仍有效的分享。
     * @returns {object[]} 记录（新→旧）。
     */
    list() {
      const now = Date.now()
      return Object.values(state.items)
        .filter((item) => item.expiresAt > now)
        .sort((a, b) => b.createdAt - a.createdAt)
    },

    /**
     * 撤销一条分享（删目录 + 索引）。
     * @param {string} id - 短码。
     * @returns {Promise<boolean>} 是否删掉了。
     */
    async revoke(id) {
      if (typeof id !== 'string' || state.items[id] === undefined) return false
      delete state.items[id]
      await persist()
      await rm(join(sitesDir, id), { recursive: true, force: true })
      return true
    },

    /**
     * 清理过期分享。
     * @returns {Promise<number>} 清理条数。
     */
    async sweep() {
      const now = Date.now()
      let dropped = 0
      for (const [id, item] of Object.entries(state.items)) {
        if (item.expiresAt > now) continue
        delete state.items[id]
        await rm(join(sitesDir, id), { recursive: true, force: true })
        dropped += 1
      }
      if (dropped > 0) await persist()
      return dropped
    },

    /**
     * 链接是否仍然有效（服务端每次请求都复核，避免清理延迟导致过期链接可读）。
     * @param {string} id - 短码。
     * @returns {boolean} 是否有效。
     */
    isLive(id) {
      const item = state.items[id]
      return item !== undefined && item.expiresAt > Date.now()
    }
  }
}

/**
 * 列出目录下的文件（给未来的目录分享用，目前只做单页）。
 * @param {string} dir - 目录。
 * @returns {Promise<string[]>} 文件名。
 */
export async function listFiles(dir) {
  try {
    const entries = await readdir(dir)
    return entries
  } catch {
    return []
  }
}

/**
 * 文件大小。
 * @param {string} file - 路径。
 * @returns {Promise<number>} 字节数。
 */
export async function sizeOf(file) {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}
