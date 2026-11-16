import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  ORIGINS,
  PROJECT_SCHEMA,
  fileSha256,
  publicSource,
  validateProductionInputs,
} from '../project.js'
import { resolveAsrRuntime, toolchainCandidates } from '../cli.mjs'
import { validateRegenSourceSpec } from '../schema/validate.js'

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const REVIEW_SCHEMA = 'dsh.ai-video-review/1'

function tempRoot(t, prefix = 'dsh-production-') {
  const root = mkdtempSync(resolve(tmpdir(), prefix))
  const intended = realpathSync(root)
  t.after(() => {
    assert.equal(realpathSync(root), intended)
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(resolve(root, '.ai-video'))
  mkdirSync(resolve(root, 'assets'))
  return root
}

function writeAsset(root, id, body, extension = 'png') {
  const path = `assets/${id}.${extension}`
  writeFileSync(resolve(root, path), body)
  return { path, sha256: fileSha256(resolve(root, path)) }
}

function fixture(t, { budget = true, dialogue = '白霜是渗水带出来的钙。' } = {}) {
  const root = tempRoot(t)
  const hero = writeAsset(root, 'hero', 'hero-bytes')
  const site = writeAsset(root, 'site', 'site-bytes')
  const key = writeAsset(root, 'key', 'key-bytes')
  const altkey = writeAsset(root, 'altkey', 'alt-key-bytes')
  const capture = writeAsset(root, 'capture', 'capture-bytes')
  const voice = writeAsset(root, 'voice', 'voice-bytes', 'wav')
  const assets = [
    { id: 'HERO', kind: 'character', path: hero.path, sha256: hero.sha256, approval: 'user_approved', approval_evidence: 'declared fixture approval', origin: 'user_supplied', root_ids: [], authority: 'declared' },
    { id: 'SITE', kind: 'scene', path: site.path, sha256: site.sha256, approval: 'user_approved', approval_evidence: 'declared fixture approval', origin: 'user_supplied', root_ids: [], authority: 'declared' },
    { id: 'K1', kind: 'keyframe', path: key.path, sha256: key.sha256, approval: 'director_approved', approval_evidence: 'declared fixture approval', origin: 'generated_original', root_ids: ['HERO', 'SITE'], shot_id: 'S1', authority: 'declared' },
    { id: 'ALT', kind: 'keyframe', path: altkey.path, sha256: altkey.sha256, approval: 'director_approved', approval_evidence: 'declared fixture approval', origin: 'generated_original', root_ids: ['HERO', 'SITE'], shot_id: 'S1', authority: 'declared' },
    { id: 'CAP', kind: 'keyframe', path: capture.path, sha256: capture.sha256, approval: 'director_approved', approval_evidence: 'declared fixture approval', origin: 'video_frame', root_ids: ['HERO', 'SITE'], shot_id: 'S1', authority: 'declared' },
    { id: 'VOICE', kind: 'audio', path: voice.path, sha256: voice.sha256, approval: 'user_approved', approval_evidence: 'declared fixture approval', origin: 'user_supplied', root_ids: [], authority: 'declared' },
  ]
  const data = {
    schema: PROJECT_SCHEMA,
    project_id: 'fixture',
    project_root: '..',
    budget: budget ? { id: 'approved-batch', limit: 2, currency: 'CNY', authority: 'declared', declared_not_independently_verified: true } : null,
    policy: { require_budget: true, allow_external_assets: false, archived_sources: 'warn', regeneration_requires_qc: ['frame_scan', 'motion_review'] },
    assets,
    shots: [{ id: 'S1', characters: ['HERO'], scenes: ['SITE'], keyframes: ['K1', 'ALT'], voice_refs: [], dialogue: [{ speaker: 'hero', line: dialogue }] }],
  }
  const file = resolve(root, '.ai-video/project.json')
  const save = (next = data) => writeFileSync(file, JSON.stringify(next))
  save()
  const check = (args, extra = {}) => validateProductionInputs({ cwd: root, args, ...extra })
  const run = (args) => spawnSync(process.execPath, [CLI, ...args, '--root', root], { cwd: root, encoding: 'utf8' })
  const runJson = (args) => {
    const result = run(args)
    let json
    try {
      json = JSON.parse(result.stdout)
    } catch {
      json = undefined
    }
    return { status: result.status, json, stdout: result.stdout, stderr: result.stderr }
  }
  return { root, data, file, save, check, run, runJson, assets }
}

const codes = (result) => (result.issues ?? []).map((issue) => issue.code)
const warningCodes = (result) => (result.warnings ?? []).map((warning) => warning.code)

function makeH3Source(t, root) {
  const media = resolve(root, 'assets/source.mp4')
  const generated = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=1344x768:r=24:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-frames:v', '124',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', media,
  ], { encoding: 'utf8' })
  if (generated.error?.code === 'ENOENT') return null
  assert.equal(generated.status, 0, generated.stderr)
  return media
}

test('fileSha256 streams the same digest as a whole-file hash; publicSource redacts URL paths', async (t) => {
  const root = tempRoot(t)
  const file = resolve(root, 'large.bin')
  writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 17, 7))
  const { createHash } = await import('node:crypto')
  const expected = createHash('sha256').update(readFileSync(file)).digest('hex')
  assert.equal(fileSha256(file), expected)
  const redacted = publicSource('https://user:pass@example.org/signed/SECRET/clip.mp4?token=abc#frag')
  assert.match(redacted, /^https:\/\/example\.org\/\[path sha256:[a-f0-9]{16}\]$/)
  assert.ok(!redacted.includes('SECRET'))
  assert.ok(!redacted.includes('token'))
  assert.equal(publicSource('relative/local.png'), 'relative/local.png')
})

test('approved keyframe inherits verified character and scene roots', (t) => {
  const f = fixture(t)
  const result = f.check({
    shot_id: 'S1',
    prompt: 'hero says: 白霜是渗水带出来的钙。',
    first_frame: 'assets/key.png',
    asset_ids: { first_frame: 'K1' },
  })
  assert.deepEqual(codes(result), [])
  assert.deepEqual(result.coverage.inherited_root_ids.sort(), ['HERO', 'SITE'])
  assert.equal(result.coverage.visual_semantics_verified, false)
  assert.equal(result.coverage.authority, 'declared')
  assert.equal(result.coverage.content_approval, 'not_asserted')
})

test('same bytes are ambiguous without asset_ids and bind when declared', (t) => {
  const f = fixture(t)
  const dupA = writeAsset(f.root, 'dupA', 'same-bytes')
  const dupB = writeAsset(f.root, 'dupB', 'same-bytes')
  f.data.assets.push(
    { id: 'DUP_A', kind: 'character', path: dupA.path, sha256: dupA.sha256, approval: 'user_approved', approval_evidence: 'declared', origin: 'user_supplied', root_ids: [] },
    { id: 'DUP_B', kind: 'character', path: dupB.path, sha256: dupB.sha256, approval: 'user_approved', approval_evidence: 'declared', origin: 'user_supplied', root_ids: [] },
  )
  f.save()
  const ambiguous = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/dupA.png' })
  assert.ok(codes(ambiguous).includes('AMBIGUOUS_ASSET_HASH'))
  const bound = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/dupA.png', asset_ids: { first_frame: 'DUP_A' } })
  assert.ok(!codes(bound).includes('AMBIGUOUS_ASSET_HASH'))
  const kindMismatch = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/dupA.png', asset_ids: { first_frame: 'VOICE' } })
  assert.ok(codes(kindMismatch).includes('DECLARED_ASSET_KIND'))
  const withoutMedia = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', asset_ids: { first_frame: 'K1' } })
  assert.ok(codes(withoutMedia).includes('ASSET_ID_WITHOUT_MEDIA'))
  const countMismatch = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/key.png', reference_images: ['assets/key.png'], asset_ids: { first_frame: 'K1', reference_images: [] } })
  assert.ok(codes(countMismatch).includes('ASSET_ID_COUNT_MISMATCH'))
})

test('native full-field asset_ids with unused blank slots binds like a sparse valid map', (t) => {
  const f = fixture(t)
  const base = {
    shot_id: 'S1',
    prompt: 'hero says: 白霜是渗水带出来的钙。',
    first_frame: 'assets/key.png',
  }
  const denseIds = {
    first_frame: 'K1',
    last_frame: '',
    base_video: null,
    reference_images: [],
    reference_videos: null,
    reference_audio: [],
  }
  const sparse = f.check({ ...base, asset_ids: { first_frame: 'K1' } })
  const dense = f.check({ ...base, asset_ids: denseIds })
  assert.deepEqual(codes(sparse), [])
  assert.deepEqual(codes(dense), codes(sparse))
  assert.deepEqual(dense.assets.map((asset) => asset.id), sparse.assets.map((asset) => asset.id))
  assert.deepEqual(dense.coverage.used_asset_ids, sparse.coverage.used_asset_ids)
  assert.deepEqual(dense.coverage.inherited_root_ids, sparse.coverage.inherited_root_ids)

  const usedBlank = f.check({ ...base, asset_ids: { first_frame: '' } })
  assert.ok(codes(usedBlank).includes('INVALID_ASSET_ID'))

  const idWithoutMedia = f.check({
    shot_id: 'S1',
    prompt: 'hero says: 白霜是渗水带出来的钙。',
    asset_ids: { last_frame: 'K1' },
  })
  assert.ok(codes(idWithoutMedia).includes('ASSET_ID_WITHOUT_MEDIA'))

  const countMismatch = f.check({
    ...base,
    reference_images: ['assets/key.png'],
    asset_ids: { first_frame: 'K1', reference_images: [] },
  })
  assert.ok(codes(countMismatch).includes('ASSET_ID_COUNT_MISMATCH'))

  const blankEntry = f.check({
    ...base,
    reference_images: ['assets/key.png'],
    asset_ids: { first_frame: 'K1', reference_images: [''] },
  })
  assert.ok(codes(blankEntry).includes('INVALID_ASSET_ID_LIST'))
  assert.ok(!codes(blankEntry).includes('ASSET_ID_COUNT_MISMATCH'), 'blank entries must not be filtered into a shift')

  const requestFile = resolve(f.root, 'dense-request.json')
  writeFileSync(requestFile, JSON.stringify({ args: { ...base, asset_ids: denseIds } }))
  const cli = f.runJson(['check', '--request', requestFile])
  assert.equal(cli.status, 0, cli.stderr)
  assert.deepEqual(cli.json.issues, [])
  assert.deepEqual(cli.json.assets.map((asset) => asset.id), sparse.assets.map((asset) => asset.id))
})

test('unregistered, candidate and changed roots cannot silently enter generation', (t) => {
  const f = fixture(t)
  writeAsset(f.root, 'unseen', 'unseen-bytes')
  assert.ok(codes(f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/unseen.png' })).includes('UNREGISTERED_SOURCE'))
  f.data.assets.find((asset) => asset.id === 'K1').approval = 'candidate'
  f.save()
  assert.ok(codes(f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/key.png' })).includes('WRONG_SOURCE_STATE_OR_KIND'))
})

test('cross-shot assets and keyframes are refused; same-shot alternates are bound', (t) => {
  const f = fixture(t)
  const foreign = writeAsset(f.root, 'foreign', 'foreign-bytes')
  f.data.assets.push({ id: 'FOREIGN', kind: 'image', path: foreign.path, sha256: foreign.sha256, approval: 'user_approved', approval_evidence: 'declared', origin: 'user_supplied', shot_id: 'S9', root_ids: [] })
  f.save()
  const crossShot = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/foreign.png', asset_ids: { first_frame: 'FOREIGN' } })
  assert.ok(codes(crossShot).includes('CROSS_SHOT_ASSET'))
  const unlisted = { ...f.data.assets.find((asset) => asset.id === 'CAP'), id: 'UNLISTED', path: foreign.path, sha256: foreign.sha256, shot_id: undefined, origin: 'video_frame' }
  f.data.assets.push(unlisted)
  f.save()
  const unlistedResult = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/foreign.png', asset_ids: { first_frame: 'UNLISTED' } })
  assert.ok(codes(unlistedResult).includes('KEYFRAME_NOT_IN_SHOT'))
})

test('keyframe role is slot-bound: screenshots need a reason, not just an ancillary keyframe', (t) => {
  const f = fixture(t)
  const bypass = f.check({
    shot_id: 'S1',
    prompt: '白霜是渗水带出来的钙。',
    first_frame: 'assets/capture.png',
    reference_images: ['assets/key.png'],
    asset_ids: { first_frame: 'CAP', reference_images: ['K1'] },
  })
  assert.ok(codes(bypass).includes('APPROVED_KEYFRAME_NOT_USED'))
  assert.ok(codes(bypass).includes('FRAME_CAPTURE_NEEDS_REASON'))
  const declared = f.check({
    shot_id: 'S1',
    prompt: '白霜是渗水带出来的钙。',
    first_frame: 'assets/capture.png',
    reference_images: ['assets/key.png'],
    asset_ids: { first_frame: 'CAP', reference_images: ['K1'] },
    keyframe_override_reason: '交接续拍一致',
  })
  assert.deepEqual(codes(declared), [])
  assert.ok(warningCodes(declared).includes('KEYFRAME_OVERRIDE_DECLARED'))
})

test('dialogue must be in the prompt; punctuation/whitespace differences only warn', (t) => {
  const f = fixture(t)
  const exact = f.check({ shot_id: 'S1', prompt: 'hero says: 白霜是渗水带出来的钙。', first_frame: 'assets/key.png', asset_ids: { first_frame: 'K1' } })
  assert.deepEqual(codes(exact), [])
  const punctuation = f.check({ shot_id: 'S1', prompt: 'hero says: 白霜是渗水带出来的钙', first_frame: 'assets/key.png', asset_ids: { first_frame: 'K1' } })
  assert.deepEqual(codes(punctuation), [])
  assert.ok(warningCodes(punctuation).includes('DIALOGUE_PUNCTUATION_DIFFERS'))
  const missing = f.check({ shot_id: 'S1', prompt: 'completely different words', first_frame: 'assets/key.png', asset_ids: { first_frame: 'K1' }, dialogue: [{ speaker: 'hero', line: '白霜是渗水带出来的钙。' }] })
  assert.ok(codes(missing).includes('APPROVED_DIALOGUE_MISSING'))
})

test('registered roots stop text-only requests and a voice reference cannot replace the prompt line', (t) => {
  const f = fixture(t)
  const textOnly = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。' })
  assert.ok(codes(textOnly).includes('MISSING_VISUAL_REFERENCE'))
  const voiceOnly = f.check({
    shot_id: 'S1',
    prompt: '仅用 Audio 1 提供声音，不写台词',
    reference_audio: ['assets/voice.wav'],
    dialogue: [{ speaker: 'hero', line: '白霜是渗水带出来的钙。' }],
  })
  assert.ok(codes(voiceOnly).includes('APPROVED_DIALOGUE_MISSING'))
})

test('shot selection, approval evidence and remote inputs are enforced', (t) => {
  const f = fixture(t)
  assert.ok(codes(f.check({ prompt: '白霜是渗水带出来的钙。' })).includes('SHOT_ID_REQUIRED'))
  assert.ok(codes(f.check({ shot_id: 'NOPE', prompt: '白霜是渗水带出来的钙。' })).includes('UNKNOWN_SHOT'))
  assert.ok(codes(f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'https://example.org/input.png?token=secret' })).includes('UNVERIFIED_INPUT'))
  delete f.data.assets.find((asset) => asset.id === 'K1').approval_evidence
  f.save()
  assert.ok(codes(f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/key.png', asset_ids: { first_frame: 'K1' } })).includes('UNPROVEN_APPROVAL'))
  const empty = mkdtempSync(resolve(tmpdir(), 'dsh-no-registry-'))
  t.after(() => rmSync(empty, { recursive: true, force: true }))
  const noProject = validateProductionInputs({ cwd: empty, args: {} })
  assert.equal(noProject.project, null)
  assert.ok(noProject.warnings.some((entry) => entry.code === 'NO_PROJECT_REGISTRY'))
})

test('origin is required for production assets and only known classifications pass', (t) => {
  const f = fixture(t)
  delete f.data.assets.find((asset) => asset.id === 'K1').origin
  f.save()
  const missing = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/key.png', asset_ids: { first_frame: 'K1' } })
  assert.ok(codes(missing).includes('ASSET_ORIGIN_REQUIRED'))
  const registered = f.runJson(['register', '--id', 'NOORIGIN', '--kind', 'image', '--file', 'assets/hero.png'])
  assert.notEqual(registered.status, 0)
  assert.match(registered.stderr, /--origin is required/)
  assert.deepEqual([...ORIGINS].sort(), ['derived_render', 'external_capture', 'generated_original', 'user_supplied', 'video_frame'])
})

test('budget is not skipped by --all; audit results stay separate', (t) => {
  const f = fixture(t, { budget: false })
  const args = { shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/key.png', asset_ids: { first_frame: 'K1' } }
  const normal = f.check(args)
  assert.ok(codes(normal).includes('PROJECT_BUDGET_REQUIRED'))
  const audited = f.check(args, { auditAll: true })
  assert.ok(codes(audited).includes('PROJECT_BUDGET_REQUIRED'))
  assert.ok(audited.audit !== null)
  // an unrelated approved asset drifting appears in the audit only
  const unused = writeAsset(f.root, 'unused', 'unused-bytes')
  f.data.assets.push({ id: 'UNUSED', kind: 'image', path: unused.path, sha256: unused.sha256, approval: 'user_approved', approval_evidence: 'declared', origin: 'user_supplied', root_ids: [] })
  f.data.budget = { id: 'b', limit: 1, currency: 'CNY', authority: 'declared' }
  f.save()
  writeFileSync(resolve(f.root, unused.path), 'drifted-bytes')
  const result = f.check(args, { auditAll: true })
  assert.deepEqual(codes(result), [])
  assert.ok((result.audit?.issues ?? []).map((issue) => issue.code).includes('ASSET_HASH_DRIFT'))
})

test('audit lineage never satisfies this request\'s required-root coverage', (t) => {
  const f = fixture(t)
  f.data.assets.find((asset) => asset.id === 'K1').root_ids = []
  f.save()
  const args = { shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/key.png', asset_ids: { first_frame: 'K1' } }
  const normal = f.check(args)
  assert.ok(codes(normal).includes('REQUIRED_ROOT_NOT_REUSED'))
  const audited = f.check(args, { auditAll: true })
  const auditRootErrors = codes(audited).filter((code) => code === 'REQUIRED_ROOT_NOT_REUSED')
  assert.ok(auditRootErrors.length >= 2, 'audit must not cover HERO/SITE for this request')
})

test('references binds current hashes and requires coverage; drift and archive policy are visible', (t) => {
  const f = fixture(t)
  const ok = f.runJson(['references', '--shot', 'S1', '--keyframe-id', 'K1', '--out', 'refs.json'])
  assert.equal(ok.status, 0, ok.stderr)
  const refs = JSON.parse(readFileSync(resolve(f.root, 'refs.json'), 'utf8'))
  assert.equal(refs.schema, 'dsh.ai-video-references/2')
  assert.equal(refs.mode, 'keyframe_derived')
  assert.ok(refs.references.some((entry) => entry.id === 'K1' && entry.required === true && entry.sha256_matches === true))
  assert.deepEqual(refs.required_root_ids.sort(), ['HERO', 'SITE'])
  assert.deepEqual(refs.coverage.required.sort(), ['HERO', 'SITE'])
  assert.ok(refs.coverage.covered.includes('HERO'))
  assert.ok(!refs.references.some((entry) => entry.id === 'VOICE'))

  const missingRoot = f.runJson(['references', '--shot', 'S1', '--out', 'refs-missing.json', '--ids', 'HERO'])
  assert.notEqual(missingRoot.status, 0)
  assert.match(missingRoot.stderr, /do not cover/)

  writeFileSync(resolve(f.root, 'assets/key.png'), 'drifted-key')
  const drift = f.runJson(['references', '--shot', 'S1', '--keyframe-id', 'K1', '--out', 'refs-drift.json'])
  assert.notEqual(drift.status, 0)
  assert.match(drift.stderr, /bytes changed before approval|bytes changed since approval/)
})

test('archived sources warn by default, reject by policy, and adoption overrides the old rejection', (t) => {
  const f = fixture(t)
  mkdirSync(resolve(f.root, '99_ARCHIVE'))
  writeFileSync(resolve(f.root, '99_ARCHIVE/old.png'), 'key-bytes')
  symlinkSync('../99_ARCHIVE/old.png', resolve(f.root, 'assets/archived.png'))
  f.data.assets[2].path = 'assets/archived.png'
  f.save()
  const heuristic = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/archived.png', asset_ids: { first_frame: 'K1' } })
  assert.deepEqual(codes(heuristic), [])
  assert.ok(warningCodes(heuristic).includes('ARCHIVE_PATH_HEURISTIC'))

  f.data.assets[2].archived = true
  f.data.policy = { ...f.data.policy, archived_sources: 'reject' }
  f.save()
  const rejected = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/archived.png', asset_ids: { first_frame: 'K1' } })
  assert.ok(codes(rejected).includes('ARCHIVED_SOURCE'))
  f.data.assets[2].archive_adoption = { decision: 'adopted', evidence: 'explicit later adoption' }
  f.save()
  const adopted = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/archived.png', asset_ids: { first_frame: 'K1' } })
  assert.ok(!codes(adopted).includes('ARCHIVED_SOURCE'))
  assert.ok(warningCodes(adopted).includes('ARCHIVE_ADOPTION_DECLARED'))
})

test('malformed request fields become issues, not TypeErrors', (t) => {
  const f = fixture(t)
  const badArray = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', reference_images: 'assets/key.png' })
  assert.ok(codes(badArray).includes('INVALID_SLOT_VALUE'))
  f.data.shots[0].dialogue = { speaker: 'hero' }
  f.save()
  const badShot = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。' })
  assert.ok(codes(badShot).includes('INVALID_SHOT_FIELD'))
  f.data.assets.push(null)
  f.save()
  const withNull = f.check({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。' }, { auditAll: true })
  assert.ok(Array.isArray(withNull.audit?.issues))
})

test('symlinked project roots resolve to the real root instead of looking external', (t) => {
  const f = fixture(t)
  const link = `${f.root}-link`
  symlinkSync(f.root, link)
  t.after(() => rmSync(link, { force: true }))
  const result = validateProductionInputs({ cwd: link, args: { shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/key.png', asset_ids: { first_frame: 'K1' } } })
  assert.ok(!codes(result).includes('EXTERNAL_ONLY_SOURCE'))
  assert.equal(result.project.root, realpathSync(f.root))
})

test('source_task_id in a registered project needs a bound local source and QC', (t) => {
  const f = fixture(t)
  const unbound = f.check({ shot_id: 'S1', source_task_id: '123' })
  assert.ok(codes(unbound).includes('SOURCE_TASK_ID_UNBOUND'))
  const bound = f.check({ shot_id: 'S1', source_task_id: '123', source_asset_id: 'K1' })
  assert.ok(codes(bound).includes('SOURCE_ASSET_KIND'))
})

test('CLI request envelope is unwrapped and provenance is not self-approved', (t) => {
  const f = fixture(t)
  writeFileSync(resolve(f.root, 'prompt.txt'), 'hero says: 白霜是渗水带出来的钙。')
  const request = f.runJson(['request', '--shot', 'S1', '--keyframe-id', 'K1', '--model', 'MiniMax-H3', '--duration', '5', '--prompt-file', 'prompt.txt', '--out', 'request.json'])
  assert.equal(request.status, 0, request.stderr)
  const envelope = JSON.parse(readFileSync(resolve(f.root, 'request.json'), 'utf8'))
  assert.equal(envelope.schema, 'dsh.ai-video-request/1')
  assert.equal(envelope.authority, 'declared')
  assert.deepEqual(envelope.args.asset_ids, { first_frame: 'K1' })
  assert.equal(envelope.args.approved_sources, undefined)
  assert.match(envelope.args.source_declarations[0], /K1/)
  const checked = f.runJson(['check', '--request', 'request.json'])
  assert.equal(checked.status, 0, checked.stderr)
  const maxCost = f.runJson(['request', '--shot', 'S1', '--keyframe-id', 'K1', '--model', 'MiniMax-H3', '--duration', '5', '--prompt-file', 'prompt.txt', '--out', 'bad.json', '--max-cost', 'abc'])
  assert.equal(maxCost.status, 2)
  assert.match(maxCost.stderr, /max-cost must be a finite number/)
  assert.equal(existsSync(resolve(f.root, 'bad.json')), false)
})

test('CLI parses --root=, rejects unknown flags/commands/duplicates, and help exits 0', (t) => {
  const f = fixture(t)
  const equals = spawnSync(process.execPath, [CLI, 'check', `--root=${f.root}`, '--request', 'missing.json'], { encoding: 'utf8' })
  assert.notEqual(equals.status, 0)
  const unknownFlag = f.runJson(['check', '--wat'])
  assert.equal(unknownFlag.status, 2)
  const unknownCommand = f.runJson(['chekc'])
  assert.equal(unknownCommand.status, 2)
  const duplicate = f.runJson(['check', '--all', '--all'])
  assert.equal(duplicate.status, 2)
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /references --shot/)
  writeFileSync(resolve(f.root, 'raw-request.json'), JSON.stringify({ shot_id: 'S1', prompt: '白霜是渗水带出来的钙。', first_frame: 'assets/key.png', asset_ids: { first_frame: 'K1' } }))
  const equalsValid = spawnSync(process.execPath, [CLI, 'check', `--root=${f.root}`, `--request=${resolve(f.root, 'raw-request.json')}`], { encoding: 'utf8' })
  assert.equal(equalsValid.status, 0, equalsValid.stderr)
  writeFileSync(resolve(f.root, 'manifest-a.json'), JSON.stringify({ project_manifest: 'a.json' }))
  const conflict = spawnSync(process.execPath, [CLI, 'check', '--root', f.root, '--request', 'manifest-a.json', '--manifest', 'b.json'], { encoding: 'utf8' })
  assert.notEqual(conflict.status, 0)
  assert.match(conflict.stderr, /conflicts with the request envelope project_manifest/)
})

test('dead project locks are reclaimed; a live lock still blocks updates', (t) => {
  const f = fixture(t)
  const lock = resolve(f.root, '.ai-video/.project.lock')
  writeFileSync(lock, JSON.stringify({ pid: 999999, token: 'dead', started_at: new Date().toISOString(), command: 'test' }))
  const recovered = f.runJson(['register', '--id', 'AFTER_DEAD', '--kind', 'image', '--file', 'assets/hero.png', '--origin', 'user_supplied'])
  assert.equal(recovered.status, 0, recovered.stderr)
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live', started_at: new Date().toISOString(), command: 'test' }))
  const blocked = f.runJson(['register', '--id', 'AFTER_LIVE', '--kind', 'image', '--file', 'assets/hero.png', '--origin', 'user_supplied'])
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /Another project update is in progress/)
})

test('approval accepts declared user/director/agent with authority and appends history', (t) => {
  const f = fixture(t)
  const registered = f.runJson(['register', '--id', 'NEW', '--kind', 'image', '--file', 'assets/hero.png', '--origin', 'user_supplied'])
  assert.equal(registered.status, 0, registered.stderr)
  const candidate = JSON.parse(readFileSync(f.file, 'utf8')).assets.find((entry) => entry.id === 'NEW')
  assert.equal(candidate.approval, 'candidate')
  const approved = f.runJson(['approve', '--id', 'NEW', '--by', 'agent', '--evidence', 'declared agent authorisation'])
  assert.equal(approved.status, 0, approved.stderr)
  const asset = JSON.parse(readFileSync(f.file, 'utf8')).assets.find((entry) => entry.id === 'NEW')
  assert.equal(asset.approval, 'agent_approved')
  assert.equal(asset.authority, 'declared')
  assert.equal(asset.approved_by, 'agent')
  const again = f.runJson(['approve', '--id', 'NEW', '--by', 'director', '--evidence', 'declared director authorisation'])
  assert.equal(again.status, 0, again.stderr)
  const current = JSON.parse(readFileSync(f.file, 'utf8')).assets.find((entry) => entry.id === 'NEW')
  assert.equal(current.approval_history.length, 1)
  const budget = f.runJson(['budget', '--id', 'declared-budget', '--limit', '3', '--evidence', 'declared user budget', '--amend', '--reason', 'declared test amendment'])
  assert.equal(budget.status, 0, budget.stderr)
  const budgetRecord = JSON.parse(readFileSync(f.file, 'utf8')).budget
  assert.equal(budgetRecord.authority, 'declared')
  assert.equal(budgetRecord.declared_not_independently_verified, true)
})

test('ASR runtime resolution: flags > env > toolchain file > project venv', (t) => {
  const root = tempRoot(t)
  const pythonFlag = resolve(root, 'flag-python')
  const modelFlag = resolve(root, 'flag-model')
  writeFileSync(pythonFlag, '#!/bin/sh\n'); mkdirSync(modelFlag)
  const envPython = resolve(root, 'env-python'); const envModel = resolve(root, 'env-model')
  writeFileSync(envPython, '#!/bin/sh\n'); mkdirSync(envModel)
  const tcPython = resolve(root, 'tc-python'); const tcModel = resolve(root, 'tc-model')
  writeFileSync(tcPython, '#!/bin/sh\n'); mkdirSync(tcModel)
  const home = resolve(root, 'home')
  mkdirSync(resolve(home, 'state/dsh-minimax-video'), { recursive: true })
  writeFileSync(resolve(home, 'state/dsh-minimax-video/toolchain.json'), JSON.stringify({ schema: 'dsh.ai-video-toolchain/1', asr_python: tcPython, asr_model: tcModel, network_policy: 'local_only_no_download' }))
  const env = { DSH_HOME: home }
  const fromToolchain = resolveAsrRuntime({ flags: { asr: true }, cwd: root, env })
  assert.equal(fromToolchain.asrPython, tcPython)
  assert.equal(fromToolchain.asrModel, tcModel)
  const fromEnv = resolveAsrRuntime({ flags: { asr: true }, cwd: root, env: { ...env, DSH_ASR_PYTHON: envPython, DSH_ASR_MODEL: envModel } })
  assert.equal(fromEnv.asrPython, envPython)
  const fromFlags = resolveAsrRuntime({ flags: { asr: true, 'asr-python': pythonFlag, 'asr-model': modelFlag }, cwd: root, env: { ...env, DSH_ASR_PYTHON: envPython, DSH_ASR_MODEL: envModel } })
  assert.equal(fromFlags.asrPython, pythonFlag)
  assert.equal(fromFlags.asrModel, modelFlag)
  // project-local venv fills the gaps when no shared toolchain exists
  const local = tempRoot(t, 'dsh-project-asr-')
  mkdirSync(resolve(local, '.work/models/faster-whisper-small'), { recursive: true })
  mkdirSync(resolve(local, '.work/asr-venv/bin'), { recursive: true })
  writeFileSync(resolve(local, '.work/asr-venv/bin/python'), '#!/bin/sh\n')
  const projectRuntime = resolveAsrRuntime({ flags: { asr: true }, cwd: local, env: {}, toolchain: null })
  assert.equal(projectRuntime.asrPython, resolve(local, '.work/asr-venv/bin/python'))
  assert.equal(projectRuntime.asrModel, resolve(local, '.work/models/faster-whisper-small'))
  assert.throws(() => resolveAsrRuntime({ flags: { asr: true }, cwd: root, env: {}, toolchain: null }), /no local Python runtime|no local faster-whisper model/)
  assert.equal(resolveAsrRuntime({ flags: {}, cwd: root, env: {} }), null)
  assert.deepEqual(toolchainCandidates({ DSH_HOME: '/x' }, '/home/u'), ['/x/state/dsh-minimax-video/toolchain.json', '/home/u/.dsh/state/dsh-minimax-video/toolchain.json'])
  assert.deepEqual(
    toolchainCandidates({ DSH_PROFILE_DIR: '/home/u/.dsh-wsl/profiles/web' }, '/home/u'),
    ['/home/u/.dsh-wsl/state/dsh-minimax-video/toolchain.json', '/home/u/.dsh/state/dsh-minimax-video/toolchain.json'],
  )
})

test('CLI inspect reports a clear ASR configuration error instead of downloading', (t) => {
  const f = fixture(t)
  const emptyHome = resolve(f.root, 'empty-home')
  mkdirSync(emptyHome)
  const result = spawnSync(process.execPath, [CLI, 'inspect', '--root', f.root, '--file', 'assets/hero.png', '--out', 'asr.json', '--asr'], {
    cwd: f.root,
    encoding: 'utf8',
    env: { ...process.env, HOME: emptyHome, DSH_HOME: emptyHome, DSH_PROFILE_DIR: '', DSH_ASR_PYTHON: '', DSH_ASR_MODEL: '' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no local Python runtime|no local faster-whisper model|does not exist/)
  assert.equal(existsSync(resolve(f.root, 'asr.json')), false)
})

test('inspect calls local-qa, keeps the evidence invariant, and writes once', (t) => {
  const f = fixture(t)
  const media = resolve(f.root, 'assets/source.mp4')
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=24:d=1', '-c:v', 'libx264', media], { encoding: 'utf8' })
  if (generated.error?.code === 'ENOENT') return t.skip('ffmpeg unavailable')
  assert.equal(generated.status, 0, generated.stderr)
  const inspected = f.runJson(['inspect', '--file', 'assets/source.mp4', '--out', 'evidence.json', '--scan-all'])
  assert.equal(inspected.status, 0, inspected.stderr)
  const report = JSON.parse(readFileSync(resolve(f.root, 'evidence.json'), 'utf8'))
  assert.equal(report.schema, 'dsh.ai-video-evidence/1')
  assert.equal(report.source_sha256, report.subject.source.sha256)
  assert.equal(report.source_sha256, fileSha256(media))
  assert.equal(report.content_approval, 'not_asserted')
  assert.equal(report.machine.verdict, 'pass')
  assert.equal(report.machine.asr, null, 'a configured toolchain alone must not trigger ASR')
  const again = f.runJson(['inspect', '--file', 'assets/source.mp4', '--out', 'evidence.json', '--scan-all'])
  assert.notEqual(again.status, 0)
  assert.match(again.stderr, /EEXIST/)
})


test('QC rejects fabricated/scope-less evidence, rejects mismatched ASR as a pass, and appends history', (t) => {
  const f = fixture(t)
  const media = resolve(f.root, 'assets/source.mp4')
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=24:d=2', '-c:v', 'libx264', media], { encoding: 'utf8' })
  if (generated.error?.code === 'ENOENT') return t.skip('ffmpeg unavailable')
  const evidence = f.runJson(['inspect', '--file', 'assets/source.mp4', '--out', 'frame.json', '--scan-all'])
  assert.equal(evidence.status, 0, evidence.stderr)
  const report = JSON.parse(readFileSync(resolve(f.root, 'frame.json'), 'utf8'))
  f.data.assets.push({ id: 'SRC', kind: 'video', path: 'assets/source.mp4', sha256: report.source_sha256, approval: 'user_approved', approval_evidence: 'declared', origin: 'derived_render', root_ids: ['K1'], shot_id: 'S1' })
  f.save()

  writeFileSync(resolve(f.root, 'fake.json'), JSON.stringify({ source_sha256: report.source_sha256, frame_scan: { status: 'pass' } }))
  const fake = f.runJson(['qc', '--id', 'SRC', '--kind', 'frame_scan', '--status', 'pass', '--evidence', 'fake.json', '--by', 'agent', '--note', 'ok'])
  assert.notEqual(fake.status, 0)
  assert.match(fake.stderr, /frame_scan evidence is not valid/)

  const pass = f.runJson(['qc', '--id', 'SRC', '--kind', 'frame_scan', '--status', 'pass', '--evidence', 'frame.json', '--by', 'agent', '--note', 'full scan'])
  assert.equal(pass.status, 0, pass.stderr)
  const secondPass = f.runJson(['qc', '--id', 'SRC', '--kind', 'frame_scan', '--status', 'pass', '--evidence', 'frame.json', '--by', 'agent', '--note', 'reconfirmed'])
  assert.equal(secondPass.status, 0, secondPass.stderr)
  let manifest = JSON.parse(readFileSync(f.file, 'utf8'))
  assert.equal(manifest.assets.find((asset) => asset.id === 'SRC').qc_history.length, 1)

  writeFileSync(resolve(f.root, 'motion.json'), JSON.stringify({ schema: REVIEW_SCHEMA, kind: 'motion_review', source_sha256: report.source_sha256, decision: 'accepted', scope: 'reviewed the whole clip motion', reviewer: 'agent A', authority: 'declared', content_approval: 'not_asserted' }))
  const motion = f.runJson(['qc', '--id', 'SRC', '--kind', 'motion_review', '--status', 'pass', '--evidence', 'motion.json', '--by', 'agent', '--note', 'motion reviewed'])
  assert.equal(motion.status, 0, motion.stderr)

  const asrReport = JSON.parse(JSON.stringify(report))
  asrReport.machine.asr = { schema: 'dsh.ai-video-local-asr/2', source_sha256: report.source_sha256, status: 'mismatch', normalized_text_match: false, text: '白霜是渗水带出来的盖' }
  writeFileSync(resolve(f.root, 'asr.json'), JSON.stringify(asrReport))
  const asrPass = f.runJson(['qc', '--id', 'SRC', '--kind', 'asr', '--status', 'pass', '--evidence', 'asr.json', '--by', 'agent', '--note', 'ok'])
  assert.notEqual(asrPass.status, 0)
  assert.match(asrPass.stderr, /ASR cannot be recorded as a machine pass/)
  const asrReview = f.runJson(['qc', '--id', 'SRC', '--kind', 'asr', '--status', 'review_required', '--evidence', 'asr.json', '--by', 'agent', '--note', 'homophone 钙/盖 accepted after listening'])
  assert.equal(asrReview.status, 0, asrReview.stderr)
  manifest = JSON.parse(readFileSync(f.file, 'utf8'))
  const asrRecord = manifest.assets.find((asset) => asset.id === 'SRC').qc.asr
  assert.equal(asrRecord.status, 'review_required')
  assert.equal(asrRecord.review.authority, 'declared')
  assert.equal(asrRecord.review.reviewer_decision, 'pending', 'review_required defaults to pending, not accepted')
})

test('black/static frames stay suspicion, while frame_scan only certifies decode and coverage', (t) => {
  const f = fixture(t)
  const black = resolve(f.root, 'assets/black.mp4')
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24:d=1', '-c:v', 'libx264', black], { encoding: 'utf8' })
  if (generated.error?.code === 'ENOENT') return t.skip('ffmpeg unavailable')
  assert.equal(generated.status, 0, generated.stderr)
  const inspected = f.runJson(['inspect', '--file', 'assets/black.mp4', '--out', 'black.json', '--scan-all'])
  assert.equal(inspected.status, 0, inspected.stderr)
  const report = JSON.parse(readFileSync(resolve(f.root, 'black.json'), 'utf8'))
  assert.equal(report.machine.verdict, 'review_required')
  assert.ok(report.machine.metrics.suspicion.includes('near_black_frames'))
  f.data.assets.push({ id: 'BLACK', kind: 'video', path: 'assets/black.mp4', sha256: report.source_sha256, approval: 'user_approved', approval_evidence: 'declared', origin: 'derived_render', root_ids: ['K1'], shot_id: 'S1' })
  f.save()
  const asPass = f.runJson(['qc', '--id', 'BLACK', '--kind', 'frame_scan', '--status', 'pass', '--evidence', 'black.json', '--by', 'agent', '--note', 'decode and coverage only'])
  assert.equal(asPass.status, 0, asPass.stderr)
  const record = JSON.parse(readFileSync(f.file, 'utf8')).assets.find((asset) => asset.id === 'BLACK').qc.frame_scan
  assert.equal(record.machine_pass_scope, 'decode_and_coverage')
})

test('source_task_id needs a task-id mapping and retained QC before it can bind a local source', (t) => {
  const f = fixture(t)
  const media = resolve(f.root, 'assets/source.mp4')
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=24:d=1', '-c:v', 'libx264', media], { encoding: 'utf8' })
  if (generated.error?.code === 'ENOENT') return t.skip('ffmpeg unavailable')
  const inspected = f.runJson(['inspect', '--file', 'assets/source.mp4', '--out', 'frame.json', '--scan-all'])
  assert.equal(inspected.status, 0, inspected.stderr)
  const report = JSON.parse(readFileSync(resolve(f.root, 'frame.json'), 'utf8'))
  f.data.assets.push({ id: 'SRC', kind: 'video', path: 'assets/source.mp4', sha256: report.source_sha256, approval: 'user_approved', approval_evidence: 'declared', origin: 'derived_render', root_ids: ['K1'], shot_id: 'S1' })
  f.save()
  writeFileSync(resolve(f.root, 'task.json'), JSON.stringify({ shot_id: 'S1', source_task_id: '123', source_asset_id: 'SRC' }))
  const unmapped = f.runJson(['check', '--request', 'task.json'])
  assert.equal(unmapped.status, 2)
  const unmappedCodes = (unmapped.json?.issues ?? []).map((issue) => issue.code)
  assert.ok(unmappedCodes.includes('SOURCE_TASK_ID_UNMAPPED'))
  assert.ok((unmapped.json?.issues ?? []).some((issue) => issue.code === 'SOURCE_TASK_ID_UNMAPPED' && /video mode/i.test(issue.message)))

  f.data.assets.find((asset) => asset.id === 'SRC').task_id = '999'
  f.save()
  const mismatch = f.runJson(['check', '--request', 'task.json'])
  const mismatchCodes = (mismatch.json?.issues ?? []).map((issue) => issue.code)
  assert.ok(mismatchCodes.includes('SOURCE_TASK_ID_MISMATCH'))

  f.data.assets.find((asset) => asset.id === 'SRC').task_id = '123'
  f.save()
  const noQc = f.runJson(['check', '--request', 'task.json'])
  assert.ok((noQc.json?.issues ?? []).map((issue) => issue.code).includes('SOURCE_QC_MISSING'))
})

test('schema files are valid JSON and match the validator constants', () => {
  for (const name of ['project', 'qc', 'references', 'request', 'evidence', 'review']) {
    const file = resolve(dirname(fileURLToPath(new URL('../schema/validate.js', import.meta.url))), `${name}.schema.json`)
    const schema = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(schema.type, 'object')
    assert.equal(typeof schema.$id, 'string')
    assert.ok(Object.keys(schema.properties ?? {}).length > 0)
  }
})

test('2K regeneration binds accepted evidence and the H3 physical source spec', (t) => {
  const f = fixture(t)
  const media = makeH3Source(t, f.root)
  if (media === null) return t.skip('ffmpeg unavailable')
  const evidence = f.runJson(['inspect', '--file', 'assets/source.mp4', '--out', 'frame.json', '--scan-all'])
  assert.equal(evidence.status, 0, evidence.stderr)
  const report = JSON.parse(readFileSync(resolve(f.root, 'frame.json'), 'utf8'))
  assert.equal(report.subject.video.width, 1344)
  assert.equal(report.subject.video.height, 768)
  assert.equal(report.subject.video.nb_frames, 124)
  f.data.assets.push({ id: 'SRC', kind: 'video', path: 'assets/source.mp4', sha256: report.source_sha256, approval: 'user_approved', approval_evidence: 'declared', origin: 'derived_render', root_ids: ['K1'], shot_id: 'S1', task_id: '123', provenance: { task_id: '123' } })
  f.save()

  // The same report is deliberately review_required because of an ASR mismatch;
  // frame_scan must still certify decode + verified coverage.
  const asrReport = JSON.parse(JSON.stringify(report))
  asrReport.machine.asr = { schema: 'dsh.ai-video-local-asr/2', source_sha256: report.source_sha256, status: 'mismatch', normalized_text_match: false, text: '白霜是渗水带出来的盖' }
  asrReport.machine.verdict = 'review_required'
  writeFileSync(resolve(f.root, 'asr.json'), JSON.stringify(asrReport))
  const framePass = f.runJson(['qc', '--id', 'SRC', '--kind', 'frame_scan', '--status', 'pass', '--evidence', 'asr.json', '--by', 'agent', '--note', 'decode and coverage only'])
  assert.equal(framePass.status, 0, framePass.stderr)
  let manifest = JSON.parse(readFileSync(f.file, 'utf8'))
  assert.equal(manifest.assets.find((asset) => asset.id === 'SRC').qc.frame_scan.machine_pass_scope, 'decode_and_coverage')

  writeFileSync(resolve(f.root, 'motion.json'), JSON.stringify({ schema: REVIEW_SCHEMA, kind: 'motion_review', source_sha256: report.source_sha256, decision: 'accepted', scope: 'whole clip motion', reviewer: 'agent A', authority: 'declared', content_approval: 'not_asserted' }))
  assert.equal(f.runJson(['qc', '--id', 'SRC', '--kind', 'motion_review', '--status', 'pass', '--evidence', 'motion.json', '--by', 'agent', '--note', 'motion accepted']).status, 0)

  const pending = f.runJson(['qc', '--id', 'SRC', '--kind', 'asr', '--status', 'review_required', '--evidence', 'asr.json', '--by', 'agent', '--note', 'homophone needs confirmation'])
  assert.equal(pending.status, 0, pending.stderr)
  writeFileSync(resolve(f.root, 'regen.json'), JSON.stringify({ shot_id: 'S1', video: 'assets/source.mp4', prompt: '白霜是渗水带出来的钙。', asset_ids: { base_video: 'SRC' } }))
  const pendingCheck = f.runJson(['check', '--request', 'regen.json'])
  assert.equal(pendingCheck.status, 2)
  assert.ok((pendingCheck.json?.issues ?? []).map((issue) => issue.code).includes('ASR_REVIEW_NOT_ACCEPTED'))

  const rejected = f.runJson(['qc', '--id', 'SRC', '--kind', 'asr', '--status', 'review_required', '--evidence', 'asr.json', '--by', 'agent', '--note', 'homophone rejected', '--review-decision', 'rejected'])
  assert.equal(rejected.status, 0, rejected.stderr)
  const rejectedCheck = f.runJson(['check', '--request', 'regen.json'])
  assert.ok((rejectedCheck.json?.issues ?? []).map((issue) => issue.code).includes('ASR_REVIEW_NOT_ACCEPTED'))

  const accepted = f.runJson(['qc', '--id', 'SRC', '--kind', 'asr', '--status', 'review_required', '--evidence', 'asr.json', '--by', 'agent', '--note', 'homophone 钙/盖 accepted after listening', '--review-decision', 'accepted'])
  assert.equal(accepted.status, 0, accepted.stderr)
  const regenCheck = f.runJson(['check', '--request', 'regen.json'])
  assert.equal(regenCheck.status, 0, regenCheck.stderr)

  writeFileSync(resolve(f.root, 'task-bound.json'), JSON.stringify({ shot_id: 'S1', source_task_id: '123', source_asset_id: 'SRC' }))
  const bound = f.runJson(['check', '--request', 'task-bound.json'])
  assert.equal(bound.status, 0, bound.stderr)
  manifest = JSON.parse(readFileSync(f.file, 'utf8'))
  assert.equal(manifest.assets.find((asset) => asset.id === 'SRC').qc.asr.review.reviewer_decision, 'accepted')
})

test('H3 regeneration source spec gate checks every physical parameter from a real evidence report', (t) => {
  const f = fixture(t)
  const media = makeH3Source(t, f.root)
  if (media === null) return t.skip('ffmpeg unavailable')
  const inspected = f.runJson(['inspect', '--file', 'assets/source.mp4', '--out', 'spec.json', '--scan-all'])
  assert.equal(inspected.status, 0, inspected.stderr)
  const report = JSON.parse(readFileSync(resolve(f.root, 'spec.json'), 'utf8'))
  assert.deepEqual(validateRegenSourceSpec(report), [])
  const mutate = (fn) => {
    const copy = structuredClone(report)
    fn(copy)
    return validateRegenSourceSpec(copy)
  }
  assert.ok(mutate((copy) => { copy.subject.video.width = 1300 }).some((error) => /divisible by 32/.test(error)))
  assert.ok(mutate((copy) => { copy.subject.video.width = 512; copy.subject.video.height = 512 }).some((error) => /area/.test(error)))
  assert.ok(mutate((copy) => { copy.subject.video.r_frame_rate = '30/1' }).some((error) => /24 fps/.test(error)))
  assert.ok(mutate((copy) => {
    copy.subject.video.nb_frames = 130
    copy.machine.frames.declared = 130
    copy.machine.frames.decoded = 130
  }).some((error) => /frame count 130/.test(error)))
  assert.ok(mutate((copy) => {
    copy.subject.audio = null
    copy.subject.streams = copy.subject.streams.filter((stream) => stream.type !== 'audio')
  }).some((error) => /audio track/.test(error)))
})

test('regeneration rejects a non-H3 source spec before any paid call', (t) => {
  const f = fixture(t)
  const media = resolve(f.root, 'assets/source.mp4')
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=24:d=2', '-c:v', 'libx264', media], { encoding: 'utf8' })
  if (generated.error?.code === 'ENOENT') return t.skip('ffmpeg unavailable')
  const inspected = f.runJson(['inspect', '--file', 'assets/source.mp4', '--out', 'frame.json', '--scan-all'])
  assert.equal(inspected.status, 0, inspected.stderr)
  const report = JSON.parse(readFileSync(resolve(f.root, 'frame.json'), 'utf8'))
  f.data.assets.push({ id: 'SRC', kind: 'video', path: 'assets/source.mp4', sha256: report.source_sha256, approval: 'user_approved', approval_evidence: 'declared', origin: 'derived_render', root_ids: ['K1'], shot_id: 'S1', task_id: '123' })
  f.save()
  assert.equal(f.runJson(['qc', '--id', 'SRC', '--kind', 'frame_scan', '--status', 'pass', '--evidence', 'frame.json', '--by', 'agent', '--note', 'decode/coverage']).status, 0)
  writeFileSync(resolve(f.root, 'motion.json'), JSON.stringify({ schema: REVIEW_SCHEMA, kind: 'motion_review', source_sha256: report.source_sha256, decision: 'accepted', scope: 'whole clip motion', reviewer: 'agent A', authority: 'declared', content_approval: 'not_asserted' }))
  assert.equal(f.runJson(['qc', '--id', 'SRC', '--kind', 'motion_review', '--status', 'pass', '--evidence', 'motion.json', '--by', 'agent', '--note', 'motion accepted']).status, 0)
  writeFileSync(resolve(f.root, 'regen.json'), JSON.stringify({ shot_id: 'S1', video: 'assets/source.mp4', prompt: '白霜是渗水带出来的钙。', asset_ids: { base_video: 'SRC' } }))
  const result = f.runJson(['check', '--request', 'regen.json'])
  assert.equal(result.status, 2)
  assert.ok((result.json?.issues ?? []).map((issue) => issue.code).includes('REGEN_SOURCE_SPEC'))
})
