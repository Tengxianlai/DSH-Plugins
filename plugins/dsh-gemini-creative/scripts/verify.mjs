/**
 * dsh-gemini-creative 自测：不发网络请求。
 *
 * 覆盖：provider 注册、候选元数据、按需加载正文、中文触发词、正文指向
 * gemini、技术质检路由、资产登记提示、音视频预检参数与用量透明度。
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

let factory
const ctx = {
  skills: {
    registerProvider(create) {
      factory = create
    },
  },
}

apply(ctx)
assert.equal(typeof factory, 'function', 'registerProvider receives a factory')

const provider = factory()
assert.equal(provider.name, 'gemini-creative')

const candidates = await provider.list()
assert.equal(candidates.length, 1)
const [candidate] = candidates
assert.equal(candidate.name, 'gemini-creative')
assert.equal(candidate.provider, 'gemini-creative')
assert.equal(candidate.source, 'custom')
assert.equal(candidate.invocation.modelInvocable, true)
assert.equal(candidate.invocation.userInvocable, true)
assert.equal(typeof candidate.rank, 'number')
assert.ok(candidate.description.includes('写剧本'), 'description carries the Chinese trigger')
assert.ok(candidate.description.includes('scene images'), 'description carries the visual-review trigger')
assert.ok(candidate.description.includes('Not for technical QC'), 'description routes technical QC away from Gemini')
assert.ok(/(?:local(?:ly)? tools?|locally)/i.test(candidate.description) && /subagents?/i.test(candidate.description), 'description names the local route')
assert.ok(/ai-video-production|registered approved assets|project registry/.test(candidate.description), 'description points at the production registry')

const definition = await provider.get(candidate)
assert.equal(definition.name, 'gemini-creative')
assert.ok(definition.content.includes('gemini('), 'body shows gemini(...) calls')
assert.ok(!definition.content.includes('gemini_text'), 'old tool name is gone')
for (const trigger of ['剧本', '对白', '旁白', '文案', '场景图']) {
  assert.ok(definition.content.includes(trigger), `body mentions ${trigger}`)
}
assert.ok(!definition.content.includes('DeepSeek Harness'), 'body carries no Harness identity sentence')

// 分工与路由：文学/文字交给 Gemini，技术质检交给本地工具 + 子代理。
assert.ok(
  definition.content.includes('技术测量默认走本地') || definition.content.includes('技术质检走本地'),
  'body routes technical measurement/QC to local tools',
)
for (const word of ['ASR', 'ffprobe', '逐帧', '抽帧', '口型']) {
  assert.ok(definition.content.includes(word), `body names the technical check ${word}`)
}
assert.ok(definition.content.includes('不能证明口型'), 'body refuses to treat ASR/frames as lip-sync proof')
assert.ok(definition.content.includes('整片审看'), 'body separates clip reading from whole-film review')

// 新项目先加载/建立跨项目资产登记，批准素材必须被复用。
assert.ok(definition.content.includes('跨项目资产登记'), 'body asks new projects to load or build the asset registry')
for (const word of ['角色卡', '场景卡', '批准关键帧']) {
  assert.ok(definition.content.includes(word), `body names reusable asset ${word}`)
}
assert.ok(!definition.content.includes('/home/'), 'body hard-codes no machine path')

// 音视频预检参数与用量透明度都写进了技能正文。
for (const word of ['media_purpose', 'local_evidence', 'user_requested_media_review', 'auto_escalate']) {
  assert.ok(definition.content.includes(word), `body explains ${word}`)
}
assert.ok(definition.content.includes('usage_complete'), 'body explains usage completeness')
assert.ok(definition.content.includes('12MB'), 'body states the inline budget')
assert.ok(definition.content.includes('本地裁片') || definition.content.includes('裁片段'), 'body sends oversized media to local trimming')

console.log('dsh-gemini-creative: ok')
