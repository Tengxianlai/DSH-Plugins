/**
 * MiniMax H3 video catalog, validation and cost estimation.
 *
 * The facts in this module are a snapshot of the official MiniMax docs on
 * 2026-11-15:
 *   - platform.minimax.io / platform.minimax.cn video-generation-v2-create
 *   - .../video-generation-v2-regeneration
 *   - .../video-generation-v2-h3-context-ir
 *   - .../pricing/overview (video section)
 *
 * Everything here is pure: no network, no filesystem. The tool layer turns a
 * validated plan plus media URLs into an API body.
 */

export const MODEL_IDS = ['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max']

export const RESOLUTIONS = ['480P', '768P', '2K']

export const RATIOS = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']

export const PROMPT_EXPANSION_MODES = ['disabled', 'balanced', 'quality']

export const REGION_BASE_URLS = {
  cn: 'https://api.minimax.cn',
  global: 'https://api.minimax.io',
}

/** First 5 images are free on the flagship tiers; Max only gets 2. */
const FLAGSHIP_PRICES = {
  cn: {
    '2K': { output: 0.8, inputVideo: 0.8, image: 0.2 },
    '768P': { output: 0.5, inputVideo: 0.5, image: 0.2 },
  },
  global: {
    '2K': { output: 0.13, inputVideo: 0.13, image: 0.04 },
    '768P': { output: 0.08, inputVideo: 0.08, image: 0.04 },
  },
}

const HIGHSPEED_PRICES = {
  cn: {
    '768P': { output: 0.4, inputVideo: 0.4, image: 0.2 },
    '480P': { output: 0.26, inputVideo: 0.26, image: 0.2 },
  },
  global: {
    '768P': { output: 0.06, inputVideo: 0.06, image: 0.03 },
    '480P': { output: 0.04, inputVideo: 0.04, image: 0.03 },
  },
}

const LITE_PRICES = {
  cn: {
    '768P': { output: 0.26, inputVideo: 0.26, image: 0.13 },
    '480P': { output: 0.16, inputVideo: 0.16, image: 0.13 },
  },
  global: {
    '768P': { output: 0.04, inputVideo: 0.04, image: 0.02 },
    '480P': { output: 0.025, inputVideo: 0.025, image: 0.02 },
  },
}

const MAX_PRICES = {
  cn: {
    '768P': { output: 0.5, inputVideo: 0.97, image: 0.5 },
    '480P': { output: 0.33, inputVideo: 0.37, image: 0.5 },
  },
  global: {
    '768P': { output: 0.08, inputVideo: 0.143, image: 0.074 },
    '480P': { output: 0.05, inputVideo: 0.0553, image: 0.074 },
  },
}

export const MODELS = [
  {
    id: 'MiniMax-H3',
    tier: 'quality',
    label: 'H3',
    description: 'Quality first: 768P/2K, best motion and prompt following.',
    resolutions: ['768P', '2K'],
    minDuration: 4,
    maxDuration: 15,
    freeImages: 5,
    prices: FLAGSHIP_PRICES,
    promptExpansion: false,
  },
  {
    id: 'MiniMax-H3-Highspeed',
    tier: 'balanced',
    label: 'H3 Highspeed',
    description: 'Balances quality and speed for everyday content; 480P/768P only.',
    resolutions: ['480P', '768P'],
    minDuration: 4,
    maxDuration: 15,
    freeImages: 5,
    prices: HIGHSPEED_PRICES,
    promptExpansion: false,
  },
  {
    id: 'MiniMax-H3-Lite',
    tier: 'budget',
    label: 'H3 Lite',
    description: 'Lowest cost for drafts and batch exploration; 480P/768P only.',
    resolutions: ['480P', '768P'],
    minDuration: 4,
    maxDuration: 15,
    freeImages: 5,
    prices: LITE_PRICES,
    promptExpansion: false,
  },
  {
    id: 'MiniMax-H3-Max',
    tier: 'multi-asset',
    label: 'H3 Max',
    description: 'Multi-asset reference variant with prompt expansion; 480P/768P, 5-15 s.',
    resolutions: ['480P', '768P'],
    minDuration: 5,
    maxDuration: 15,
    freeImages: 2,
    prices: MAX_PRICES,
    promptExpansion: true,
  },
]

export const MODEL_BY_ID = new Map(MODELS.map((model) => [model.id, model]))

export const REGENERATION = {
  model: 'MiniMax-H3',
  resolution: '2K',
  minDuration: 4,
  maxDuration: 15,
  freeImages: 5,
  prices: {
    cn: {
      '2K': { output: 0.3, inputVideo: 0.3, image: 0.15 },
    },
    global: {
      '2K': { output: 0.05, inputVideo: 0.05, image: 0.025 },
    },
  },
}

export const CONTEXT_IR_PRICES = {
  cn: { inputPerMTokens: 5.8, outputPerMTokens: 23.0 },
  global: { inputPerMTokens: 0.9, outputPerMTokens: 3.6 },
}

export const LIMITS = {
  promptChars: 7000,
  referenceImages: 9,
  referenceVideos: 3,
  referenceAudio: 3,
  mixedReferenceFiles: 12,
  imageBytes: 30 * 1024 * 1024,
  videoBytes: 50 * 1024 * 1024,
  audioBytes: 15 * 1024 * 1024,
  requestBytes: 64 * 1024 * 1024,
  refClipSeconds: 15,
  taskQueryDays: 7,
}

export const BASE_VIDEO_SPEC = {
  audioTrack: 'required',
  frameRate: 24,
  dimensionsDivisibleBy: 32,
  minArea: 768 * 768,
  maxArea: 768 * 1344,
  minFrames: 107,
  maxFrames: 362,
  frameStep: 17,
}

/** Pick the billing region from a configured base URL. */
export function regionOf(baseURL) {
  return /minimax\.io/i.test(baseURL) ? 'global' : 'cn'
}

/** Currency symbol for a billing region. */
export function currencyOf(region) {
  return region === 'global' ? '$' : '¥'
}

/** Format a list-price amount with the region's currency. */
export function formatMoney(amount, region) {
  return `${currencyOf(region)}${amount.toFixed(2)}`
}

/** Resolve one model id or throw a caller-facing error. */
export function getModel(id) {
  const model = MODEL_BY_ID.get(id)
  if (model === undefined) {
    throw new Error(`unknown model "${id}"; use ${MODEL_IDS.join(', ')}`)
  }
  return model
}

/**
 * Normalize the input media into one generation mode.
 *
 * First/last frames and reference media are mutually exclusive in the H3 API;
 * the API rejects a request that mixes them, so the plugin does it earlier with
 * an actionable message.
 */
export function inferMode({ firstFrame, lastFrame, referenceImages = [], referenceVideos = [], referenceAudio = [] } = {}) {
  const hasFrames = firstFrame !== undefined || lastFrame !== undefined
  const referenceCount = referenceImages.length + referenceVideos.length + referenceAudio.length
  if (hasFrames && referenceCount > 0) {
    throw new Error(
      'first_frame/last_frame and reference_* cannot be mixed: choose image-to-video (first/last frame) or reference-to-video. For voice-timbre continuity use reference-to-video with <Picture N> + <Audio N>; first_frame pins the opening frame but cannot carry a voice reference. See the minimax-video skill reference continuity-and-voice.md',
    )
  }
  if (lastFrame !== undefined && firstFrame === undefined) {
    throw new Error('last_frame requires first_frame: the API only accepts a last frame paired with a first frame')
  }
  if (referenceCount > 0) return 'reference'
  if (hasFrames) return 'image'
  return 'text'
}

/** Validate a non-empty H3 prompt. */
export function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('prompt must be a non-empty string')
  }
  if (prompt.length > LIMITS.promptChars) {
    throw new Error(`prompt is ${prompt.length} characters; MiniMax H3 accepts at most ${LIMITS.promptChars}`)
  }
  return prompt
}

/** Validate reference counts and the 12-file mixed-reference cap. */
export function validateReferenceCounts({ referenceImages = [], referenceVideos = [], referenceAudio = [] } = {}) {
  if (referenceImages.length > LIMITS.referenceImages) {
    throw new Error(`reference_images accepts at most ${LIMITS.referenceImages} images (got ${referenceImages.length})`)
  }
  if (referenceVideos.length > LIMITS.referenceVideos) {
    throw new Error(`reference_videos accepts at most ${LIMITS.referenceVideos} clips (got ${referenceVideos.length})`)
  }
  if (referenceAudio.length > LIMITS.referenceAudio) {
    throw new Error(`reference_audio accepts at most ${LIMITS.referenceAudio} clips (got ${referenceAudio.length})`)
  }
  const total = referenceImages.length + referenceVideos.length + referenceAudio.length
  if (total > LIMITS.mixedReferenceFiles) {
    throw new Error(`mixed reference input is capped at ${LIMITS.mixedReferenceFiles} files (got ${total})`)
  }
}

/** Resolve a ratio for the inferred mode, applying the API's defaults. */
export function normalizeRatio({ ratio, mode, model }) {
  if (ratio !== undefined && !RATIOS.includes(ratio)) {
    throw new Error(`unknown ratio "${ratio}"; use ${RATIOS.join(', ')}`)
  }
  if (mode === 'image') {
    // The frame image decides the shape; the API silently treats any other
    // value as adaptive, so the plugin states it explicitly.
    return 'adaptive'
  }
  if (mode === 'text') {
    const value = ratio ?? '16:9'
    if (value === 'adaptive') {
      throw new Error('text-to-video needs a concrete ratio; adaptive is only valid for reference-to-video')
    }
    return value
  }
  const value = ratio ?? 'adaptive'
  if (model === 'MiniMax-H3-Lite' && value === 'adaptive') {
    throw new Error('MiniMax-H3-Lite does not support adaptive ratio for reference-to-video; pass a concrete ratio')
  }
  return value
}

/** Validate the model/resolution/duration matrix and return a normalized plan. */
export function planGeneration({
  model = 'MiniMax-H3',
  resolution,
  duration = 5,
  ratio,
  promptExpansion,
  firstFrame,
  lastFrame,
  referenceImages = [],
  referenceVideos = [],
  referenceAudio = [],
} = {}) {
  const spec = getModel(model)
  const mode = inferMode({ firstFrame, lastFrame, referenceImages, referenceVideos, referenceAudio })
  const chosenResolution = resolution ?? '768P'
  if (!spec.resolutions.includes(chosenResolution)) {
    throw new Error(
      `${model} does not support ${chosenResolution}; available resolutions: ${spec.resolutions.join(', ')}`,
    )
  }
  if (!Number.isInteger(duration) || duration < spec.minDuration || duration > spec.maxDuration) {
    throw new Error(
      `${model} duration must be an integer from ${spec.minDuration} to ${spec.maxDuration} seconds (got ${duration})`,
    )
  }
  let effectivePromptExpansion = promptExpansion
  if (promptExpansion !== undefined) {
    if (!PROMPT_EXPANSION_MODES.includes(promptExpansion)) {
      throw new Error(`unknown prompt_expansion "${promptExpansion}"; use ${PROMPT_EXPANSION_MODES.join(', ')}`)
    }
    if (!spec.promptExpansion) {
      if (promptExpansion === 'disabled') {
        // Full native-tool serialization sends every field. On a non-Max tier
        // "disabled" is a no-op, not an unsupported API field: strip it so the
        // request never carries prompt_expansion for a tier that cannot use it.
        effectivePromptExpansion = undefined
      } else {
        throw new Error(
          `prompt_expansion ${promptExpansion} is only supported by MiniMax-H3-Max (got ${model}); non-Max tiers accept disabled as a no-op`,
        )
      }
    }
  }
  return {
    model,
    mode,
    resolution: chosenResolution,
    duration,
    ratio: normalizeRatio({ ratio, mode, model }),
    ...(effectivePromptExpansion === undefined ? {} : { promptExpansion: effectivePromptExpansion }),
  }
}

/** Count the images that are billed beyond the free allowance. */
export function extraImageCount(model, imageCount) {
  const free = model === 'MiniMax-H3-Max' ? 2 : 5
  return Math.max(0, imageCount - free)
}

/**
 * Estimate list cost for a generation task.
 *
 * Input reference-video seconds are billed too, but the plugin cannot probe a
 * remote clip's duration, so the caller may pass the known total; otherwise the
 * estimate covers output seconds, input images and says so.
 */
export function estimateGenerationCost({
  model = 'MiniMax-H3',
  resolution = '768P',
  duration = 5,
  imageCount = 0,
  inputVideoSeconds = 0,
  region = 'cn',
} = {}) {
  const spec = getModel(model)
  const price = spec.prices[region]?.[resolution]
  if (price === undefined) throw new Error(`no ${region} price for ${model} at ${resolution}`)
  const extraImages = Math.max(0, imageCount - spec.freeImages)
  const output = duration * price.output
  const video = inputVideoSeconds * price.inputVideo
  const images = extraImages * price.image
  return {
    amount: output + video + images,
    currency: currencyOf(region),
    output,
    inputVideo: video,
    extraImages,
    imageCost: images,
    freeImages: spec.freeImages,
  }
}

/** Render the model-facing catalog: tiers, matrix, prices, limits, chooser. */
export function catalogText(region = 'cn') {
  const lines = [
    'MiniMax H3 / Hailuo 3 video catalog. Price snapshot 2026-11-16; list prices per second unless noted.',
    '',
    'TIER          MODEL                    RESOLUTIONS   DURATION   REFERENCE INPUT',
    'quality       MiniMax-H3               768P, 2K      4-15 s     image, video, audio',
    'balanced      MiniMax-H3-Highspeed     480P, 768P    4-15 s     image, video, audio',
    'budget        MiniMax-H3-Lite          480P, 768P    4-15 s     image, video, audio',
    'multi-asset   MiniMax-H3-Max           480P, 768P    5-15 s     image, video, audio + prompt expansion',
    '',
    'PRICES (CNY/s on api.minimax.cn | USD/s on api.minimax.io)',
    'MiniMax-H3            2K    ¥0.80 | $0.13      768P  ¥0.50 | $0.08',
    'MiniMax-H3-Highspeed  768P  ¥0.40 | $0.06      480P  ¥0.26 | $0.04',
    'MiniMax-H3-Lite       768P  ¥0.26 | $0.04      480P  ¥0.16 | $0.025',
    'MiniMax-H3-Max        768P  ¥0.50 | $0.08      480P  ¥0.33 | $0.05   (input video: ¥0.97 | $0.143 at 768P)',
    '',
    'IMAGE INPUT: first 5 images free on H3/Highspeed/Lite/Regeneration, 2 free on Max; then',
    '  ¥0.20 | $0.04 per image (H3/Highspeed), ¥0.13 | $0.02 (Lite), ¥0.50 | $0.074 (Max).',
    'VIDEO INPUT: billed per input second at the output resolution rate; Max has its own input rate.',
    'AUDIO INPUT: free. All task types share the same unit price for a model/resolution.',
    '',
    'REGENERATION (768P -> 2K; any H3-family 768P output: standard H3, Highspeed or Lite):',
    '  Direct 2K generation is only available on standard MiniMax-H3; any approved 768P H3-family output',
    '  can use the official regeneration channel.',
    '  Output video ¥0.30 | $0.05 per second; input video ¥0.30 | $0.05 per second; images beyond 5 at',
    '  ¥0.15 | $0.025. Original task input materials are billed again: reference videos by original input',
    '  duration, audio free. Whether the base clip adds another input-video charge is unconfirmed, so',
    '  estimates are floor/upper partial, never an invoice.',
    '  Example 5 s standard-H3 768P + 5 s regeneration: generation ¥2.50; regeneration floor ¥1.50',
    '  (output video only); upper ¥3.00 if the base clip also pays input video. Pipeline ~¥4.00-¥5.50,',
    '  comparable to direct 2K ¥4.00, not automatically more expensive. Original reference-video seconds',
    '  add ¥0.30/s to both floor and upper.',
    'CONTEXT-IR (prompt enhancement): ¥5.80 | $0.90 per M input tokens, ¥23.00 | $3.60 per M output tokens.',
    '',
    'MODES: no media = text-to-video. first_frame/last_frame = image-to-video. reference_* =',
    'reference-to-video. Frames and references are mutually exclusive. last_frame needs first_frame.',
    '',
    'RATIO: text-to-video requires a concrete ratio (default 16:9) and rejects adaptive. Image-to-video',
    'follows the frame image (always adaptive). Reference-to-video defaults to adaptive; Lite requires a',
    'concrete ratio. Options: 21:9, 16:9, 4:3, 1:1, 3:4, 9:16.',
    '',
    'LIMITS: prompt <= 7000 chars per text item. Reference images <= 9, videos <= 3, audio <= 3, mixed',
    '<= 12 files. Image <= 30 MB, video <= 50 MB (2-15 s each, total <= 15 s), audio <= 15 MB (2-15 s each,',
    'total <= 15 s). Whole request body <= 64 MB. Output is one 4-15 s clip with native audio.',
    '',
    'CHOOSE: draft/iterate Lite 480P 4 s (about ¥0.64); everyday Highspeed 768P; final H3 2K;',
    'multi-asset reference Max; 2K from an approved H3-family 768P clip -> video_regenerate',
    '(estimate is a floor/upper partial, not an invoice).',
    '',
    'COST & SAFETY: call video_prepare (or dry_run:true) for a no-cost plan, diagnostic list and',
    'estimate. max_cost is a hard per-call cap; budget_id (or a project manifest budget) enforces a',
    'cross-call ceiling with conservative reservations. Every submit is journaled before the network',
    'call and an unknown outcome blocks a silent retry of the same request.',
    'ESTIMATE STATUS: complete = every billed input known; partial = floor/upper bound (remote inputs,',
    'or regeneration where the base-clip charge is unconfirmed); unknown = token-priced Context-IR,',
    'which cannot be capped or budgeted before the call.',
    '',
    `Current base URL region: ${region}. Call video_models again after changing config.`,
  ]
  return lines.join('\n')
}

/** Human-readable summary of a generation plan. */
export function describePlan(plan) {
  return `${plan.model} ${plan.resolution} ${plan.duration}s ${plan.ratio} (${plan.mode}-to-video)`
}
