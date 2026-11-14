/**
 * Claude Opus 5.5 outside-expert tool for DeepSeek Harness.
 *
 * One tool (`claude`) plus one model-invocable skill (`external-expert`).
 * The tool is a consultation line, not a general chat endpoint: the caller
 * briefs an independent expert with the problem, what it already tried, and
 * the materials that matter — text, images, PDFs — and gets a second opinion
 * back as text.
 *
 * Two things are deliberate:
 *
 * 1. Extended reasoning is always on. The tool maps low/medium/high to an
 *    explicit `thinking.budget_tokens`; there is no "fast answer" mode,
 *    because this line exists for problems that deserve thought.
 *
 * 2. Prompt caching is on by default. The system instruction and the stable
 *    briefing (source + attachments) carry `cache_control` breakpoints, while
 *    the task stays after the last breakpoint. Repeating the same brief then
 *    reads the cached prefix instead of paying for it again. The 1-hour TTL is
 *    the default because an outside expert is usually consulted more than
 *    once; pass `cache_ttl: '5m'` for a genuinely one-off call.
 *
 * Dependencies are Node built-ins plus the host-provided `dsh-tools`.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'claude'
export const inject = ['tools', 'workingDirectory', 'credentials', 'skills']

// Fixed on purpose: this tool is the outside-expert line, not a model switcher.
const MODEL = 'claude-opus-5-5'

// `budget_tokens` for extended thinking. The answer budget is added on top;
// thinking tokens count against `max_tokens`, so a max_tokens at or below the
// budget would leave no room for the answer.
const LEVELS = { low: 2_048, medium: 8_192, high: 16_384 }
const DEFAULT_REASONING = 'high'
const MAX_OUTPUT = 32_000
const MIN_OUTPUT = 1_024

const CACHE_TTLS = ['5m', '1h']
const DEFAULT_CACHE_TTL = '1h'
const CACHE_BETA = 'extended-cache-ttl-2025-04-11'

const MAX_CHARS = 200_000
const MAX_TOTAL_TEXT = 400_000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PDF_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

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
  '.log',
])

// A stable, brand-free expert instruction. It is the first cache breakpoint:
// identical on every call, so its tokens are written once and read afterwards.
const SYSTEM = [
  'You are an outside expert consulted by another AI agent that is working on a real task.',
  'You see the problem, the context, and any attached materials.',
  'Give a direct, concrete answer: a recommendation, the reasoning that actually matters, and the next checks.',
  'Separate what the materials establish from what you infer; say plainly when evidence is missing.',
  'If the agent\'s attempt is wrong, say where and why. Do not invent file contents, citations, results, or constraints.',
].join(' ')

const CACHE_MARKER = '以上是本次咨询的固定背景。'

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
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (match === null || match[1] !== key) continue
    const value = match[2].replace(/^["']|["']$/g, '').trim()
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

/**
 * Type of a path or URL, or undefined when nothing can read it.
 * URLs are judged by their pathname first and the response Content-Type next.
 */
function typeOf(input, mimeHint) {
  const path = /^https?:\/\//i.test(input) ? new URL(input).pathname : input
  const ext = extname(path).toLowerCase()
  if (TEXT_EXT.has(ext)) return { kind: 'text', ext }
  if (IMAGE_MIME[ext] !== undefined) return { kind: 'image', ext, mimeType: IMAGE_MIME[ext] }
  if (ext === '.pdf') return { kind: 'pdf', ext, mimeType: 'application/pdf' }

  const hint = (mimeHint ?? '').split(';')[0].trim().toLowerCase()
  if (hint.startsWith('text/') || hint === 'application/json') return { kind: 'text', ext }
  if (hint === 'image/jpg') return { kind: 'image', ext, mimeType: 'image/jpeg' }
  if (SUPPORTED_IMAGE_MIME.has(hint)) {
    return { kind: 'image', ext, mimeType: hint }
  }
  if (hint === 'application/pdf') return { kind: 'pdf', ext, mimeType: 'application/pdf' }
  return undefined
}

/** Load one attachment as text, an image block, or a PDF document block. */
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
      `unsupported attachment ${source}; Claude can read images (png/jpg/webp/gif), PDFs, and text files (txt/md/csv/json/srt/yaml/html/fountain/log)`,
    )
  }
  if (type.kind === 'text') {
    return { kind: 'text', label: source, text: bytes.toString('utf8'), bytes: bytes.length }
  }
  if (type.kind === 'image') {
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`${source} is larger than the 5 MB image limit (${bytes.length} bytes)`)
    }
    return {
      kind: 'image',
      label: source,
      mimeType: type.mimeType,
      data: bytes.toString('base64'),
      bytes: bytes.length,
    }
  }
  if (bytes.length > MAX_PDF_BYTES) {
    throw new Error(`${source} is larger than the 20 MB PDF limit (${bytes.length} bytes)`)
  }
  return {
    kind: 'pdf',
    label: source,
    mimeType: 'application/pdf',
    data: bytes.toString('base64'),
    bytes: bytes.length,
  }
}

/** Cache-control marker for one TTL; 5m is the API default and carries no ttl. */
function cacheControl(ttl) {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
}

/**
 * Build the stable briefing blocks: source, labelled attachments, then a text
 * marker that carries the second cache breakpoint. The task is appended by the
 * caller after this marker so a new question does not invalidate the cache.
 */
async function buildBriefing(args, cwd, signal) {
  const blocks = []
  let textBudget = MAX_TOTAL_TEXT
  const takeText = (text) => {
    if (textBudget <= 0) return '[truncated: text budget exhausted]'
    const allowed = Math.min(textBudget, MAX_CHARS, text.length)
    const slice = text.slice(0, allowed)
    textBudget -= allowed
    return allowed < text.length ? `${slice}\n\n[truncated]` : slice
  }

  const source = typeof args.source === 'string' ? args.source : ''
  if (source.trim().length > 0) blocks.push({ type: 'text', text: takeText(source) })

  const files = Array.isArray(args.files) ? args.files : []
  let totalBytes = 0
  for (const [index, input] of files.entries()) {
    const attachment = await loadAttachment(input, cwd, signal)
    blocks.push({ type: 'text', text: `文件 ${index + 1}：${attachment.label}` })
    if (attachment.kind === 'text') {
      blocks.push({ type: 'text', text: takeText(attachment.text) })
      continue
    }
    totalBytes += attachment.bytes
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `attachments exceed the ${MAX_TOTAL_BYTES / 1024 / 1024} MB inline limit; attach fewer or smaller files`,
      )
    }
    if (attachment.kind === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data },
      })
    } else {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data },
      })
    }
  }
  return blocks
}

/**
 * Validate and shape one request. Exported so the self-test can inspect the
 * exact wire shape without a network call.
 */
export async function buildRequest(args, cfg = {}, cwd = process.cwd(), signal) {
  const reasoning = args.reasoning ?? cfg.defaultReasoning ?? DEFAULT_REASONING
  const thinkingBudget = LEVELS[reasoning]
  if (thinkingBudget === undefined) {
    throw new Error(`reasoning must be one of ${Object.keys(LEVELS).join(', ')} (got "${reasoning}")`)
  }

  const defaultMax = Math.min(MAX_OUTPUT, thinkingBudget + 8_192)
  const maxTokens = args.max_tokens ?? defaultMax
  if (!Number.isInteger(maxTokens) || maxTokens < MIN_OUTPUT || maxTokens > MAX_OUTPUT) {
    throw new Error(`max_tokens must be an integer from ${MIN_OUTPUT} to ${MAX_OUTPUT} (got ${maxTokens})`)
  }
  const minimumForAnswer = Math.min(MAX_OUTPUT, thinkingBudget + MIN_OUTPUT)
  if (maxTokens < minimumForAnswer) {
    throw new Error(
      `max_tokens must be at least ${minimumForAnswer} for reasoning ${reasoning}: the ${thinkingBudget}-token thinking budget also counts against it`,
    )
  }

  const cacheTTL = args.cache_ttl ?? cfg.cacheTTL ?? DEFAULT_CACHE_TTL
  if (!CACHE_TTLS.includes(cacheTTL)) {
    throw new Error(`cache_ttl must be one of ${CACHE_TTLS.join(', ')} (got "${cacheTTL}")`)
  }

  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (task.length === 0) throw new Error('task must be a non-empty string')
  if (task.length > MAX_CHARS) {
    throw new Error(`task is longer than ${MAX_CHARS} characters; move the long material into source or files`)
  }

  const content = await buildBriefing(args, cwd, signal)
  if (content.length > 0) {
    content.push({ type: 'text', text: CACHE_MARKER, cache_control: cacheControl(cacheTTL) })
  }
  content.push({ type: 'text', text: task })

  const base = trimSlash(cfg.baseURL ?? 'https://api.teamorouter.com/v1')
  return {
    url: `${base}/messages`,
    model: MODEL,
    reasoning,
    thinkingBudget,
    maxTokens,
    cacheTTL,
    beta: cacheTTL === '1h' ? [CACHE_BETA] : [],
    body: {
      model: MODEL,
      max_tokens: maxTokens,
      thinking: { type: 'enabled', budget_tokens: thinkingBudget },
      system: [{ type: 'text', text: SYSTEM, cache_control: cacheControl(cacheTTL) }],
      messages: [{ role: 'user', content }],
    },
  }
}

/** Read one Anthropic-format reply; thinking blocks are dropped. */
export function parseResponse(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : []
  const text = blocks
    .filter(
      (block) =>
        block !== null &&
        typeof block === 'object' &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('')

  const usage = payload?.usage ?? {}
  return {
    text,
    model: typeof payload?.model === 'string' ? payload.model : MODEL,
    finishReason: payload?.stop_reason,
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
    },
  }
}

/** One HTTP POST in one auth style. */
async function post(url, body, key, scheme, beta, signal) {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (beta.length > 0) headers['anthropic-beta'] = beta.join(',')
  if (scheme === 'bearer') headers.authorization = `Bearer ${key}`
  else headers['x-api-key'] = key
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
}

/**
 * One round trip; returns the parsed reply or throws with the upstream message.
 * TeamoRouter accepts Bearer, but the native Anthropic `x-api-key` header is
 * kept as a fallback for gateways that only take it.
 */
async function requestOnce(url, body, key, beta, signal) {
  let response = await post(url, body, key, 'bearer', beta, signal)
  if (response.status === 401 || response.status === 403) {
    response = await post(url, body, key, 'apikey', beta, signal)
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

/** Register the `claude` tool and the `external-expert` skill. */
export function apply(ctx, config) {
  const cfg = {
    baseURL: 'https://api.teamorouter.com/v1',
    keyRef: 'TEAMOROUTER_API_KEY',
    keyFile: undefined,
    cacheTTL: DEFAULT_CACHE_TTL,
    defaultReasoning: DEFAULT_REASONING,
    ...(config ?? {}),
  }

  ctx.tools.register(
    defineTool({
      name: 'claude',
      description:
        "Consult an outside expert: Claude Opus 5.5 with extended reasoning. Use it when a problem is genuinely hard or high-stakes, after you have been corrected or refuted more than once, when you are stuck and do not know the next step, or when the user asks for Claude, a second opinion, or an outside expert. Brief it fully in `source` (what you tried, the errors, the constraints) and attach text, images, or PDFs in `files`. Prompt caching is on: repeating the same brief reuses the cached prefix.",
      timeoutMs: 900_000,
      parameters: {
        task: {
          type: 'string',
          required: true,
          description:
            'The question you want the expert to decide or review. State the goal, the constraints, and what would count as a good answer. Put supporting material in source/files, not here.',
        },
        source: {
          type: 'string',
          description:
            'The brief: what you already tried, the exact errors or refutations, relevant code/logs, and constraints. This is the stable cached prefix, so repeat it verbatim across follow-up questions.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Local paths or http(s) URLs to attach: images (png/jpg/webp/gif), PDFs, and text files. Each is labelled with its path so the expert can refer to it. Audio and video are not supported.',
        },
        reasoning: {
          type: 'string',
          enum: Object.keys(LEVELS),
          description:
            'Thinking budget: low (2048), medium (8192), high (16384, default). Extended thinking is always on; high is the right default for the problems this line exists for.',
        },
        max_tokens: {
          type: 'integer',
          description:
            'Total output budget, 1024-32000. Thinking tokens count against it, so it must exceed the thinking budget. Defaults to budget + 8192.',
        },
        cache_ttl: {
          type: 'string',
          enum: CACHE_TTLS,
          description:
            "Cache lifetime: 1h (default; better when the same brief will be reused in a long session) or 5m (cheaper first write for a one-off call). Task text after the briefing is never cached.",
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
            thinking_budget: { type: 'integer', required: true },
            max_tokens: { type: 'integer', required: true },
            input_tokens: { type: 'integer', required: true },
            uncached_input_tokens: { type: 'integer', required: true },
            output_tokens: { type: 'integer', required: true },
            cache_write_tokens: { type: 'integer', required: true },
            cache_read_tokens: { type: 'integer', required: true },
            cache_ttl: { type: 'string', required: true },
            cache_hit: { type: 'boolean', required: true },
            finish_reason: { type: 'string' },
            truncated: { type: 'boolean' },
          },
        },
        render: (_args, value) => {
          const body = typeof value?.text === 'string' ? value.text : ''
          const cache =
            value.cache_read_tokens > 0
              ? `cache read ${value.cache_read_tokens} / write ${value.cache_write_tokens}`
              : `cache write ${value.cache_write_tokens} / read 0`
          const input =
            value.uncached_input_tokens === value.input_tokens
              ? `in ${value.input_tokens}`
              : `in ${value.input_tokens} (new ${value.uncached_input_tokens})`
          const footer = `[${value.model} · ${value.reasoning} · ${input} / out ${value.output_tokens} · ${cache}]`
          return [{ type: 'text', text: `${body}\n\n${footer}` }]
        },
      },
      async execute(args, exec) {
        const key = await resolveKey(ctx, cfg)
        const cwd =
          exec.agent === undefined
            ? process.cwd()
            : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        const request = await buildRequest(args, cfg, cwd, exec.signal)

        let parsed = await requestOnce(request.url, request.body, key, request.beta, exec.signal)
        let maxTokens = request.maxTokens

        // Thinking tokens share the output budget. If thought consumes all of
        // it, the reply can be empty with stop_reason=max_tokens: retry once
        // with a larger budget before reporting failure.
        if (parsed.text.trim().length === 0 && parsed.finishReason === 'max_tokens') {
          const budget = Math.min(MAX_OUTPUT, Math.max(maxTokens * 2, request.thinkingBudget + 4_096))
          if (budget > maxTokens) {
            const retry = { ...request.body, max_tokens: budget }
            parsed = await requestOnce(request.url, retry, key, request.beta, exec.signal)
            maxTokens = budget
          }
        }

        if (parsed.text.trim().length === 0) {
          if (parsed.finishReason === 'refusal') {
            throw new Error('Claude declined this request; rephrase the task or remove the material that triggered the refusal')
          }
          throw new Error(
            `Claude returned no text (stop_reason ${parsed.finishReason ?? 'unknown'}); raise max_tokens or lower reasoning`,
          )
        }

        let text = parsed.text.trim()
        const truncated = text.length > MAX_CHARS
        if (truncated) text = `${text.slice(0, MAX_CHARS)}\n\n[truncated]`

        // `usage.input_tokens` only counts the uncached part. Report the whole
        // prompt (uncached + cache write + cache read) as input_tokens so the
        // number is comparable with other model tools, and keep the API's
        // uncached figure separately.
        const totalInput = parsed.usage.input + parsed.usage.cacheWrite + parsed.usage.cacheRead

        return {
          text,
          model: parsed.model,
          reasoning: request.reasoning,
          thinking_budget: request.thinkingBudget,
          max_tokens: maxTokens,
          input_tokens: totalInput,
          uncached_input_tokens: parsed.usage.input,
          output_tokens: parsed.usage.output,
          cache_write_tokens: parsed.usage.cacheWrite,
          cache_read_tokens: parsed.usage.cacheRead,
          cache_ttl: request.cacheTTL,
          cache_hit: parsed.usage.cacheRead > 0,
          ...(parsed.finishReason === undefined ? {} : { finish_reason: parsed.finishReason }),
          ...(truncated ? { truncated: true } : {}),
        }
      },
    }),
  )

  ctx.skills.registerProvider(() => skillProvider)
}

const SKILL_NAME = 'external-expert'
const SKILL_PROVIDER = 'claude-expert'
const SKILL_BODY_URL = new URL('./assets/external-expert.md', import.meta.url)
const SKILL_RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('./assets/', import.meta.url)),
}

// BUNDLED_SKILL_RANK in @deepseek-ai/dsh-skill is 600. Kept as a literal so
// this plugin needs no runtime import beyond Node built-ins; any value is a
// precedence hint, and no shipped skill uses this name.
const SKILL_RANK = 600

const SKILL_DESCRIPTION =
  'Use when a problem is genuinely hard or high-stakes, when your answer has been corrected or refuted more than once, when you are stuck and do not know the next step, or when the user asks for Claude, an outside expert, or a second opinion. Routes a fully briefed question to Claude Opus 5.5 with extended reasoning and prompt caching; accepts text, images, and PDFs. Chinese triggers: 专业难度大、多次被反驳或出错、迷茫不知道怎么办、用户指定问 Claude 或外场/场外专家。'

const SKILL_CANDIDATE = {
  name: SKILL_NAME,
  description: SKILL_DESCRIPTION,
  invocation: { modelInvocable: true, userInvocable: true },
  provider: SKILL_PROVIDER,
  source: 'custom',
  resourceBase: SKILL_RESOURCE_BASE,
  rank: SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const skillProvider = {
  name: SKILL_PROVIDER,
  list: () => Promise.resolve([SKILL_CANDIDATE]),
  async get() {
    return {
      name: SKILL_CANDIDATE.name,
      description: SKILL_CANDIDATE.description,
      invocation: SKILL_CANDIDATE.invocation,
      provider: SKILL_CANDIDATE.provider,
      source: SKILL_CANDIDATE.source,
      resourceBase: SKILL_RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}
