// 轻量自检：入口可加载、两个工具可注册、provider/model 解析、档位/计费规则、
// 2K/4K 成本保护、来源收据与 dry_run、身份根硬门。全部离线 mock，不发起真实请求、
// 不读取真实凭据，所以零成本、可重复。
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, dshHomePath, inject, name } from '../index.js'
import {
  ASPECTS,
  GPT_MODELS,
  GPT_TIER_PRICES_CNY,
  MINIMAX_4K_PROMO,
  MINIMAX_MODELS,
  MODEL_BY_ID,
  MODEL_IDS,
  PROVIDERS,
  billingTierOfSize,
  catalogText,
  costCnyFor,
  normalizeFormat,
  planBilledSize,
  planSize,
  resolveSelection,
  validateCounts,
  validatePrompt,
  validateQuality,
} from '../lib/catalog.js'
import {
  CARD_ROLES,
  IDENTITY_ROOT_ROLES,
  REFERENCE_ROLES,
  identityEditPhrase,
  evaluateIdentityGuard,
  reuseWarnings,
  collectReferences,
} from '../lib/guard.js'
import { imageInfoOf, mimeOf } from '../lib/imageinfo.js'
import { makeReceiptId, redactText, redactUrl, sha256Hex, writeFileExclusive, writeReceipt } from '../lib/receipt.js'

assert.equal(name, 'image-gen')
assert.deepEqual(inject, ['tools', 'workingDirectory', 'credentials'])
assert.equal(typeof apply, 'function')

// --- dotenv fallback path: the Desktop host has HOME but no DSH_HOME ----
const savedDshHome = process.env.DSH_HOME
const savedHome = process.env.HOME
try {
  delete process.env.DSH_HOME
  process.env.HOME = '/tmp/dsh-home-test'
  assert.equal(dshHomePath(), '/tmp/dsh-home-test/.dsh')
  process.env.DSH_HOME = '/tmp/custom-dsh'
  assert.equal(dshHomePath(), '/tmp/custom-dsh')
  delete process.env.DSH_HOME
  process.env.HOME = ''
  assert.equal(dshHomePath(), join(homedir(), '.dsh'))
} finally {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
}

// --- tool registration and model-facing schemas -------------------------
const definitions = []
const registrationCtx = {
  tools: {
    register(definition) {
      definitions.push(definition)
    },
  },
  credentials: {
    async resolve() {
      throw new Error('credentials must not be read during registration')
    },
  },
  workingDirectory: {
    async ensure() {
      return process.cwd()
    },
  },
}
apply(registrationCtx, {})

assert.deepEqual(
  definitions.map((definition) => definition.name),
  ['image_models', 'image_generate'],
)
const modelsTool = definitions.find((definition) => definition.name === 'image_models')
const generateTool = definitions.find((definition) => definition.name === 'image_generate')
assert.ok(modelsTool !== undefined)
assert.ok(generateTool !== undefined)

const params = generateTool.parameters
assert.deepEqual(params.required, ['prompt'])
assert.deepEqual(params.properties.provider.enum, ['gpt', 'minimax'])
assert.deepEqual(params.properties.model.enum, [...MODEL_IDS])
assert.deepEqual(params.properties.aspect.enum, [...ASPECTS])
assert.equal(params.properties.allow_4k.type, 'boolean')
assert.equal(params.properties.dry_run.type, 'boolean')
assert.equal(params.properties.references.type, 'array')
assert.deepEqual(params.properties.references.items.properties.role.enum, [...REFERENCE_ROLES])
assert.deepEqual(params.properties.references.items.required, ['image', 'role'])
assert.equal(params.properties.references_file.type, 'string')
assert.equal(params.properties.label.type, 'string')
assert.match(params.properties.size.description, /Billing tier/)
assert.match(params.properties.size.description, /2560x1440 is 4K billing/)
assert.match(params.properties.dry_run.description, /without any network request/)
assert.match(params.properties.references.description, /identity_root/)
assert.match(generateTool.description, /BILLING TIER/)
assert.match(generateTool.description, /¥0\.60/)
assert.match(generateTool.description, /receipt/)
assert.ok(params.properties.model.enum.includes('MiniMax-H3-Image'))
assert.ok(params.properties.model.enum.includes('MiniMax-H3-Image-Highspeed'))
assert.ok(params.properties.quality.enum.includes('high'))

const outputRequired = generateTool.output.schema.required
for (const field of ['files', 'provider', 'size', 'model', 'format', 'dry_run', 'receipt_path', 'receipt_id', 'inputs', 'outputs', 'warnings']) {
  assert.ok(outputRequired.includes(field), `output must require ${field}`)
}
const outputProps = generateTool.output.schema.properties
assert.ok('billing_tier' in outputProps)
assert.equal(outputProps.cost_cny.type, 'number')
assert.ok('failed' in outputProps)
assert.equal(outputProps.cost.properties.bill.type, 'boolean')
assert.equal(outputProps.cost.properties.estimated.type, 'boolean')
assert.equal(outputProps.cost.properties.known.type, 'boolean')
assert.deepEqual(outputProps.inputs.items.required, ['image', 'source_type', 'checked', 'role'])
assert.deepEqual(outputProps.outputs.items.required, ['index', 'file', 'sha256', 'bytes', 'format'])

const catalog = await modelsTool.execute({}, {})
assert.match(catalog.text, /GPT BILLING TIERS/)
assert.match(catalog.text, /1K and 2K cost|same price as 1K/)
assert.match(catalog.text, /¥0\.18/)
assert.match(catalog.text, /¥0\.60/)
assert.match(catalog.text, /2560x1440 is 4K billing/)
assert.match(catalog.text, /gpt-image-2\.6-sunburst \(default\)/)
assert.match(catalog.text, /\[4K-only\]/)
assert.match(catalog.text, /MiniMax-H3-Image/)
assert.match(catalog.text, /¥0\.2261/)
assert.match(catalog.text, /¥0\.4275/)
assert.match(catalog.text, /3840x2160/)
assert.equal(catalog.text, catalogText())

// --- provider/model resolution -----------------------------------------
const defaults = { provider: 'gpt', gpt: 'gpt-image-2.6-sunburst', minimax: 'MiniMax-H3-Image' }
assert.deepEqual(
  (({ provider, model }) => ({ provider, model }))(resolveSelection({ defaults })),
  { provider: 'gpt', model: 'gpt-image-2.6-sunburst' },
)
assert.equal(resolveSelection({ model: 'MiniMax-H3-Image', defaults }).provider, 'minimax')
assert.equal(resolveSelection({ provider: 'minimax', defaults }).model, 'MiniMax-H3-Image')
assert.throws(
  () => resolveSelection({ provider: 'gpt', model: 'MiniMax-H3-Image', defaults }),
  /belongs to provider "minimax"/,
)
assert.throws(() => resolveSelection({ provider: 'midjourney', defaults }), /provider must be/)
assert.throws(() => resolveSelection({ model: 'gpt-image-9', defaults }), /unknown image model/)

// --- GPT tier price snapshot (2026-11-15 account bill) ------------------
assert.deepEqual(GPT_TIER_PRICES_CNY, { '1K': 0.18, '2K': 0.18, '4K': 0.60 })
for (const entry of GPT_MODELS) {
  if (entry.pricing.mode !== 'per_image') continue
  assert.equal(entry.pricing.currency, 'CNY')
  assert.deepEqual(entry.pricing.tiers, GPT_TIER_PRICES_CNY)
  assert.equal(costCnyFor(entry, '2K'), 0.18)
  assert.equal(costCnyFor(entry, '4K'), 0.6)
}
for (const entry of GPT_MODELS) {
  if (entry.id.endsWith('-4k-upscale')) assert.equal(entry.always4k, true, `${entry.id} must be 4K-only`)
}
assert.equal(costCnyFor(MODEL_BY_ID.get('MiniMax-H3-Image'), '4K'), undefined)
assert.equal(costCnyFor(MODEL_BY_ID.get('gemini-3-pro-image'), '4K'), undefined)
assert.equal(costCnyFor(MODEL_BY_ID.get('gpt-image-2.6-sunburst'), undefined), undefined)

// --- MiniMax model ids and price snapshot ------------------------------
assert.deepEqual(
  MINIMAX_MODELS.map((entry) => entry.id),
  ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'],
)
const standard = MODEL_BY_ID.get('MiniMax-H3-Image')
const highspeed = MODEL_BY_ID.get('MiniMax-H3-Image-Highspeed')
assert.deepEqual(standard.pricing.tokenRates, {
  textInputPerMTok: 15,
  imageInputPerMTok: 10,
  outputPerMTok: 25,
})
assert.deepEqual(highspeed.pricing.tokenRates, {
  textInputPerMTok: 15,
  imageInputPerMTok: 20,
  outputPerMTok: 50,
})
assert.equal(standard.pricing.rows[0].prices['4K'].list, 0.4522)
assert.equal(standard.pricing.rows[0].prices['4K'].promo, 0.2261)
assert.equal(standard.pricing.rows[1].prices['4K'].promo, 0.2404)
assert.equal(standard.pricing.rows[2].prices['4K'].promo, 0.2605)
assert.equal(highspeed.pricing.rows[0].prices['4K'].promo, 0.4275)
assert.equal(highspeed.pricing.rows[2].prices['4K'].list, 1.0146)
assert.equal(MINIMAX_4K_PROMO.discount, 0.5)
assert.equal(MINIMAX_4K_PROMO.minPixels, 16_600_000)

// --- GPT / MiniMax size planning ---------------------------------------
assert.deepEqual(planSize('gpt', '1k', '1:1'), { size: '1024x1024', billingTier: '1K' })
assert.deepEqual(planSize('gpt', '2k', '1:1'), { size: '2048x2048', billingTier: '2K' })
assert.deepEqual(planSize('gpt', '2k', '16:9'), { size: '2048x1152', billingTier: '2K' })
assert.deepEqual(planSize('gpt', '4k', '16:9'), { size: '3840x2160', billingTier: '4K' })
// 4K square is capped by the 8,294,400-pixel limit, not stretched to 4096.
assert.deepEqual(planSize('gpt', '4k', '1:1'), { size: '2880x2880', billingTier: '4K' })
// An omitted GPT size defaults to 2K: same price as 1K, four times the pixels.
assert.deepEqual(planSize('gpt'), { size: '2048x2048', billingTier: '2K' })
assert.deepEqual(planSize('minimax'), { area: '1K', aspectRatio: '1:1', billingTier: '1K' })
// The 655,360-pixel floor pushes 1K 16:9 over 1024px, so it bills as 2K.
assert.deepEqual(planSize('gpt', '1k', '16:9'), { size: '1088x608', billingTier: '2K' })
assert.deepEqual(planSize('gpt', '1k', '9:16'), { size: '608x1088', billingTier: '2K' })
assert.deepEqual(planSize('gpt', '1536x1024'), { size: '1536x1024', billingTier: '2K' })
assert.deepEqual(planSize('minimax', '1k', '16:9'), {
  area: '1K',
  aspectRatio: '16:9',
  billingTier: '1K',
})
assert.deepEqual(planSize('minimax', '4k', '1:1'), {
  area: '4K',
  aspectRatio: '1:1',
  billingTier: '4K',
})
// MiniMax explicit sizes are not subject to GPT's 16-px grid or 3840px cap.
assert.deepEqual(planSize('minimax', '5472x3072'), { size: '5472x3072' })
assert.deepEqual(planSize('minimax', '7104x2368'), { size: '7104x2368' })
assert.throws(() => planSize('minimax', '4096x1024'), /aspect ratio/)
assert.throws(() => planSize('minimax', '1552x422'), /total pixels/)
assert.throws(() => planSize('minimax', '1001x500'), /total pixels/)
assert.throws(() => planSize('gpt', '1000x1000'), /multiples of 16/)
assert.throws(() => planSize('gpt', '4096x4096'), /longest side/)
assert.throws(() => planSize('gpt', '1024x1024', '21:9'), /aspect must be one of/)

assert.equal(billingTierOfSize('1024x1024'), '1K')
assert.equal(billingTierOfSize('2048x1152'), '2K')
assert.equal(billingTierOfSize('2560x1440'), '4K')
assert.equal(billingTierOfSize('3840x2160'), '4K')
// "auto" must never be mistaken for 4K.
assert.equal(billingTierOfSize('auto'), undefined)
assert.equal(billingTierOfSize(undefined), undefined)

// --- accidental-4K guard ------------------------------------------------
const sunburst = MODEL_BY_ID.get('gpt-image-2.6-sunburst')
const upscale = MODEL_BY_ID.get('gpt-image-2.6-sunburst-4k-upscale')

assert.deepEqual(planBilledSize({ provider: 'gpt', entry: sunburst, size: '2k', aspect: '16:9' }), {
  size: '2048x1152',
  billingTier: '2K',
})
assert.deepEqual(planBilledSize({ provider: 'gpt', entry: sunburst, size: '2048x1152' }), {
  size: '2048x1152',
  billingTier: '2K',
})
assert.deepEqual(planBilledSize({ provider: 'gpt', entry: sunburst, size: '2048x2048' }), {
  size: '2048x2048',
  billingTier: '2K',
})
assert.deepEqual(planBilledSize({ provider: 'gpt', entry: sunburst }), {
  size: '2048x2048',
  billingTier: '2K',
})
// 2560x1440 is the classic "2K" that the gateway actually bills as 4K.
assert.throws(
  () => planBilledSize({ provider: 'gpt', entry: sunburst, size: '2560x1440', aspect: '16:9' }),
  /billed as 4K.*not 2K/,
)
// Portrait sizes must report the long side, not width 1440.
assert.throws(
  () => planBilledSize({ provider: 'gpt', entry: sunburst, size: '1440x2560' }),
  /longest side 2560/,
)
assert.deepEqual(
  planBilledSize({ provider: 'gpt', entry: sunburst, size: '2560x1440', aspect: '16:9', allow4k: true }),
  { size: '2560x1440', billingTier: '4K' },
)
assert.deepEqual(planBilledSize({ provider: 'gpt', entry: sunburst, size: '4k', aspect: '16:9' }), {
  size: '3840x2160',
  billingTier: '4K',
})
// 4K-only variants reject 2K instead of silently producing 4K.
assert.throws(() => planBilledSize({ provider: 'gpt', entry: upscale, size: '2k' }), /4K-only/)
assert.deepEqual(planBilledSize({ provider: 'gpt', entry: upscale }), {
  size: '2880x2880',
  billingTier: '4K',
})
assert.deepEqual(planBilledSize({ provider: 'gpt', entry: upscale, size: '4k', aspect: '16:9' }), {
  size: '3840x2160',
  billingTier: '4K',
})
// Token-billed Gemini models may use an exact 4K-ish size without the flag.
assert.deepEqual(
  planBilledSize({
    provider: 'gpt',
    entry: MODEL_BY_ID.get('gemini-3-pro-image'),
    size: '2560x1440',
    aspect: '16:9',
  }),
  { size: '2560x1440', billingTier: '4K' },
)
// MiniMax explicit sizes are unaffected by the GPT tier guard.
assert.deepEqual(
  planBilledSize({ provider: 'minimax', entry: standard, size: '5472x3072' }),
  { size: '5472x3072' },
)

// --- provider-specific limits ------------------------------------------
validatePrompt('a prompt')
assert.throws(() => validatePrompt('   '), /must not be empty/)
assert.throws(() => validatePrompt('x'.repeat(32_001)), /32,000 characters/)
validateCounts('gpt', 4, 16)
assert.throws(() => validateCounts('gpt', 5, 0), /1 to 4 for gpt/)
validateCounts('minimax', 10, 16)
assert.throws(() => validateCounts('minimax', 11, 0), /1 to 10 for minimax/)
assert.throws(() => validateCounts('minimax', 1, 17), /at most 16 reference images/)
assert.equal(validateQuality('gpt', undefined), 'auto')
assert.equal(validateQuality('gpt', 'high'), 'high')
assert.equal(validateQuality('minimax', undefined), undefined)
assert.equal(validateQuality('minimax', 'auto'), undefined)
assert.throws(() => validateQuality('minimax', 'high'), /GPT-only/)
assert.equal(normalizeFormat('jpg'), 'jpeg')
assert.equal(normalizeFormat('png'), 'png')
assert.equal(normalizeFormat('gif'), undefined)

// Every provider has a default model and every model carries pricing.
for (const provider of Object.values(PROVIDERS)) {
  assert.ok(MODEL_BY_ID.has(provider.defaultModel), `${provider.id} default model must be catalogued`)
}
for (const id of MODEL_IDS) {
  assert.ok(MODEL_BY_ID.get(id).pricing !== undefined, `${id} must declare pricing`)
}

// --- byte-level identification (format, real dimensions) ----------------
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const tinyPngInfo = imageInfoOf(TINY_PNG)
assert.deepEqual(tinyPngInfo, { format: 'png', width: 1, height: 1, bytes: TINY_PNG.length })
assert.equal(mimeOf('jpeg'), 'image/jpeg')
assert.equal(mimeOf(undefined), 'image/png')

function jpegHeader(width, height) {
  const bytes = Buffer.alloc(20)
  bytes.writeUInt16BE(0xffd8, 0)
  bytes.writeUInt16BE(0xffc0, 2)
  bytes.writeUInt16BE(17, 4)
  bytes[6] = 0x08
  bytes.writeUInt16BE(height, 7)
  bytes.writeUInt16BE(width, 9)
  return bytes
}
assert.deepEqual(
  (({ format, width, height }) => ({ format, width, height }))(imageInfoOf(jpegHeader(32, 16))),
  { format: 'jpeg', width: 32, height: 16 },
)

function webpLossy(width, height) {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(22, 4)
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8 ', 12, 'ascii')
  bytes.writeUInt32LE(10, 16)
  bytes[23] = 0x9d
  bytes[24] = 0x01
  bytes[25] = 0x2a
  bytes.writeUInt16LE(width, 26)
  bytes.writeUInt16LE(height, 28)
  return bytes
}
assert.deepEqual(
  (({ format, width, height }) => ({ format, width, height }))(imageInfoOf(webpLossy(320, 200))),
  { format: 'webp', width: 320, height: 200 },
)

const gif = Buffer.alloc(10)
gif.write('GIF89a', 0, 'ascii')
gif.writeUInt16LE(64, 6)
gif.writeUInt16LE(48, 8)
assert.deepEqual(
  (({ format, width, height }) => ({ format, width, height }))(imageInfoOf(gif)),
  { format: 'gif', width: 64, height: 48 },
)
assert.deepEqual(imageInfoOf(Buffer.from('not an image')), {
  format: null,
  width: null,
  height: null,
  bytes: 12,
})

// --- receipt helpers: redaction and hashing ----------------------------
assert.equal(sha256Hex(TINY_PNG), createHash('sha256').update(TINY_PNG).digest('hex'))
assert.match(makeReceiptId(), /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[0-9a-f]{8}$/)
assert.equal(
  redactUrl('https://user:pw@example.com/a.png?token=TOPSECRET#frag'),
  'https://example.com/a.png[redacted]',
)
assert.equal(redactUrl('https://example.com/a.png'), 'https://example.com/a.png')
assert.equal(redactUrl('/local/path.png'), '/local/path.png')
const redacted = redactText('Authorization: Bearer abc123 sk-TESTKEY12345678 https://x.test/y?token=zzz')
assert.ok(!redacted.includes('abc123'))
assert.ok(!redacted.includes('sk-TESTKEY12345678'))
assert.ok(!redacted.includes('zzz'))

// --- identity / reuse guard unit tests ---------------------------------
assert.equal(identityEditPhrase('把这张海报的脸改年轻一点'), '脸改')
assert.equal(identityEditPhrase('让五官再硬朗一点'), '五官再硬朗')
assert.equal(identityEditPhrase('新角色概念设计，更年轻的脸'), '更年轻的脸')
assert.equal(identityEditPhrase('一个年轻工程师在车间'), undefined)
assert.equal(identityEditPhrase('保持五官不变'), undefined)

const redactNoop = (value) => value
const preserved = evaluateIdentityGuard({
  prompt: '不要改脸，保持五官不变',
  images: ['/frame.png'],
  annotations: new Map(),
  redactUrl: redactNoop,
})
assert.equal(preserved.identityEditPrompt, false)
assert.equal(preserved.identityPreservationPrompt, true)

const textToImage = evaluateIdentityGuard({
  prompt: '更年轻的脸',
  images: [],
  annotations: new Map(),
  redactUrl: redactNoop,
})
assert.equal(textToImage.identityEditPrompt, true)
assert.equal(textToImage.warnings.length, 1)

const newCharacter = evaluateIdentityGuard({
  prompt: '新角色概念设计，让五官更硬朗',
  images: ['/style.png'],
  annotations: new Map(),
  redactUrl: redactNoop,
})
assert.equal(newCharacter.identityEditPrompt, true)
assert.match(newCharacter.warnings[0], /new-character\/concept/)

assert.throws(
  () =>
    evaluateIdentityGuard({
      prompt: '把这张海报的脸改年轻一点',
      images: ['/frame.png'],
      annotations: new Map(),
      redactUrl: redactNoop,
    }),
  /identity edit refused.*existing-identity context/s,
)
assert.throws(
  () =>
    evaluateIdentityGuard({
      prompt: '把脸改年轻一点',
      images: ['/frame.png'],
      annotations: new Map(),
      manifest: { path: '/project.json', entries: [{ key: '/root.png', role: 'identity_root', approved: true }] },
      redactUrl: redactNoop,
    }),
  /declares approved identity root\(s\) that were NOT passed as references: \/root\.png/,
)
const anchored = evaluateIdentityGuard({
  prompt: '把脸改年轻一点',
  images: ['/frame.png'],
  annotations: new Map([['/frame.png', { key: '/frame.png', role: 'identity_root', approved: true }]]),
  redactUrl: redactNoop,
})
assert.equal(anchored.identityEditPrompt, true)
assert.match(anchored.warnings[0], /approved identity reference is present/)

assert.deepEqual(REFERENCE_ROLES, ['identity_root', 'character_card', 'scene_card', 'keyframe', 'source_frame', 'style_ref', 'other'])
assert.deepEqual(IDENTITY_ROOT_ROLES, ['identity_root', 'character_card'])
assert.ok(CARD_ROLES.includes('scene_card'))

const reuse = reuseWarnings({
  images: ['/frame.png'],
  annotations: new Map([['/frame.png', { key: '/frame.png', role: 'source_frame', approved: false }]]),
  manifest: undefined,
  redactUrl: redactNoop,
})
assert.ok(reuse.some((warning) => /source_frame/.test(warning)))

// References must match the images actually sent.
const collectBase = { cwd: '/tmp', readFileSync, resolve: (cwd, p) => join(cwd, p), sha256Hex, redactUrl }
assert.throws(
  () =>
    collectReferences({
      ...collectBase,
      images: ['a.png'],
      references: [{ image: 'b.png', role: 'scene_card' }],
    }),
  /not one of the images being sent/,
)
assert.throws(
  () =>
    collectReferences({
      ...collectBase,
      images: ['a.png'],
      references: [{ image: 'a.png', role: 'face' }],
    }),
  /use one of identity_root/,
)
assert.throws(
  () =>
    collectReferences({
      ...collectBase,
      images: ['a.png'],
      references: [{ image: 'a.png', role: 'scene_card' }, { image: 'a.png', role: 'other' }],
    }),
  /annotated twice/,
)

// --- mocked end-to-end: dry_run, receipts, guards ----------------------
const root = mkdtempSync(join(tmpdir(), 'dsh-image-gen-verify-'))
const originalFetch = globalThis.fetch

/** Fresh tool bound to its own mock context. */
function makeTool(credentials = { async resolve() { return { value: 'test-key-SECRET' } } }) {
  const local = []
  apply(
    {
      tools: {
        register(definition) {
          local.push(definition)
        },
      },
      credentials,
      workingDirectory: {
        async ensure() {
          return process.cwd()
        },
      },
    },
    {},
  )
  return local.find((definition) => definition.name === 'image_generate')
}

/** Install a fetch mock; the handler receives the URL and options. */
async function withFetch(handler, fn) {
  const calls = []
  globalThis.fetch = async (input, options) => {
    const url = String(input)
    calls.push({ url, options })
    return handler(url, options)
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

function pngPayload(count = 1, size = '2048x1152') {
  return {
    data: Array.from({ length: count }, () => ({ b64_json: TINY_PNG.toString('base64'), size })),
  }
}

/** Assert a tool result matches the declared output schema exactly once. */
function assertValidOutput(result) {
  const violations = validateJsonSchemaValue(generateTool.output.schema, result)
  assert.deepEqual(violations, [])
}

function receiptsIn(outDir) {
  const dir = join(outDir, 'receipts')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => join(dir, file))
}

// --- exclusive writes: an existing file or receipt is never replaced ----
const exclusiveFile = join(root, 'exclusive.bin')
writeFileExclusive(exclusiveFile, Buffer.from('first-bytes'))
assert.deepEqual(readFileSync(exclusiveFile), Buffer.from('first-bytes'))
assert.throws(
  () => writeFileExclusive(exclusiveFile, Buffer.from('second-bytes')),
  /refusing to overwrite an existing file/,
)
assert.deepEqual(readFileSync(exclusiveFile), Buffer.from('first-bytes'))
const createdReceipt = join(root, 'created-receipt.json')
writeReceipt(createdReceipt, { owner: 'first' }, { create: true })
assert.throws(
  () => writeReceipt(createdReceipt, { owner: 'second' }, { create: true }),
  /refusing to overwrite an existing receipt/,
)
assert.equal(JSON.parse(readFileSync(createdReceipt, 'utf8')).owner, 'first')
// A receipt may update its own file after creation.
writeReceipt(createdReceipt, { owner: 'first', status: 'delivered' })
assert.equal(JSON.parse(readFileSync(createdReceipt, 'utf8')).status, 'delivered')

const refPng = join(root, 'ref.png')
writeFileSync(refPng, TINY_PNG)
const framePng = join(root, 'frame.png')
writeFileSync(framePng, TINY_PNG)
const refPngSha = sha256Hex(TINY_PNG)

try {
  // --- dry_run: no fetch, no credential lookup, plan + receipt ----------
  const dryOut = join(root, 'dry')
  const refusingTool = makeTool({
    async resolve() {
      throw new Error('credentials must not be read during dry_run')
    },
  })
  const dry = await withFetch(
    () => {
      throw new Error('dry_run must not call fetch')
    },
    async (calls) => {
      const result = await refusingTool.execute(
        {
          prompt: '一个空镜',
          provider: 'gpt',
          size: '2k',
          aspect: '16:9',
          images: [refPng],
          references: [{ image: refPng, role: 'scene_card', approved: true, source: 'approval-2026-11-15' }],
          dry_run: true,
          out_dir: dryOut,
        },
        {},
      )
      assert.equal(calls.length, 0)
      return result
    },
  )
  assert.equal(dry.dry_run, true)
  assert.deepEqual(dry.files, [])
  assert.deepEqual(dry.outputs, [])
  assert.equal(dry.size, '2048x1152')
  assert.equal(dry.plan.endpoint, '/images/edits')
  assert.equal(dry.plan.billing_tier, '2K')
  assert.equal(dry.cost.known, true)
  assert.equal(dry.cost.cny, 0.18)
  assert.equal(dry.cost.estimated, true)
  assert.equal(dry.cost.bill, false)
  assert.equal(dry.cost_cny, 0.18)
  assert.equal(dry.inputs.length, 1)
  assert.equal(dry.inputs[0].sha256, refPngSha)
  assert.equal(dry.inputs[0].role, 'scene_card')
  assert.equal(dry.inputs[0].approval, 'caller_declared')
  assert.equal(dry.inputs[0].checked, true)
  assert.ok(receiptsIn(dryOut).length === 1, 'dry_run must persist a plan receipt')
  assert.equal(JSON.parse(readFileSync(dry.receipt_path, 'utf8')).status, 'planned')
  assertValidOutput(dry)

  // --- dry_run with a remote reference: listed, not fetched -------------
  const remoteOut = join(root, 'dry-remote')
  const secretUrl = 'https://user:pw@example.com/ref.png?token=SUPERSECRET#frag'
  const remoteDry = await withFetch(
    () => {
      throw new Error('dry_run must not fetch remote references')
    },
    async (calls) => {
      const result = await refusingTool.execute(
        { prompt: '一个空镜', images: [secretUrl], dry_run: true, out_dir: remoteOut },
        {},
      )
      assert.equal(calls.length, 0)
      return result
    },
  )
  assert.equal(remoteDry.inputs[0].checked, false)
  assert.equal(remoteDry.inputs[0].sha256, null)
  assert.equal(remoteDry.inputs[0].image, 'https://example.com/ref.png[redacted]')
  assert.ok(remoteDry.warnings.some((warning) => /not fetched during dry_run/.test(warning)))
  const remoteReceipt = readFileSync(remoteDry.receipt_path, 'utf8')
  assert.ok(!remoteReceipt.includes('SUPERSECRET'))
  assertValidOutput(remoteDry)

  // --- dry_run: token-billed cost stays explicitly unknown --------------
  const minimaxDry = await refusingTool.execute(
    { prompt: '一个空镜', provider: 'minimax', size: '1k', dry_run: true, out_dir: join(root, 'dry-minimax') },
    {},
  )
  assert.equal(minimaxDry.provider, 'minimax')
  assert.equal(minimaxDry.size, '1K')
  assert.equal(minimaxDry.plan.planned_area, '1K')
  assert.equal(minimaxDry.cost.known, false)
  assert.equal(minimaxDry.cost.cny, null)
  assert.equal(minimaxDry.cost_cny, undefined)
  assert.match(minimaxDry.cost.note, /cost unknown/)
  assertValidOutput(minimaxDry)

  const geminiDry = await refusingTool.execute(
    {
      prompt: '一个空镜',
      model: 'gemini-3-pro-image',
      size: '2560x1440',
      aspect: '16:9',
      dry_run: true,
      out_dir: join(root, 'dry-gemini'),
    },
    {},
  )
  assert.equal(geminiDry.cost.known, false)
  assert.equal(geminiDry.cost_cny, undefined)

  // --- real run: receipt written before request, hashes, actual dims ----
  const realOut = join(root, 'real')
  const realTool = makeTool()
  let receiptDuringRequest
  const real = await withFetch(
    (url, options) => {
      if (url.endsWith('/images/edits')) {
        const files = receiptsIn(realOut)
        assert.equal(files.length, 1)
        receiptDuringRequest = JSON.parse(readFileSync(files[0], 'utf8'))
        assert.equal(receiptDuringRequest.status, 'requested')
        assert.equal(receiptDuringRequest.inputs[0].sha256, refPngSha)
        assert.ok(options.body instanceof FormData)
        assert.equal(options.body.getAll('image').length, 1)
        assert.equal(options.body.get('model'), 'gpt-image-2.6-sunburst')
        return jsonResponse(pngPayload())
      }
      throw new Error(`unexpected fetch ${url}`)
    },
    async () =>
      realTool.execute(
        {
          prompt: '一个空镜',
          images: [refPng],
          references: [{ image: refPng, role: 'scene_card', approved: true, source: 'approval-2026-11-15' }],
          size: '2k',
          aspect: '16:9',
          format: 'jpeg',
          out_dir: realOut,
          label: 'shot-01',
        },
        {},
      ),
  )
  assert.equal(real.files.length, 1)
  // GPT 2.6 can answer PNG for a jpeg request; the saved extension follows bytes.
  assert.match(real.files[0], /\.png$/)
  assert.equal(real.format, 'png')
  assert.equal(real.size, '1x1')
  assert.equal(real.cost.known, true)
  assert.equal(real.cost.cny, 0.18)
  assert.equal(real.cost.bill, false)
  assert.equal(real.outputs[0].sha256, sha256Hex(readFileSync(real.files[0])))
  assert.equal(real.outputs[0].sha256, refPngSha)
  assert.deepEqual([real.outputs[0].width, real.outputs[0].height], [1, 1])
  assert.equal(real.outputs[0].billing_tier, '2K')
  const realReceiptText = readFileSync(real.receipt_path, 'utf8')
  assert.ok(!realReceiptText.includes('test-key-SECRET'), 'the API key must never enter a receipt')
  assert.ok(!realReceiptText.includes('Authorization'))
  const realReceipt = JSON.parse(realReceiptText)
  assert.equal(realReceipt.status, 'delivered')
  assert.equal(realReceipt.label, 'shot-01')
  assert.equal(realReceipt.request.prompt_sha256, sha256Hex('一个空镜'))
  assert.equal(realReceipt.outputs[0].sha256, real.outputs[0].sha256)
  assert.equal(realReceipt.inputs[0].approval, 'caller_declared')
  assert.equal(realReceipt.cost.bill, false)
  assert.equal(realReceipt.cost.estimated, true)
  assert.match(realReceipt.approval_policy, /caller-declared/)
  assertValidOutput(real)

  // --- real run over two references: repeated image fields --------------
  const pairOut = join(root, 'pair')
  const pair = await withFetch(
    (url, options) => {
      if (!url.endsWith('/images/edits')) throw new Error(`unexpected fetch ${url}`)
      assert.equal(options.body.getAll('image').length, 2)
      return jsonResponse(pngPayload())
    },
    async () =>
      realTool.execute(
        { prompt: '合成', images: [refPng, framePng], n: 1, out_dir: pairOut },
        {},
      ),
  )
  assert.equal(pair.inputs.length, 2)
  assert.equal(pair.warnings.some((warning) => /no references metadata/.test(warning)), true)

  // --- manifest: path+sha pinned, expected sha checked, reuse warning ---
  const manifestPath = join(root, 'assets.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({
      assets: [
        {
          id: 'scene-01',
          kind: 'scene',
          path: refPng,
          sha256: refPngSha,
          approval: { status: 'approved' },
          approval_evidence: 'user approved 2026-11-15',
          origin: 'project',
          root_ids: [],
        },
        { id: 'scene-02', kind: 'scene', path: framePng, approved: true },
      ],
    }),
  )
  const manifestOut = join(root, 'manifest')
  const manifestDry = await refusingTool.execute(
    {
      prompt: '空镜',
      images: [refPng],
      references_file: manifestPath,
      dry_run: true,
      out_dir: manifestOut,
    },
    {},
  )
  assert.equal(manifestDry.inputs[0].role, 'scene_card')
  assert.equal(manifestDry.inputs[0].approved, true)
  assert.equal(manifestDry.inputs[0].sha256_match, true)
  assert.equal(manifestDry.inputs[0].asset_id, 'scene-01')
  assert.match(manifestDry.inputs[0].approval_evidence, /user approved/)
  const manifestReceipt = JSON.parse(readFileSync(manifestDry.receipt_path, 'utf8'))
  assert.equal(manifestReceipt.references_manifest.path, manifestPath)
  assert.equal(manifestReceipt.references_manifest.sha256, sha256Hex(readFileSync(manifestPath)))
  assert.match(manifestReceipt.approval_policy, /sha256/)
  assert.ok(
    manifestDry.warnings.some((warning) => /available but not marked required and not passed/.test(warning)),
    'an approved manifest asset that was not passed must be reported',
  )

  // A manifest entry whose expected hash no longer matches refuses the call.
  writeFileSync(
    manifestPath,
    JSON.stringify({ assets: [{ path: refPng, role: 'scene_card', approved: true, sha256: 'f'.repeat(64) }] }),
  )
  await assert.rejects(
    refusingTool.execute(
      { prompt: '空镜', images: [refPng], references_file: manifestPath, dry_run: true, out_dir: join(root, 'mismatch') },
      {},
    ),
    /reference hash mismatch/,
  )

  // A manifest-declared approved root that was not passed refuses a face edit.
  writeFileSync(
    manifestPath,
    JSON.stringify({ assets: [{ id: 'root', path: refPng, role: 'identity_root', approved: true, sha256: refPngSha }] }),
  )
  await assert.rejects(
    refusingTool.execute(
      {
        prompt: '把这张海报的脸改年轻一点',
        images: [framePng],
        references_file: manifestPath,
        dry_run: true,
        out_dir: join(root, 'unused-root'),
      },
      {},
    ),
    /declares approved identity root\(s\) that were NOT passed/,
  )

  // A registry manifest may store paths relative to itself; those still match.
  const registryDir = join(root, 'registry')
  mkdirSync(registryDir, { recursive: true })
  const relativeManifest = join(registryDir, 'assets.json')
  writeFileSync(
    relativeManifest,
    JSON.stringify({
      assets: [
        { id: 'rel-scene', kind: 'scene', path: '../ref.png', approved: true, sha256: refPngSha },
        // An unused entry with an audit hash this plugin cannot compare must not
        // block the call; only a used invalid hash is refused.
        { id: 'unused', path: '/elsewhere/unrelated.png', approved: false, sha256: 'not-a-sha' },
      ],
    }),
  )
  const relativeDry = await refusingTool.execute(
    {
      prompt: '相对路径清单',
      images: [refPng],
      references_file: relativeManifest,
      dry_run: true,
      out_dir: join(root, 'relative-manifest'),
    },
    {},
  )
  assert.equal(relativeDry.inputs[0].role, 'scene_card')
  assert.equal(relativeDry.inputs[0].sha256_match, true)
  assert.equal(relativeDry.inputs[0].asset_id, 'rel-scene')

  // A lead-style project.json (project_root + string approval + root_ids) also works.
  const aiVideoDir = join(root, '.ai-video')
  mkdirSync(aiVideoDir, { recursive: true })
  const projectFile = join(aiVideoDir, 'project.json')
  writeFileSync(
    projectFile,
    JSON.stringify({
      schema: 'dsh.ai-video-project/1',
      project_root: '..',
      assets: [
        {
          id: 'zhou-root',
          kind: 'character',
          path: 'ref.png',
          sha256: refPngSha,
          approval: 'locked',
          approval_evidence: 'user approved 2026-11-12',
          origin: 'project',
          required: true,
          root_ids: [],
        },
      ],
      shots: [],
    }),
  )
  const projectDry = await refusingTool.execute(
    {
      prompt: '项目清单',
      images: [refPng],
      references_file: projectFile,
      dry_run: true,
      out_dir: join(root, 'project-manifest'),
    },
    {},
  )
  assert.equal(projectDry.inputs[0].role, 'character_card')
  assert.equal(projectDry.inputs[0].approved, true)
  assert.equal(projectDry.inputs[0].approval, 'caller_declared')
  assert.equal(projectDry.inputs[0].asset_id, 'zhou-root')
  assert.equal(projectDry.inputs[0].required, true)
  assert.deepEqual(projectDry.inputs[0].root_ids, [])

  // --- required-reference contract: missing or drifted blocks pre-payment --
  const requiredMissingManifest = join(root, 'required-missing.json')
  writeFileSync(
    requiredMissingManifest,
    JSON.stringify({
      assets: [
        { id: 'req-root', path: framePng, role: 'identity_root', approved: true, required: true, sha256: refPngSha },
        { id: 'other-scene', path: refPng, role: 'scene_card', approved: true, sha256: refPngSha },
      ],
    }),
  )
  // Missing required reference: refused before credentials/network.
  await withFetch(
    () => {
      throw new Error('a missing required reference must not reach the network')
    },
    async (calls) => {
      await assert.rejects(
        refusingTool.execute(
          { prompt: '镜头复用', images: [refPng], references_file: requiredMissingManifest, dry_run: true, out_dir: join(root, 'required-missing') },
          {},
        ),
        /marks 1 reference\(s\) as required.*not passed in images: .*req-root/,
      )
      assert.equal(calls.length, 0)
      assert.equal(receiptsIn(join(root, 'required-missing')).length, 0)
    },
  )
  const requiredManifest = join(root, 'required.json')
  writeFileSync(
    requiredManifest,
    JSON.stringify({
      assets: [
        { id: 'req-root', path: refPng, role: 'identity_root', approved: true, required: true, sha256: refPngSha, approval_evidence: 'user approved 2026-11-15' },
        { id: 'other-scene', path: framePng, role: 'scene_card', approved: true, sha256: refPngSha },
      ],
    }),
  )
  // Present required reference with drifted bytes: refused before the request.
  const driftedFile = join(root, 'drifted.png')
  writeFileSync(driftedFile, Buffer.concat([TINY_PNG, Buffer.from('drift')]))
  const driftManifest = join(root, 'required-drift.json')
  writeFileSync(
    driftManifest,
    JSON.stringify({
      assets: [{ id: 'req-root', path: driftedFile, role: 'identity_root', approved: true, required: true, sha256: refPngSha }],
    }),
  )
  await withFetch(
    () => {
      throw new Error('a required hash drift must not reach the network')
    },
    async (calls) => {
      await assert.rejects(
        refusingTool.execute(
          { prompt: '镜头复用', images: [driftedFile], references_file: driftManifest, dry_run: true, out_dir: join(root, 'required-drift2') },
          {},
        ),
        /reference hash mismatch .*required by references_file/,
      )
      assert.equal(calls.length, 0)
    },
  )
  // Required and present: passes, records required=true and the manifest count.
  const requiredOut = join(root, 'required-ok')
  const requiredDry = await refusingTool.execute(
    {
      prompt: '镜头复用',
      images: [refPng],
      references_file: requiredManifest,
      dry_run: true,
      out_dir: requiredOut,
    },
    {},
  )
  assert.equal(requiredDry.inputs[0].required, true)
  assert.equal(requiredDry.inputs[0].sha256_match, true)
  const requiredReceipt = JSON.parse(readFileSync(requiredDry.receipt_path, 'utf8'))
  assert.equal(requiredReceipt.references_manifest.required, 1)
  assert.equal(
    requiredDry.warnings.some((warning) => /available but not marked required/.test(warning)),
    false,
    'with an authoritative required list, non-required approved assets must not be nagged',
  )
  // A required entry without sha256 keeps presence enforcement but warns that
  // content drift is undetectable.
  const requiredNoHash = join(root, 'required-nohash.json')
  writeFileSync(requiredNoHash, JSON.stringify({ assets: [{ id: 'no-hash', path: refPng, role: 'scene_card', required: true }] }))
  const noHashDry = await refusingTool.execute(
    { prompt: '镜头复用', images: [refPng], references_file: requiredNoHash, dry_run: true, out_dir: join(root, 'required-nohash') },
    {},
  )
  assert.ok(noHashDry.warnings.some((warning) => /has no sha256 .* content drift cannot be detected/.test(warning)))
  assert.equal(noHashDry.inputs[0].required, true)

  // A malformed required flag is a contract error, not a silent false.
  // A malformed required flag is a contract error, not a silent false.
  writeFileSync(
    requiredManifest,
    JSON.stringify({ assets: [{ path: refPng, role: 'identity_root', required: 'yes' }] }),
  )
  await assert.rejects(
    refusingTool.execute(
      { prompt: 'x', images: [refPng], references_file: requiredManifest, dry_run: true, out_dir: join(root, 'required-bad') },
      {},
    ),
    /"required" must be a boolean/,
  )

  // --- identity guard: refuses before any fetch / credential use --------
  await withFetch(
    () => {
      throw new Error('a refused identity edit must not call fetch')
    },
    async (calls) => {
      await assert.rejects(
        refusingTool.execute(
          {
            prompt: '把这张海报的脸改年轻一点',
            images: [framePng],
            out_dir: join(root, 'guard'),
          },
          {},
        ),
        /identity edit refused before any request/,
      )
      assert.equal(calls.length, 0)
      assert.equal(receiptsIn(join(root, 'guard')).length, 0)
    },
  )

  // Preservation wording is not an edit; the call proceeds.
  const preservedDry = await refusingTool.execute(
    {
      prompt: '不要改脸，只调整光线',
      images: [framePng],
      dry_run: true,
      out_dir: join(root, 'preserve'),
    },
    {},
  )
  assert.ok(!preservedDry.warnings.some((warning) => /face\/identity/.test(warning)))

  const preservedReceipt = JSON.parse(readFileSync(preservedDry.receipt_path, 'utf8'))
  assert.equal(preservedReceipt.guard.identity_preservation_prompt, true)
  assert.equal(preservedReceipt.guard.identity_edit_prompt, false)

  // New character concept design works without an approved root.
  const conceptDry = await refusingTool.execute(
    {
      prompt: '新角色概念设计，让五官更硬朗',
      images: [framePng],
      dry_run: true,
      out_dir: join(root, 'concept'),
    },
    {},
  )
  assert.ok(conceptDry.warnings.some((warning) => /new-character\/concept/.test(warning)))

  // Declaring an approved root allows the edit and records caller-declared approval.
  const anchoredDry = await refusingTool.execute(
    {
      prompt: '把脸改年轻一点',
      images: [framePng],
      references: [{ image: framePng, role: 'identity_root', approved: true, source: 'approval-2026-11-15' }],
      dry_run: true,
      out_dir: join(root, 'anchored'),
    },
    {},
  )
  assert.equal(anchoredDry.inputs[0].approval, 'caller_declared')
  assert.ok(anchoredDry.warnings.some((warning) => /approved identity reference is present/.test(warning)))
  const anchoredReceipt = JSON.parse(readFileSync(anchoredDry.receipt_path, 'utf8'))
  assert.equal(anchoredReceipt.guard.identity_edit_prompt, true)
  assert.equal(anchoredReceipt.guard.approved_identity_references, 1)

  // --- failure after the request: receipt is marked failed --------------
  const failedOut = join(root, 'failed')
  await withFetch(
    () =>
      new Response(JSON.stringify({ error: { message: 'boom from the gateway' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    async () => {
      await assert.rejects(
        realTool.execute({ prompt: '失败路径', images: [refPng], out_dir: failedOut }, {}),
        /TeamoRouter 500: boom from the gateway/,
      )
    },
  )
  const failedReceipts = receiptsIn(failedOut)
  assert.equal(failedReceipts.length, 1)
  const failedReceipt = JSON.parse(readFileSync(failedReceipts[0], 'utf8'))
  assert.equal(failedReceipt.status, 'failed')
  assert.match(failedReceipt.error, /boom from the gateway/)
  assert.equal(failedReceipt.inputs[0].sha256, refPngSha)
  assert.ok(!JSON.stringify(failedReceipt).includes('test-key-SECRET'))

  // --- remote reference: bounded read, local copy, signed URL not kept --
  const remoteRealOut = join(root, 'remote-real')
  const remoteSecretUrl = 'https://cdn.example.com/ref.png?token=REFTOKEN'
  const remoteReal = await withFetch(
    (url) => {
      if (url === remoteSecretUrl) {
        return new Response(TINY_PNG, { status: 200, headers: { 'content-type': 'image/png' } })
      }
      if (url.endsWith('/images/edits')) return jsonResponse(pngPayload())
      throw new Error(`unexpected fetch ${url}`)
    },
    async () =>
      realTool.execute({ prompt: '远端参考', images: [remoteSecretUrl], out_dir: remoteRealOut }, {}),
  )
  assert.equal(remoteReal.inputs[0].source_type, 'url')
  assert.equal(remoteReal.inputs[0].checked, true)
  assert.equal(remoteReal.inputs[0].sha256, refPngSha)
  assert.ok(existsSync(remoteReal.inputs[0].local_copy))
  assert.deepEqual(readFileSync(remoteReal.inputs[0].local_copy), TINY_PNG)
  const remoteRealReceipt = readFileSync(remoteReal.receipt_path, 'utf8')
  assert.ok(!remoteRealReceipt.includes('REFTOKEN'))
  assertValidOutput(remoteReal)

  // An oversized declared Content-Length is refused before the body is read.
  const oversizedUrl = 'https://cdn.example.com/huge.png'
  await withFetch(
    (url) => {
      if (url === oversizedUrl) {
        return new Response(TINY_PNG, {
          status: 200,
          headers: { 'content-length': String(64 * 1024 * 1024 + 1), 'content-type': 'image/png' },
        })
      }
      throw new Error('the generation request must not run after a refused reference')
    },
    async () => {
      await assert.rejects(
        realTool.execute({ prompt: '超大参考', images: [oversizedUrl], out_dir: join(root, 'oversized') }, {}),
        /over the 67108864-byte limit/,
      )
    },
  )

  // A stream without Content-Length is still read correctly under the cap.
  const streamUrl = 'https://cdn.example.com/stream.png'
  const streamReal = await withFetch(
    (url) => {
      if (url === streamUrl) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(TINY_PNG.subarray(0, 40)))
            controller.enqueue(new Uint8Array(TINY_PNG.subarray(40)))
            controller.close()
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } })
      }
      if (url.endsWith('/images/edits')) return jsonResponse(pngPayload())
      throw new Error(`unexpected fetch ${url}`)
    },
    async () =>
      realTool.execute({ prompt: '流式参考', images: [streamUrl], out_dir: join(root, 'stream') }, {}),
  )
  assert.equal(streamReal.inputs[0].sha256, refPngSha)

  // --- 4K guard still refuses before any request ------------------------
  await withFetch(
    () => {
      throw new Error('the 4K guard must run before the request')
    },
    async (calls) => {
      await assert.rejects(
        realTool.execute(
          { prompt: 'verify', size: '2560x1440', aspect: '16:9', out_dir: join(root, 'guard4k') },
          {},
        ),
        /billed as 4K.*not 2K/,
      )
      assert.equal(calls.length, 0)
    },
  )

  // --- same prompt + same second: distinct files, original bytes intact ---
  const RealDate = Date
  const FIXED = RealDate.parse('2026-11-16T10:30:00.000Z')
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [FIXED] : args))
    }
    static now() {
      return FIXED
    }
  }
  globalThis.Date = FixedDate
  try {
    const concurrentOut = join(root, 'concurrent')
    await withFetch(
      () => jsonResponse(pngPayload()),
      async () => {
        const firstCall = await realTool.execute({ prompt: '并发同秒', out_dir: concurrentOut }, {})
        const firstBytes = readFileSync(firstCall.files[0])
        const secondCall = await realTool.execute({ prompt: '并发同秒', out_dir: concurrentOut }, {})
        assert.notEqual(firstCall.files[0], secondCall.files[0])
        assert.notEqual(firstCall.receipt_id, secondCall.receipt_id)
        assert.deepEqual(readFileSync(firstCall.files[0]), firstBytes, 'the first delivery must keep its bytes')
        assert.equal(receiptsIn(concurrentOut).length, 2)
        const firstReceipt = JSON.parse(readFileSync(firstCall.receipt_path, 'utf8'))
        assert.equal(firstReceipt.status, 'delivered')
        assert.equal(firstReceipt.outputs[0].sha256, sha256Hex(firstBytes))
      },
    )
  } finally {
    globalThis.Date = RealDate
  }

  // Two images cost twice one image; the receipt sums the delivered tiers.
  const costOut = join(root, 'cost')
  await withFetch(
    () => jsonResponse(pngPayload(2, '2048x2048')),
    async () => {
      const pairCost = await realTool.execute({ prompt: '两张', n: 2, out_dir: costOut }, {})
      assert.equal(pairCost.cost.cny, 0.36)
      assert.equal(pairCost.outputs.length, 2)
      assert.equal(pairCost.billing_tier, '2K')
    },
  )
  // --- native empty-string serialization: '' means "no manifest" --------
  // The tool schema serializes an unset references_file as '', which must behave
  // like undefined; resolving it would stat the cwd and fail with EISDIR.
  const blankOut = join(root, 'blank-manifest')
  const blankDry = await withFetch(
    () => {
      throw new Error('an empty references_file must not fetch anything')
    },
    async (calls) => {
      const first = await refusingTool.execute(
        { prompt: '空字段兼容', references_file: '', dry_run: true, out_dir: blankOut },
        {},
      )
      const second = await refusingTool.execute(
        { prompt: '空字段兼容', references_file: '   ', dry_run: true, out_dir: join(root, 'blank-manifest-2') },
        {},
      )
      assert.equal(calls.length, 0)
      assert.equal(second.dry_run, true)
      return first
    },
  )
  assert.equal(blankDry.dry_run, true)
  assert.deepEqual(blankDry.files, [])
  assert.equal(blankDry.plan.reference_count, 0)
  assertValidOutput(blankDry)
  const blankReceipt = JSON.parse(readFileSync(blankDry.receipt_path, 'utf8'))
  assert.equal(blankReceipt.references_manifest, null)
  assert.equal(blankReceipt.status, 'planned')

  // A non-empty but missing manifest is still a hard error before any network.
  await withFetch(
    () => {
      throw new Error('a missing manifest must not reach the network')
    },
    async (calls) => {
      await assert.rejects(
        refusingTool.execute(
          { prompt: '空字段兼容', references_file: join(root, 'no-such-manifest.json'), dry_run: true, out_dir: join(root, 'missing-manifest') },
          {},
        ),
        /cannot read references_file/,
      )
      assert.equal(calls.length, 0)
    },
  )

} finally {
  globalThis.fetch = originalFetch
  rmSync(root, { recursive: true, force: true })
}

console.log('dsh-image-gen: verify ok')
