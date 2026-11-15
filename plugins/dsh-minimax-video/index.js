/**
 * MiniMax H3 video tools for DeepSeek Harness.
 *
 * Five tools over one family of models:
 *   - video_models          catalog: tiers, resolution matrix, price, limits
 *   - video_generate        text / first-last-frame / reference -> 4-15 s clip
 *   - video_task            query, wait, download, cancel or delete
 *   - video_regenerate      official 768P -> 2K regeneration
 *   - video_prompt_enhance  official H3-Context-IR prompt structuring
 *
 * Plus the `minimax-video` skill: prompt shape, camera language, content
 * archetypes, API quirks and the 2K workflow.
 *
 * Local media is inlined as a data URI up to the per-asset limit; URLs and
 * `mm_file://` handles pass through. Video bytes never enter the conversation.
 */
import { readFile } from 'node:fs/promises'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  MODEL_IDS,
  PROMPT_EXPANSION_MODES,
  RATIOS,
  RESOLUTIONS,
  catalogText,
  estimateGenerationCost,
  formatMoney,
  planGeneration,
  regionOf,
  validatePrompt,
  validateReferenceCounts,
} from './lib/catalog.js'
import { imageCountOf, resolveMedia, assertRequestSize } from './lib/media.js'
import { buildContextIrBody, buildGenerationBody, buildRegenerationBody } from './lib/request.js'
import { ApiError, MiniMaxVideoClient, describeUsage, downloadVideo, pollTask } from './lib/api.js'

export const name = 'minimax-video'
export const inject = ['tools', 'workingDirectory', 'credentials', 'skills']

const DEFAULT_CONFIG = {
  baseURL: 'https://api.minimax.cn',
  keyRef: 'MINIMAX_API_KEY',
  keyFile: undefined,
  defaultModel: 'MiniMax-H3',
  maxWaitSeconds: 900,
  pollIntervalMs: 10_000,
}

const SKILL_DIR = fileURLToPath(new URL('./skill/', import.meta.url))
const SKILL_FILE = fileURLToPath(new URL('./skill/SKILL.md', import.meta.url))

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

const skillProvider = {
  name: 'dsh-minimax-video',
  list() {
    return Promise.resolve([skillCandidate])
  },
  async get() {
    return { ...skillCandidate, content: await readFile(SKILL_FILE, 'utf8') }
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

function resolveSources(cwd, args) {
  const referenceImages = (args.reference_images ?? []).map((input) => resolveMedia(cwd, input, 'image'))
  const referenceVideos = (args.reference_videos ?? []).map((input) => resolveMedia(cwd, input, 'video'))
  const referenceAudio = (args.reference_audio ?? []).map((input) => resolveMedia(cwd, input, 'audio'))
  return {
    firstFrame: args.first_frame === undefined ? undefined : resolveMedia(cwd, args.first_frame, 'image'),
    lastFrame: args.last_frame === undefined ? undefined : resolveMedia(cwd, args.last_frame, 'image'),
    referenceImages,
    referenceVideos,
    referenceAudio,
  }
}

function resolveWaitMs(args, cfg) {
  const requested = args.wait_seconds ?? cfg.maxWaitSeconds
  const seconds = Math.min(Math.max(Number(requested) || cfg.maxWaitSeconds, 10), cfg.maxWaitSeconds)
  return seconds * 1000
}

async function downloadResult(task, { outDir, stem, signal }) {
  const url = task?.content?.url
  if (typeof url !== 'string' || url.length === 0) return {}
  try {
    mkdirSync(outDir, { recursive: true })
    const result = await downloadVideo(url, { directory: outDir, stem, signal })
    return { file: result.file }
  } catch (error) {
    return { note: `task succeeded but the download failed (${error.message}); call video_task with download true to retry` }
  }
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

const modeDescription =
  'Mode is inferred: no media = text-to-video; first_frame/last_frame = image-to-video; reference_* = reference-to-video. Frames and references are mutually exclusive.'

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
      estimated_cost: { type: 'string' },
      action: { type: 'string' },
      note: { type: 'string' },
      error: { type: 'string' },
      ...extra,
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
  if (value.estimated_cost) bits.push(`estimated ${value.estimated_cost}`)
  if (value.error) bits.push(`error ${value.error}`)
  if (value.note) bits.push(value.note)
  const head = bits.join(' | ')
  return [{ type: 'text', text: value.prompt === undefined ? head : `${head}\n\n${value.prompt}` }]
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
  const region = regionOf(cfg.baseURL)

  ctx.skills.registerProvider(() => skillProvider)

  const makeClient = async (signal) => {
    const key = await resolveKey(ctx, cfg)
    return new MiniMaxVideoClient({ baseURL: cfg.baseURL, key, signal })
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
    name: 'video_generate',
    description:
      'Create a MiniMax H3 video from a prompt plus optional first/last frames or reference media. H3 renders picture and sound together: dialogue, ambience and score come from the prompt. Output is one 4-15 s clip at 480P/768P/2K depending on the tier. By default waits, downloads the MP4 into generated-videos/ and returns its path; on the wait cap it returns the live task_id for video_task. ' +
      modeDescription,
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
          'MiniMax-H3-Max only. disabled keeps your prompt as written; balanced (API default) expands it moderately; quality prioritizes expansion quality. Passing this on another tier is an error.',
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
    },
    output: {
      schema: taskOutputSchema(),
      render: renderTask,
    },
    async execute(args, exec) {
      const cwd = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      validatePrompt(args.prompt)
      validateReferenceCounts(args)
      const sources = resolveSources(cwd, args)
      const plan = planGeneration({
        model: args.model ?? cfg.defaultModel,
        resolution: args.resolution,
        duration: args.duration ?? 5,
        ratio: args.ratio,
        promptExpansion: args.prompt_expansion,
        ...sources,
      })
      const body = buildGenerationBody(plan, args.prompt, sources)
      assertRequestSize(body)
      const client = await makeClient(exec.signal)
      const created = await client.create(body)
      const taskId = String(created.task_id)
      const estimate = estimateGenerationCost({
        model: plan.model,
        resolution: plan.resolution,
        duration: plan.duration,
        imageCount: imageCountOf(sources),
        region,
      })
      const estimatedCost = `${formatMoney(estimate.amount, region)} ${region === 'global' ? 'USD' : 'CNY'} list (output${estimate.extraImages > 0 ? ' + extra images' : ''}${sources.referenceVideos.length > 0 ? '; reference-video seconds excluded' : ''})`

      if (args.wait === false) {
        return {
          task_id: taskId,
          status: 'queued',
          model: plan.model,
          resolution: plan.resolution,
          duration: plan.duration,
          ratio: plan.ratio,
          mode: plan.mode,
          estimated_cost: estimatedCost,
          note: `submitted; call video_task with task_id ${taskId}`,
        }
      }

      const { task, timedOut } = await pollTask(client, taskId, {
        timeoutMs: resolveWaitMs(args, cfg),
        intervalMs: cfg.pollIntervalMs,
        signal: exec.signal,
      })
      const outDir = args.out_dir === undefined ? join(cwd, 'generated-videos') : resolve(cwd, args.out_dir)
      const downloaded =
        task.status === 'succeeded' && args.download !== false
          ? await downloadResult(task, { outDir, stem: `${timestamp()}-${slugOf(args.prompt)}`, signal: exec.signal })
          : {}
      return {
        ...summaryOf(task, { task_id: taskId }),
        model: plan.model,
        resolution: plan.resolution,
        duration: plan.duration,
        ratio: plan.ratio,
        mode: plan.mode,
        estimated_cost: estimatedCost,
        ...downloaded,
        ...(timedOut
          ? { note: `still ${task.status} after the wait cap; call video_task with task_id ${taskId}` }
          : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_task',
    description:
      'Query, wait for, download, cancel or delete a MiniMax H3 video task (generation, regeneration or Context-IR). Status is cheap; set wait to block until the task finishes. Delete cancels a queued task, or removes a succeeded/failed record; a running task cannot be cancelled.',
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
      const cwd = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const client = await makeClient(exec.signal)
      if (args.action === 'cancel') {
        const result = await client.remove(args.task_id)
        return {
          task_id: String(result.task_id ?? args.task_id),
          status: String(result.status ?? result.action ?? 'deleted'),
          action: String(result.action ?? 'deleted'),
          note:
            result.action === 'cancelled'
              ? 'queued task cancelled; no charge for the cancelled generation'
              : 'task record deleted',
        }
      }
      const { task, timedOut } = args.wait
        ? await pollTask(client, args.task_id, {
            timeoutMs: resolveWaitMs(args, cfg),
            intervalMs: cfg.pollIntervalMs,
            signal: exec.signal,
          })
        : { task: await client.query(args.task_id), timedOut: false }
      const outDir = args.out_dir === undefined ? join(cwd, 'generated-videos') : resolve(cwd, args.out_dir)
      const downloaded =
        task.status === 'succeeded' && args.download !== false && typeof task.content?.url === 'string'
          ? await downloadResult(task, { outDir, stem: `${timestamp()}-${slugOf(task.task_type ?? 'video')}`, signal: exec.signal })
          : {}
      return {
        ...summaryOf(task),
        ...downloaded,
        ...(timedOut ? { note: `still ${task.status} after the wait cap; call video_task again` } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_regenerate',
    description:
      'Regenerate an existing MiniMax-H3 768P output as 2K. This is the official regeneration endpoint, not a generic upscaler: the source must be a 768P H3 result (24 fps, audio track, dimensions divisible by 32, 107-362 frames), and the original prompt plus all original media must be resubmitted. Two modes: source_task_id (whitelist only) or a source video plus the original inputs. ' +
      'Cost note: 768P generation + regeneration is usually more expensive than generating 2K directly; use it to iterate cheaply at 768P and finish at 2K.',
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
      wait: { type: 'boolean', description: 'Wait for completion and download the 2K MP4. Default true.' },
      wait_seconds: {
        type: 'integer',
        description: 'Maximum wait when wait is true. Default 900 s; capped by the plugin maxWaitSeconds.',
      },
      download: { type: 'boolean', description: 'Download the finished 2K MP4. Default true.' },
      out_dir: outProperty,
    },
    output: {
      schema: taskOutputSchema(),
      render: renderTask,
    },
    async execute(args, exec) {
      const cwd = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const byTask = args.source_task_id !== undefined
      const byVideo = args.video !== undefined
      if (byTask === byVideo) {
        throw new Error('provide exactly one of source_task_id or video')
      }
      let body
      if (byTask) {
        const hasContent =
          args.prompt !== undefined ||
          args.first_frame !== undefined ||
          args.last_frame !== undefined ||
          (args.reference_images?.length ?? 0) > 0 ||
          (args.reference_videos?.length ?? 0) > 0 ||
          (args.reference_audio?.length ?? 0) > 0
        if (hasContent) {
          throw new Error('source_task_id mode resubmits no content; omit prompt, frames and references')
        }
        body = buildRegenerationBody({ sourceTaskId: args.source_task_id })
      } else {
        validatePrompt(args.prompt)
        validateReferenceCounts(args)
        const sources = resolveSources(cwd, args)
        const baseVideo = resolveMedia(cwd, args.video, 'video')
        body = buildRegenerationBody({ baseVideo, prompt: args.prompt, sources })
      }
      assertRequestSize(body)
      const client = await makeClient(exec.signal)
      let created
      try {
        created = await client.regenerate(body)
      } catch (error) {
        if (byTask && error instanceof ApiError && /whitelist|permission|forbidden/i.test(error.message)) {
          throw new Error(
            `${error.message}. source_task_id regeneration needs whitelist access; use the video mode with the original prompt and media instead`,
          )
        }
        throw error
      }
      const taskId = String(created.task_id)
      if (args.wait === false) {
        return {
          task_id: taskId,
          status: 'queued',
          resolution: '2K',
          note: `submitted; call video_task with task_id ${taskId}`,
        }
      }
      const { task, timedOut } = await pollTask(client, taskId, {
        timeoutMs: resolveWaitMs(args, cfg),
        intervalMs: cfg.pollIntervalMs,
        signal: exec.signal,
      })
      const outDir = args.out_dir === undefined ? join(cwd, 'generated-videos') : resolve(cwd, args.out_dir)
      const downloaded =
        task.status === 'succeeded' && args.download !== false
          ? await downloadResult(task, { outDir, stem: `${timestamp()}-${slugOf(args.prompt ?? 'regenerated')}-2k`, signal: exec.signal })
          : {}
      return {
        ...summaryOf(task, { task_id: taskId }),
        resolution: '2K',
        ...downloaded,
        ...(timedOut ? { note: `still ${task.status} after the wait cap; call video_task with task_id ${taskId}` } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_prompt_enhance',
    description:
      'Run the official MiniMax H3-Context-IR prompt enhancer. It reads the same multimodal inputs as a generation (text plus optional frames or reference media) and returns a structured, semantically enriched prompt, but does not create a video. Use it when a prompt is vague, when references need to be assigned roles, or before a deliberate 768P-to-2K pipeline. Costs Context-IR tokens, not video seconds.',
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
      wait: { type: 'boolean', description: 'Wait for the enhanced prompt. Default true.' },
      wait_seconds: { type: 'integer', description: 'Maximum wait when wait is true. Default 900 s.' },
    },
    output: {
      schema: taskOutputSchema(),
      render: renderTask,
    },
    async execute(args, exec) {
      const cwd = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      validatePrompt(args.prompt)
      validateReferenceCounts(args)
      const sources = resolveSources(cwd, args)
      const plan = planGeneration({
        model: 'MiniMax-H3',
        resolution: '768P',
        duration: args.duration ?? 5,
        ratio: args.ratio,
        ...sources,
      })
      const body = buildContextIrBody(plan, args.prompt, sources)
      assertRequestSize(body)
      const client = await makeClient(exec.signal)
      const created = await client.contextIr(body)
      const taskId = String(created.task_id)
      if (args.wait === false) {
        return { task_id: taskId, status: 'queued', note: 'submitted; call video_task with this task_id' }
      }
      const { task, timedOut } = await pollTask(client, taskId, {
        timeoutMs: resolveWaitMs(args, cfg),
        intervalMs: cfg.pollIntervalMs,
        signal: exec.signal,
      })
      return {
        ...summaryOf(task, { task_id: taskId }),
        ...(timedOut ? { note: `still ${task.status} after the wait cap; call video_task with task_id ${taskId}` } : {}),
      }
    },
  }))
}
