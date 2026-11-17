/**
 * Byte-level image identification used by the receipts.
 *
 * The gateway is not authoritative about what it delivered: GPT 2.6 answers PNG
 * even when `output_format: jpeg` was requested, so the saved extension, the
 * reported format and the receipt all follow the bytes. The same sniffing
 * supplies the real pixel dimensions, which is what makes "I replaced an
 * approved 2048px original with a video frame" visible in the receipt instead
 * of hidden behind a provider field.
 *
 * Node built-ins only; no image library is loaded.
 */

/** MIME type for a sniffed format. */
const MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
}

/** Sniff the container format from magic bytes. */
export function imageFormatOf(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  if (bytes.length >= 6) {
    const head = bytes.toString('ascii', 0, 6)
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif'
  }
  // ISO base media: HEIC/HEIF are a best effort; the `ispe` box carries the size.
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12)
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'heic'
  }
  return undefined
}

/** MIME type for a sniffed format, defaulting to PNG like the upload path. */
export function mimeOf(format) {
  return MIME[format] ?? 'image/png'
}

function pngSize(bytes) {
  if (bytes.length < 24) return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function jpegSize(bytes) {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2) return undefined
    if (isSof) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return undefined
}

function webpSize(bytes) {
  if (bytes.length < 30) return undefined
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    if (bytes.length < 30) return undefined
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
  }
  return undefined
}

function ispeSize(bytes) {
  // Best effort: the first `ispe` box in the header carries width/height.
  const limit = Math.min(bytes.length - 16, 65_536)
  for (let offset = 0; offset <= limit; offset += 1) {
    if (bytes.toString('ascii', offset, offset + 4) !== 'ispe') continue
    return { width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12) }
  }
  return undefined
}

/**
 * Identify one image buffer: actual format, byte length and, when the container
 * can be read with built-ins, the real pixel dimensions.
 *
 * Dimensions are intentionally `null` when unknown (HEIC variants, truncated
 * bytes) rather than a guess, so a receipt never claims a size it did not read.
 */
export function imageInfoOf(bytes) {
  const format = imageFormatOf(bytes)
  let size
  if (format === 'png') size = pngSize(bytes)
  else if (format === 'jpeg') size = jpegSize(bytes)
  else if (format === 'webp') size = webpSize(bytes)
  else if (format === 'gif' && bytes.length >= 10) {
    size = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  } else if (format === 'heic') size = ispeSize(bytes)
  return {
    format: format ?? null,
    width: size?.width ?? null,
    height: size?.height ?? null,
    bytes: bytes.length,
  }
}
