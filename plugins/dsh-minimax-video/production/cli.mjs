#!/usr/bin/env node
/**
 * Local-only AI video project/asset/QA entry point. No credentials, model API
 * or package install. Approvals, budgets, QC reviewers and review decisions are
 * declared workflow records: they are not same-UID authentication, and the
 * output says so explicitly.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { PROJECT_SCHEMA, ORIGINS, fileSha256, loadProject, validateProductionInputs } from './project.js'
import {
  QC_SCHEMA,
  REFERENCES_SCHEMA,
  REQUEST_SCHEMA,
  REVIEW_KINDS,
  evidenceAsrMachineMatch,
  evidenceSourceSha256,
  validateEvidenceReport,
  validateReviewRecord,
} from './schema/validate.js'

class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.exitCode = 2
  }
}

const COMMON_FLAGS = ['root']
const COMMANDS = {
  init: ['root', 'id'],
  budget: ['root', 'manifest', 'id', 'limit', 'currency', 'evidence', 'amend', 'reason'],
  request: ['root', 'manifest', 'shot', 'prompt-file', 'model', 'resolution', 'duration', 'ratio', 'max-cost', 'keyframe-id', 'override-reason', 'out'],
  register: ['root', 'manifest', 'id', 'kind', 'file', 'roots', 'origin', 'shot-id', 'task-id'],
  approve: ['root', 'manifest', 'id', 'by', 'evidence'],
  shot: ['root', 'manifest', 'spec'],
  qc: ['root', 'manifest', 'id', 'kind', 'status', 'evidence', 'by', 'note', 'review-decision'],
  check: ['root', 'manifest', 'request', 'all'],
  references: ['root', 'manifest', 'shot', 'out', 'ids', 'keyframe-id'],
  inspect: ['root', 'file', 'out', 'scan-all', 'asr', 'asr-python', 'asr-model', 'expected', 'language', 'expected-frames', 'expected-duration'],
}
const BOOLEAN_FLAGS = new Set(['amend', 'all', 'scan-all', 'asr'])
const USAGE = [
  'init --root DIR --id NAME',
  'budget --id ID --limit N [--currency CNY|USD] --evidence DECISION [--amend --reason REASON]',
  'register --id ID --kind character|scene|keyframe|image|video|audio --file PATH --origin generated_original|video_frame|external_capture|user_supplied|derived_render [--roots ID,ID] [--shot-id SHOT] [--task-id REMOTE_TASK]',
  'approve --id ID --by user|director|agent --evidence DECISION',
  'shot --spec SHOT.json',
  'request --shot ID --model MODEL --duration 4-15 --prompt-file PATH --out REQUEST.json [--resolution R] [--ratio R] [--keyframe-id ID] [--max-cost N] [--override-reason TEXT]',
  'check [--request REQUEST.json] [--all] [--manifest PATH]',
  'references --shot ID --out REFERENCES.json [--keyframe-id ID] [--ids ID,ID]',
  'inspect --file MEDIA --out REPORT.json [--scan-all] [--expected-frames N] [--expected-duration SEC] [--asr] [--asr-python PYTHON] [--asr-model LOCAL_DIR] [--expected TEXT] [--language zh]',
  'qc --id ASSET --kind frame_scan|asr|motion_review|voice_review|identity_review --status pass|fail|review_required --evidence REPORT.json --by REVIEWER --note SCOPE [--review-decision accepted|rejected|pending]',
]

function parseArgv(argv) {
  if (argv.length === 0) return { help: true }
  if (argv.some((entry) => entry === '--help' || entry === '-h')) return { help: true }
  const command = argv[0]
  if (command === 'help') return { help: true }
  if (!Object.hasOwn(COMMANDS, command)) throw new UsageError(`Unknown command "${command}"; run --help for the command list.`)
  const allowed = new Set([...COMMON_FLAGS, ...COMMANDS[command]])
  const flags = {}
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]
    if (typeof arg !== 'string' || !arg.startsWith('--')) throw new UsageError(`Expected an option starting with --, got "${arg}"`)
    let key
    let value
    const equals = arg.indexOf('=')
    if (equals > 2) {
      key = arg.slice(2, equals)
      value = arg.slice(equals + 1)
    } else {
      key = arg.slice(2)
      if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) value = argv[++index]
    }
    if (!allowed.has(key)) throw new UsageError(`Unknown option --${key} for command ${command}`)
    if (Object.hasOwn(flags, key)) throw new UsageError(`Duplicate option --${key}`)
    if (value === '') throw new UsageError(`--${key} needs a non-empty value`)
    if (BOOLEAN_FLAGS.has(key)) {
      if (value !== undefined) throw new UsageError(`--${key} is a flag and takes no value`)
      flags[key] = true
    } else if (value === undefined) {
      throw new UsageError(`--${key} needs a value`)
    } else {
      flags[key] = value
    }
  }
  return { command, flags }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : undefined)
const nowIso = () => new Date().toISOString()

/** Read a JSON file with a labelled error instead of a raw SyntaxError. */
function readJson(file, label = file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON in ${label}: ${error.message}`)
  }
}

function saveNew(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

function required(flags, key) {
  const value = flags[key]
  if (typeof value !== 'string' || value.trim().length === 0) throw new UsageError(`--${key} is required`)
  return value.trim()
}

function optionalNumber(flags, key) {
  if (flags[key] === undefined) return undefined
  const value = Number(flags[key])
  if (!Number.isFinite(value)) throw new UsageError(`--${key} must be a finite number`)
  return value
}

function csv(flags, key) {
  return typeof flags[key] === 'string' ? flags[key].split(',').map((entry) => entry.trim()).filter(Boolean) : []
}

function planCwd(flags) {
  return resolve(flags.root === undefined ? process.cwd() : flags.root)
}

function findProjectOrThrow(flags) {
  const project = loadProject({ cwd: planCwd(flags), manifest: flags.manifest })
  if (!project) throw new Error('No .ai-video/project.json; run init first.')
  return project
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function acquireLock(lockFile, command) {
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token, started_at: nowIso(), command }))
      } finally {
        closeSync(fd)
      }
      return token
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let lock
      try {
        lock = JSON.parse(readFileSync(lockFile, 'utf8'))
      } catch {
        lock = null
      }
      let ageMs = Number.POSITIVE_INFINITY
      try {
        ageMs = Date.now() - statSync(lockFile).mtimeMs
      } catch {
        // the owner may have removed it between the open and this stat
      }
      const parsedAge = isObject(lock) ? Date.parse(lock.started_at) : Number.NaN
      if (Number.isFinite(parsedAge)) ageMs = Math.max(ageMs, Date.now() - parsedAge)
      const alive = isObject(lock) ? pidAlive(lock.pid) : false
      const dead = isObject(lock)
        ? (!alive || ageMs > 60 * 60 * 1000)
        : ageMs > 5 * 60 * 1000
      if (dead) {
        try {
          unlinkSync(lockFile)
        } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError
        }
        continue
      }
      throw new Error(
        `Another project update is in progress (pid ${lock?.pid ?? 'unknown'}, started ${lock?.started_at ?? 'unknown'}). ` +
          `If that process no longer exists, remove ${lockFile} and retry.`,
      )
    }
  }
  throw new Error(`could not acquire ${lockFile}`)
}

function releaseLock(lockFile, token) {
  try {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
    if (lock?.token === token) unlinkSync(lockFile)
  } catch {
    // a missing or replaced lock is not ours to remove
  }
}

function updateProject(flags, mutate) {
  const project = findProjectOrThrow(flags)
  const lockFile = resolve(dirname(project.file), '.project.lock')
  const token = acquireLock(lockFile, flags.__command)
  try {
    const current = findProjectOrThrow(flags)
    mutate(current, project)
    const temp = resolve(dirname(project.file), `.project-${token}.tmp`)
    saveNew(temp, current.data)
    renameSync(temp, project.file)
    return { manifest: project.file, updated: true }
  } finally {
    releaseLock(lockFile, token)
  }
}

/** Accept either a bare args object or the CLI request envelope. */
export function unwrapRequest(value) {
  if (!isObject(value)) throw new Error('request must be a JSON object')
  if (value.schema === REQUEST_SCHEMA || isObject(value.args)) {
    if (!isObject(value.args)) throw new Error('request envelope needs an args object')
    return { args: { ...value.args }, envelope: value, mode: 'envelope' }
  }
  return { args: { ...value }, envelope: null, mode: 'args' }
}

function assetOf(project, id) {
  const asset = project.data.assets.find((entry) => entry?.id === id)
  if (!asset) throw new Error(`Unknown asset ${id}`)
  return asset
}

function approved(asset) {
  return ['approved', 'user_approved', 'director_approved', 'agent_approved', 'locked'].includes(asset?.approval)
}

function currentAssetHash(project, asset) {
  const hash = fileSha256(resolve(project.root, asset.path))
  if (lower(hash) !== lower(asset.sha256)) {
    throw new Error(`${asset.id}: bytes changed since registration; register a new version instead of overwriting the old hash.`)
  }
  return hash
}


const TOOLCHAIN_RELATIVE = 'state/dsh-minimax-video/toolchain.json'
const TOOLCHAIN_SCHEMA = 'dsh.ai-video-toolchain/1'

/** Candidate global toolchain files, in precedence order. */
export function toolchainCandidates(env = process.env, home = homedir()) {
  const candidates = []
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) {
    candidates.push(resolve(env.DSH_HOME, TOOLCHAIN_RELATIVE))
  }
  if (typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.length > 0) {
    const profileHome = dirname(dirname(resolve(env.DSH_PROFILE_DIR)))
    candidates.push(resolve(profileHome, TOOLCHAIN_RELATIVE))
  }
  if (typeof home === 'string' && home.length > 0) {
    candidates.push(resolve(home, '.dsh', TOOLCHAIN_RELATIVE))
  }
  return [...new Set(candidates)]
}

function readToolchain(env) {
  for (const file of toolchainCandidates(env)) {
    if (!existsSync(file)) continue
    const document = readJson(file, `toolchain ${file}`)
    if (!isObject(document) || document.schema !== TOOLCHAIN_SCHEMA) {
      throw new Error(`toolchain file ${file} must use schema ${TOOLCHAIN_SCHEMA}`)
    }
    return { file, ...document }
  }
  return null
}

function existingProjectRuntime(cwd) {
  let root = cwd
  try {
    const project = loadProject({ cwd })
    if (project) root = project.root
  } catch {
    // no project registry: still allow a project-local venv relative to cwd
  }
  const pythonCandidates = [resolve(root, '.work/asr-venv/bin/python'), resolve(cwd, '.work/asr-venv/bin/python')]
  const modelCandidates = [
    resolve(root, '.work/models/faster-whisper-small'),
    resolve(root, '.work/faster-whisper-small'),
    resolve(root, '.work/asr-model'),
    resolve(cwd, '.work/models/faster-whisper-small'),
    resolve(cwd, '.work/faster-whisper-small'),
    resolve(cwd, '.work/asr-model'),
  ]
  return {
    python: pythonCandidates.find((file) => existsSync(file)),
    model: modelCandidates.find((dir) => existsSync(dir)),
  }
}

/**
 * Resolve the local ASR runtime without installing or downloading anything.
 * Precedence: explicit flags > DSH_ASR_PYTHON/DSH_ASR_MODEL > shared toolchain
 * file > an existing project-local venv/model. Missing pieces are an error,
 * never an automatic install.
 */
export function resolveAsrRuntime({ flags = {}, cwd = process.cwd(), env = process.env, toolchain } = {}) {
  const wantsAsr = flags.asr === true
    || flags['asr-python'] !== undefined
    || flags['asr-model'] !== undefined
    || flags.expected !== undefined
  if (!wantsAsr) return null
  const notes = []
  const envPython = typeof env.DSH_ASR_PYTHON === 'string' && env.DSH_ASR_PYTHON.trim().length > 0 ? env.DSH_ASR_PYTHON : undefined
  const envModel = typeof env.DSH_ASR_MODEL === 'string' && env.DSH_ASR_MODEL.trim().length > 0 ? env.DSH_ASR_MODEL : undefined
  let python = flags['asr-python'] !== undefined ? resolve(cwd, String(flags['asr-python'])) : envPython
  let model = flags['asr-model'] !== undefined ? resolve(cwd, String(flags['asr-model'])) : envModel
  if (python !== undefined) notes.push('python:flags/env')
  if (model !== undefined) notes.push('model:flags/env')
  let shared = toolchain === undefined ? null : toolchain
  if (shared === null && (python === undefined || model === undefined)) shared = readToolchain(env)
  if (python === undefined && typeof shared?.asr_python === 'string' && shared.asr_python.length > 0) {
    python = shared.asr_python
    notes.push(`python:toolchain(${shared.file ?? 'configured'})`)
  }
  if (model === undefined && typeof shared?.asr_model === 'string' && shared.asr_model.length > 0) {
    model = shared.asr_model
    notes.push(`model:toolchain(${shared.file ?? 'configured'})`)
  }
  if (python === undefined || model === undefined) {
    const project = existingProjectRuntime(cwd)
    if (python === undefined && project.python !== undefined) {
      python = project.python
      notes.push('python:project-venv')
    }
    if (model === undefined && project.model !== undefined) {
      model = project.model
      notes.push('model:project')
    }
  }
  if (python === undefined || typeof python !== 'string' || python.length === 0) {
    throw new Error(
      'ASR was requested but no local Python runtime is configured. ' +
        'Pass --asr-python, set DSH_ASR_PYTHON, or install a shared $DSH_HOME/state/dsh-minimax-video/toolchain.json (schema ' +
        `${TOOLCHAIN_SCHEMA}); no download or install is attempted.`,
    )
  }
  if (model === undefined || typeof model !== 'string' || model.length === 0) {
    throw new Error(
      'ASR was requested but no local faster-whisper model directory is configured. ' +
        'Pass --asr-model, set DSH_ASR_MODEL, or install a shared $DSH_HOME/state/dsh-minimax-video/toolchain.json; no download or install is attempted.',
    )
  }
  const resolvedPython = resolve(cwd, python)
  const resolvedModel = resolve(cwd, model)
  if (!existsSync(resolvedPython)) throw new Error(`ASR Python runtime does not exist: ${resolvedPython}; no download or install is attempted`)
  if (!existsSync(resolvedModel)) throw new Error(`ASR model directory does not exist: ${resolvedModel}; no download or install is attempted`)
  return { asrPython: resolvedPython, asrModel: resolvedModel, notes, toolchain: shared?.file ?? null }
}

function inspectCommand(flags, localQa) {
  const cwd = planCwd(flags)
  const file = resolve(cwd, required(flags, 'file'))
  const out = resolve(cwd, required(flags, 'out'))
  const asr = resolveAsrRuntime({ flags, cwd })
  const report = localQa.inspectMedia({
    file,
    scanAll: flags['scan-all'] === true,
    ...(flags['expected-frames'] === undefined ? {} : { expectedFrames: Number(required(flags, 'expected-frames')) }),
    ...(flags['expected-duration'] === undefined ? {} : { expectedDuration: Number(required(flags, 'expected-duration')) }),
    ...(asr === null ? {} : { asrPython: asr.asrPython, asrModel: asr.asrModel }),
    ...(flags.expected === undefined ? {} : { expectedText: flags.expected }),
    ...(flags.language === undefined ? {} : { language: flags.language }),
  })
  const basic = validateEvidenceReport(report, {})
  if (!basic.ok) throw new Error(`local-qa returned an invalid evidence report: ${basic.errors.join('; ')}`)
  saveNew(out, report)
  return {
    report: out,
    schema: report.schema,
    source_sha256: report.source_sha256,
    verdict: report.machine?.verdict ?? null,
    decoded_frames: report.machine?.frames?.decoded ?? null,
    declared_frames: report.machine?.frames?.declared ?? null,
    ...(asr === null ? {} : { asr: { source: asr.notes, toolchain: asr.toolchain } }),
    note: 'Evidence collected locally; machine signals do not approve content. Review scope and record separate acting/identity/voice decisions.',
  }
}

async function loadLocalQa() {
  try {
    return await import('./local-qa.js')
  } catch (error) {
    throw new Error(`local-qa.js failed to load: ${error.message}; install or upgrade dsh-minimax-video`)
  }
}

function qcCommand(flags) {
  return updateProject(flags, (project) => {
    const asset = assetOf(project, required(flags, 'id'))
    const kind = required(flags, 'kind')
    if (!['frame_scan', 'asr', ...REVIEW_KINDS].includes(kind)) throw new Error('Unknown QC kind')
    const status = required(flags, 'status')
    if (!['pass', 'fail', 'review_required'].includes(status)) throw new Error('QC status must be pass, fail, or review_required')
    const reviewDecision = flags['review-decision']
    if (reviewDecision !== undefined && !['accepted', 'rejected', 'pending'].includes(reviewDecision)) {
      throw new UsageError('--review-decision must be accepted, rejected, or pending')
    }
    const reviewer = required(flags, 'by')
    const note = required(flags, 'note')
    const evidenceFile = resolve(planCwd(flags), required(flags, 'evidence'))
    const report = readJson(evidenceFile, 'QC evidence')
    const sourceHash = currentAssetHash(project, asset)
    const reportedHash = evidenceSourceSha256(report)
    if (reportedHash === null) throw new Error('QC evidence source hashes disagree or are missing')
    if (reportedHash !== sourceHash) throw new Error('QC evidence belongs to different source bytes')

    const record = {
      schema: QC_SCHEMA,
      kind,
      status,
      authority: 'declared',
      source_sha256: sourceHash,
      evidence: relative(project.root, evidenceFile),
      evidence_sha256: fileSha256(evidenceFile),
      evidence_schema: report.schema ?? null,
      machine_verdict: report?.machine?.verdict ?? null,
      machine_pass_scope: kind === 'frame_scan' && status === 'pass' ? 'decode_and_coverage' : null,
      scope: Array.isArray(report?.machine?.coverage?.scope) ? report.machine.coverage.scope : [],
      reviewed_by: reviewer,
      note,
      recorded_at: nowIso(),
    }

    if (kind === 'frame_scan') {
      const result = validateEvidenceReport(report, { kind, sourceSha256: sourceHash, frameGate: status === 'pass', requirePass: status === 'pass' })
      if (!result.ok) throw new Error(`frame_scan evidence is not valid: ${result.errors.join('; ')}`)
      // frame_scan only covers decode + verified coverage + metric structure;
      // the global verdict may be review_required because of an unrelated ASR
      // mismatch or a legitimately dark/static shot.
    } else if (kind === 'asr') {
      const result = validateEvidenceReport(report, { kind, sourceSha256: sourceHash })
      if (!result.ok) throw new Error(`asr evidence is not valid: ${result.errors.join('; ')}`)
      const machineMatch = evidenceAsrMachineMatch(report)
      if (status === 'pass' && !machineMatch) {
        throw new Error(
          'ASR cannot be recorded as a machine pass: local ASR status is ' +
            `${report?.machine?.asr?.status ?? 'missing'} / match ${String(report?.machine?.asr?.normalized_text_match)}. ` +
            'Record review_required with an explicit agent/director review scope, or fix the approved words.',
        )
      }
      if (status === 'review_required') {
        record.review = { authority: 'declared', reviewer, scope: note, reviewer_decision: reviewDecision ?? 'pending', raw_asr: true }
      }
    } else {
      const result = validateReviewRecord(report, { kind, sourceSha256: sourceHash })
      if (!result.ok) throw new Error(`${kind} review evidence is not valid: ${result.errors.join('; ')}`)
      if (status !== 'pass') throw new Error(`${kind} needs status pass and a declared review record`)
      if (reviewDecision !== undefined && reviewDecision !== 'accepted') throw new Error(`${kind} needs an explicit accepted review decision`)
      record.review = { authority: 'declared', reviewer, scope: note, reviewer_decision: 'accepted' }
    }

    asset.qc = isObject(asset.qc) ? asset.qc : {}
    asset.qc_history = Array.isArray(asset.qc_history) ? asset.qc_history : []
    if (isObject(asset.qc[kind])) {
      asset.qc_history.push({ ...asset.qc[kind], superseded_at: record.recorded_at })
    }
    asset.qc[kind] = record
    project.data.history = Array.isArray(project.data.history) ? project.data.history : []
    project.data.history.push({ kind: 'qc_record', asset_id: asset.id, qc_kind: kind, status, evidence_sha256: record.evidence_sha256, at: record.recorded_at })
  })
}

function referencesCommand(flags) {
  const project = findProjectOrThrow(flags)
  const shot = project.data.shots.find((entry) => entry?.id === required(flags, 'shot'))
  if (!shot) throw new Error('Unknown shot')
  const requiredRoots = [...new Set([
    ...(Array.isArray(shot.characters) ? shot.characters.filter((id) => typeof id === 'string') : []),
    ...(Array.isArray(shot.scenes) ? shot.scenes.filter((id) => typeof id === 'string') : []),
  ])]
  const keyframes = Array.isArray(shot.keyframes) ? shot.keyframes.filter((id) => typeof id === 'string') : []
  const explicit = flags.ids === undefined ? null : csv(flags, 'ids')
  const warnings = []
  let keyframeId = null
  let mode = 'keyframe_derived'
  const ordered = []
  if (explicit !== null) {
    mode = 'explicit'
    ordered.push(...explicit)
  } else {
    keyframeId = flags['keyframe-id'] || shot.primary_keyframe || (keyframes.length === 1 ? keyframes[0] : null)
    if (!keyframeId) throw new Error('Choose --keyframe-id when the shot has several keyframes')
    if (!keyframes.includes(keyframeId)) throw new Error(`--keyframe-id ${keyframeId} is not in ${shot.id}.keyframes`)
    ordered.push(keyframeId)
    const keyframeAsset = assetOf(project, keyframeId)
    for (const root of Array.isArray(keyframeAsset.root_ids) ? keyframeAsset.root_ids : []) ordered.push(root)
    ordered.push(...requiredRoots)
  }
  const ids = [...new Set(ordered)]
  const references = []
  const covered = new Set()
  const archiveMode = isObject(project.data.policy) ? (project.data.policy.archived_sources ?? 'warn') : 'warn'
  for (const id of ids) {
    const asset = assetOf(project, id)
    if (!approved(asset)) throw new Error(`${id}: state ${asset.approval ?? 'missing'} cannot be exported as a reference`)
    if (typeof asset.shot_id === 'string' && asset.shot_id !== shot.id) throw new Error(`${id}: registered for shot ${asset.shot_id}, not ${shot.id}; references must not mix shots`)
    if (typeof asset.path !== 'string' || /^(https?:|data:|mm_file:)/i.test(asset.path)) throw new Error(`${id}: references must be local files`)
    const path = resolve(project.root, asset.path)
    if (!existsSync(path)) throw new Error(`${id}: source file is missing`)
    const real = realpathSync(path)
    const rel = relative(project.root, real)
    const outside = rel === '' || rel.startsWith('..') || isAbsolute(rel)
    if (outside && !(isObject(project.data.policy) && project.data.policy.allow_external_assets === true)) {
      throw new Error(`${id}: resolved source is outside the project root; set policy.allow_external_assets only for an explicitly external source`)
    }
    const hash = fileSha256(real)
    if (lower(hash) !== lower(asset.sha256)) throw new Error(`${id}: bytes changed since approval; register a new version first`)
    const adoption = isObject(asset.archive_adoption) && typeof asset.archive_adoption.evidence === 'string' && asset.archive_adoption.evidence.trim().length > 0
    const archived = asset.archived === true
    const heuristic = real.split(/[\\/]/).includes('99_ARCHIVE')
    if (adoption) warnings.push({ code: 'ARCHIVE_ADOPTION_DECLARED', id })
    else if (archived) {
      if (archiveMode === 'reject') throw new Error(`${id}: manifest marks this source as archived (policy=reject)`)
      if (archiveMode === 'warn') warnings.push({ code: 'ARCHIVED_SOURCE', id })
    } else if (heuristic && !archived) {
      warnings.push({ code: 'ARCHIVE_PATH_HEURISTIC', id })
    }
    const role = asset.kind === 'character' ? 'identity_root' : asset.kind === 'scene' ? 'scene_card' : asset.kind === 'keyframe' ? 'keyframe' : asset.kind === 'audio' ? 'voice' : 'reference'
    references.push({
      id,
      kind: asset.kind,
      role,
      required: requiredRoots.includes(id) || id === keyframeId,
      path: real,
      sha256: hash,
      sha256_matches: true,
      approval: asset.approval,
      origin: asset.origin ?? 'unspecified',
      root_ids: Array.isArray(asset.root_ids) ? asset.root_ids : [],
    })
    covered.add(id)
    for (const root of Array.isArray(asset.root_ids) ? asset.root_ids : []) covered.add(root)
  }
  const missing = requiredRoots.filter((id) => !covered.has(id))
  if (missing.length > 0) {
    throw new Error(`references do not cover the shot's required character/scene roots: ${missing.join(', ')}; carry them explicitly or via an exported keyframe's root_ids`)
  }
  const out = resolve(planCwd(flags), required(flags, 'out'))
  saveNew(out, {
    schema: REFERENCES_SCHEMA,
    project: project.data.project_id ?? null,
    shot_id: shot.id,
    mode,
    authority: 'declared',
    references,
    warnings,
    required_root_ids: requiredRoots,
    coverage: { required: requiredRoots, covered: [...covered] },
    note: 'Paths and hashes are bound to the current bytes. Reuses the same-shot keyframe and its declared roots; do not pass the whole library. Approval is a declared workflow record.',
  })
  return { file: out, count: references.length, mode, required_root_ids: requiredRoots, warnings, note: 'No network or model call.' }
}

export async function main(argv) {
  const parsed = parseArgv(argv)
  if (parsed.help) return { usage: USAGE, note: 'All commands are local. No API keys, cloud calls, dependency installs, automatic approvals, or overwrites. Approvals/budget/QC/review are declared workflow records, not same-UID authentication.' }
  const { command, flags } = parsed
  flags.__command = command
  const cwd = planCwd(flags)

  if (command === 'init') {
    if (flags.root === undefined) throw new UsageError('--root is required for init')
    const file = resolve(cwd, '.ai-video/project.json')
    saveNew(file, {
      schema: PROJECT_SCHEMA,
      project_id: required(flags, 'id'),
      project_root: '..',
      budget: null,
      policy: { require_budget: true, allow_external_assets: false, archived_sources: 'warn', regeneration_requires_qc: ['frame_scan', 'motion_review'] },
      assets: [],
      shots: [],
      history: [],
    })
    return { manifest: file, note: 'No assets have been approved and no spending budget has been granted. Register actual approved sources with an explicit origin and a scoped budget before paid generation.' }
  }

  if (command === 'budget') {
    return updateProject(flags, (project) => {
      const id = required(flags, 'id')
      const limit = Number(required(flags, 'limit'))
      if (!Number.isFinite(limit) || limit <= 0) throw new Error('Budget limit must be a positive finite number')
      const currency = flags.currency === undefined ? 'CNY' : flags.currency
      if (!['CNY', 'USD'].includes(currency)) throw new Error('Budget currency must be CNY or USD')
      const evidence = required(flags, 'evidence')
      if (project.data.budget && !flags.amend) throw new Error('An existing budget cannot be replaced silently; use --amend --reason and reconcile the video_budget ledger separately')
      if (project.data.budget && flags.amend && (flags.reason === undefined || String(flags.reason).trim().length === 0)) throw new UsageError('--amend requires --reason explaining the budget change')
      const declaration = {
        id,
        limit,
        currency,
        authorization_evidence: evidence,
        authority: 'declared',
        declared_not_independently_verified: true,
      }
      project.data.history = Array.isArray(project.data.history) ? project.data.history : []
      project.data.history.push({ kind: 'budget_declaration', at: nowIso(), previous: project.data.budget ?? null, id, limit, currency, evidence, reason: flags.reason ?? null })
      project.data.budget = declaration
    })
  }

  if (command === 'request') {
    const project = findProjectOrThrow(flags)
    const shot = project.data.shots.find((entry) => entry?.id === required(flags, 'shot'))
    if (!shot) throw new Error('Unknown shot')
    const keyframes = Array.isArray(shot.keyframes) ? shot.keyframes.filter((id) => typeof id === 'string') : []
    const keyId = flags['keyframe-id'] || shot.primary_keyframe || (keyframes.length === 1 ? keyframes[0] : null)
    if (!keyId || !keyframes.includes(keyId)) throw new Error('Choose a registered same-shot keyframe explicitly when several states are available')
    const keyframe = assetOf(project, keyId)
    const voices = (Array.isArray(shot.voice_refs) ? shot.voice_refs : []).map((id) => {
      const asset = assetOf(project, id)
      if (asset.kind !== 'audio') throw new Error(`voice reference ${id} is not an audio asset`)
      return asset
    })
    const duration = Number(required(flags, 'duration'))
    if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error('Duration must be an explicit integer 4-15')
    const maxCost = optionalNumber(flags, 'max-cost')
    if (maxCost !== undefined && maxCost < 0) throw new UsageError('--max-cost must be zero or positive')
    const args = {
      project_manifest: relative(cwd, project.file),
      shot_id: shot.id,
      prompt: readFileSync(resolve(cwd, required(flags, 'prompt-file')), 'utf8'),
      model: required(flags, 'model'),
      resolution: flags.resolution === undefined ? '768P' : flags.resolution,
      duration,
      dialogue: Array.isArray(shot.dialogue) ? shot.dialogue : [],
      source_declarations: [keyframe.id, ...voices.map((asset) => asset.id)],
    }
    if (voices.length > 0) {
      args.reference_images = [resolve(project.root, keyframe.path)]
      args.reference_audio = voices.map((asset) => resolve(project.root, asset.path))
      args.reference_roles = ['approved same-shot composition, identity and scene lineage', ...voices.map((asset) => `voice timbre reference ${asset.id}; spoken words come from explicit dialogue`)]
      args.asset_ids = { reference_images: [keyframe.id], reference_audio: voices.map((asset) => asset.id) }
      args.ratio = flags.ratio || '16:9'
    } else {
      args.first_frame = resolve(project.root, keyframe.path)
      args.asset_ids = { first_frame: keyframe.id }
    }
    if (flags.ratio && voices.length === 0) args.ratio = flags.ratio
    if (maxCost !== undefined) args.max_cost = maxCost
    if (flags['override-reason'] !== undefined) args.keyframe_override_reason = flags['override-reason']
    const validation = validateProductionInputs({ cwd, args })
    const out = resolve(cwd, required(flags, 'out'))
    saveNew(out, {
      schema: REQUEST_SCHEMA,
      authority: 'declared',
      args,
      validation,
      note: 'Offline request envelope. Review the generated args and actual images before video_prepare; no network or model call was made.',
    })
    if (validation.issues.length > 0) process.exitCode = 2
    return {
      file: out,
      selected_keyframe: keyframe.id,
      inherited_roots: keyframe.root_ids ?? [],
      ready_for_offline_prepare: validation.issues.length === 0,
      issues: validation.issues,
      note: 'No network or model call. Pass the args object to video_prepare before paid submission.',
    }
  }

  if (command === 'register') {
    return updateProject(flags, (project) => {
      const id = required(flags, 'id')
      if (project.data.assets.some((asset) => asset.id === id)) throw new Error('Asset id already exists; use a new version id.')
      const kind = required(flags, 'kind')
      if (!['character', 'scene', 'keyframe', 'image', 'video', 'audio'].includes(kind)) throw new Error('Unsupported asset kind')
      const origin = required(flags, 'origin')
      if (!ORIGINS.has(origin)) throw new Error(`--origin must be one of ${[...ORIGINS].join(', ')}; a filename or extension is not an origin classification`)
      const file = resolve(cwd, required(flags, 'file'))
      const asset = {
        id,
        kind,
        path: relative(project.root, file),
        sha256: fileSha256(file),
        approval: 'candidate',
        origin,
        root_ids: csv(flags, 'roots'),
        registered_at: nowIso(),
        authority: 'declared',
      }
      if (flags['shot-id'] !== undefined) asset.shot_id = flags['shot-id']
      if (flags['task-id'] !== undefined) {
        const taskId = required(flags, 'task-id')
        asset.task_id = taskId
        asset.provenance = { task_id: taskId }
      }
      project.data.assets.push(asset)
    })
  }

  if (command === 'approve') {
    return updateProject(flags, (project) => {
      const asset = assetOf(project, required(flags, 'id'))
      const by = required(flags, 'by')
      if (!['user', 'director', 'agent'].includes(by)) throw new Error('--by must be user, director or agent; approvals are declared workflow records, model PASS alone is not approval')
      const evidence = required(flags, 'evidence')
      const hash = currentAssetHash(project, asset)
      asset.approval_history = Array.isArray(asset.approval_history) ? asset.approval_history : []
      if (asset.approval !== undefined && asset.approval !== 'candidate') {
        asset.approval_history.push({ approval: asset.approval, approval_evidence: asset.approval_evidence ?? null, approved_at: asset.approved_at ?? null })
      }
      asset.approval = by === 'user' ? 'user_approved' : by === 'director' ? 'director_approved' : 'agent_approved'
      asset.approval_evidence = evidence
      asset.approved_by = by
      asset.authority = 'declared'
      asset.approved_at = nowIso()
      asset.sha256 = hash
    })
  }

  if (command === 'shot') {
    return updateProject(flags, (project) => {
      const spec = readJson(resolve(cwd, required(flags, 'spec')), 'shot spec')
      if (!isObject(spec) || typeof spec.id !== 'string' || spec.id.length === 0) throw new Error('Shot spec needs a non-empty id')
      if (project.data.shots.some((entry) => entry.id === spec.id)) throw new Error('Shot spec needs a new unique id')
      project.data.shots.push(spec)
    })
  }

  if (command === 'qc') return qcCommand(flags)

  if (command === 'check') {
    let parsedRequest = {}
    if (flags.request !== undefined) parsedRequest = readJson(resolve(cwd, required(flags, 'request')), 'request file')
    const unwrapped = flags.request === undefined ? { args: {}, envelope: null } : unwrapRequest(parsedRequest)
    const args = { ...unwrapped.args }
    if (flags.manifest !== undefined) {
      const manifest = resolve(cwd, flags.manifest)
      if (args.project_manifest !== undefined && resolve(cwd, args.project_manifest) !== manifest) {
        throw new Error('--manifest conflicts with the request envelope project_manifest; choose one')
      }
      args.project_manifest = flags.manifest
    }
    const result = validateProductionInputs({ cwd, args, auditAll: flags.all === true })
    if (result.issues.length > 0 || (result.audit?.issues?.length ?? 0) > 0) process.exitCode = 2
    return result
  }

  if (command === 'references') return referencesCommand(flags)

  if (command === 'inspect') {
    const localQa = await loadLocalQa()
    return inspectCommand(flags, localQa)
  }

  throw new UsageError(`Unknown command "${command}"`)
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  try {
    const result = await main(process.argv.slice(2))
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, ...(error.code === undefined ? {} : { code: error.code }) }))
    process.exitCode = error.exitCode ?? 1
  }
}
