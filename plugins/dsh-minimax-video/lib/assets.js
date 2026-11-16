/**
 * Media resolution, asset registry and request sanitization.
 *
 * One bundle describes exactly what a submission will send: the resolved URL /
 * data URI for the API, plus a registry entry per asset with origin, SHA-256,
 * size, mime and (when locally parsable) duration. The journal persists only
 * the sanitized registry: signed URL query strings never reach disk, and local
 * snapshots are copied next to the record before the paid call.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { safeSegment, sha256Hex } from './store.js'
import { isPassThroughMedia, loadLocalFile, mediaInput } from './media.js'
import { probeMp4Duration } from './mp4.js'

const SLOT_KIND = {
  first_frame: 'image',
  last_frame: 'image',
  reference_image: 'image',
  reference_video: 'video',
  reference_audio: 'audio',
  base_video: 'video',
}

/** Ordered media slots for one operation. Blank optional values are absent. */
export function mediaSlots(args, { includeBaseVideo = false } = {}) {
  const slots = []
  const push = (slot, input) => {
    if (typeof input !== 'string' || input.trim().length === 0) return
    slots.push({ slot, kind: SLOT_KIND[slot], input })
  }
  push('first_frame', args.first_frame)
  push('last_frame', args.last_frame)
  for (const input of args.reference_images ?? []) push('reference_image', input)
  for (const input of args.reference_videos ?? []) push('reference_video', input)
  for (const input of args.reference_audio ?? []) push('reference_audio', input)
  if (includeBaseVideo) push('base_video', args.video)
  return slots
}

/**
 * Optional media accepts an omitted value, null, an empty string or a
 * whitespace-only string; all mean "not provided" so a caller that serializes
 * an empty optional field does not spend nine attempts on a schema error.
 * Arrays are normalized by dropping empty entries. Required fields (prompt,
 * task_id) stay strict, and a prompt that references <Picture N> with no actual
 * media is still rejected by the contract check.
 */
export function normalizeMediaArgs(args) {
  const out = { ...args }
  for (const key of ['first_frame', 'last_frame', 'video']) {
    const value = args[key]
    out[key] = typeof value === 'string' && value.trim().length === 0 ? undefined : value
  }
  for (const key of ['reference_images', 'reference_videos', 'reference_audio']) {
    const value = args[key]
    if (Array.isArray(value)) {
      out[key] = value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    }
  }
  return out
}

function decodeDataUri(value) {
  const match = /^data:([^,]*?),(.*)$/s.exec(value)
  if (match === null) return { mime: 'application/octet-stream', bytes: Buffer.from(value) }
  const meta = match[1]
  const mime = meta.split(';')[0] || 'application/octet-stream'
  const base64 = /;base64/i.test(meta)
  const payload = match[2]
  if (!base64) {
    try {
      return { mime, bytes: Buffer.from(decodeURIComponent(payload)) }
    } catch {
      return { mime, bytes: Buffer.from(payload) }
    }
  }
  return { mime, bytes: Buffer.from(payload, 'base64') }
}

/**
 * Resolve one media input into its request value plus registry metadata.
 * `buffer`/`absolute` are memory-only; `sanitizedAsset` strips them.
 */
export function resolveAsset(cwd, input, kind) {
  const value = mediaInput(input, kind)
  if (/^https?:\/\//i.test(value)) {
    let host
    let pathname
    let query = false
    try {
      const url = new URL(value)
      host = url.host
      pathname = url.pathname
      query = url.search.length > 0 || url.hash.length > 0
    } catch {
      host = undefined
      pathname = undefined
    }
    return {
      url: value,
      origin: 'url',
      sha256: sha256Hex(value),
      host,
      pathname,
      query,
      input: value,
    }
  }
  if (/^mm_file:\/\//i.test(value)) {
    return { url: value, origin: 'mm_file', sha256: sha256Hex(value), input: value }
  }
  if (isPassThroughMedia(value)) {
    const decoded = decodeDataUri(value)
    return {
      url: value,
      origin: 'data',
      mime: decoded.mime,
      bytes: decoded.bytes.length,
      sha256: sha256Hex(decoded.bytes),
      durationSeconds: kind === 'video' ? probeMp4Duration(decoded.bytes) : undefined,
      input: value,
    }
  }
  const file = loadLocalFile(cwd, value, kind)
  return {
    url: `data:${file.mime};base64,${file.bytes.toString('base64')}`,
    origin: 'local',
    mime: file.mime,
    bytes: file.size,
    sha256: sha256Hex(file.bytes),
    durationSeconds: kind === 'video' ? probeMp4Duration(file.bytes) : undefined,
    absolute: file.absolute,
    buffer: file.bytes,
    input: value,
  }
}

/** Build the resolved sources object the request builders consume. */
export function sourcesFromAssets(assets) {
  const url = (slot) => assets.find((asset) => asset.slot === slot)?.url
  return {
    firstFrame: url('first_frame'),
    lastFrame: url('last_frame'),
    referenceImages: assets.filter((asset) => asset.slot === 'reference_image').map((asset) => asset.url),
    referenceVideos: assets.filter((asset) => asset.slot === 'reference_video').map((asset) => asset.url),
    referenceAudio: assets.filter((asset) => asset.slot === 'reference_audio').map((asset) => asset.url),
  }
}

/** Resolve every media argument in deterministic declaration order. */
export function buildMediaBundle(cwd, args, { includeBaseVideo = false } = {}) {
  const assets = mediaSlots(args, { includeBaseVideo }).map(({ slot, kind, input }) => {
    try {
      return { ...resolveAsset(cwd, input, kind), slot, kind }
    } catch (error) {
      throw new Error(`${slot}: ${error.message}`)
    }
  })
  return { assets, sources: sourcesFromAssets(assets) }
}

/**
 * Persisted form of one asset. Never contains a signed query string, an API
 * key, an inlined data URI or a memory-only buffer.
 */
export function sanitizedAsset(asset) {
  return {
    slot: asset.slot,
    kind: asset.kind,
    origin: asset.origin,
    sha256: asset.sha256,
    ...(asset.mime === undefined ? {} : { mime: asset.mime }),
    ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
    ...(asset.durationSeconds === undefined ? {} : { duration_seconds: Number(asset.durationSeconds.toFixed(3)) }),
    ...(asset.origin === 'url'
      ? {
          host: asset.host,
          path: asset.pathname,
          query_present: asset.query,
        }
      : {}),
    ...(asset.origin === 'local' ? { input: asset.input } : {}),
    ...(asset.origin === 'mm_file' ? { handle: asset.input } : {}),
    ...(asset.copy === undefined ? {} : { copy: asset.copy }),
    ...(asset.copySkipped === undefined ? {} : { copy_skipped: asset.copySkipped }),
  }
}

export function sanitizedAssets(assets) {
  return assets.map(sanitizedAsset)
}

/**
 * Copy local inputs into the record directory so a later regeneration can
 * resubmit the exact bytes that were sent, even if the workspace file changed.
 */
export function snapshotLocalAssets(recordDir, assets, { maxBytes = 64 * 1024 * 1024 } = {}) {
  let copied = 0
  const skipped = []
  for (const [index, asset] of assets.entries()) {
    if (asset.origin !== 'local') continue
    if (asset.bytes !== undefined && copied + asset.bytes > maxBytes) {
      asset.copySkipped = `input snapshot limit ${maxBytes} bytes exceeded`
      skipped.push(asset)
      continue
    }
    const name = `${String(index + 1).padStart(2, '0')}-${safeSegment(basename(asset.absolute ?? 'input'), 40)}`
    const target = join(recordDir, 'inputs', name)
    mkdirSync(join(recordDir, 'inputs'), { recursive: true })
    writeFileSync(target, asset.buffer, { mode: 0o600 })
    const copyHash = sha256Hex(asset.buffer)
    if (copyHash !== asset.sha256) {
      throw new Error(`input snapshot for ${asset.input} failed its hash check`)
    }
    asset.copy = relative(recordDir, target)
    copied += asset.buffer.length
  }
  return { copied, skipped }
}

/**
 * Sanitized request as persisted in the journal: text is represented by its
 * hash/length, media by its registry digest. Useful for audits and drift checks
 * without retaining prompt copies in two places or URL tokens on disk.
 */
export function sanitizeRequestBody(body, assets) {
  const byUrl = new Map(assets.filter((asset) => asset.url !== undefined).map((asset) => [asset.url, asset]))
  const content = (body.content ?? []).map((item) => {
    if (item.type === 'text') {
      return { type: 'text', chars: item.text.length, sha256: sha256Hex(item.text) }
    }
    const holder = item.image_url ?? item.video_url ?? item.audio_url
    const asset = holder === undefined ? undefined : byUrl.get(holder.url)
    return {
      type: item.type,
      ...(item.role === undefined ? {} : { role: item.role }),
      source:
        asset === undefined
          ? { origin: 'unknown', sha256: sha256Hex(String(holder?.url ?? '')) }
          : {
              origin: asset.origin,
              sha256: asset.sha256,
              ...(asset.mime === undefined ? {} : { mime: asset.mime }),
              ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
              ...(asset.host === undefined ? {} : { host: asset.host }),
              ...(asset.pathname === undefined ? {} : { path: asset.pathname }),
            },
    }
  })
  return {
    model: body.model,
    ...(body.resolution === undefined ? {} : { resolution: body.resolution }),
    ...(body.duration === undefined ? {} : { duration: body.duration }),
    ...(body.ratio === undefined ? {} : { ratio: body.ratio }),
    ...(body.extra === undefined ? {} : { extra: body.extra }),
    ...(body.source_task_id === undefined ? {} : { source_task_id: body.source_task_id }),
    content,
  }
}

/**
 * Fingerprint the paid request payload exactly: the API body changing fields
 * only. Cost caps, budget binding, provenance/dialogue declarations and local
 * consistency references are excluded so changing them cannot silently bypass
 * the unknown-submission duplicate guard for the same paid work.
 */
export function requestFingerprint({ kind, plan = null, prompt = null, assets = [], sourceTaskId = null }) {
  return sha256Hex(JSON.stringify({
    version: 2,
    kind,
    prompt: typeof prompt === 'string' ? prompt : null,
    model: plan?.model ?? null,
    resolution: plan?.resolution ?? null,
    duration: plan?.duration ?? null,
    ratio: plan?.ratio ?? null,
    prompt_expansion: plan?.promptExpansion ?? null,
    source_task_id: sourceTaskId ?? null,
    assets: assets.map((asset) => ({ slot: asset.slot, kind: asset.kind, sha256: asset.sha256 })),
  }))
}

/**
 * Fingerprint an approved plan: the request payload plus the cost cap, budget
 * binding, contract declarations, local regeneration reference and measured
 * source duration. `video_prepare`/`dry_run` store this; execution must match it.
 */
export function operationFingerprint({
  kind,
  plan = null,
  prompt = null,
  assets = [],
  sourceTaskId = null,
  originalTaskId = null,
  sourceDurationSeconds = null,
  maxCost = null,
  budgetId = null,
  contract = {},
}) {
  const request = requestFingerprint({ kind, plan, prompt, assets, sourceTaskId })
  return sha256Hex(JSON.stringify({
    version: 2,
    request,
    original_task_id: originalTaskId ?? null,
    source_duration_seconds: sourceDurationSeconds === undefined || sourceDurationSeconds === null ? null : sourceDurationSeconds,
    max_cost: maxCost === undefined ? null : maxCost,
    budget_id: budgetId ?? null,
    contract: {
      dialogue: contract.dialogue ?? null,
      reference_roles: contract.referenceRoles ?? null,
      source_declarations: contract.sourceDeclarations ?? null,
      approved_sources: contract.approvedSources ?? null,
      shot_id: contract.shotId ?? null,
      project_manifest: contract.projectManifest ?? null,
      // Registry-facing bindings are part of the approved plan only; they do
      // not change the API body, so requestFingerprint deliberately omits them.
      asset_ids: canonicalAssetIds(contract.assetIds),
      source_asset_id: contract.sourceAssetId ?? null,
    },
  }))
}

/** Stable canonical form for the slot -> asset id map (object key order is not significant). */
export function canonicalAssetIds(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return value
  const out = {}
  for (const key of Object.keys(value).sort()) {
    const entry = value[key]
    out[key] = Array.isArray(entry) ? entry.map((item) => String(item)) : entry
  }
  return out
}
