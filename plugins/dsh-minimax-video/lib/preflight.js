/**
 * Pre-submit checks and cost planning.
 *
 * Everything here is pure and offline: prompt/reference contracts, declared
 * asset provenance, local media duration limits, list-price estimates with an
 * explicit completeness status, and hard cost-cap enforcement. The tool layer
 * runs it before the journal, credentials or any network call.
 */
import {
  CONTEXT_IR_PRICES,
  LIMITS,
  REGENERATION,
  currencyOf,
  formatMoney,
  getModel,
} from './catalog.js'

const EPSILON = 1e-9

export function diagnostic(level, code, message) {
  return { level, code, message }
}

export function diagnosticsToLines(diagnostics) {
  return diagnostics.map((entry) => `${entry.level}: [${entry.code}] ${entry.message}`)
}

/** Throw one combined error when any diagnostic is a hard error. */
export function assertNoErrors(diagnostics, label = 'preflight') {
  const errors = diagnostics.filter((entry) => entry.level === 'error')
  if (errors.length === 0) return
  throw new Error(`${label} failed: ${errors.map((entry) => `[${entry.code}] ${entry.message}`).join('; ')}`)
}

export function currencyCodeOf(region) {
  return region === 'global' ? 'USD' : 'CNY'
}

/** Normalize prompt/dialogue text for a forgiving but exact containment test. */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[“”„‟"'‘’「」『』《》]/g, '')
    .trim()
    .toLowerCase()
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * Approximate spoken seconds for one line. English: words / 3.3 / 0.57
 * (speech fills roughly 57% of a clip). CJK: about four characters per second
 * of speech, divided by the same fill factor.
 */
export function speechSeconds(line) {
  const text = String(line ?? '')
  const cjkChars = (text.match(new RegExp(CJK.source, 'g')) ?? []).length
  const latinWords = text
    .replace(new RegExp(CJK.source, 'g'), ' ')
    .split(/[^\p{L}\p{N}']+/u)
    .filter((word) => word.length > 0).length
  return cjkChars / 4 / 0.57 + latinWords / 3.3 / 0.57
}

function normalizeDialogue(dialogue) {
  if (dialogue === undefined) return []
  if (!Array.isArray(dialogue)) throw new Error('dialogue must be an array of {speaker, line}')
  return dialogue.map((entry, index) => {
    if (typeof entry === 'string') {
      const match = /^([^:：]+)[:：]\s*(.+)$/s.exec(entry)
      return {
        speaker: match === null ? '' : match[1].trim(),
        line: match === null ? entry.trim() : match[2].trim(),
        index,
      }
    }
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`dialogue[${index}] must be an object with speaker and line`)
    }
    return {
      speaker: String(entry.speaker ?? '').trim(),
      line: String(entry.line ?? '').trim(),
      index,
    }
  })
}

/** All `<Picture N>` / `<Video N>` / `<Audio N>` references in a prompt. */
export function referenceTags(prompt) {
  const tags = { picture: [], video: [], audio: [] }
  const pattern = /<(Picture|Video|Audio)\s+(\d+)>/gi
  for (const match of String(prompt ?? '').matchAll(pattern)) {
    const kind = match[1].toLowerCase()
    const index = Number(match[2])
    tags[kind].push(index)
  }
  return tags
}

/** Sum the heuristic spoken seconds of declared dialogue, including gaps. */
export function dialogueSpeechSeconds(dialogue) {
  let lines
  try {
    lines = normalizeDialogue(dialogue)
  } catch {
    return undefined
  }
  if (lines.length === 0) return undefined
  const speech = lines.reduce((sum, entry) => sum + speechSeconds(entry.line), 0)
  return Number((speech + Math.max(0, lines.length - 1) * 0.3).toFixed(2))
}

/**
 * Validate declared dialogue: presence in the prompt and only impossible
 * speech-overflow is a hard error. The duration estimate is explicitly
 * heuristic; a tight clipped line is a warning, never an automatic trim.
 */
export function checkDialogue({ prompt, dialogue, duration, requestedDuration, sourceActualDuration }) {
  const diagnostics = []
  let lines
  try {
    lines = normalizeDialogue(dialogue)
  } catch (error) {
    return [diagnostic('error', 'dialogue_invalid', error.message)]
  }
  if (lines.length === 0) return diagnostics
  const haystack = normalizeText(prompt)
  let total = 0
  for (const entry of lines) {
    if (entry.line.length === 0) {
      diagnostics.push(diagnostic('error', 'dialogue_empty_line', `dialogue[${entry.index}] has an empty line`))
      continue
    }
    if (!haystack.includes(normalizeText(entry.line))) {
      diagnostics.push(
        diagnostic(
          'error',
          'dialogue_missing',
          `declared line "${entry.line.slice(0, 40)}" does not appear verbatim in prompt; a specified line must be written into the prompt`,
        ),
      )
    }
    if (entry.speaker.length === 0) {
      diagnostics.push(diagnostic('warn', 'dialogue_speaker_missing', `dialogue[${entry.index}] has no speaker name`))
    } else if (!haystack.includes(normalizeText(entry.speaker))) {
      diagnostics.push(
        diagnostic('warn', 'dialogue_speaker_not_in_prompt', `speaker "${entry.speaker}" is not named in the prompt`),
      )
    }
    total += speechSeconds(entry.line)
  }
  const gaps = Math.max(0, lines.length - 1) * 0.3
  const needed = total + gaps
  diagnostics.push(
    diagnostic(
      'info',
      'speech_estimate_heuristic',
      `estimated speech ${needed.toFixed(1)} s is a heuristic (CJK by characters, other text by words, speech filling about 57% of the clip), not a measured or ASR boundary; requested duration ${Number.isFinite(requestedDuration) ? `${requestedDuration} s` : 'unknown'}, measured source duration ${Number.isFinite(sourceActualDuration) ? `${Number(sourceActualDuration).toFixed(2)} s` : 'unknown'}`,
    ),
  )
  const fitDuration = Number.isFinite(duration) ? duration : undefined
  if (fitDuration !== undefined && needed > fitDuration + EPSILON) {
    diagnostics.push(
      diagnostic(
        'error',
        'dialogue_too_long',
        `declared dialogue needs about ${needed.toFixed(1)} s of heuristic speech/gaps but the clip is ${fitDuration} s; this is impossible to fit, shorten it or extend duration`,
      ),
    )
  } else if (fitDuration !== undefined && needed > fitDuration * 0.9) {
    diagnostics.push(
      diagnostic(
        'warn',
        'dialogue_tight',
        `declared dialogue needs about ${needed.toFixed(1)} s of a ${fitDuration} s clip (heuristic); it may fit but leaves little beat. Do not trim an already accepted source ending purely from this estimate`,
      ),
    )
  }
  return diagnostics
}

function hostMatches(host, patterns) {
  if (host === undefined) return false
  const target = host.toLowerCase()
  return patterns.some((pattern) => {
    const rule = String(pattern).trim().toLowerCase()
    if (rule.length === 0) return false
    if (rule.startsWith('*.')) return target === rule.slice(2) || target.endsWith(rule.slice(1))
    return target === rule
  })
}

/**
 * Reference roles, source declarations and approved-source policy.
 *
 * Reference roles align with reference media in bundle order (images, then
 * videos, then audio). Source declarations align with every media slot in
 * submission order (frames, references, then base_video for regeneration).
 */
export function checkMediaContract({
  prompt,
  assets,
  referenceRoles,
  sourceDeclarations,
  approvedSources,
  approvedHosts,
  requireSourced = false,
  strict = false,
}) {
  const diagnostics = []
  const referenceAssets = assets.filter((asset) => asset.slot.startsWith('reference_'))
  const tags = referenceTags(prompt)
  const counts = {
    picture: referenceAssets.filter((asset) => asset.kind === 'image').length,
    video: referenceAssets.filter((asset) => asset.kind === 'video').length,
    audio: referenceAssets.filter((asset) => asset.kind === 'audio').length,
  }
  const labels = { picture: 'reference_image', video: 'reference_video', audio: 'reference_audio' }

  for (const kind of ['picture', 'video', 'audio']) {
    for (const index of tags[kind]) {
      if (!Number.isInteger(index) || index < 1 || index > counts[kind]) {
        diagnostics.push(
          diagnostic(
            'error',
            'reference_tag_out_of_range',
            `prompt references <${kind[0].toUpperCase()}${kind.slice(1)} ${index}> but only ${counts[kind]} ${labels[kind]} input(s) are attached`,
          ),
        )
      }
    }
    if (counts[kind] > 0 && tags[kind].length === 0) {
      diagnostics.push(
        diagnostic(
          'warn',
          'reference_not_referenced',
          `${counts[kind]} ${labels[kind]} input(s) are attached but the prompt has no <${kind[0].toUpperCase()}${kind.slice(1)} N> tag describing their role`,
        ),
      )
    }
  }

  // Reference roles
  if (referenceRoles !== undefined) {
    if (!Array.isArray(referenceRoles)) {
      diagnostics.push(diagnostic('error', 'reference_roles_invalid', 'reference_roles must be an array of strings'))
    } else if (referenceRoles.length !== referenceAssets.length) {
      diagnostics.push(
        diagnostic(
          'error',
          'reference_roles_count',
          `reference_roles has ${referenceRoles.length} entr${referenceRoles.length === 1 ? 'y' : 'ies'} but ${referenceAssets.length} reference asset(s) are attached; align it to images, then videos, then audio`,
        ),
      )
    } else {
      referenceRoles.forEach((role, index) => {
        const asset = referenceAssets[index]
        const name = String(role ?? '').trim()
        if (name.length === 0) {
          diagnostics.push(diagnostic('error', 'reference_roles_empty', `reference_roles[${index}] is empty`))
          return
        }
        if (!normalizeText(prompt).includes(normalizeText(name))) {
          diagnostics.push(
            diagnostic(
              'warn',
              'reference_role_not_in_prompt',
              `reference_roles[${index}] "${name}" is not named in the prompt; state who or what the reference is`,
            ),
          )
        }
        const kind = asset.kind === 'image' ? 'picture' : asset.kind
        const tagIndexes = tags[kind]
        if (tagIndexes.length === 0) {
          diagnostics.push(
            diagnostic(
              'warn',
              'reference_role_tag_missing',
              `reference_roles[${index}] "${name}" has no <${kind[0].toUpperCase()}${kind.slice(1)} N> tag in the prompt`,
            ),
          )
        }
      })
    }
  } else if (referenceAssets.length > 0 && strict) {
    diagnostics.push(
      diagnostic(
        'error',
        'reference_roles_required',
        'a registered project requires reference_roles for every attached reference asset (images, then videos, then audio)',
      ),
    )
  } else if (referenceAssets.length > 0) {
    diagnostics.push(
      diagnostic(
        'info',
        'reference_roles_unverified',
        'no reference_roles supplied; reference identity/role is declared only by prompt tags and not verified',
      ),
    )
  }

  // Source/provenance declarations
  const declarationCount = sourceDeclarations === undefined ? 0 : sourceDeclarations.length
  const required = requireSourced || (Array.isArray(approvedSources) && approvedSources.length > 0) || strict
  if (sourceDeclarations !== undefined && !Array.isArray(sourceDeclarations)) {
    diagnostics.push(
      diagnostic('error', 'source_declarations_invalid', 'source_declarations must be an array of strings'),
    )
  } else if (assets.length > 0) {
    if (sourceDeclarations !== undefined) {
      if (declarationCount !== assets.length) {
        const order = assets.map((asset) => asset.slot).join(', ')
        diagnostics.push(
          diagnostic(
            'error',
            'source_declarations_count',
            `source_declarations has ${declarationCount} entr${declarationCount === 1 ? 'y' : 'ies'} but ${assets.length} media input(s) are attached; align it to submission order: ${order}`,
          ),
        )
      } else if (Array.isArray(approvedSources) && approvedSources.length > 0) {
        const approved = new Set(approvedSources.map((entry) => String(entry).trim()))
        sourceDeclarations.forEach((declaration, index) => {
          const label = String(declaration ?? '').trim()
          if (label.length === 0) {
            diagnostics.push(
              diagnostic('error', 'source_declarations_empty', `source_declarations[${index}] is empty`),
            )
          } else if (!approved.has(label)) {
            diagnostics.push(
              diagnostic(
                'error',
                'source_not_approved',
                `source_declarations[${index}] "${label}" is not in approved_sources (${[...approved].join(', ')})`,
              ),
            )
          }
        })
      } else {
        diagnostics.push(
          diagnostic(
            'info',
            'source_provenance_unverified',
            'source_declarations were supplied but no approved_sources allowlist was given; provenance is declared, not verified',
          ),
        )
      }
    } else if (required) {
      diagnostics.push(
        diagnostic(
          'error',
          'source_declarations_required',
          'source_declarations is required for every media input (submission order: frames, references, base_video)',
        ),
      )
    } else {
      diagnostics.push(
        diagnostic(
          'info',
          'source_provenance_unverified',
          'no source_declarations supplied; media provenance is unverified',
        ),
      )
    }
  }

  if (Array.isArray(approvedHosts) && approvedHosts.length > 0) {
    for (const asset of assets) {
      if (asset.origin !== 'url') continue
      if (!hostMatches(asset.host, approvedHosts)) {
        diagnostics.push(
          diagnostic(
            'error',
            'source_host_not_approved',
            `${asset.slot} uses host ${asset.host ?? '(unparseable URL)'}, which is not in the approved host list`,
          ),
        )
      }
    }
  }

  return diagnostics
}

/** Duration limits the API applies to reference clips and regeneration sources. */
export function checkMediaDurations(assets) {
  const diagnostics = []
  for (const asset of assets) {
    if (asset.kind !== 'video') continue
    const duration = asset.durationSeconds
    if (duration === undefined) continue
    if (asset.slot === 'base_video') {
      if (duration < 4 - EPSILON || duration > 15 + EPSILON) {
        diagnostics.push(
          diagnostic(
            'error',
            'base_video_duration',
            `${asset.slot} is ${duration.toFixed(2)} s; a 768P H3 source clip must be about 4-15 s (107-362 frames)`,
          ),
        )
      }
    } else if (duration < 2 - EPSILON || duration > LIMITS.refClipSeconds + EPSILON) {
      diagnostics.push(
        diagnostic(
          'error',
          'reference_video_duration',
          `${asset.slot} is ${duration.toFixed(2)} s; reference clips must be 2-15 s each`,
        ),
      )
    }
  }
  const knownReferenceSeconds = assets
    .filter((asset) => asset.slot === 'reference_video' && asset.durationSeconds !== undefined)
    .reduce((sum, asset) => sum + asset.durationSeconds, 0)
  if (knownReferenceSeconds > LIMITS.refClipSeconds + EPSILON) {
    diagnostics.push(
      diagnostic(
        'error',
        'reference_video_total',
        `known reference-video duration is ${knownReferenceSeconds.toFixed(2)} s; the API caps the total at ${LIMITS.refClipSeconds} s`,
      ),
    )
  }
  return diagnostics
}

function moneyOrNull(amount, region) {
  return amount === null ? null : Number(amount.toFixed(6))
}

/** List-price estimate for a generation request. */
export function estimateGeneration({ plan, assets, region }) {
  const spec = getModel(plan.model)
  const price = spec.prices[region]?.[plan.resolution]
  if (price === undefined) throw new Error(`no ${region} price for ${plan.model} at ${plan.resolution}`)
  const imageCount = assets.filter((asset) => asset.kind === 'image').length
  const extraImages = Math.max(0, imageCount - spec.freeImages)
  const output = plan.duration * price.output
  const imageCost = extraImages * price.image
  const videos = assets.filter((asset) => asset.slot === 'reference_video')
  const knownSeconds = videos.reduce((sum, asset) => sum + (asset.durationSeconds ?? 0), 0)
  const unknownVideos = videos.filter((asset) => asset.durationSeconds === undefined)
  const inputVideo = knownSeconds * price.inputVideo
  const amount = output + imageCost + inputVideo
  const unknownItems = unknownVideos.map((asset) => ({
    item: 'reference-video duration',
    slot: asset.slot,
    reason:
      asset.origin === 'url'
        ? 'remote clip duration cannot be probed before the call'
        : 'container duration could not be read locally',
  }))
  const upperInputSeconds = unknownVideos.length > 0
    ? Math.max(knownSeconds, LIMITS.refClipSeconds)
    : knownSeconds
  return {
    kind: 'generate',
    status: unknownVideos.length > 0 ? 'partial' : 'complete',
    region,
    currency: currencyCodeOf(region),
    symbol: currencyOf(region),
    amount: moneyOrNull(amount, region),
    upper_bound: moneyOrNull(output + imageCost + upperInputSeconds * price.inputVideo, region),
    output_amount: moneyOrNull(output, region),
    image_amount: moneyOrNull(imageCost, region),
    input_video_amount: moneyOrNull(inputVideo, region),
    image_count: imageCount,
    extra_images: extraImages,
    free_images: spec.freeImages,
    input_video_seconds: Number(knownSeconds.toFixed(3)),
    unknown_items: unknownItems,
    unit_prices: price,
  }
}

/**
 * List-price estimate for a 768P -> 2K regeneration request.
 *
 * Official pricing (2026-11-16, cn + io): the regeneration row prices output
 * video and input video at ¥0.30/s (or $0.05/s), images beyond 5 at ¥0.15
 * ($0.025), and the notes say the original task's input materials are billed
 * again: video by the original input duration, audio free.
 *
 * Two things stay deliberately provisional:
 *   - whether the base 768P clip adds a *second* input-video charge. The
 *     authorized 10 s/1-image/0-input-seconds usage sample cannot prove it is
 *     free, so the base clip is only in the upper bound, never in the floor;
 *   - the exact rate applied to re-billed original reference videos. The
 *     official regeneration table's input-video rate is used here; the result
 *     is a floor/upper estimate, never an invoice and never "complete".
 */
export function estimateRegeneration({
  assets = [],
  region,
  originalDuration,
  imageCount = 0,
  referenceVideoSeconds = 0,
  unknownReferenceVideos = 0,
  originalInputsUnknown = false,
}) {
  const price = REGENERATION.prices[region]?.['2K']
  if (price === undefined) throw new Error(`no ${region} price for regeneration`)
  const baseVideo = assets.find((asset) => asset.slot === 'base_video')
  const measured = Number.isFinite(originalDuration) ? originalDuration : baseVideo?.durationSeconds
  const sourceKnown = measured !== undefined && measured !== null
  const floorSourceSeconds = sourceKnown ? measured : REGENERATION.minDuration
  const upperSourceSeconds = sourceKnown ? measured : REGENERATION.maxDuration
  const knownReferenceSeconds = Math.max(0, Number(referenceVideoSeconds) || 0)
  const unknownReferenceCount = Math.max(0, Number(unknownReferenceVideos) || 0)
  // When a source_task_id has no local record, the original input materials are
  // unreviewable. The floor claims no such inputs; the upper must include the
  // API maximum: 15 s of original reference video and 9 images (5 free).
  const upperReferenceSeconds = originalInputsUnknown
    ? Math.max(knownReferenceSeconds, LIMITS.refClipSeconds)
    : unknownReferenceCount > 0
      ? Math.max(knownReferenceSeconds, LIMITS.refClipSeconds)
      : knownReferenceSeconds
  const extraImages = Math.max(0, imageCount - REGENERATION.freeImages)
  const imageCost = extraImages * price.image
  const upperImageCount = originalInputsUnknown ? LIMITS.referenceImages : imageCount
  const upperImageCost = Math.max(0, upperImageCount - REGENERATION.freeImages) * price.image
  const outputFloor = floorSourceSeconds * price.output
  const outputUpper = upperSourceSeconds * price.output
  const referenceFloor = knownReferenceSeconds * price.inputVideo
  const referenceUpper = upperReferenceSeconds * price.inputVideo
  // Possible extra charge for the base clip itself; unknown, upper bound only.
  const baseVideoUpper = upperSourceSeconds * price.inputVideo
  const amount = outputFloor + referenceFloor + imageCost
  const upperBound = Math.max(amount, outputUpper + referenceUpper + baseVideoUpper + upperImageCost)
  const unknownItems = [
    {
      item: 'base-video second charge',
      reason:
        'official text bills the original input materials and lists an input-video rate; the authorized 10 s regeneration sample reported input_seconds 0, which cannot prove the base clip is free, so a base-clip charge is included only in the upper bound',
    },
    ...(unknownReferenceCount > 0
      ? [
          {
            item: 'original reference-video duration',
            reason: 'one or more original reference clips have no locally measured duration; the 15 s total cap bounds the upper estimate',
          },
        ]
      : []),
    ...(sourceKnown
      ? []
      : [
          {
            item: 'source-clip duration',
            reason: 'no local container or trusted download measured the source; floor uses the 4 s minimum and upper uses the 15 s API maximum',
          },
        ]),
    ...(originalInputsUnknown
      ? [
          {
            item: 'original input materials not reviewable',
            reason: `source_task_id has no local generation record, so original reference-video and image usage cannot be audited; the upper bound includes the API maximum of ${LIMITS.refClipSeconds} s original reference video and ${LIMITS.referenceImages} images (${REGENERATION.freeImages} free), while the floor asserts no such inputs`,
          },
        ]
      : []),
  ]
  return {
    kind: 'regenerate',
    status: 'partial',
    region,
    currency: currencyCodeOf(region),
    symbol: currencyOf(region),
    amount: moneyOrNull(amount, region),
    upper_bound: moneyOrNull(upperBound, region),
    output_amount: moneyOrNull(outputFloor, region),
    output_upper: moneyOrNull(outputUpper, region),
    image_amount: moneyOrNull(imageCost, region),
    input_video_amount: moneyOrNull(referenceFloor, region),
    input_video_upper: moneyOrNull(referenceUpper, region),
    possible_base_video_amount: moneyOrNull(baseVideoUpper, region),
    image_count: imageCount,
    extra_images: extraImages,
    free_images: REGENERATION.freeImages,
    input_video_seconds: Number(knownReferenceSeconds.toFixed(3)),
    upper_image_count: upperImageCount,
    original_inputs_unknown: originalInputsUnknown,
    source_seconds: sourceKnown ? Number(measured.toFixed(3)) : null,
    source_seconds_floor: Number(floorSourceSeconds.toFixed(3)),
    source_seconds_upper: Number(upperSourceSeconds.toFixed(3)),
    unknown_items: unknownItems,
    provisional: true,
    assumption:
      'floor: output video + known re-billed original reference-video seconds (at the regeneration input-video rate) + images beyond 5. upper additionally includes the possible base-clip input-video charge and unknown reference-video durations bounded by 15 s. Not an actual bill.',
    unit_prices: price,
  }
}

/**
 * Context-IR is token-priced: output tokens cannot be bounded before the call,
 * so it is never reported as a complete estimate.
 */
export function estimateContextIr({ region }) {
  const prices = CONTEXT_IR_PRICES[region]
  return {
    kind: 'prompt_enhance',
    status: 'unknown',
    region,
    currency: currencyCodeOf(region),
    symbol: currencyOf(region),
    amount: null,
    upper_bound: null,
    output_amount: null,
    image_amount: 0,
    input_video_amount: 0,
    image_count: 0,
    extra_images: 0,
    free_images: 0,
    input_video_seconds: 0,
    unknown_items: [
      {
        item: 'Context-IR token usage',
        reason: `token-priced (${formatMoney(prices.inputPerMTokens, region)}/M input, ${formatMoney(prices.outputPerMTokens, region)}/M output); output tokens have no pre-call bound`,
      },
    ],
    unit_prices: prices,
  }
}

/** One-line, honest rendering of an estimate. */
export function formatEstimate(estimate) {
  const money = (value) => formatMoney(value, estimate.region)
  if (estimate.status === 'complete') {
    const parts = [`${money(estimate.amount)} ${estimate.currency} list (complete)`]
    if (estimate.output_amount > 0) parts.push('output')
    if (estimate.extra_images > 0) parts.push(`${estimate.extra_images} extra image(s)`)
    if (estimate.input_video_seconds > 0) parts.push(`${estimate.input_video_seconds.toFixed(2)} s input video`)
    return parts.join('; ')
  }
  if (estimate.status === 'partial') {
    const unknown = estimate.unknown_items.map((entry) => entry.item).join(', ')
    return `${money(estimate.amount)} ${estimate.currency} known; worst case ${money(estimate.upper_bound)} ${estimate.currency} (unknown: ${unknown})`
  }
  return `unknown (${estimate.unknown_items.map((entry) => `${entry.item}: ${entry.reason}`).join('; ')})`
}

/** Render the budget-relevant amount for a cap check. */
export function costBound(estimate) {
  if (estimate.status === 'complete') return estimate.amount
  if (estimate.status === 'partial') return estimate.upper_bound
  return null
}

/**
 * Hard-cap enforcement. Returns extra diagnostics or throws before any paid
 * call. A hard cap never degrades to an advisory cap: unknown pricing with a
 * cap is a refusal, not a warning.
 */
export function enforceCostCap({
  estimate,
  maxCost,
  hasBudget = false,
  allowUnboundedCost = false,
  overrideReason,
}) {
  const diagnostics = []
  if (maxCost !== undefined && maxCost !== null) {
    if (typeof maxCost !== 'number' || !Number.isFinite(maxCost) || maxCost < 0) {
      throw new Error('max_cost must be a non-negative number')
    }
  }
  const capSet = typeof maxCost === 'number'
  const money = (value) => formatMoney(value, estimate.region)

  if (allowUnboundedCost && (capSet || hasBudget)) {
    throw new Error(
      'allow_unbounded_cost cannot be combined with max_cost or a budget: a declared hard cap/budget cannot be silently turned into an advisory one. Choose a bounded operation instead',
    )
  }

  if (estimate.status === 'unknown') {
    if (hasBudget) {
      throw new Error(
        `this operation cannot run under a budget: ${formatEstimate(estimate)}. A budget reservation needs a finite upper bound, and unknown billing is never released automatically`,
      )
    }
    if (capSet) {
      throw new Error(
        `max_cost ${money(maxCost)} cannot be enforced for this operation: ${formatEstimate(estimate)}. Remove max_cost, or pass allow_unbounded_cost:true with override_reason to proceed WITHOUT a hard cap`,
      )
    }
    if (allowUnboundedCost) {
      if (typeof overrideReason !== 'string' || overrideReason.trim().length === 0) {
        throw new Error('allow_unbounded_cost requires override_reason explaining why an uncapped paid call is acceptable')
      }
      diagnostics.push(
        diagnostic(
          'warn',
          'cost_unknown_acknowledged',
          `proceeding without a hard cap despite unknown pricing; reason: ${overrideReason.trim()}`,
        ),
      )
    }
    return diagnostics
  }

  if (capSet) {
    const bound = costBound(estimate)
    if (bound > maxCost + EPSILON) {
      const detail = estimate.status === 'partial'
        ? `worst-case upper bound ${money(bound)} (${money(estimate.amount)} known; unknown: ${estimate.unknown_items.map((entry) => entry.item).join(', ')})`
        : `estimated ${money(bound)}`
      throw new Error(
        `cost cap exceeded before submit: ${detail} > max_cost ${money(maxCost)}. Raise max_cost, supply local/parsable media to complete the estimate, or downgrade the tier`,
      )
    }
    diagnostics.push(
      diagnostic(
        'info',
        'cost_cap_ok',
        `estimated ${estimate.status === 'partial' ? `worst case ${money(bound)}` : money(bound)} is within max_cost ${money(maxCost)}`,
      ),
    )
  }
  return diagnostics
}
