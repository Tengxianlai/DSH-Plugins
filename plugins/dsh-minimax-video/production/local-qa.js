/**
 * Local, offline media evidence for AI-video review.
 *
 * `inspectMedia` is synchronous (it shells out with spawnSync). It never calls a
 * cloud API, never downloads a model and never decides whether content is good:
 * it collects machine observations, marks coverage honestly and leaves content
 * approval unasserted. Callers (the CLI, an agent, a human) must review the
 * scope and record their own decisions.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EVIDENCE_SCHEMA = 'dsh.ai-video-evidence/1'
export const ASR_SCHEMA = 'dsh.ai-video-local-asr/2'
const ASR_SCRIPT = fileURLToPath(new URL('./local_asr.py', import.meta.url))
// Same algorithm/digest as project.js fileSha256 (sha256 of the file bytes), kept
// local so evidence hashing streams the file instead of loading a whole 1 GB
// take into memory, and does not depend on project.js being mid-edit.
function fileSha256(file) {
  const hash = createHash('sha256')
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
    let read
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}
const NEAR_BLACK_YAVG = 18
const STATIC_YDIF = 0.05
const FFPROBE_MAX = 8 * 1024 * 1024
const SCAN_MAX = 8 * 1024 * 1024
const ASR_MAX = 32 * 1024 * 1024

const LIMITS = [
  'Container metadata, frame counts and decoded-frame metrics are machine observations; they do not prove content, hands, lip sync, identity, acting, sound or customer acceptance.',
  'A complete decode only proves the container can be read end-to-end; it is not completeness of the original production unless a trusted frame count/duration is supplied.',
  'Near-black, static or silent signals are suspicion hints for review, not quality decisions.',
  'ASR proves approximate words in the audio only; homophones and word substitutions are review hints, not proof a take is wrong.',
  'content_approval is fixed to not_asserted in this report; approval must be recorded separately with its own evidence.',
]

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function run(program, args, { maxBuffer, cwd, timeout } = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer, cwd, timeout, windowsHide: true })
  if (result.error) {
    const code = result.error.code === 'ENOENT' ? 'ENOENT' : result.error.code || 'SPAWN_ERROR'
    throw fail(code, `${program}: ${result.error.code || result.error.message}`)
  }
  return result
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseFps(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value ?? ''))
  if (!match) return null
  const fps = Number(match[1]) / Number(match[2])
  return Number.isFinite(fps) && fps > 0 ? fps : null
}

function subjectOf(file, info, hash, bytes) {
  const streams = (info.streams ?? []).map((stream, index) => {
    const row = { index, type: stream.codec_type, codec: stream.codec_name ?? null }
    if (stream.codec_type === 'video') {
      row.width = Number(stream.width) || null
      row.height = Number(stream.height) || null
      row.r_frame_rate = stream.r_frame_rate ?? null
      row.nb_frames = Number.isFinite(Number(stream.nb_frames)) ? Number(stream.nb_frames) : null
    }
    if (stream.codec_type === 'audio') {
      row.sample_rate = Number(stream.sample_rate) || null
      row.channels = Number(stream.channels) || null
    }
    return row
  })
  const video = streams.find(stream => stream.type === 'video') ?? null
  const audio = streams.find(stream => stream.type === 'audio') ?? null
  const durationSec = Number(info.format?.duration)
  return {
    file,
    source: { sha256: hash, bytes },
    container: info.format?.format_name ?? null,
    duration_sec: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) / 1000 : null,
    video,
    audio,
    streams,
  }
}

function parseMetrics(metricsText) {
  const yavg = []
  const ydif = []
  const pattern = /lavfi\.signalstats\.(YAVG|YDIF)=(-?[\d.]+(?:e-?\d+)?)/gi
  for (const match of metricsText.matchAll(pattern)) {
    const value = Number(match[2])
    if (!Number.isFinite(value)) continue
    if (match[1].toUpperCase() === 'YAVG') yavg.push(value)
    else ydif.push(value)
  }
  return { yavg, ydif }
}

function metricsOf(yavg, ydif) {
  if (!yavg.length) return null
  const sum = yavg.reduce((acc, value) => acc + value, 0)
  const nearBlack = yavg.filter(value => value < NEAR_BLACK_YAVG).length
  const suspicion = []
  if (nearBlack > 0) suspicion.push('near_black_frames')
  if (nearBlack === yavg.length) suspicion.push('all_black_clip')
  const ydifStats = ydif.length
    ? {
        available: true,
        min: Math.min(...ydif),
        max: Math.max(...ydif),
        static_frame_count: ydif.filter(value => value <= STATIC_YDIF).length,
      }
    : { available: false, min: null, max: null, static_frame_count: 0 }
  if (ydifStats.available && ydifStats.static_frame_count === ydif.length) suspicion.push('static_clip')
  return {
    frames_measured: yavg.length,
    scale: '320px_width',
    yavg: { min: Math.min(...yavg), max: Math.max(...yavg), mean: Math.round((sum / yavg.length) * 100) / 100 },
    near_black_threshold: NEAR_BLACK_YAVG,
    near_black_frame_count: nearBlack,
    ydif: ydifStats,
    suspicion,
  }
}

function decodeScan(file, video) {
  if (!video) throw fail('NO_VIDEO_STREAM', 'scanAll requires a video stream')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-local-qa-'))
  try {
    const metricsName = 'frame-metrics.txt'
    let result
    try {
      result = run('ffmpeg', [
        '-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode',
        '-i', file, '-map', '0:v:0',
        '-vf', `scale=320:-2,signalstats,metadata=print:file=${metricsName}`,
        '-an', '-f', 'null', '-',
      ], { maxBuffer: SCAN_MAX, cwd: dir, timeout: 30 * 60 * 1000 })
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('FFMPEG_UNAVAILABLE', 'ffmpeg is not installed or not on PATH')
      throw error
    }
    const metricsPath = join(dir, metricsName)
    const text = existsSync(metricsPath) ? readFileSync(metricsPath, 'utf8') : ''
    const { yavg, ydif } = parseMetrics(text)
    const decoded = yavg.length
    const status = result.status === 0 && decoded > 0 ? 'pass' : 'fail'
    return {
      decode: {
        status,
        mode: 'full_scan',
        exit_code: result.status,
        error: status === 'pass' ? null : String(result.stderr || '').slice(-2000) || 'ffmpeg returned no decodable video frames',
        note: status === 'pass' ? null : 'Decode failed or produced no measured frames; frame metrics are partial and cannot support a pass.',
      },
      frames: { decoded, declared: video.nb_frames ?? null },
      coverageScope: ['container_metadata', 'all_decoded_frames_at_320px_metrics', 'full_decode'],
      metrics: metricsOf(yavg, ydif),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function coverageOf({ scanAll, decoded, declared, expectedFrames, decodeStatus }) {
  const expectedUsed = finite(expectedFrames) ? expectedFrames : (finite(declared) ? declared : null)
  const expectedSource = finite(expectedFrames) ? 'caller' : (finite(declared) ? 'container' : null)
  const shortfall = expectedUsed !== null && decoded !== null ? expectedUsed - decoded : null
  if (!scanAll) {
    return {
      frames: { decoded: null, declared: finite(declared) ? declared : null, expected: finite(expectedFrames) ? expectedFrames : null, expected_source: expectedSource, shortfall: null },
      coverage: { status: 'unknown', scope: ['container_metadata'], complete: null, note: 'scanAll was not requested; no frames were decoded, so completeness is unknown.' },
    }
  }
  if (expectedUsed === null) {
    return {
      frames: { decoded, declared: finite(declared) ? declared : null, expected: finite(expectedFrames) ? expectedFrames : null, expected_source: null, shortfall: null },
      coverage: {
        status: 'unknown',
        scope: ['container_metadata', 'all_decoded_frames_at_320px_metrics', 'full_decode'],
        complete: decodeStatus === 'fail' ? false : null,
        note: 'No trusted expected frame count (caller expectedFrames or container nb_frames) is available; a decodable remainder does not prove the original was complete.',
      },
    }
  }
  const matched = decoded === expectedUsed
  const status = matched ? 'verified' : 'mismatch'
  return {
    frames: { decoded, declared: finite(declared) ? declared : null, expected: finite(expectedFrames) ? expectedFrames : null, expected_source: expectedSource, shortfall },
    coverage: {
      status,
      scope: ['container_metadata', 'all_decoded_frames_at_320px_metrics', 'full_decode'],
      complete: matched,
      note: matched
        ? (expectedSource === 'caller' ? 'Decoded frame count matches the caller-supplied expectation.' : 'Decoded frame count matches the container-declared nb_frames (container metadata is not independent proof).')
        : (expectedSource === 'caller'
          ? `Decoded ${decoded} frames but the caller expected ${expectedUsed}; this is a completeness mismatch.`
          : `Decoded ${decoded} frames but the container declares ${expectedUsed}; verify whether the container metadata or the file is wrong.`),
    },
  }
}

function durationOf(actual, expectedDuration, fps) {
  if (!finite(expectedDuration)) return { actual_sec: actual, expected_sec: null, delta_sec: null, tolerance_sec: null, status: 'unknown' }
  const tolerance = Math.max(fps ? 1 / fps : 0.5, 0.25)
  const delta = actual === null ? null : actual - expectedDuration
  const status = delta === null ? 'unknown' : (Math.abs(delta) <= tolerance ? 'match' : 'mismatch')
  return {
    actual_sec: actual,
    expected_sec: expectedDuration,
    delta_sec: delta === null ? null : Math.round(delta * 1000) / 1000,
    tolerance_sec: Math.round(tolerance * 1000) / 1000,
    status,
  }
}

function normalise(text) {
  return String(text ?? '').replace(/[^\w\u4e00-\u9fff]/g, '')
}

function defaultVerdict({ decodeStatus, coverage, metrics, asr, durationStatus, expectedFrames, expectedDuration }) {
  if (decodeStatus === 'fail') return 'fail'
  if (finite(expectedFrames) && coverage.status === 'mismatch') return 'fail'
  if (finite(expectedDuration) && durationStatus === 'mismatch') return 'fail'
  if (finite(expectedDuration) && durationStatus === 'unknown') return 'review_required'
  const asrNegative = asr && ['mismatch', 'error', 'silence_suspected', 'no_audio', 'no_speech_detected', 'review_required'].includes(asr.status)
  if (decodeStatus === 'unknown' && coverage.status === 'unknown') return asrNegative ? 'review_required' : 'unknown'
  if (coverage.status !== 'verified') return 'review_required'
  if (metrics?.suspicion?.length) return 'review_required'
  if (asrNegative) return 'review_required'
  return 'pass'
}

function asrError(status, detail) {
  return {
    schema: ASR_SCHEMA,
    status,
    source_sha256: null,
    text: null,
    language: null,
    duration_sec: null,
    expected_text: null,
    normalized_text_match: null,
    model: null,
    segments: [],
    warnings: [],
    limits: ['ASR failed; no transcript is present and no words were accepted.'],
    error: detail,
  }
}

function runAsr({ file, hash, asrPython, asrModel, expectedText, language }) {
  const modelDir = resolve(asrModel)
  let modelStat
  try { modelStat = statSync(modelDir) } catch { modelStat = null }
  if (!modelStat?.isDirectory()) throw fail('ASR_MODEL_UNAVAILABLE', `ASR model directory does not exist: ${modelDir}`)
  const python = asrPython || 'python3'
  if (python.includes('/') || python.includes('\\')) {
    try { accessSync(python, constants.X_OK) } catch { throw fail('ASR_PYTHON_UNAVAILABLE', `ASR python is not executable: ${python}`) }
  }
  const args = [ASR_SCRIPT, '--file', file, '--model', modelDir, '--language', language || 'zh', '--expect-sha256', hash]
  if (expectedText) args.push('--expected', String(expectedText))
  let result
  try {
    result = run(python, args, { maxBuffer: ASR_MAX, timeout: 20 * 60 * 1000 })
  } catch (error) {
    if (error.code === 'ENOENT') throw fail('ASR_PYTHON_UNAVAILABLE', `ASR python could not be started: ${python}`)
    throw error
  }
  if (result.status !== 0) {
    return asrError('error', { code: 'ASR_EXIT', exit_code: result.status, message: String(result.stderr || '').slice(-2000) })
  }
  let parsed
  try { parsed = JSON.parse(String(result.stdout || '').trim()) } catch {
    return asrError('error', { code: 'ASR_BAD_OUTPUT', message: 'local ASR did not print one JSON document', stderr: String(result.stderr || '').slice(-1000) })
  }
  const reported = parsed.source?.sha256 ?? parsed.source_sha256 ?? null
  if (parsed.status === 'source_hash_mismatch' || (reported && reported !== hash)) {
    throw fail('ASR_SOURCE_HASH_MISMATCH', 'the ASR process hashed different bytes than the inspected file')
  }
  if (parsed.status === 'error' || !reported) {
    return asrError(parsed.status === 'error' ? 'error' : 'review_required', parsed.error ?? { code: 'ASR_INCOMPLETE', message: 'ASR did not bind a source hash' })
  }
  const status = ['match', 'mismatch', 'transcribed', 'review_required', 'silence_suspected', 'no_speech_detected', 'no_audio'].includes(parsed.status)
    ? parsed.status
    : 'review_required'
  return {
    schema: parsed.schema ?? ASR_SCHEMA,
    source_sha256: reported,
    status,
    text: parsed.text ?? '',
    language: parsed.language ?? language ?? null,
    duration_sec: parsed.duration ?? parsed.decoding?.duration_sec ?? null,
    expected_text: expectedText ?? null,
    normalized_text_match: parsed.normalized_text_match ?? (expectedText ? normalise(parsed.text) === normalise(expectedText) : null),
    model: parsed.model ?? null,
    decoding: parsed.decoding ?? null,
    audio: parsed.audio ?? null,
    vad: parsed.vad ?? null,
    segments: Array.isArray(parsed.segments) ? parsed.segments : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    limits: Array.isArray(parsed.limits) && parsed.limits.length ? parsed.limits : asrError('review_required', null).limits,
  }
}

/**
 * Inspect one local media file and return a machine-evidence report.
 *
 * @param {object} options
 * @param {string} options.file             local media path (resolved by the caller)
 * @param {boolean} [options.scanAll]       decode every frame once and collect 320px luma metrics
 * @param {number} [options.expectedFrames] caller-supplied trusted frame count
 * @param {number} [options.expectedDuration] caller-supplied trusted duration in seconds
 * @param {string} [options.asrPython]      python executable that has faster-whisper (optional)
 * @param {string} [options.asrModel]       local faster-whisper model directory (optional)
 * @param {string} [options.expectedText]   approved dialogue line for a text check (optional)
 * @param {string} [options.language]       ASR language (default zh)
 * @returns {object} dsh.ai-video-evidence/1 report
 */
export function inspectMedia(options = {}) {
  const { file, scanAll = false, expectedFrames, expectedDuration, asrPython, asrModel, expectedText, language } = options
  if (typeof file !== 'string' || !file) throw fail('INVALID_OPTIONS', 'file must be a non-empty string')
  if (expectedFrames !== undefined && !(Number.isInteger(expectedFrames) && expectedFrames > 0)) throw fail('INVALID_OPTIONS', 'expectedFrames must be a positive integer')
  if (expectedDuration !== undefined && !(finite(expectedDuration) && expectedDuration > 0)) throw fail('INVALID_OPTIONS', 'expectedDuration must be a positive number of seconds')
  if (typeof scanAll !== 'boolean') throw fail('INVALID_OPTIONS', 'scanAll must be a boolean')
  if ((asrPython || asrModel) && !asrModel) throw fail('INVALID_OPTIONS', 'asrModel is required when ASR is requested')
  if (asrModel) {
    const modelDir = resolve(asrModel)
    let modelStat
    try { modelStat = statSync(modelDir) } catch { modelStat = null }
    if (!modelStat?.isDirectory()) throw fail('ASR_MODEL_UNAVAILABLE', `ASR model directory does not exist: ${modelDir}`)
  }
  const target = resolve(file)
  let stat
  try { stat = statSync(target) } catch { throw fail('FILE_UNAVAILABLE', `media file does not exist or is unreadable: ${target}`) }
  if (!stat.isFile()) throw fail('FILE_UNAVAILABLE', `not a regular file: ${target}`)
  let hashStart
  try { hashStart = fileSha256(target) } catch (error) { throw fail('FILE_UNAVAILABLE', `cannot read media bytes: ${error.message}`) }

  let probe
  try {
    probe = run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', target], { maxBuffer: FFPROBE_MAX })
  } catch (error) {
    if (error.code === 'ENOENT') throw fail('FFPROBE_UNAVAILABLE', 'ffprobe is not installed or not on PATH')
    throw error
  }
  if (probe.status !== 0) throw fail('FFPROBE_FAILED', `ffprobe could not read the file: ${String(probe.stderr || '').slice(-1000)}`)
  let info
  try { info = JSON.parse(probe.stdout) } catch { throw fail('FFPROBE_FAILED', 'ffprobe output was not valid JSON') }

  const subject = subjectOf(target, info, hashStart, stat.size)
  const fps = parseFps(subject.video?.r_frame_rate)
  const declared = subject.video?.nb_frames ?? null

  let decode = { status: 'unknown', mode: 'not_run', exit_code: null, error: null, note: 'scanAll was not requested; no decode was run.' }
  let scanFrames = null
  let metrics = null
  let coverageScope = ['container_metadata']
  if (scanAll) {
    const scan = decodeScan(target, subject.video)
    decode = scan.decode
    scanFrames = scan.frames
    metrics = scan.metrics
    coverageScope = scan.coverageScope
  }

  const decoded = scanFrames ? scanFrames.decoded : null
  const { frames, coverage } = coverageOf({ scanAll, decoded, declared, expectedFrames, decodeStatus: decode.status })
  coverage.scope = coverageScope
  const duration = durationOf(subject.duration_sec, expectedDuration, fps)

  let asr = null
  if (asrModel) {
    asr = runAsr({ file: target, hash: hashStart, asrPython, asrModel, expectedText, language })
  }

  let hashEnd
  try { hashEnd = fileSha256(target) } catch { throw fail('SOURCE_CHANGED_DURING_INSPECTION', 'the media file disappeared during inspection') }
  if (hashEnd !== hashStart) throw fail('SOURCE_CHANGED_DURING_INSPECTION', 'the media bytes changed while being inspected; evidence is not bound to one source')

  const verdict = defaultVerdict({
    decodeStatus: decode.status, coverage, metrics, asr,
    durationStatus: duration.status, expectedFrames, expectedDuration,
  })

  return {
    schema: EVIDENCE_SCHEMA,
    source_sha256: hashStart,
    subject,
    machine: {
      decode,
      frames,
      coverage,
      duration,
      metrics,
      asr,
      verdict,
    },
    declared: null,
    content_approval: 'not_asserted',
    limits: LIMITS,
  }
}
