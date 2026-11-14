/**
 * dsh-claude 自测：不发真实网络请求。
 *
 * 覆盖：工具/技能注册、请求形状（推理预算、缓存断点、多模态块）、
 * 参数校验、附件拒绝与截断、思考块过滤、缓存用量解析、Bearer 正常路径、
 * 401 回退、预算重试、拒绝回答、渲染页脚以及技能正文。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, buildRequest, parseResponse } from '../index.js'

const dir = mkdtempSync(join(tmpdir(), 'claude-'))
writeFileSync(join(dir, 'note.txt'), '错误：PutObject 超时后客户端重试，产生重复对象。')
writeFileSync(
  join(dir, 'dot.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)
writeFileSync(join(dir, 'spec.pdf'), '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
writeFileSync(join(dir, 'draft.docx'), 'not really a docx')

let tool
let provider
const ctx = {
  tools: {
    register(definition) {
      tool = definition
    },
  },
  workingDirectory: {
    async ensure() {
      return dir
    },
  },
  credentials: {
    async resolve() {
      return { value: 'test-key' }
    },
  },
  skills: {
    registerProvider(factory) {
      provider = factory()
    },
  },
}

apply(ctx, {})

assert.equal(tool?.name, 'claude', 'tool is registered as claude')
assert.equal(tool.timeoutMs, 900_000, 'tool timeout is 15 minutes')
assert.equal(provider?.name, 'claude-expert', 'skill provider is registered')

const request = await buildRequest(
  {
    task: '请判断这个上传迁移会不会丢数据；如果有，指出最小修复。',
    source: '项目背景：上传服务 200 QPS，本地磁盘切对象存储，计划双写后切读。',
    files: ['note.txt', 'dot.png', 'spec.pdf'],
  },
  {},
  dir,
)

assert.equal(request.url, 'https://api.teamorouter.com/v1/messages')
assert.equal(request.model, 'claude-opus-5-5')
assert.equal(request.reasoning, 'high')
assert.equal(request.thinkingBudget, 16_384)
assert.equal(request.maxTokens, 24_576)
assert.equal(request.cacheTTL, '1h')
assert.deepEqual(request.beta, ['extended-cache-ttl-2025-04-11'])
assert.deepEqual(request.body.thinking, { type: 'enabled', budget_tokens: 16_384 })
assert.equal(request.body.system[0].cache_control.type, 'ephemeral')
assert.equal(request.body.system[0].cache_control.ttl, '1h')

const content = request.body.messages[0].content
assert.equal(content[0].text, '项目背景：上传服务 200 QPS，本地磁盘切对象存储，计划双写后切读。')
assert.match(content[1].text, /note\.txt/)
assert.match(content[2].text, /PutObject 超时/)
assert.match(content[3].text, /dot\.png/)
assert.equal(content[4].type, 'image')
assert.equal(content[4].source.media_type, 'image/png')
assert.ok(Buffer.from(content[4].source.data, 'base64').subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
assert.match(content[5].text, /spec\.pdf/)
assert.equal(content[6].type, 'document')
assert.equal(content[6].source.media_type, 'application/pdf')
assert.equal(content[7].text, '以上是本次咨询的固定背景。')
assert.equal(content[7].cache_control.type, 'ephemeral')
assert.equal(content[7].cache_control.ttl, '1h')
assert.match(content[8].text, /最小修复/)
assert.equal(content.filter((block) => block.cache_control !== undefined).length, 1)

const prompt = JSON.stringify(request.body)
for (const banned of ['DeepSeek Harness', 'Tokens prefixed', 'DSH_BOOT', 'dsh web']) {
  assert.ok(!prompt.includes(banned), `system prompt must not contain "${banned}"`)
}

const shortCache = await buildRequest({ task: 'x', source: '固定背景', cache_ttl: '5m' }, {}, dir)
assert.equal(shortCache.cacheTTL, '5m')
assert.deepEqual(shortCache.beta, [])
assert.equal(shortCache.body.system[0].cache_control.ttl, undefined)
assert.equal(shortCache.body.messages[0].content.at(-2).cache_control.ttl, undefined)

const bare = await buildRequest({ task: '只有一个问题' }, {}, dir)
assert.equal(bare.body.messages[0].content.length, 1, 'no briefing means no cache marker')
assert.equal(bare.body.messages[0].content[0].text, '只有一个问题')

const low = await buildRequest({ task: 'x', reasoning: 'low' }, {}, dir)
assert.equal(low.thinkingBudget, 2_048)
assert.equal(low.maxTokens, 10_240)
const medium = await buildRequest({ task: 'x', reasoning: 'medium' }, {}, dir)
assert.equal(medium.thinkingBudget, 8_192)
assert.equal(medium.maxTokens, 16_384)

await assert.rejects(() => buildRequest({ task: 'x', reasoning: 'extreme' }, {}, dir), /reasoning must be one of/)
await assert.rejects(
  () => buildRequest({ task: 'x', reasoning: 'high', max_tokens: 16_384 }, {}, dir),
  /at least 17408/,
)
await assert.rejects(() => buildRequest({ task: 'x', max_tokens: 100 }, {}, dir), /max_tokens must be an integer/)
await assert.rejects(() => buildRequest({ task: 'x', cache_ttl: '24h' }, {}, dir), /cache_ttl must be one of/)
await assert.rejects(() => buildRequest({ task: '   ' }, {}, dir), /task must be a non-empty string/)
await assert.rejects(
  () => buildRequest({ task: 'x'.repeat(200_001) }, {}, dir),
  /task is longer than 200000/,
)
await assert.rejects(() => buildRequest({ task: 'x', files: ['draft.docx'] }, {}, dir), /unsupported attachment/)
await assert.rejects(() => buildRequest({ task: 'x', files: ['missing.png'] }, {}, dir), /cannot read/)

const clipped = await buildRequest({ task: 'x', source: 'a'.repeat(250_000) }, {}, dir)
assert.match(clipped.body.messages[0].content[0].text, /\[truncated\]$/)

const parsed = parseResponse({
  model: 'claude-opus-5-5',
  content: [
    { type: 'thinking', thinking: '内部推理', signature: 'sig' },
    { type: 'text', text: '第一段。' },
    { type: 'text', text: '第二段。' },
  ],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 11,
    output_tokens: 7,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 200,
  },
})
assert.equal(parsed.text, '第一段。第二段。', 'thinking blocks are dropped')
assert.equal(parsed.finishReason, 'end_turn')
assert.equal(parsed.usage.input, 11)
assert.equal(parsed.usage.output, 7)
assert.equal(parsed.usage.cacheWrite, 100)
assert.equal(parsed.usage.cacheRead, 200)

const payload = (overrides = {}) => ({
  model: 'claude-opus-5-5',
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: '迁移方案 A 有一个丢数据窗口。' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 20,
    output_tokens: 8,
    cache_creation_input_tokens: 500,
    cache_read_input_tokens: 0,
    ...overrides,
  },
})

const calls = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  return new Response(JSON.stringify(payload()), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

try {
  const out = await tool.execute(
    { task: '请复核迁移方案', files: ['dot.png'], reasoning: 'medium' },
    { signal: undefined, agent: {} },
  )
  assert.equal(out.text, '迁移方案 A 有一个丢数据窗口。')
  assert.equal(out.model, 'claude-opus-5-5')
  assert.equal(out.reasoning, 'medium')
  assert.equal(out.thinking_budget, 8_192)
  assert.equal(out.max_tokens, 16_384)
  assert.equal(out.input_tokens, 520)
  assert.equal(out.uncached_input_tokens, 20)
  assert.equal(out.output_tokens, 8)
  assert.equal(out.cache_write_tokens, 500)
  assert.equal(out.cache_read_tokens, 0)
  assert.equal(out.cache_ttl, '1h')
  assert.equal(out.cache_hit, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.teamorouter.com/v1/messages')
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key')
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01')
  assert.equal(calls[0].init.headers['anthropic-beta'], 'extended-cache-ttl-2025-04-11')
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.thinking.type, 'enabled')
  assert.equal(sent.system[0].cache_control.ttl, '1h')
  assert.equal(
    tool.output.render({}, out)[0].text,
    `${out.text}\n\n[claude-opus-5-5 · medium · in 520 (new 20) / out 8 · cache write 500 / read 0]`,
  )

  // 缓存命中：读缓存，页脚显示 read。
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(payload({ cache_read_input_tokens: 400, cache_creation_input_tokens: 0 })), {
      status: 200,
    })
  }
  const cached = await tool.execute({ task: '追问', source: '固定背景' }, {})
  assert.equal(cached.input_tokens, 420)
  assert.equal(cached.uncached_input_tokens, 20)
  assert.equal(cached.cache_read_tokens, 400)
  assert.equal(cached.cache_hit, true)
  assert.match(tool.output.render({}, cached)[0].text, /in 420 \(new 20\)/)
  assert.match(tool.output.render({}, cached)[0].text, /cache read 400 \/ write 0/)

  // 5m 缓存不发送 beta 头，也不带 ttl。
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(payload()), { status: 200 })
  }
  await tool.execute({ task: '一次性问题', cache_ttl: '5m' }, {})
  assert.equal(calls[0].init.headers['anthropic-beta'], undefined)
  assert.equal(JSON.parse(calls[0].init.body).system[0].cache_control.ttl, undefined)

  // 401 后用原生 Anthropic 头重试一次。
  calls.length = 0
  let attempt = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    attempt += 1
    if (attempt === 1) {
      return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401 })
    }
    return new Response(JSON.stringify(payload()), { status: 200 })
  }
  const retried = await tool.execute({ task: 'ping' }, {})
  assert.equal(retried.text, '迁移方案 A 有一个丢数据窗口。')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].init.headers['x-api-key'], 'test-key')
  assert.equal(calls[1].init.headers.authorization, undefined)

  // 思考耗尽预算：自动放大一次再重试。
  calls.length = 0
  attempt = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    attempt += 1
    if (attempt === 1) {
      return new Response(
        JSON.stringify({
          model: 'claude-opus-5-5',
          content: [{ type: 'thinking', thinking: '想了很久', signature: 'sig' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify(payload()), { status: 200 })
  }
  const recovered = await tool.execute({ task: 'x', max_tokens: 17_408 }, {})
  assert.equal(recovered.text, '迁移方案 A 有一个丢数据窗口。')
  assert.equal(recovered.max_tokens, 32_000)
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[1].init.body).max_tokens, 32_000)

  // 拒答与空回答都给出可操作错误。
  calls.length = 0
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        content: [],
        stop_reason: 'refusal',
        usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
      { status: 200 },
    )
  }
  await assert.rejects(() => tool.execute({ task: 'x' }, {}), /declined/)

  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
      { status: 200 },
    )
  }
  await assert.rejects(() => tool.execute({ task: 'x' }, {}), /returned no text/)

  // 上游错误保留状态码与消息。
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ error: { message: 'model overloaded' } }), { status: 503 })
  }
  await assert.rejects(() => tool.execute({ task: 'x' }, {}), /TeamoRouter 503: model overloaded/)
} finally {
  globalThis.fetch = originalFetch
}

const listed = await provider.list()
assert.equal(listed.length, 1)
assert.equal(listed[0].name, 'external-expert')
assert.deepEqual(listed[0].invocation, { modelInvocable: true, userInvocable: true })
assert.match(listed[0].description, /迷茫/)
assert.match(listed[0].description, /second opinion/)

const skill = await provider.get()
assert.equal(skill.name, 'external-expert')
assert.match(skill.content, /多次被反驳/)
assert.match(skill.content, /cache_ttl/)
assert.match(skill.content, /第二意见/)
assert.match(skill.content, /files/)

console.log('dsh-claude: ok')
