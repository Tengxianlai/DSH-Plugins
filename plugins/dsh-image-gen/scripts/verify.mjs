// 轻量自检：入口可加载、两个工具可注册、provider/model 解析、档位/计费规则与
// 2026-11-15 的实际账单口径一致。不发起网络请求，所以离线、零成本、可重复。
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
const ctx = {
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
apply(ctx, {})

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
assert.match(params.properties.size.description, /Billing tier/)
assert.match(params.properties.size.description, /2560x1440 is 4K billing/)
assert.match(generateTool.description, /BILLING TIER/)
assert.match(generateTool.description, /¥0\.60/)
assert.ok(params.properties.model.enum.includes('MiniMax-H3-Image'))
assert.ok(params.properties.model.enum.includes('MiniMax-H3-Image-Highspeed'))
assert.ok(params.properties.quality.enum.includes('high'))
assert.deepEqual(generateTool.output.schema.required, ['files', 'provider', 'size', 'model'])
assert.ok('format' in generateTool.output.schema.properties)
assert.ok('billing_tier' in generateTool.output.schema.properties)
assert.equal(generateTool.output.schema.properties.cost_cny.type, 'number')
assert.ok('failed' in generateTool.output.schema.properties)

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

// --- mocked end-to-end execute: request shape, tier, cost_cny ----------
// No network and no real image: fetch is replaced with a tiny PNG response.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const execDefinitions = []
apply(
  {
    tools: {
      register(definition) {
        execDefinitions.push(definition)
      },
    },
    credentials: {
      async resolve() {
        return { value: 'test-key' }
      },
    },
    workingDirectory: {
      async ensure() {
        return process.cwd()
      },
    },
  },
  {},
)
const execTool = execDefinitions.find((definition) => definition.name === 'image_generate')
assert.ok(execTool !== undefined)

const outDir = mkdtempSync(join(process.cwd(), '.verify-images-'))
const originalFetch = globalThis.fetch
let requestBody
const respond = (size, count = 1) => {
  globalThis.fetch = async (_url, options) => {
    requestBody = options?.body === undefined ? undefined : JSON.parse(options.body)
    const data = Array.from({ length: count }, () => ({ b64_json: TINY_PNG, size }))
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}
try {
  respond('2048x1152')
  const twoK = await execTool.execute(
    { prompt: 'verify', size: '2k', aspect: '16:9', out_dir: outDir },
    {},
  )
  assert.equal(requestBody.size, '2048x1152')
  assert.equal(requestBody.quality, 'auto')
  assert.equal(twoK.size, '2048x1152')
  assert.equal(twoK.billing_tier, '2K')
  assert.equal(twoK.cost_cny, 0.18)
  assert.equal(twoK.files.length, 1)

  // Omitted size defaults to 2K for GPT; two images cost twice one image.
  respond('2048x2048', 2)
  const pair = await execTool.execute({ prompt: 'verify', n: 2, out_dir: outDir }, {})
  assert.equal(requestBody.size, '2048x2048')
  assert.equal(pair.billing_tier, '2K')
  assert.equal(pair.cost_cny, 0.36)

  // Explicit 4K pixels require allow_4k and are priced as 4K.
  respond('2560x1440')
  const fourK = await execTool.execute(
    { prompt: 'verify', size: '2560x1440', aspect: '16:9', allow_4k: true, out_dir: outDir },
    {},
  )
  assert.equal(requestBody.size, '2560x1440')
  assert.equal(fourK.billing_tier, '4K')
  assert.equal(fourK.cost_cny, 0.6)

  // The guard must reject before spending the request.
  let fetched = false
  globalThis.fetch = async () => {
    fetched = true
    return new Response('{}', { status: 200 })
  }
  await assert.rejects(
    execTool.execute({ prompt: 'verify', size: '2560x1440', aspect: '16:9', out_dir: outDir }, {}),
    /billed as 4K.*not 2K/,
  )
  assert.equal(fetched, false, 'the 4K guard must run before the request')
} finally {
  globalThis.fetch = originalFetch
  rmSync(outDir, { recursive: true, force: true })
}

console.log('dsh-image-gen: verify ok')
