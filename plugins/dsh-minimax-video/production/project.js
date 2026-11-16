import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import {
  QC_SCHEMA,
  evidenceAsrMachineMatch,
  validateEvidenceReport,
  validateRegenSourceSpec,
  validateReviewRecord,
} from './schema/validate.js'

export const PROJECT_SCHEMA = 'dsh.ai-video-project/1'
export const ORIGINS = new Set(['generated_original', 'video_frame', 'external_capture', 'user_supplied', 'derived_render'])
const APPROVED = new Set(['approved', 'user_approved', 'director_approved', 'agent_approved', 'locked'])
const SHA = /^[a-f0-9]{64}$/i
const IMAGE_KINDS = new Set(['image', 'character', 'scene', 'keyframe'])
const ASSET_ID_SLOTS = new Set(['first_frame', 'last_frame', 'reference_images', 'reference_videos', 'reference_audio', 'images', 'base_video'])
const ARRAY_ASSET_ID_SLOTS = new Set(['reference_images', 'reference_videos', 'reference_audio', 'images'])
const SLOT_ARRAY_FIELDS = [
  ['reference_images', 'image'],
  ['reference_videos', 'video'],
  ['reference_audio', 'audio'],
  ['images', 'image'],
]

const error = (code, message) => ({ level: 'error', code, message })
const warning = (code, message) => ({ level: 'warn', code, message })
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : undefined)

/** Synchronous streaming sha256: large 2K sources are never read into one buffer. */
export function fileSha256(file) {
  const hash = createHash('sha256')
  const fd = openSync(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read === 0) break
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/**
 * Redact a source for display. Remote URLs keep only origin plus a hash of the
 * path: signed URLs can carry credentials in the path as well as the query.
 */
export function publicSource(value) {
  const text = String(value ?? '')
  try {
    const url = new URL(text)
    if (['http:', 'https:'].includes(url.protocol)) {
      const pathHash = createHash('sha256').update(url.pathname).digest('hex').slice(0, 16)
      return `${url.origin}/[path sha256:${pathHash}]`
    }
  } catch {}
  if (text.startsWith('data:')) {
    return `[inline media sha256:${createHash('sha256').update(text).digest('hex')}]`
  }
  return text
}

function within(root, file) {
  const path = relative(root, file)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export function findProject(cwd, explicit) {
  if (explicit) return resolve(cwd, explicit)
  let dir = resolve(cwd)
  for (let depth = 0; depth < 30; depth++) {
    const file = resolve(dir, '.ai-video/project.json')
    if (existsSync(file)) return file
    if (existsSync(resolve(dir, '.git'))) return null
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function loadProject({ cwd = process.cwd(), manifest } = {}) {
  const file = findProject(cwd, manifest)
  if (!file) return null
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (data.schema !== PROJECT_SCHEMA) throw new Error(`unsupported AI video project schema; expected ${PROJECT_SCHEMA}`)
  if (!Array.isArray(data.assets) || !Array.isArray(data.shots)) throw new Error('project assets and shots must be arrays')
  const rawRoot = resolve(dirname(file), data.project_root ?? '..')
  let root
  try {
    root = realpathSync(rawRoot)
  } catch {
    throw new Error(`project root does not exist or is unreadable: ${rawRoot}`)
  }
  return { data, file, root }
}

function declaredAssetId(args, slot, index) {
  if (!isObject(args.asset_ids)) return undefined
  if (index === undefined) return args.asset_ids[slot]
  const list = args.asset_ids[slot]
  return Array.isArray(list) ? list[index] : undefined
}

function inputRows(args) {
  const rows = []
  const push = (slot, kind, input, index) => {
    if (input === undefined || input === null) return
    rows.push({
      slot,
      kind,
      input,
      usage: index === undefined ? slot : `${slot}[${index}]`,
      declaredId: declaredAssetId(args, slot, index),
    })
  }
  push('first_frame', 'image', args.first_frame)
  push('last_frame', 'image', args.last_frame)
  for (const [slot, kind] of SLOT_ARRAY_FIELDS) {
    const value = args[slot]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value)) {
      rows.push({ slot, kind, input: value, usage: slot, declaredId: undefined, malformed: true })
      continue
    }
    value.forEach((entry, index) => push(slot, kind, entry, index))
  }
  push('base_video', 'video', args.video)
  return rows
}

/** Validate the optional slot -> asset id map that disambiguates hashes and roles. */
function validateAssetIdsShape(args, errors) {
  if (args.asset_ids === undefined || args.asset_ids === null) return
  if (!isObject(args.asset_ids)) {
    errors.push(error('INVALID_ASSET_IDS', 'asset_ids must be an object mapping slot names to registered asset ids'))
    return
  }
  for (const [slot, value] of Object.entries(args.asset_ids)) {
    if (!ASSET_ID_SLOTS.has(slot)) {
      errors.push(error('UNKNOWN_ASSET_ID_SLOT', `asset_ids.${slot} is not a media slot`))
      continue
    }
    if (ARRAY_ASSET_ID_SLOTS.has(slot)) {
      if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
        errors.push(error('INVALID_ASSET_ID_LIST', `asset_ids.${slot} must be an array of non-empty asset ids`))
      }
    } else if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(error('INVALID_ASSET_ID', `asset_ids.${slot} must be a non-empty asset id`))
    }
  }
}

function validateAssetIdsCoverage(args, errors) {
  if (!isObject(args.asset_ids)) return
  for (const [slot, field] of [['first_frame', 'first_frame'], ['last_frame', 'last_frame'], ['base_video', 'video']]) {
    if (args.asset_ids[slot] !== undefined && (args[field] === undefined || args[field] === null)) {
      errors.push(error('ASSET_ID_WITHOUT_MEDIA', `asset_ids.${slot} names an asset but no ${field} media was supplied.`))
    }
  }
  for (const [slot] of SLOT_ARRAY_FIELDS) {
    const declared = args.asset_ids[slot]
    if (declared === undefined) continue
    if (!Array.isArray(declared)) continue
    const actual = args[slot]
    if (!Array.isArray(actual) || declared.length !== actual.length) {
      errors.push(error('ASSET_ID_COUNT_MISMATCH', `asset_ids.${slot} has ${declared.length} entries but the media slot has ${Array.isArray(actual) ? actual.length : 0}.`))
    }
  }
}

function slotAcceptsKind(slot, assetKind) {
  if (slot === 'reference_audio') return assetKind === 'audio'
  if (slot === 'reference_videos' || slot === 'base_video') return assetKind === 'video'
  return IMAGE_KINDS.has(assetKind)
}

function listOf(shot, field, errors) {
  const value = shot?.[field]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    errors.push(error('INVALID_SHOT_FIELD', `${shot?.id ?? 'shot'}.${field} must be an array of asset ids`))
    return []
  }
  const valid = value.filter((entry) => typeof entry === 'string' && entry.length > 0)
  if (valid.length !== value.length) errors.push(error('INVALID_SHOT_FIELD', `${shot?.id ?? 'shot'}.${field} must contain non-empty strings`))
  return valid
}

function linesOf(shot, errors) {
  const dialogue = shot?.dialogue
  if (dialogue === undefined || dialogue === null) return []
  if (!Array.isArray(dialogue)) {
    errors.push(error('INVALID_SHOT_FIELD', `${shot?.id ?? 'shot'}.dialogue must be an array`))
    return []
  }
  const lines = []
  for (const entry of dialogue) {
    if (typeof entry === 'string' && entry.trim().length > 0) lines.push(entry)
    else if (isObject(entry) && typeof entry.line === 'string' && entry.line.trim().length > 0) lines.push(entry.line)
    else errors.push(error('INVALID_SHOT_FIELD', `${shot?.id ?? 'shot'}.dialogue entries need a non-empty line`))
  }
  return lines
}

export function normalizeText(value) {
  return String(value ?? '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[“”„‟"'‘’「」『』《》]/g, '')
    .trim()
}

/** Punctuation/whitespace-insensitive comparison used only for warnings. */
export function normalizeLoose(value) {
  return normalizeText(value).replace(/[\s，。！？、；：,.!?;:…—–\-()（）\[\]【】]/g, '')
}

function reasonText(args) {
  return typeof args?.keyframe_override_reason === 'string' ? args.keyframe_override_reason.trim() : ''
}

function hasSpecificReason(args) {
  return [...reasonText(args)].length >= 4
}

/**
 * Validate actual media bytes, slot/asset-id binding and approved lineage.
 * Approvals, budget and reviews are declared workflow records: this function
 * verifies bytes and records, never user or client acceptance.
 */
export function validateProductionInputs({
  cwd = process.cwd(),
  args = {},
  prompt,
  verifyAll = false,
  auditAll = verifyAll,
} = {}) {
  if (!isObject(args)) args = {}
  const promptText = prompt === undefined ? args.prompt : prompt
  const loaded = loadProject({ cwd, manifest: args.project_manifest })
  if (!loaded) {
    return {
      project: null,
      shot: null,
      issues: [],
      warnings: [{ code: 'NO_PROJECT_REGISTRY', message: 'No project registry; source approval and card reuse have not been verified.' }],
      assets: [],
      audit: null,
    }
  }

  const { data, file, root } = loaded
  const errors = []
  const warnings = []
  const map = new Map()
  const checked = new Map()
  const policy = isObject(data.policy) ? data.policy : {}
  const budget = data.budget
  const authority = { authority: 'declared', content_approval: 'not_asserted' }

  validateAssetIdsShape(args, errors)
  validateAssetIdsCoverage(args, errors)
  if (policy.require_budget !== false && !budget) {
    errors.push(error('PROJECT_BUDGET_REQUIRED', 'Registered production requires an explicit project budget before paid submission.'))
  }
  if (budget && (!budget.id || !Number.isFinite(budget.limit) || budget.limit <= 0 || !['CNY', 'USD'].includes(budget.currency))) {
    errors.push(error('INVALID_BUDGET', 'Project budget needs an id, positive limit and CNY/USD currency.'))
  }

  for (const asset of data.assets) {
    if (!isObject(asset) || typeof asset.id !== 'string' || !asset.id) {
      errors.push(error('DUPLICATE_ASSET_ID', 'Every asset needs a unique nonempty id.'))
      continue
    }
    if (map.has(asset.id)) {
      errors.push(error('DUPLICATE_ASSET_ID', `${asset.id}: duplicate asset id.`))
      continue
    }
    map.set(asset.id, asset)
    if (APPROVED.has(asset.approval) && (!SHA.test(asset.sha256 ?? '') || !asset.approval_evidence)) {
      errors.push(error('UNPROVEN_APPROVAL', `${asset.id}: approved assets require sha256 and an approval_evidence record; authority is declared, model PASS is not approval.`))
    }
    if (!ORIGINS.has(asset.origin)) {
      const problem = error(
        'ASSET_ORIGIN_REQUIRED',
        `${asset.id}: origin must be one of ${[...ORIGINS].join(', ')}; filename or extension is not an origin classification.`,
      )
      if (APPROVED.has(asset.approval)) errors.push(problem)
      else warnings.push({ ...problem, level: 'warn' })
    }
  }

  function archiveProblems(asset, real) {
    const problems = []
    const adoption = isObject(asset.archive_adoption)
      && typeof asset.archive_adoption.evidence === 'string'
      && asset.archive_adoption.evidence.trim().length > 0
    if (adoption) {
      problems.push(warning('ARCHIVE_ADOPTION_DECLARED', `${asset.id}: an explicit archive adoption record exists; it overrides the old rejection but is still a declared workflow record.`))
      return problems
    }
    const archived = asset.archived === true
    const archivedPath = real.split(/[\\/]/).includes('99_ARCHIVE')
    if (archived) {
      const mode = policy.archived_sources ?? 'warn'
      if (mode === 'allow') return problems
      if (mode === 'reject') {
        problems.push(error('ARCHIVED_SOURCE', `${asset.id}: the manifest marks this approved source as archived.`))
      } else {
        problems.push(warning('ARCHIVED_SOURCE', `${asset.id}: the manifest marks this approved source as archived; confirm the current adoption before reuse.`))
      }
      return problems
    }
    if (archivedPath) {
      problems.push(warning('ARCHIVE_PATH_HEURISTIC', `${asset.id}: the resolved path is under 99_ARCHIVE; a directory name is only a heuristic, not an archive status.`))
    }
    return problems
  }

  function checkAsset(id) {
    const cached = checked.get(id)
    if (cached !== undefined) return cached
    const result = { info: null, problems: [] }
    checked.set(id, result)
    const asset = map.get(id)
    if (!asset) {
      result.problems.push(error('UNKNOWN_ASSET', `Unknown asset id: ${id}`))
      return result
    }
    if (!APPROVED.has(asset.approval)) {
      result.problems.push(error('ASSET_NOT_APPROVED', `${id}: state ${asset.approval ?? 'missing'} cannot enter production.`))
      return result
    }
    if (typeof asset.path !== 'string' || !asset.path) {
      result.problems.push(error('ASSET_PATH_MISSING', `${id}: local source path is required.`))
      return result
    }
    if (/^(https?:|data:|mm_file:)/i.test(asset.path)) {
      result.problems.push(error('UNVERIFIED_REMOTE_ASSET', `${id}: copy approved reference bytes locally before production; a URL is not a verified content hash.`))
      return result
    }
    const path = resolve(root, asset.path)
    let real
    try {
      real = realpathSync(path)
      if (!statSync(real).isFile()) throw new Error('not a regular file')
    } catch {
      result.problems.push(error('ASSET_UNAVAILABLE', `${id}: approved file is missing or unreadable.`))
      return result
    }
    result.problems.push(...archiveProblems(asset, real))
    if (!within(root, real) && policy.allow_external_assets !== true) {
      result.problems.push(error('EXTERNAL_ONLY_SOURCE', `${id}: approved source must be retained inside the project or explicitly allowed by project policy.`))
    }
    const hash = fileSha256(real)
    if (hash !== lower(asset.sha256)) {
      result.problems.push(error('ASSET_HASH_DRIFT', `${id}: bytes differ from the approved source.`))
    }
    result.info = {
      id,
      kind: asset.kind,
      origin: asset.origin ?? 'unspecified',
      path: asset.path,
      sha256: hash,
      approval: asset.approval,
      authority: 'declared',
      root_ids: Array.isArray(asset.root_ids) ? asset.root_ids : [],
    }
    return result
  }

  function applyProblems(problems, sinkErrors, sinkWarnings) {
    for (const problem of problems) {
      if (problem.level === 'warn') sinkWarnings.push(problem)
      else sinkErrors.push(problem)
    }
  }

  const shots = new Map()
  for (const shotEntry of data.shots) {
    if (!isObject(shotEntry) || typeof shotEntry.id !== 'string' || !shotEntry.id) {
      errors.push(error('DUPLICATE_SHOT_ID', 'Every shot needs a unique nonempty id.'))
      continue
    }
    if (shots.has(shotEntry.id)) errors.push(error('DUPLICATE_SHOT_ID', `${shotEntry.id}: duplicate shot id.`))
    else shots.set(shotEntry.id, shotEntry)
  }
  const shot = typeof args.shot_id === 'string' ? shots.get(args.shot_id) : null
  if (data.shots.length && !args.shot_id) errors.push(error('SHOT_ID_REQUIRED', 'This project has a shot register; select shot_id before production.'))
  if (args.shot_id && !shot) errors.push(error('UNKNOWN_SHOT', `Shot is not registered: ${args.shot_id}`))

  const usedIds = new Set()
  const selected = []
  const slotByAsset = new Map()

  function bindAsset(row, info) {
    usedIds.add(info.id)
    selected.push({ ...info, usage: row.usage, slot: row.slot })
    const previousSlot = slotByAsset.get(info.id)
    if (previousSlot !== undefined && previousSlot !== row.slot) {
      warnings.push(warning('ASSET_USED_IN_MULTIPLE_SLOTS', `${info.id}: used in both ${previousSlot} and ${row.slot}; confirm each role is intentional.`))
    } else {
      slotByAsset.set(info.id, row.slot)
    }
  }

  function roleProblems(asset, slot) {
    const problems = []
    if (shot && typeof asset.shot_id === 'string' && asset.shot_id !== shot.id) {
      problems.push(error('CROSS_SHOT_ASSET', `${asset.id}: registered for shot ${asset.shot_id}, not ${shot.id}.`))
    }
    if (shot && asset.kind === 'keyframe' && typeof asset.shot_id !== 'string') {
      const keyframes = Array.isArray(shot.keyframes) ? shot.keyframes : []
      if (!keyframes.includes(asset.id)) {
        problems.push(error('KEYFRAME_NOT_IN_SHOT', `${asset.id}: keyframe has no shot_id and is not listed in ${shot.id}.keyframes; register it with --shot-id or add it to the shot explicitly.`))
      }
    }
    return problems
  }

  for (const row of inputRows(args)) {
    if (row.malformed) {
      errors.push(error('INVALID_SLOT_VALUE', `${row.slot}: expected an array of local media paths.`))
      continue
    }
    if (typeof row.input !== 'string' || row.input.trim().length === 0 || /^(https?:|data:|mm_file:)/i.test(row.input)) {
      errors.push(error('UNVERIFIED_INPUT', `${row.usage}: registered production requires local, hash-verifiable inputs.`))
      continue
    }
    let actualHash
    try {
      actualHash = fileSha256(resolve(cwd, row.input))
    } catch {
      errors.push(error('INPUT_UNAVAILABLE', `${row.usage}: actual input cannot be read.`))
      continue
    }

    if (row.declaredId !== undefined) {
      if (typeof row.declaredId !== 'string' || row.declaredId.trim().length === 0) {
        errors.push(error('INVALID_ASSET_ID', `${row.usage}: asset_ids entry must be a non-empty registered asset id.`))
        continue
      }
      const asset = map.get(row.declaredId)
      if (!asset) {
        errors.push(error('DECLARED_ASSET_UNKNOWN', `${row.usage}: declared asset ${row.declaredId} is not registered.`))
        continue
      }
      if (!APPROVED.has(asset.approval)) {
        errors.push(error('ASSET_NOT_APPROVED', `${row.declaredId}: state ${asset.approval ?? 'missing'} cannot enter production.`))
        continue
      }
      if (!slotAcceptsKind(row.slot, asset.kind)) {
        errors.push(error('DECLARED_ASSET_KIND', `${row.usage}: ${row.declaredId} is ${asset.kind}, which does not fit this slot.`))
        continue
      }
      if (lower(asset.sha256) !== actualHash) {
        errors.push(error('DECLARED_ASSET_HASH_MISMATCH', `${row.usage}: actual bytes do not match declared asset ${row.declaredId}.`))
        continue
      }
      const checkedAsset = checkAsset(asset.id)
      applyProblems(checkedAsset.problems, errors, warnings)
      applyProblems(roleProblems(asset, row.slot), errors, warnings)
      if (checkedAsset.info) bindAsset(row, checkedAsset.info)
      continue
    }

    const matches = data.assets.filter((asset) => lower(asset?.sha256) === actualHash)
    if (matches.length === 0) {
      errors.push(error('UNREGISTERED_SOURCE', `${row.usage}: actual input bytes are not in the approved asset register.`))
      continue
    }
    const eligible = matches.filter((asset) => APPROVED.has(asset.approval) && slotAcceptsKind(row.slot, asset.kind))
    if (eligible.length === 0) {
      errors.push(error('WRONG_SOURCE_STATE_OR_KIND', `${row.usage}: matching bytes are not approved for this media kind.`))
      continue
    }
    const ids = [...new Set(eligible.map((asset) => asset.id))]
    if (ids.length > 1) {
      errors.push(error(
        'AMBIGUOUS_ASSET_HASH',
        `${row.usage}: bytes match ${ids.join(', ')}; declare asset_ids.${row.slot}${row.usage.includes('[') ? `[${row.usage.split('[')[1].replace(']', '')}]` : ''} so the role and lineage are explicit.`,
      ))
      continue
    }
    const asset = eligible.find((entry) => entry.id === ids[0])
    const checkedAsset = checkAsset(asset.id)
    applyProblems(checkedAsset.problems, errors, warnings)
    applyProblems(roleProblems(asset, row.slot), errors, warnings)
    if (checkedAsset.info) bindAsset(row, checkedAsset.info)
  }

  // Explicit source binding for source_task_id regeneration. Without a local,
  // hash-bound source there is nothing to attach QC evidence to, so the
  // registered path refuses instead of silently skipping the QC gate.
  const byTask = typeof args.source_task_id === 'string' && args.source_task_id.trim().length > 0
  let sourceForQc = selected.find((asset) => asset.usage === 'base_video')
  if (byTask) {
    if (args.video !== undefined) errors.push(error('CONFLICTING_REGENERATION_MODES', 'source_task_id and a local base video cannot be combined.'))
    const sourceAssetId = typeof args.source_asset_id === 'string' ? args.source_asset_id.trim() : ''
    if (!sourceAssetId) {
      errors.push(error(
        'SOURCE_TASK_ID_UNBOUND',
        'source_task_id regeneration in a registered project needs source_asset_id naming the registered 768P source, so its bytes and QC evidence can be bound. Register the source video (with root_ids linking its keyframe) first, or submit the local video instead.',
      ))
    } else {
      const asset = map.get(sourceAssetId)
      if (!asset) errors.push(error('SOURCE_ASSET_UNKNOWN', `source_asset_id ${sourceAssetId} is not registered.`))
      else if (asset.kind !== 'video') errors.push(error('SOURCE_ASSET_KIND', `${sourceAssetId} must be a video asset.`))
      else if (!APPROVED.has(asset.approval)) errors.push(error('ASSET_NOT_APPROVED', `${sourceAssetId}: state ${asset.approval ?? 'missing'} cannot enter production.`))
      else {
        const taskIds = new Set()
        for (const candidate of [asset.task_id, isObject(asset.provenance) ? asset.provenance.task_id : undefined]) {
          if (typeof candidate === 'string' && candidate.trim().length > 0) taskIds.add(candidate.trim())
          else if (typeof candidate === 'number' && Number.isFinite(candidate)) taskIds.add(String(candidate))
        }
        const expectedTaskId = String(args.source_task_id).trim()
        if (taskIds.size === 0) {
          errors.push(error(
            'SOURCE_TASK_ID_UNMAPPED',
            `${sourceAssetId}: no task_id/provenance.task_id is recorded, so it cannot be proven to be the local source of remote task ${expectedTaskId}. Register the downloaded local source with its task id, or use the video mode that submits the local file and original inputs.`,
          ))
        } else if (!taskIds.has(expectedTaskId)) {
          errors.push(error(
            'SOURCE_TASK_ID_MISMATCH',
            `${sourceAssetId}: recorded task id(s) ${[...taskIds].join(', ')} do not include ${expectedTaskId}; a local source for another task cannot carry this regeneration's QC. Use the video mode instead.`,
          ))
        } else {
          const checkedAsset = checkAsset(asset.id)
          applyProblems(checkedAsset.problems, errors, warnings)
          applyProblems(roleProblems(asset, 'base_video'), errors, warnings)
          if (checkedAsset.info) {
            usedIds.add(asset.id)
            selected.push({ ...checkedAsset.info, usage: 'source_task_id', slot: 'source_asset' })
            sourceForQc = checkedAsset.info
          }
        }
      }
    }
  }

  const covered = new Set()
  function lineage(id, active = new Set(), sinkErrors = errors, sinkWarnings = warnings, seen = covered) {
    if (active.has(id)) {
      sinkErrors.push(error('LINEAGE_CYCLE', `Asset lineage is cyclic at ${id}`))
      return
    }
    if (seen.has(id)) return
    const asset = map.get(id)
    if (!asset) {
      sinkErrors.push(error('MISSING_ROOT', `Missing lineage root ${id}`))
      return
    }
    if (asset.root_ids !== undefined && !Array.isArray(asset.root_ids)) {
      sinkErrors.push(error('INVALID_ROOT_IDS', `${id}.root_ids must be an array of asset ids`))
    }
    const checkedAsset = checkAsset(id)
    applyProblems(checkedAsset.problems, sinkErrors, sinkWarnings)
    seen.add(id)
    const next = new Set(active)
    next.add(id)
    const roots = Array.isArray(asset.root_ids) ? asset.root_ids.filter((entry) => typeof entry === 'string') : []
    for (const parent of roots) lineage(parent, next, sinkErrors, sinkWarnings, seen)
  }
  for (const id of usedIds) lineage(id)

  let audit = null
  if (auditAll) {
    audit = { issues: [], warnings: [] }
    // Audit lineage must not contribute to this request's required-root
    // coverage: an approved-but-unused root being valid is not reuse.
    const auditCovered = new Set()
    for (const asset of data.assets) {
      if (!isObject(asset) || !APPROVED.has(asset.approval)) continue
      lineage(asset.id, new Set(), audit.issues, audit.warnings, auditCovered)
    }
  }

  if (shot) {
    const requiredRoots = [
      ...listOf(shot, 'characters', errors),
      ...listOf(shot, 'scenes', errors),
      ...listOf(shot, 'required_assets', errors),
    ]
    for (const id of requiredRoots) {
      if (!covered.has(id)) {
        errors.push(error('REQUIRED_ROOT_NOT_REUSED', `${shot.id}: required character/scene/root ${id} is absent from actual inputs and their declared lineage.`))
      }
    }

    const keyframes = listOf(shot, 'keyframes', errors)
    const voiceRefs = listOf(shot, 'voice_refs', errors)
    const imageInputs = inputRows(args).filter((row) => row.kind === 'image')
    const keyframeRoleSlots = new Set(voiceRefs.length > 0 ? ['reference_images'] : ['first_frame', 'last_frame'])
    if (keyframes.length > 0 && imageInputs.length > 0) {
      const keyframeInRole = selected.some((asset) => keyframes.includes(asset.id) && keyframeRoleSlots.has(asset.slot))
      if (!keyframeInRole) {
        if (hasSpecificReason(args)) warnings.push(warning('KEYFRAME_OVERRIDE_DECLARED', `${shot.id}: alternate reference choice recorded; this declaration is not visual verification.`))
        else errors.push(error('APPROVED_KEYFRAME_NOT_USED', `${shot.id}: reuse an approved same-shot keyframe in ${[...keyframeRoleSlots].join('/')}; replacing it requires a specific keyframe_override_reason, not file recency or model score.`))
      }
    }

    const hasVisualInput = imageInputs.length > 0
    if ((requiredRoots.length > 0 || keyframes.length > 0) && !hasVisualInput && args.video === undefined && !byTask) {
      errors.push(error('MISSING_VISUAL_REFERENCE', `${shot.id}: text-only generation drops registered identity/scene constraints.`))
    }

    if (!byTask && shot.dialogue !== undefined) {
      const rawPrompt = String(promptText ?? '')
      for (const line of linesOf(shot, errors)) {
        if (rawPrompt.includes(line)) continue
        if (normalizeText(rawPrompt).includes(normalizeText(line))) {
          warnings.push(warning('DIALOGUE_WHITESPACE_DIFFERS', `${shot.id}: line "${line.slice(0, 40)}" matches after whitespace normalisation; write the approved line verbatim in the prompt.`))
        } else if (normalizeLoose(rawPrompt).includes(normalizeLoose(line))) {
          warnings.push(warning('DIALOGUE_PUNCTUATION_DIFFERS', `${shot.id}: line "${line.slice(0, 40)}" differs only in punctuation/whitespace; write the approved line verbatim in the prompt.`))
        } else {
          errors.push(error('APPROVED_DIALOGUE_MISSING', `${shot.id}: an approved dialogue line is absent from the prompt; args.dialogue cannot replace the prompt text.`))
        }
      }
    }
  }

  for (const asset of selected) {
    if (!IMAGE_KINDS.has(asset.kind)) continue
    if (asset.origin === 'video_frame' && !hasSpecificReason(args)) {
      errors.push(error('FRAME_CAPTURE_NEEDS_REASON', `${asset.id}: video screenshots require a stated continuity/action reason and review of the actual frame.`))
    }
  }

  if (sourceForQc) {
    const entry = map.get(sourceForQc.id)
    const required = new Set(policy.regeneration_requires_qc ?? ['frame_scan', 'motion_review'])
    // A 2K submission always needs the local source's decode/coverage evidence:
    // without it the H3 physical source spec cannot be checked before payment.
    required.add('frame_scan')
    if (shot && linesOf(shot, errors).length > 0) required.add('asr')
    for (const kind of required) checkQc(entry, sourceForQc, kind, errors, warnings, root)
    warnings.push(warning('QC_SCOPE', 'ASR checks words; full-frame metrics check measured signals. Neither proves lip sync, identity, natural acting, or human acceptance.'))
  }

  return {
    project: {
      id: data.project_id ?? null,
      manifest: file,
      root,
      budget: budget ?? null,
      policy,
      ...authority,
    },
    shot: shot ?? null,
    issues: errors,
    warnings,
    audit,
    assets: selected,
    coverage: {
      used_asset_ids: [...usedIds],
      inherited_root_ids: [...covered].filter((id) => !usedIds.has(id)),
      required_root_ids: shot
        ? [...listOf(shot, 'characters', []), ...listOf(shot, 'scenes', []), ...listOf(shot, 'required_assets', [])]
        : [],
      local_bytes_verified: errors.length === 0,
      visual_semantics_verified: false,
      ...authority,
      lineage_basis: 'declared root_ids',
    },
  }
}

/** Validate one QC record against its evidence bytes and the declared source. */
function checkQc(entry, source, kind, errors, warnings, root) {
  const record = isObject(entry?.qc) ? entry.qc[kind] : undefined
  if (!isObject(record)) {
    errors.push(error('SOURCE_QC_MISSING', `${source.id}: ${kind} QC is missing before 2K regeneration.`))
    return
  }
  if (record.schema !== QC_SCHEMA) errors.push(error('QC_RECORD_SCHEMA', `${source.id}: ${kind} QC record must use ${QC_SCHEMA}.`))
  if (record.authority !== 'declared') errors.push(error('QC_AUTHORITY', `${source.id}: ${kind} QC must declare authority=declared.`))
  if (lower(record.source_sha256) !== lower(source.sha256)) {
    errors.push(error('QC_SOURCE_MISMATCH', `${source.id}: ${kind} QC was recorded against different source bytes.`))
  }
  if (typeof record.evidence !== 'string' || record.evidence.trim().length === 0) {
    errors.push(error('QC_EVIDENCE_MISSING', `${source.id}: ${kind} evidence path is missing.`))
    return
  }
  if (!SHA.test(record.evidence_sha256 ?? '')) {
    errors.push(error('QC_EVIDENCE_HASH_MISSING', `${source.id}: ${kind} evidence sha256 is missing.`))
    return
  }
  const evidenceFile = resolve(root, record.evidence)
  if (!existsSync(evidenceFile)) {
    errors.push(error('QC_EVIDENCE_MISSING', `${source.id}: ${kind} evidence file is absent.`))
    return
  }
  let evidenceHash
  try {
    evidenceHash = fileSha256(evidenceFile)
  } catch {
    errors.push(error('QC_EVIDENCE_UNREADABLE', `${source.id}: ${kind} evidence file cannot be read.`))
    return
  }
  if (evidenceHash !== lower(record.evidence_sha256)) {
    errors.push(error('QC_EVIDENCE_DRIFT', `${source.id}: ${kind} evidence bytes changed since the QC record.`))
    return
  }
  let report
  try {
    report = JSON.parse(readFileSync(evidenceFile, 'utf8'))
  } catch {
    errors.push(error('QC_EVIDENCE_INVALID_JSON', `${source.id}: ${kind} evidence is not valid JSON.`))
    return
  }

  if (kind === 'frame_scan') {
    const result = validateEvidenceReport(report, { kind, sourceSha256: source.sha256, frameGate: true })
    if (!result.ok) errors.push(error('QC_EVIDENCE_SCHEMA', `${source.id}: frame_scan evidence invalid: ${result.errors.join('; ')}`))
    if (record.status !== 'pass') errors.push(error('QC_NOT_PASS', `${source.id}: frame_scan QC status is ${record.status ?? 'missing'}, not pass.`))
    if (record.machine_pass_scope !== 'decode_and_coverage') {
      errors.push(error('QC_FRAME_SCOPE', `${source.id}: frame_scan pass must declare machine_pass_scope=decode_and_coverage.`))
    }
    const specErrors = validateRegenSourceSpec(report)
    if (specErrors.length > 0) {
      errors.push(error('REGEN_SOURCE_SPEC', `${source.id}: regeneration source is not an H3 768P clip: ${specErrors.join('; ')}`))
    }
  } else if (kind === 'asr') {
    const result = validateEvidenceReport(report, { kind, sourceSha256: source.sha256 })
    if (!result.ok) errors.push(error('QC_EVIDENCE_SCHEMA', `${source.id}: asr evidence invalid: ${result.errors.join('; ')}`))
    const machineMatch = result.ok && evidenceAsrMachineMatch(report)
    if (record.status === 'pass') {
      if (!machineMatch) errors.push(error('ASR_MACHINE_PASS_REQUIRED', `${source.id}: ASR cannot be a machine pass unless the retained transcript matches the approved words; record review_required with an explicit declared review instead.`))
    } else if (record.status === 'review_required') {
      const review = record.review
      if (!isObject(review) || review.authority !== 'declared'
        || typeof review.reviewer !== 'string' || review.reviewer.trim().length === 0
        || typeof review.scope !== 'string' || review.scope.trim().length === 0) {
        errors.push(error('ASR_REVIEW_DECLARATION_REQUIRED', `${source.id}: an ASR mismatch needs an explicit declared review (reviewer + scope) bound to the raw ASR evidence.`))
      } else if (review.reviewer_decision !== 'accepted') {
        errors.push(error(
          'ASR_REVIEW_NOT_ACCEPTED',
          `${source.id}: ASR review is ${review.reviewer_decision ?? 'pending'}; only an explicit accepted review with a scope allows 2K regeneration.`,
        ))
      }
      if (!isObject(report?.machine?.asr)) errors.push(error('ASR_RAW_EVIDENCE_REQUIRED', `${source.id}: ASR review needs retained raw ASR output.`))
    } else {
      errors.push(error('QC_NOT_REVIEWED', `${source.id}: ASR QC status is ${record.status ?? 'missing'}; record pass only for a machine match, or review_required with a declared review.`))
    }
  } else {
    const result = validateReviewRecord(report, { kind, sourceSha256: source.sha256 })
    if (!result.ok) errors.push(error('QC_REVIEW_SCHEMA', `${source.id}: ${kind} review evidence invalid: ${result.errors.join('; ')}`))
    if (record.status !== 'pass') errors.push(error('QC_NOT_PASS', `${source.id}: ${kind} QC status is ${record.status ?? 'missing'}, not pass.`))
    if (!isObject(record.review) || record.review.authority !== 'declared'
      || typeof record.review.reviewer !== 'string' || record.review.reviewer.trim().length === 0
      || typeof record.review.scope !== 'string' || record.review.scope.trim().length === 0) {
      errors.push(error('QC_REVIEW_AUTHORITY', `${source.id}: ${kind} needs a declared reviewer and scope.`))
    } else if (record.review.reviewer_decision !== 'accepted') {
      errors.push(error('QC_REVIEW_NOT_ACCEPTED', `${source.id}: ${kind} is ${record.review.reviewer_decision ?? 'pending'}, not accepted.`))
    }
  }
}
