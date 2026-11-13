/**
 * dsh-gemini-creative 自测：不发网络请求。
 *
 * 覆盖：provider 注册、候选元数据、按需加载正文、中文触发词、正文指向
 * gemini。
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

const definition = await provider.get(candidate)
assert.equal(definition.name, 'gemini-creative')
assert.ok(definition.content.includes('gemini('), 'body shows gemini(...) calls')
assert.ok(!definition.content.includes('gemini_text'), 'old tool name is gone')
for (const trigger of ['剧本', '对白', '旁白', '文案', '场景图']) {
  assert.ok(definition.content.includes(trigger), `body mentions ${trigger}`)
}
assert.ok(!definition.content.includes('DeepSeek Harness'), 'body carries no Harness identity sentence')

console.log('dsh-gemini-creative: ok')
