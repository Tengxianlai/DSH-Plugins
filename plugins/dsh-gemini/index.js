/**
 * Gemini 4 Argon consultant tool for DeepSeek Harness.
 *
 * One tool (`gemini`) over the native Gemini `generateContent` protocol.
 * It is deliberately not a "writing mode": the caller phrases the request in
 * its own words and attaches whatever the question needs — text, images, a
 * PDF, a clip — and Gemini answers as a reader, not as a constrained text
 * factory. Gemini is the literary/text specialist here; technical media checks
 * (ASR, frame-by-frame scanning, ffprobe, decode) are local work, and audio or
 * video attachments therefore need a stated purpose and local evidence.
 *
 * The request carries a short, neutral system instruction written here: no
 * Harness identity block and no file-reference paragraph, so the upstream
 * never sees the prompt fingerprint that some Gemini routes use to downgrade
 * agent traffic. Thinking parts are dropped; only the answer comes back.
 *
 * Every HTTP attempt is recorded, including the auth fallback and the single
 * budget retry, so retries and empty-text failures cannot hide their cost.
 *
 * Dependencies are Node built-ins plus the host-provided `dsh-tools`.
 */
import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'gemini'
export const inject = ['tools', 'workingDirectory', 'credentials']

// Fixed on purpose: this tool exists for Argon's reading and writing voice.
// Carbon and Hydrogen are deliberately not reachable from here.
const MODEL = 'gemini-4-argon'

const LEVELS = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' }
const MAX_CHARS = 200_000
// Inline request budget: base64 grows by 4/3, and Gemini's inline limit is
// about 20 MB per request. 12 MB of raw bytes leaves room for text.
const MAX_INLINE_BYTES = 12 * 1024 * 1024
const MAX_TOKENS_CAP = 65_536
const MAX_TOKENS_DEFAULT = 16_384

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
  '.jsonl',
  '.srt',
  '.vtt',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.fountain',
])

const AV_MIME = /^(video|audio)\//
const LIP_SYNC_WORDS = /口型|唇形|嘴型|对白口型|lip[- ]?sync/i

const SYSTEM = [
  'You can read the text, images, and files in this request.',
  'Answer the question directly and concretely.',
  'Say when something is missing, unreadable, or unclear instead of guessing.',
].join(' ')

const LOCAL_MEDIA_HINT =
  'For media, gather local evidence first: ffprobe for streams and timing, ffmpeg to cut the smallest useful segment or sample frames, and a local ASR transcript for dialogue; a subagent can cross-check that evidence. Sampled stills and ASR are evidence only — they cannot prove lip-sync, identity, or performance, and one clip is not a whole-film review.'

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const trimSlash = (value) => value.replace(/\/+$/, '')

/**
 * Drop query and fragment from a URL before it reaches a label or an error:
 * signed URLs carry credentials that must not be echoed or sent to Gemini.
 */
function redactUrl(value) {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return value.split(/[?#]/)[0]
  }
}

/** Read one key from a dotenv file; undefined when the file or key is absent. */
function readDotenv(file, key) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m === null || m[1] !== key) continue
    const value = m[2].replace(/^["']|["']$/g, '').trim()
    if (value.length > 0) return value
  }
  return undefined
}

/** Resolve the gateway key from the credentials provider, then a dotenv file. */
async function resolveKey(ctx, cfg) {
  const ref = cfg.keyRef ?? 'TEAMOROUTER_API_KEY'
  try {
    const credential = await ctx.credentials.resolve(ref)
    if (credential?.value) return credential.value
  } catch {
    // fall through to the dotenv file
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = cfg.keyFile ?? join(home, 'secrets/teamorouter.env')
  const value = readDotenv(file, ref)
  if (value) return value
  throw new Error(`${ref} is not available: set it in the credentials store or in ${file}`)
}

/** Supported type for a path or URL, or undefined when nothing can read it. */
function typeOf(input, mimeHint) {
  const path = /^https?:\/\//i.test(input) ? new URL(input).pathname : input
  const ext = extname(path).toLowerCase()
  if (TEXT_EXT.has(ext)) return { kind: 'text', ext }
  if (MIME[ext] !== undefined) return { kind: 'inline', ext, mimeType: MIME[ext] }
  const hint = (mimeHint ?? '').split(';')[0].trim().toLowerCase()
  if (hint.startsWith('text/') || hint === 'application/json') return { kind: 'text', ext }
  if (hint.startsWith('image/') || hint.startsWith('video/') || hint.startsWith('audio/') || hint === 'application/pdf') {
    return { kind: 'inline', ext, mimeType: hint }
  }
  return undefined
}

function unsupportedError(source) {
  return new Error(
    `unsupported attachment ${source}; use an image (png/jpg/webp/gif/bmp), PDF, mp4/mov/webm, mp3/wav/ogg, or a text file (txt/md/csv/json/srt/yaml/html)`,
  )
}

function tooLargeError(observedBytes, partial = false) {
  const observed = partial ? `stopped after ${mb(observedBytes)} read` : `${mb(observedBytes)} total`
  return new Error(
    `attachments exceed the ${MAX_INLINE_BYTES / 1024 / 1024} MB inline limit (${observed}); no request was sent. ` +
      'For local files the budget is checked from file sizes before any read or base64 encoding; a remote body is streamed and stopped at the limit, never buffered whole first. ' +
      'Attach fewer or smaller files; for a clip, cut the smallest useful segment locally first (e.g. ffmpeg -ss START -t 8 -i input.mp4 -c copy clip.mp4) or extract frames, then check timing and dialogue with ffprobe and a local ASR transcript. ' +
      LOCAL_MEDIA_HINT,
  )
}

/**
 * Inspect attachments without reading their bytes: resolve each source, stat
 * local files, and enforce the inline byte budget before anything is loaded.
 * Exported for the self-test.
 */
export async function planAttachments(files, cwd) {
  const planned = []
  let inlineBytes = 0
  for (const input of files) {
    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new Error('files must contain non-empty path or URL strings')
    }
    const source = input.trim()
    if (/^https?:\/\//i.test(source)) {
      // Remote size is unknown until the body streams in; loadAttachment
      // enforces the cap while reading. The display form drops query/hash so a
      // signed URL never reaches a label, the prompt, or an error.
      const type = typeOf(source)
      planned.push({ source, display: redactUrl(source), remote: true, kind: type?.kind, mimeType: type?.mimeType })
      continue
    }
    const path = isAbsolute(source) ? source : resolve(cwd, source)
    const type = typeOf(source)
    if (type === undefined) throw unsupportedError(source)
    let info
    try {
      info = await stat(path)
    } catch (error) {
      throw new Error(`cannot read ${source}: ${error.message}`)
    }
    if (!info.isFile()) throw new Error(`cannot read ${source}: not a regular file`)
    if (type.kind === 'inline') {
      inlineBytes += info.size
      if (inlineBytes > MAX_INLINE_BYTES) throw tooLargeError(inlineBytes)
    }
    planned.push({
      source,
      remote: false,
      path,
      kind: type.kind,
      bytes: info.size,
      ...(type.mimeType === undefined ? {} : { mimeType: type.mimeType }),
    })
  }
  return { planned, inlineBytes }
}

/**
 * Stream one response body and stop at `limit` bytes. content-length is
 * deliberately not trusted: it can be missing or wrong, so the cap is enforced
 * on the bytes actually read and an oversized body is never buffered whole.
 */
async function readCappedBody(response, limit) {
  const body = response.body
  if (body === null || typeof body?.getReader !== 'function') {
    // Defensive fallback for non-stream responses (mocks, older runtimes); the
    // size is still checked before the bytes are used.
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > limit) throw tooLargeError(bytes.length, true)
    return bytes
  }
  const reader = body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done === true) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw tooLargeError(total, true)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

/**
 * Load one planned attachment as text or inline bytes. Remote bodies are
 * streamed under the remaining inline budget; labels and errors use the
 * redacted URL so credentials in a query string are never echoed.
 */
async function loadAttachment(entry, budget, signal) {
  const label = entry.remote ? entry.display : entry.source
  let bytes
  let type
  if (entry.remote) {
    let response
    try {
      response = await fetch(entry.source, { signal })
    } catch (error) {
      // Strip the full URL in case the runtime echoed it back: a signed URL
      // must not leak through an error message.
      const detail = String(error.message).split(entry.source).join(label)
      throw new Error(`cannot read ${label}: ${detail}`)
    }
    if (!response.ok) throw new Error(`cannot read ${label}: HTTP ${response.status}`)
    type = typeOf(entry.source, response.headers.get('content-type') ?? undefined)
    if (type === undefined) {
      await response.body?.cancel?.()
      throw unsupportedError(label)
    }
    if (type.kind === 'text') {
      bytes = Buffer.from(await response.text(), 'utf8')
    } else {
      bytes = await readCappedBody(response, MAX_INLINE_BYTES - budget.used)
      budget.used += bytes.length
    }
  } else {
    try {
      bytes = await readFile(entry.path)
    } catch (error) {
      throw new Error(`cannot read ${entry.source}: ${error.message}`)
    }
    type = entry.kind === 'text' ? { kind: 'text' } : { kind: 'inline', mimeType: entry.mimeType }
  }

  if (type.kind === 'text') {
    const text = bytes.toString('utf8')
    return {
      kind: 'text',
      label,
      text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[truncated]` : text,
      bytes: bytes.length,
    }
  }
  return {
    kind: 'inline',
    label,
    mimeType: type.mimeType,
    data: bytes.toString('base64'),
    bytes: bytes.length,
  }
}

/**
 * Purpose/local-evidence precheck for audio and video attachments. Images are
 * ordinary review material and are not gated. Returns model-visible notes; a
 * missing purpose or evidence throws with the local workflow to use instead.
 * Exported for the self-test.
 */
export function precheckMedia(args, attachments) {
  const notes = []
  const media = attachments.filter((attachment) => attachment.kind === 'inline' && AV_MIME.test(attachment.mimeType ?? ''))
  if (media.length === 0) return notes

  const purpose = typeof args.media_purpose === 'string' ? args.media_purpose.trim() : ''
  const evidence = typeof args.local_evidence === 'string' ? args.local_evidence.trim() : ''
  const userAsked = args.user_requested_media_review === true

  if (purpose.length === 0) {
    throw new Error(
      'audio/video attachments need media_purpose: one sentence on the integrated judgement only Gemini can make here (performance, pacing, continuity, on-screen action). ' +
        LOCAL_MEDIA_HINT,
    )
  }
  if (evidence.length === 0 && !userAsked) {
    throw new Error(
      'audio/video attachments need local_evidence (paths or a short summary of ffprobe output, trimmed segments, sampled frames, or a local ASR transcript), or user_requested_media_review=true when the user explicitly asked Gemini to look at the clip. ' +
        LOCAL_MEDIA_HINT,
    )
  }

  notes.push(
    'Clip-level reading, not a whole-film review; a stated purpose and local evidence are routing aids, not user or expert acceptance.',
  )
  notes.push(
    'Sampled frames and ASR are evidence only — they cannot prove lip-sync, identity, or performance; have a subagent cross-check automated evidence.',
  )
  const audioOnly = media.every((attachment) => (attachment.mimeType ?? '').startsWith('audio/'))
  if (audioOnly) {
    const text = `${args.task ?? ''}\n${args.source ?? ''}`
    if (LIP_SYNC_WORDS.test(text)) {
      notes.push('The attachment is audio-only; lip-sync and mouth movement need the video segment, not audio.')
    }
  }
  return notes
}

/**
 * Build the user turn: source text, then each attachment labelled with its
 * path, then the caller's question last. Returns the parts plus any media
 * precheck notes. Exported for the self-test.
 */
export async function buildParts(args, cwd, signal) {
  const files = Array.isArray(args.files) ? args.files : []
  const { planned, inlineBytes } = await planAttachments(files, cwd)
  // Known media types are gated before any bytes are read; a remote URL with
  // no usable extension is gated again after its content-type is known.
  const earlyNotes = precheckMedia(args, planned)
  const budget = { used: inlineBytes }
  const loaded = []
  for (const entry of planned) loaded.push(await loadAttachment(entry, budget, signal))
  const notes = [...new Set([...earlyNotes, ...precheckMedia(args, loaded)])]

  const parts = []
  const source = typeof args.source === 'string' ? args.source : ''
  if (source.trim().length > 0) parts.push({ text: source })

  let inlineSeen = 0
  for (const [index, attachment] of loaded.entries()) {
    parts.push({ text: `文件 ${index + 1}：${attachment.label}` })
    if (attachment.kind === 'text') {
      parts.push({ text: attachment.text })
      continue
    }
    inlineSeen += attachment.bytes
    if (inlineSeen > MAX_INLINE_BYTES) throw tooLargeError(inlineSeen)
    parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } })
  }

  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (task.length === 0) throw new Error('task must be a non-empty string')
  parts.push({ text: task })
  return { parts, notes }
}

/** Validate and shape one request; exported so the self-test can inspect it. */
export async function buildRequest(args, cfg = {}, cwd = process.cwd(), signal) {
  const reasoning = args.reasoning ?? 'medium'
  if (LEVELS[reasoning] === undefined) {
    throw new Error(`reasoning must be one of ${Object.keys(LEVELS).join(', ')} (got "${reasoning}")`)
  }

  const temperature = args.temperature ?? 0.7
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`temperature must be a number from 0 to 2 (got ${temperature})`)
  }

  const maxTokens = args.max_tokens ?? cfg.maxTokens ?? MAX_TOKENS_DEFAULT
  if (!Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > MAX_TOKENS_CAP) {
    throw new Error(`max_tokens must be an integer from 1024 to ${MAX_TOKENS_CAP} (got ${maxTokens})`)
  }

  const { parts, notes } = await buildParts(args, cwd, signal)
  const base = trimSlash(cfg.baseURL ?? 'https://api.teamorouter.com/v1beta')
  return {
    url: `${base}/models/${MODEL}:generateContent`,
    model: MODEL,
    reasoning,
    notes,
    body: {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
        thinkingConfig: { thinkingLevel: LEVELS[reasoning] },
      },
    },
  }
}

/** Reported token count, or null when the upstream did not report it. */
function tokenCount(value) {
  return Number.isInteger(value) ? value : null
}

/** Read one Gemini reply; exported for the self-test. */
export function parseResponse(payload) {
  const candidate = payload?.candidates?.[0]
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  const text = parts
    .filter((part) => part !== null && typeof part === 'object' && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')

  // Missing counts stay null: an absent usageMetadata (blocked calls, 401s,
  // proxies) is unknown, not zero, and must not be reported as measured.
  const usage = payload?.usageMetadata ?? {}
  return {
    text,
    finishReason: candidate?.finishReason,
    blockReason: payload?.promptFeedback?.blockReason,
    usage: {
      input: tokenCount(usage.promptTokenCount),
      output: tokenCount(usage.candidatesTokenCount),
      total: tokenCount(usage.totalTokenCount),
      thoughts: tokenCount(usage.thoughtsTokenCount),
    },
  }
}

async function post(url, body, key, scheme, signal) {
  const headers = { 'Content-Type': 'application/json' }
  if (scheme === 'goog') headers['x-goog-api-key'] = key
  else headers.Authorization = `Bearer ${key}`
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
}

/**
 * One network call, recorded into `attempts` whatever its outcome. Returns
 * either `{ parsed }` or `{ error }`; the caller decides whether an error is
 * final or triggers the single auth fallback.
 */
async function sendAttempt(url, body, key, scheme, signal, kind, record) {
  const maxOutputTokens = body?.generationConfig?.maxOutputTokens ?? 0
  let response
  try {
    response = await post(url, body, key, scheme, signal)
  } catch (error) {
    record({ kind, status: 0, max_output_tokens: maxOutputTokens, error: `network error: ${error.message}` })
    throw error
  }
  let raw
  try {
    raw = await response.text()
  } catch (error) {
    record({ kind, status: response.status, max_output_tokens: maxOutputTokens, error: `read failed: ${error.message}` })
    throw error
  }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    const message = `TeamoRouter answered HTTP ${response.status}: ${raw.slice(0, 300)}`
    record({ kind, status: response.status, max_output_tokens: maxOutputTokens, error: message })
    return { status: response.status, error: message }
  }
  if (!response.ok) {
    const message = `TeamoRouter ${response.status}: ${payload?.error?.message ?? JSON.stringify(payload).slice(0, 300)}`
    record({ kind, status: response.status, max_output_tokens: maxOutputTokens, error: message })
    return { status: response.status, error: message }
  }

  const parsed = parseResponse(payload)
  record({
    kind,
    status: response.status,
    max_output_tokens: maxOutputTokens,
    usage: parsed.usage,
    ...(parsed.finishReason === undefined ? {} : { finish_reason: parsed.finishReason }),
  })
  return { status: response.status, parsed }
}

/** One logical round trip: the Bearer request plus at most one auth fallback. */
async function requestOnce(url, body, key, signal, record, kind = 'request') {
  const first = await sendAttempt(url, body, key, 'bearer', signal, kind, record)
  if (first.status === 401) {
    // TeamoRouter accepts Bearer on both protocols today, but keep the native
    // Gemini header as a fallback for gateways that only take it.
    const fallback = await sendAttempt(url, body, key, 'goog', signal, 'auth-fallback', record)
    if (fallback.error !== undefined) throw new Error(fallback.error)
    return fallback.parsed
  }
  if (first.error !== undefined) throw new Error(first.error)
  return first.parsed
}

/**
 * Human-readable cumulative usage for a failure message. Attempts whose token
 * counts were not reported are called out instead of being counted as zero.
 */
function describeUsage(attempts, cumulative) {
  const incomplete = attempts.filter((item) => item.usage_status !== 'measured').length
  const suffix = incomplete === 0 ? '' : ` (${incomplete} attempt(s) with incomplete or unknown usage)`
  return `cumulative usage ${cumulative.input} input, ${cumulative.output} output, ${cumulative.total} total tokens${suffix}`
}

/** Error carrying the attempt log so a failed call still reports its cost. */
function failedAttempts(message, attempts, usageState, cause) {
  const error = new Error(
    `${message} [attempts=${attempts.length}; ${describeUsage(attempts, usageState.cumulative)}]`,
  )
  error.attempts = attempts
  error.usage = {
    ...usageState.cumulative,
    complete: usageState.complete,
    unknown_attempts: usageState.unknownAttempts,
  }
  if (cause !== undefined) error.cause = cause
  return error
}

export function apply(ctx, config) {
  const cfg = {
    baseURL: 'https://api.teamorouter.com/v1beta',
    keyRef: 'TEAMOROUTER_API_KEY',
    keyFile: undefined,
    maxTokens: MAX_TOKENS_DEFAULT,
    ...(config ?? {}),
  }

  ctx.tools.register(
    defineTool({
      name: 'gemini',
      description:
        "Ask Gemini 4 Argon to write or revise scripts, dialogue, narration, and copy, read long documents, or give an integrated judgement on scene images and a short clip. Gemini is the literary/text specialist; technical checks — ASR transcription, frame-by-frame scanning, ffprobe/decode, contact sheets, audio sync — belong to local tools and subagents, and sampled frames or ASR cannot prove lip-sync, identity, or performance. Attaching audio/video requires media_purpose plus local_evidence, unless the user explicitly asked Gemini to view the clip (then set user_requested_media_review). Phrase the request in your own words. Each call pays for exactly one request unless auto_escalate is set; every attempt's usage is returned, missing upstream counts are reported as unknown rather than zero, and the 12 MB inline budget is checked from file sizes before any read.",
      timeoutMs: 600_000,
      parameters: {
        task: {
          type: 'string',
          required: true,
          description:
            'Your question or request in natural language. Say what project this is, what to compare, and what would count as an error; add format or length only when the result needs it.',
        },
        source: {
          type: 'string',
          description:
            'Long text material to read alongside the question: script, transcript, outline, notes. Omit when everything is in `files`.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Local paths or http(s) URLs to attach: images, PDF, mp4/mov/webm, mp3/wav/ogg, or text files. Each is labelled with its path so Gemini can refer to it. The 12 MB total is checked from file sizes before anything is read.',
        },
        reasoning: {
          type: 'string',
          enum: Object.keys(LEVELS),
          description: 'Thinking effort. Default medium; low for quick reads, high for dense comparison or analysis.',
        },
        max_tokens: {
          type: 'integer',
          description:
            'Output budget in tokens, 1024 to 65536. Default 16384; thinking tokens count against it. An exhausted budget is not retried unless auto_escalate is true.',
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature, 0 to 2. Default 0.7.',
        },
        media_purpose: {
          type: 'string',
          description:
            'Required when attaching audio or video: what integrated judgement only Gemini can make here (performance, pacing, continuity, on-screen action) that local evidence cannot answer.',
        },
        local_evidence: {
          type: 'string',
          description:
            'For audio/video: paths or a short summary of the local evidence already gathered — ffprobe output, trimmed segments, sampled frames, local ASR transcript.',
        },
        user_requested_media_review: {
          type: 'boolean',
          description:
            'Set true only when the user explicitly asked Gemini to look at the clip/audio; allows attaching it without local_evidence.',
        },
        auto_escalate: {
          type: 'boolean',
          description:
            'Default false: one call pays for exactly one request. Set true to allow one retry with a doubled budget (capped 65536) when thinking exhausts max_tokens with no text; every attempt is reported.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            model: { type: 'string', required: true },
            reasoning: { type: 'string', required: true },
            input_tokens: { type: 'integer', required: true },
            output_tokens: { type: 'integer', required: true },
            total_tokens: { type: 'integer', required: true },
            usage_complete: { type: 'boolean', required: true },
            unknown_usage_attempts: { type: 'integer', required: true },
            attempt_count: { type: 'integer', required: true },
            attempts: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  attempt: { type: 'integer', required: true },
                  kind: { type: 'string', required: true },
                  status: { type: 'integer', required: true },
                  max_output_tokens: { type: 'integer', required: true },
                  usage_status: { type: 'string', required: true },
                  input_tokens: { type: 'integer' },
                  output_tokens: { type: 'integer' },
                  total_tokens: { type: 'integer' },
                  thought_tokens: { type: 'integer' },
                  finish_reason: { type: 'string' },
                  error: { type: 'string' },
                },
              },
            },
            notes: { type: 'array', items: { type: 'string' } },
            finish_reason: { type: 'string' },
            truncated: { type: 'boolean' },
          },
        },
        render: (_args, value) => {
          const blocks = [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }]
          // The model sees rendered content, not the canonical value, so the
          // usage and evidence notes have to be part of the render to stay
          // visible in the conversation.
          for (const note of Array.isArray(value?.notes) ? value.notes : []) {
            blocks.push({ type: 'text', text: `[note] ${note}` })
          }
          const kinds = [...new Set((value?.attempts ?? []).map((item) => item.kind))].join('/')
          const incomplete = value?.usage_complete === false
            ? `; incomplete usage: ${value.unknown_usage_attempts} attempt(s) unknown`
            : ''
          blocks.push({
            type: 'text',
            text: `[usage] ${value?.attempt_count ?? 0} attempt(s) (${kinds || 'none'}); ${value?.input_tokens ?? 0} input / ${value?.output_tokens ?? 0} output / ${value?.total_tokens ?? 0} total tokens${incomplete}`,
          })
          return blocks
        },
      },
      async execute(args, exec) {
        const key = await resolveKey(ctx, cfg)
        const cwd =
          exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        const { url, body, model, reasoning, notes } = await buildRequest(args, cfg, cwd, exec.signal)

        const attempts = []
        const cumulative = { input: 0, output: 0, total: 0 }
        const usageState = { cumulative, complete: true, unknownAttempts: 0 }
        const record = (entry) => {
          // `usage` is null for failures with no usageMetadata; individual
          // counts may also be missing. Sum only measured values and label the
          // rest instead of silently counting them as zero.
          const usage = entry.usage ?? {}
          const measuredInput = Number.isInteger(usage.input)
          const measuredOutput = Number.isInteger(usage.output)
          const measuredTotal = Number.isInteger(usage.total)
          const measured = measuredInput && measuredOutput && measuredTotal
          const anyKnown = measuredInput || measuredOutput || measuredTotal
          const usageStatus = measured ? 'measured' : anyKnown ? 'partial' : 'unknown'
          if (usageStatus === 'unknown') usageState.unknownAttempts += 1
          if (usageStatus !== 'measured') usageState.complete = false
          if (measuredInput) cumulative.input += usage.input
          if (measuredOutput) cumulative.output += usage.output
          if (measuredTotal) cumulative.total += usage.total
          attempts.push({
            attempt: attempts.length + 1,
            kind: entry.kind,
            status: entry.status,
            max_output_tokens: entry.max_output_tokens,
            usage_status: usageStatus,
            ...(measuredInput ? { input_tokens: usage.input } : {}),
            ...(measuredOutput ? { output_tokens: usage.output } : {}),
            ...(measuredTotal ? { total_tokens: usage.total } : {}),
            ...(Number.isInteger(usage.thoughts) && usage.thoughts > 0 ? { thought_tokens: usage.thoughts } : {}),
            ...(entry.finish_reason === undefined ? {} : { finish_reason: entry.finish_reason }),
            ...(entry.error === undefined ? {} : { error: entry.error.slice(0, 240) }),
          })
        }

        let parsed
        try {
          parsed = await requestOnce(url, body, key, exec.signal, record)
        } catch (error) {
          throw failedAttempts(error.message, attempts, usageState, error)
        }

        // Thinking tokens share the output budget. A small budget can be spent
        // entirely on thought, leaving finishReason MAX_TOKENS and no text.
        // Escalation is opt-in: by default one call pays for one request. When
        // enabled it is one retry with a doubled budget, capped at 65536, and
        // both attempts stay visible in `attempts`.
        if (parsed.text.trim().length === 0 && parsed.finishReason === 'MAX_TOKENS' && args.auto_escalate === true) {
          const current = body.generationConfig.maxOutputTokens
          const budget = Math.min(MAX_TOKENS_CAP, Math.max(4_096, current * 2))
          if (budget > current) {
            const retry = { ...body, generationConfig: { ...body.generationConfig, maxOutputTokens: budget } }
            try {
              parsed = await requestOnce(url, retry, key, exec.signal, record, 'budget-retry')
            } catch (error) {
              throw failedAttempts(error.message, attempts, usageState, error)
            }
          }
        }

        if (parsed.text.trim().length === 0) {
          if (parsed.blockReason) {
            throw failedAttempts(`Gemini blocked the request (${parsed.blockReason})`, attempts, usageState)
          }
          throw failedAttempts(
            `Gemini returned no text (finishReason ${parsed.finishReason ?? 'unknown'}); thinking tokens count against max_tokens, so raise max_tokens, lower reasoning, or set auto_escalate=true for one budget-doubling retry`,
            attempts,
            usageState,
          )
        }

        let text = parsed.text.trim()
        const truncated = text.length > MAX_CHARS
        if (truncated) text = `${text.slice(0, MAX_CHARS)}\n\n[truncated]`

        return {
          text,
          model,
          reasoning,
          input_tokens: cumulative.input,
          output_tokens: cumulative.output,
          total_tokens: cumulative.total,
          usage_complete: usageState.complete,
          unknown_usage_attempts: usageState.unknownAttempts,
          attempt_count: attempts.length,
          attempts,
          ...(notes.length === 0 ? {} : { notes }),
          ...(parsed.finishReason === undefined ? {} : { finish_reason: parsed.finishReason }),
          ...(truncated ? { truncated: true } : {}),
        }
      },
    }),
  )
}
