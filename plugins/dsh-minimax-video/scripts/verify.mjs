// Offline self-check: tool registration, the tier/resolution matrix, request
// shapes, cost estimates, media inlining and the skill provider. No network
// request and no paid generation.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../index.js'
import {
  LIMITS,
  MODEL_IDS,
  MODELS,
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

assert.equal(name, 'minimax-video')
assert.deepEqual(inject, ['tools', 'workingDirectory', 'credentials', 'skills'])
assert.equal(typeof apply, 'function')

// --- registration -------------------------------------------------------
const definitions = []
const providers = []
const ctx = {
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
apply(ctx, {})

assert.deepEqual(definitions.map((definition) => definition.name), [
  'video_models',
  'video_generate',
  'video_task',
  'video_regenerate',
  'video_prompt_enhance',
])
const byName = new Map(definitions.map((definition) => [definition.name, definition]))
const generate = byName.get('video_generate')
const task = byName.get('video_task')
const regenerate = byName.get('video_regenerate')
const enhance = byName.get('video_prompt_enhance')
const models = byName.get('video_models')

// --- model-facing parameter schemas -------------------------------------
assert.deepEqual(generate.parameters.required, ['prompt'])
assert.deepEqual(generate.parameters.properties.model.enum, [...MODEL_IDS])
assert.deepEqual(generate.parameters.properties.resolution.enum, ['480P', '768P', '2K'])
assert.deepEqual(generate.parameters.properties.ratio.enum, [...RATIOS])
assert.deepEqual(generate.parameters.properties.prompt_expansion.enum, ['disabled', 'balanced', 'quality'])
assert.match(generate.parameters.properties.first_frame.description, /first.frame/i)
assert.ok(generate.parameters.properties.reference_videos.description.includes('15 s total'))
assert.deepEqual(task.parameters.required, ['task_id'])
assert.deepEqual(task.parameters.properties.action.enum, ['status', 'cancel'])
assert.equal(regenerate.parameters.required, undefined)
assert.ok(regenerate.parameters.properties.source_task_id.description.includes('Whitelist'))
assert.deepEqual(enhance.parameters.required, ['prompt'])
assert.equal(models.parameters.required, undefined)

for (const definition of definitions) {
  assert.equal(definition.output.schema.type, 'object')
  assert.ok(Array.isArray(definition.output.schema.required))
  assert.ok(definition.output.schema.properties !== undefined)
}

const sampleValue = {
  task_id: '123',
  status: 'succeeded',
  model: 'MiniMax-H3',
  resolution: '768P',
  duration: 5,
  ratio: '16:9',
  mode: 'text',
  usage: '5s output',
}
for (const name of ['video_generate', 'video_task', 'video_regenerate', 'video_prompt_enhance']) {
  const rendered = byName.get(name).output.render({}, sampleValue)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /^123: succeeded/)
}
const enhanced = byName.get('video_prompt_enhance').output.render({}, { ...sampleValue, prompt: 'integrated_multimodal_description: [Shot 1] A cup.' })
assert.match(enhanced[0].text, /integrated_multimodal_description: \[Shot 1\] A cup\./)
assert.match(byName.get('video_generate').output.render({}, { ...sampleValue, estimated_cost: '¥4.00 CNY list' })[0].text, /estimated ¥4\.00/)

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

assert.equal(inferMode({}), 'text')
assert.equal(inferMode({ firstFrame: 'a.png' }), 'image')
assert.equal(inferMode({ firstFrame: 'a.png', lastFrame: 'b.png' }), 'image')
assert.equal(inferMode({ referenceImages: ['a.png'] }), 'reference')
assert.throws(() => inferMode({ lastFrame: 'b.png' }), /requires first_frame/)
assert.throws(() => inferMode({ firstFrame: 'a.png', referenceImages: ['b.png'] }), /cannot be mixed/)
assert.throws(
  () => inferMode({ firstFrame: 'a.png', referenceAudio: ['voice.wav'] }),
  /voice-timbre continuity/,
)

assert.equal(normalizeRatio({ mode: 'text', model: 'MiniMax-H3' }), '16:9')
assert.throws(() => normalizeRatio({ mode: 'text', model: 'MiniMax-H3', ratio: 'adaptive' }), /needs a concrete ratio/)
assert.equal(normalizeRatio({ mode: 'image', model: 'MiniMax-H3', ratio: '9:16' }), 'adaptive')
assert.equal(normalizeRatio({ mode: 'reference', model: 'MiniMax-H3' }), 'adaptive')
assert.throws(
  () => normalizeRatio({ mode: 'reference', model: 'MiniMax-H3-Lite', ratio: 'adaptive' }),
  /does not support adaptive/,
)
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
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
near(estimateGenerationCost({ model: 'MiniMax-H3', resolution: '2K', duration: 5 }).amount, 4)
near(estimateGenerationCost({ model: 'MiniMax-H3', resolution: '768P', duration: 5, imageCount: 7 }).amount, 2.9)
near(estimateGenerationCost({ model: 'MiniMax-H3-Max', resolution: '480P', duration: 5, imageCount: 3 }).amount, 2.15)
near(estimateGenerationCost({ model: 'MiniMax-H3', resolution: '2K', duration: 5, region: 'global' }).amount, 0.65)
assert.equal(REGENERATION.prices.cn['2K'].output, 0.3)

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

// --- content order and roles -------------------------------------------
const content = buildContent({
  prompt: 'P',
  referenceImages: ['i1'],
  referenceVideos: ['v1'],
  referenceAudio: ['a1'],
})
assert.deepEqual(content.map((item) => [item.type, item.role]), [
  ['text', undefined],
  ['image_url', 'reference_image'],
  ['video_url', 'reference_video'],
  ['audio_url', 'reference_audio'],
])

// --- media --------------------------------------------------------------
assert.equal(resolveMedia(process.cwd(), 'https://example.com/a.png', 'image'), 'https://example.com/a.png')
assert.equal(resolveMedia(process.cwd(), 'mm_file://abc', 'video'), 'mm_file://abc')
assert.equal(resolveMedia(process.cwd(), 'data:image/png;base64,AA', 'image'), 'data:image/png;base64,AA')
assert.throws(() => resolveMedia(process.cwd(), '/definitely/missing.png', 'image'), /cannot read image/)

const dir = mkdtempSync(join(tmpdir(), 'h3-verify-'))
try {
  const png = join(dir, 'tiny.png')
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  assert.match(resolveMedia(dir, 'tiny.png', 'image'), /^data:image\/png;base64,/)
  const txt = join(dir, 'note.txt')
  writeFileSync(txt, 'x')
  assert.throws(() => resolveMedia(dir, 'note.txt', 'image'), /unsupported image extension/)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

assert.equal(imageCountOf({ referenceImages: ['a', 'b'] }), 2)
assert.equal(imageCountOf({ firstFrame: 'a', lastFrame: 'b', referenceImages: [] }), 2)
assert.ok(assertRequestSize({ content: [{ type: 'text', text: 'hello' }] }) > 0)
assert.throws(
  () => assertRequestSize({ content: [{ type: 'text', text: 'x'.repeat(LIMITS.requestBytes + 1) }] }),
  /64 MB/,
)

// --- skill provider -----------------------------------------------------
assert.equal(providers.length, 1)
const provider = providers[0]
assert.equal(provider.name, 'dsh-minimax-video')
const candidates = await provider.list()
assert.equal(candidates.length, 1)
assert.equal(candidates[0].name, 'minimax-video')
assert.equal(candidates[0].invocation.modelInvocable, true)
assert.equal(candidates[0].invocation.userInvocable, true)
assert.equal(candidates[0].resourceBase.kind, 'directory')
const skill = await provider.get(candidates[0])
assert.equal(skill.name, 'minimax-video')
assert.match(skill.content, /# MiniMax H3 video/)
assert.match(skill.content, /integrated_multimodal_description/)
assert.match(skill.content, /768P → 2K/)
assert.match(skill.content, /3\.3 words per second/)
assert.match(skill.content, /references\/video-types\.md/)

// --- skill documents exist and carry the promised sections -------------
const read = (file) => readFileSync(new URL(`../skill/${file}`, import.meta.url), 'utf8')
assert.match(read('references/prompt-guide.md'), /overall_soundscape/)
assert.match(read('references/camera.md'), /push in/)
assert.match(read('references/video-types.md'), /故事型/)
assert.match(read('references/video-types.md'), /演绎型/)
assert.match(read('references/video-types.md'), /叙述型/)
assert.match(read('references/examples.md'), /retention_analysis/)
assert.match(read('references/api-notes.md'), /MiniMax-H3-Regeneration|regeneration/i)
assert.match(read('references/api-notes.md'), /1008/)
assert.match(read('references/continuity-and-voice.md'), /first_frame.*reference_audio|reference_audio.*first_frame/is)
assert.match(read('references/continuity-and-voice.md'), /Decision table/)

console.log('dsh-minimax-video: 5 tools, catalog matrix, request shapes, costs, media and skill verified offline')
