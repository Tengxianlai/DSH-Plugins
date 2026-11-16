import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectMedia, EVIDENCE_SCHEMA, ASR_SCHEMA } from '../local-qa.js'

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-local-qa-test-'))
after(() => rmSync(ROOT, { recursive: true, force: true }))

const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
const haveFfmpeg = probe.status === 0
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `ffmpeg failed: ${result.stderr}`)
}

let cache = null
function fixtures() {
  if (cache) return cache
  const file = name => join(ROOT, name)
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file('moving.mp4')])
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file('black.mp4')])
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=24:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file('static.mp4')])
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file('silent.mp4')])
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file('long.mp4')])
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mpegts', file('stream.ts')])
  const faststart = readFileSync(file('long.mp4'))
  writeFileSync(file('truncated.mp4'), faststart.subarray(0, Math.floor(faststart.length * 0.7)))
  cache = { moving: file('moving.mp4'), black: file('black.mp4'), static: file('static.mp4'), silent: file('silent.mp4'), truncated: file('truncated.mp4'), stream: file('stream.ts') }
  return cache
}

function fakeAsr(name, { sha = 'correct', exit = 0 } = {}) {
  const path = join(ROOT, name)
  const body = `#!/usr/bin/env node
const i = process.argv.indexOf('--expect-sha256');
const reported = ${JSON.stringify(sha)} === 'correct' ? (i >= 0 ? process.argv[i + 1] : '0'.repeat(64)) : '0'.repeat(64);
if (${exit} !== 0) { process.stderr.write('fake asr failure'); process.exit(${exit}) }
process.stdout.write(JSON.stringify({ schema: '${ASR_SCHEMA}', status: 'transcribed', source: { sha256: reported }, text: '测试', language: 'zh', duration: 1, segments: [], model: { path: 'fake', fingerprint: { sha256: 'f'.repeat(64) } }, warnings: [], limits: ['fake asr'] }))
`
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

const FAKE_MODEL = join(ROOT, 'fake-model')
mkdirSync(FAKE_MODEL, { recursive: true })
writeFileSync(join(FAKE_MODEL, 'config.json'), '{}')

test('schema and hash invariants for a normal clip', { skip: !haveFfmpeg }, () => {
  const { moving } = fixtures()
  const report = inspectMedia({ file: moving, scanAll: true, expectedFrames: 24 })
  assert.equal(report.schema, EVIDENCE_SCHEMA)
  assert.equal(report.content_approval, 'not_asserted')
  assert.equal(report.declared, null)
  assert.equal(report.source_sha256, report.subject.source.sha256)
  assert.match(report.source_sha256, /^[a-f0-9]{64}$/)
  assert.equal(report.machine.decode.status, 'pass')
  assert.equal(report.machine.frames.decoded, 24)
  assert.equal(report.machine.coverage.status, 'verified')
  assert.equal(report.machine.coverage.complete, true)
  assert.equal(report.machine.verdict, 'pass')
  assert.equal(report.machine.asr, null)
})

test('container-declared frames verify coverage but are marked as container metadata', { skip: !haveFfmpeg }, () => {
  const { moving } = fixtures()
  const report = inspectMedia({ file: moving, scanAll: true })
  assert.equal(report.machine.frames.expected_source, 'container')
  assert.equal(report.machine.coverage.status, 'verified')
  assert.match(report.machine.coverage.note, /container/i)
})

test('a black clip passes decode but stays review_required with content unasserted', { skip: !haveFfmpeg }, () => {
  const { black } = fixtures()
  const report = inspectMedia({ file: black, scanAll: true, expectedFrames: 24 })
  assert.equal(report.machine.decode.status, 'pass')
  assert.ok(report.machine.metrics.near_black_frame_count > 0)
  assert.ok(report.machine.metrics.suspicion.includes('near_black_frames'))
  assert.equal(report.machine.verdict, 'review_required')
  assert.equal(report.content_approval, 'not_asserted')
})

test('a static clip is suspected as static without claiming what it shows', { skip: !haveFfmpeg }, () => {
  const { static: still } = fixtures()
  const report = inspectMedia({ file: still, scanAll: true, expectedFrames: 24 })
  assert.ok(report.machine.metrics.ydif.available)
  assert.ok(report.machine.metrics.suspicion.includes('static_clip'))
  assert.equal(report.machine.verdict, 'review_required')
})

test('a clip without an audio stream still reports video evidence', { skip: !haveFfmpeg }, () => {
  const { static: still } = fixtures()
  const report = inspectMedia({ file: still, scanAll: true, expectedFrames: 24 })
  assert.equal(report.subject.audio, null)
  assert.ok(report.subject.streams.every(stream => stream.type !== 'audio'))
})

test('a container without nb_frames never claims original completeness', { skip: !haveFfmpeg }, () => {
  const { stream } = fixtures()
  const report = inspectMedia({ file: stream, scanAll: true })
  assert.equal(report.machine.frames.declared, null)
  assert.equal(report.machine.coverage.status, 'unknown')
  assert.equal(report.machine.coverage.complete, null)
  assert.match(report.machine.coverage.note, /trusted expected frame count|does not prove/i)
  assert.equal(report.machine.verdict, 'review_required')
})

test('scanAll=false never claims decode or completeness', { skip: !haveFfmpeg }, () => {
  const { moving } = fixtures()
  const report = inspectMedia({ file: moving })
  assert.equal(report.machine.decode.status, 'unknown')
  assert.equal(report.machine.decode.mode, 'not_run')
  assert.equal(report.machine.metrics, null)
  assert.equal(report.machine.coverage.status, 'unknown')
  assert.equal(report.machine.coverage.complete, null)
  assert.equal(report.machine.frames.decoded, null)
  assert.equal(report.machine.frames.declared, 24)
  assert.equal(report.machine.verdict, 'unknown')
})

test('caller frame expectation drives completeness and can fail', { skip: !haveFfmpeg }, () => {
  const { moving } = fixtures()
  const report = inspectMedia({ file: moving, scanAll: true, expectedFrames: 25 })
  assert.equal(report.machine.coverage.status, 'mismatch')
  assert.equal(report.machine.frames.expected_source, 'caller')
  assert.equal(report.machine.frames.shortfall, 1)
  assert.equal(report.machine.verdict, 'fail')
})

test('caller duration expectation drives the duration verdict', { skip: !haveFfmpeg }, () => {
  const { moving } = fixtures()
  const report = inspectMedia({ file: moving, scanAll: true, expectedDuration: 5 })
  assert.equal(report.machine.duration.status, 'mismatch')
  assert.equal(report.machine.verdict, 'fail')
})

test('a truncated file is reported as fail or unreadable, never as pass', { skip: !haveFfmpeg }, () => {
  const { truncated } = fixtures()
  let report = null
  try {
    report = inspectMedia({ file: truncated, scanAll: true })
  } catch (error) {
    assert.ok(['FFPROBE_FAILED', 'FILE_UNAVAILABLE'].includes(error.code), `unexpected error code ${error.code}`)
    return
  }
  assert.notEqual(report.machine.verdict, 'pass')
  if (report.machine.decode.status === 'fail') assert.equal(report.machine.verdict, 'fail')
})

test('invalid options and missing files raise coded errors', () => {
  assert.throws(() => inspectMedia({ file: join(ROOT, 'missing.mp4') }), error => error.code === 'FILE_UNAVAILABLE')
  assert.throws(() => inspectMedia({ file: 'x' , expectedFrames: 0 }), error => error.code === 'INVALID_OPTIONS')
  assert.throws(() => inspectMedia({ file: 'x', expectedDuration: -1 }), error => error.code === 'INVALID_OPTIONS')
  assert.throws(() => inspectMedia({ file: 'x', asrPython: 'python3' }), error => error.code === 'INVALID_OPTIONS')
  assert.throws(() => inspectMedia({ file: 'x', asrModel: join(ROOT, 'no-model') }), error => error.code === 'ASR_MODEL_UNAVAILABLE')
})

test('fake ASR with a different source hash is rejected, not merged', { skip: !haveFfmpeg }, () => {
  const { moving } = fixtures()
  assert.throws(() => inspectMedia({ file: moving, asrPython: fakeAsr('asr-wrong-hash.js', { sha: 'wrong' }), asrModel: FAKE_MODEL }),
    error => error.code === 'ASR_SOURCE_HASH_MISMATCH')
})

test('fake ASR that exits non-zero is kept as partial evidence, not a pass', { skip: !haveFfmpeg }, () => {
  const { moving } = fixtures()
  const report = inspectMedia({ file: moving, scanAll: true, expectedFrames: 24, asrPython: fakeAsr('asr-exit.js', { exit: 1 }), asrModel: FAKE_MODEL })
  assert.equal(report.machine.asr.status, 'error')
  assert.equal(report.machine.asr.error.code, 'ASR_EXIT')
  assert.equal(report.machine.verdict, 'review_required')
})

test('fake ASR output with a matching hash is passed through and bound', { skip: !haveFfmpeg }, () => {
  const { moving } = fixtures()
  const report = inspectMedia({ file: moving, scanAll: true, expectedFrames: 24, asrPython: fakeAsr('asr-ok.js'), asrModel: FAKE_MODEL })
  assert.equal(report.machine.asr.schema, ASR_SCHEMA)
  assert.equal(report.machine.asr.status, 'transcribed')
  assert.equal(report.machine.asr.source_sha256, report.source_sha256)
  assert.equal(report.machine.verdict, 'pass')
})

// ASR integration against the two real, short, already-local TanLu clips.
// Enabled only when the operator supplies the local ASR environment; no download.
const ASR_ENV = {
  python: process.env.DSH_ASR_PYTHON,
  model: process.env.DSH_ASR_MODEL,
  clipA: process.env.DSH_ASR_CLIP_A,
  clipB: process.env.DSH_ASR_CLIP_B,
}
const haveAsr = Boolean(ASR_ENV.python && ASR_ENV.model && ASR_ENV.clipA && ASR_ENV.clipB)

test('real local ASR binds source hash and reports words on two existing clips', { skip: !haveAsr }, () => {
  for (const [clip, expectedText] of [[ASR_ENV.clipA, '白霜是渗水带出来的钙'], [ASR_ENV.clipB, '老师，结晶面太糙，负压腔漏气，往上滑了！']]) {
    const report = inspectMedia({ file: clip, asrPython: ASR_ENV.python, asrModel: ASR_ENV.model, expectedText, language: 'zh' })
    assert.equal(report.machine.asr.source_sha256, report.source_sha256)
    assert.match(report.machine.asr.model.fingerprint.sha256, /^[a-f0-9]{64}$/)
    assert.ok(report.machine.asr.text.length > 0)
    assert.ok(report.machine.asr.segments.length > 0)
    assert.ok(['mismatch', 'match', 'transcribed'].includes(report.machine.asr.status), report.machine.asr.status)
    assert.notEqual(report.machine.verdict, 'pass', 'ASR-only inspection must not claim video completeness')
  }
})

test('real local ASR on silence does not force a transcript match', { skip: !haveAsr || !haveFfmpeg }, () => {
  const { silent } = fixtures()
  const report = inspectMedia({ file: silent, asrPython: ASR_ENV.python, asrModel: ASR_ENV.model, expectedText: '不该出现的话', language: 'zh' })
  assert.ok(['no_speech_detected', 'silence_suspected', 'review_required'].includes(report.machine.asr.status), report.machine.asr.status)
  assert.notEqual(report.machine.asr.normalized_text_match, true)
  assert.notEqual(report.machine.verdict, 'pass')
})
