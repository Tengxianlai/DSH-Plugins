/**
 * Media input handling for the MiniMax video API.
 *
 * The API accepts a public URL, `mm_file://{file_id}`, or a data URI. Local
 * session files are inlined as data URIs so a normal workspace path works
 * without an upload step. The 64 MB request cap is enforced before the call.
 *
 * `loadLocalFile` is also the snapshot path: callers hash and copy the exact
 * bytes that were read, so the journal describes the bytes that were submitted,
 * not whatever the path happens to contain later.
 */
import { readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { LIMITS } from './catalog.js'

const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

const AUDIO_MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
}

const LIMITS_BY_KIND = {
  image: { bytes: LIMITS.imageBytes, mimes: IMAGE_MIME, label: 'image' },
  video: { bytes: LIMITS.videoBytes, mimes: VIDEO_MIME, label: 'video' },
  audio: { bytes: LIMITS.audioBytes, mimes: AUDIO_MIME, label: 'audio' },
}

export function mimeFor(kind, path) {
  const ext = extname(String(path).split(/[?#]/)[0]).toLowerCase()
  const mime = LIMITS_BY_KIND[kind].mimes[ext]
  if (mime === undefined) {
    const allowed = Object.keys(LIMITS_BY_KIND[kind].mimes).join(', ')
    throw new Error(`unsupported ${kind} extension "${ext}"; use ${allowed}, or pass a public URL`)
  }
  return mime
}

/** True for inputs that pass straight through to the API unchanged. */
export function isPassThroughMedia(value) {
  return /^https?:\/\//i.test(value) || /^mm_file:\/\//i.test(value) || /^data:/i.test(value)
}

/** Validate one media argument and return its trimmed string value. */
export function mediaInput(value, kind) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${kind} input must be a non-empty path or URL`)
  }
  return value.trim()
}

/**
 * Read one local media file after the per-asset size check.
 * Returns the exact bytes plus mime type and size; never mutates the input.
 */
export function loadLocalFile(cwd, value, kind) {
  const meta = LIMITS_BY_KIND[kind]
  const raw = mediaInput(value, kind)
  const path = raw.startsWith('file://') ? decodeURIComponent(raw.slice('file://'.length)) : raw
  const absolute = path.startsWith('/') ? path : resolve(cwd, path)
  let size
  try {
    size = statSync(absolute).size
  } catch (error) {
    throw new Error(`cannot read ${meta.label} ${value}: ${error.message}`)
  }
  if (size > meta.bytes) {
    throw new Error(
      `${meta.label} ${value} is ${(size / 1024 / 1024).toFixed(1)} MB; the API limit is ${meta.bytes / 1024 / 1024} MB per file. Upload it and pass a public URL`,
    )
  }
  const mime = mimeFor(kind, absolute)
  let bytes
  try {
    bytes = readFileSync(absolute)
  } catch (error) {
    throw new Error(`cannot read ${meta.label} ${value}: ${error.message}`)
  }
  return { absolute, bytes, mime, size }
}

/**
 * Resolve one media input to something the H3 API accepts.
 *
 * URLs, `mm_file://` handles and data URIs pass through untouched. A local
 * path is read and returned as a data URI after the per-asset size check.
 */
export function resolveMedia(cwd, input, kind) {
  const value = mediaInput(input, kind)
  if (isPassThroughMedia(value)) return value
  const file = loadLocalFile(cwd, value, kind)
  return `data:${file.mime};base64,${file.bytes.toString('base64')}`
}

/** Reject a JSON body above the API's 64 MB request cap with a useful hint. */
export function assertRequestSize(body) {
  const bytes = Buffer.byteLength(JSON.stringify(body))
  if (bytes > LIMITS.requestBytes) {
    throw new Error(
      `request body is ${(bytes / 1024 / 1024).toFixed(1)} MB; the API cap is 64 MB. Base64 inflates files by about 33%: upload the largest assets and pass public URLs`,
    )
  }
  return bytes
}

/** Count images that will be sent, for the cost estimate. */
export function imageCountOf(sources) {
  return (sources.firstFrame === undefined ? 0 : 1) +
    (sources.lastFrame === undefined ? 0 : 1) +
    sources.referenceImages.length
}
