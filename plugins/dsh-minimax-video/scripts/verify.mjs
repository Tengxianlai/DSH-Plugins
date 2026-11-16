// Offline self-check: tool registration, tool schemas, catalog matrix, request
// shapes, media/asset registry, pre-submit contracts, cost/budget enforcement,
// the durable task journal (including cross-process races), prepared plans,
// regeneration drift checks, mock-network recovery paths and the skill provider.
//
// No real network request and no paid generation: every HTTP call is mocked.
import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, inject, name } from '../index.js'
import {
  LIMITS,
  MODEL_IDS,
  RATIOS,
  REGENERATION,
  catalogText,
  estimateGenerationCost,
  formatMoney,
  inferMode,
  normalizeRatio,
  planGeneration,
  regionOf,
  validatePrompt,
  validateReferenceCounts,
} from '../lib/catalog.js'
import { assertRequestSize, imageCountOf, resolveMedia } from '../lib/media.js'
import { buildContent, buildContextIrBody, buildGenerationBody, buildRegenerationBody } from '../lib/request.js'
import {
  buildMediaBundle,
  normalizeAssetIds,
  normalizeMediaArgs,
  operationFingerprint,
  requestFingerprint,
  sanitizeRequestBody,
  snapshotLocalAssets,
} from '../lib/assets.js'
import {
  checkDialogue,
  checkMediaContract,
  checkMediaDurations,
  enforceCostCap,
  estimateContextIr,
  estimateGeneration,
  estimateRegeneration,
  formatEstimate,
  speechSeconds,
} from '../lib/preflight.js'
import { probeMp4Duration } from '../lib/mp4.js'
import { downloadVideo } from '../lib/api.js'
import { TaskJournal } from '../lib/journal.js'
import { PlanStore } from '../lib/plans.js'
import { BudgetLedger } from '../lib/budget.js'
import { acquireLock, atomicWriteJson, readJson, sha256Hex } from '../lib/store.js'

// The host validates every successful execute() result before the model sees it
// (dsh-tools pipeline.createSuccessResult): a lossless-JSON snapshot first,
// then output.schema validation, a deep freeze, and finally output.render whose
// content is snapshotted too. Mirror that exact boundary here instead of
// accepting the raw execute() return. `@deepseek-ai/dsh-util-values` is not a
// direct dependency of this repo, but the installed @deepseek-ai/dsh-tools pins
// it as a real dependency, so resolve the runtime-identical copy from that
// anchor (no new dependency, no install, no absolute install path).
const hostRequire = createRequire(import.meta.url)
const dshToolsEntry = hostRequire.resolve('@deepseek-ai/dsh-tools')
const { snapshotJsonValue, deepFreeze } = await import(
  pathToFileURL(createRequire(dshToolsEntry).resolve('@deepseek-ai/dsh-util-values')).href
)

/** Fail exactly where the host would reject a tool result: snapshot, schema, render. */
function assertHostResult(definition, args, candidate) {
  const detached = snapshotJsonValue(candidate)
  assert.notEqual(
    detached,
    undefined,
    `${definition.name}: the host would reject this result as non-lossless JSON (an own undefined/function/symbol/NaN value); a paid submit would lose its task id`,
  )
  const violations = validateJsonSchemaValue(definition.output.schema, detached, 'value')
  assert.deepEqual(
    violations,
    [],
    `${definition.name}: the host would reject this result against output.schema: ${JSON.stringify(violations)}`,
  )
  const value = deepFreeze(detached)
  let rendered
  try {
    rendered = definition.output.render(args, value)
  } catch (error) {
    assert.fail(`${definition.name}: output.render threw: ${error.message}`)
  }
  const renderedSnapshot = snapshotJsonValue(rendered)
  assert.notEqual(renderedSnapshot, undefined, `${definition.name}: output.render must return lossless JSON content`)
  assert.ok(
    Array.isArray(renderedSnapshot) && renderedSnapshot.length > 0,
    `${definition.name}: output.render returned no content blocks`,
  )
  for (const block of renderedSnapshot) {
    assert.equal(block.type, 'text', `${definition.name}: render blocks must be text`)
    assert.equal(typeof block.text, 'string', `${definition.name}: render text must be a string`)
  }
  return value
}

const CLEANUP = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  CLEANUP.push(dir)
  return dir
}
function cleanup() {
  for (const dir of CLEANUP) rmSync(dir, { recursive: true, force: true })
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
/**
 * Build a minimal MP4 whose mvhd carries an exact duration: duration = seconds
 * (or frames at fps via the `timescale` override, e.g. 328 frames at 24 fps is
 * an exact 328000/24000 s container, not a rounded decimal).
 */
function mp4Buffer(seconds, timescale = 1000) {
  const mvhd = Buffer.alloc(100)
  mvhd.writeUInt32BE(timescale, 12)
  mvhd.writeUInt32BE(Math.round(seconds * timescale), 16)
  const mvhdBox = Buffer.alloc(8 + mvhd.length)
  mvhdBox.writeUInt32BE(8 + mvhd.length, 0)
  mvhdBox.write('mvhd', 4, 'ascii')
  mvhd.copy(mvhdBox, 8)
  const moov = Buffer.alloc(8 + mvhdBox.length)
  moov.writeUInt32BE(8 + mvhdBox.length, 0)
  moov.write('moov', 4, 'ascii')
  mvhdBox.copy(moov, 8)
  const ftyp = Buffer.alloc(24)
  ftyp.writeUInt32BE(24, 0)
  ftyp.write('ftyp', 4, 'ascii')
  ftyp.write('isom', 8, 'ascii')
  ftyp.write('isomiso2', 16, 'ascii')
  return Buffer.concat([ftyp, moov, Buffer.alloc(1200)])
}
const MP4 = mp4Buffer(5)

// --- registration -------------------------------------------------------
assert.equal(name, 'minimax-video')
assert.deepEqual(inject, ['tools', 'workingDirectory', 'credentials', 'skills'])
assert.equal(typeof apply, 'function')

const definitions = []
const providers = []
const registrationCtx = {
  tools: {
    register(definition) {
      definitions.push(definition)
    },
  },
  credentials: {
    async resolve() {
      throw new Error('credentials must not be read during registration')
    },
  },
  workingDirectory: {
    async ensure() {
      return process.cwd()
    },
  },
  skills: {
    registerProvider(factory) {
      providers.push(factory())
    },
  },
}
apply(registrationCtx, { stateDir: tempDir('h3-register-'), baseURL: 'https://api.minimax.cn' })

assert.deepEqual(definitions.map((definition) => definition.name), [
  'video_models',
  'video_prepare',
  'video_generate',
  'video_task',
  'video_regenerate',
  'video_prompt_enhance',
  'video_budget',
])
const byName = new Map(definitions.map((definition) => [definition.name, definition]))
const generate = byName.get('video_generate')
const prepare = byName.get('video_prepare')
const task = byName.get('video_task')
const regenerate = byName.get('video_regenerate')
const enhance = byName.get('video_prompt_enhance')
const budgetTool = byName.get('video_budget')
const models = byName.get('video_models')

// --- model-facing parameter schemas -------------------------------------
assert.deepEqual(generate.parameters.required, ['prompt'])
assert.deepEqual(generate.parameters.properties.model.enum, [...MODEL_IDS])
assert.deepEqual(generate.parameters.properties.resolution.enum, ['480P', '768P', '2K'])
assert.deepEqual(generate.parameters.properties.ratio.enum, [...RATIOS])
assert.deepEqual(generate.parameters.properties.prompt_expansion.enum, ['disabled', 'balanced', 'quality'])
assert.match(generate.parameters.properties.first_frame.description, /first.frame/i)
assert.ok(generate.parameters.properties.reference_videos.description.includes('15 s total'))
assert.equal(generate.parameters.properties.dry_run.type, 'boolean')
assert.equal(generate.parameters.properties.max_cost.type, 'number')
assert.equal(generate.parameters.properties.dialogue.type, 'array')
assert.deepEqual(generate.parameters.properties.dialogue.items.required, ['speaker', 'line'])
assert.equal(generate.parameters.properties.source_declarations.type, 'array')
assert.equal(generate.parameters.properties.approved_sources.type, 'array')
assert.equal(generate.parameters.properties.prior_record_id.type, 'string')
assert.equal(generate.parameters.properties.budget_id.type, 'string')
assert.equal(generate.parameters.properties.asset_ids.type, 'object')
assert.equal(generate.parameters.properties.asset_ids.properties.first_frame.type, 'string')
assert.equal(generate.parameters.properties.asset_ids.properties.reference_images.type, 'array')
assert.equal(generate.parameters.properties.source_asset_id, undefined)
assert.equal(prepare.parameters.properties.kind.enum.length, 3)
assert.equal(prepare.parameters.properties.shot_id.type, 'string')
assert.equal(prepare.parameters.properties.keyframe_override_reason.type, 'string')
assert.equal(prepare.parameters.properties.source_duration_seconds.type, 'number')
assert.equal(prepare.parameters.properties.asset_ids.properties.base_video.type, 'string')
assert.equal(prepare.parameters.properties.source_asset_id.type, 'string')
assert.equal(regenerate.parameters.properties.original_task_id.type, 'string')
assert.equal(regenerate.parameters.properties.source_duration_seconds.type, 'number')
assert.equal(regenerate.parameters.properties.asset_ids.properties.base_video.type, 'string')
assert.equal(regenerate.parameters.properties.source_asset_id.type, 'string')
assert.deepEqual(task.parameters.required, ['task_id'])
assert.deepEqual(task.parameters.properties.action.enum, ['status', 'cancel'])
assert.deepEqual(enhance.parameters.properties.max_cost.type, 'number')
assert.deepEqual(enhance.parameters.properties.allow_unbounded_cost.type, 'boolean')
assert.deepEqual(enhance.parameters.required, ['prompt'])
assert.deepEqual(budgetTool.parameters.properties.action.enum, ['status', 'create', 'amend', 'release'])
assert.equal(models.parameters.required, undefined)

// The paid tools can return either an offline plan (dry_run) or a submitted
// task, so their output contract is a strict oneOf of both shapes. Neither
// branch may relax its required identifiers or allow undeclared properties.
const paidToolNames = ['video_generate', 'video_regenerate', 'video_prompt_enhance']
for (const definition of definitions) {
  const schema = definition.output.schema
  if (paidToolNames.includes(definition.name)) {
    assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length === 2, `${definition.name}: oneOf(plan, task) expected`)
    assert.equal(schema.type, undefined, `${definition.name}: oneOf must not be combined with a top-level type`)
    const [planBranch, taskBranch] = schema.oneOf
    assert.deepEqual(planBranch.required, ['plan_id', 'status', 'kind'])
    assert.equal(planBranch.additionalProperties, false)
    assert.equal(planBranch.properties.duration.type, 'number')
    assert.deepEqual(taskBranch.required, ['task_id', 'status'])
    assert.equal(taskBranch.additionalProperties, false)
    assert.equal(taskBranch.properties.duration.type, 'number')
    // A value missing the branch identifier is rejected by the host, not accepted.
    assert.ok(
      validateJsonSchemaValue(schema, { status: 'queued' }, 'value').length > 0,
      `${definition.name}: a task-shaped value without task_id must be refused`,
    )
    assert.ok(
      validateJsonSchemaValue(schema, { status: 'prepared', kind: 'generate' }, 'value').length > 0,
      `${definition.name}: a prepared value without plan_id must be refused`,
    )
  } else {
    assert.equal(schema.type, 'object')
    assert.ok(Array.isArray(schema.required))
    assert.ok(schema.properties !== undefined)
  }
}

const paidPreparedRender = generate.output.render({}, {
  plan_id: 'p-1',
  status: 'prepared',
  kind: 'regenerate',
  estimate: '¥1.50 CNY known; worst case ¥3.00 CNY',
  requested_duration: 5,
  source_actual_duration: 12.25,
  diagnostics: [],
})
assert.match(paidPreparedRender[0].text, /plan_id: p-1/)
assert.match(paidPreparedRender[0].text, /prepared: regenerate/)

// Fail-loud proof that the boundary above is not a no-op: both payload shapes
// reported by the user (an own `ratio: undefined` after a real submit, and a
// task-shaped value missing its task id) are rejected as the host rejects them.
assert.throws(
  () => assertHostResult(task, { task_id: 'T1' }, { task_id: 'T1', status: 'queued', duration: 5, ratio: undefined }),
  /non-lossless JSON/,
)
assert.throws(
  () => assertHostResult(task, { task_id: 'T1' }, { status: 'queued', duration: 5 }),
  /missing required property/,
)

const sampleValue = {
  task_id: '123',
  status: 'succeeded',
  model: 'MiniMax-H3',
  resolution: '768P',
  duration: 5,
  ratio: '16:9',
  mode: 'text',
  usage: '5s output',
  estimate: '¥2.50 CNY list (complete)',
  record_id: 'r-1',
  diagnostics: ['warn: [dialogue_tight] tight'],
}
for (const toolName of ['video_generate', 'video_task', 'video_regenerate', 'video_prompt_enhance']) {
  const rendered = byName.get(toolName).output.render({}, sampleValue)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /^123: succeeded/)
  assert.match(rendered[0].text, /estimated ¥2\.50/)
  assert.match(rendered[0].text, /record r-1/)
  assert.match(rendered[0].text, /- warn: \[dialogue_tight\] tight/)
}
const enhanced = enhance.output.render({}, { ...sampleValue, prompt: 'integrated_multimodal_description: [Shot 1] A cup.' })
assert.match(enhanced[0].text, /integrated_multimodal_description: \[Shot 1\] A cup\./)
const preparedRender = prepare.output.render({}, {
  plan_id: 'p-1',
  status: 'prepared',
  kind: 'generate',
  estimate: '¥2.50 CNY list (complete)',
  cost_status: 'complete',
  requested_duration: 5,
  source_actual_duration: null,
  estimated_speech_seconds: 1.2,
  diagnostics: [],
})
assert.match(preparedRender[0].text, /plan_id: p-1/)
assert.match(preparedRender[0].text, /requested 5s; measured source unknown; speech heuristic 1\.2s/)

// --- catalog text and prices -------------------------------------------
assert.equal(regionOf('https://api.minimax.io'), 'global')
assert.equal(regionOf('https://api.minimax.cn'), 'cn')
assert.equal(formatMoney(4, 'cn'), '¥4.00')
assert.equal(formatMoney(0.65, 'global'), '$0.65')

const text = catalogText('cn')
for (const model of MODEL_IDS) assert.ok(text.includes(model), `catalog missing ${model}`)
assert.match(text, /2K/)
assert.match(text, /480P/)
assert.match(text, /768P/)
assert.match(text, /¥0\.80 \| \$0\.13/)
assert.match(text, /¥5\.50/)
assert.match(text, /¥4\.00/)
assert.match(text, /prompt <= 7000/)
assert.match(text, /768P -> 2K/)
assert.match(text, /video_prepare/)
assert.match(text, /ESTIMATE STATUS/)
assert.equal(text, catalogText('cn'))

// --- model / resolution / duration matrix ------------------------------
assert.deepEqual(planGeneration({}), {
  model: 'MiniMax-H3',
  mode: 'text',
  resolution: '768P',
  duration: 5,
  ratio: '16:9',
})
assert.equal(planGeneration({ resolution: '2K', duration: 15 }).resolution, '2K')
assert.throws(() => planGeneration({ model: 'MiniMax-H3', resolution: '480P' }), /does not support 480P/)
assert.throws(() => planGeneration({ model: 'MiniMax-H3-Lite', resolution: '2K' }), /does not support 2K/)
assert.throws(() => planGeneration({ model: 'MiniMax-H3-Max', duration: 4 }), /5 to 15/)
assert.equal(planGeneration({ model: 'MiniMax-H3-Max', duration: 5, promptExpansion: 'quality' }).promptExpansion, 'quality')
assert.throws(() => planGeneration({ promptExpansion: 'quality' }), /only supported by MiniMax-H3-Max/)
assert.throws(() => planGeneration({ model: 'MiniMax-H3-Max', promptExpansion: 'fast' }), /unknown prompt_expansion/)
// Full native-tool serialization sends disabled on a non-Max tier; it is a no-op
// and must be stripped before the API body, while balanced/quality stay rejected.
assert.equal(planGeneration({ model: 'MiniMax-H3-Lite', promptExpansion: 'disabled' }).promptExpansion, undefined)
const liteNoExpansion = planGeneration({ model: 'MiniMax-H3-Lite', promptExpansion: 'disabled' })
assert.equal('extra' in buildGenerationBody(liteNoExpansion, 'Lite.', { referenceImages: [], referenceVideos: [], referenceAudio: [] }), false)
assert.throws(() => planGeneration({ model: 'MiniMax-H3-Lite', promptExpansion: 'balanced' }), /only supported by MiniMax-H3-Max/)
assert.throws(() => planGeneration({ model: 'MiniMax-H3-Lite', promptExpansion: 'quality' }), /only supported by MiniMax-H3-Max/)

assert.equal(inferMode({}), 'text')
assert.equal(inferMode({ firstFrame: 'a.png' }), 'image')
assert.equal(inferMode({ firstFrame: 'a.png', lastFrame: 'b.png' }), 'image')
assert.equal(inferMode({ referenceImages: ['a.png'] }), 'reference')
assert.throws(() => inferMode({ lastFrame: 'b.png' }), /requires first_frame/)
assert.throws(() => inferMode({ firstFrame: 'a.png', referenceImages: ['b.png'] }), /cannot be mixed/)
assert.throws(() => inferMode({ firstFrame: 'a.png', referenceAudio: ['voice.wav'] }), /voice-timbre continuity/)

assert.equal(normalizeRatio({ mode: 'text', model: 'MiniMax-H3' }), '16:9')
assert.throws(() => normalizeRatio({ mode: 'text', model: 'MiniMax-H3', ratio: 'adaptive' }), /needs a concrete ratio/)
assert.equal(normalizeRatio({ mode: 'image', model: 'MiniMax-H3', ratio: '9:16' }), 'adaptive')
assert.equal(normalizeRatio({ mode: 'reference', model: 'MiniMax-H3' }), 'adaptive')
assert.throws(() => normalizeRatio({ mode: 'reference', model: 'MiniMax-H3-Lite', ratio: 'adaptive' }), /does not support adaptive/)
assert.equal(normalizeRatio({ mode: 'reference', model: 'MiniMax-H3-Lite', ratio: '16:9' }), '16:9')

// --- limits -------------------------------------------------------------
assert.equal(validatePrompt('hello'), 'hello')
assert.throws(() => validatePrompt('   '), /non-empty/)
assert.throws(() => validatePrompt('x'.repeat(LIMITS.promptChars + 1)), /7000/)
validateReferenceCounts({ referenceImages: Array(9).fill('x') })
assert.throws(() => validateReferenceCounts({ referenceImages: Array(10).fill('x') }), /at most 9/)
assert.throws(() => validateReferenceCounts({ referenceVideos: Array(4).fill('x') }), /at most 3/)
assert.throws(() => validateReferenceCounts({ referenceAudio: Array(4).fill('x') }), /at most 3/)
assert.throws(
  () => validateReferenceCounts({ referenceImages: Array(9).fill('x'), referenceVideos: Array(3).fill('x'), referenceAudio: ['x'] }),
  /capped at 12/,
)

// --- cost estimates -----------------------------------------------------
const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`)
near(estimateGenerationCost({ model: 'MiniMax-H3', resolution: '2K', duration: 5 }).amount, 4)
near(estimateGenerationCost({ model: 'MiniMax-H3', resolution: '768P', duration: 5, imageCount: 7 }).amount, 2.9)
near(estimateGenerationCost({ model: 'MiniMax-H3-Max', resolution: '480P', duration: 5, imageCount: 3 }).amount, 2.15)
near(estimateGenerationCost({ model: 'MiniMax-H3', resolution: '2K', duration: 5, region: 'global' }).amount, 0.65)
assert.equal(REGENERATION.prices.cn['2K'].output, 0.3)

const generatePlan = planGeneration({ duration: 5 })
const genAssets = []
const complete = estimateGeneration({ plan: generatePlan, assets: genAssets, region: 'cn' })
assert.equal(complete.status, 'complete')
near(complete.amount, 2.5)
assert.match(formatEstimate(complete), /¥2\.50 CNY list \(complete\)/)

const partial = estimateGeneration({
  plan: planGeneration({ model: 'MiniMax-H3-Max', duration: 5 }),
  assets: [{ slot: 'reference_video', kind: 'video', origin: 'url', sha256: 'x' }],
  region: 'cn',
})
assert.equal(partial.status, 'partial')
near(partial.unknown_items.length, 1)
near(partial.upper_bound, 17.05)
const capWarning = enforceCostCap({ estimate: partial, maxCost: 18 })
assert.equal(capWarning[0].code, 'cost_cap_ok')
assert.throws(() => enforceCostCap({ estimate: partial, maxCost: 3 }), /worst-case upper bound/)
assert.throws(() => enforceCostCap({ estimate: complete, maxCost: 1 }), /cost cap exceeded/)
assert.throws(() => enforceCostCap({ estimate: partial, maxCost: 17 }), /cost cap exceeded/)

const unknownCost = estimateContextIr({ region: 'cn' })
assert.equal(unknownCost.status, 'unknown')
assert.match(formatEstimate(unknownCost), /unknown \(Context-IR token usage/)
assert.throws(() => enforceCostCap({ estimate: unknownCost, maxCost: 1 }), /cannot be enforced/)
assert.throws(() => enforceCostCap({ estimate: unknownCost, hasBudget: true }), /cannot run under a budget/)
assert.throws(() => enforceCostCap({ estimate: unknownCost, allowUnboundedCost: true }), /override_reason/)
assert.throws(
  () => enforceCostCap({ estimate: unknownCost, maxCost: 1, allowUnboundedCost: true, overrideReason: 'x' }),
  /cannot be combined/,
)
const unbounded = enforceCostCap({
  estimate: unknownCost,
  allowUnboundedCost: true,
  overrideReason: 'one-off prompt experiment',
})
assert.equal(unbounded[0].level, 'warn')

// --- request bodies -----------------------------------------------------
const sources = {
  firstFrame: 'https://example.com/first.png',
  lastFrame: 'https://example.com/last.png',
  referenceImages: [],
  referenceVideos: [],
  referenceAudio: [],
}
const plan = planGeneration({ resolution: '2K', duration: 8, ...sources })
const body = buildGenerationBody(plan, 'A test prompt.', sources)
assert.equal(body.model, 'MiniMax-H3')
assert.equal(body.resolution, '2K')
assert.equal(body.duration, 8)
assert.equal(body.ratio, 'adaptive')
assert.deepEqual(body.content.map((item) => item.role), [undefined, 'first_frame', 'last_frame'])
assert.equal(body.content[0].type, 'text')

const maxPlan = planGeneration({ model: 'MiniMax-H3-Max', duration: 5, promptExpansion: 'disabled' })
const maxBody = buildGenerationBody(maxPlan, 'Max.', { referenceImages: [], referenceVideos: [], referenceAudio: [] })
assert.deepEqual(maxBody.extra, { prompt_expansion_mode: 'disabled' })

const irBody = buildContextIrBody(plan, 'A test prompt.', sources)
assert.equal(irBody.model, 'MiniMax-H3')
assert.equal('resolution' in irBody, false)

assert.deepEqual(buildRegenerationBody({ sourceTaskId: '123' }), {
  model: 'MiniMax-H3',
  source_task_id: '123',
  resolution: '2K',
})
const regen = buildRegenerationBody({ baseVideo: 'https://example.com/base.mp4', prompt: 'Same prompt.', sources })
assert.equal(regen.content.at(-1).role, 'base_video')
assert.equal(regen.content.at(-1).video_url.url, 'https://example.com/base.mp4')
assert.equal(regen.resolution, '2K')
assert.throws(() => buildRegenerationBody({}), /exactly one/)
assert.throws(() => buildRegenerationBody({ sourceTaskId: '1', baseVideo: '2' }), /exactly one/)
assert.throws(
  () => buildRegenerationBody({ baseVideo: 'https://example.com/base.mp4', prompt: ' ', sources }),
  /original prompt/,
)

const content = buildContent({ prompt: 'P', referenceImages: ['i1'], referenceVideos: ['v1'], referenceAudio: ['a1'] })
assert.deepEqual(content.map((item) => [item.type, item.role]), [
  ['text', undefined],
  ['image_url', 'reference_image'],
  ['video_url', 'reference_video'],
  ['audio_url', 'reference_audio'],
])

// --- media / asset registry / sanitization -----------------------------
assert.equal(resolveMedia(process.cwd(), 'https://example.com/a.png', 'image'), 'https://example.com/a.png')
assert.equal(resolveMedia(process.cwd(), 'mm_file://abc', 'video'), 'mm_file://abc')
assert.equal(resolveMedia(process.cwd(), 'data:image/png;base64,AA', 'image'), 'data:image/png;base64,AA')
assert.throws(() => resolveMedia(process.cwd(), '/definitely/missing.png', 'image'), /cannot read image/)

near(probeMp4Duration(MP4), 5)
assert.equal(probeMp4Duration(Buffer.from('not an mp4 at all')), undefined)

const assetDir = tempDir('h3-assets-')
writeFileSync(join(assetDir, 'frame.png'), PNG)
writeFileSync(join(assetDir, 'clip.mp4'), MP4)
const bundle = buildMediaBundle(assetDir, {
  first_frame: 'frame.png',
  reference_videos: ['clip.mp4'],
  reference_images: ['https://cdn.example.com/pic.png?X-Amz-Signature=TOPSECRET'],
})
assert.equal(bundle.assets.length, 3)
assert.equal(bundle.assets[0].slot, 'first_frame')
assert.equal(bundle.assets[0].origin, 'local')
assert.equal(bundle.assets[0].sha256, sha256Hex(PNG))
near(bundle.assets[2].durationSeconds, 5)
assert.equal(bundle.assets[1].origin, 'url')
assert.equal(bundle.assets[1].query, true)

snapshotLocalAssets(join(assetDir, 'record'), bundle.assets, { maxBytes: 1024 * 1024 })
assert.ok(existsSync(join(assetDir, 'record', bundle.assets[0].copy)))
assert.ok(existsSync(join(assetDir, 'record', bundle.assets[2].copy)))
assert.equal(bundle.assets[1].copy, undefined)

const sanitizeSources = {
  referenceImages: bundle.sources.referenceImages,
  referenceVideos: bundle.sources.referenceVideos,
}
const sanitizedRequest = sanitizeRequestBody(
  buildGenerationBody(planGeneration({ ...sanitizeSources, duration: 5 }), 'A prompt.', sanitizeSources),
  bundle.assets,
)
const requestJson = JSON.stringify(sanitizedRequest)
assert.ok(!requestJson.includes('TOPSECRET'))
assert.ok(!requestJson.includes('data:image'))
assert.ok(requestJson.includes('cdn.example.com'))
assert.equal(sanitizedRequest.content[0].type, 'text')
assert.equal(sanitizedRequest.content[0].chars, 'A prompt.'.length)

const fpBase = operationFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: bundle.assets, contract: {} })
assert.equal(
  fpBase,
  operationFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: bundle.assets, contract: {} }),
)
assert.notEqual(
  fpBase,
  operationFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A different prompt.', assets: bundle.assets, contract: {} }),
)
assert.notEqual(
  fpBase,
  operationFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: [bundle.assets[0]], contract: {} }),
)
const requestBase = requestFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: bundle.assets })
assert.equal(requestBase, requestFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: bundle.assets }))
assert.notEqual(requestBase, requestFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'Other.', assets: bundle.assets }))
assert.notEqual(
  operationFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: bundle.assets, maxCost: 3, contract: {} }),
  operationFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: bundle.assets, maxCost: 4, contract: {} }),
)
// Cost/contract metadata must not change the paid-request fingerprint used for duplicate protection.
assert.equal(
  requestBase,
  requestFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: bundle.assets }),
)
const fingerprintWithBindings = operationFingerprint({
  kind: 'generate',
  plan: generatePlan,
  prompt: 'A prompt.',
  assets: bundle.assets,
  contract: { assetIds: { first_frame: 'kf1', reference_images: ['a', 'b'] }, sourceAssetId: 'src' },
})
assert.equal(
  requestBase,
  requestFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: bundle.assets }),
  'registry bindings are plan-only and must not enter requestFingerprint',
)
assert.notEqual(
  fingerprintWithBindings,
  operationFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: bundle.assets, contract: {} }),
)
assert.equal(
  fingerprintWithBindings,
  operationFingerprint({
    kind: 'generate',
    plan: generatePlan,
    prompt: 'A prompt.',
    assets: bundle.assets,
    contract: { sourceAssetId: 'src', assetIds: { reference_images: ['a', 'b'], first_frame: 'kf1' } },
  }),
  'asset_ids object key order must not change the plan fingerprint',
)

// --- shared nested asset-id and optional-selector normalization ----------
const denseNativeArgs = {
  prompt: 'P',
  first_frame: 'a.png',
  last_frame: '',
  video: null,
  reference_images: [],
  reference_videos: null,
  reference_audio: [],
  asset_ids: {
    first_frame: 'K1',
    last_frame: '',
    base_video: null,
    reference_images: [],
    reference_videos: null,
    reference_audio: [],
  },
  budget_id: '',
  project_manifest: '',
  shot_id: '',
  source_asset_id: '',
  original_task_id: null,
  source_task_id: '',
  max_cost: 0,
}
const denseSnapshot = JSON.stringify(denseNativeArgs)
const denseNormalized = normalizeMediaArgs(denseNativeArgs)
assert.equal(JSON.stringify(denseNativeArgs), denseSnapshot, 'normalization must not mutate its input')
assert.equal(denseNormalized.first_frame, 'a.png')
assert.equal(denseNormalized.last_frame, undefined)
assert.equal(denseNormalized.video, undefined)
assert.equal(denseNormalized.reference_videos, undefined)
assert.deepEqual(denseNormalized.asset_ids, { first_frame: 'K1' })
assert.deepEqual(normalizeAssetIds({ unknown_slot: 'X' }, {}), { unknown_slot: 'X' }, 'unknown slots are preserved for the validator')
assert.equal(denseNormalized.budget_id, undefined)
assert.equal(denseNormalized.project_manifest, undefined)
assert.equal(denseNormalized.shot_id, undefined)
assert.equal(denseNormalized.source_asset_id, undefined)
assert.equal(denseNormalized.original_task_id, undefined)
assert.equal(denseNormalized.source_task_id, undefined)
assert.equal(denseNormalized.prompt, 'P')
assert.equal(denseNormalized.max_cost, 0, 'max_cost=0 keeps its own meaning')

const sparseNativeArgs = { prompt: 'P', first_frame: 'a.png', asset_ids: { first_frame: 'K1' } }
const sparseNormalized = normalizeMediaArgs(sparseNativeArgs)
assert.deepEqual(denseNormalized.asset_ids, sparseNormalized.asset_ids)
const allUnusedIds = normalizeMediaArgs({ asset_ids: { first_frame: '', last_frame: null, reference_images: [], reference_videos: null } })
assert.equal(allUnusedIds.asset_ids, undefined, 'an all-unused id map is equivalent to omission')
assert.deepEqual(normalizeAssetIds({ first_frame: 'K1' }, { first_frame: 'a.png' }), { first_frame: 'K1' })
assert.deepEqual(
  normalizeAssetIds({ first_frame: '' }, { first_frame: 'a.png' }),
  { first_frame: '' },
  'a used scalar slot keeps a blank id so the validator can reject it',
)
assert.deepEqual(
  normalizeAssetIds({ reference_images: ['', 'K1'] }, { reference_images: ['a.png', 'b.png'] }),
  { reference_images: ['', 'K1'] },
  'used id arrays are never filtered or shifted',
)
assert.deepEqual(
  normalizeAssetIds({ reference_images: ['K1'] }, {}),
  { reference_images: ['K1'] },
  'a real id without media is preserved for the without-media error',
)
assert.deepEqual(
  normalizeAssetIds({ reference_images: [] }, {}),
  undefined,
  'an unused empty id array is dropped',
)
const protoArgs = JSON.parse('{"__proto__":{"polluted":true},"first_frame":"K1"}')
const protoNormalized = normalizeAssetIds(protoArgs, { first_frame: 'a.png' })
assert.equal(Object.hasOwn(protoNormalized, '__proto__'), true, 'unknown __proto__ slot is preserved for the validator')
assert.deepEqual(protoNormalized.first_frame, 'K1')
assert.equal({}.polluted, undefined, 'normalization must not pollute Object.prototype')
assert.equal(normalizeAssetIds({ images: [] }, {}), undefined)
assert.deepEqual(
  normalizeAssetIds({ images: ['IMG1'] }, { images: ['a.png'] }),
  { images: ['IMG1'] },
  'production CLI images slot is normalized like other arrays',
)
assert.equal(normalizeMediaArgs({ prompt: '' }).prompt, '', 'required prompt is not relaxed')
assert.deepEqual(
  normalizeMediaArgs({ asset_ids: ['bad'] }).asset_ids,
  ['bad'],
  'wrong asset_ids type is preserved for the validator',
)

const densePlanFingerprint = operationFingerprint({
  kind: 'generate',
  plan: generatePlan,
  prompt: 'A prompt.',
  assets: bundle.assets,
  contract: { assetIds: denseNormalized.asset_ids },
})
const sparsePlanFingerprint = operationFingerprint({
  kind: 'generate',
  plan: generatePlan,
  prompt: 'A prompt.',
  assets: bundle.assets,
  contract: { assetIds: sparseNormalized.asset_ids },
})
assert.equal(densePlanFingerprint, sparsePlanFingerprint, 'dense/sparse valid asset ids must share the plan fingerprint')
assert.equal(
  requestFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: bundle.assets }),
  requestFingerprint({ kind: 'generate', plan: generatePlan, prompt: 'A prompt.', assets: bundle.assets }),
)

assert.equal(imageCountOf({ referenceImages: ['a', 'b'] }), 2)
assert.equal(imageCountOf({ firstFrame: 'a', lastFrame: 'b', referenceImages: [] }), 2)
assert.ok(assertRequestSize({ content: [{ type: 'text', text: 'hello' }] }) > 0)
assert.throws(
  () => assertRequestSize({ content: [{ type: 'text', text: 'x'.repeat(LIMITS.requestBytes + 1) }] }),
  /64 MB/,
)

// --- prompt / reference / provenance contracts -------------------------
assert.ok(speechSeconds('我们到了。') > 0)
assert.ok(speechSeconds('hello world') > 0)
assert.equal(checkDialogue({ prompt: 'x', dialogue: [], duration: 5 }).length, 0)

const goodDialogue = checkDialogue({
  prompt: '小雅说：“我们到了。”然后她挥手。',
  dialogue: [{ speaker: '小雅', line: '我们到了。' }],
  duration: 5,
  requestedDuration: 5,
})
assert.ok(goodDialogue.some((entry) => entry.code === 'speech_estimate_heuristic' && entry.level === 'info'))
assert.ok(!goodDialogue.some((entry) => entry.level === 'error'))

const missingDialogue = checkDialogue({
  prompt: 'A cup on a table.',
  dialogue: [{ speaker: '小雅', line: '我们到了。' }],
  duration: 5,
})
assert.ok(missingDialogue.some((entry) => entry.code === 'dialogue_missing' && entry.level === 'error'))

const impossibleDialogue = checkDialogue({
  prompt: '小雅说：“' + '很长的一句中文台词'.repeat(8) + '”',
  dialogue: [{ speaker: '小雅', line: '很长的一句中文台词'.repeat(8) }],
  duration: 2,
  requestedDuration: 2,
})
assert.ok(impossibleDialogue.some((entry) => entry.code === 'dialogue_too_long' && entry.level === 'error'))

const contractAssets = [
  { slot: 'reference_image', kind: 'image', sha256: 'a' },
  { slot: 'reference_video', kind: 'video', sha256: 'b', durationSeconds: 5 },
]
const tagError = checkMediaContract({
  prompt: 'A <Picture 3> shot.',
  assets: contractAssets,
})
assert.ok(tagError.some((entry) => entry.code === 'reference_tag_out_of_range' && entry.level === 'error'))
assert.ok(tagError.some((entry) => entry.code === 'reference_not_referenced'))

const roleMismatch = checkMediaContract({
  prompt: 'A <Picture 1> <Video 1>.',
  assets: contractAssets,
  referenceRoles: ['hero'],
})
assert.ok(roleMismatch.some((entry) => entry.code === 'reference_roles_count'))

const sourceCount = checkMediaContract({
  prompt: 'A <Picture 1> <Video 1>.',
  assets: contractAssets,
  sourceDeclarations: ['own-shoot'],
  approvedSources: ['own-shoot'],
})
assert.ok(sourceCount.some((entry) => entry.code === 'source_declarations_count'))

const sourceApproval = checkMediaContract({
  prompt: 'A <Picture 1> <Video 1>.',
  assets: contractAssets,
  sourceDeclarations: ['own-shoot', 'stock'],
  approvedSources: ['own-shoot'],
})
assert.ok(sourceApproval.some((entry) => entry.code === 'source_not_approved' && entry.level === 'error'))

const hostPolicy = checkMediaContract({
  prompt: 'A <Picture 1>.',
  assets: [{ slot: 'reference_image', kind: 'image', sha256: 'a', origin: 'url', host: 'evil.example' }],
  approvedHosts: ['cdn.example.com'],
})
assert.ok(hostPolicy.some((entry) => entry.code === 'source_host_not_approved' && entry.level === 'error'))

const strictRoles = checkMediaContract({
  prompt: 'A <Picture 1>.',
  assets: contractAssets,
  strict: true,
  sourceDeclarations: ['own-shoot', 'own-shoot'],
})
assert.ok(strictRoles.some((entry) => entry.code === 'reference_roles_required' && entry.level === 'error'))

const videoTooLong = checkMediaDurations([
  { slot: 'reference_video', kind: 'video', durationSeconds: 10 },
  { slot: 'reference_video', kind: 'video', durationSeconds: 10 },
])
assert.ok(videoTooLong.some((entry) => entry.code === 'reference_video_total' && entry.level === 'error'))
const baseTooShort = checkMediaDurations([{ slot: 'base_video', kind: 'video', durationSeconds: 2 }])
assert.ok(baseTooShort.some((entry) => entry.code === 'base_video_duration' && entry.level === 'error'))

// --- cost estimates for regeneration -----------------------------------
const regenPartial = estimateRegeneration({ assets: [{ slot: 'base_video', kind: 'video', sha256: 'x' }], region: 'cn' })
assert.equal(regenPartial.status, 'partial')
near(regenPartial.amount, 1.2)
near(regenPartial.upper_bound, 9)
const regenKnown = estimateRegeneration({ region: 'cn', originalDuration: 5 })
assert.equal(regenKnown.status, 'partial')
near(regenKnown.amount, 1.5)
near(regenKnown.upper_bound, 3)
const regenRefs = estimateRegeneration({
  assets: [
    { slot: 'base_video', kind: 'video', durationSeconds: 5, sha256: 'x' },
    { slot: 'reference_video', kind: 'video', durationSeconds: 2, sha256: 'y' },
  ],
  region: 'cn',
  originalDuration: 5,
  referenceVideoSeconds: 2,
  unknownReferenceVideos: 0,
})
assert.equal(regenRefs.status, 'partial')
near(regenRefs.amount, 2.1)
near(regenRefs.upper_bound, 3.6)
const regenUnknownRefs = estimateRegeneration({
  region: 'cn',
  originalDuration: 5,
  referenceVideoSeconds: 2,
  unknownReferenceVideos: 1,
})
assert.equal(regenUnknownRefs.status, 'partial')
near(regenUnknownRefs.amount, 2.1)
near(regenUnknownRefs.upper_bound, 7.5)
assert.ok(regenUnknownRefs.unknown_items.some((entry) => entry.item === 'original reference-video duration'))
assert.ok(regenRefs.assumption.includes('base-clip'))

// --- durable journal unit checks ---------------------------------------
const journalDir = tempDir('h3-journal-')
const journal = new TaskJournal(journalDir)
const recordFor = (fingerprint, recordId) => ({
  schema: 1,
  record_id: recordId,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  status: 'submitting',
  task_type: 'generate',
  fingerprint,
  request: { model: 'MiniMax-H3' },
  assets: [],
  estimate: { status: 'complete', amount: 2.5 },
  attempts: [],
  audit: [],
})
const firstRecord = journal.createIntent(recordFor('fp-one', 'r-one'))
journal.commitTask(firstRecord, 'task-one')
assert.equal(readdirSync(journalDir).filter((entry) => entry.startsWith('task-')).length, 1)
assert.equal(journal.findByTaskId('task-one').task_id, 'task-one')
assert.equal(journal.findBlocking('fp-one', { dedupeWindowMs: 600_000 }).kind, 'recent')
assert.equal(journal.findBlocking('fp-other', { dedupeWindowMs: 600_000 }), undefined)

const secondIntent = journal.createIntent(recordFor('fp-one', 'r-two'))
assert.throws(() => journal.createIntent(recordFor('fp-one', 'r-three')), /unresolved outcome|identical request/)
journal.closeIntent(secondIntent, { ambiguous: false, error: new Error('HTTP 400 rejected') })
assert.equal(journal.findBlocking('fp-one', { dedupeWindowMs: 600_000 }).kind, 'recent')

const unknownIntent = journal.createIntent(recordFor('fp-unknown', 'r-unknown'))
journal.closeIntent(unknownIntent, { ambiguous: true, error: new Error('network down') })
const blockedUnknown = journal.findBlocking('fp-unknown', { dedupeWindowMs: 600_000 })
assert.equal(blockedUnknown.kind, 'unknown')
assert.equal(blockedUnknown.record.record_id, 'r-unknown')
assert.equal(journal.findByTaskId('missing-task'), undefined)

// --- advisory lock ownership and stale recovery ------------------------
{
  const lockDir = tempDir('h3-lock-')
  const lockFile = join(lockDir, 'record.json.lock')
  const release = acquireLock(lockFile)
  assert.ok(existsSync(lockFile))
  release()
  assert.equal(existsSync(lockFile), false)

  const releaseForeign = acquireLock(lockFile)
  atomicWriteJson(lockFile, { pid: process.pid, host: hostname(), nonce: 'not-mine', created_at: new Date(0).toISOString() })
  releaseForeign()
  assert.ok(existsSync(lockFile), 'release must not delete a lock owned by another nonce')
  rmSync(lockFile, { force: true })

  atomicWriteJson(lockFile, {
    pid: 999_999,
    host: hostname(),
    nonce: 'dead-owner',
    created_at: new Date(0).toISOString(),
  })
  const reclaimed = acquireLock(lockFile, { timeoutMs: 1_000 })
  assert.ok(existsSync(lockFile))
  reclaimed()
  assert.equal(existsSync(lockFile), false)

  atomicWriteJson(lockFile, {
    pid: process.pid,
    host: hostname(),
    nonce: 'alive-owner',
    created_at: new Date(0).toISOString(),
  })
  assert.throws(() => acquireLock(lockFile, { timeoutMs: 60 }), /live process/)
  assert.ok(existsSync(lockFile), 'a live owner lock must not be stolen by age')
  rmSync(lockFile, { force: true })

  atomicWriteJson(lockFile, {
    pid: 999_999,
    host: 'another-host',
    nonce: 'foreign-host',
    created_at: new Date(0).toISOString(),
  })
  assert.throws(() => acquireLock(lockFile, { timeoutMs: 60 }), /another host/)
  rmSync(lockFile, { force: true })
}

// --- prepared plan store ------------------------------------------------
const planDir = tempDir('h3-plans-')
const planStore = new PlanStore({ dir: planDir, ttlSeconds: 60 })
const storedPlan = planStore.write({ kind: 'generate', fingerprint: 'fp-plan', estimate: { status: 'complete' } })
assert.match(storedPlan.plan_id, /^p-/)
assert.equal(planStore.peek(storedPlan.plan_id, { kind: 'generate', fingerprint: 'fp-plan' }).plan_id, storedPlan.plan_id)
assert.throws(() => planStore.peek(storedPlan.plan_id, { fingerprint: 'other' }), /arguments differ/)
planStore.claim(storedPlan.plan_id, { kind: 'generate', fingerprint: 'fp-plan' })
assert.throws(() => planStore.claim(storedPlan.plan_id), /already consumed/)
assert.throws(() => planStore.peek('p-missing'), /unknown or expired/)

// --- budget ledger ------------------------------------------------------
const budgetDir = tempDir('h3-budgets-')
const ledger = new BudgetLedger(budgetDir)
ledger.ensure({ budgetId: 'shots', limit: 10, currency: 'CNY', note: 'test budget' })
assert.equal(ledger.load('shots').limit, 10)
const reservation = ledger.reserve({ budgetId: 'shots', recordId: 'r-a', amount: 4, taskType: 'generate', estimateAmount: 2.5 }).reservation
assert.equal(reservation.status, 'held')
assert.throws(() => ledger.precheck('shots', 7, 'CNY'), /left/)
ledger.attachTask({ budgetId: 'shots', recordId: 'r-a', taskId: 'task-a' })
ledger.settle({ budgetId: 'shots', recordId: 'r-a', amount: 2.5, reason: 'succeeded' })
assert.equal(ledger.summary('shots').used, 2.5)
assert.throws(() => ledger.ensure({ budgetId: 'shots', limit: 20, currency: 'CNY' }), /cannot raise or change/)
assert.throws(() => ledger.amend({ budgetId: 'shots', limit: 1, reason: 'lower' }), /already held/)
ledger.amend({ budgetId: 'shots', limit: 20, reason: 'approved extra spend' })
assert.equal(ledger.summary('shots').limit, 20)
const released = ledger.reserve({ budgetId: 'shots', recordId: 'r-b', amount: 3, taskType: 'generate' }).reservation
assert.throws(() => ledger.release({ budgetId: 'shots', recordId: 'r-b' }), /requires a reason/)
ledger.release({ budgetId: 'shots', recordId: 'r-b', reason: 'reconciled: not billed' })
assert.equal(ledger.summary('shots').reservations.find((entry) => entry.reservation_id === released.reservation_id).status, 'released')
assert.throws(() => ledger.load('missing-budget'), /unknown budget/)

// --- cross-process durability and budget reservation -------------------
const childScript = join(tempDir('h3-child-'), 'child.mjs')
writeFileSync(childScript, `
import { TaskJournal } from ${JSON.stringify(new URL('../lib/journal.js', import.meta.url).href)}
import { BudgetLedger } from ${JSON.stringify(new URL('../lib/budget.js', import.meta.url).href)}
const [mode, dir, key, taskId] = process.argv.slice(2)
try {
  if (mode === 'journal') {
    const journal = new TaskJournal(dir)
    const now = new Date().toISOString()
    const record = { schema: 1, record_id: 'r-' + key, created_at: now, updated_at: now, status: 'submitting', task_type: 'generate', fingerprint: key, attempts: [], audit: [] }
    journal.createIntent(record)
    await new Promise((resolve) => setTimeout(resolve, 150))
    journal.commitTask(record, taskId)
  } else if (mode === 'ensure') {
    const ledger = new BudgetLedger(dir)
    ledger.ensure({ budgetId: key, limit: Number(taskId), currency: 'CNY' })
  } else {
    const ledger = new BudgetLedger(dir)
    ledger.ensure({ budgetId: 'race', limit: 1, currency: 'CNY' })
    ledger.reserve({ budgetId: 'race', recordId: 'r-' + key, amount: 0.4, taskType: 'generate' })
  }
  process.stdout.write('ok')
} catch (error) {
  process.stdout.write('err:' + error.name)
  process.exit(2)
}
`)
function runChild(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [childScript, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}
const raceJournalDir = tempDir('h3-race-journal-')
const uniqueRuns = await Promise.all(
  Array.from({ length: 4 }, (_, index) => runChild(['journal', raceJournalDir, `fp-${index}`, `task-${index}`])),
)
for (const run of uniqueRuns) {
  assert.equal(run.code, 0, run.stderr)
  assert.equal(run.stdout, 'ok')
}
assert.equal(readdirSync(raceJournalDir).filter((entry) => entry.startsWith('task-')).length, 4)
const sameRuns = await Promise.all(
  Array.from({ length: 4 }, (_, index) => runChild(['journal', raceJournalDir, 'fp-shared', `shared-${index}`])),
)
assert.equal(sameRuns.filter((run) => run.code === 0).length, 1)
assert.equal(sameRuns.filter((run) => run.code === 2).length, 3)

const raceBudgetDir = tempDir('h3-race-budget-')
const budgetRuns = await Promise.all(
  Array.from({ length: 4 }, (_, index) => runChild(['reserve', raceBudgetDir, `b-${index}`, `x-${index}`])),
)
assert.equal(budgetRuns.filter((run) => run.code === 0).length, 2)
assert.equal(budgetRuns.filter((run) => run.code === 2).length, 2)
const raceLedger = new BudgetLedger(raceBudgetDir)
assert.equal(raceLedger.summary('race').held, 0.8)

// Two processes racing to create the same budget id with different caps: one
// wins and the other must be rejected, never silently accept the higher cap.
const ensureRaceDir = tempDir('h3-ensure-race-')
const ensureRuns = await Promise.all([
  runChild(['ensure', ensureRaceDir, 'same-id', '1']),
  runChild(['ensure', ensureRaceDir, 'same-id', '9']),
])
assert.equal(ensureRuns.filter((run) => run.code === 0).length, 1)
assert.equal(ensureRuns.filter((run) => run.code === 2).length, 1)
const ensureLedger = new BudgetLedger(ensureRaceDir)
const winner = ensureLedger.load('same-id')
assert.ok(winner.limit === 1 || winner.limit === 9)
assert.throws(
  () => ensureLedger.ensure({ budgetId: 'same-id', limit: winner.limit === 1 ? 9 : 1, currency: 'CNY' }),
  /cannot raise or change/,
)

// --- download naming and reuse -----------------------------------------
{
  const downloadDir = tempDir('h3-download-')
  const calls = mockFetch(() => mp4Response())
  try {
    const first = await downloadVideo('https://cdn.example.com/a.mp4', { directory: downloadDir, stem: 'same-stem' })
    const second = await downloadVideo('https://cdn.example.com/a.mp4', { directory: downloadDir, stem: 'same-stem' })
    assert.notEqual(first.file, second.file)
    assert.ok(first.file.endsWith('.mp4') && second.file.endsWith('.mp4'))
    assert.ok(existsSync(first.file) && existsSync(second.file))
    const reused = await downloadVideo('https://cdn.example.com/a.mp4', { directory: downloadDir, stem: 'x', existingFile: first.file })
    assert.equal(reused.reused, true)
    assert.equal(reused.file, first.file)
    assert.equal(calls.calls.length, 2)
  } finally {
    calls.restore()
  }
}

// --- mocked-network harness --------------------------------------------
function mp4Response() {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => MP4.buffer.slice(MP4.byteOffset, MP4.byteOffset + MP4.byteLength),
  }
}
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload),
})
function mockFetch(routes) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), method: init?.method ?? 'GET', init }
    calls.push(call)
    const response = routes(call)
    if (response === undefined) throw new Error(`unexpected fetch ${call.method} ${call.url}`)
    return response
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}
function harness({ cwd = tempDir('h3-cwd-'), stateDir = tempDir('h3-state-'), config = {} } = {}) {
  const definitionsHere = []
  const credentialCalls = { count: 0 }
  const ctx = {
    tools: {
      register(definition) {
        definitionsHere.push(definition)
      },
    },
    credentials: {
      async resolve() {
        credentialCalls.count += 1
        return { value: 'test-key-not-to-be-persisted' }
      },
    },
    workingDirectory: {
      async ensure() {
        return cwd
      },
    },
    skills: {
      registerProvider() {},
    },
  }
  apply(ctx, {
    baseURL: 'https://api.minimax.cn',
    stateDir,
    pollIntervalMs: 1,
    maxWaitSeconds: 10,
    ...config,
  })
  const map = new Map(definitionsHere.map((definition) => [definition.name, definition]))
  return {
    cwd,
    stateDir,
    credentialCalls,
    tool(toolName) {
      return map.get(toolName)
    },
    async run(toolName, args) {
      const definition = map.get(toolName)
      assert.ok(definition !== undefined, `unknown tool ${toolName}`)
      const result = await definition.execute(args, execContext)
      // Every successful result goes through the host's output boundary, so a
      // regression like an own `undefined` field or an output.schema mismatch
      // fails here exactly as it would fail in the real tool pipeline.
      return assertHostResult(definition, args, result)
    },
  }
}
/** A small real registered project (approved local character) for H3 preflight tests. */
function makeRegisteredProjectFixture({ prefix = 'h3-project-' } = {}) {
  const root = tempDir(prefix)
  mkdirSync(join(root, '.ai-video'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets', 'char1.png'), PNG)
  writeFileSync(join(root, '.ai-video', 'project.json'), JSON.stringify({
    schema: 'dsh.ai-video-project/1',
    project_id: 'p-test',
    project_root: '..',
    budget: { id: 'project-budget', limit: 5, currency: 'CNY' },
    policy: {},
    assets: [{
      id: 'char1',
      kind: 'character',
      path: 'assets/char1.png',
      sha256: sha256Hex(PNG),
      origin: 'user_supplied',
      approval: 'approved',
      approval_evidence: 'evidence/char1.md',
      root_ids: [],
    }],
    shots: [{ id: 's1', characters: ['char1'], scenes: [], keyframes: [], dialogue: [] }],
  }))
  return root
}

/** A minimal stand-in production validator for H3-side byTask binding tests. */
function mockProductionModule({ sha256, taskId }) {
  const dir = tempDir('h3-mockprod-')
  const file = join(dir, 'project.js')
  const asset = {
    id: 'src',
    usage: 'source_task_id',
    slot: 'source_asset',
    sha256,
    ...(taskId === undefined ? {} : { task_id: taskId }),
  }
  writeFileSync(file, `
export function validateProductionInputs({ args }) {
  return {
    project: { id: 'mock-project', manifest: '/mock/project.json', root: '/mock', budget: null, policy: {} },
    shot: null,
    issues: [],
    warnings: [],
    assets: args.source_task_id ? [${JSON.stringify(asset)}] : [],
  };
}
`)
  return file
}

const execContext = { agent: { id: 'test' }, signal: undefined }
function recordsOf(stateDir) {
  const dir = join(stateDir, 'journal')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => JSON.parse(readFileSync(join(dir, entry), 'utf8')))
}
function budgetOf(stateDir, budgetId) {
  const dir = join(stateDir, 'budgets')
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const value = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
    if (value.budget_id === budgetId) return value
  }
  return undefined
}
const successRoute = (taskId) => (call) => {
  if (call.url.endsWith('/v2/video_generation')) return jsonResponse({ task_id: taskId })
  if (call.url.endsWith('/v2/video_regeneration')) return jsonResponse({ task_id: taskId })
  if (call.url.endsWith('/v2/h3_context_ir')) return jsonResponse({ task_id: taskId })
  if (call.url.includes(`/v2/query/video_generation/${taskId}`)) {
    return jsonResponse({
      task: { id: taskId, status: 'succeeded', content: { url: `https://cdn.example.com/${taskId}.mp4?token=SIGNED-TOKEN` }, usage: { output_seconds: 5 } },
    })
  }
  if (call.url.startsWith('https://cdn.example.com/')) return mp4Response()
  return undefined
}

try {
  // 1. prepare: no network, no credential read, plan recorded
  {
    const h = harness()
    const calls = mockFetch(() => {
      throw new Error('prepare must not touch the network')
    })
    try {
      const prepared = await h.run('video_prepare', { prompt: 'A cup on a table.', duration: 5 })
      assert.equal(prepared.status, 'prepared')
      assert.match(prepared.plan_id, /^p-/)
      assert.equal(prepared.cost_status, 'complete')
      assert.equal(prepared.estimate, '¥2.50 CNY list (complete); output')
      assert.match(prepared.note, /no paid call/)
      assert.equal(calls.calls.length, 0)
      assert.equal(h.credentialCalls.count, 0)
      assert.ok(existsSync(join(h.stateDir, 'plans', `plan-${prepared.plan_id}.json`)))
    } finally {
      calls.restore()
    }
  }

  // 1b. blank optional media means absent; a referenced tag without media still blocks
  {
    const h = harness()
    const calls = mockFetch(() => {
      throw new Error('blank optional media must stay offline')
    })
    try {
      const prepared = await h.run('video_prepare', {
        prompt: 'Text only.',
        first_frame: '',
        last_frame: '   ',
        reference_images: [''],
        duration: 5,
      })
      assert.equal(prepared.mode, 'text')
      await assert.rejects(
        () => h.run('video_prepare', { prompt: 'A <Picture 1> shot.', reference_images: [''] }),
        /reference_tag_out_of_range/,
      )
      await assert.rejects(
        () => h.run('video_prepare', { prompt: 'A <Audio 1> line.', reference_audio: ['  '] }),
        /reference_tag_out_of_range/,
      )
      assert.equal(calls.calls.length, 0)
    } finally {
      calls.restore()
    }
  }

  // 1c. serialized prompt_expansion:disabled on a non-Max tier is a stripped no-op
  {
    const h = harness()
    const calls = mockFetch(successRoute('T123'))
    try {
      const prepared = await h.run('video_prepare', {
        prompt: 'Lite no expansion.',
        model: 'MiniMax-H3-Lite',
        prompt_expansion: 'disabled',
      })
      assert.equal(prepared.status, 'prepared')
      assert.equal(prepared.model, 'MiniMax-H3-Lite')
      await h.run('video_generate', {
        prompt: 'Lite no expansion.',
        model: 'MiniMax-H3-Lite',
        prompt_expansion: 'disabled',
        wait: false,
      })
      const post = calls.calls.find((call) => call.method === 'POST')
      assert.ok(post !== undefined)
      const apiBody = JSON.parse(post.init.body)
      assert.equal('extra' in apiBody, false, 'non-Max disabled must never send prompt_expansion to the API')
    } finally {
      calls.restore()
    }
  }

  // 2. paid success journals before polling, sanitizes signed URLs and settles budget
  {
    const h = harness()
    await h.run('video_budget', { action: 'create', budget_id: 'b-main', limit: 10, currency: 'CNY' })
    const calls = mockFetch(successRoute('T100'))
    try {
      const result = await h.run('video_generate', {
        prompt: 'A cup.',
        budget_id: 'b-main',
        reference_images: ['https://cdn.example.com/ref.png?X-Amz-Signature=TOPSECRET'],
        wait: true,
      })
      assert.equal(result.task_id, 'T100')
      assert.equal(result.status, 'succeeded')
      assert.ok(result.file.endsWith('.mp4'))
      assert.equal(result.record_id.startsWith('r-'), true)
      assert.equal(result.cost_status, 'complete')
      assert.equal(result.diagnostics.length > 0, true)
      assert.equal(calls.calls.length, 3)
      const record = recordsOf(h.stateDir).find((entry) => entry.record_id === result.record_id)
      assert.ok(record !== undefined)
      assert.equal(record.task_id, 'T100')
      assert.equal(record.status, 'succeeded')
      assert.equal(record.estimate.status, 'complete')
      assert.equal(record.assets[0].origin, 'url')
      assert.equal(record.assets[0].copy, undefined)
      assert.deepEqual(record.assets[0].query_present, true)
      assert.equal(record.assets[0].host, 'cdn.example.com')
      assert.equal(record.assets[0].path, '/ref.png')
      const persisted = JSON.stringify(record)
      assert.ok(!persisted.includes('TOPSECRET'))
      assert.ok(!persisted.includes('test-key-not-to-be-persisted'))
      assert.ok(!persisted.includes('SIGNED-TOKEN'))
      assert.ok(!persisted.includes('data:image'))
      assert.equal(budgetOf(h.stateDir, 'b-main').reservations[0].status, 'settled')
      assert.equal(budgetOf(h.stateDir, 'b-main').reservations[0].settled_amount, 2.5)
    } finally {
      calls.restore()
    }
  }

  // 3. max_cost and budget block before credentials/network
  {
    const h = harness()
    await h.run('video_budget', { action: 'create', budget_id: 'b-low', limit: 1, currency: 'CNY' })
    const calls = mockFetch(() => {
      throw new Error('blocked calls must not reach the network')
    })
    try {
      await assert.rejects(() => h.run('video_generate', { prompt: 'A cup.', max_cost: 1 }), /cost cap exceeded/)
      assert.equal(calls.calls.length, 0)
      assert.equal(h.credentialCalls.count, 0)
      await assert.rejects(() => h.run('video_generate', { prompt: 'A cup.', budget_id: 'b-low' }), /has .* left/)
      assert.equal(calls.calls.length, 0)
      assert.equal(h.credentialCalls.count, 0)
      await assert.rejects(
        () => h.run('video_prompt_enhance', { prompt: 'A cup.', max_cost: 1 }),
        /cannot be enforced/,
      )
      await assert.rejects(
        () => h.run('video_prompt_enhance', { prompt: 'A cup.', allow_unbounded_cost: true }),
        /override_reason/,
      )
      await assert.rejects(
        () => h.run('video_prompt_enhance', { prompt: 'A cup.', max_cost: 1, allow_unbounded_cost: true, override_reason: 'try it' }),
        /cannot be combined/,
      )
      assert.equal(calls.calls.length, 0)
    } finally {
      calls.restore()
    }
  }

  // 4. prepared plan executes exactly once; changed arguments are refused
  {
    const h = harness()
    const calls = mockFetch(successRoute('T101'))
    try {
      const prepared = await h.run('video_prepare', { prompt: 'Plan me.', duration: 5 })
      await assert.rejects(
        () => h.run('video_generate', { prompt: 'Plan changed.', plan_id: prepared.plan_id }),
        /arguments differ/,
      )
      assert.equal(calls.calls.length, 0)
      await assert.rejects(
        () => h.run('video_generate', { prompt: 'Plan me.', plan_id: prepared.plan_id, max_cost: 3 }),
        /arguments differ/,
      )
      assert.equal(calls.calls.length, 0)
      const executed = await h.run('video_generate', { prompt: 'Plan me.', plan_id: prepared.plan_id })
      assert.equal(executed.task_id, 'T101')
      await assert.rejects(
        () => h.run('video_generate', { prompt: 'Plan me.', plan_id: prepared.plan_id }),
        /already consumed/,
      )
      assert.equal(calls.calls.length, 3)
    } finally {
      calls.restore()
    }
  }

  // 5. unknown submission blocks silent retries and requires reason + prior record
  {
    const h = harness()
    await h.run('video_budget', { action: 'create', budget_id: 'b-unknown', limit: 10, currency: 'CNY' })
    let mode = 'fail'
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v2/video_generation')) {
        if (mode === 'fail') throw new Error('network down')
        return jsonResponse({ task_id: 'T102' })
      }
      if (call.url.includes('/v2/query/video_generation/T102')) {
        return jsonResponse({ task: { id: 'T102', status: 'succeeded', content: { url: 'https://cdn.example.com/T102.mp4' } } })
      }
      if (call.url.startsWith('https://cdn.example.com/')) return mp4Response()
      return undefined
    })
    try {
      await assert.rejects(
        () => h.run('video_generate', { prompt: 'Uncertain submit.', budget_id: 'b-unknown', wait: false }),
        /outcome is unknown/,
      )
      assert.equal(calls.calls.length, 1)
      const pending = recordsOf(h.stateDir).find((entry) => entry.status === 'unknown')
      assert.ok(pending !== undefined)
      assert.equal(pending.task_id, undefined)
      const budget = budgetOf(h.stateDir, 'b-unknown')
      assert.equal(budget.reservations[0].status, 'held')
      mode = 'ok'
      await assert.rejects(
        () => h.run('video_generate', { prompt: 'Uncertain submit.', budget_id: 'b-unknown', wait: false }),
        /unresolved outcome/,
      )
      assert.equal(calls.calls.length, 1)
      // Same paid payload with different cost metadata must not bypass the
      // unknown-submission duplicate guard.
      await assert.rejects(
        () => h.run('video_generate', { prompt: 'Uncertain submit.', budget_id: 'b-unknown', wait: false, max_cost: 20 }),
        /unresolved outcome/,
      )
      assert.equal(calls.calls.length, 1)
      await assert.rejects(
        () => h.run('video_generate', {
          prompt: 'Uncertain submit.',
          budget_id: 'b-unknown',
          wait: false,
          allow_duplicate_risk: true,
          override_reason: 'checked console, no task appeared',
          prior_record_id: 'wrong-id',
        }),
        /prior_record_id/,
      )
      const result = await h.run('video_generate', {
        prompt: 'Uncertain submit.',
        budget_id: 'b-unknown',
        wait: false,
        allow_duplicate_risk: true,
        override_reason: 'checked console, no task appeared',
        prior_record_id: pending.record_id,
      })
      assert.equal(result.task_id, 'T102')
      assert.equal(calls.calls.length, 2)
      const records = recordsOf(h.stateDir)
      const overridden = records.find((entry) => entry.overrides?.some((override) => override.prior_record_id === pending.record_id))
      assert.ok(overridden !== undefined)
      assert.equal(overridden.overrides[0].reason, 'checked console, no task appeared')
      const archived = records.find((entry) => entry.record_id === pending.record_id)
      assert.equal(archived.status, 'resolved')
      assert.equal(archived.audit.at(-1).prior_record_id, pending.record_id)
    } finally {
      calls.restore()
    }
  }

  // 6. recent duplicate needs allow_duplicate; terminal failure keeps the budget held
  {
    const h = harness()
    await h.run('video_budget', { action: 'create', budget_id: 'b-dup', limit: 20, currency: 'CNY' })
    const calls = mockFetch(successRoute('T103'))
    try {
      await h.run('video_generate', { prompt: 'Repeat me.', budget_id: 'b-dup', wait: false })
      await assert.rejects(
        () => h.run('video_generate', { prompt: 'Repeat me.', budget_id: 'b-dup', wait: false }),
        /allow_duplicate/,
      )
      assert.equal(calls.calls.length, 1)
      const again = await h.run('video_generate', { prompt: 'Repeat me.', budget_id: 'b-dup', wait: false, allow_duplicate: true })
      assert.equal(again.task_id, 'T103')
      assert.equal(calls.calls.length, 2)
    } finally {
      calls.restore()
    }

    const failing = harness()
    await failing.run('video_budget', { action: 'create', budget_id: 'b-fail', limit: 20, currency: 'CNY' })
    const failCalls = mockFetch((call) => {
      if (call.url.endsWith('/v2/video_generation')) return jsonResponse({ task_id: 'T104' })
      if (call.url.includes('/v2/query/video_generation/T104')) {
        return jsonResponse({ task: { id: 'T104', status: 'failed', error: { code: 'x', message: 'rejected' } } })
      }
      return undefined
    })
    try {
      const failed = await failing.run('video_generate', { prompt: 'Fails.', budget_id: 'b-fail', wait: true })
      assert.equal(failed.status, 'failed')
      const budget = budgetOf(failing.stateDir, 'b-fail')
      assert.equal(budget.reservations[0].status, 'held')
      const record = recordsOf(failing.stateDir).find((entry) => entry.task_id === 'T104')
      assert.match(record.budget_note, /does not prove a zero charge/)
      assert.equal(failCalls.calls.length, 2)
    } finally {
      failCalls.restore()
    }
  }

  // 7. interrupted polling still delivers the persisted task id; video_task recovers
  {
    const h = harness()
    let phase = 'fail-poll'
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v2/video_generation')) return jsonResponse({ task_id: 'T105' })
      if (call.url.includes('/v2/query/video_generation/T105')) {
        if (phase === 'fail-poll') throw new Error('poll connection reset')
        return jsonResponse({ task: { id: 'T105', status: 'succeeded', content: { url: 'https://cdn.example.com/T105.mp4' } } })
      }
      if (call.url.startsWith('https://cdn.example.com/')) return mp4Response()
      return undefined
    })
    try {
      const interrupted = await h.run('video_generate', { prompt: 'Interrupted.', wait: true })
      assert.equal(interrupted.status, 'unknown')
      assert.equal(interrupted.task_id, 'T105')
      const record = recordsOf(h.stateDir).find((entry) => entry.task_id === 'T105')
      assert.ok(record !== undefined)
      assert.equal(record.status, 'unknown')
      assert.match(interrupted.note, /Retry video_task/)
      phase = 'ok'
      const recovered = await h.run('video_task', { task_id: 'T105' })
      assert.equal(recovered.status, 'succeeded')
      assert.ok(recovered.file.endsWith('.mp4'))
      assert.equal(recovered.record_id, record.record_id)
      assert.equal(recordsOf(h.stateDir).find((entry) => entry.task_id === 'T105').status, 'succeeded')
      phase = 'fail-poll'
      const terminalFallback = await h.run('video_task', { task_id: 'T105' })
      assert.equal(terminalFallback.status, 'succeeded')
      assert.equal(terminalFallback.file, recovered.file)
      assert.match(terminalFallback.note, /last journaled terminal state/)
    } finally {
      calls.restore()
    }
  }

  // 8. video_task query failure with a local record does not lose the id
  {
    const h = harness()
    let phase = 'ok'
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v2/video_generation')) return jsonResponse({ task_id: 'T106' })
      if (call.url.includes('/v2/query/video_generation/T106')) {
        if (phase === 'fail') throw new Error('query offline')
        return jsonResponse({ task: { id: 'T106', status: 'queued' } })
      }
      return undefined
    })
    try {
      const submitted = await h.run('video_generate', { prompt: 'Later query.', wait: false })
      phase = 'fail'
      const recovered = await h.run('video_task', { task_id: submitted.task_id })
      assert.equal(recovered.status, 'unknown')
      assert.equal(recovered.task_id, 'T106')
      assert.match(recovered.note, /saved in the local ledger/)
      assert.equal(recovered.record_id, submitted.record_id)
      assert.equal(calls.calls.length, 2)
    } finally {
      calls.restore()
    }
  }

  // 8b. journal commit failure returns the task id immediately without polling
  {
    const h = harness()
    let queryCount = 0
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v2/video_generation')) {
        // Make the journal directory unwritable for the post-network commit.
        rmSync(join(h.stateDir, 'journal'), { recursive: true, force: true })
        writeFileSync(join(h.stateDir, 'journal'), 'not a directory')
        return jsonResponse({ task_id: 'T109' })
      }
      if (call.url.includes('/v2/query/')) {
        queryCount += 1
        return jsonResponse({ task: { id: 'T109', status: 'succeeded' } })
      }
      return undefined
    })
    try {
      const result = await h.run('video_generate', { prompt: 'Journal failure.', wait: true })
      assert.equal(result.task_id, 'T109')
      assert.equal(result.status, 'submitted')
      assert.match(result.note, /CRITICAL/)
      assert.match(result.note, /do not resubmit/i)
      assert.equal(queryCount, 0, 'must not enter the default wait when the id was not persisted')
      assert.ok(result.diagnostics.some((entry) => entry.includes('journal_commit_failed')))
    } finally {
      calls.restore()
    }
  }

  // 8b2. journal success + budget attach failure still polls and distinguishes the warning
  {
    const h = harness()
    await h.run('video_budget', { action: 'create', budget_id: 'b-attach', limit: 10, currency: 'CNY' })
    let queryCount = 0
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v2/video_generation')) {
        const budgetDir = join(h.stateDir, 'budgets')
        const budgetFile = readdirSync(budgetDir).find((entry) => entry.endsWith('.json'))
        writeFileSync(join(budgetDir, budgetFile), '{broken ledger')
        return jsonResponse({ task_id: 'T110' })
      }
      if (call.url.includes('/v2/query/video_generation/T110')) {
        queryCount += 1
        return jsonResponse({
          task: { id: 'T110', status: 'succeeded', content: { url: 'https://cdn.example.com/T110.mp4' } },
        })
      }
      if (call.url.startsWith('https://cdn.example.com/')) return mp4Response()
      return undefined
    })
    try {
      const result = await h.run('video_generate', { prompt: 'Attach failure.', budget_id: 'b-attach', wait: true })
      assert.equal(result.task_id, 'T110')
      assert.equal(result.status, 'succeeded')
      assert.equal(queryCount, 1, 'journal success should still enter the wait even if budget attach fails')
      assert.ok(result.diagnostics.some((entry) => entry.includes('budget_attach_failed')))
      assert.match(result.note ?? '', /budget reservation is not linked/)
    } finally {
      calls.restore()
    }
  }

  // 8c. a missing production validator fails closed even without a local registry
  {
    const missingDir = tempDir('h3-missing-production-')
    const h = harness({ config: { productionModule: join(missingDir, 'does-not-exist.js') } })
    const calls = mockFetch(() => {
      throw new Error('missing production validator must fail before network')
    })
    try {
      await assert.rejects(
        () => h.run('video_prepare', { prompt: 'No validator.' }),
        /production validator .* missing/,
      )
      assert.equal(calls.calls.length, 0)
    } finally {
      calls.restore()
    }
  }

  // 9. declared contracts block before the network call
  {
    const h = harness()
    const calls = mockFetch(() => {
      throw new Error('contract failures must not reach the network')
    })
    try {
      await assert.rejects(
        () => h.run('video_generate', {
          prompt: '小雅微笑。',
          dialogue: [{ speaker: '小雅', line: '我们到了。' }],
        }),
        /dialogue_missing/,
      )
      await assert.rejects(
        () => h.run('video_generate', {
          prompt: 'A <Picture 2> shot.',
          reference_images: ['https://cdn.example.com/a.png'],
        }),
        /reference_tag_out_of_range/,
      )
      await assert.rejects(
        () => h.run('video_generate', {
          prompt: 'A <Picture 1> shot.',
          reference_images: ['https://cdn.example.com/a.png'],
          source_declarations: ['own-shoot'],
          approved_sources: ['approved-only'],
        }),
        /source_not_approved/,
      )
      const configured = harness({ config: { approvedSources: ['studio'] } })
      const configuredCalls = mockFetch(() => {
        throw new Error('contract failures must not reach the network')
      })
      try {
        await assert.rejects(
          () => configured.run('video_generate', {
            prompt: 'A <Picture 1> shot.',
            reference_images: ['https://cdn.example.com/a.png'],
            source_declarations: ['stock'],
            approved_sources: ['stock'],
          }),
          /approved_sources_scope/,
        )
        const configuredPrepared = await configured.run('video_prepare', {
          prompt: 'A <Picture 1> shot.',
          reference_images: ['https://cdn.example.com/a.png'],
          source_declarations: ['studio'],
          approved_sources: ['studio'],
        })
        assert.equal(configuredPrepared.status, 'prepared')
        assert.equal(configuredCalls.calls.length, 0)
      } finally {
        configuredCalls.restore()
      }
      assert.equal(calls.calls.length, 0)
    } finally {
      calls.restore()
    }
  }

  // 10. regeneration: drift checks, measured source duration and budget settle
  {
    const h = harness()
    writeFileSync(join(h.cwd, 'frame.png'), PNG)
    await h.run('video_budget', { action: 'create', budget_id: 'b-regen', limit: 30, currency: 'CNY' })
    const calls = mockFetch(successRoute('T107'))
    try {
      const generated = await h.run('video_generate', {
        prompt: 'Same prompt.',
        first_frame: 'frame.png',
        budget_id: 'b-regen',
        wait: true,
      })
      await assert.rejects(
        () => h.run('video_regenerate', {
          video: generated.file,
          prompt: 'Different prompt.',
          first_frame: 'frame.png',
          original_task_id: generated.task_id,
          budget_id: 'b-regen',
          wait: false,
        }),
        /regeneration_prompt_drift/,
      )
      const regenerated = await h.run('video_regenerate', {
        video: generated.file,
        prompt: 'Same prompt.',
        first_frame: 'frame.png',
        original_task_id: generated.task_id,
        budget_id: 'b-regen',
        wait: true,
      })
      assert.equal(regenerated.status, 'succeeded')
      assert.equal(regenerated.cost_status, 'partial')
      assert.match(regenerated.estimate, /¥1\.50 CNY known; worst case ¥3\.00 CNY/)
      assert.match(regenerated.estimate, /base-video second charge/)
      const reservations = budgetOf(h.stateDir, 'b-regen').reservations
      assert.equal(reservations.length, 2)
      assert.ok(reservations.every((entry) => entry.status === 'settled'))
    } finally {
      calls.restore()
    }
  }

  // 10a. regeneration re-bills original reference-video seconds from the record
  {
    const h = harness()
    writeFileSync(join(h.cwd, 'ref-2s.mp4'), MP4)
    await h.run('video_budget', { action: 'create', budget_id: 'b-refs', limit: 50, currency: 'CNY' })
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v2/video_generation')) return jsonResponse({ task_id: 'T111' })
      if (call.url.endsWith('/v2/video_regeneration')) return jsonResponse({ task_id: 'T112' })
      if (call.url.includes('/v2/query/video_generation/T111')) {
        return jsonResponse({
          task: { id: 'T111', status: 'succeeded', content: { url: 'https://cdn.example.com/T111.mp4' }, usage: { output_seconds: 5 } },
        })
      }
      if (call.url.includes('/v2/query/video_generation/T112')) {
        return jsonResponse({ task: { id: 'T112', status: 'queued' } })
      }
      if (call.url.startsWith('https://cdn.example.com/')) return mp4Response()
      return undefined
    })
    try {
      const generated = await h.run('video_generate', {
        prompt: 'Camera follows <Video 1> motion.',
        reference_videos: ['ref-2s.mp4'],
        budget_id: 'b-refs',
        wait: true,
      })
      const record = recordsOf(h.stateDir).find((entry) => entry.task_id === 'T111')
      assert.equal(record.assets.find((asset) => asset.slot === 'reference_video').duration_seconds, 5)
      const regenerated = await h.run('video_regenerate', {
        source_task_id: 'T111',
        original_task_id: '',
        budget_id: 'b-refs',
        wait: false,
      })
      assert.equal(regenerated.cost_status, 'partial')
      assert.match(regenerated.estimate, /¥3\.00 CNY known; worst case ¥4\.50 CNY/)
      assert.match(regenerated.estimate, /base-video second charge/)
    } finally {
      calls.restore()
    }
  }

  // 10a2. registered byTask QC source must be proven to be the task's download
  {
    const mp4Sha = sha256Hex(MP4)
    const matchingModule = mockProductionModule({ sha256: mp4Sha })
    const h = harness({ config: { productionModule: matchingModule } })
    const calls = mockFetch(successRoute('T120'))
    try {
      const generated = await h.run('video_generate', { prompt: 'Source for QC.', wait: true })
      const prepared = await h.run('video_prepare', {
        kind: 'regenerate',
        source_task_id: generated.task_id,
        source_asset_id: 'src',
      })
      assert.equal(prepared.status, 'prepared')
      assert.equal(prepared.cost_status, 'partial')
    } finally {
      calls.restore()
    }

    const noRecord = harness({ config: { productionModule: matchingModule } })
    await assert.rejects(
      () => noRecord.run('video_prepare', {
        kind: 'regenerate',
        source_task_id: 'remote-without-record',
        source_asset_id: 'src',
      }),
      /no local generation record|video mode/,
    )

    const mismatchModule = mockProductionModule({ sha256: sha256Hex(Buffer.from('different bytes')) })
    const mismatch = harness({ config: { productionModule: mismatchModule } })
    const mismatchCalls = mockFetch(successRoute('T121'))
    try {
      const generated = await mismatch.run('video_generate', { prompt: 'Mismatch source.', wait: true })
      await assert.rejects(
        () => mismatch.run('video_prepare', {
          kind: 'regenerate',
          source_task_id: generated.task_id,
          source_asset_id: 'src',
        }),
        /sha256 does not match|stand in for another task/,
      )
    } finally {
      mismatchCalls.restore()
    }

    const wrongTaskModule = mockProductionModule({ sha256: mp4Sha, taskId: 'OTHER-TASK' })
    const wrongTask = harness({ config: { productionModule: wrongTaskModule } })
    const wrongTaskCalls = mockFetch(successRoute('T122'))
    try {
      const generated = await wrongTask.run('video_generate', { prompt: 'Wrong task source.', wait: true })
      await assert.rejects(
        () => wrongTask.run('video_prepare', {
          kind: 'regenerate',
          source_task_id: generated.task_id,
          source_asset_id: 'src',
        }),
        /bound to task OTHER-TASK|source_asset_task_mismatch/,
      )
    } finally {
      wrongTaskCalls.restore()
    }
  }

  // 10b. declared source duration can never replace a measurement or lower a cap
  {
    const h = harness()
    writeFileSync(join(h.cwd, 'source-5s.mp4'), MP4)
    const calls = mockFetch(() => {
      throw new Error('duration checks must stay offline')
    })
    try {
      await assert.rejects(
        () => h.run('video_prepare', {
          kind: 'regenerate',
          video: 'source-5s.mp4',
          prompt: 'Same prompt.',
          source_duration_seconds: 1,
          max_cost: 0.6,
        }),
        /source_duration_mismatch/,
      )
      const measured = await h.run('video_prepare', {
        kind: 'regenerate',
        video: 'source-5s.mp4',
        prompt: 'Same prompt.',
        source_duration_seconds: 5,
      })
      assert.equal(measured.cost_status, 'partial')
      assert.equal(measured.source_actual_duration, 5)
      assert.equal(measured.source_duration_declared, 5)
      assert.match(measured.estimate, /¥1\.50 CNY known; worst case ¥3\.00 CNY/)

      const zeroDeclared = await h.run('video_prepare', {
        kind: 'regenerate',
        video: 'source-5s.mp4',
        source_task_id: '',
        prompt: 'Same prompt.',
        source_duration_seconds: 0,
      })
      assert.equal(zeroDeclared.cost_status, 'partial')
      assert.equal(zeroDeclared.source_actual_duration, 5)
      assert.equal(zeroDeclared.source_duration_declared, undefined)

      const declaredOnly = await h.run('video_prepare', {
        kind: 'regenerate',
        source_task_id: 'remote-task-1',
        source_duration_seconds: 1,
      })
      assert.equal(declaredOnly.cost_status, 'partial')
      assert.equal(declaredOnly.source_actual_duration, undefined)
      assert.equal(declaredOnly.source_duration_declared, 1)
      assert.equal(declaredOnly.original_inputs_unknown, true)
      assert.match(declaredOnly.estimate, /worst case ¥14\.10 CNY/)
      assert.match(declaredOnly.estimate, /original input materials not reviewable/)
      assert.ok(declaredOnly.diagnostics.some((entry) => entry.includes('source_duration_declared_only')))
      assert.ok(declaredOnly.diagnostics.some((entry) => entry.includes('original_inputs_unverified')))

      await assert.rejects(
        () => h.run('video_prepare', {
          kind: 'regenerate',
          source_task_id: 'remote-task-1',
          source_duration_seconds: 1,
          max_cost: 0.6,
        }),
        /worst-case upper bound/,
      )
      await assert.rejects(
        () => h.run('video_prepare', {
          kind: 'regenerate',
          source_task_id: 'remote-task-1',
          max_cost: 9,
        }),
        /original input materials not reviewable|worst-case upper bound/,
      )
      assert.equal(calls.calls.length, 0)
    } finally {
      calls.restore()
    }
  }

  // 10c. host output boundary: measured fractional 768P source seconds reach the
  // paid 2K regeneration tools as output. The pre-fix prepare/task output schema
  // declared `duration: {type:'integer'}`, which the host rejects for 12.25 /
  // 10.125 / 328÷24 s; that rejection is asserted here through the same boundary.
  {
    const durations = [
      { label: '8', seconds: 8, timescale: 1000, expected: 8 },
      { label: '12.25', seconds: 12.25, timescale: 1000, expected: 12.25 },
      { label: '10.125', seconds: 10.125, timescale: 1000, expected: 10.125 },
      // 328 frames at 24 fps is exactly 328000/24000 s in the container.
      { label: '328/24', seconds: 328 / 24, timescale: 24000, expected: 328 / 24 },
    ]
    for (const entry of durations) {
      const h = harness()
      const file = join(h.cwd, `source-${entry.label.replace('/', '-')}.mp4`)
      writeFileSync(file, mp4Buffer(entry.seconds, entry.timescale))
      const calls = mockFetch(() => {
        throw new Error('fractional-duration prepare must stay offline')
      })
      try {
        const prepared = await h.run('video_prepare', {
          kind: 'regenerate',
          video: file,
          prompt: 'Same 2K prompt.',
        })
        assert.equal(prepared.status, 'prepared')
        assert.equal(prepared.duration, entry.expected)
        assert.equal(prepared.source_actual_duration, Number(entry.expected.toFixed(3)))
        assert.equal(prepared.mode, 'reference')
        assert.equal('ratio' in prepared, false, 'a regeneration plan has no declared output ratio')
        assert.equal('requested_duration' in prepared, false, 'no original record means no requested duration')
        assert.equal(calls.calls.length, 0)
        assert.equal(h.credentialCalls.count, 0)
        // The harness must reject the schema that shipped with the reported bug.
        const integerSchema = {
          ...prepare.output.schema,
          properties: { ...prepare.output.schema.properties, duration: { type: 'integer' } },
        }
        assert.throws(
          () => assertHostResult({ ...prepare, output: { ...prepare.output, schema: integerSchema } }, {}, { ...prepared, duration: 12.25 }),
          /must be an integer/,
        )
      } finally {
        calls.restore()
      }
    }
  }

  // 10d. dry_run on the paid tools returns the prepared shape and must still
  // satisfy the tool's own output.schema at the host boundary.
  {
    const h = harness()
    const file = join(h.cwd, 'dry-source.mp4')
    writeFileSync(file, mp4Buffer(12.25))
    const calls = mockFetch(() => {
      throw new Error('dry_run must stay offline')
    })
    try {
      const dryRegen = await h.run('video_regenerate', {
        video: file,
        prompt: 'Same 2K prompt.',
        plan_id: '',
        dry_run: true,
      })
      assert.equal(dryRegen.status, 'prepared')
      assert.equal(dryRegen.kind, 'regenerate')
      assert.equal(dryRegen.duration, 12.25)
      assert.match(dryRegen.plan_id, /^p-/)
      assert.ok(existsSync(join(h.stateDir, 'plans', `plan-${dryRegen.plan_id}.json`)))
      const dryGenerate = await h.run('video_generate', { prompt: 'A cup on a table.', duration: 8, dry_run: true, plan_id: '' })
      assert.equal(dryGenerate.status, 'prepared')
      assert.equal(dryGenerate.kind, 'generate')
      assert.equal(dryGenerate.requested_duration, 8)
      const dryEnhance = await h.run('video_prompt_enhance', { prompt: 'A cup on a table.', dry_run: true, plan_id: '  ' })
      assert.equal(dryEnhance.status, 'prepared')
      assert.equal(dryEnhance.kind, 'prompt_enhance')
      assert.match(dryEnhance.plan_id, /^p-/)
      await assert.rejects(
        () => h.run('video_generate', {
          prompt: 'A cup on a table.', duration: 8, dry_run: true, plan_id: dryGenerate.plan_id,
        }),
        /use either dry_run or plan_id/,
      )
      assert.equal(calls.calls.length, 0)
      assert.equal(h.credentialCalls.count, 0)
    } finally {
      calls.restore()
    }
  }

  // 10e. wait:false 2K regeneration: one submit, host-valid queued result with
  // fractional duration and no `ratio: undefined`, journaled task id, held
  // budget; the same task then continues through video_task (mocked) to success.
  {
    const h = harness()
    const file = join(h.cwd, 'source-12.25.mp4')
    writeFileSync(file, mp4Buffer(12.25))
    await h.run('video_budget', { action: 'create', budget_id: 'b-frac', limit: 20, currency: 'CNY' })
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v2/video_regeneration')) return jsonResponse({ task_id: 'T140' })
      if (call.url.includes('/v2/query/video_generation/T140')) {
        return jsonResponse({
          task: {
            id: 'T140',
            status: 'succeeded',
            content: { url: 'https://cdn.example.com/T140.mp4?token=SIGNED-TOKEN' },
            usage: { output_seconds: 12.25 },
          },
        })
      }
      if (call.url.startsWith('https://cdn.example.com/')) return mp4Response()
      return undefined
    })
    try {
      const submitted = await h.run('video_regenerate', {
        video: file,
        prompt: 'Same 2K prompt.',
        budget_id: 'b-frac',
        plan_id: '',
        wait: false,
      })
      assert.equal(submitted.task_id, 'T140')
      assert.equal(submitted.status, 'queued')
      assert.equal(submitted.duration, 12.25)
      assert.equal(submitted.resolution, '2K')
      assert.equal('ratio' in submitted, false, 'the reported wait:false bug leaked ratio: undefined after a real submit')
      assert.equal(calls.calls.length, 1, 'wait:false submits exactly once')
      const record = recordsOf(h.stateDir).find((entry) => entry.task_id === 'T140')
      assert.ok(record !== undefined, 'the accepted task id must be journaled before returning')
      assert.equal(record.status, 'submitted')
      assert.equal(budgetOf(h.stateDir, 'b-frac').reservations[0].status, 'held')

      const queried = await h.run('video_task', { task_id: submitted.task_id, download: false })
      assert.equal(queried.task_id, 'T140')
      assert.equal(queried.status, 'succeeded')
      assert.equal(queried.record_id, record.record_id)
      assert.equal('file' in queried, false, 'download:false must not claim a saved file')
      assert.equal(calls.calls.length, 2)
      assert.equal(budgetOf(h.stateDir, 'b-frac').reservations[0].status, 'settled')
      assert.equal(recordsOf(h.stateDir).find((entry) => entry.task_id === 'T140').status, 'succeeded')

      // The duplicate gate still refuses an identical resubmission of the same
      // fractional-source request after the first task exists.
      await assert.rejects(
        () => h.run('video_regenerate', { video: file, prompt: 'Same 2K prompt.', budget_id: 'b-frac', wait: false }),
        /allow_duplicate/,
      )
      assert.equal(calls.calls.length, 2)
    } finally {
      calls.restore()
    }
  }

  // 10f. wait:true 2K regeneration success with download:false also stays
  // host-valid; the old wait:true return re-added the same undefined plan fields.
  {
    const h = harness()
    const file = join(h.cwd, 'source-8s.mp4')
    writeFileSync(file, mp4Buffer(8))
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v2/video_regeneration')) return jsonResponse({ task_id: 'T141' })
      if (call.url.includes('/v2/query/video_generation/T141')) {
        return jsonResponse({
          task: { id: 'T141', status: 'succeeded', content: { url: 'https://cdn.example.com/T141.mp4' } },
        })
      }
      return undefined
    })
    try {
      const result = await h.run('video_regenerate', {
        video: file,
        prompt: 'Same 2K prompt.',
        wait: true,
        download: false,
      })
      assert.equal(result.status, 'succeeded')
      assert.equal(result.task_id, 'T141')
      assert.equal(result.duration, 8)
      assert.equal(result.url, 'https://cdn.example.com/T141.mp4')
      assert.equal('file' in result, false, 'download:false must not report a downloaded file')
      assert.equal('ratio' in result, false)
      assert.equal(calls.calls.length, 2)
    } finally {
      calls.restore()
    }
  }

  // 10g. an unknown source_task_id has no measurable original duration: the
  // prepared output must omit duration/ratio instead of returning undefined.
  {
    const h = harness()
    const calls = mockFetch(() => {
      throw new Error('unknown byTask prepare must stay offline')
    })
    try {
      const prepared = await h.run('video_prepare', {
        kind: 'regenerate',
        source_task_id: 'remote-only-task',
      })
      assert.equal(prepared.status, 'prepared')
      assert.equal(prepared.original_inputs_unknown, true)
      assert.equal('duration' in prepared, false)
      assert.equal('ratio' in prepared, false)
      assert.equal('source_actual_duration' in prepared, false)
      assert.equal(calls.calls.length, 0)
      assert.equal(h.credentialCalls.count, 0)
    } finally {
      calls.restore()
    }
  }

  // 10h. requested generation seconds stay whole: fractional durations are
  // refused before credentials or any network call.
  {
    const h = harness()
    const calls = mockFetch(() => {
      throw new Error('a fractional generation duration must stay offline')
    })
    try {
      for (const duration of [12.25, 10.125, 328 / 24, 4.5]) {
        await assert.rejects(
          () => h.run('video_prepare', { prompt: 'A cup on a table.', duration }),
          /integer/,
        )
        await assert.rejects(
          () => h.run('video_generate', { prompt: 'A cup on a table.', duration, wait: false }),
          /integer/,
        )
      }
      assert.equal(calls.calls.length, 0)
      assert.equal(h.credentialCalls.count, 0)
    } finally {
      calls.restore()
    }
  }

  // 11. project registry: approval, shot selection, budget binding, strict provenance
  {
    const projectRoot = tempDir('h3-project-')
    mkdirSync(join(projectRoot, '.ai-video'))
    mkdirSync(join(projectRoot, 'assets'))
    writeFileSync(join(projectRoot, 'assets', 'char1.png'), PNG)
    writeFileSync(join(projectRoot, '.ai-video', 'project.json'), JSON.stringify({
      schema: 'dsh.ai-video-project/1',
      project_id: 'p-test',
      project_root: '..',
      budget: { id: 'project-budget', limit: 5, currency: 'CNY' },
      policy: {},
      assets: [{
        id: 'char1',
        kind: 'character',
        path: 'assets/char1.png',
        sha256: sha256Hex(PNG),
        origin: 'user_supplied',
        approval: 'approved',
        approval_evidence: 'evidence/char1.md',
        root_ids: [],
      }],
      shots: [{ id: 's1', characters: ['char1'], scenes: [], keyframes: [], dialogue: [] }],
    }))
    const h = harness({ cwd: projectRoot, stateDir: join(projectRoot, '.state') })
    const calls = mockFetch(() => {
      throw new Error('project prepare must stay offline')
    })
    try {
      const prepared = await h.run('video_prepare', {
        prompt: '[Shot 1] 小雅在窗边转身。',
        first_frame: 'assets/char1.png',
        shot_id: 's1',
        source_declarations: ['own-shoot'],
      })
      assert.equal(prepared.status, 'prepared')
      assert.match(prepared.project, /shot s1/)
      assert.match(prepared.budget, /project-budget/)
      assert.equal(prepared.cost_status, 'complete')
      assert.ok(budgetOf(h.stateDir, 'project-budget') !== undefined)
      await assert.rejects(
        () => h.run('video_prepare', {
          prompt: 'no shot selected',
          first_frame: 'assets/char1.png',
          source_declarations: ['own-shoot'],
        }),
        /SHOT_ID_REQUIRED/,
      )
      await assert.rejects(
        () => h.run('video_prepare', {
          prompt: 'remote input',
          first_frame: 'https://cdn.example.com/a.png',
          shot_id: 's1',
          source_declarations: ['own-shoot'],
        }),
        /UNVERIFIED_INPUT/,
      )
      await assert.rejects(
        () => h.run('video_prepare', {
          prompt: 'budget switch',
          first_frame: 'assets/char1.png',
          shot_id: 's1',
          source_declarations: ['own-shoot'],
          budget_id: 'other-budget',
        }),
        /declares budget "project-budget"/,
      )
      await assert.rejects(
        () => h.run('video_prepare', {
          prompt: 'no provenance',
          first_frame: 'assets/char1.png',
          shot_id: 's1',
        }),
        /source_declarations_required/,
      )
      await assert.rejects(
        () => h.run('video_prepare', {
          prompt: 'too expensive for the project budget',
          first_frame: 'assets/char1.png',
          shot_id: 's1',
          source_declarations: ['own-shoot'],
          resolution: '2K',
          duration: 8,
        }),
        /has .* left|budget/,
      )
      assert.equal(calls.calls.length, 0)
    } finally {
      calls.restore()
    }
  }

  // 11b. dense native asset_ids and sparse valid ids share the same plan;
  // prepare dense -> submit sparse and the reverse both work on fresh plans.
  {
    const root = makeRegisteredProjectFixture()
    const base = {
      prompt: '[Shot 1] 小雅在窗边转身。',
      first_frame: 'assets/char1.png',
      shot_id: 's1',
      source_declarations: ['own-shoot'],
    }
    const dense = {
      ...base,
      asset_ids: {
        first_frame: 'char1',
        last_frame: '',
        base_video: '',
        reference_images: [],
        reference_videos: [],
        reference_audio: [],
      },
    }
    const sparse = { ...base, asset_ids: { first_frame: 'char1' } }
    const flow = async (prepareDense, taskId, stateName) => {
      const h = harness({ cwd: root, stateDir: join(root, `.state-${stateName}`) })
      const prepared = await h.run('video_prepare', prepareDense ? dense : sparse)
      assert.equal(prepared.status, 'prepared')
      const calls = mockFetch(successRoute(taskId))
      try {
        const executed = await h.run('video_generate', {
          ...(prepareDense ? sparse : dense),
          plan_id: prepared.plan_id,
          wait: false,
        })
        assert.equal(executed.task_id, taskId)
        const post = calls.calls.find((call) => call.method === 'POST')
        const apiBody = JSON.parse(post.init.body)
        assert.equal('asset_ids' in apiBody, false, 'asset_ids is registry-only and stays out of the API body')
        assert.equal('source_asset_id' in apiBody, false)
      } finally {
        calls.restore()
      }
    }
    await flow(true, 'T130', 'dense-first')
    await flow(false, 'T131', 'sparse-first')

    const blank = harness({ cwd: root, stateDir: join(root, '.state-blank') })
    const blankPrepared = await blank.run('video_prepare', {
      ...base,
      budget_id: '',
      project_manifest: '',
      asset_ids: dense.asset_ids,
    })
    assert.equal(blankPrepared.status, 'prepared')
    assert.match(blankPrepared.budget, /project-budget/)

    const failing = harness({ cwd: root, stateDir: join(root, '.state-invalid-id') })
    const failedCalls = mockFetch(() => {
      throw new Error('a real id without media must fail before network')
    })
    try {
      await assert.rejects(
        () => failing.run('video_prepare', { ...base, asset_ids: { last_frame: 'char1' } }),
        /ASSET_ID_WITHOUT_MEDIA/,
      )
      assert.equal(failedCalls.calls.length, 0)
      assert.equal(failing.credentialCalls.count, 0)
    } finally {
      failedCalls.restore()
    }
  }

  // 12. queued cancel releases its budget reservation
  {
    const h = harness()
    await h.run('video_budget', { action: 'create', budget_id: 'b-cancel', limit: 10, currency: 'CNY' })
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/v2/video_generation')) return jsonResponse({ task_id: 'T108' })
      if (call.method === 'DELETE' && call.url.endsWith('/v2/video_generation/T108')) {
        return jsonResponse({ task_id: 'T108', status: 'cancelled', action: 'cancelled' })
      }
      return undefined
    })
    try {
      const submitted = await h.run('video_generate', { prompt: 'Cancel me.', budget_id: 'b-cancel', wait: false })
      assert.equal(budgetOf(h.stateDir, 'b-cancel').reservations[0].status, 'held')
      const cancelled = await h.run('video_task', { task_id: submitted.task_id, action: 'cancel' })
      assert.equal(cancelled.action, 'cancelled')
      assert.equal(budgetOf(h.stateDir, 'b-cancel').reservations[0].status, 'released')
    } finally {
      calls.restore()
    }
  }

  // --- skill provider ---------------------------------------------------
  assert.equal(providers.length, 1)
  const provider = providers[0]
  assert.equal(provider.name, 'dsh-minimax-video')
  const candidates = await provider.list()
  assert.ok(candidates.length >= 1)
  const primaryCandidate = candidates.find((entry) => entry.name === 'minimax-video')
  assert.ok(primaryCandidate !== undefined)
  assert.equal(primaryCandidate.invocation.modelInvocable, true)
  assert.equal(primaryCandidate.invocation.userInvocable, true)
  assert.equal(primaryCandidate.resourceBase.kind, 'directory')
  const skill = await provider.get(primaryCandidate)
  assert.equal(skill.name, 'minimax-video')
  assert.equal(skill.locator, primaryCandidate.locator)
  const productionCandidate = candidates.find((entry) => entry.name === 'ai-video-production')
  if (productionCandidate !== undefined) {
    assert.match(productionCandidate.description, /启动\/恢复任何 AI 视频或 AI 电影项目之前加载/)
    assert.match(productionCandidate.whenToUse, /启动\/恢复任何 AI 视频或 AI 电影项目之前加载/)
  }
  for (const candidate of candidates) {
    const loaded = await provider.get(candidate)
    assert.equal(loaded.name, candidate.name)
    assert.equal(loaded.locator, candidate.locator)
    assert.ok(loaded.content.length > 0)
  }
  assert.match(skill.content, /# MiniMax H3 video/)
  assert.match(skill.content, /integrated_multimodal_description/)
  assert.match(skill.content, /768P → 2K/)
  assert.match(skill.content, /heuristic/i)
  assert.match(skill.content, /references\/video-types\.md/)

  const readSkill = (file) => readFileSync(new URL(`../skill/${file}`, import.meta.url), 'utf8')
  assert.match(readSkill('references/prompt-guide.md'), /overall_soundscape/)
  assert.match(readSkill('references/camera.md'), /push in/)
  assert.match(readSkill('references/video-types.md'), /故事型/)
  assert.match(readSkill('references/video-types.md'), /演绎型/)
  assert.match(readSkill('references/video-types.md'), /叙述型/)
  assert.match(readSkill('references/examples.md'), /retention_analysis/)
  assert.match(readSkill('references/api-notes.md'), /MiniMax-H3-Regeneration|regeneration/i)
  assert.match(readSkill('references/api-notes.md'), /1008/)
  assert.match(readSkill('references/continuity-and-voice.md'), /first_frame.*reference_audio|reference_audio.*first_frame/is)
  assert.match(readSkill('references/continuity-and-voice.md'), /Decision table/)

  // production suites (owned by production/, run as part of this self-test).
  // Explicit file list from readdir, never a shell glob, and a red suite stays red.
  const productionTestDir = fileURLToPath(new URL('../production/test/', import.meta.url))
  const productionTests = existsSync(productionTestDir)
    ? readdirSync(productionTestDir)
        .filter((entry) => entry.endsWith('.test.mjs'))
        .sort()
        .map((entry) => join(productionTestDir, entry))
    : []
  if (productionTests.length > 0) {
    const result = spawnSync(process.execPath, ['--test', ...productionTests], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: 'inherit',
    })
    assert.equal(result.status, 0, 'production test suites failed (upstream failure stays a hard failure)')
  }

  console.log(
    'dsh-minimax-video: 7 tools, prepare/plan, preflight contracts, cost cap + budget ledger, durable journal, sanitized assets, regen drift, download naming and recovery verified offline (all network mocked)',
  )
} finally {
  cleanup()
}
