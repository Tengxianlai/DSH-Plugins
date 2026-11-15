/**
 * Image generation tool for DeepSeek Harness.
 *
 * One `image_generate` tool over two OpenAI-compatible image backends:
 *   - GPT Image through TeamoRouter (/v1/images/generations and /edits)
 *   - MiniMax H3-Image, standard or Highspeed (same two endpoints)
 *
 * Text-to-image goes through /images/generations; one or more reference images
 * go through /images/edits (edit, combine, keep a subject consistent). Files are
 * saved next to the session and only their paths enter the context.
 *
 * Dependencies are Node built-ins only, so the module can be mounted by file
 * URL without installing a package.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ASPECTS,
  FORMATS,
  MODEL_IDS,
  PROVIDERS,
  QUALITIES,
  catalogText,
  normalizeFormat,
  planSize,
  resolveSelection,
  validateCounts,
  validatePrompt,
  validateQuality,
} from './lib/catalog.js'

export const name = 'image-gen'
export const inject = ['tools', 'workingDirectory', 'credentials']

/**
 * DSH home for the dotenv key fallback.
 *
 * The Desktop host does not inherit the shell-only `DSH_HOME` variable; its
 * environment normally has only HOME. Fall back to the default `~/.dsh` so a
 * key placed in `~/.dsh/secrets/*.env` is found without a credentials-store
 * entry. A configured DSH_HOME always wins.
 */
export function dshHomePath() {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.length > 0) return configured
  return join(process.env.HOME || homedir(), '.dsh')
}

const DEFAULT_CONFIG = {
  defaultProvider: 'gpt',
  baseURL: 'https://api.teamorouter.com/v1',
  keyRef: 'TEAMOROUTER_API_KEY',
  keyFile: undefined,
  defaultModel: 'gpt-image-2.6-sunburst',
  minimaxBaseURL: 'https://api.minimax.cn/v1',
  minimaxKeyRef: 'MINIMAX_API_KEY',
  minimaxKeyFile: undefined,
  minimaxDefaultModel: 'MiniMax-H3-Image',
}

/** Read one key from a dotenv-style file, ignoring comments and blank values. */
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

/** Resolve one provider key: credentials store first, then its dotenv file. */
async function resolveKey(ctx, backend) {
  try {
    const credential = await ctx.credentials.resolve(backend.keyRef)
    if (credential?.value) return credential.value
  } catch {
    // fall through to the dotenv file
  }
  const value = readDotenv(backend.keyFile, backend.keyRef)
  if (value) return value
  throw new Error(`${backend.keyRef} is not available: set it in the credentials store or in ${backend.keyFile}`)
}

/** Load one reference image as a Blob for a multipart edit request. */
async function loadImage(cwd, input, signal) {
  if (/^https?:\/\//i.test(input)) {
    const response = await fetch(input, { signal })
    if (!response.ok) throw new Error(`cannot read reference image ${input}: HTTP ${response.status}`)
    const type = response.headers.get('content-type') ?? 'image/png'
    return new Blob([await response.arrayBuffer()], { type })
  }
  const path = input.startsWith('/') ? input : resolve(cwd, input)
  let bytes
  try {
    bytes = readFileSync(path)
  } catch (error) {
    throw new Error(`cannot read reference image ${input}: ${error.message}`)
  }
  const ext = extname(path.split(/[?#]/)[0]).toLowerCase()
  const type =
    ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.heic' || ext === '.heif'
          ? 'image/heic'
          : 'image/png'
  return new Blob([bytes], { type })
}

function slugOf(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image'
  )
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

/**
 * Sniff the delivered bytes. TeamoRouter's GPT 2.6 path returns PNG even when
 * `output_format: jpeg` is requested, so the file extension must follow the
 * bytes, not the request.
 */
function imageFormatOf(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  return undefined
}

/** JSON body for text-to-image. */
function generationBody(plan, prompt) {
  const body = {
    model: plan.model,
    prompt,
    n: plan.n,
    output_format: plan.format,
  }
  if (plan.provider === 'minimax') {
    // URL avoids the b64_json total-area cap (n up to 10 at 4K) and is
    // downloaded immediately, before the 24-hour link expires.
    body.response_format = 'url'
    if (plan.size !== undefined) {
      body.size = plan.size
    } else {
      body.size = 'auto'
      body.area = plan.area
      body.aspect_ratio = plan.aspectRatio
    }
  } else {
    body.size = plan.size
    body.quality = plan.quality
  }
  return body
}

/** Multipart form for image editing; reference files use repeated `image` fields. */
async function editForm(plan, prompt, images, cwd, signal) {
  const form = new FormData()
  form.append('model', plan.model)
  form.append('prompt', prompt)
  form.append('n', String(plan.n))
  form.append('output_format', plan.format)
  if (plan.provider === 'minimax') {
    form.append('response_format', 'url')
    if (plan.size !== undefined) {
      form.append('size', plan.size)
    } else {
      form.append('size', 'auto')
      form.append('area', plan.area)
      form.append('aspect_ratio', plan.aspectRatio)
    }
  } else {
    form.append('size', plan.size)
    form.append('quality', plan.quality)
    form.append('input_fidelity', 'high')
  }
  // MiniMax reads repeated `image` fields and keeps their order as Picture 1..N;
  // TeamoRouter uses the same shape for GPT edits (verified 2026-11-13/14).
  for (const [index, input] of images.entries()) {
    const blob = await loadImage(cwd, input, signal)
    form.append('image', blob, `image-${index}${extname(input.split(/[?#]/)[0]) || '.png'}`)
  }
  return form
}

/** Decode one item from an images response into bytes. */
async function itemBytes(item, signal) {
  if (typeof item.b64_json === 'string') return Buffer.from(item.b64_json, 'base64')
  if (typeof item.url === 'string') {
    const download = await fetch(item.url, { signal })
    if (!download.ok) throw new Error(`image URL answered HTTP ${download.status}`)
    return Buffer.from(await download.arrayBuffer())
  }
  return undefined
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  const dshHome = dshHomePath()
  const backends = {
    gpt: {
      baseURL: cfg.baseURL,
      keyRef: cfg.keyRef,
      keyFile: cfg.keyFile ?? join(dshHome, PROVIDERS.gpt.keyFile),
      defaultModel: cfg.defaultModel,
    },
    minimax: {
      baseURL: cfg.minimaxBaseURL,
      keyRef: cfg.minimaxKeyRef,
      keyFile: cfg.minimaxKeyFile ?? join(dshHome, PROVIDERS.minimax.keyFile),
      defaultModel: cfg.minimaxDefaultModel,
    },
  }

  ctx.tools.register(defineTool({
    name: 'image_models',
    description:
      'List image providers, models, resolution tiers, capabilities, and the price snapshot used by image_generate. Call it when choosing a provider/model or when cost matters.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute() {
      return { text: catalogText() }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'image_generate',
    description:
      'Generate or edit images with GPT Image (TeamoRouter) or MiniMax H3-Image. Without `images` it draws from the prompt; with `images` (local paths or URLs, up to 16) it edits or combines them, and passing the same reference each time keeps a subject consistent. MiniMax offers a ~16.8MP 4K area at low cost. Saves files and returns their paths; does not put image bytes in the conversation. Call image_models for capabilities and prices.',
    timeoutMs: 900_000,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What to draw, or how to change the images. Up to 32,000 characters.',
      },
      provider: {
        type: 'string',
        enum: ['gpt', 'minimax'],
        description:
          'Backend: gpt (default; TeamoRouter GPT Image 2.x, also Gemini image models) or minimax (MiniMax H3-Image). Inferred from model when model is given.',
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description:
          'Exact model id. Defaults: gpt-image-2.6-sunburst (gpt), MiniMax-H3-Image (minimax). GPT *-4k-upscale variants add 4K detail; MiniMax-H3-Image-Highspeed is faster at about 1.5-2x the standard price. See image_models.',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Reference or source images: local paths or http(s) URLs. One image edits it; several combine them (a subject from each). Up to 16; omit for text-to-image.',
      },
      size: {
        type: 'string',
        description:
          'Resolution tier or explicit WIDTHxHEIGHT. Default 1k. gpt: 1k/2k/4k map to longest side 1024/2048/3840; explicit sizes need multiples of 16, longest <=3840, total 655,360-8,294,400px. minimax: 1k/2k/4k are area tiers (4K = 4096^2); explicit sizes need 655,360-20,000,000px and aspect 1:3-3:1. MiniMax 4K has about 2x GPT 4K pixels.',
      },
      aspect: {
        type: 'string',
        enum: ASPECTS,
        description: 'Shape for tier sizes; ignored with explicit WIDTHxHEIGHT. Default 1:1.',
      },
      quality: {
        type: 'string',
        enum: QUALITIES,
        description:
          'gpt only: auto (default), low, medium, high; higher costs more. minimax has no quality level and accepts only auto.',
      },
      n: {
        type: 'integer',
        description: 'Images per call: 1-4 for gpt, 1-10 for minimax. Default 1.',
      },
      format: {
        type: 'string',
        enum: FORMATS,
        description:
          "png (default), jpeg, webp. MiniMax honors it; GPT models may return PNG regardless. The saved extension and returned format follow the actual bytes.",
      },
      out_dir: {
        type: 'string',
        description: 'Directory for the saved files, relative to the session working directory. Default generated-images.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            required: true,
          },
          provider: { type: 'string', required: true },
          size: { type: 'string', required: true },
          model: { type: 'string', required: true },
          format: { type: 'string' },
          billing_tier: { type: 'string' },
          quality: { type: 'string' },
          revised_prompt: { type: 'string' },
          failed: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        const billed =
          value.billing_tier === undefined
            ? ''
            : ` (${value.provider === 'minimax' ? 'area' : 'billed as'} ${value.billing_tier})`
        const failed =
          value.failed === undefined || value.failed.length === 0
            ? ''
            : `; ${value.failed.length} failed: ${value.failed.join('; ')}`
        return [
          {
            type: 'text',
            text: `Saved ${value.files.length} image(s) at ${value.size}${billed} with ${value.model} via ${value.provider}: ${value.files.join(', ')}${failed}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const cwd =
        exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const selection = resolveSelection({
        provider: args.provider,
        model: args.model,
        defaults: {
          provider: cfg.defaultProvider,
          gpt: backends.gpt.defaultModel,
          minimax: backends.minimax.defaultModel,
        },
      })
      const { provider, model, entry, profile } = selection
      const backend = backends[provider]

      validatePrompt(args.prompt)
      const quality = validateQuality(provider, args.quality)
      const n = args.n ?? 1
      const images = args.images ?? []
      validateCounts(provider, n, images.length)
      const format = args.format ?? 'png'
      const sizePlan = planSize(provider, args.size, args.aspect ?? '1:1')
      const plan = { provider, model, n, format, quality, ...sizePlan }

      const key = await resolveKey(ctx, backend)
      const baseURL = backend.baseURL.replace(/\/$/, '')
      const apiLabel = profile.apiLabel

      let response
      try {
        if (images.length > 0) {
          const form = await editForm(plan, args.prompt, images, cwd, exec.signal)
          response = await fetch(`${baseURL}/images/edits`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: form,
            signal: exec.signal,
          })
        } else {
          response = await fetch(`${baseURL}/images/generations`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(generationBody(plan, args.prompt)),
            signal: exec.signal,
          })
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        throw new Error(`${apiLabel} request failed: ${error.message}`)
      }

      const raw = await response.text()
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        throw new Error(`${apiLabel} answered HTTP ${response.status}: ${raw.slice(0, 300)}`)
      }
      if (!response.ok) {
        const message = payload?.error?.message ?? JSON.stringify(payload).slice(0, 300)
        const itemErrors = Array.isArray(payload?.data)
          ? payload.data
              .filter((item) => item?.error !== undefined)
              .map((item) => `${item.error.code ?? 'error'}: ${item.error.message ?? 'failed'}`)
              .join('; ')
          : ''
        throw new Error(`${apiLabel} ${response.status}: ${message}${itemErrors.length > 0 ? ` (${itemErrors})` : ''}`)
      }

      const items = Array.isArray(payload.data) ? payload.data : []
      if (items.length === 0) throw new Error(`${apiLabel} returned no image`)

      const outDir = args.out_dir === undefined ? join(cwd, 'generated-images') : resolve(cwd, args.out_dir)
      mkdirSync(outDir, { recursive: true })
      const stamp = timestamp()
      const slug = slugOf(args.prompt)
      const responseFormat = normalizeFormat(payload.output_format) ?? format
      const files = []
      const failures = []
      const actualFormats = []
      let actualSize
      let revisedPrompt

      for (const [index, item] of items.entries()) {
        if (item === null || typeof item !== 'object') {
          failures.push(`image ${index + 1}: empty result`)
          continue
        }
        if (item.error !== undefined && item.b64_json === undefined && item.url === undefined) {
          const detail = item.error.message ?? item.error.code ?? 'failed'
          failures.push(`image ${index + 1}: ${detail}`)
          continue
        }
        let bytes
        try {
          bytes = await itemBytes(item, exec.signal)
        } catch (error) {
          failures.push(`image ${index + 1}: ${error.message}`)
          continue
        }
        if (bytes === undefined) {
          failures.push(`image ${index + 1}: no b64_json or url`)
          continue
        }
        const actualFormat = imageFormatOf(bytes) ?? responseFormat
        const ext = actualFormat === 'jpeg' ? 'jpg' : actualFormat
        const file = join(outDir, `${stamp}-${slug}${items.length > 1 ? `-${index + 1}` : ''}.${ext}`)
        writeFileSync(file, bytes)
        files.push(file)
        actualFormats.push(actualFormat)
        if (actualSize === undefined && typeof item.size === 'string') actualSize = item.size
        if (revisedPrompt === undefined && typeof item.revised_prompt === 'string') {
          revisedPrompt = item.revised_prompt
        }
      }

      if (files.length === 0) {
        throw new Error(`${apiLabel} returned no usable image: ${failures.join('; ') || 'empty result'}`)
      }

      // Gemini image models are token-billed, so their size tier is not a
      // billing tier; only report it for per-image GPT models and MiniMax areas.
      const billingTier =
        provider === 'gpt' && entry.pricing.mode === 'token' ? undefined : plan.billingTier

      return {
        files,
        provider,
        size: actualSize ?? plan.size ?? plan.area ?? 'unknown',
        model,
        format: actualFormats[0],
        ...(billingTier === undefined ? {} : { billing_tier: billingTier }),
        ...(quality === undefined ? {} : { quality }),
        ...(revisedPrompt === undefined ? {} : { revised_prompt: revisedPrompt }),
        ...(failures.length === 0 ? {} : { failed: failures }),
      }
    },
  }))
}
