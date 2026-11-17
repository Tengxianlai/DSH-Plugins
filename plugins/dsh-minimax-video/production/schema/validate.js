/**
 * Structural checks for the local evidence report (`local-qa.js`) and for
 * declared review records. These helpers deliberately do not try to prove that
 * a human approved anything: every approval/QC/review value is a declared
 * workflow record, not same-UID authentication.
 *
 * Evidence schema is owned by local-qa.js (`dsh.ai-video-evidence/1`); these
 * checks are deliberately strict about the fields the QC gate relies on:
 * source-byte binding, full-decode coverage, frame completeness, black/static
 * suspicion and ASR word matching.
 */

export const EVIDENCE_SCHEMA = 'dsh.ai-video-evidence/1'
export const ASR_SCHEMA = 'dsh.ai-video-local-asr/2'
export const REVIEW_SCHEMA = 'dsh.ai-video-review/1'
export const QC_SCHEMA = 'dsh.ai-video-qc/1'
export const REFERENCES_SCHEMA = 'dsh.ai-video-references/2'
export const REQUEST_SCHEMA = 'dsh.ai-video-request/1'

const SHA = /^[a-f0-9]{64}$/i

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isSha = (value) => typeof value === 'string' && SHA.test(value)
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : undefined)

function checkFrameMetricsStructure(machine, errors) {
  const metrics = machine.metrics
  if (!isObject(metrics)) {
    errors.push('evidence.machine.metrics is required for a frame scan')
    return
  }
  if (!Number.isInteger(metrics.frames_measured) || metrics.frames_measured < 1) {
    errors.push('evidence.machine.metrics.frames_measured must be a positive integer')
  }
  if (!isObject(metrics.yavg)
    || typeof metrics.yavg.min !== 'number'
    || typeof metrics.yavg.max !== 'number'
    || typeof metrics.yavg.mean !== 'number') {
    errors.push('evidence.machine.metrics.yavg must contain numeric min/max/mean')
  }
  if (typeof metrics.near_black_threshold !== 'number') {
    errors.push('evidence.machine.metrics.near_black_threshold must be a number')
  }
  if (!Number.isInteger(metrics.near_black_frame_count) || metrics.near_black_frame_count < 0) {
    errors.push('evidence.machine.metrics.near_black_frame_count must be a non-negative integer')
  }
  if (!isObject(metrics.ydif) || typeof metrics.ydif.available !== 'boolean') {
    errors.push('evidence.machine.metrics.ydif must report whether frame differences were measured')
  }
  if (!Array.isArray(metrics.suspicion)) {
    errors.push('evidence.machine.metrics.suspicion must be an array')
  }
}

/** The bytes hash actually inside the evidence report, preferring the invariant pair. */
export function evidenceSourceSha256(report) {
  const top = lower(report?.source_sha256)
  const subject = lower(report?.subject?.source?.sha256)
  if (top !== undefined && subject !== undefined && top !== subject) return null
  return top ?? subject
}

/** Validate one local evidence report for the requested QC kind. */
export function validateEvidenceReport(report, { kind, sourceSha256, requirePass = true, frameGate = false } = {}) {
  const errors = []
  if (!isObject(report)) return { ok: false, errors: ['evidence must be a JSON object'] }
  if (report.schema !== EVIDENCE_SCHEMA) errors.push(`evidence.schema must be ${EVIDENCE_SCHEMA}`)
  if (report.content_approval !== 'not_asserted') errors.push("evidence.content_approval must be 'not_asserted'")
  if (!Array.isArray(report.limits)) errors.push('evidence.limits must be an array of strings')

  const declaredTop = lower(report.source_sha256)
  const declaredSubject = lower(report?.subject?.source?.sha256)
  if (!isSha(declaredTop)) errors.push('evidence.source_sha256 must be a sha256 hex string')
  if (!isSha(declaredSubject)) errors.push('evidence.subject.source.sha256 must be a sha256 hex string')
  if (isSha(declaredTop) && isSha(declaredSubject) && declaredTop !== declaredSubject) {
    errors.push('evidence.source_sha256 disagrees with subject.source.sha256')
  }
  const hash = isSha(declaredTop) ? declaredTop : declaredSubject
  if (sourceSha256 !== undefined && hash !== undefined && hash !== lower(sourceSha256)) {
    errors.push('evidence belongs to different source bytes')
  }

  const machine = report.machine
  if (!isObject(machine)) {
    errors.push('evidence.machine is required')
    return { ok: false, errors, source_sha256: hash, machine: null }
  }
  if (!['pass', 'review_required', 'fail', 'unknown'].includes(machine.verdict)) {
    errors.push('evidence.machine.verdict must be pass, review_required, fail or unknown')
  }

  if (kind === 'frame_scan' && (frameGate || requirePass)) {
    const decode = machine.decode
    if (!isObject(decode)) errors.push('evidence.machine.decode is required for frame_scan')
    else if (decode.status !== 'pass') errors.push(`evidence.machine.decode.status must be pass (got ${decode.status ?? 'missing'})`)
    if (!frameGate && machine.verdict !== 'pass') errors.push(`evidence.machine.verdict must be pass for frame_scan (got ${machine.verdict ?? 'missing'})`)

    const frames = machine.frames
    if (!isObject(frames)) {
      errors.push('evidence.machine.frames is required for frame_scan')
    } else {
      if (!Number.isInteger(frames.decoded) || frames.decoded < 1) errors.push('evidence.machine.frames.decoded must be a positive integer')
      if (frames.declared !== null && frames.declared !== undefined && (!Number.isInteger(frames.declared) || frames.declared < 1)) {
        errors.push('evidence.machine.frames.declared must be a positive integer or null')
      }
      if (frames.expected !== null && frames.expected !== undefined && (!Number.isInteger(frames.expected) || frames.expected < 1)) {
        errors.push('evidence.machine.frames.expected must be a positive integer or null')
      }
      if (typeof frames.shortfall === 'number' && frames.shortfall > 0) {
        errors.push(`evidence.machine.frames.shortfall ${frames.shortfall} means the decode is short of the expected frame count`)
      }
      if (Number.isInteger(frames.declared) && Number.isInteger(frames.decoded) && frames.declared !== frames.decoded) {
        errors.push(`evidence.machine.frames decoded ${frames.decoded} does not match declared ${frames.declared}`)
      }
    }

    const coverage = machine.coverage
    if (!isObject(coverage)) {
      errors.push('evidence.machine.coverage is required for frame_scan')
    } else {
      if (coverage.status !== 'verified') errors.push(`evidence.machine.coverage.status must be verified (got ${coverage.status ?? 'missing'})`)
      if (coverage.complete !== true) errors.push('evidence.machine.coverage.complete must be true')
      const scope = Array.isArray(coverage.scope) ? coverage.scope.map(String) : []
      if (!scope.some((entry) => /all_decoded_frames/.test(entry))) errors.push('evidence.machine.coverage.scope must include all_decoded_frames')
    }

    if (frameGate) {
      checkFrameMetricsStructure(machine, errors)
    } else {
      const metrics = machine.metrics
      if (isObject(metrics)) {
        if (Number.isInteger(metrics.near_black_frame_count) && Number.isInteger(machine.frames?.decoded)
          && metrics.near_black_frame_count === machine.frames.decoded) {
          errors.push('all frames are near-black; a strict frame pass is not allowed')
        }
        if (Array.isArray(metrics.suspicion) && metrics.suspicion.length > 0) {
          errors.push(`evidence.machine.metrics reports suspicion (${metrics.suspicion.join(', ')}); a strict frame pass is not allowed`)
        }
      }
      if (isObject(machine.duration) && machine.duration.status === 'mismatch') {
        errors.push('evidence.machine.duration does not match the expected duration')
      }
    }
  }

  if (kind === 'asr') {
    const asr = machine.asr
    if (!isObject(asr)) {
      errors.push('evidence.machine.asr is required for asr evidence')
    } else {
      if (asr.schema !== ASR_SCHEMA) errors.push(`evidence.machine.asr.schema must be ${ASR_SCHEMA}`)
      if (!isSha(lower(asr.source_sha256))) errors.push('evidence.machine.asr.source_sha256 must bind the transcribed bytes')
      else if (hash !== undefined && lower(asr.source_sha256) !== hash) errors.push('evidence.machine.asr.source_sha256 disagrees with the evidence source')
      if (!['match', 'mismatch', 'transcribed', 'review_required', 'silence_suspected', 'no_speech_detected', 'no_audio', 'error'].includes(asr.status)) {
        errors.push(`evidence.machine.asr.status is not recognised (${asr.status ?? 'missing'})`)
      }
      if (asr.normalized_text_match !== null && typeof asr.normalized_text_match !== 'boolean') {
        errors.push('evidence.machine.asr.normalized_text_match must be boolean or null')
      }
    }
  }

  if (kind !== undefined && kind !== 'frame_scan' && kind !== 'asr') {
    errors.push(`evidence is not produced for QC kind ${kind}`)
  }
  return { ok: errors.length === 0, errors, source_sha256: hash, machine }
}

/** True when local-qa says the ASR output matches the declared text. */
export function evidenceAsrMachineMatch(report) {
  return isObject(report?.machine?.asr) && report.machine.asr.status === 'match' && report.machine.asr.normalized_text_match === true
}

/**
 * Validate one declared review record (motion/identity/voice, or the explicit
 * agent/director review of a mismatched ASR transcript).
 */
export function validateReviewRecord(report, { kind, sourceSha256 } = {}) {
  const errors = []
  if (!isObject(report)) return { ok: false, errors: ['review must be a JSON object'] }
  if (report.schema !== REVIEW_SCHEMA) errors.push(`review.schema must be ${REVIEW_SCHEMA}`)
  if (kind !== undefined && report.kind !== kind) errors.push(`review.kind must be ${kind}`)
  const top = lower(report.source_sha256)
  if (!isSha(top)) errors.push('review.source_sha256 must be a sha256 hex string')
  if (sourceSha256 !== undefined && top !== undefined && top !== lower(sourceSha256)) {
    errors.push('review belongs to different source bytes')
  }
  if (!['accepted', 'pass'].includes(report.decision)) errors.push("review.decision must be 'accepted' or 'pass'")
  if (typeof report.scope !== 'string' || report.scope.trim().length === 0) errors.push('review.scope must describe what was actually reviewed')
  if (typeof report.reviewer !== 'string' || report.reviewer.trim().length === 0) errors.push('review.reviewer must name the reviewer')
  if (report.authority !== 'declared') errors.push("review.authority must be 'declared' (workflow record, not authentication)")
  if (report.content_approval !== 'not_asserted') errors.push("review.content_approval must be 'not_asserted'")
  return { ok: errors.length === 0, errors, review: report }
}

function parseFrameRate(value) {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return null
  const match = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(value.trim())
  if (match === null) return null
  const numerator = Number(match[1])
  const denominator = match[2] === undefined ? 1 : Number(match[2])
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null
  return numerator / denominator
}

/**
 * H3 regeneration accepts only an H3-family 768P clip: 24 fps, dimensions
 * divisible by 32, 768P area, and 107..362 frames on the documented 17-frame
 * grid, with an audio track. This gate applies only to the base source of a
 * regeneration, not to ordinary inspect evidence.
 */
export function validateRegenSourceSpec(report) {
  const errors = []
  const subject = report?.subject
  const video = subject?.video
  if (!isObject(video)) return ['subject.video is required for regeneration source evidence']
  const width = video.width
  const height = video.height
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    errors.push('subject.video width/height must be positive integers')
  } else {
    if (width % 32 !== 0 || height % 32 !== 0) errors.push(`video ${width}x${height} must have width and height divisible by 32`)
    const area = width * height
    if (area < 589824 || area > 1032192) errors.push(`video area ${area} is outside the H3 768P range 589824-1032192`)
  }
  const rate = parseFrameRate(video.r_frame_rate)
  if (rate === null || Math.abs(rate - 24) > 1e-6) errors.push(`video frame rate ${video.r_frame_rate ?? 'missing'} must be 24 fps`)
  const frameCount = [video.nb_frames, report?.machine?.frames?.declared, report?.machine?.frames?.decoded]
    .find((value) => Number.isInteger(value))
  if (!Number.isInteger(frameCount)) {
    errors.push('video frame count is unknown; regeneration needs 107-362 frames on the 17-frame grid')
  } else if (frameCount < 107 || frameCount > 362 || (frameCount - 107) % 17 !== 0) {
    errors.push(`video frame count ${frameCount} is outside the H3 regeneration grid (107..362, step 17)`)
  }
  const hasAudio = isObject(subject?.audio)
    || (Array.isArray(subject?.streams) && subject.streams.some((stream) => stream?.type === 'audio'))
  if (!hasAudio) errors.push('video source has no audio track; H3 regeneration needs native audio')
  return errors
}

export const EVIDENCE_KINDS = new Set(['frame_scan', 'asr'])
export const REVIEW_KINDS = new Set(['motion_review', 'voice_review', 'identity_review'])
