/**
 * Request-body builders for the MiniMax H3 video endpoints.
 *
 * Kept separate from the network layer so the exact JSON shape can be tested
 * offline: content order, roles, the image-to-video / reference-to-video
 * exclusivity, and the 768P->2K regeneration contract.
 */

/** Build the multimodal `content` array shared by generation and Context-IR. */
export function buildContent({
  prompt,
  firstFrame,
  lastFrame,
  referenceImages = [],
  referenceVideos = [],
  referenceAudio = [],
}) {
  const content = [{ type: 'text', text: prompt }]
  if (firstFrame !== undefined) {
    content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
  }
  if (lastFrame !== undefined) {
    content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' })
  }
  for (const url of referenceImages) {
    content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
  }
  for (const url of referenceVideos) {
    content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
  }
  for (const url of referenceAudio) {
    content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
  }
  return content
}

/** Body for POST /v2/video_generation. */
export function buildGenerationBody(plan, prompt, sources) {
  const body = {
    model: plan.model,
    content: buildContent({ prompt, ...sources }),
    resolution: plan.resolution,
    duration: plan.duration,
    ratio: plan.ratio,
  }
  if (plan.promptExpansion !== undefined) {
    body.extra = { prompt_expansion_mode: plan.promptExpansion }
  }
  return body
}

/** Body for POST /v2/h3_context_ir (prompt enhancement only). */
export function buildContextIrBody(plan, prompt, sources) {
  return {
    model: 'MiniMax-H3',
    content: buildContent({ prompt, ...sources }),
    duration: plan.duration,
    ratio: plan.ratio,
  }
}

/**
 * Body for POST /v2/video_regeneration.
 *
 * Exactly one source form is valid: an existing succeeded task id (whitelist
 * only) or a 768P source clip plus the original generation inputs.
 */
export function buildRegenerationBody({ sourceTaskId, baseVideo, prompt, sources }) {
  if ((sourceTaskId === undefined) === (baseVideo === undefined)) {
    throw new Error('provide exactly one of source_task_id or video')
  }
  if (sourceTaskId !== undefined) {
    return {
      model: 'MiniMax-H3',
      source_task_id: sourceTaskId,
      resolution: '2K',
    }
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('regeneration by source video needs the original prompt (and the original media) so the 2K pass matches the 768P source')
  }
  const content = buildContent({ prompt, ...sources })
  content.push({ type: 'video_url', video_url: { url: baseVideo }, role: 'base_video' })
  return {
    model: 'MiniMax-H3',
    content,
    resolution: '2K',
  }
}
