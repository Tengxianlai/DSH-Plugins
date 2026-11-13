/**
 * Gemini 4 Argon consultant tool for DeepSeek Harness.
 *
 * One tool (`gemini`) over the native Gemini `generateContent` protocol.
 * It is deliberately not a "writing mode": the caller phrases the request in
 * its own words and attaches whatever the question needs — text, images, a
 * PDF, a clip — and Gemini answers as a reader, not as a constrained text
 * factory.
 *
 * The request carries a short, neutral system instruction written here: no
 * Harness identity block and no file-reference paragraph, so the upstream
 * never sees the prompt fingerprint that some Gemini routes use to downgrade
 * agent traffic. Thinking parts are dropped; only the answer comes back.
 *
 * Dependencies are Node built-ins plus the host-provided `dsh-tools`.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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

const SYSTEM = [
  'You can read the text, images, and files in this request.',
  'Answer the question directly and concretely.',
  'Say when something is missing, unreadable, or unclear instead of guessing.',
].join(' ')

const trimSlash = (value) => value.replace(/\/+$/, '')

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

/** Load one attachment as text or inline bytes, labelled with its input path. */
async function loadAttachment(input, cwd, signal) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('files must contain non-empty path or URL strings')
  }
  const source = input.trim()
  let bytes
  let mimeHint
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal })
    if (!response.ok) throw new Error(`cannot read ${source}: HTTP ${response.status}`)
    mimeHint = response.headers.get('content-type') ?? undefined
    bytes = Buffer.from(await response.arrayBuffer())
  } else {
    const path = isAbsolute(source) ? source : resolve(cwd, source)
    try {
      bytes = await readFile(path)
    } catch (error) {
      throw new Error(`cannot read ${source}: ${error.message}`)
    }
  }

  const type = typeOf(source, mimeHint)
  if (type === undefined) {
    throw new Error(
      `unsupported attachment ${source}; use an image (png/jpg/webp/gif/bmp), PDF, mp4/mov/webm, mp3/wav/ogg, or a text file (txt/md/csv/json/srt/yaml/html)`,
    )
  }
  if (type.kind === 'text') {
    const text = bytes.toString('utf8')
    return {
      kind: 'text',
      label: source,
      text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[truncated]` : text,
      bytes: bytes.length,
    }
  }
  return {
    kind: 'inline',
    label: source,
    mimeType: type.mimeType,
    data: bytes.toString('base64'),
    bytes: bytes.length,
  }
}

/**
 * Build the user turn: source text, then each attachment labelled with its
 * path, then the caller's question last. Exported for the self-test.
 */
export async function buildParts(args, cwd, signal) {
  const parts = []
  const source = typeof args.source === 'string' ? args.source : ''
  if (source.trim().length > 0) parts.push({ text: source })

  const files = Array.isArray(args.files) ? args.files : []
  let inlineBytes = 0
  for (const [index, input] of files.entries()) {
    const attachment = await loadAttachment(input, cwd, signal)
    parts.push({ text: `文件 ${index + 1}：${attachment.label}` })
    if (attachment.kind === 'text') {
      parts.push({ text: attachment.text })
      continue
    }
    inlineBytes += attachment.bytes
    if (inlineBytes > MAX_INLINE_BYTES) {
      throw new Error(`attachments exceed the ${MAX_INLINE_BYTES / 1024 / 1024} MB inline limit; attach fewer or smaller files`)
    }
    parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } })
  }

  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (task.length === 0) throw new Error('task must be a non-empty string')
  parts.push({ text: task })
  return parts
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

  const maxTokens = args.max_tokens ?? cfg.maxTokens ?? 16_384
  if (!Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 65_536) {
    throw new Error(`max_tokens must be an integer from 1024 to 65536 (got ${maxTokens})`)
  }

  const parts = await buildParts(args, cwd, signal)
  const base = trimSlash(cfg.baseURL ?? 'https://api.teamorouter.com/v1beta')
  return {
    url: `${base}/models/${MODEL}:generateContent`,
    model: MODEL,
    reasoning,
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

/** Read one Gemini reply; exported for the self-test. */
export function parseResponse(payload) {
  const candidate = payload?.candidates?.[0]
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  const text = parts
    .filter((part) => part !== null && typeof part === 'object' && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')

  const usage = payload?.usageMetadata ?? {}
  return {
    text,
    finishReason: candidate?.finishReason,
    blockReason: payload?.promptFeedback?.blockReason,
    usage: {
      input: usage.promptTokenCount ?? 0,
      output: usage.candidatesTokenCount ?? 0,
      total: usage.totalTokenCount ?? 0,
    },
  }
}

async function post(url, body, key, scheme, signal) {
  const headers = { 'Content-Type': 'application/json' }
  if (scheme === 'goog') headers['x-goog-api-key'] = key
  else headers.Authorization = `Bearer ${key}`
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
}

/** One round trip; returns the parsed reply or throws with the upstream message. */
async function requestOnce(url, body, key, signal) {
  let response = await post(url, body, key, 'bearer', signal)
  if (response.status === 401) {
    // TeamoRouter accepts Bearer on both protocols today, but keep the native
    // Gemini header as a fallback for gateways that only take it.
    response = await post(url, body, key, 'goog', signal)
  }

  const raw = await response.text()
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new Error(`TeamoRouter answered HTTP ${response.status}: ${raw.slice(0, 300)}`)
  }
  if (!response.ok) {
    const message = payload?.error?.message ?? JSON.stringify(payload).slice(0, 300)
    throw new Error(`TeamoRouter ${response.status}: ${message}`)
  }
  return parseResponse(payload)
}

export function apply(ctx, config) {
  const cfg = {
    baseURL: 'https://api.teamorouter.com/v1beta',
    keyRef: 'TEAMOROUTER_API_KEY',
    keyFile: undefined,
    maxTokens: 16_384,
    ...(config ?? {}),
  }

  ctx.tools.register(
    defineTool({
      name: 'gemini',
      description:
        "Ask Gemini 4 Argon about text, images, or files — write, compare, review, or analyze. Attach scene images, storyboards, PDFs, clips, or text by path; Gemini reads them together with the question and answers as text. Phrase the request in your own words; it is not limited to writing.",
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
            'Local paths or http(s) URLs to attach: images, PDF, mp4/mov/webm, mp3/wav/ogg, or text files. Each is labelled with its path so Gemini can refer to it.',
        },
        reasoning: {
          type: 'string',
          enum: Object.keys(LEVELS),
          description: 'Thinking effort. Default medium; low for quick reads, high for dense comparison or analysis.',
        },
        max_tokens: {
          type: 'integer',
          description:
            'Output budget in tokens, 1024 to 65536. Default 16384; thinking tokens count against it, and an exhausted budget is retried once with a larger one.',
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature, 0 to 2. Default 0.7.',
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
            finish_reason: { type: 'string' },
            truncated: { type: 'boolean' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: typeof value?.text === 'string' ? value.text : '' },
        ],
      },
      async execute(args, exec) {
        const key = await resolveKey(ctx, cfg)
        const cwd =
          exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        const { url, body, model, reasoning } = await buildRequest(args, cfg, cwd, exec.signal)

        let parsed = await requestOnce(url, body, key, exec.signal)

        // Thinking tokens share the output budget. A small budget can be spent
        // entirely on thought, leaving finishReason MAX_TOKENS and no text:
        // retry once with a larger budget before reporting failure.
        if (parsed.text.trim().length === 0 && parsed.finishReason === 'MAX_TOKENS') {
          const budget = Math.min(65_536, Math.max(4_096, body.generationConfig.maxOutputTokens * 2))
          const retry = { ...body, generationConfig: { ...body.generationConfig, maxOutputTokens: budget } }
          parsed = await requestOnce(url, retry, key, exec.signal)
        }

        if (parsed.text.trim().length === 0) {
          if (parsed.blockReason) throw new Error(`Gemini blocked the request (${parsed.blockReason})`)
          throw new Error(
            `Gemini returned no text (finishReason ${parsed.finishReason ?? 'unknown'}); thinking tokens count against max_tokens, so raise it or lower reasoning`,
          )
        }

        let text = parsed.text.trim()
        const truncated = text.length > MAX_CHARS
        if (truncated) text = `${text.slice(0, MAX_CHARS)}\n\n[truncated]`

        return {
          text,
          model,
          reasoning,
          input_tokens: parsed.usage.input,
          output_tokens: parsed.usage.output,
          total_tokens: parsed.usage.total,
          ...(parsed.finishReason === undefined ? {} : { finish_reason: parsed.finishReason }),
          ...(truncated ? { truncated: true } : {}),
        }
      },
    }),
  )
}
