/**
 * Static catalog for the image providers, models, capabilities and the price
 * snapshot used by `image_generate` / `image_models`.
 *
 * Keep prices in one place: when a provider changes its table, update the
 * snapshot here and the README together. The plugin never derives a price from
 * a request, because both providers bill by their own rules (GPT per delivered
 * image tier, MiniMax by tokens with prompt-enhancement included).
 *
 * GPT tiers are the one place where the public price page and the account
 * statement disagree: TeamoRouter still advertises a flat $0.02/image for GPT
 * Image 2.6, but a 4K delivery is billed at about ¥0.60 on this account
 * (user-confirmed 2026-11-15). The catalog therefore quotes the observed CNY
 * amount (1K = 2K = ¥0.18, 4K = ¥0.60) instead of the advertised USD figure.
 * Under-quoting 4K is what made callers treat it as free; over-quoting it only
 * makes them choose 2K, which is the safe side.
 */

/** Date of the price snapshot shown by `image_models` and the README. */
export const PRICE_AS_OF = '2026-11-15'

/**
 * GPT per-delivered-image tiers in CNY, as reported for this account.
 * 1K and 2K are the same price on purpose: 2K is the default and the only
 * sensible choice unless 4K detail is actually required.
 */
export const GPT_TIER_PRICES_CNY = Object.freeze({ '1K': 0.18, '2K': 0.18, '4K': 0.60 })

/** Per-provider `size` used when the caller omits it. */
export function defaultSizeFor(provider) {
  return provider === 'gpt' ? '2k' : '1k'
}

/** MiniMax 4K launch promo: 50% off a delivered image of at least 16.6MP. */
export const MINIMAX_4K_PROMO = Object.freeze({
  until: '2026-11-18T00:00:00+08:00',
  discount: 0.5,
  minPixels: 16_600_000,
})

/** Where the snapshot came from; the README links these too. */
export const PRICE_SOURCES = Object.freeze({
  teamorouter: 'https://api.teamorouter.com/v1/models/pricing',
  minimax: 'https://platform.minimax.cn/docs/pricing/overview',
})

export const TIER_KEYS = Object.freeze(['1k', '2k', '4k'])
export const ASPECTS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'])
export const FORMATS = Object.freeze(['png', 'jpeg', 'webp'])
export const QUALITIES = Object.freeze(['auto', 'low', 'medium', 'high'])

export const PROVIDERS = {
  gpt: {
    id: 'gpt',
    label: 'GPT Image (TeamoRouter)',
    apiLabel: 'TeamoRouter',
    keyRef: 'TEAMOROUTER_API_KEY',
    keyFile: 'secrets/teamorouter.env',
    baseURL: 'https://api.teamorouter.com/v1',
    defaultModel: 'gpt-image-2.6-sunburst',
    capabilities: {
      textToImage: true,
      imageToImage: true,
      multiReference: true,
      maxReferences: 16,
      maxImages: 4,
      qualities: QUALITIES,
      formats: FORMATS,
      promptMaxChars: 32_000,
      promptEnhancement: false,
      sizeSummary:
        'billing tiers 1k/2k/4k (delivered longest side 1024/2048/3840; default 2k) or WIDTHxHEIGHT: sides multiples of 16, longest <= 3840, total 655,360-8,294,400 px',
      priceSummary:
        'per delivered image, CNY: 1K/2K ¥0.18, 4K ¥0.60; tier follows the delivered image longest side (<=1024 1K, <=2048 2K, >2048 4K)',
    },
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax H3-Image',
    apiLabel: 'MiniMax',
    keyRef: 'MINIMAX_API_KEY',
    keyFile: 'secrets/minimax.env',
    baseURL: 'https://api.minimax.cn/v1',
    defaultModel: 'MiniMax-H3-Image',
    capabilities: {
      textToImage: true,
      imageToImage: true,
      multiReference: true,
      maxReferences: 16,
      maxImages: 10,
      qualities: null,
      formats: FORMATS,
      promptMaxChars: 32_000,
      promptEnhancement: true,
      sizeSummary:
        'area 1K/2K/4K (1024^2/2048^2/4096^2 target area) + aspect_ratio 1:3-3:1, or WIDTHxHEIGHT: total 655,360-20,000,000 px and ratio 1:3-3:1',
      priceSummary:
        'tokens: text input, image input (per reference) and image output; prompt enhancement tokens are included',
    },
  },
}

/** Per-image TeamoRouter price for one GPT model (tiers are shared). */
function gptPerImage() {
  return {
    currency: 'CNY',
    mode: 'per_image',
    tiers: GPT_TIER_PRICES_CNY,
  }
}

/** Token-billed TeamoRouter price for one Gemini image model (USD per MTok). */
function geminiToken(inputPerMTok, outputPerMTok, listInputPerMTok, listOutputPerMTok) {
  return {
    currency: 'USD',
    mode: 'token',
    inputPerMTok,
    outputPerMTok,
    listInputPerMTok,
    listOutputPerMTok,
  }
}

/** One MiniMax per-image reference row: 1K/2K list price, 4K list + promo. */
function minimaxRow(scene, text1k, text2k, text4k, promo4k) {
  return {
    scene,
    prices: {
      '1K': { list: text1k },
      '2K': { list: text2k },
      '4K': { list: text4k, promo: promo4k },
    },
  }
}

/** Common MiniMax pricing shape. */
function minimaxPricing(textInputPerMTok, imageInputPerMTok, outputPerMTok, rows) {
  return {
    currency: 'CNY',
    mode: 'token',
    tokenRates: { textInputPerMTok, imageInputPerMTok, outputPerMTok },
    rows,
  }
}

export const MODELS = Object.freeze([
  {
    id: 'gpt-image-2.6-sunburst',
    provider: 'gpt',
    label: 'GPT Image 2.6 Sunburst',
    note: 'best detail and instruction following',
    pricing: gptPerImage(),
  },
  {
    id: 'gpt-image-2.6-flare',
    label: 'GPT Image 2.6 Flare',
    provider: 'gpt',
    note: 'faster iteration',
    pricing: gptPerImage(),
  },
  {
    id: 'gpt-image-2.5-sunburst',
    provider: 'gpt',
    label: 'GPT Image 2.5 Sunburst',
    note: 'previous generation',
    pricing: gptPerImage(),
  },
  {
    id: 'gpt-image-2.5-flare',
    provider: 'gpt',
    label: 'GPT Image 2.5 Flare',
    note: 'previous generation, faster',
    pricing: gptPerImage(),
  },
  {
    id: 'gpt-image-2',
    provider: 'gpt',
    label: 'GPT Image 2',
    note: 'older generation',
    pricing: gptPerImage(),
  },
  {
    id: 'gpt-image-2.6-sunburst-4k-upscale',
    provider: 'gpt',
    label: 'GPT Image 2.6 Sunburst 4K Upscale',
    note: 'always outputs and bills 4K',
    always4k: true,
    pricing: gptPerImage(),
  },
  {
    id: 'gpt-image-2.6-flare-4k-upscale',
    provider: 'gpt',
    label: 'GPT Image 2.6 Flare 4K Upscale',
    note: 'faster, always outputs and bills 4K',
    always4k: true,
    pricing: gptPerImage(),
  },
  {
    id: 'gpt-image-2.5-sunburst-4k-upscale',
    provider: 'gpt',
    label: 'GPT Image 2.5 Sunburst 4K Upscale',
    note: 'previous generation, 4K-only',
    always4k: true,
    pricing: gptPerImage(),
  },
  {
    id: 'gpt-image-2.5-flare-4k-upscale',
    provider: 'gpt',
    label: 'GPT Image 2.5 Flare 4K Upscale',
    note: 'previous generation, 4K-only',
    always4k: true,
    pricing: gptPerImage(),
  },
  {
    id: 'gpt-image-2-4k-upscale',
    provider: 'gpt',
    label: 'GPT Image 2 4K Upscale',
    note: 'older generation, 4K-only',
    always4k: true,
    pricing: gptPerImage(),
  },
  {
    id: 'gemini-3-pro-image',
    provider: 'gpt',
    label: 'Gemini 3 Pro Image',
    note: 'token-billed; served by TeamoRouter',
    pricing: geminiToken(1, 60, 2, 120),
  },
  {
    id: 'gemini-3.1-flash-image',
    provider: 'gpt',
    label: 'Gemini 3.1 Flash Image',
    note: 'token-billed; faster and cheaper',
    pricing: geminiToken(0.25, 30, 0.5, 60),
  },
  {
    id: 'MiniMax-H3-Image',
    provider: 'minimax',
    label: 'MiniMax H3-Image (standard)',
    note: 'default MiniMax model; cheaper of the two',
    pricing: minimaxPricing(15, 10, 25, [
      minimaxRow('text-to-image', 0.143, 0.1531, 0.4522, 0.2261),
      minimaxRow('edit, 1 reference', 0.1744, 0.1747, 0.4809, 0.2404),
      minimaxRow('edit, 3 references', 0.2346, 0.2746, 0.5211, 0.2605),
    ]),
  },
  {
    id: 'MiniMax-H3-Image-Highspeed',
    provider: 'minimax',
    label: 'MiniMax H3-Image Highspeed',
    note: 'faster, about 1.5-2x the standard price',
    pricing: minimaxPricing(15, 20, 50, [
      minimaxRow('text-to-image', 0.2319, 0.238, 0.855, 0.4275),
      minimaxRow('edit, 1 reference', 0.2978, 0.3011, 0.8998, 0.4499),
      minimaxRow('edit, 3 references', 0.3982, 0.4003, 1.0146, 0.5073),
    ]),
  },
])

export const MODEL_IDS = Object.freeze(MODELS.map((entry) => entry.id))
export const MODEL_BY_ID = new Map(MODELS.map((entry) => [entry.id, entry]))
export const GPT_MODELS = Object.freeze(MODELS.filter((entry) => entry.provider === 'gpt'))
export const MINIMAX_MODELS = Object.freeze(MODELS.filter((entry) => entry.provider === 'minimax'))

/** Provider id owning an exact model id. */
export function providerForModel(model) {
  const entry = MODEL_BY_ID.get(model)
  if (entry === undefined) {
    throw new Error(`unknown image model "${model}"; call image_models for the catalog`)
  }
  return entry.provider
}

/**
 * Resolve the provider and model for one call.
 *
 * `provider` is optional when `model` names one; the model's provider wins.
 * When both are given they must agree, so a typo cannot silently bill the other
 * backend.
 */
export function resolveSelection({ provider, model, defaults = {} }) {
  const fallbackProvider = defaults.provider ?? 'gpt'
  const chosenProvider = provider ?? (model === undefined ? fallbackProvider : providerForModel(model))
  const profile = PROVIDERS[chosenProvider]
  if (profile === undefined) {
    throw new Error(`provider must be "gpt" or "minimax" (got "${provider}")`)
  }
  const chosenModel = model ?? defaults[chosenProvider] ?? profile.defaultModel
  const entry = MODEL_BY_ID.get(chosenModel)
  if (entry === undefined) {
    throw new Error(`unknown image model "${chosenModel}"; call image_models for the catalog`)
  }
  if (entry.provider !== chosenProvider) {
    throw new Error(
      `model "${chosenModel}" belongs to provider "${entry.provider}", not "${chosenProvider}"; ` +
        `use provider "${entry.provider}" or omit provider`,
    )
  }
  return { provider: chosenProvider, model: chosenModel, entry, profile }
}

const STEP = 16
const GPT_MIN_PIXELS = 655_360
const GPT_MAX_PIXELS = 8_294_400
const GPT_MAX_SIDE = 3840
const MINIMAX_MIN_PIXELS = 655_360
const MINIMAX_MAX_PIXELS = 20_000_000
const MINIMAX_MAX_RATIO = 3

const ceil16 = (n) => Math.max(STEP, Math.ceil(n / STEP) * STEP)
const round16 = (n) => Math.max(STEP, Math.round(n / STEP) * STEP)
const floor16 = (n) => Math.max(STEP, Math.floor(n / STEP) * STEP)

/**
 * Billing tier of a delivered GPT size: by longest side, per the gateway rules.
 * Returns undefined for anything that is not a WIDTHxHEIGHT pair, so a
 * provider-reported "auto" can never be mistaken for the 4K tier.
 */
export function billingTierOfSize(size) {
  if (typeof size !== 'string') return undefined
  const match = /^(\d+)x(\d+)$/.exec(size.trim())
  if (match === null) return undefined
  const longest = Math.max(Number(match[1]), Number(match[2]))
  if (longest <= 1024) return '1K'
  if (longest <= 2048) return '2K'
  return '4K'
}

/**
 * GPT size for a tier and aspect. The 655,360-pixel floor can push 1K 16:9 /
 * 9:16 over 1024px, so callers must also look at `billingTier` (returned).
 */
function gptSizeFor(tier, aspect) {
  const [aw, ah] = aspect.split(':').map(Number)
  const longest = tier === '1k' ? 1024 : tier === '2k' ? 2048 : 3840
  let w
  let h
  if (aw >= ah) {
    w = longest
    h = round16((longest * ah) / aw)
  } else {
    h = longest
    w = round16((longest * aw) / ah)
  }

  if (w * h < GPT_MIN_PIXELS) {
    if (w === h) {
      const side = ceil16(Math.sqrt(GPT_MIN_PIXELS))
      w = side
      h = side
    } else {
      const k = Math.sqrt(GPT_MIN_PIXELS / (w * h))
      if (w > h) {
        w = ceil16(w * k)
        h = round16(h * k)
        while (w * h < GPT_MIN_PIXELS) w += STEP
      } else {
        h = ceil16(h * k)
        w = round16(w * k)
        while (w * h < GPT_MIN_PIXELS) h += STEP
      }
    }
  }

  if (w * h > GPT_MAX_PIXELS) {
    const k = Math.sqrt(GPT_MAX_PIXELS / (w * h))
    w = floor16(w * k)
    h = floor16(h * k)
    while (w * h > GPT_MAX_PIXELS) {
      if (w >= h) w -= STEP
      else h -= STEP
    }
  }

  if (Math.max(w, h) > GPT_MAX_SIDE) {
    const k = GPT_MAX_SIDE / Math.max(w, h)
    w = floor16(w * k)
    h = floor16(h * k)
    while (Math.max(w, h) > GPT_MAX_SIDE) {
      if (w >= h) w -= STEP
      else h -= STEP
    }
  }

  return `${w}x${h}`
}

/** Validate a caller-supplied GPT size and return it unchanged. */
function gptExplicitSize(value) {
  const match = /^(\d+)x(\d+)$/.exec(value.trim())
  if (match === null) {
    throw new Error(`size must be 1k, 2k, 4k, or WIDTHxHEIGHT such as 1536x1024 (got "${value}")`)
  }
  const w = Number(match[1])
  const h = Number(match[2])
  if (w <= 0 || h <= 0) throw new Error(`size sides must be positive (got ${w}x${h})`)
  if (w % STEP !== 0 || h % STEP !== 0) throw new Error(`size sides must be multiples of 16 (got ${w}x${h})`)
  if (Math.max(w, h) > GPT_MAX_SIDE) {
    throw new Error(`size longest side must not exceed ${GPT_MAX_SIDE} (got ${w}x${h})`)
  }
  if (w * h < GPT_MIN_PIXELS || w * h > GPT_MAX_PIXELS) {
    throw new Error(`size total pixels must be between ${GPT_MIN_PIXELS} and ${GPT_MAX_PIXELS} (got ${w * h})`)
  }
  return `${w}x${h}`
}

/** Validate a caller-supplied MiniMax size and return it unchanged. */
function minimaxExplicitSize(value) {
  const match = /^(\d+)x(\d+)$/.exec(value.trim())
  if (match === null) {
    throw new Error(`size must be 1k, 2k, 4k, or WIDTHxHEIGHT such as 2720x1536 (got "${value}")`)
  }
  const w = Number(match[1])
  const h = Number(match[2])
  if (w <= 0 || h <= 0) throw new Error(`size sides must be positive (got ${w}x${h})`)
  if (w * h < MINIMAX_MIN_PIXELS || w * h > MINIMAX_MAX_PIXELS) {
    throw new Error(
      `MiniMax size total pixels must be between ${MINIMAX_MIN_PIXELS} and ${MINIMAX_MAX_PIXELS} (got ${w * h})`,
    )
  }
  if (w > MINIMAX_MAX_RATIO * h || h > MINIMAX_MAX_RATIO * w) {
    throw new Error(`MiniMax size aspect ratio must be within 1:3 and 3:1 (got ${w}x${h})`)
  }
  return `${w}x${h}`
}

/**
 * Translate the shared `size` + `aspect` arguments into one provider's request
 * shape:
 *   GPT      -> exact `size` (billing tier follows the delivered longest side)
 *   MiniMax  -> `area` + `aspectRatio` for a tier, or exact `size` when given
 *
 * An omitted size uses the provider default: 2k for GPT (1K and 2K cost the
 * same, so 2K is strictly better) and 1k for MiniMax (cheapest).
 */
export function planSize(provider, size, aspect = '1:1') {
  const tier = (size ?? defaultSizeFor(provider)).trim().toLowerCase()
  if (!ASPECTS.includes(aspect)) {
    throw new Error(`aspect must be one of ${ASPECTS.join(', ')} (got "${aspect}")`)
  }

  if (TIER_KEYS.includes(tier)) {
    if (provider === 'minimax') {
      return { area: tier.toUpperCase(), aspectRatio: aspect, billingTier: tier.toUpperCase() }
    }
    const exact = gptSizeFor(tier, aspect)
    return { size: exact, billingTier: billingTierOfSize(exact) }
  }

  if (provider === 'minimax') {
    return { size: minimaxExplicitSize(tier) }
  }
  const exact = gptExplicitSize(tier)
  return { size: exact, billingTier: billingTierOfSize(exact) }
}

/**
 * Plan a request size while protecting the caller from an accidental 4K bill.
 *
 * Two rules:
 *   1. `*-4k-upscale` models always deliver 4K, so they only accept size "4k".
 *   2. An explicit GPT WIDTHxHEIGHT whose longest side exceeds 2048 is billed
 *      as 4K (about ¥0.60 instead of ¥0.18). That is exactly how "give me 2K"
 *      turns into a 4K charge when the caller writes 2560x1440, so such a size
 *      is refused unless the caller opts in with `allow_4k`.
 */
export function planBilledSize({ provider, entry, size, aspect = '1:1', allow4k = false }) {
  const fallback = entry?.always4k === true ? '4k' : defaultSizeFor(provider)
  const requested = (size ?? fallback).trim().toLowerCase()

  if (entry?.always4k === true) {
    if (requested !== '4k') {
      const base = entry.id.replace(/-4k-upscale$/, '')
      throw new Error(
        `${entry.id} is a 4K-only model: it always outputs and bills 4K (~¥${GPT_TIER_PRICES_CNY['4K'].toFixed(2)}). ` +
          `Pass size:"4k", or use ${base} when you want 2K.`,
      )
    }
    return planSize(provider, '4k', aspect)
  }

  const plan = planSize(provider, requested, aspect)

  if (
    provider === 'gpt' &&
    entry?.pricing?.mode === 'per_image' &&
    !TIER_KEYS.includes(requested) &&
    plan.billingTier === '4K' &&
    allow4k !== true
  ) {
    const twoK = planSize('gpt', '2k', aspect)
    const longest = Math.max(...plan.size.split('x').map(Number))
    throw new Error(
      `size ${plan.size} is billed as 4K (~¥${GPT_TIER_PRICES_CNY['4K'].toFixed(2)}/image), not 2K: ` +
        `the longest side ${longest} exceeds 2048. ` +
        `For 2K pass size:"2k" with aspect:"${aspect}" (${twoK.size}). ` +
        `To request this exact 4K size on purpose, set allow_4k:true or pass size:"4k".`,
    )
  }

  return plan
}

/** Estimated CNY cost of one delivered image, when the model is per-image. */
export function costCnyFor(entry, billingTier) {
  if (entry?.pricing?.mode !== 'per_image' || billingTier === undefined) return undefined
  return entry.pricing.tiers[billingTier.toUpperCase()]
}

/** Reject blank or oversized prompts before spending a request. */
export function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('prompt must not be empty')
  }
  if (prompt.length > 32_000) {
    throw new Error(`prompt must be at most 32,000 characters (got ${prompt.length})`)
  }
}

/** Provider-specific `n` and reference-image limits. */
export function validateCounts(provider, n, imageCount) {
  const caps = PROVIDERS[provider].capabilities
  if (!Number.isInteger(n) || n < 1 || n > caps.maxImages) {
    throw new Error(`n must be an integer from 1 to ${caps.maxImages} for ${provider} (got ${n})`)
  }
  if (imageCount > caps.maxReferences) {
    throw new Error(
      `${provider} accepts at most ${caps.maxReferences} reference images (got ${imageCount})`,
    )
  }
}

/** MiniMax has no quality knob; `auto` is accepted as a no-op. */
export function validateQuality(provider, quality) {
  if (provider === 'minimax') {
    if (quality !== undefined && quality !== 'auto') {
      throw new Error(`quality is GPT-only; MiniMax H3-Image has no quality level (got "${quality}")`)
    }
    return undefined
  }
  const value = quality ?? 'auto'
  if (!QUALITIES.includes(value)) {
    throw new Error(`quality must be one of ${QUALITIES.join(', ')} (got "${value}")`)
  }
  return value
}

/** Normalize a provider-reported format (`jpg` -> `jpeg`). */
export function normalizeFormat(value) {
  if (value === 'jpg') return 'jpeg'
  return FORMATS.includes(value) ? value : undefined
}

const usd = (value) => Number(value).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
const cny = (value) => Number(value).toFixed(4)
const pad = (value, width) => String(value).padEnd(width)

/**
 * Model-facing catalog text. It is deliberately a string (not a deep object):
 * the caller needs a compact table it can read before choosing a model, and
 * the README holds the same snapshot in Chinese.
 */
export function catalogText() {
  const lines = []
  lines.push(`Image model catalog & price snapshot (${PRICE_AS_OF})`)
  lines.push('Pick a provider + model for image_generate; an omitted model uses the provider default.')
  lines.push('')

  lines.push('GPT BILLING TIERS (per delivered image, CNY) -- decide this before the model')
  lines.push('  1K  delivered longest side <= 1024   ¥0.18')
  lines.push('  2K  delivered longest side <= 2048   ¥0.18   <- same price as 1K; default')
  lines.push('  4K  delivered longest side >  2048   ¥0.60   <- ~3.3x 2K; only when 4K is required')
  lines.push('  2560x1440 is 4K billing (longest side 2560), NOT 2K. For 2K 16:9 use 2048x1152.')
  lines.push('  Pass size:"2k" + aspect instead of computing pixels; an explicit GPT size above')
  lines.push('  2048 is refused unless allow_4k:true. *-4k-upscale models are 4K-only.')
  lines.push('')

  lines.push('gpt — TeamoRouter (GPT Image 2.x; Gemini image models share this backend)')
  lines.push(
    `  key: ${PROVIDERS.gpt.keyRef}; text-to-image + edit/combine; 1-16 refs; n 1-4; ` +
      `quality auto/low/medium/high; ${FORMATS.join('/')}`,
  )
  lines.push(
    '  size: 1k/2k/4k (delivered longest 1024/2048/3840) or WIDTHxHEIGHT. 4K is capped at ' +
      '8.29MP: 4K 1:1 = 2880x2880, 4K 16:9 = 3840x2160. 1K 16:9/9:16 cannot reach the ' +
      '655,360px floor within 1024px, so they render 1088x608 / 608x1088 and bill as 2K ' +
      '(same price, so no loss).',
  )
  lines.push('  format: png/jpeg/webp requested; GPT 2.6 currently returns PNG even when jpeg is requested.')
  lines.push('  models (per-image price = the tier table above; model choice is quality/speed):')
  for (const entry of GPT_MODELS) {
    const marker = entry.id === PROVIDERS.gpt.defaultModel ? ' (default)' : ''
    if (entry.pricing.mode === 'per_image') {
      const only4k = entry.always4k === true ? ' [4K-only]' : ''
      lines.push(`    ${entry.id}${marker}${only4k}: ${entry.note}`)
    } else {
      lines.push(
        `    ${entry.id}${marker}: token $${usd(entry.pricing.inputPerMTok)}/M input, ` +
          `$${usd(entry.pricing.outputPerMTok)}/M output ` +
          `(list $${usd(entry.pricing.listInputPerMTok)}/$${usd(entry.pricing.listOutputPerMTok)}); ` +
          `${entry.note}`,
      )
    }
  }
  lines.push(
    '  GPT per-image billing: per delivered image, tier by delivered longest side; ' +
      'Gemini models are token-billed instead.',
  )
  lines.push('')

  lines.push('minimax — MiniMax H3-Image (api.minimax.cn; CNY, token-billed)')
  lines.push(
    `  key: ${PROVIDERS.minimax.keyRef}; text-to-image + edit/combine; 1-16 refs; n 1-10; ` +
      `${FORMATS.join('/')}; no quality level; prompt enhancement is on by default and its tokens are included.`,
  )
  lines.push(
    '  size: area 1K/2K/4K (1024^2/2048^2/4096^2) + aspect_ratio 1:3-3:1, or WIDTHxHEIGHT ' +
      '655,360-20,000,000px with ratio 1:3-3:1. 4K 16:9 = 5472x3072 (16.8MP), about 2x GPT 4K pixels.',
  )
  for (const entry of MINIMAX_MODELS) {
    const marker = entry.id === PROVIDERS.minimax.defaultModel ? ' (default)' : ''
    lines.push(
      `  ${entry.id}${marker} — CNY/image; 4K promo until ${MINIMAX_4K_PROMO.until.slice(0, 10)} ` +
        `when the delivered image is >= 16.6MP:`,
    )
    lines.push(`    ${entry.note}.`)
    lines.push('    scene                   1K       2K       4K list  4K promo')
    for (const row of entry.pricing.rows) {
      lines.push(
        `    ${pad(row.scene, 22)} ${pad(`¥${cny(row.prices['1K'].list)}`, 8)} ` +
          `${pad(`¥${cny(row.prices['2K'].list)}`, 8)} ` +
          `${pad(`¥${cny(row.prices['4K'].list)}`, 8)} ` +
          `¥${cny(row.prices['4K'].promo)}`,
      )
    }
    lines.push(
      `    token rates: text input ¥${entry.pricing.tokenRates.textInputPerMTok}/M, ` +
        `image input ¥${entry.pricing.tokenRates.imageInputPerMTok}/M, ` +
        `output ¥${entry.pricing.tokenRates.outputPerMTok}/M`,
    )
  }
  lines.push(
    '  MiniMax has a fixed quality; unsupported quality values are rejected by the plugin. The figures ' +
      'above are documented single-image references and vary with prompt-enhancement and reference tokens.',
  )
  lines.push(
    '  Reference cost: GPT per-image rates do not change with reference count; MiniMax charges each ' +
      'reference as image-input tokens (about +¥0.03 standard / +¥0.06 highspeed per 1K reference).',
  )
  lines.push('')

  lines.push('Comparison (2026-11-15, CNY):')
  lines.push(
    '  2K: GPT ¥0.18 vs MiniMax standard ~¥0.15 -- close; pick GPT for detail/instruction following.',
  )
  lines.push(
    '  4K: GPT ¥0.60 vs MiniMax standard ¥0.2261 promo / ¥0.4522 list at 16.8MP -- MiniMax is much ' +
      'cheaper for 4K, so use MiniMax when 4K pixels are the goal.',
  )
  lines.push('  1K on GPT is pointless: 2K costs the same and has 4x the pixels.')
  lines.push(
    `Public list: ${PRICE_SOURCES.teamorouter} (may still show the old flat $0.02 and lag the ` +
      `account bill) and ${PRICE_SOURCES.minimax}. The MiniMax 4K promo ends ${MINIMAX_4K_PROMO.until}.`,
  )
  return lines.join('\n')
}
