/**
 * `gemini-creative` skill provider for DeepSeek Harness.
 *
 * One model-invocable skill that tells the agent when to hand a writing or
 * long-text analysis task to the `gemini` tool (the dsh-gemini
 * plugin) instead of writing it itself. The body is read when the skill is
 * loaded, so editing assets/gemini-creative.md takes effect without a restart
 * as long as the catalog entry itself does not change.
 *
 * Dependencies are Node built-ins only; `ctx.skills` comes from the host.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const PROVIDER_NAME = 'gemini-creative'
const SKILL_NAME = 'gemini-creative'
const BODY_URL = new URL('./assets/gemini-creative.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('./assets/', import.meta.url)),
}

// BUNDLED_SKILL_RANK in @deepseek-ai/dsh-skill is 600. Kept as a literal so
// this plugin needs no runtime import beyond Node built-ins; any value is a
// precedence hint, and no shipped skill uses this name.
const RANK = 600

const DESCRIPTION =
  'Use when the user asks to write or revise a script, screenplay, dialogue, narration, or copy, or to review scene images, storyboards, PDFs, and other materials against a script — including Chinese requests such as 写剧本、对白、旁白、文案、分镜、场景图、素材对照、长文分析。Routes the task to Gemini 4 Argon through the gemini tool.'

const CANDIDATE = {
  name: SKILL_NAME,
  description: DESCRIPTION,
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'custom',
  resourceBase: RESOURCE_BASE,
  rank: RANK,
  locator: BODY_URL,
}

const provider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get() {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(BODY_URL, 'utf8'),
    }
  },
}

/** Cordis plugin name. */
export const name = 'gemini-creative'
/** Service required by the provider. */
export const inject = ['skills']

/** Register the `gemini-creative` provider on `ctx.skills`. */
export function apply(ctx) {
  ctx.skills.registerProvider(() => provider)
}
