// 轻量自检：入口可加载、两个工具可注册、provider/model 解析与尺寸/计费规则符合
// 2026-11-14 的文档快照。不发起网络请求，所以离线、零成本、可重复。
import { strict as assert } from 'node:assert'
import { apply, inject, name } from '../index.js'
import {
  ASPECTS,
  MINIMAX_4K_PROMO,
  MINIMAX_MODELS,
  MODEL_BY_ID,
  MODEL_IDS,
  PROVIDERS,
  billingTierOfSize,
  catalogText,
  normalizeFormat,
  planSize,
  resolveSelection,
  validateCounts,
  validatePrompt,
  validateQuality,
} from '../lib/catalog.js'

assert.equal(name, 'image-gen')
assert.deepEqual(inject, ['tools', 'workingDirectory', 'credentials'])
assert.equal(typeof apply, 'function')

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
assert.ok(params.properties.model.enum.includes('MiniMax-H3-Image'))
assert.ok(params.properties.model.enum.includes('MiniMax-H3-Image-Highspeed'))
assert.ok(params.properties.quality.enum.includes('high'))
assert.deepEqual(generateTool.output.schema.required, ['files', 'provider', 'size', 'model'])
assert.ok('format' in generateTool.output.schema.properties)
assert.ok('billing_tier' in generateTool.output.schema.properties)
assert.ok('failed' in generateTool.output.schema.properties)

const catalog = await modelsTool.execute({}, {})
assert.match(catalog.text, /MiniMax-H3-Image/)
assert.match(catalog.text, /¥0\.2261/)
assert.match(catalog.text, /¥0\.4275/)
assert.match(catalog.text, /3840x2160/)
assert.match(catalog.text, /gpt-image-2\.6-sunburst \(default\)/)
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
assert.deepEqual(planSize('gpt', '2k', '16:9'), { size: '2048x1152', billingTier: '2K' })
assert.deepEqual(planSize('gpt', '4k', '16:9'), { size: '3840x2160', billingTier: '4K' })
// 4K square is capped by the 8,294,400-pixel limit, not stretched to 4096.
assert.deepEqual(planSize('gpt', '4k', '1:1'), { size: '2880x2880', billingTier: '4K' })
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
assert.equal(billingTierOfSize('3840x2160'), '4K')

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

console.log('dsh-image-gen: verify ok')
