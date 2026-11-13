/**
 * dsh-gemini 自测：不发真实网络请求。
 *
 * 覆盖：工具注册、文本 + 图片 + 文本附件组装、路径标签、类型拒绝、
 * 默认 medium/0.7、思考过滤、Bearer 正常路径、401 回退、预算重试。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, buildRequest, parseResponse } from '../index.js'

const dir = mkdtempSync(join(tmpdir(), 'gemini-'))
writeFileSync(join(dir, 'note.txt'), '第一幕：门开了。')
writeFileSync(
  join(dir, 'dot.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)
writeFileSync(join(dir, 'draft.docx'), 'not really a docx')

let tool
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
}

apply(ctx, {})

assert.equal(tool?.name, 'gemini', 'tool is registered as gemini')
assert.equal(tool.timeoutMs, 600_000, 'tool timeout is 10 minutes')

const request = await buildRequest(
  {
    task: '我们现在在做一部短片。请对照剧本、分镜和场景图，指出明显的场景错误或语义错误。',
    source: '剧本正文：第一幕，雨夜，门开了。',
    files: ['note.txt', 'dot.png'],
  },
  {},
  dir,
)
assert.match(request.url, /\/models\/gemini-4-argon:generateContent$/)
assert.equal(request.model, 'gemini-4-argon')
assert.equal(request.reasoning, 'medium')
assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM')
assert.equal(request.body.generationConfig.temperature, 0.7)

const parts = request.body.contents[0].parts
assert.equal(parts[0].text, '剧本正文：第一幕，雨夜，门开了。')
assert.match(parts[1].text, /note\.txt/)
assert.match(parts[2].text, /第一幕/)
assert.match(parts[3].text, /dot\.png/)
assert.equal(parts[4].inlineData.mimeType, 'image/png')
assert.ok(Buffer.from(parts[4].inlineData.data, 'base64').subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
assert.match(parts[5].text, /场景错误/)

const prompt = JSON.stringify(request.body)
for (const banned of ['DeepSeek Harness', 'Tokens prefixed', 'DSH_BOOT', 'dsh web']) {
  assert.ok(!prompt.includes(banned), `system prompt must not contain "${banned}"`)
}

const parsed = parseResponse({
  candidates: [
    {
      content: {
        parts: [{ text: '内部推理', thought: true }, { text: '第三张图和剧本对不上：' }, { text: '剧本写的是室内。' }],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
})
assert.equal(parsed.text, '第三张图和剧本对不上：剧本写的是室内。')
assert.equal(parsed.usage.input, 11)
assert.equal(parsed.usage.output, 7)
assert.equal(parsed.finishReason, 'STOP')

const calls = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: '场景 2 的图里是白天，剧本是雨夜。' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

try {
  const out = await tool.execute(
    { task: '看看场景图和剧本对不对得上', files: ['dot.png'], reasoning: 'low' },
    { signal: undefined, agent: {} },
  )
  assert.equal(out.text, '场景 2 的图里是白天，剧本是雨夜。')
  assert.equal(out.model, 'gemini-4-argon')
  assert.equal(out.reasoning, 'low')
  assert.equal(out.input_tokens, 20)
  assert.equal(out.output_tokens, 8)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key')
  assert.equal(tool.output.render({}, out)[0].text, out.text)

  // 401 后用原生 Gemini 头重试一次。
  calls.length = 0
  let attempt = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    attempt += 1
    if (attempt === 1) {
      return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401 })
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
      { status: 200 },
    )
  }
  const retried = await tool.execute({ task: 'ping' }, {})
  assert.equal(retried.text, 'OK')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].init.headers['x-goog-api-key'], 'test-key')
  assert.equal(calls[1].init.headers.Authorization, undefined)

  // 思考耗尽预算：自动放大一次再重试。
  calls.length = 0
  attempt = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    attempt += 1
    if (attempt === 1) {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '想了很久', thought: true }] }, finishReason: 'MAX_TOKENS' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 },
        }),
        { status: 200 },
      )
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '好了' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      }),
      { status: 200 },
    )
  }
  const recovered = await tool.execute({ task: 'x', max_tokens: 1024 }, {})
  assert.equal(recovered.text, '好了')
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[1].init.body).generationConfig.maxOutputTokens, 4096)

  await assert.rejects(() => buildRequest({ task: '看看这个', files: ['draft.docx'] }, {}, dir), /unsupported attachment/)
  await assert.rejects(() => buildRequest({ task: '看看这个', files: ['missing.png'] }, {}, dir), /cannot read/)
  await assert.rejects(() => buildRequest({ task: '   ' }, {}, dir), /task must be a non-empty string/)
  await assert.rejects(() => buildRequest({ task: 'x', max_tokens: 10 }, {}, dir), /max_tokens must be an integer/)
  await assert.rejects(() => buildRequest({ task: 'x', temperature: 3 }, {}, dir), /temperature must be a number/)
} finally {
  globalThis.fetch = originalFetch
}

console.log('dsh-gemini: ok')
