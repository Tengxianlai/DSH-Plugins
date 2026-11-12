/**
 * TeamoRouter image generation tool for DeepSeek Harness.
 *
 * One compact tool (`image_generate`) over the OpenAI-compatible Images API:
 * text-to-image through /v1/images/generations, and image-to-image (edit,
 * combine, keep a subject consistent) through /v1/images/edits when
 * `images` is given. Saves PNG/JPEG/WebP files next to the session and
 * returns their paths, instead of streaming image bytes into the context.
 *
 * Dependencies are Node built-ins only, so the module can be mounted by file
 * URL without installing a package.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'image-gen'
export const inject = ['tools', 'workingDirectory', 'credentials']

const TIERS = { '1k': 1024, '2k': 2048, '4k': 3840 }
const STEP = 16
const MIN_PIXELS = 655360
const MAX_PIXELS = 8294400
const MAX_SIDE = 3840

const MODELS = [
  'gpt-image-2.6-sunburst',
  'gpt-image-2.6-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
  'gpt-image-2',
  'gpt-image-2.6-sunburst-4k-upscale',
  'gpt-image-2.6-flare-4k-upscale',
  'gpt-image-2.5-sunburst-4k-upscale',
  'gpt-image-2.5-flare-4k-upscale',
  'gpt-image-2-4k-upscale',
  'gemini-3-pro-image',
  'gemini-3.1-flash-image',
]

const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']
const FORMATS = ['png', 'jpeg', 'webp']

const round16 = (n) => Math.max(STEP, Math.round(n / STEP) * STEP)
const floor16 = (n) => Math.max(STEP, Math.floor(n / STEP) * STEP)

/** Size the upstream accepts: both sides multiples of 16, longest ≤ 3840, pixels inside [655360, 8294400]. */
function sizeFor(tier, aspect) {
  const [aw, ah] = aspect.split(':').map(Number)
  const longest = TIERS[tier]
  let w
  let h
  if (aw >= ah) {
    w = longest
    h = round16((longest * ah) / aw)
  } else {
    h = longest
    w = round16((longest * aw) / ah)
  }
  if (w * h < MIN_PIXELS) {
    const k = Math.sqrt(MIN_PIXELS / (w * h))
    w = round16(w * k)
    h = round16(h * k)
  }
  if (w * h > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (w * h))
    w = floor16(w * k)
    h = floor16(h * k)
  }
  if (w > MAX_SIDE || h > MAX_SIDE) {
    const k = MAX_SIDE / Math.max(w, h)
    w = floor16(w * k)
    h = floor16(h * k)
  }
  return `${w}x${h}`
}

/** A caller-given WIDTHxHEIGHT, checked against the same rules. */
function explicitSize(value) {
  const m = /^(\d+)x(\d+)$/.exec(value.trim())
  if (m === null) throw new Error(`size must be 1k, 2k, 4k, or WIDTHxHEIGHT such as 1536x1024 (got "${value}")`)
  const w = Number(m[1])
  const h = Number(m[2])
  if (w % STEP !== 0 || h % STEP !== 0) throw new Error(`size sides must be multiples of 16 (got ${w}x${h})`)
  if (Math.max(w, h) > MAX_SIDE) throw new Error(`size longest side must not exceed ${MAX_SIDE} (got ${w}x${h})`)
  if (w * h < MIN_PIXELS || w * h > MAX_PIXELS) throw new Error(`size total pixels must be between ${MIN_PIXELS} and ${MAX_PIXELS} (got ${w * h})`)
  return `${w}x${h}`
}

/** Read the gateway key from the credentials provider, then a dotenv file. */
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

async function resolveKey(ctx, cfg) {
  const ref = cfg.keyRef ?? 'TEAMOROUTER_API_KEY'
  try {
    const credential = await ctx.credentials.resolve(ref)
    if (credential?.value) return credential.value
  } catch {
    // fall through to the dotenv file
  }
  const file = cfg.keyFile ?? join(process.env.DSH_HOME ?? '', 'secrets/teamorouter.env')
  const value = readDotenv(file, ref)
  if (value) return value
  throw new Error(`${ref} is not available: set it in the credentials store or in ${file}`)
}

/** Load one reference image as a Blob for the multipart edit request. */
async function loadImage(ctx, cwd, input, signal) {
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
  const ext = extname(path).toLowerCase()
  const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
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

export function apply(ctx, config) {
  const cfg = {
    baseURL: 'https://api.teamorouter.com/v1',
    keyRef: 'TEAMOROUTER_API_KEY',
    keyFile: undefined,
    defaultModel: 'gpt-image-2.6-sunburst',
    ...(config ?? {}),
  }

  ctx.tools.register(defineTool({
    name: 'image_generate',
    description:
      'Generate or edit images with TeamoRouter GPT Image models. Without `images` it draws from the prompt; with `images` (local paths or URLs) it edits or combines them, and passing the same reference each time keeps a subject consistent. Saves files and returns their paths; does not put image bytes in the conversation.',
    timeoutMs: 900_000,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What to draw, or how to change the images.',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: 'Reference or source images: local paths or http(s) URLs. One image edits it; several combine them (a subject from each). Omit for text-to-image.',
      },
      size: {
        type: 'string',
        description: 'Resolution: 1k, 2k, 4k, or WIDTHxHEIGHT such as 1536x1024. Billing tier follows the longest side (≤1024 1K, ≤2048 2K, above 4K). Default 1k.',
      },
      aspect: {
        type: 'string',
        enum: ASPECTS,
        description: 'Shape used when size is a tier. Default 1:1.',
      },
      quality: {
        type: 'string',
        enum: ['auto', 'low', 'medium', 'high'],
        description: 'Render effort; higher costs more. Default auto.',
      },
      n: {
        type: 'integer',
        description: 'Images per call, 1 to 4. Default 1.',
      },
      format: {
        type: 'string',
        enum: FORMATS,
        description: 'File format of the saved images. Default png.',
      },
      model: {
        type: 'string',
        enum: MODELS,
        description: 'Image model; use a -4k-upscale model for 4K detail. Default gpt-image-2.6-sunburst.',
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
          size: { type: 'string', required: true },
          model: { type: 'string', required: true },
          quality: { type: 'string', required: true },
          revised_prompt: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Saved ${value.files.length} image(s) at ${value.size} with ${value.model}: ${value.files.join(', ')}`,
        },
      ],
    },
    async execute(args, exec) {
      const cwd = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const key = await resolveKey(ctx, cfg)

      const model = args.model ?? cfg.defaultModel
      const quality = args.quality ?? 'auto'
      const format = args.format ?? 'png'
      const aspect = args.aspect ?? '1:1'
      const tier = (args.size ?? '1k').trim().toLowerCase()
      const size = tier in TIERS ? sizeFor(tier, aspect) : explicitSize(tier)
      const n = args.n ?? 1
      if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error(`n must be an integer from 1 to 4 (got ${n})`)

      const outDir = args.out_dir === undefined ? join(cwd, 'generated-images') : resolve(cwd, args.out_dir)
      const images = args.images ?? []

      let response
      if (images.length > 0) {
        const form = new FormData()
        form.append('model', model)
        form.append('prompt', args.prompt)
        form.append('size', size)
        form.append('quality', quality)
        form.append('n', String(n))
        form.append('output_format', format)
        form.append('input_fidelity', 'high')
        // The edits endpoint takes reference images as repeated `image` fields,
        // not as one `image[]` or `image[0]` field. Verified against TeamoRouter
        // 2026-11-13: two references sent as repeated `image` fields are both
        // read (input image tokens double); a single `image[]` array is not.
        for (const [index, input] of images.entries()) {
          const blob = await loadImage(ctx, cwd, input, exec.signal)
          form.append('image', blob, `image-${index}${extname(input) || '.png'}`)
        }
        response = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/images/edits`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: exec.signal,
        })
      } else {
        response = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/images/generations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, prompt: args.prompt, size, quality, n, output_format: format }),
          signal: exec.signal,
        })
      }

      const raw = await response.text()
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        throw new Error(`TeamRouter answered HTTP ${response.status}: ${raw.slice(0, 300)}`)
      }
      if (!response.ok) {
        const message = payload?.error?.message ?? JSON.stringify(payload).slice(0, 300)
        throw new Error(`TeamRouter ${response.status}: ${message}`)
      }

      const items = Array.isArray(payload.data) ? payload.data : []
      if (items.length === 0) throw new Error('TeamRouter returned no image')
      mkdirSync(outDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
      const slug = slugOf(args.prompt)
      const ext = format === 'jpeg' ? 'jpg' : format
      const files = []
      for (const [index, item] of items.entries()) {
        let bytes
        if (typeof item.b64_json === 'string') {
          bytes = Buffer.from(item.b64_json, 'base64')
        } else if (typeof item.url === 'string') {
          const download = await fetch(item.url, { signal: exec.signal })
          if (!download.ok) throw new Error(`TeamRouter image URL answered HTTP ${download.status}`)
          bytes = Buffer.from(await download.arrayBuffer())
        } else {
          throw new Error('TeamRouter returned an image without b64_json or url')
        }
        const file = join(outDir, `${stamp}-${slug}${items.length > 1 ? `-${index + 1}` : ''}.${ext}`)
        writeFileSync(file, bytes)
        files.push(file)
      }

      return {
        files,
        size: typeof payload.size === 'string' && payload.size.length > 0 ? payload.size : size,
        model,
        quality: typeof payload.quality === 'string' && payload.quality.length > 0 ? payload.quality : quality,
        ...(typeof items[0].revised_prompt === 'string' ? { revised_prompt: items[0].revised_prompt } : {}),
      }
    },
  }))
}
