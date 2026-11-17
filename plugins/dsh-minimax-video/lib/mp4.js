/**
 * Minimal MP4/MOV duration probe.
 *
 * H3 bills reference-video input seconds and regeneration bills the source
 * clip's seconds. A local clip's duration can be read from the movie header
 * without shipping a media library, which turns a partial cost estimate into a
 * complete one before the paid call. URL inputs and unparsable containers stay
 * unknown and are bounded conservatively by the caller instead.
 */

function boxAt(buffer, offset, end) {
  if (offset + 8 > end) return undefined
  let size = buffer.readUInt32BE(offset)
  const type = buffer.toString('ascii', offset + 4, offset + 8)
  let header = 8
  if (size === 1) {
    if (offset + 16 > end) return undefined
    size = Number(buffer.readBigUInt64BE(offset + 8))
    header = 16
  } else if (size === 0) {
    size = end - offset
  }
  if (size < header || offset + size > end) return undefined
  return { type, start: offset + header, end: offset + size, size }
}

function mvhdDuration(buffer, start, end) {
  if (start + 4 > end) return undefined
  const version = buffer.readUInt8(start)
  let timescale
  let duration
  if (version === 1) {
    if (start + 32 > end) return undefined
    timescale = buffer.readUInt32BE(start + 20)
    duration = Number(buffer.readBigUInt64BE(start + 24))
  } else {
    if (start + 20 > end) return undefined
    timescale = buffer.readUInt32BE(start + 12)
    duration = buffer.readUInt32BE(start + 16)
  }
  if (!Number.isFinite(timescale) || timescale <= 0 || !Number.isFinite(duration) || duration <= 0) {
    return undefined
  }
  return duration / timescale
}

function moovDuration(buffer, start, end) {
  let offset = start
  while (offset + 8 <= end) {
    const box = boxAt(buffer, offset, end)
    if (box === undefined) return undefined
    if (box.type === 'mvhd') return mvhdDuration(buffer, box.start, box.end)
    offset = box.end
  }
  return undefined
}

/**
 * Return a container's duration in seconds, or undefined when it cannot be
 * read. Accepts any Buffer (a whole MP4 or a leading fragment).
 */
export function probeMp4Duration(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return undefined
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const box = boxAt(buffer, offset, buffer.length)
    if (box === undefined) return undefined
    if (box.type === 'moov') {
      const duration = moovDuration(buffer, box.start, box.end)
      if (duration !== undefined) return duration
    }
    offset = box.end
  }
  return undefined
}
