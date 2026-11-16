/**
 * Thin MiniMax H3 video client: async task create, query, cancel/delete,
 * Context-IR, regeneration, polling and result download.
 *
 * Node built-ins only. The client never logs the API key and surfaces the
 * server's `request_id` on failure, which is what MiniMax support asks for.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export class ApiError extends Error {
  constructor({ status, message, type, requestId, code, ambiguous = false }) {
    super(`${status} ${type ?? 'api_error'}: ${message}${requestId ? ` (request_id ${requestId})` : ''}`)
    this.name = 'ApiError'
    this.status = status
    this.type = type
    this.requestId = requestId
    this.code = code
    /**
     * True when the server may or may not have created/charged the task:
     * transport failures, aborts, 5xx and malformed successful responses. The
     * caller must record such a submission as unknown instead of retrying it.
     */
    this.ambiguous = ambiguous
  }
}

/** Mark a thrown network/client error as a possibly-accepted submission. */
export function markAmbiguous(error) {
  try {
    error.ambiguous = true
  } catch {
    // primitive throwables are wrapped by the caller anyway
  }
  return error
}

function messageOf(payload) {
  const error = payload?.error
  if (typeof error === 'string') return { message: error }
  if (error !== null && typeof error === 'object') {
    return {
      message: typeof error.message === 'string' ? error.message : JSON.stringify(error),
      type: typeof error.type === 'string' ? error.type : undefined,
      code: typeof error.code === 'string' ? error.code : undefined,
    }
  }
  return { message: JSON.stringify(payload).slice(0, 500) }
}

export class MiniMaxVideoClient {
  constructor({ baseURL, key, signal }) {
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.key = key
    this.signal = signal
  }

  async request(method, path, body) {
    let response
    try {
      response = await fetch(`${this.baseURL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: this.signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        markAmbiguous(error)
        throw error
      }
      throw markAmbiguous(new Error(`MiniMax request failed: ${error.message}`))
    }
    const text = await response.text()
    let payload
    try {
      payload = text.length === 0 ? {} : JSON.parse(text)
    } catch {
      throw new ApiError({
        status: response.status,
        message: text.slice(0, 500),
        type: 'non_json_response',
        ambiguous: response.ok || response.status >= 500,
      })
    }
    if (!response.ok) {
      const detail = messageOf(payload)
      throw new ApiError({
        status: response.status,
        message: detail.message,
        type: detail.type,
        code: detail.code,
        requestId: typeof payload?.request_id === 'string' ? payload.request_id : undefined,
        ambiguous: response.status >= 500,
      })
    }
    return payload
  }

  async create(body) {
    return this.request('POST', '/v2/video_generation', body)
  }

  async query(taskId) {
    const payload = await this.request('GET', `/v2/query/video_generation/${encodeURIComponent(taskId)}`)
    return payload?.task ?? payload
  }

  async remove(taskId) {
    return this.request('DELETE', `/v2/video_generation/${encodeURIComponent(taskId)}`)
  }

  async contextIr(body) {
    return this.request('POST', '/v2/h3_context_ir', body)
  }

  async regenerate(body) {
    return this.request('POST', '/v2/video_regeneration', body)
  }
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

function sleep(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Poll a task until it reaches a terminal state or the wait budget expires.
 * A timeout is not an error: the caller gets the live task back so it can report
 * the task id and let the user continue with video_task.
 */
export async function pollTask(client, taskId, { timeoutMs = 900_000, intervalMs = 10_000, signal } = {}) {
  const startedAt = Date.now()
  let task = await client.query(taskId)
  while (!TERMINAL.has(task.status)) {
    if (Date.now() - startedAt >= timeoutMs) return { task, timedOut: true }
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))), signal)
    task = await client.query(taskId)
  }
  return { task, timedOut: false }
}

/** Describe usage in one short line. */
export function describeUsage(task) {
  const usage = task?.usage
  if (usage === null || typeof usage !== 'object') return undefined
  const parts = []
  if (typeof usage.output_seconds === 'number') parts.push(`${usage.output_seconds}s output`)
  if (typeof usage.input_seconds === 'number' && usage.input_seconds > 0) parts.push(`${usage.input_seconds}s input video`)
  if (typeof usage.input_image_count === 'number' && usage.input_image_count > 0) parts.push(`${usage.input_image_count} images`)
  if (typeof usage.input_audio_seconds === 'number' && usage.input_audio_seconds > 0) parts.push(`${usage.input_audio_seconds}s input audio`)
  if (typeof usage.total_tokens === 'number') parts.push(`${usage.total_tokens} tokens`)
  return parts.length === 0 ? undefined : parts.join(', ')
}

function looksLikeMp4(bytes) {
  return bytes.length >= 1024 && bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp'
}

/**
 * Download a finished MP4 and return its path, bytes and hash.
 *
 * `existingFile` lets a retried download for the same task reuse the already
 * saved file after a hash/format check (the result URL is time-limited).
 * New files are opened exclusively: the stem carries the task id plus a random
 * segment, and a rare name collision retries with a suffix instead of
 * overwriting another task's output.
 */
export async function downloadVideo(url, { directory, stem, signal, existingFile }) {
  if (typeof existingFile === 'string' && existingFile.length > 0) {
    try {
      const existing = readFileSync(existingFile)
      if (looksLikeMp4(existing)) {
        return {
          file: existingFile,
          bytes: existing.length,
          sha256: createHash('sha256').update(existing).digest('hex'),
          reused: true,
        }
      }
    } catch {
      // fall through to a fresh download
    }
  }
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`video download answered HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 1024) throw new Error(`video download returned only ${bytes.length} bytes`)
  const branded = bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp'
  if (!branded) throw new Error('downloaded result is not an MP4 (missing ftyp box); the URL may have expired')
  mkdirSync(directory, { recursive: true })
  const safeStem = String(stem ?? 'video').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'video'
  let file
  for (let attempt = 0; attempt < 5 && file === undefined; attempt += 1) {
    const candidate = join(directory, attempt === 0 ? `${safeStem}.mp4` : `${safeStem}-${attempt}.mp4`)
    try {
      writeFileSync(candidate, bytes, { flag: 'wx', mode: 0o600 })
      file = candidate
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  if (file === undefined) throw new Error(`could not allocate a unique download filename for stem ${safeStem}`)
  return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
