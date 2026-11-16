/**
 * MiniMax H3 video tools for DeepSeek Harness.
 *
 * Six tools over one family of models:
 *   - video_models          catalog: tiers, resolution matrix, price, limits
 *   - video_prepare         offline preflight + estimate + one-shot plan
 *   - video_generate        text / first-last-frame / reference -> 4-15 s clip
 *   - video_task            query, wait, download, cancel or delete
 *   - video_regenerate      official 768P -> 2K regeneration
 *   - video_prompt_enhance  official H3-Context-IR prompt structuring
 *   - video_budget          cross-call budget ledger (status/create/amend/release)
 *
 * Paid work is protected by default and cannot be switched off by a call flag:
 * prompt/media/provenance preflight, a pre-submit estimate with an explicit
 * completeness status, a durable intent record before the network call, the
 * task id persisted atomically before polling, and duplicate/unknown-outcome
 * guards. A per-call `max_cost` and a persistent `budget_id` are both enforced
 * before any paid request.
 *
 * Local media is inlined as a data URI up to the per-asset limit; URLs and
 * `mm_file://` handles pass through. Video bytes never enter the conversation.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  MODEL_IDS,
  PROMPT_EXPANSION_MODES,
  RATIOS,
  RESOLUTIONS,
  catalogText,
  formatMoney,
  planGeneration,
  regionOf,
  validatePrompt,
  validateReferenceCounts,
} from './lib/catalog.js'
import { assertRequestSize } from './lib/media.js'
import { buildContextIrBody, buildGenerationBody, buildRegenerationBody } from './lib/request.js'
import { ApiError, MiniMaxVideoClient, describeUsage, pollTask, downloadVideo } from './lib/api.js'
import {
  buildMediaBundle,
  normalizeMediaArgs,
  operationFingerprint,
  requestFingerprint,
  sanitizeRequestBody,
  sanitizedAssets,
  snapshotLocalAssets,
} from './lib/assets.js'
import {
  assertNoErrors,
  checkDialogue,
  checkMediaContract,
  checkMediaDurations,
  costBound,
  currencyCodeOf,
  diagnostic,
  diagnosticsToLines,
  dialogueSpeechSeconds,
  enforceCostCap,
  estimateContextIr,
  estimateGeneration,
  estimateRegeneration,
  formatEstimate,
} from './lib/preflight.js'
import { probeMp4Duration } from './lib/mp4.js'
import { DuplicateSubmissionError, TaskJournal } from './lib/journal.js'
import { PlanStore } from './lib/plans.js'
import { BudgetLedger, formatBudget } from './lib/budget.js'
import { nowIso, randomToken, sha256Hex } from './lib/store.js'

export const name = 'minimax-video'
export const inject = ['tools', 'workingDirectory', 'credentials', 'skills']

const DEFAULT_CONFIG = {
  baseURL: 'https://api.minimax.cn',
  keyRef: 'MINIMAX_API_KEY',
  keyFile: undefined,
  defaultModel: 'MiniMax-H3',
  maxWaitSeconds: 900,
  pollIntervalMs: 10_000,
  stateDir: undefined,
  planTtlSeconds: 1_800,
  duplicateWindowSeconds: 600,
  inputSnapshotMaxBytes: 64 * 1024 * 1024,
  budgetId: undefined,
  approvedSources: undefined,
  approvedHosts: undefined,
  requireSourced: false,
  productionModule: undefined,
}

const SKILL_DIR = fileURLToPath(new URL('./skill/', import.meta.url))
const SKILL_FILE = fileURLToPath(new URL('./skill/SKILL.md', import.meta.url))
const PRODUCTION_SKILL_FILE = fileURLToPath(new URL('./skill/production-workflow.md', import.meta.url))
const PRODUCTION_FILE = fileURLToPath(new URL('./production/project.js', import.meta.url))

const SKILL_DESCRIPTION =
  'Plan, generate, and troubleshoot MiniMax H3 (Hailuo 3) video: model tiers, the 480P/768P/2K matrix, the three-field prompt with a shot timeline, camera language, dialogue and voiceover rules, content archetypes, and the official 768P-to-2K regeneration workflow.'

const skillCandidate = {
  name: 'minimax-video',
  description: SKILL_DESCRIPTION,
  whenToUse:
    'Load before writing or reviewing an H3 prompt, choosing a tier/resolution, directing camera moves, designing a multi-shot clip, or using 768P-to-2K regeneration.',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: 'dsh-minimax-video',
  source: 'bundled',
  resourceBase: { kind: 'directory', path: SKILL_DIR },
  rank: 600,
  locator: SKILL_FILE,
  path: SKILL_FILE,
}

const productionSkillCandidate = {
  name: 'ai-video-production',
  description:
    '启动/恢复任何 AI 视频或 AI 电影项目之前加载；角色/场景/关键帧/声线登记与本地技术 QA，以及 H3 付费提交前的项目登记检查。',
  whenToUse:
    '启动/恢复任何 AI 视频或 AI 电影项目之前加载；在登记角色/场景/关键帧/声线、做本地技术 QA、或发起 H3 付费请求之前加载。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: 'dsh-minimax-video',
  source: 'bundled',
  resourceBase: { kind: 'directory', path: SKILL_DIR },
  rank: 600,
  locator: PRODUCTION_SKILL_FILE,
  path: PRODUCTION_SKILL_FILE,
}

const skillProvider = {
  name: 'dsh-minimax-video',
  list() {
    return Promise.resolve([
      skillCandidate,
      ...(existsSync(PRODUCTION_SKILL_FILE) ? [productionSkillCandidate] : []),
    ])
  },
  async get(candidate) {
    const definition = candidate ?? skillCandidate
    const locator = definition.locator ?? definition.path ?? SKILL_FILE
    return { ...definition, content: await readFile(locator, 'utf8') }
  },
}

/** Read one key from a dotenv-style file, ignoring comments and blank values. */
function readDotenv(file, key) {
  if (file === undefined) return undefined
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (match === null || match[1] !== key) continue
    const value = match[2].replace(/^["']|["']$/g, '').trim()
    if (value.length > 0) return value
  }
  return undefined
}

/** Resolve one API key: credentials store first, then its dotenv file. */
async function resolveKey(ctx, cfg) {
  try {
    const credential = await ctx.credentials.resolve(cfg.keyRef)
    if (credential?.value) return credential.value
  } catch {
    // fall through to the dotenv file
  }
  const value = readDotenv(cfg.keyFile, cfg.keyRef)
  if (value) return value
  throw new Error(`${cfg.keyRef} is not available: set it in the credentials store or in ${cfg.keyFile}`)
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
}

function slugOf(text) {
  return (
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'video'
  )
}

function errorText(task) {
  if (task?.error === undefined || task.error === null) return undefined
  if (typeof task.error === 'string') return task.error
  return [task.error.code, task.error.message].filter((part) => part !== undefined).join(': ')
}

function summaryOf(task, extra = {}) {
  const error = errorText(task)
  return {
    task_id: String(task.id ?? extra.task_id ?? ''),
    status: String(task.status ?? 'unknown'),
    ...(task.model === undefined ? {} : { model: String(task.model) }),
    ...(task.resolution === undefined ? {} : { resolution: String(task.resolution) }),
    ...(typeof task.duration === 'number' ? { duration: task.duration } : {}),
    ...(task.ratio ? { ratio: String(task.ratio) } : {}),
    ...(task.task_type === undefined ? {} : { task_type: String(task.task_type) }),
    ...(task.content?.url === undefined ? {} : { url: String(task.content.url) }),
    ...(typeof task.content?.prompt === 'string' ? { prompt: task.content.prompt } : {}),
    ...(describeUsage(task) === undefined ? {} : { usage: describeUsage(task) }),
    ...(error === undefined ? {} : { error }),
    ...extra,
  }
}

function resolveWaitMs(args, cfg) {
  const requested = args.wait_seconds ?? cfg.maxWaitSeconds
  const seconds = Math.min(Math.max(Number(requested) || cfg.maxWaitSeconds, 10), cfg.maxWaitSeconds)
  return seconds * 1000
}

async function downloadResult(task, { outDir, stem, signal, existingFile }) {
  const url = task?.content?.url
  if (typeof url !== 'string' || url.length === 0) return {}
  try {
    const result = await downloadVideo(url, { directory: outDir, stem, signal, existingFile })
    return {
      file: result.file,
      bytes: result.bytes,
      sha256: result.sha256,
      ...(result.reused === true ? { note: `reused the previously saved download for this task (${result.file})` } : {}),
    }
  } catch (error) {
    return { note: `task succeeded but the download failed (${error.message}); call video_task with download true to retry` }
  }
}

/** Collision-free download stem: task id + millisecond clock + random segment. */
function downloadStem(taskId, prompt) {
  const safeId = String(taskId ?? 'task')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 40)
  return `${safeId}-${Date.now()}-${randomToken(2)}-${slugOf(prompt)}`
}

const outProperty = {
  type: 'string',
  description: 'Directory for the saved MP4, relative to the session working directory. Default generated-videos.',
}

function mediaProperties() {
  return {
    first_frame: {
      type: 'string',
      description:
        'First-frame image: local path or public URL. Pins the opening frame and makes the clip image-to-video; aspect ratio follows this image. Last frame requires a first frame. Cannot be combined with reference_*.',
    },
    last_frame: {
      type: 'string',
      description:
        'Last-frame image: local path or public URL. Pins the ending frame; requires first_frame. Describe the observable path from the first to the last image, not just both images.',
    },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Up to 9 reference images (local paths or URLs). Reference identity, costume, prop, environment or style; name them <Picture 1>... in the prompt. Cannot be combined with first_frame/last_frame.',
    },
    reference_videos: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Up to 3 reference clips, 2-15 s each and 15 s total, <= 50 MB each. Reference motion, camera structure or editing rhythm; name them <Video 1>... Their audio can be referenced too.',
    },
    reference_audio: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Up to 3 reference audio clips, 2-15 s each and 15 s total, <= 15 MB each. Reference voice timbre, music, rhythm or effect texture; name them <Audio 1>... Cannot be combined with first_frame/last_frame: for a recurring character voice use reference images plus this audio (see the skill reference continuity-and-voice.md).',
    },
  }
}

function contractProperties() {
  return {
    dialogue: {
      type: 'array',
      description:
        'Declared spoken lines, e.g. [{speaker:"小雅", line:"我们到了。"}]. Each line must appear verbatim in the prompt; the plugin estimates whether the lines fit the clip length.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          speaker: { type: 'string', required: true, description: 'Speaker name used in the prompt.' },
          line: { type: 'string', required: true, description: 'Exact spoken line that must appear in the prompt.' },
        },
      },
    },
    reference_roles: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Role/identity per reference asset, aligned to reference order (images, then videos, then audio). Use the same names as the prompt tags. Omitted means the role is declared by prompt tags only, not verified.',
    },
    source_declarations: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Provenance label per media input, aligned to submission order: first_frame, last_frame, reference_images..., reference_videos..., reference_audio..., base_video. Called with approved_sources, each label must be in that allowlist.',
    },
    approved_sources: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Allowlist of approved provenance labels. When set, source_declarations is required and every value must be listed; without it declarations are recorded but marked unverified.',
    },
    shot_id: {
      type: 'string',
      description:
        'Shot id in the project registry (cwd/.ai-video/project.json or project_manifest). Required when the registered project has shots.',
    },
    project_manifest: {
      type: 'string',
      description:
        'Explicit path to an AI-video project manifest, overriding automatic discovery. Registered projects require local, hash-verifiable, approved inputs.',
    },
    keyframe_override_reason: {
      type: 'string',
      description:
        'Specific reason (at least 12 characters) for not reusing an approved same-shot keyframe, or for using a video frame capture. Required by the project registry when an approved keyframe is not used.',
    },
  }
}

function assetIdProperties({ includeBaseVideo = false, includeSourceAsset = false } = {}) {
  return {
    asset_ids: {
      type: 'object',
      additionalProperties: false,
      description:
        'Explicit registered-project asset id per media slot, e.g. {"reference_images":["char1"],"first_frame":"kf1"}. Used only for registry approval/QC binding and plan approval; it never changes the API body.',
      properties: {
        first_frame: { type: 'string', description: 'Registered asset id for first_frame.' },
        last_frame: { type: 'string', description: 'Registered asset id for last_frame.' },
        reference_images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Registered asset ids aligned with reference_images.',
        },
        reference_videos: {
          type: 'array',
          items: { type: 'string' },
          description: 'Registered asset ids aligned with reference_videos.',
        },
        reference_audio: {
          type: 'array',
          items: { type: 'string' },
          description: 'Registered asset ids aligned with reference_audio.',
        },
        ...(includeBaseVideo
          ? { base_video: { type: 'string', description: 'Registered asset id for the base_video slot.' } }
          : {}),
      },
    },
    ...(includeSourceAsset
      ? {
          source_asset_id: {
            type: 'string',
            description:
              'Registered 768P source-video asset id for source_task_id regeneration. The local journal download hash must match its approved sha256; otherwise registered byTask regeneration is refused and the video mode is suggested. Registry/QC binding only, not an API body field.',
          },
        }
      : {}),
  }
}

function safetyProperties() {
  return {
    max_cost: {
      type: 'number',
      description:
        'Hard per-call cost cap in the region currency (CNY on api.minimax.cn, USD on api.minimax.io). Checked before credentials or any network call; partial estimates are checked at their worst-case bound.',
    },
    allow_unbounded_cost: {
      type: 'boolean',
      description:
        'Explicitly accept a token-priced operation (Context-IR) with no pre-call bound. Requires override_reason, cannot be combined with max_cost or a budget, and is recorded in the task journal.',
    },
  }
}

function planProperties() {
  return {
    dry_run: {
      type: 'boolean',
      description:
        'Prepare only: run every offline check, return the estimate and a plan_id, and make no paid call. Submit later by passing plan_id with the same arguments.',
    },
    plan_id: {
      type: 'string',
      description:
        'Execute a prepared plan exactly once. Re-supply the same arguments; a changed prompt/media/settings/cap or a consumed/expired plan is rejected.',
    },
  }
}

function overrideProperties() {
  return {
    override_reason: {
      type: 'string',
      description:
        'Required with allow_duplicate_risk or allow_unbounded_cost. A concrete reason recorded in the journal and audit trail.',
    },
    prior_record_id: {
      type: 'string',
      description:
        'Required with allow_duplicate_risk: the record_id of the blocked unknown-outcome submission that the caller has checked.',
    },
    allow_duplicate: {
      type: 'boolean',
      description: 'Submit the same request again even though an identical submission was made within the duplicate window. Recorded in the journal audit.',
    },
    allow_duplicate_risk: {
      type: 'boolean',
      description:
        'Proceed despite a previous identical submission with an unknown outcome. Requires override_reason and prior_record_id; this accepts the duplicate-charge risk.',
    },
  }
}

function taskOutputSchema(extra = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      task_id: { type: 'string', required: true },
      status: { type: 'string', required: true },
      model: { type: 'string' },
      resolution: { type: 'string' },
      duration: { type: 'integer' },
      ratio: { type: 'string' },
      task_type: { type: 'string' },
      mode: { type: 'string' },
      url: { type: 'string' },
      file: { type: 'string' },
      prompt: { type: 'string' },
      usage: { type: 'string' },
      estimate: { type: 'string' },
      cost_status: { type: 'string' },
      cost_cap: { type: 'string' },
      budget: { type: 'string' },
      record_id: { type: 'string' },
      plan_id: { type: 'string' },
      diagnostics: { type: 'array', items: { type: 'string' } },
      action: { type: 'string' },
      note: { type: 'string' },
      error: { type: 'string' },
      ...extra,
    },
  }
}

function prepareOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      plan_id: { type: 'string', required: true },
      status: { type: 'string', required: true },
      kind: { type: 'string', required: true },
      estimate: { type: 'string' },
      cost_status: { type: 'string' },
      cost_cap: { type: 'string' },
      budget: { type: 'string' },
      model: { type: 'string' },
      resolution: { type: 'string' },
      duration: { type: 'integer' },
      ratio: { type: 'string' },
      mode: { type: 'string' },
      requested_duration: { type: 'integer' },
      source_actual_duration: { type: 'number' },
      source_duration_declared: { type: 'number' },
      estimated_speech_seconds: { type: 'number' },
      project: { type: 'string' },
      original_inputs_unknown: { type: 'boolean' },
      expires_at: { type: 'string' },
      diagnostics: { type: 'array', items: { type: 'string' } },
      note: { type: 'string' },
    },
  }
}

function renderTask(_args, value) {
  const bits = [`${value.task_id}: ${value.status}`]
  if (value.mode) bits.push(value.mode)
  if (value.resolution) bits.push(value.resolution)
  if (value.duration) bits.push(`${value.duration}s`)
  if (value.file) bits.push(`saved ${value.file}`)
  else if (value.url) bits.push(value.url)
  if (value.usage) bits.push(value.usage)
  if (value.estimate) bits.push(`estimated ${value.estimate}`)
  if (value.record_id) bits.push(`record ${value.record_id}`)
  if (value.error) bits.push(`error ${value.error}`)
  if (value.note) bits.push(value.note)
  const lines = [bits.join(' | ')]
  if (value.diagnostics?.length > 0) {
    lines.push('diagnostics:')
    for (const entry of value.diagnostics) lines.push(`- ${entry}`)
  }
  if (value.prompt !== undefined) lines.push('', value.prompt)
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderPrepared(_args, value) {
  const lines = [
    `${value.status}: ${value.kind} ${value.model ?? ''} ${value.resolution ?? ''} ${value.duration ?? ''}s`.replace(/\s+/g, ' ').trim(),
    `plan_id: ${value.plan_id}`,
    `estimate: ${value.estimate ?? 'unknown'}`,
    ...(value.cost_cap === undefined ? [] : [`hard cap: ${value.cost_cap}`]),
    ...(value.budget === undefined ? [] : [value.budget]),
    ...(value.original_inputs_unknown === true
      ? ['original inputs: unreviewable (upper includes max 15s reference video + 9 images)']
      : []),
    ...(value.requested_duration == null
      ? []
      : [
          `duration: requested ${value.requested_duration}s; measured source ${value.source_actual_duration ?? 'unknown'}${value.source_duration_declared == null ? '' : `; declared ${value.source_duration_declared}s (not a measurement)`}${value.estimated_speech_seconds == null ? '' : `; speech heuristic ${value.estimated_speech_seconds}s`}`,
        ]),
    ...(value.expires_at === undefined ? [] : [`expires: ${value.expires_at}`]),
  ]
  if (value.diagnostics?.length > 0) {
    lines.push('diagnostics:')
    for (const entry of value.diagnostics) lines.push(`- ${entry}`)
  }
  if (value.note) lines.push(value.note)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  // DSH sets DSH_PROFILE_DIR for a profile-launched Harness, but not always
  // DSH_HOME (the Desktop app process leaves it unset). The profile lives at
  // <DSH_HOME>/profiles/<name>, so two dirname calls recover it.
  const dshHome =
    process.env.DSH_HOME ||
    (process.env.DSH_PROFILE_DIR
      ? dirname(dirname(process.env.DSH_PROFILE_DIR))
      : join(homedir(), '.dsh'))
  cfg.keyFile = cfg.keyFile ?? join(dshHome, 'secrets', 'minimax.env')
  if (cfg.approvedSources !== undefined && !Array.isArray(cfg.approvedSources)) {
    throw new Error('approvedSources config must be an array of provenance labels')
  }
  if (cfg.approvedHosts !== undefined && !Array.isArray(cfg.approvedHosts)) {
    throw new Error('approvedHosts config must be an array of host patterns')
  }
  const region = regionOf(cfg.baseURL)
  const currency = currencyCodeOf(region)
  const configuredStateDir = cfg.stateDir ?? join(dshHome, 'state', 'dsh-minimax-video')
  const stateDir = isAbsolute(configuredStateDir) ? configuredStateDir : resolve(process.cwd(), configuredStateDir)
  const journal = new TaskJournal(join(stateDir, 'journal'))
  const plans = new PlanStore({ dir: join(stateDir, 'plans'), ttlSeconds: Number(cfg.planTtlSeconds) || 1800 })
  const budgets = new BudgetLedger(join(stateDir, 'budgets'))
  const productionModule = cfg.productionModule === undefined ? PRODUCTION_FILE : resolve(String(cfg.productionModule))
  let productionImport

  ctx.skills.registerProvider(() => skillProvider)

  const makeClient = async (signal) => {
    const key = await resolveKey(ctx, cfg)
    return new MiniMaxVideoClient({ baseURL: cfg.baseURL, key, signal })
  }

  function toolCwd(exec) {
    return exec.agent === undefined ? process.cwd() : ctx.workingDirectory.ensure(exec.agent, exec.signal)
  }

  function outDirFor(cwd, args) {
    return args.out_dir === undefined ? join(cwd, 'generated-videos') : resolve(cwd, args.out_dir)
  }

  function normalizeSourceList(value) {
    if (!Array.isArray(value)) return undefined
    const list = value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
    return list.length > 0 ? list : undefined
  }

  /**
   * Resolve contract declarations for one call. A configured site/project
   * allowlist is the ceiling: a per-call `approved_sources` may narrow it but
   * cannot widen or replace it. Declarations are still recorded, but no call can
   * turn a configured-unverified source into a verified one.
   */
  function contractOf(args, diagnostics = []) {
    const configured = normalizeSourceList(cfg.approvedSources)
    const requested = normalizeSourceList(args.approved_sources)
    let approvedSources = requested
    if (configured !== undefined) {
      if (approvedSources === undefined) {
        approvedSources = configured
      } else {
        const outside = approvedSources.filter((entry) => !configured.includes(entry))
        if (outside.length > 0) {
          diagnostics.push(
            diagnostic(
              'error',
              'approved_sources_scope',
              `approved_sources contains ${outside.join(', ')}, outside the configured allowlist (${configured.join(', ')}); a call cannot widen or replace the configured source allowlist`,
            ),
          )
        }
        approvedSources = approvedSources.filter((entry) => configured.includes(entry))
      }
    }
    return {
      dialogue: args.dialogue,
      referenceRoles: args.reference_roles,
      sourceDeclarations: args.source_declarations,
      approvedSources,
      approvedHosts: cfg.approvedHosts,
      requireSourced: cfg.requireSourced === true,
      approvedSourcesRequested: requested,
      assetIds: args.asset_ids,
      sourceAssetId: args.source_asset_id,
    }
  }

  function contractRecord(args, effectiveApprovedSources) {
    return {
      dialogue: args.dialogue ?? null,
      reference_roles: args.reference_roles ?? null,
      source_declarations: args.source_declarations ?? null,
      approved_sources: args.approved_sources ?? null,
      approved_sources_effective: effectiveApprovedSources ?? null,
      shot_id: args.shot_id ?? null,
      project_manifest: args.project_manifest ?? null,
      keyframe_override_reason: args.keyframe_override_reason ?? null,
      asset_ids: args.asset_ids ?? null,
      source_asset_id: args.source_asset_id ?? null,
    }
  }

  function diagnosticsFromProduction(result) {
    const diagnostics = []
    for (const issueEntry of result.issues ?? []) {
      if (typeof issueEntry === 'string') {
        diagnostics.push(diagnostic('error', 'production_issue', issueEntry))
        continue
      }
      diagnostics.push(
        diagnostic(
          issueEntry.level === 'warn' ? 'warn' : 'error',
          String(issueEntry.code ?? 'production_issue'),
          String(issueEntry.message ?? ''),
        ),
      )
    }
    for (const warning of result.warnings ?? []) {
      if (typeof warning === 'string') {
        diagnostics.push(diagnostic('info', 'production_warning', warning))
        continue
      }
      diagnostics.push(
        diagnostic(
          warning.code === 'NO_PROJECT_REGISTRY' ? 'info' : 'warn',
          String(warning.code ?? 'production_warning'),
          String(warning.message ?? ''),
        ),
      )
    }
    return diagnostics
  }

  /**
   * Run the project registry validator (synchronous, bundled with this plugin).
   *
   * The validator is packaged, so a missing/broken validator is always a hard
   * failure: no cwd-shape shortcut, no ancestor-registry bypass, no unverified
   * fallback. The module's own findProject walks ancestors, so a registry above
   * the workspace cannot be missed by checking only cwd/.ai-video. With no
   * registry anywhere it returns project:null and the general-purpose path
   * continues under the journal/budget/preflight protections.
   */
  async function runProduction(cwd, args, prompt) {
    if (!existsSync(productionModule)) {
      throw new Error(
        'the production validator (production/project.js) is missing from this plugin install; refusing paid/prepare operations because project approvals, keyframe reuse and 2K source QC cannot be checked. Reinstall or upgrade dsh-minimax-video',
      )
    }
    let module
    try {
      productionImport ??= import(pathToFileURL(productionModule).href)
      module = await productionImport
    } catch (error) {
      throw new Error(`production validator failed to load (${productionModule}): ${error.message}`)
    }
    if (typeof module.validateProductionInputs !== 'function') {
      throw new Error(`production validator ${productionModule} does not export validateProductionInputs; refusing unverified submission`)
    }
    let result
    try {
      result = module.validateProductionInputs({ cwd, args, prompt })
    } catch (error) {
      throw new Error(`production validation failed: ${error.message}`)
    }
    if (result === null || typeof result !== 'object') {
      throw new Error('validateProductionInputs returned no result')
    }
    return {
      project: result.project ?? null,
      shot: result.shot ?? null,
      issues: Array.isArray(result.issues) ? result.issues : [],
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      assets: Array.isArray(result.assets) ? result.assets : [],
      available: true,
    }
  }

  /** Resolve the budget that governs this call: manifest > explicit > config. */
  function resolveBudget(args, production) {
    const projectBudget = production?.project?.budget ?? null
    const explicit = args.budget_id
    if (projectBudget !== null && explicit !== undefined && explicit !== projectBudget.id) {
      throw new Error(
        `this project declares budget "${projectBudget.id}"; a call cannot switch to budget "${explicit}". Use the declared budget or update the manifest`,
      )
    }
    const budgetId = projectBudget?.id ?? explicit ?? cfg.budgetId
    if (budgetId === undefined || budgetId === null || String(budgetId).trim().length === 0) return null
    let document
    if (projectBudget !== null && projectBudget.id === budgetId) {
      if (!Number.isFinite(projectBudget.limit) || projectBudget.limit <= 0) {
        throw new Error('the project manifest budget needs a positive limit')
      }
      budgets.ensure({
        budgetId: String(budgetId),
        limit: projectBudget.limit,
        currency: projectBudget.currency,
        note: 'project manifest budget',
        source: 'project_manifest',
      })
      document = budgets.load(String(budgetId))
    } else {
      document = budgets.load(String(budgetId))
    }
    if (document.currency !== currency) {
      throw new Error(
        `budget "${document.budget_id}" is in ${document.currency}, but baseURL ${cfg.baseURL} bills in ${currency}`,
      )
    }
    return { budgetId: document.budget_id, ledger: budgets, document, summary: budgets.summary(document.budget_id) }
  }

  function appendBudgetPrecheck(diagnostics, estimate, budget) {
    if (budget === null) return
    if (estimate.status === 'unknown') return
    const amount = costBound(estimate)
    const precheck = budget.ledger.precheck(budget.budgetId, amount, currency)
    diagnostics.push(
      diagnostic(
        'info',
        'budget_prechecked',
        `${formatBudget(precheck)}; this call reserves up to ${amount.toFixed(2)} ${currency}`,
      ),
    )
  }

  function prepareResult(kind, prep) {
    const plan = plans.write({
      kind,
      fingerprint: prep.planFingerprint,
      request_fingerprint: prep.requestFingerprint,
      plan: prep.plan ?? null,
      estimate: prep.estimate,
      estimate_line: formatEstimate(prep.estimate),
      cap: prep.maxCost ?? null,
      budget_id: prep.budget?.budgetId ?? null,
      original_task_id: prep.originalTaskId ?? null,
      diagnostics: diagnosticsToLines(prep.diagnostics),
      project: prep.production?.project
        ? { id: prep.production.project.id, shot_id: prep.production.shot?.id ?? null }
        : null,
      currency: prep.estimate.currency,
    })
    return {
      plan_id: plan.plan_id,
      status: 'prepared',
      kind,
      estimate: formatEstimate(prep.estimate),
      cost_status: prep.estimate.status,
      ...(prep.maxCost === undefined
        ? {}
        : { cost_cap: `${formatMoney(prep.maxCost, region)} ${currency} hard` }),
      ...(prep.budget === null || prep.budget === undefined ? {} : { budget: formatBudget(prep.budget.summary) }),
      ...(prep.plan?.model === undefined ? {} : { model: prep.plan.model }),
      ...(prep.plan?.resolution === undefined ? {} : { resolution: prep.plan.resolution }),
      ...(typeof prep.plan?.duration === 'number' ? { duration: prep.plan.duration } : {}),
      ...(prep.plan?.ratio === undefined ? {} : { ratio: prep.plan.ratio }),
      ...(prep.plan?.mode === undefined ? {} : { mode: prep.plan.mode }),
      ...(prep.durationContext?.requested_duration == null
        ? {}
        : { requested_duration: prep.durationContext.requested_duration }),
      ...(prep.durationContext?.source_actual_duration == null
        ? {}
        : { source_actual_duration: prep.durationContext.source_actual_duration }),
      ...(prep.durationContext?.source_duration_declared == null
        ? {}
        : { source_duration_declared: prep.durationContext.source_duration_declared }),
      ...(prep.durationContext?.estimated_speech_seconds == null
        ? {}
        : { estimated_speech_seconds: prep.durationContext.estimated_speech_seconds }),
      ...(prep.originalInputsUnknown === true ? { original_inputs_unknown: true } : {}),
      ...(prep.production?.project === null || prep.production?.project === undefined
        ? {}
        : { project: `${prep.production.project.id ?? 'project'}${prep.production.shot?.id ? ` shot ${prep.production.shot.id}` : ''}` }),
      expires_at: plan.expires_at,
      diagnostics: diagnosticsToLines(prep.diagnostics),
      note: 'no paid call was made. Submit once by calling the same tool with plan_id and the same arguments; runtime controls (wait, wait_seconds, download, out_dir) may change.',
    }
  }

  function measuredSourceDuration(record, baseAsset) {
    if (baseAsset?.durationSeconds !== undefined) return baseAsset.durationSeconds
    const file = record?.download?.file
    if (typeof file !== 'string') return undefined
    try {
      if (statSync(file).size > 64 * 1024 * 1024) return undefined
      return probeMp4Duration(readFileSync(file))
    } catch {
      return undefined
    }
  }

  function durationContext(requested, sourceActual, dialogue, declared) {
    return {
      requested_duration: Number.isFinite(requested) ? requested : null,
      source_actual_duration: Number.isFinite(sourceActual) ? Number(sourceActual.toFixed(3)) : null,
      source_duration_declared: Number.isFinite(declared) ? Number(declared.toFixed(3)) : null,
      estimated_speech_seconds: dialogueSpeechSeconds(dialogue) ?? null,
      speech_estimate: 'heuristic',
    }
  }

  async function prepareGenerate(cwd, args) {
    args = normalizeMediaArgs(args)
    validatePrompt(args.prompt)
    validateReferenceCounts(args)
    const bundle = buildMediaBundle(cwd, args)
    const production = await runProduction(cwd, args, args.prompt)
    const plan = planGeneration({
      model: args.model ?? cfg.defaultModel,
      resolution: args.resolution,
      duration: args.duration ?? 5,
      ratio: args.ratio,
      promptExpansion: args.prompt_expansion,
      ...bundle.sources,
    })
    const body = buildGenerationBody(plan, args.prompt, bundle.sources)
    assertRequestSize(body)
    const requestedDuration = plan.duration
    const diagnostics = [...diagnosticsFromProduction(production)]
    const contract = contractOf(args, diagnostics)
    diagnostics.push(
      ...checkDialogue({
        prompt: args.prompt,
        dialogue: args.dialogue,
        duration: requestedDuration,
        requestedDuration,
        sourceActualDuration: undefined,
      }),
      ...checkMediaContract({
        prompt: args.prompt,
        assets: bundle.assets,
        ...contract,
        strict: production.project !== null,
      }),
      ...checkMediaDurations(bundle.assets),
    )
    const estimate = estimateGeneration({ plan, assets: bundle.assets, region })
    const budget = resolveBudget(args, production)
    diagnostics.push(
      ...enforceCostCap({
        estimate,
        maxCost: args.max_cost,
        hasBudget: budget !== null,
        allowUnboundedCost: args.allow_unbounded_cost === true,
        overrideReason: args.override_reason,
      }),
    )
    appendBudgetPrecheck(diagnostics, estimate, budget)
    assertNoErrors(diagnostics)
    const requestFingerprintValue = requestFingerprint({
      kind: 'generate',
      plan,
      prompt: args.prompt,
      assets: bundle.assets,
    })
    const planFingerprintValue = operationFingerprint({
      kind: 'generate',
      plan,
      prompt: args.prompt,
      assets: bundle.assets,
      maxCost: args.max_cost ?? null,
      budgetId: budget?.budgetId ?? null,
      contract,
    })
    return {
      kind: 'generate',
      plan,
      assets: bundle.assets,
      sources: bundle.sources,
      body,
      production,
      estimate,
      budget,
      diagnostics,
      requestFingerprint: requestFingerprintValue,
      planFingerprint: planFingerprintValue,
      contract,
      maxCost: args.max_cost,
      prompt: args.prompt,
      durationContext: durationContext(requestedDuration, undefined, args.dialogue),
      outDir: outDirFor(cwd, args),
      stem: `${timestamp()}-${slugOf(args.prompt)}`,
      cwd,
    }
  }

  async function prepareRegenerate(cwd, args) {
    args = normalizeMediaArgs(args)
    const byTask = args.source_task_id !== undefined
    const byVideo = args.video !== undefined
    if (byTask === byVideo) throw new Error('provide exactly one of source_task_id or video')
    if (byTask) {
      const hasContent =
        args.prompt !== undefined ||
        args.first_frame !== undefined ||
        args.last_frame !== undefined ||
        (args.reference_images?.length ?? 0) > 0 ||
        (args.reference_videos?.length ?? 0) > 0 ||
        (args.reference_audio?.length ?? 0) > 0
      if (hasContent) throw new Error('source_task_id mode resubmits no content; omit prompt, frames and references')
    } else {
      validatePrompt(args.prompt)
      validateReferenceCounts(args)
    }
    validateReferenceCounts(args)
    const bundle = buildMediaBundle(cwd, args, { includeBaseVideo: byVideo })
    const prompt = byVideo ? args.prompt : undefined
    const production = await runProduction(cwd, args, prompt ?? '')
    // Resolve the original generation record: explicit original_task_id first,
    // otherwise the source_task_id itself. A byTask request with no record still
    // has an unknown original input footprint and must be bounded, not assumed 0.
    let record
    if (args.original_task_id !== undefined) record = findOriginalRecord(args.original_task_id)
    else if (byTask) record = findOriginalRecord(args.source_task_id)
    if (args.original_task_id !== undefined && record === undefined) {
      throw new Error(
        `original_task_id "${args.original_task_id}" has no local record; a regeneration consistency check is required, so prepare the source generation through this plugin first`,
      )
    }
    const originalInputsUnknown = byTask && record === undefined
    const resolvedOriginalTaskId = args.original_task_id ?? record?.task_id ?? null
    const baseAsset = bundle.assets.find((asset) => asset.slot === 'base_video')
    // Local container bytes or a trusted downloaded record are measurements.
    // A caller-supplied duration is a declaration only: it is displayed and
    // cross-checked, never used to replace a measurement or to upgrade an
    // unknown-duration estimate to complete.
    const measuredSource = measuredSourceDuration(record, baseAsset)
    let declaredSource
    if (args.source_duration_seconds !== undefined) {
      const value = Number(args.source_duration_seconds)
      if (value === 0) {
        // Native tool interfaces serialize every field; 0 means "not provided",
        // not a 0-second real source (H3 sources are at least 4 s). Treat it as
        // unknown; a positive low declaration still goes through the mismatch /
        // upper-bound mechanism and cannot lower a cap.
        declaredSource = undefined
      } else if (!Number.isFinite(value) || value < 0) {
        throw new Error('source_duration_seconds must be a positive number of seconds, or 0 for not provided')
      } else {
        declaredSource = value
      }
    }
    const diagnostics = [
      ...diagnosticsFromProduction(production),
      ...checkMediaDurations(bundle.assets),
    ]
    if (originalInputsUnknown) {
      diagnostics.push(
        diagnostic(
          'warn',
          'original_inputs_unverified',
          'source_task_id has no local generation record: original reference-video and image usage cannot be reviewed. The floor claims no such inputs; the upper bound uses the API maximum of 15 s original reference video and 9 images (5 free), so a cap below that upper bound is refused',
        ),
      )
    } else if (byTask && args.original_task_id === undefined) {
      diagnostics.push(
        diagnostic(
          'info',
          'original_record_found',
          `resolved source_task_id to local generation record ${record.record_id}; original reference-video/image usage is taken from that record`,
        ),
      )
    }
    if (declaredSource !== undefined) {
      if (measuredSource !== undefined) {
        const tolerance = Math.max(0.25, measuredSource * 0.02)
        if (Math.abs(declaredSource - measuredSource) > tolerance) {
          diagnostics.push(
            diagnostic(
              'error',
              'source_duration_mismatch',
              `source_duration_seconds ${declaredSource}s conflicts with the measured local/recorded source duration ${measuredSource.toFixed(2)}s; the measurement governs the cost bound and the declared value cannot lower it`,
            ),
          )
        } else {
          diagnostics.push(
            diagnostic(
              'info',
              'source_duration_declared_matches',
              `declared source duration ${declaredSource}s matches the measured ${measuredSource.toFixed(2)}s`,
            ),
          )
        }
      } else {
        diagnostics.push(
          diagnostic(
            'warn',
            'source_duration_declared_only',
            `declared source duration ${declaredSource}s is unverified: no local container or trusted download was measured, so the estimate stays partial with the 15 s API upper bound and the declared value cannot lower the reservation`,
          ),
        )
      }
    }
    const contract = contractOf(args, diagnostics)
    if (byVideo) {
      diagnostics.push(
        ...checkDialogue({
          prompt,
          dialogue: args.dialogue,
          duration: measuredSource,
          requestedDuration: record?.plan?.duration,
          sourceActualDuration: measuredSource,
        }),
      )
      diagnostics.push(
        ...checkMediaContract({
          prompt,
          assets: bundle.assets,
          ...contract,
          strict: production.project !== null,
        }),
      )
    }
    if (record !== undefined) diagnostics.push(...checkRegenerationDrift(record, args, bundle, byVideo))
    if (byTask) diagnostics.push(...checkRegisteredByTaskBinding(production, record, args))
    // Contract/duration errors should surface before a cap error so the caller
    // sees the root cause; neither path reaches the network.
    assertNoErrors(diagnostics)
    const recordAssets = record?.assets ?? []
    const referenceAssets = byVideo
      ? bundle.assets.filter((asset) => asset.slot === 'reference_video')
      : recordAssets.filter((asset) => asset.slot === 'reference_video')
    const referenceVideoSeconds = referenceAssets.reduce((sum, asset) => {
      const value = asset.durationSeconds ?? asset.duration_seconds
      return sum + (Number.isFinite(value) ? value : 0)
    }, 0)
    const unknownReferenceVideos = referenceAssets.filter((asset) => {
      const value = asset.durationSeconds ?? asset.duration_seconds
      return !Number.isFinite(value)
    }).length
    const imageCount = byVideo
      ? bundle.assets.filter((asset) => asset.kind === 'image').length
      : recordAssets.filter((asset) => asset.kind === 'image').length
    const estimate = estimateRegeneration({
      assets: bundle.assets,
      region,
      originalDuration: measuredSource,
      imageCount,
      referenceVideoSeconds,
      unknownReferenceVideos,
      originalInputsUnknown,
    })
    const budget = resolveBudget(args, production)
    diagnostics.push(
      ...enforceCostCap({
        estimate,
        maxCost: args.max_cost,
        hasBudget: budget !== null,
        allowUnboundedCost: args.allow_unbounded_cost === true,
        overrideReason: args.override_reason,
      }),
    )
    appendBudgetPrecheck(diagnostics, estimate, budget)
    assertNoErrors(diagnostics)
    const body = byTask
      ? buildRegenerationBody({ sourceTaskId: args.source_task_id })
      : buildRegenerationBody({ baseVideo: bundle.assets.find((asset) => asset.slot === 'base_video').url, prompt, sources: bundle.sources })
    assertRequestSize(body)
    const regenPlan = { model: 'MiniMax-H3', resolution: '2K', duration: measuredSource ?? null }
    const requestFingerprintValue = requestFingerprint({
      kind: 'regenerate',
      // The regeneration body carries no duration; a measured source duration
      // belongs to the approved plan, not to duplicate protection of the payload.
      plan: { model: 'MiniMax-H3', resolution: '2K' },
      prompt: prompt ?? null,
      assets: bundle.assets,
      sourceTaskId: byTask ? args.source_task_id : null,
    })
    const planFingerprintValue = operationFingerprint({
      kind: 'regenerate',
      plan: regenPlan,
      prompt: prompt ?? null,
      assets: bundle.assets,
      sourceTaskId: byTask ? args.source_task_id : null,
      originalTaskId: resolvedOriginalTaskId,
      sourceDurationSeconds: measuredSource ?? null,
      maxCost: args.max_cost ?? null,
      budgetId: budget?.budgetId ?? null,
      contract,
    })
    return {
      kind: 'regenerate',
      byTask,
      plan: { model: 'MiniMax-H3', resolution: '2K', duration: measuredSource, mode: byVideo ? 'reference' : 'source_task' },
      assets: bundle.assets,
      sources: bundle.sources,
      body,
      production,
      estimate,
      budget,
      diagnostics,
      requestFingerprint: requestFingerprintValue,
      planFingerprint: planFingerprintValue,
      contract,
      maxCost: args.max_cost,
      prompt,
      originalTaskId: resolvedOriginalTaskId,
      originalRecordId: record?.record_id,
      originalInputsUnknown,
      durationContext: durationContext(record?.plan?.duration, measuredSource, args.dialogue, declaredSource),
      outDir: outDirFor(cwd, args),
      stem: `${timestamp()}-${slugOf(prompt ?? 'regenerated')}-2k`,
      cwd,
    }
  }

  async function prepareEnhance(cwd, args) {
    args = normalizeMediaArgs(args)
    validatePrompt(args.prompt)
    validateReferenceCounts(args)
    const bundle = buildMediaBundle(cwd, args)
    const production = await runProduction(cwd, args, args.prompt)
    const plan = planGeneration({
      model: 'MiniMax-H3',
      resolution: '768P',
      duration: args.duration ?? 5,
      ratio: args.ratio,
      ...bundle.sources,
    })
    const body = buildContextIrBody(plan, args.prompt, bundle.sources)
    assertRequestSize(body)
    const diagnostics = [...diagnosticsFromProduction(production)]
    const contract = contractOf(args, diagnostics)
    diagnostics.push(
      ...checkMediaContract({
        prompt: args.prompt,
        assets: bundle.assets,
        ...contract,
        strict: production.project !== null,
      }),
      ...checkMediaDurations(bundle.assets),
    )
    const estimate = estimateContextIr({ region })
    const budget = resolveBudget(args, production)
    diagnostics.push(
      ...enforceCostCap({
        estimate,
        maxCost: args.max_cost,
        hasBudget: budget !== null,
        allowUnboundedCost: args.allow_unbounded_cost === true,
        overrideReason: args.override_reason,
      }),
    )
    assertNoErrors(diagnostics)
    const requestFingerprintValue = requestFingerprint({
      kind: 'prompt_enhance',
      plan,
      prompt: args.prompt,
      assets: bundle.assets,
    })
    const planFingerprintValue = operationFingerprint({
      kind: 'prompt_enhance',
      plan,
      prompt: args.prompt,
      assets: bundle.assets,
      maxCost: args.max_cost ?? null,
      budgetId: budget?.budgetId ?? null,
      contract,
    })
    return {
      kind: 'prompt_enhance',
      plan,
      assets: bundle.assets,
      sources: bundle.sources,
      body,
      production,
      estimate,
      budget,
      diagnostics,
      requestFingerprint: requestFingerprintValue,
      planFingerprint: planFingerprintValue,
      contract,
      maxCost: args.max_cost,
      prompt: args.prompt,
      durationContext: durationContext(plan.duration, undefined, undefined),
      cwd,
    }
  }

  function findOriginalRecord(identifier) {
    return journal.findByTaskId(identifier) ?? journal.findByRecordId(identifier)
  }

  /**
   * A registered byTask regeneration binds a local QC asset to a remote task.
   * A local approved asset alone is not proof that it is the remote task's
   * downloaded output: require a journaled download hash and match it against
   * the production source asset. Without that proof, refuse and point to the
   * local video mode instead of letting asset A stand in for remote task B.
   */
  function checkRegisteredByTaskBinding(production, record, args) {
    const diagnostics = []
    if (production?.project === null || production?.project === undefined) return diagnostics
    if (args.source_task_id === undefined) return diagnostics
    const sourceTaskId = String(args.source_task_id)
    const sourceAsset = (production.assets ?? []).find(
      (asset) => asset?.usage === 'source_task_id' || asset?.slot === 'source_asset',
    )
    if (record === undefined) {
      diagnostics.push(
        diagnostic(
          'error',
          'registered_bytask_record_missing',
          `source_task_id ${sourceTaskId} has no local generation record in a registered project, so no local task download can be proven to match the registered QC source. Submit the local 768P file with the video mode instead`,
        ),
      )
      return diagnostics
    }
    if (typeof record.download?.sha256 !== 'string') {
      diagnostics.push(
        diagnostic(
          'error',
          'registered_bytask_download_missing',
          `local record ${record.record_id} for source_task_id ${sourceTaskId} has no journaled download sha256, so the registered source asset cannot be proven to be this task's output. Use the video mode with the local 768P file instead`,
        ),
      )
      return diagnostics
    }
    if (sourceAsset === undefined) {
      diagnostics.push(
        diagnostic(
          'error',
          'registered_bytask_source_unbound',
          `production did not resolve a source_asset for source_task_id ${sourceTaskId}; pass source_asset_id naming the registered 768P source, or use the video mode`,
        ),
      )
      return diagnostics
    }
    if (String(sourceAsset.sha256 ?? '').toLowerCase() !== record.download.sha256.toLowerCase()) {
      diagnostics.push(
        diagnostic(
          'error',
          'source_asset_sha_mismatch',
          `source asset ${sourceAsset.id ?? '?'} sha256 does not match the local download sha256 of task ${sourceTaskId} (record ${record.record_id}); a local asset cannot stand in for another task's output. Use the video mode or bind the correct source`,
        ),
      )
    }
    const declaredTask = sourceAsset.task_id ?? sourceAsset.provenance?.task_id
    if (declaredTask !== undefined && String(declaredTask) !== sourceTaskId) {
      diagnostics.push(
        diagnostic(
          'error',
          'source_asset_task_mismatch',
          `source asset ${sourceAsset.id ?? '?'} is bound to task ${declaredTask}, not source_task_id ${sourceTaskId}; QC assets cannot be reused across remote tasks`,
        ),
      )
    }
    return diagnostics
  }

  /** Reject a 2K pass whose prompt/media no longer match the recorded source. */
  function checkRegenerationDrift(record, args, bundle, byVideo) {
    const diagnostics = []
    const promptHash = byVideo && typeof args.prompt === 'string' ? sha256Hex(args.prompt) : undefined
    if (byVideo) {
      if (record.prompt?.sha256 !== undefined && promptHash !== record.prompt.sha256) {
        diagnostics.push(
          diagnostic(
            'error',
            'regeneration_prompt_drift',
            `regeneration prompt differs from the source generation record ${record.record_id}; the official 2K pass requires the exact final prompt used for the 768P source`,
          ),
        )
      }
      for (const asset of bundle.assets) {
        if (asset.slot === 'base_video') continue
        const recorded = (record.assets ?? []).find((entry) => entry.slot === asset.slot && entry.kind === asset.kind)
        if (recorded?.sha256 !== asset.sha256) {
          diagnostics.push(
            diagnostic(
              'error',
              'regeneration_input_drift',
              `${asset.slot} bytes differ from the source generation record ${record.record_id}; resubmit the original media`,
            ),
          )
        }
      }
      const base = bundle.assets.find((asset) => asset.slot === 'base_video')
      if (base !== undefined && record.download?.sha256 !== undefined && base.sha256 !== record.download.sha256) {
        diagnostics.push(
          diagnostic(
            'error',
            'regeneration_source_drift',
            `base_video does not match the file downloaded for the source generation record ${record.record_id}`,
          ),
        )
      }
    }
    if (args.source_task_id !== undefined && record.task_id !== undefined && String(args.source_task_id) !== String(record.task_id)) {
      diagnostics.push(
        diagnostic(
          'warn',
          'regeneration_task_mismatch',
          `source_task_id ${args.source_task_id} differs from record ${record.record_id} task ${record.task_id}; the local consistency check covers the recorded generation, not the supplied task`,
        ),
      )
    }
    return diagnostics
  }

  function budgetLine(prep) {
    if (prep.budget === null || prep.budget === undefined) return undefined
    try {
      return formatBudget(prep.budget.ledger.summary(prep.budget.budgetId))
    } catch {
      return formatBudget(prep.budget.summary)
    }
  }

  function budgetRecordLine(record) {
    const budget = record?.budget
    if (budget === null || budget === undefined || budget.id === undefined) return undefined
    try {
      const summary = budgets.summary(budget.id)
      const reservation = (summary.reservations ?? []).find((entry) => entry.reservation_id === budget.reservation_id)
      const amount = reservation?.settled_amount ?? reservation?.amount ?? budget.reservation_amount ?? '?'
      return `budget ${budget.id}: ${reservation?.status ?? 'held'} ${amount} ${budget.currency}`
    } catch {
      return `budget ${budget.id}: ${budget.reservation_amount ?? '?'} ${budget.currency} (ledger unavailable)`
    }
  }

  function buildRecord(recordId, prep, reservation, outDir, stem, overrides, args) {
    const promptText = typeof prep.prompt === 'string' ? prep.prompt : undefined
    return {
      schema: 1,
      record_id: recordId,
      created_at: nowIso(),
      updated_at: nowIso(),
      status: 'submitting',
      task_type: prep.kind,
      fingerprint: prep.requestFingerprint,
      plan_fingerprint: prep.planFingerprint,
      request_fingerprint: prep.requestFingerprint,
      plan: prep.plan ?? null,
      ...(promptText === undefined
        ? {}
        : { prompt: { text: promptText, sha256: sha256Hex(promptText), chars: promptText.length } }),
      request: sanitizeRequestBody(prep.body, prep.assets),
      assets: sanitizedAssets(prep.assets),
      estimate: prep.estimate,
      estimate_line: formatEstimate(prep.estimate),
      max_cost: prep.maxCost ?? null,
      budget:
        prep.budget === null || prep.budget === undefined
          ? null
          : {
              id: prep.budget.budgetId,
              currency: prep.budget.document.currency,
              reservation_id: reservation?.reservation_id ?? null,
              reservation_amount: reservation?.amount ?? null,
            },
      diagnostics: diagnosticsToLines(prep.diagnostics),
      project:
        prep.production?.project === null || prep.production?.project === undefined
          ? null
          : { id: prep.production.project.id ?? null, manifest: prep.production.project.manifest ?? null },
      shot: prep.production?.shot === null || prep.production?.shot === undefined ? null : { id: prep.production.shot.id },
      contract: contractRecord(args, prep.contract?.approvedSources),
      out_dir: outDir ?? null,
      stem: stem ?? null,
      duration_context: prep.durationContext ?? null,
      cwd: prep.cwd,
      overrides: overrides ?? [],
      attempts: [],
      audit: [],
    }
  }

  function releaseReservationQuietly(prep, recordId, reason) {
    const reservationId = prep.recordReservationId
    if (prep.budget === null || prep.budget === undefined) return
    try {
      prep.budget.ledger.release({
        budgetId: prep.budget.budgetId,
        recordId,
        reservationId,
        reason,
        outcome: 'definite_failure',
      })
    } catch {
      // reservation cleanup must not hide the original error
    }
  }

  function authorizeOverride(args, blocking, fingerprint) {
    if (blocking.kind === 'unknown') {
      if (args.allow_duplicate_risk !== true) {
        throw new DuplicateSubmissionError({ kind: 'unknown', record: blocking.record, file: blocking.file, fingerprint })
      }
      const reason = String(args.override_reason ?? '').trim()
      if (reason.length < 8) {
        throw new Error('allow_duplicate_risk requires override_reason (at least 8 characters) explaining why the unknown outcome is safe to duplicate')
      }
      const expected = blocking.record?.record_id
      if (expected === undefined) {
        throw new Error(
          `the blocked unknown submission has no readable record_id; inspect ${stateDir}/journal and resolve it manually before retrying`,
        )
      }
      if (String(args.prior_record_id ?? '') !== expected) {
        throw new Error(
          `allow_duplicate_risk requires prior_record_id="${expected}" (the blocked unknown record); this proves the caller inspected the right submission`,
        )
      }
      journal.acknowledgeBlocking(blocking, { overrideReason: reason, kind: 'unknown', priorRecordId: expected })
      return { kind: 'allow_duplicate_risk', reason, prior_record_id: expected, at: nowIso() }
    }
    if (blocking.kind === 'recent') {
      if (args.allow_duplicate !== true) {
        throw new DuplicateSubmissionError({ kind: 'recent', record: blocking.record, file: blocking.file, fingerprint })
      }
      journal.acknowledgeBlocking(blocking, {
        overrideReason: 'explicit allow_duplicate',
        kind: 'recent',
        priorRecordId: blocking.record?.record_id,
      })
      return { kind: 'allow_duplicate', at: nowIso(), prior_record_id: blocking.record?.record_id ?? null }
    }
    throw new DuplicateSubmissionError({ kind: 'inflight', record: blocking.record, file: blocking.file, fingerprint })
  }

  function callBudgetOutcome(record) {
    const budget = record.budget
    if (budget === null || budget === undefined || budget.id === undefined) return
    try {
      if (record.status === 'succeeded') {
        const amount =
          record.estimate?.status === 'complete'
            ? record.estimate.amount
            : budget.reservation_amount ?? record.estimate?.upper_bound ?? 0
        budgets.settle({
          budgetId: budget.id,
          recordId: record.record_id,
          amount,
          reason: 'task succeeded; settled at the conservative list-price bound',
        })
      } else if (record.status === 'cancelled') {
        budgets.release({
          budgetId: budget.id,
          recordId: record.record_id,
          reason: 'task cancelled before billing',
          outcome: 'cancelled',
        })
      } else if (record.status === 'failed') {
        journal.update(record, {
          budget_note:
            'terminal failed does not prove a zero charge; the reservation stays held for reconciliation (video_budget action=release with a reason)',
        })
      }
    } catch {
      // budget bookkeeping must not turn a delivered task result into an error
    }
  }

  function syncTaskRecord(record, task, downloaded) {
    if (record === undefined) return
    try {
      journal.update(record, {
        status: String(task.status ?? 'unknown'),
        task_snapshot: {
          status: String(task.status ?? 'unknown'),
          ...(describeUsage(task) === undefined ? {} : { usage: describeUsage(task) }),
          ...(errorText(task) === undefined ? {} : { error: errorText(task) }),
        },
        ...(downloaded?.file === undefined
          ? {}
          : {
              download: {
                file: downloaded.file,
                bytes: downloaded.bytes,
                sha256: downloaded.sha256,
                at: nowIso(),
              },
            }),
        ...(downloaded?.note === undefined ? {} : { download_error: downloaded.note }),
      })
      callBudgetOutcome(record)
    } catch {
      // the network result is still returned even if the journal update fails
    }
  }

  function recoveryValue({ taskId, record, error }) {
    return {
      task_id: String(taskId),
      status: 'unknown',
      ...(record?.record_id === undefined ? {} : { record_id: record.record_id }),
      ...(record?.estimate_line === undefined ? {} : { estimate: record.estimate_line }),
      ...(record?.estimate?.status === undefined ? {} : { cost_status: record.estimate.status }),
      ...(budgetRecordLine(record) === undefined ? {} : { budget: budgetRecordLine(record) }),
      note: `the task id is saved in the local ledger; the query failed (${error.message}). Retry video_task with task_id ${taskId}; do not submit the same request again`,
    }
  }

  async function executePaid({ args, exec, prep, submit }) {
    if (args.dry_run === true && args.plan_id !== undefined) {
      throw new Error('use either dry_run or plan_id, not both')
    }
    if (args.dry_run === true) return prepareResult(prep.kind, prep)
    if (args.plan_id !== undefined) plans.peek(args.plan_id, { kind: prep.kind, fingerprint: prep.planFingerprint })
    // Key resolution happens before the plan claim, budget reservation and
    // intent write so a missing credential stays a retryable local error.
    const client = await makeClient(exec.signal)
    const blocking = journal.findBlocking(prep.requestFingerprint, {
      dedupeWindowMs: (Number(cfg.duplicateWindowSeconds) || 600) * 1000,
    })
    const override = blocking === undefined ? undefined : authorizeOverride(args, blocking, prep.requestFingerprint)
    if (override !== undefined) {
      prep.diagnostics.push(
        diagnostic('warn', 'duplicate_override', `duplicate protection overridden: ${override.kind}${override.reason ? ` (${override.reason})` : ''}`),
      )
    }
    const overrides = []
    if (override !== undefined) overrides.push(override)
    if (args.allow_unbounded_cost === true) {
      overrides.push({ kind: 'allow_unbounded_cost', reason: args.override_reason, at: nowIso() })
    }
    const recordId = `r-${Date.now().toString(36)}-${randomToken(4)}`
    let reservation
    if (prep.budget !== null && prep.budget !== undefined) {
      reservation = prep.budget.ledger.reserve({
        budgetId: prep.budget.budgetId,
        recordId,
        amount: costBound(prep.estimate),
        taskType: prep.kind,
        estimateAmount: prep.estimate.amount,
        note: override === undefined ? null : `override ${override.kind}: ${override.reason ?? 'allow_duplicate'}`,
      }).reservation
    }
    prep.recordReservationId = reservation?.reservation_id
    let intent
    let outDir
    let stem
    try {
      const recordDir = join(stateDir, 'records', recordId)
      if (prep.assets.length > 0) {
        snapshotLocalAssets(recordDir, prep.assets, {
          maxBytes: Number(cfg.inputSnapshotMaxBytes) || 64 * 1024 * 1024,
        })
      }
      outDir = prep.outDir ?? outDirFor(prep.cwd, args)
      stem = `${slugOf(prep.prompt ?? 'video')}-${recordId}`
      const record = buildRecord(recordId, prep, reservation, outDir, stem, overrides, args)
      intent = journal.createIntent(record)
      if (args.plan_id !== undefined) {
        try {
          plans.claim(args.plan_id, { kind: prep.kind, fingerprint: prep.planFingerprint })
        } catch (error) {
          journal.cancelIntent(intent)
          throw error
        }
      }
    } catch (error) {
      releaseReservationQuietly(prep, recordId, `submission aborted before the network call: ${error.message}`)
      throw error
    }
    let created
    try {
      created = await submit(client)
    } catch (error) {
      const ambiguous = error?.ambiguous === true || error?.name === 'AbortError'
      journal.closeIntent(intent, { ambiguous, error })
      if (!ambiguous) {
        releaseReservationQuietly(prep, recordId, `API rejected the submission before acceptance: ${error.message}`)
        throw error
      }
      throw new Error(
        `submission outcome is unknown: ${error.message}. Record ${recordId} is saved as unknown${reservation ? ' and its budget reservation stays held' : ''}; no automatic retry will happen. Check the MiniMax console, then retry with allow_duplicate_risk:true, override_reason:"...", prior_record_id:"${recordId}" if a duplicate is acceptable.`,
      )
    }
    const taskId = created?.task_id === undefined || created?.task_id === null ? '' : String(created.task_id)
    if (taskId.length === 0) {
      journal.closeIntent(intent, { ambiguous: true, error: new Error('create response carried no task_id') })
      throw new Error(
        `the server accepted the request but returned no task_id; record ${recordId} is saved as unknown and budget stays reserved. Check the MiniMax console before retrying`,
      )
    }
    let journalError
    let attachError
    try {
      journal.commitTask(intent, taskId)
    } catch (error) {
      journalError = error
      // Preserve the only remaining evidence as an unresolved outcome so a
      // later identical submission is blocked as unknown and can be explicitly
      // overridden after inspecting the console. Best effort by definition.
      try {
        journal.closeIntent(intent, { ambiguous: true, error })
      } catch {
        // the pending intent (if any) remains the recovery marker
      }
    }
    if (journalError === undefined && reservation !== undefined && prep.budget !== null && prep.budget !== undefined) {
      try {
        prep.budget.ledger.attachTask({ budgetId: prep.budget.budgetId, recordId, taskId })
      } catch (error) {
        // The task id is safely journaled; only the budget cross-reference is
        // missing. Keep waiting and surface the bookkeeping warning.
        attachError = error
      }
    }
    if (journalError !== undefined) {
      prep.diagnostics.push(
        diagnostic(
          'error',
          'journal_commit_failed',
          `task id ${taskId} was accepted by the server but its durable record could not be written (${journalError.message}); this is a critical recovery condition`,
        ),
      )
    } else if (attachError !== undefined) {
      prep.diagnostics.push(
        diagnostic(
          'warn',
          'budget_attach_failed',
          `task ${taskId} is journaled, but the budget reservation could not be linked to it (${attachError.message}); reconcile the held reservation later`,
        ),
      )
    }
    const record = intent
    const base = {
      task_id: taskId,
      model: prep.plan?.model,
      resolution: prep.plan?.resolution,
      duration: prep.plan?.duration,
      ratio: prep.plan?.ratio,
      mode: prep.plan?.mode,
      estimate: formatEstimate(prep.estimate),
      cost_status: prep.estimate.status,
      ...(prep.maxCost === undefined ? {} : { cost_cap: `${formatMoney(prep.maxCost, region)} ${currency} hard` }),
      ...(budgetLine(prep) === undefined ? {} : { budget: budgetLine(prep) }),
      record_id: recordId,
      diagnostics: diagnosticsToLines(prep.diagnostics),
      ...(attachError === undefined
        ? {}
        : { note: `task ${taskId} is journaled but its budget reservation is not linked; reconcile it later` }),
    }
    if (journalError !== undefined) {
      // Never enter the default 900 s wait when the id could not be persisted:
      // an interruption here would lose the only copy of a live task id.
      return {
        ...base,
        status: 'submitted',
        note: `CRITICAL: task_id ${taskId} was accepted but the local journal write failed (${journalError.message}). Save this ID now and do not resubmit the same request; check the MiniMax console. Local recovery via video_task may not find this task, and its budget reservation remains held.`,
      }
    }
    if (args.wait === false) {
      return {
        ...base,
        status: 'queued',
        note: `${base.note ?? ''}${base.note === undefined ? '' : ' '}submitted; call video_task with task_id ${taskId}`.trim(),
      }
    }
    let task
    let timedOut = false
    try {
      ;({ task, timedOut } = await pollTask(client, taskId, {
        timeoutMs: resolveWaitMs(args, cfg),
        intervalMs: cfg.pollIntervalMs,
        signal: exec.signal,
      }))
    } catch (error) {
      if (error?.name === 'AbortError') {
        try {
          journal.update(record, { status: 'unknown', last_error: `polling aborted: ${error.message}` })
        } catch {
          // best effort
        }
        throw error
      }
      try {
        journal.update(record, { status: 'unknown', last_error: `polling failed: ${error.message}` })
      } catch {
        // best effort
      }
      return recoveryValue({ taskId, record, error })
    }
    const downloaded =
      task.status === 'succeeded' && args.download !== false
        ? await downloadResult(task, {
            outDir,
            stem: downloadStem(taskId, prep.prompt),
            signal: exec.signal,
          })
        : {}
    syncTaskRecord(record, task, downloaded)
    return {
      ...base,
      ...summaryOf(task, { task_id: taskId }),
      model: prep.plan?.model,
      resolution: prep.plan?.resolution,
      duration: prep.plan?.duration,
      ratio: prep.plan?.ratio,
      mode: prep.plan?.mode,
      estimate: formatEstimate(prep.estimate),
      cost_status: prep.estimate.status,
      ...(prep.maxCost === undefined ? {} : { cost_cap: `${formatMoney(prep.maxCost, region)} ${currency} hard` }),
      ...(budgetLine(prep) === undefined ? {} : { budget: budgetLine(prep) }),
      record_id: recordId,
      diagnostics: diagnosticsToLines(prep.diagnostics),
      ...(downloaded.file === undefined ? {} : { file: downloaded.file }),
      ...(downloaded.note === undefined ? {} : { note: downloaded.note }),
      ...(timedOut ? { note: `still ${task.status} after the wait cap; call video_task with task_id ${taskId}` } : {}),
    }
  }

  ctx.tools.register(defineTool({
    name: 'video_models',
    description:
      'List MiniMax H3 (Hailuo 3) tiers, the resolution/duration matrix, list prices, input limits and the 768P-to-2K regeneration rules. Call this before choosing a tier or resolution, or when the user asks what a clip will cost.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute() {
      return { text: catalogText(region) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_prepare',
    description:
      'Offline preflight for an H3 paid operation: validates the prompt, media limits, declared dialogue/reference roles/source provenance and project-registry approvals, computes a list-price estimate with an explicit complete/partial/unknown status, checks max_cost and the persistent budget, and returns a one-shot plan_id. Makes no network call and reads no credential. Submit later with plan_id and the same arguments.',
    parameters: {
      kind: {
        type: 'string',
        enum: ['generate', 'regenerate', 'prompt_enhance'],
        description: 'Operation to prepare. Default generate.',
      },
      prompt: {
        type: 'string',
        description:
          'Full H3 prompt (<= 7000 chars); required for generate and prompt_enhance, and for regenerate when video is used instead of source_task_id.',
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: 'Generation tier; ignored by regeneration (always MiniMax-H3) and Context-IR.',
      },
      resolution: {
        type: 'string',
        enum: RESOLUTIONS,
        description: 'Output resolution; ignored by regeneration (2K) and Context-IR.',
      },
      duration: {
        type: 'integer',
        description: 'Clip length in whole seconds; H3/Highspeed/Lite 4-15, Max 5-15. Default 5.',
      },
      ratio: {
        type: 'string',
        enum: RATIOS,
        description: 'Frame shape; regeneration follows the source clip.',
      },
      ...mediaProperties(),
      prompt_expansion: {
        type: 'string',
        enum: PROMPT_EXPANSION_MODES,
        description: 'MiniMax-H3-Max only for balanced/quality. On a non-Max tier disabled is accepted as a no-op and stripped from the API body; balanced/quality are rejected.',
      },
      source_task_id: {
        type: 'string',
        description: 'Regeneration mode 1: an existing succeeded H3 768P task id (whitelist access required).',
      },
      video: {
        type: 'string',
        description: 'Regeneration mode 2: the 768P source clip (local path or URL), sent as base_video.',
      },
      original_task_id: {
        type: 'string',
        description:
          'Local record/task id of the original 768P generation; enables prompt/media/source-file drift checks before the 2K pass.',
      },
      source_duration_seconds: {
        type: 'number',
        description:
          'Declared duration of the 768P source clip from an external request CLI. It is displayed and cross-checked only: a local container or trusted downloaded record is measured independently, a mismatch is rejected, and without a measurement the estimate stays partial at the 15 s upper bound. A declaration cannot lower a cap or reservation; 0 means "not provided" (serialized empty field) and is treated as unknown.',
      },
      ...contractProperties(),
      ...assetIdProperties({ includeBaseVideo: true, includeSourceAsset: true }),
      max_cost: safetyProperties().max_cost,
      allow_unbounded_cost: safetyProperties().allow_unbounded_cost,
      override_reason: overrideProperties().override_reason,
      budget_id: {
        type: 'string',
        description:
          'Named persistent budget to check against. A project manifest budget is bound automatically and cannot be overridden.',
      },
    },
    output: {
      schema: prepareOutputSchema(),
      render: renderPrepared,
    },
    async execute(args, exec) {
      const cwd = await toolCwd(exec)
      const kind = args.kind ?? 'generate'
      const prep =
        kind === 'generate'
          ? await prepareGenerate(cwd, args)
          : kind === 'regenerate'
            ? await prepareRegenerate(cwd, args)
            : await prepareEnhance(cwd, args)
      return prepareResult(kind, prep)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_generate',
    description:
      'Create a MiniMax H3 video from a prompt plus optional first/last frames or reference media. H3 renders picture and sound together: dialogue, ambience and score come from the prompt. Output is one 4-15 s clip at 480P/768P/2K depending on the tier. By default waits, downloads the MP4 into generated-videos/ and returns its path; on the wait cap it returns the live task_id for video_task. Every submit is preflighted, estimated and journaled before the network call. ' +
      modeDescription(),
    timeoutMs: 1_800_000,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description:
          'Full H3 prompt (<= 7000 chars). Prefer the three-field shape: "integrated_multimodal_description: [Shot 1] ... [Shot 2] At 00:04.500, the camera cuts to ...", "overall_soundscape: ...", "non_diegetic_music: ...". Describe subject, action, camera move, light and audible sound in positive terms. Load the minimax-video skill for templates.',
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description:
          'Generation tier. MiniMax-H3 (default) = best quality, 768P/2K, 4-15 s. MiniMax-H3-Highspeed = faster and cheaper, 480P/768P, 4-15 s. MiniMax-H3-Lite = cheapest, 480P/768P, 4-15 s. MiniMax-H3-Max = multi-asset reference with prompt expansion, 480P/768P, 5-15 s.',
      },
      resolution: {
        type: 'string',
        enum: RESOLUTIONS,
        description:
          'Output resolution. 2K is only available on MiniMax-H3; 480P is available on Highspeed/Lite/Max; 768P works on every tier. Default 768P. Higher resolution costs more per second.',
      },
      duration: {
        type: 'integer',
        description:
          'Clip length in whole seconds: 4-15 on H3/Highspeed/Lite, 5-15 on Max. Default 5. A single generation is one clip; size it to the action or dialogue (about 3.3 spoken words per second, speech fills roughly 57% of a clip).',
      },
      ratio: {
        type: 'string',
        enum: RATIOS,
        description:
          'Frame shape. Text-to-video needs a concrete ratio and defaults to 16:9. Image-to-video follows the frame image and is always adaptive. Reference-to-video defaults to adaptive; Lite requires a concrete ratio.',
      },
      ...mediaProperties(),
      prompt_expansion: {
        type: 'string',
        enum: PROMPT_EXPANSION_MODES,
        description:
          'MiniMax-H3-Max only for balanced/quality. disabled keeps your prompt as written and is also accepted as a no-op on non-Max tiers (stripped, never sent); balanced (API default) and quality on another tier are rejected.',
      },
      wait: {
        type: 'boolean',
        description: 'Wait for completion and download the result. Default true. Set false to submit and return immediately.',
      },
      wait_seconds: {
        type: 'integer',
        description: 'Maximum wait when wait is true. Default 900 s; the cap is the plugin maxWaitSeconds (900 s).',
      },
      download: {
        type: 'boolean',
        description: 'Download the finished MP4. Default true. The result URL is time-limited, so keep this on unless you only need the URL.',
      },
      out_dir: outProperty,
      ...contractProperties(),
      ...assetIdProperties(),
      ...planProperties(),
      ...safetyProperties(),
      ...overrideProperties(),
      budget_id: {
        type: 'string',
        description: 'Named persistent budget for cross-call cost control; the project manifest budget is bound automatically.',
      },
    },
    output: {
      schema: taskOutputSchema(),
      render: renderTask,
    },
    async execute(args, exec) {
      const cwd = await toolCwd(exec)
      const prep = await prepareGenerate(cwd, args)
      return executePaid({
        args,
        exec,
        prep,
        submit: (client) => client.create(prep.body),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_task',
    description:
      'Query, wait for, download, cancel or delete a MiniMax H3 video task (generation, regeneration or Context-IR). Status is cheap; set wait to block until the task finishes. Delete cancels a queued task, or removes a succeeded/failed record; a running task cannot be cancelled. A locally journaled task is recovered automatically, including its download directory and estimate, and a failed query never loses the task id.',
    timeoutMs: 1_800_000,
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by video_generate, video_regenerate or video_prompt_enhance.' },
      action: {
        type: 'string',
        enum: ['status', 'cancel'],
        description: 'status (default) queries or waits; cancel cancels a queued task or deletes a finished record.',
      },
      wait: {
        type: 'boolean',
        description: 'Block until the task reaches succeeded, failed or cancelled. Default false.',
      },
      wait_seconds: {
        type: 'integer',
        description: 'Maximum wait when wait is true. Default 900 s; capped by the plugin maxWaitSeconds.',
      },
      download: {
        type: 'boolean',
        description: 'Download the MP4 when the task has succeeded. Default true. The result URL expires.',
      },
      out_dir: outProperty,
    },
    output: {
      schema: taskOutputSchema({ action: { type: 'string' } }),
      render: renderTask,
    },
    async execute(args, exec) {
      const cwd = await toolCwd(exec)
      const record = journal.findByTaskId(args.task_id)
      let client
      try {
        client = await makeClient(exec.signal)
      } catch (error) {
        if (record !== undefined) return recoveryValue({ taskId: args.task_id, record, error })
        throw error
      }
      if (args.action === 'cancel') {
        const result = await client.remove(args.task_id)
        const status = String(result.status ?? result.action ?? 'deleted')
        if (record !== undefined) {
          try {
            journal.update(record, {
              status: result.action === 'cancelled' ? 'cancelled' : record.status,
              action: String(result.action ?? 'deleted'),
            })
            if (result.action === 'cancelled') callBudgetOutcome(record)
          } catch {
            // best effort
          }
        }
        return {
          task_id: String(result.task_id ?? args.task_id),
          status,
          action: String(result.action ?? 'deleted'),
          ...(record?.record_id === undefined ? {} : { record_id: record.record_id }),
          ...(record?.estimate_line === undefined ? {} : { estimate: record.estimate_line }),
          note:
            result.action === 'cancelled'
              ? 'queued task cancelled; no charge for the queued generation and its budget reservation was released'
              : 'task record deleted',
        }
      }
      let task
      let timedOut = false
      try {
        ;({ task, timedOut } = args.wait
          ? await pollTask(client, args.task_id, {
              timeoutMs: resolveWaitMs(args, cfg),
              intervalMs: cfg.pollIntervalMs,
              signal: exec.signal,
            })
          : { task: await client.query(args.task_id), timedOut: false })
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        if (record !== undefined) {
          const terminal = record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled'
          try {
            journal.update(record, terminal
              ? { last_error: `query failed: ${error.message}` }
              : { status: 'unknown', last_error: `query failed: ${error.message}` })
          } catch {
            // best effort
          }
          if (terminal) {
            return {
              task_id: args.task_id,
              status: record.status,
              ...(record.record_id === undefined ? {} : { record_id: record.record_id }),
              ...(record.estimate_line === undefined ? {} : { estimate: record.estimate_line }),
              ...(record.estimate?.status === undefined ? {} : { cost_status: record.estimate.status }),
              ...(budgetRecordLine(record) === undefined ? {} : { budget: budgetRecordLine(record) }),
              ...(typeof record.download?.file === 'string' ? { file: record.download.file } : {}),
              note: `query failed (${error.message}); returning the last journaled terminal state without resubmitting`,
            }
          }
          return recoveryValue({ taskId: args.task_id, record, error })
        }
        throw error
      }
      const outDir = args.out_dir !== undefined
        ? resolve(cwd, args.out_dir)
        : record?.out_dir ?? join(cwd, 'generated-videos')
      const stem = record?.stem ?? downloadStem(args.task_id, task.task_type ?? 'video')
      let downloaded = {}
      if (task.status === 'succeeded' && args.download !== false) {
        if (typeof task.content?.url === 'string') {
          downloaded = await downloadResult(task, {
            outDir,
            stem,
            signal: exec.signal,
            existingFile: record?.download?.file,
          })
        } else if (typeof record?.download?.file === 'string' && existsSync(record.download.file)) {
          downloaded = {
            file: record.download.file,
            bytes: record.download.bytes,
            sha256: record.download.sha256,
            note: 'result URL is missing or expired; reused the file already saved for this task',
          }
        }
      }
      syncTaskRecord(record, task, downloaded)
      return {
        ...summaryOf(task),
        ...(record?.record_id === undefined ? {} : { record_id: record.record_id }),
        ...(record?.estimate_line === undefined ? {} : { estimate: record.estimate_line }),
        ...(record?.estimate?.status === undefined ? {} : { cost_status: record.estimate.status }),
        ...(budgetRecordLine(record) === undefined ? {} : { budget: budgetRecordLine(record) }),
        ...(downloaded.file === undefined ? {} : { file: downloaded.file }),
        ...(downloaded.note === undefined ? {} : { note: downloaded.note }),
        ...(timedOut ? { note: `still ${task.status} after the wait cap; call video_task again` } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_regenerate',
    description:
      'Regenerate an existing MiniMax-H3 768P output as 2K. This is the official regeneration endpoint, not a generic upscaler: the source must be a 768P H3-family result (standard H3, Highspeed or Lite; 24 fps, audio track, dimensions divisible by 32, 107-362 frames), and the original prompt plus all original media must be resubmitted. Direct 2K generation itself remains available only on standard MiniMax-H3. Two modes: source_task_id (whitelist only) or a source video plus the original inputs. ' +
      'Cost note: regeneration is billed per output second plus the original task input materials re-billed (reference videos by original input duration; images beyond 5); whether the base clip adds another input-video charge is unconfirmed. Estimates are floor/upper partial, not invoices. For a 5 s 768P clip + 5 s regeneration the pipeline is about ¥4.00-5.50 vs ¥4.00 for direct 2K: not automatically cheaper or more expensive. Pass original_task_id to verify the resubmitted prompt/media/source bytes against the recorded 768P generation.',
    timeoutMs: 1_800_000,
    parameters: {
      source_task_id: {
        type: 'string',
        description:
          'Mode 1: an existing succeeded /v2/video_generation task id. Whitelist access is required; the task must belong to this account, be succeeded, and be within the 7-day query window. Omit all content when using this mode.',
      },
      video: {
        type: 'string',
        description:
          'Mode 2: the 768P source video (local path or public URL), sent as base_video. Must meet the H3 768P output spec and carry an audio track. Supply the original prompt and media too.',
      },
      prompt: {
        type: 'string',
        description: 'Mode 2: the final prompt actually sent when the 768P source was generated (not the pre-Context-IR draft). Max 7000 chars.',
      },
      ...mediaProperties(),
      original_task_id: {
        type: 'string',
        description:
          'Local record/task id of the original 768P generation; enables prompt/media/source-file drift checks against the saved record.',
      },
      source_duration_seconds: {
        type: 'number',
        description:
          'Declared duration of the 768P source clip. Displayed and cross-checked, never a substitute for measurement: local/trusted source bytes are measured first, a conflicting declaration is rejected, and without measurement the estimate remains partial (15 s upper bound), so a low declared value cannot lower the cap or reservation; 0 means "not provided" and is treated as unknown.',
      },
      wait: { type: 'boolean', description: 'Wait for completion and download the 2K MP4. Default true.' },
      wait_seconds: {
        type: 'integer',
        description: 'Maximum wait when wait is true. Default 900 s; capped by the plugin maxWaitSeconds.',
      },
      download: { type: 'boolean', description: 'Download the finished 2K MP4. Default true.' },
      out_dir: outProperty,
      ...contractProperties(),
      ...assetIdProperties({ includeBaseVideo: true, includeSourceAsset: true }),
      ...planProperties(),
      ...safetyProperties(),
      ...overrideProperties(),
      budget_id: {
        type: 'string',
        description: 'Named persistent budget for cross-call cost control; the project manifest budget is bound automatically.',
      },
    },
    output: {
      schema: taskOutputSchema(),
      render: renderTask,
    },
    async execute(args, exec) {
      const cwd = await toolCwd(exec)
      const prep = await prepareRegenerate(cwd, args)
      return executePaid({
        args,
        exec,
        prep,
        submit: async (client) => {
          try {
            return await client.regenerate(prep.body)
          } catch (error) {
            if (prep.byTask && error instanceof ApiError && /whitelist|permission|forbidden/i.test(error.message)) {
              const wrapped = new Error(
                `${error.message}. source_task_id regeneration needs whitelist access; use the video mode with the original prompt and media instead`,
              )
              wrapped.ambiguous = error.ambiguous === true
              throw wrapped
            }
            throw error
          }
        },
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_prompt_enhance',
    description:
      'Run the official MiniMax H3-Context-IR prompt enhancer. It reads the same multimodal inputs as a generation (text plus optional frames or reference media) and returns a structured, semantically enriched prompt, but does not create a video. Use it when a prompt is vague, when references need to be assigned roles, or before a deliberate 768P-to-2K pipeline. Costs Context-IR tokens, not video seconds: the cost has no pre-call bound, so a hard cap or budget is refused for this operation.',
    timeoutMs: 600_000,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The draft prompt to interpret (<= 7000 chars). It may be short; Context-IR expands it using the supplied media.',
      },
      duration: {
        type: 'integer',
        description: 'Target video length in seconds, 4-15. Default 5. Shapes the shot timeline in the enhanced prompt.',
      },
      ratio: {
        type: 'string',
        enum: RATIOS,
        description: 'Target ratio. Text-only input needs a concrete ratio (default 16:9); image input is adaptive; reference input defaults to adaptive.',
      },
      ...mediaProperties(),
      ...contractProperties(),
      ...planProperties(),
      ...safetyProperties(),
      override_reason: overrideProperties().override_reason,
      budget_id: {
        type: 'string',
        description: 'A persistent budget cannot govern token-priced Context-IR; supplying one is refused rather than guessed.',
      },
      wait: { type: 'boolean', description: 'Wait for the enhanced prompt. Default true.' },
      wait_seconds: { type: 'integer', description: 'Maximum wait when wait is true. Default 900 s.' },
    },
    output: {
      schema: taskOutputSchema(),
      render: renderTask,
    },
    async execute(args, exec) {
      const cwd = await toolCwd(exec)
      const prep = await prepareEnhance(cwd, args)
      return executePaid({
        args,
        exec,
        prep,
        submit: (client) => client.contextIr(prep.body),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_budget',
    description:
      'Inspect or manage the persistent MiniMax video budget: status, create, amend (with a reason) or release a held reservation for reconciliation. A project manifest budget is created automatically and cannot be changed by a paid call; only action=amend can change it, with an audit reason.',
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'create', 'amend', 'release'],
        description: 'status (default) lists budgets; create creates one; amend changes a limit with a reason; release frees a held reservation with a reason.',
      },
      budget_id: {
        type: 'string',
        description: 'Budget id. Required for create, amend and release; optional for status.',
      },
      limit: { type: 'number', description: 'Positive limit in the budget currency (create/amend).' },
      currency: { type: 'string', enum: ['CNY', 'USD'], description: 'Budget currency; must match the configured region.' },
      record_id: {
        type: 'string',
        description: 'For release: the task record_id whose held reservation should be released.',
      },
      reason: { type: 'string', description: 'Required for amend and release; recorded in the budget audit trail.' },
      note: { type: 'string', description: 'Optional note stored with a created budget.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args) {
      const action = args.action ?? 'status'
      if (action === 'create') {
        if (args.currency !== currency) {
          throw new Error(`the configured base URL bills in ${currency}; create the budget in ${currency}`)
        }
        budgets.ensure({
          budgetId: args.budget_id,
          limit: args.limit,
          currency: args.currency,
          note: args.note,
        })
        return { text: formatBudget(budgets.summary(args.budget_id)) }
      }
      if (action === 'amend') {
        budgets.amend({ budgetId: args.budget_id, limit: args.limit, reason: args.reason })
        return { text: `amended. ${formatBudget(budgets.summary(args.budget_id))}` }
      }
      if (action === 'release') {
        if (args.record_id === undefined) throw new Error('release requires record_id')
        budgets.release({ budgetId: args.budget_id, recordId: args.record_id, reason: args.reason })
        return { text: `released reservation for ${args.record_id}. ${formatBudget(budgets.summary(args.budget_id))}` }
      }
      if (args.budget_id !== undefined) {
        const summary = budgets.summary(args.budget_id)
        const recent = summary.reservations
          .map((reservation) => `- ${reservation.record_id} ${reservation.status} ${reservation.amount} ${summary.currency}${reservation.release_reason ? ` (${reservation.release_reason})` : ''}`)
          .join('\n')
        return {
          text: `${formatBudget(summary)}\n${recent.length > 0 ? recent : '- no reservations'}`,
        }
      }
      const all = budgets.list()
      if (all.length === 0) return { text: 'no budgets; create one with action=create or declare budget:{id,limit,currency} in the project manifest' }
      return { text: all.map((summary) => formatBudget(summary)).join('\n') }
    },
  }))
}

function modeDescription() {
  return 'Mode is inferred: no media = text-to-video; first_frame/last_frame = image-to-video; reference_* = reference-to-video. Frames and references are mutually exclusive.'
}
