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
 * Every call also writes a redacted generation receipt: the final prompt, the
 * model and size plan, the real reference list with sha256/dimensions, the
 * output hashes and the cost as an explicit estimate. The receipt is written
 * before the paid request, so a killed process still leaves the inputs on disk.
 * `dry_run` produces the same plan and receipt without any request or key use.
 *
 * Dependencies are Node built-ins only, so the module can be mounted by file
 * URL without installing a package.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ASPECTS,
  FORMATS,
  MODEL_IDS,
  PROVIDERS,
  QUALITIES,
  billingTierOfSize,
  catalogText,
  costCnyFor,
  normalizeFormat,
  planBilledSize,
  resolveSelection,
  validateCounts,
  validatePrompt,
  validateQuality,
} from './lib/catalog.js'
import {
  APPROVAL_POLICY,
  IDENTITY_ROOT_ROLES,
  REFERENCE_ROLES,
  collectReferences,
  evaluateIdentityGuard,
  referenceKey,
  reuseWarnings,
} from './lib/guard.js'
import { imageInfoOf, mimeOf } from './lib/imageinfo.js'
import {
  makeReceipt,
  makeReceiptId,
  receiptDirFor,
  redactText,
  redactUrl,
  sha256Hex,
  writeFileExclusive,
  writeReceipt,
} from './lib/receipt.js'

export const name = 'image-gen'
export const inject = ['tools', 'workingDirectory', 'credentials']

/** Per-reference upload cap (matches the documented MiniMax reference limit). */
const MAX_REFERENCE_BYTES = 64 * 1024 * 1024
/** Downloaded result cap: a 4K PNG stays well under this. */
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024

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

const isHttp = (value) => /^https?:\/\//i.test(value)

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

/**
 * Read a remote body with a hard byte cap. Content-Length is checked first so a
 * declared-oversized file is refused unread; a stream without Content-Length is
 * aborted as soon as the running total passes the cap instead of being buffered
 * to the end first.
 */
async function readBounded(response, limit, label) {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const expected = Number(declared)
    if (Number.isFinite(expected) && expected > limit) {
      throw new Error(`${label} is ${expected} bytes, over the ${limit}-byte limit`)
    }
  }
  if (response.body === null || typeof response.body.getReader !== 'function') {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > limit) {
      throw new Error(`${label} is ${bytes.length} bytes, over the ${limit}-byte limit`)
    }
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        throw new Error(`${label} exceeded the ${limit}-byte limit while streaming; aborted before buffering it all`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks, total)
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

function extensionFor(format) {
  return format === 'jpeg' ? 'jpg' : (format ?? 'bin')
}

/**
 * Load every reference once: hash it, record its real format and dimensions,
 * keep a local copy of remote bytes and build the blob for the multipart edit.
 *
 * Nothing is sent before this completes, which is what lets the receipt be
 * written with the true input list before the paid request.
 */
async function loadReferenceInputs({ images, cwd, annotations, dryRun, signal, copyDir }) {
  const loaded = []
  const records = []
  const warnings = []

  for (const [index, image] of images.entries()) {
    const key = referenceKey(image, cwd, resolve)
    const meta = annotations.get(key)
    const record = {
      image: isHttp(image) ? redactUrl(image) : image,
      source_type: isHttp(image) ? 'url' : 'file',
      checked: false,
      sha256: null,
      sha256_expected: meta?.expectedSha256 ?? null,
      sha256_match: null,
      bytes: null,
      format: null,
      width: null,
      height: null,
      role: meta?.role ?? 'unspecified',
      approved: meta === undefined ? null : meta.approved,
      approval: meta === undefined ? null : meta.approved ? 'caller_declared' : 'unapproved',
      approval_evidence: meta?.approvalEvidence === undefined ? null : redactText(meta.approvalEvidence),
      source: meta?.source === undefined ? null : redactText(meta.source),
      note: meta?.note === undefined ? null : redactText(meta.note),
      asset_id: meta?.assetId ?? null,
      required: meta === undefined ? null : meta.required === true,
      root_ids: meta?.rootIds ?? null,
    }

    let bytes
    if (isHttp(image)) {
      if (dryRun) {
        records.push(record)
        warnings.push(
          `remote reference ${redactUrl(image)} was not fetched during dry_run; its sha256/dimensions are ` +
            'verified only on a real call',
        )
        continue
      }
      const response = await fetch(image, { signal })
      if (!response.ok) {
        throw new Error(`cannot read reference image ${redactUrl(image)}: HTTP ${response.status}`)
      }
      bytes = await readBounded(response, MAX_REFERENCE_BYTES, `reference image ${redactUrl(image)}`)
    } else {
      const path = resolve(cwd, image)
      try {
        bytes = readFileSync(path)
      } catch (error) {
        throw new Error(`cannot read reference image ${image}: ${error.message}`)
      }
      if (bytes.length > MAX_REFERENCE_BYTES) {
        throw new Error(`reference image ${image} is ${bytes.length} bytes, over the ${MAX_REFERENCE_BYTES}-byte limit`)
      }
      record.resolved = path
    }

    const info = imageInfoOf(bytes)
    record.checked = true
    record.sha256 = sha256Hex(bytes)
    record.bytes = info.bytes
    record.format = info.format
    record.width = info.width
    record.height = info.height

    if (record.sha256_expected !== null) {
      record.sha256_match = record.sha256_expected === record.sha256
      if (!record.sha256_match) {
        throw new Error(
          `reference hash mismatch for ${image}${record.required === true ? ' (required by references_file)' : ''}: ` +
            `references_file declares sha256 ${record.sha256_expected}, actual bytes hash ${record.sha256}. ` +
            'The asset changed or the wrong file was passed; refusing before any request.',
        )
      }
    }

    if (isHttp(image) && copyDir !== undefined) {
      const localCopy = join(copyDir, `ref-${index + 1}.${extensionFor(info.format)}`)
      mkdirSync(dirname(localCopy), { recursive: true })
      writeFileExclusive(localCopy, bytes)
      record.local_copy = localCopy
    }

    if (!dryRun) {
      loaded.push({ blob: new Blob([bytes], { type: mimeOf(info.format) }), name: `ref-${index + 1}.${extensionFor(info.format)}` })
    }
    records.push(record)
  }

  return { loaded, records, warnings }
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
function editForm(plan, prompt, loaded) {
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
  for (const input of loaded) {
    form.append('image', input.blob, input.name)
  }
  return form
}

/** Decode one item from an images response into bytes. */
async function itemBytes(item, signal) {
  if (typeof item.b64_json === 'string') return Buffer.from(item.b64_json, 'base64')
  if (typeof item.url === 'string') {
    // The signed download URL is deliberately not persisted anywhere.
    const download = await fetch(item.url, { signal })
    if (!download.ok) throw new Error(`image URL answered HTTP ${download.status}`)
    return readBounded(download, MAX_OUTPUT_BYTES, 'generated image download')
  }
  return undefined
}

/** One estimate object shared by dry_run and real receipts. */
function costRecord({ cny, unitCny, known, basis, note }) {
  return {
    currency: 'CNY',
    cny: cny ?? null,
    unit_cny: unitCny ?? null,
    known,
    estimated: true,
    bill: false,
    basis,
    note: note ?? (known ? 'estimate only, not a bill; the provider invoice is authoritative' : 'cost unknown'),
  }
}

/** Pre-request estimate. Token-billed models stay explicitly unknown. */
function planCost({ provider, entry, sizePlan, n }) {
  const perImage = provider === 'gpt' && entry.pricing.mode === 'per_image'
  const unit = perImage ? costCnyFor(entry, sizePlan.billingTier) : undefined
  if (unit === undefined) {
    return costRecord({
      known: false,
      basis: `${provider === 'minimax' || entry.pricing.mode === 'token' ? 'token-billed' : 'price unknown'}: ` +
        'prompt/reference/output tokens decide the amount',
      note: 'cost unknown: this model is not per-image priced here, so no CNY amount is fabricated',
    })
  }
  return costRecord({
    cny: Number((unit * n).toFixed(2)),
    unitCny: unit,
    known: true,
    basis: `per delivered image tier ${sizePlan.billingTier} × n=${n}`,
  })
}

/** Post-delivery estimate: sums the tier of each delivered image. */
function deliveredCost({ provider, entry, billedTiers }) {
  const perImage = provider === 'gpt' && entry.pricing.mode === 'per_image'
  const units = perImage ? billedTiers.map((tier) => costCnyFor(entry, tier)) : []
  const known = units.length > 0 && units.every((value) => value !== undefined)
  if (!known) {
    return costRecord({
      known: false,
      basis: `${provider === 'minimax' || entry.pricing.mode === 'token' ? 'token-billed' : 'price unknown'}: ` +
        'the delivered amount depends on tokens and prompt enhancement',
      note: 'cost unknown: this model is not per-image priced here, so no CNY amount is fabricated',
    })
  }
  const total = Number(units.reduce((sum, value) => sum + value, 0).toFixed(2))
  return costRecord({
    cny: total,
    unitCny: units.length === 1 ? units[0] : null,
    known: true,
    basis: `per delivered image; tiers ${billedTiers.join(', ')}`,
  })
}

/** The receipt `request` block; also the source for the model-facing plan. */
function requestRecord({
  provider,
  model,
  endpoint,
  prompt,
  n,
  format,
  quality,
  aspect,
  sizeRequested,
  sizePlan,
  allow4k,
  referenceCount,
  dryRun,
}) {
  return {
    provider,
    model,
    endpoint,
    prompt,
    prompt_sha256: sha256Hex(prompt),
    prompt_chars: prompt.length,
    n,
    format_requested: format,
    quality: quality ?? null,
    aspect,
    size_requested: sizeRequested ?? null,
    planned_size: sizePlan.size ?? null,
    planned_area: sizePlan.area ?? null,
    billing_tier: sizePlan.billingTier ?? null,
    allow_4k: allow4k === true,
    reference_count: referenceCount,
    dry_run: dryRun,
  }
}

/** The plan surfaced to the caller (prompt text itself stays in the receipt). */
function planView(request) {
  return {
    provider: request.provider,
    model: request.model,
    endpoint: request.endpoint,
    planned_size: request.planned_size,
    planned_area: request.planned_area,
    billing_tier: request.billing_tier,
    aspect: request.aspect,
    n: request.n,
    format_requested: request.format_requested,
    quality: request.quality,
    prompt_chars: request.prompt_chars,
    prompt_sha256: request.prompt_sha256,
    reference_count: request.reference_count,
    allow_4k: request.allow_4k,
  }
}

const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }
const NULLABLE_INTEGER = { oneOf: [{ type: 'integer' }, { type: 'null' }] }
const NULLABLE_BOOLEAN = { oneOf: [{ type: 'boolean' }, { type: 'null' }] }

const INPUT_RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    image: { type: 'string', required: true },
    resolved: { type: 'string' },
    source_type: { type: 'string', required: true },
    checked: { type: 'boolean', required: true },
    sha256: NULLABLE_STRING,
    sha256_expected: NULLABLE_STRING,
    sha256_match: NULLABLE_BOOLEAN,
    bytes: NULLABLE_INTEGER,
    format: NULLABLE_STRING,
    width: NULLABLE_INTEGER,
    height: NULLABLE_INTEGER,
    local_copy: { type: 'string' },
    role: { type: 'string', required: true },
    approved: NULLABLE_BOOLEAN,
    approval: NULLABLE_STRING,
    approval_evidence: NULLABLE_STRING,
    source: NULLABLE_STRING,
    note: NULLABLE_STRING,
    asset_id: NULLABLE_STRING,
    required: NULLABLE_BOOLEAN,
    root_ids: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
  },
}

const OUTPUT_RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', required: true },
    file: { type: 'string', required: true },
    sha256: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    format: { type: 'string', required: true },
    width: NULLABLE_INTEGER,
    height: NULLABLE_INTEGER,
    size: NULLABLE_STRING,
    billing_tier: NULLABLE_STRING,
  },
}

const COST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    currency: { type: 'string', required: true },
    cny: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
    unit_cny: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    known: { type: 'boolean', required: true },
    estimated: { type: 'boolean', required: true },
    bill: { type: 'boolean', required: true },
    basis: { type: 'string' },
    note: { type: 'string' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    endpoint: { type: 'string', required: true },
    planned_size: NULLABLE_STRING,
    planned_area: NULLABLE_STRING,
    billing_tier: NULLABLE_STRING,
    aspect: { type: 'string', required: true },
    n: { type: 'integer', required: true },
    format_requested: { type: 'string', required: true },
    quality: NULLABLE_STRING,
    prompt_chars: { type: 'integer', required: true },
    prompt_sha256: { type: 'string', required: true },
    reference_count: { type: 'integer', required: true },
    allow_4k: { type: 'boolean', required: true },
  },
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
      'List image providers, models, billing tiers, capabilities and the CNY price snapshot used by image_generate. Read the GPT tier table before choosing `size`; call it whenever cost matters.',
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
      'Generate or edit images with GPT Image (TeamoRouter) or MiniMax H3-Image. ' +
      '`size` is the BILLING TIER, not a marketing label: 1k/2k/4k (GPT default 2k). ' +
      'GPT bills the delivered image by its longest side: 1K and 2K both cost about ¥0.18/image, ' +
      '4K costs about ¥0.60 (~3.3x). 2K means longest side 2048 — 2048x1152 for 16:9; ' +
      '2560x1440 is billed as 4K, so never pass it for 2K. Prefer size:"2k" + aspect over ' +
      'computing pixels. Without `images` it draws from the prompt; with `images` (local paths ' +
      'or URLs, up to 16) it edits or combines them, and passing the same reference each time ' +
      'keeps a subject consistent. Every call writes a receipt with the real input list ' +
      '(sha256/dimensions/role/approval), output hashes and an estimate marked as not a bill; ' +
      'use dry_run to inspect the plan and inputs before paying. For an existing person, pass the ' +
      'approved identity root directly — do not try to fix an approved face with opposite ' +
      'adjectives; declare references so the receipt proves what anchored the result. A ' +
      'references_file entry marked required:true must be passed and hash-matched or the call is ' +
      'refused before spending. ' +
      'Saves files, returns their paths; call image_models for the full table.',
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
          'Exact model id. Defaults: gpt-image-2.6-sunburst (gpt), MiniMax-H3-Image (minimax). ' +
          'Never pick a *-4k-upscale model for 2K: it is 4K-only and always bills 4K. ' +
          'MiniMax-H3-Image-Highspeed is faster at about 1.5-2x the standard price. See image_models.',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Reference or source images: local paths or http(s) URLs. One image edits it; several combine them (a subject from each). Up to 16; omit for text-to-image.',
      },
      references: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            image: { type: 'string', required: true },
            role: { type: 'string', enum: [...REFERENCE_ROLES], required: true },
            approved: { type: 'boolean' },
            source: { type: 'string' },
            note: { type: 'string' },
          },
        },
        description:
          'Provenance for entries of `images`, matched by path/URL (relative paths allowed): role is ' +
          'identity_root/character_card/scene_card/keyframe/source_frame/style_ref/other; approved is ' +
          'caller-declared and recorded as such; source names the approval record. Declaring an approved ' +
          'identity_root/character_card is how an edit of an existing person is allowed; approved cards are ' +
          'also what keeps approved assets from being replaced by video frames. Required metadata is optional ' +
          'for plain calls but makes the receipt auditable.',
      },
      references_file: {
        type: 'string',
        description:
          'Optional JSON manifest (relative path) of project assets: an array, {references:[...]} or ' +
          '{assets:[...]} with entries {image|path, role|kind, approved, required, source, note, sha256, id, ' +
          'approval_evidence, root_ids}. Only entries matching `images` are used; its path+sha256 are pinned in ' +
          'the receipt. An entry marked `required:true` MUST be passed in `images` and its sha256 must match the ' +
          'actual bytes, otherwise the call is refused before any credential or network use; a missing or drifted ' +
          'required reference cannot be replaced by a frame, another asset or a text-only retry. Approved ' +
          'assets not marked required stay optional (informational warning only).',
      },
      dry_run: {
        type: 'boolean',
        description:
          'Default false. Validate, resolve, price and hash the local inputs without any network request or ' +
          'credential use, write a plan receipt, and return the plan/inputs/cost. Remote references are listed ' +
          'but not fetched. Cost is always estimated and marked bill:false; token-billed or unknown prices ' +
          'return cost.known:false with cny:null instead of a fabricated amount.',
      },
      label: {
        type: 'string',
        description: 'Free-form label recorded in the receipt (for example a shot or scene id).',
      },
      size: {
        type: 'string',
        description:
          'Billing tier: "1k", "2k", or "4k". Defaults: gpt 2k (1K and 2K cost the same, ~¥0.18), ' +
          'minimax 1k. GPT bills by delivered longest side: <=1024 1K, <=2048 2K, >2048 4K (~¥0.60). ' +
          'For 16:9 2K pass size:"2k" + aspect:"16:9" (2048x1152); do NOT compute pixels — ' +
          '2560x1440 is 4K billing. Explicit WIDTHxHEIGHT (multiples of 16, longest <=3840, ' +
          '0.66-8.29MP) is for exact control; an explicit per-image GPT size above 2048 requires allow_4k:true. ' +
          'MiniMax: area 1K/2K/4K (1024^2/2048^2/4096^2) + aspect 1:3-3:1, or explicit 0.66-20MP.',
      },
      aspect: {
        type: 'string',
        enum: ASPECTS,
        description: 'Shape for tier sizes; ignored with explicit WIDTHxHEIGHT. Default 1:1.',
      },
      allow_4k: {
        type: 'boolean',
        description:
          'per-image gpt models only, default false. An explicit WIDTHxHEIGHT whose longest side exceeds 2048 is ' +
          'billed as 4K (~¥0.60) and is refused unless this is true. Not needed for size:"4k" ' +
          'or for MiniMax. Set it only when you deliberately want exact 4K pixels.',
      },
      quality: {
        type: 'string',
        enum: QUALITIES,
        description:
          'gpt only: auto (default), low, medium, high; this does not change the size/billing tier. minimax has no quality level and accepts only auto.',
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
        description:
          'Directory for the saved files, relative to the session working directory. Default generated-images. Receipts go to <out_dir>/receipts.',
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
          format: { type: 'string', required: true },
          dry_run: { type: 'boolean', required: true },
          receipt_path: { type: 'string', required: true },
          receipt_id: { type: 'string', required: true },
          inputs: { type: 'array', items: INPUT_RECORD_SCHEMA, required: true },
          outputs: { type: 'array', items: OUTPUT_RECORD_SCHEMA, required: true },
          cost: { ...COST_SCHEMA, required: true },
          plan: { ...PLAN_SCHEMA, required: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
          billing_tier: { type: 'string' },
          cost_cny: { type: 'number' },
          quality: { type: 'string' },
          revised_prompt: { type: 'string' },
          failed: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        const cost = value.cost
        const costText =
          cost === undefined
            ? ''
            : cost.known
              ? `≈¥${Number(cost.cny).toFixed(2)} estimate, not a bill`
              : 'cost unknown (token-billed; the provider bill is authoritative)'
        const tier =
          value.billing_tier === undefined
            ? ''
            : ` [${value.provider === 'minimax' ? 'area' : 'billed as'} ${value.billing_tier}]`
        const warnings = value.warnings ?? []
        const warningText =
          warnings.length === 0
            ? ''
            : `; ${warnings.length} warning(s): ${warnings.slice(0, 3).join(' | ')}${warnings.length > 3 ? ' …' : ''}`
        if (value.dry_run === true) {
          const plan = value.plan ?? {}
          const plannedSize = plan.planned_size ?? plan.planned_area ?? value.size
          return [
            {
              type: 'text',
              text:
                `Dry run: no request, no charge. ${plan.provider ?? value.provider} ${plan.model ?? value.model} at ` +
                `${plannedSize}, ${plan.reference_count ?? value.inputs.length} reference(s), ${costText}. ` +
                `Receipt: ${value.receipt_path}${warningText}`,
            },
          ]
        }
        const failed =
          value.failed === undefined || value.failed.length === 0
            ? ''
            : `; ${value.failed.length} failed: ${value.failed.join('; ')}`
        return [
          {
            type: 'text',
            text:
              `Saved ${value.files.length} image(s) at ${value.size} (${value.format}) with ${value.model} via ` +
              `${value.provider}${tier}; ${costText}. Receipt: ${value.receipt_path}${failed}${warningText}`,
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
      const aspect = args.aspect ?? '1:1'
      const sizePlan = planBilledSize({
        provider,
        entry,
        size: args.size,
        aspect,
        allow4k: args.allow_4k === true,
      })
      const requestPlan = { provider, model, n, format, quality, aspect, ...sizePlan }
      const endpoint = images.length > 0 ? '/images/edits' : '/images/generations'
      const dryRun = args.dry_run === true
      const outDir = args.out_dir === undefined ? join(cwd, 'generated-images') : resolve(cwd, args.out_dir)
      const receiptId = makeReceiptId()
      const receiptPath = join(receiptDirFor(outDir), `${receiptId}.json`)

      // Provenance and guard run before anything is sent. A refused identity
      // edit costs nothing, not even a credential lookup.
      const collected = collectReferences({
        images,
        cwd,
        references: args.references,
        referencesFile: typeof args.references_file === 'string' && args.references_file.trim().length === 0
          ? undefined
          : args.references_file,
        readFileSync,
        resolve,
        sha256Hex,
        redactUrl,
      })
      const warnings = [...collected.warnings]
      const guard = evaluateIdentityGuard({
        prompt: args.prompt,
        images,
        annotations: collected.annotations,
        manifest: collected.manifest,
        redactUrl,
      })
      warnings.push(...guard.warnings)
      warnings.push(
        ...reuseWarnings({ images, annotations: collected.annotations, manifest: collected.manifest, redactUrl }),
      )

      const loadedInputs = await loadReferenceInputs({
        images,
        cwd,
        annotations: collected.annotations,
        dryRun,
        signal: exec.signal,
        copyDir: dryRun ? undefined : join(receiptDirFor(outDir), 'inputs', receiptId),
      })
      warnings.push(...loadedInputs.warnings)

      const request = requestRecord({
        provider,
        model,
        endpoint,
        prompt: args.prompt,
        n,
        format,
        quality,
        aspect,
        sizeRequested: args.size,
        sizePlan,
        allow4k: args.allow_4k,
        referenceCount: images.length,
        dryRun,
      })
      const plan = planView(request)
      const plannedCost = planCost({ provider, entry, sizePlan, n })
      const receipt = makeReceipt({
        id: receiptId,
        label: args.label,
        manifest: collected.manifest,
        request,
        inputs: loadedInputs.records,
        cost: plannedCost,
        warnings,
      })
      receipt.approval_policy = APPROVAL_POLICY
      receipt.guard = {
        identity_edit_prompt: guard.identityEditPrompt === true,
        identity_preservation_prompt: guard.identityPreservationPrompt === true,
        approved_identity_references: [...collected.annotations.values()].filter(
          (annotation) => annotation.approved === true && IDENTITY_ROOT_ROLES.includes(annotation.role),
        ).length,
      }

      if (dryRun) {
        receipt.status = 'planned'
        writeReceipt(receiptPath, receipt, { create: true })
        return {
          files: [],
          provider,
          size: sizePlan.size ?? sizePlan.area ?? 'unknown',
          model,
          format,
          dry_run: true,
          receipt_path: receiptPath,
          receipt_id: receiptId,
          inputs: loadedInputs.records,
          outputs: [],
          cost: plannedCost,
          plan,
          warnings,
          ...(sizePlan.billingTier === undefined ? {} : { billing_tier: sizePlan.billingTier }),
          ...(plannedCost.known ? { cost_cny: plannedCost.cny } : {}),
          ...(quality === undefined ? {} : { quality }),
        }
      }

      // Persist the input provenance before the paid request; a killed process
      // still leaves the exact reference list and hashes on disk.
      receipt.status = 'requested'
      writeReceipt(receiptPath, receipt, { create: true })

      const failures = []
      const outputRecords = []
      let revisedPrompt
      try {
        const key = await resolveKey(ctx, backend)
        const baseURL = backend.baseURL.replace(/\/$/, '')
        const apiLabel = profile.apiLabel

        let response
        try {
          if (images.length > 0) {
            response = await fetch(`${baseURL}/images/edits`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${key}` },
              body: editForm(requestPlan, args.prompt, loadedInputs.loaded),
              signal: exec.signal,
            })
          } else {
            response = await fetch(`${baseURL}/images/generations`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(generationBody(requestPlan, args.prompt)),
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
          throw new Error(`${apiLabel} answered HTTP ${response.status}: ${redactText(raw.slice(0, 300))}`)
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

        mkdirSync(outDir, { recursive: true })
        const stamp = timestamp()
        const slug = slugOf(args.prompt)
        // A same-second retry with the same prompt must never reuse a name: the
        // receipt id contributes 8 random hex and the write itself is exclusive.
        const unique = receiptId.slice(-8)
        const responseFormat = normalizeFormat(payload.output_format) ?? format
        const billedTiers = []
        const files = []

        for (const [index, item] of items.entries()) {
          if (item === null || typeof item !== 'object') {
            failures.push(`image ${index + 1}: empty result`)
            continue
          }
          if (item.error !== undefined && item.b64_json === undefined && item.url === undefined) {
            const detail = item.error.message ?? item.error.code ?? 'failed'
            failures.push(redactText(`image ${index + 1}: ${detail}`))
            continue
          }
          let bytes
          try {
            bytes = await itemBytes(item, exec.signal)
          } catch (error) {
            failures.push(redactText(`image ${index + 1}: ${error.message}`))
            continue
          }
          if (bytes === undefined) {
            failures.push(`image ${index + 1}: no b64_json or url`)
            continue
          }
          const info = imageInfoOf(bytes)
          const actualFormat = info.format ?? responseFormat
          const file = join(
            outDir,
            `${stamp}-${slug}-${unique}${items.length > 1 ? `-${index + 1}` : ''}.${extensionFor(actualFormat)}`,
          )
          writeFileExclusive(file, bytes)
          const deliveredSize = typeof item.size === 'string' ? item.size : undefined
          const tier =
            provider === 'gpt' && entry.pricing.mode === 'per_image'
              ? (billingTierOfSize(deliveredSize) ?? requestPlan.billingTier)
              : requestPlan.billingTier
          billedTiers.push(tier)
          files.push(file)
          outputRecords.push({
            index: outputRecords.length + 1,
            file,
            sha256: sha256Hex(bytes),
            bytes: info.bytes,
            format: actualFormat,
            width: info.width,
            height: info.height,
            size: info.width !== null && info.height !== null ? `${info.width}x${info.height}` : (deliveredSize ?? null),
            billing_tier: tier ?? null,
          })
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
          provider === 'gpt' && entry.pricing.mode === 'token' ? undefined : billedTiers[0]
        const cost = deliveredCost({ provider, entry, billedTiers })

        receipt.status = failures.length === 0 ? 'delivered' : 'partial'
        receipt.finished_at = new Date().toISOString()
        receipt.outputs = outputRecords
        receipt.failures = failures
        receipt.cost = cost
        writeReceipt(receiptPath, receipt)

        return {
          files,
          provider,
          size: outputRecords[0]?.size ?? requestPlan.size ?? requestPlan.area ?? 'unknown',
          model,
          format: outputRecords[0]?.format ?? format,
          dry_run: false,
          receipt_path: receiptPath,
          receipt_id: receiptId,
          inputs: loadedInputs.records,
          outputs: outputRecords,
          cost,
          plan,
          warnings,
          ...(billingTier === undefined ? {} : { billing_tier: billingTier }),
          ...(cost.known ? { cost_cny: cost.cny } : {}),
          ...(quality === undefined ? {} : { quality }),
          ...(revisedPrompt === undefined ? {} : { revised_prompt: revisedPrompt }),
          ...(failures.length === 0 ? {} : { failed: failures }),
        }
      } catch (error) {
        receipt.status = outputRecords.length > 0 ? 'partial' : 'failed'
        receipt.finished_at = new Date().toISOString()
        receipt.outputs = outputRecords
        receipt.failures = failures
        receipt.error = redactText(error?.message ?? String(error))
        writeReceipt(receiptPath, receipt)
        if (error instanceof Error && error.name !== 'AbortError') {
          error.message = redactText(error.message)
        }
        throw error
      }
    },
  }))
}
