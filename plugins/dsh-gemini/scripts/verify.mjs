/**
 * dsh-gemini 自测：不发真实网络请求。
 *
 * 覆盖：工具注册、文本 + 图片 + 文本附件组装、路径标签、类型拒绝、
 * 默认 medium/0.7、思考过滤、Bearer 正常路径、401 回退、预算重试（默认关闭）、
 * 每次/累计 usage 与未知计数、空正文失败的费用可见、重试有界、stat 预检、
 * 远端流式截断、URL 脱敏、音视频目的/本地证据预检。
 */
import assert from 'node:assert/strict'
import { closeSync, ftruncateSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, buildRequest, parseResponse, planAttachments, precheckMedia } from '../index.js'

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
writeFileSync(join(dir, 'clip.mp4'), 'fake-mp4-bytes')
writeFileSync(join(dir, 'voice.mp3'), 'fake-mp3-bytes')

// Sparse files: stat reports the budget-breaking size without touching disk.
const MB = 1024 * 1024
const sparse = (name, bytes) => {
  const path = join(dir, name)
  const fd = openSync(path, 'w')
  ftruncateSync(fd, bytes)
  closeSync(fd)
  return path
}
sparse('big.mp4', 13 * MB)
sparse('half-a.mp4', 7 * MB)
sparse('half-b.mp4', 7 * MB)

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
assert.match(tool.description, /literary\/text specialist/, 'description routes literary work to Gemini')
assert.match(tool.description, /local tools and subagents/, 'description routes technical checks to local tools')
assert.match(tool.description, /reported as unknown rather than zero/, 'description promises honest usage reporting')
assert.equal(tool.output.schema.properties.attempts.type, 'array', 'output schema exposes the attempt log')
assert.equal(tool.output.schema.properties.usage_complete.type, 'boolean')
assert.equal(tool.output.schema.properties.unknown_usage_attempts.type, 'integer')

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
assert.deepEqual(request.notes, [], 'plain image review needs no media justification')

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
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18, thoughtsTokenCount: 4 },
})
assert.equal(parsed.text, '第三张图和剧本对不上：剧本写的是室内。')
assert.equal(parsed.usage.input, 11)
assert.equal(parsed.usage.output, 7)
assert.equal(parsed.usage.total, 18)
assert.equal(parsed.usage.thoughts, 4)
assert.equal(parsed.finishReason, 'STOP')

// 缺 usageMetadata 时是未知，不是 0。
const unmeasured = parseResponse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] })
assert.equal(unmeasured.usage.input, null)
assert.equal(unmeasured.usage.total, null)

const calls = []
const originalFetch = globalThis.fetch
const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  return jsonResponse({
    candidates: [{ content: { parts: [{ text: '场景 2 的图里是白天，剧本是雨夜。' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 },
  })
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
  assert.equal(out.total_tokens, 28)
  assert.equal(out.usage_complete, true)
  assert.equal(out.unknown_usage_attempts, 0)
  assert.equal(out.attempt_count, 1)
  assert.equal(out.attempts[0].kind, 'request')
  assert.equal(out.attempts[0].usage_status, 'measured')
  assert.equal(out.attempts[0].status, 200)
  assert.equal(out.attempts[0].max_output_tokens, 16_384)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key')
  const rendered = tool.output.render({}, out)
  assert.equal(rendered[0].text, out.text)
  assert.match(rendered[1].text, /\[usage\] 1 attempt\(s\) \(request\); 20 input \/ 8 output \/ 28 total tokens/)
  const renderedWithNotes = tool.output.render({}, { ...out, notes: ['evidence boundary'] })
  assert.equal(renderedWithNotes[1].text, '[note] evidence boundary')
  assert.match(renderedWithNotes[2].text, /\[usage\]/)

  // 401 后用原生 Gemini 头重试一次；401 的 usage 未知，不能按 0 计成已计量。
  calls.length = 0
  let attempt = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    attempt += 1
    if (attempt === 1) return jsonResponse({ error: { message: 'unauthorized' } }, 401)
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    })
  }
  const retried = await tool.execute({ task: 'ping' }, {})
  assert.equal(retried.text, 'OK')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].init.headers['x-goog-api-key'], 'test-key')
  assert.equal(calls[1].init.headers.Authorization, undefined)
  assert.equal(retried.attempt_count, 2)
  assert.deepEqual(
    retried.attempts.map((item) => item.kind),
    ['request', 'auth-fallback'],
  )
  assert.equal(retried.attempts[0].status, 401)
  assert.equal(retried.attempts[0].usage_status, 'unknown')
  assert.equal(retried.attempts[0].total_tokens, undefined, 'unknown usage is not reported as 0')
  assert.equal(retried.usage_complete, false)
  assert.equal(retried.unknown_usage_attempts, 1)
  assert.equal(retried.input_tokens, 1)
  assert.equal(retried.total_tokens, 2)

  // 默认 auto_escalate=false：只付一次，不隐藏扩大预算。
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: '想了很久', thought: true }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5, thoughtsTokenCount: 5 },
    })
  }
  let defaultRetry
  try {
    await tool.execute({ task: 'x', max_tokens: 1024 }, {})
    assert.fail('expected an empty-text failure')
  } catch (error) {
    defaultRetry = error
  }
  assert.equal(calls.length, 1, 'default is no retry')
  assert.match(defaultRetry.message, /returned no text/)
  assert.match(defaultRetry.message, /attempts=1; cumulative usage 5 input, 0 output, 5 total tokens/)
  assert.equal(defaultRetry.attempts.length, 1)
  assert.equal(defaultRetry.attempts[0].thought_tokens, 5)
  assert.equal(defaultRetry.usage.complete, true)

  // 显式 auto_escalate=true：放大一次预算重试，两次 usage 都累计返回。
  calls.length = 0
  attempt = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    attempt += 1
    if (attempt === 1) {
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: '想了很久', thought: true }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 },
      })
    }
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: '好了' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    })
  }
  const recovered = await tool.execute({ task: 'x', max_tokens: 1024, auto_escalate: true }, {})
  assert.equal(recovered.text, '好了')
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[1].init.body).generationConfig.maxOutputTokens, 4096)
  assert.equal(recovered.attempt_count, 2)
  assert.deepEqual(
    recovered.attempts.map((item) => item.kind),
    ['request', 'budget-retry'],
  )
  assert.equal(recovered.attempts[1].max_output_tokens, 4096)
  assert.equal(recovered.input_tokens, 10, 'cumulative input covers both attempts')
  assert.equal(recovered.output_tokens, 2)
  assert.equal(recovered.total_tokens, 12)
  assert.equal(recovered.attempts[0].total_tokens, 5)
  assert.equal(recovered.usage_complete, true)

  // 已在 65536 上限：即使显式开启也不再放大预算。
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 0, totalTokenCount: 3 },
    })
  }
  let atCap
  try {
    await tool.execute({ task: 'x', max_tokens: 65_536, auto_escalate: true }, {})
    assert.fail('expected an empty-text failure')
  } catch (error) {
    atCap = error
  }
  assert.match(atCap.message, /attempts=1; cumulative usage 3 input/)
  assert.equal(calls.length, 1)

  // 两次都空正文：失败信息仍带两次累计 usage。
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 },
    })
  }
  let empty
  try {
    await tool.execute({ task: 'x', max_tokens: 1024, auto_escalate: true }, {})
    assert.fail('expected an empty-text failure')
  } catch (error) {
    empty = error
  }
  assert.equal(calls.length, 2)
  assert.match(empty.message, /attempts=2; cumulative usage 10 input, 0 output, 10 total tokens/)
  assert.equal(empty.attempts.length, 2)
  assert.equal(empty.usage.total, 10)
  assert.equal(empty.usage.complete, true)

  // HTTP 失败的尝试也记录，错误带累计 usage；无 usageMetadata 时标为未知。
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ error: { message: 'boom' } }, 500)
  }
  let httpError
  try {
    await tool.execute({ task: 'x' }, {})
    assert.fail('expected the HTTP failure')
  } catch (error) {
    httpError = error
  }
  assert.match(httpError.message, /TeamoRouter 500: boom/)
  assert.match(httpError.message, /attempts=1/)
  assert.match(httpError.message, /1 attempt\(s\) with incomplete or unknown usage/)
  assert.equal(httpError.attempts.length, 1)
  assert.equal(httpError.attempts[0].status, 500)
  assert.equal(httpError.attempts[0].usage_status, 'unknown')
  assert.equal(httpError.usage.complete, false)
  assert.equal(httpError.usage.unknown_attempts, 1)
  assert.match(httpError.attempts[0].error, /TeamoRouter 500/)

  globalThis.fetch = originalFetch

  // ---- 附件预检：先 stat 再读，超限在读入/base64 之前失败 ----
  const planned = await planAttachments(['dot.png', 'note.txt'], dir)
  assert.equal(
    planned.inlineBytes,
    Buffer.byteLength('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  )
  assert.equal(planned.planned.length, 2)

  let sizeError
  try {
    await buildRequest(
      { task: '看看这个片段', files: ['big.mp4'], media_purpose: '看表演节奏', local_evidence: 'ffprobe 已看' },
      {},
      dir,
    )
    assert.fail('expected the inline budget to reject the sparse file')
  } catch (error) {
    sizeError = error
  }
  assert.match(sizeError.message, /exceed the 12 MB inline limit \(13\.0 MB total\)/)
  assert.match(sizeError.message, /before any read or base64 encoding/)

  await assert.rejects(
    () =>
      buildRequest(
        { task: 'x', files: ['half-a.mp4', 'half-b.mp4'], media_purpose: '看剪辑节奏', local_evidence: 'ffprobe 已看' },
        {},
        dir,
      ),
    /exceed the 12 MB inline limit \(14\.0 MB total\)/,
  )

  // 远端不信任 content-length：即使 header 谎报得很小，也流式读到 12MB 截断，
  // 且绝不先 arrayBuffer 整个读完。
  const streamOf = (chunks) => {
    let index = 0
    const state = { cancelled: false }
    return {
      state,
      body: {
        getReader: () => ({
          read: async () => {
            if (index >= chunks.length) return { done: true, value: undefined }
            const value = chunks[index]
            index += 1
            return { done: false, value }
          },
          cancel: async () => {
            state.cancelled = true
          },
        }),
      },
    }
  }
  let remoteArrayBufferCalled = false
  let remoteStream = streamOf([new Uint8Array(MB), new Uint8Array(MB), new Uint8Array(MB), new Uint8Array(MB), new Uint8Array(MB), new Uint8Array(MB), new Uint8Array(MB), new Uint8Array(MB), new Uint8Array(MB), new Uint8Array(MB), new Uint8Array(MB), new Uint8Array(MB), new Uint8Array(MB)])
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': '1', 'content-type': 'video/mp4' }),
    body: remoteStream.body,
    arrayBuffer: async () => {
      remoteArrayBufferCalled = true
      return new ArrayBuffer(0)
    },
  })
  try {
    await assert.rejects(
      () =>
        buildRequest(
          { task: 'x', files: ['https://example.com/big.mp4'], media_purpose: '看动作', local_evidence: 'ffprobe 已看' },
          {},
          dir,
        ),
      /exceed the 12 MB inline limit \(stopped after 13\.0 MB read\)/,
    )
    assert.equal(remoteArrayBufferCalled, false, 'remote bodies stream, never arrayBuffer first')
    assert.equal(remoteStream.state.cancelled, true, 'the oversized stream is cancelled')
  } finally {
    globalThis.fetch = originalFetch
  }

  // 远端 URL 的 query 不进入标签/请求，避免外泄 token。
  let secretFetchCalls = 0
  globalThis.fetch = async () => {
    secretFetchCalls += 1
    const stream = streamOf([new Uint8Array(MB)])
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'video/mp4' }),
      body: stream.body,
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }
  try {
    const signed = await buildRequest(
      {
        task: '看整体气质',
        files: ['https://example.com/clip.mp4?token=SECRET-SIGNATURE'],
        media_purpose: '看整体气质',
        local_evidence: 'ffprobe 已看',
      },
      {},
      dir,
    )
    const signedParts = signed.body.contents[0].parts
    assert.equal(signedParts[0].text, '文件 1：https://example.com/clip.mp4')
    assert.ok(!JSON.stringify(signed.body).includes('SECRET-SIGNATURE'), 'signed URL query never reaches the prompt')
    assert.equal(secretFetchCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }

  // URL 里的 userinfo 也去掉。
  let credentialLabel = ''
  globalThis.fetch = async () => {
    const stream = streamOf([new Uint8Array(MB)])
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'video/mp4' }),
      body: stream.body,
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }
  try {
    const credentialed = await buildRequest(
      {
        task: '看整体气质',
        files: ['https://user:pass@example.com/clip.mp4'],
        media_purpose: '看整体气质',
        local_evidence: 'ffprobe 已看',
      },
      {},
      dir,
    )
    credentialLabel = credentialed.body.contents[0].parts[0].text
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(credentialLabel, '文件 1：https://example.com/clip.mp4')
  assert.ok(!credentialLabel.includes('demo-user'), 'URL credentials are stripped from the label')

  // 取流失败时若运行时把完整 URL 写进错误，也要替换成脱敏地址。
  globalThis.fetch = async () => {
    throw new Error('fetch failed for https://example.com/clip.mp4?token=SECRET-SIGNATURE')
  }
  let echoed
  try {
    await buildRequest(
      {
        task: '看整体气质',
        files: ['https://example.com/clip.mp4?token=SECRET-SIGNATURE'],
        media_purpose: '看整体气质',
        local_evidence: 'ffprobe 已看',
      },
      {},
      dir,
    )
    assert.fail('expected the fetch failure')
  } catch (error) {
    echoed = error
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.match(echoed.message, /cannot read https:\/\/example\.com\/clip\.mp4/)
  assert.ok(!echoed.message.includes('SECRET-SIGNATURE'), 'signed URL never leaks through an error')

  // ---- 音视频目的/本地证据预检 ----
  await assert.rejects(() => buildRequest({ task: '看看这段表演', files: ['clip.mp4'] }, {}, dir), /need media_purpose/)
  await assert.rejects(
    () => buildRequest({ task: '看看这段表演', files: ['clip.mp4'], media_purpose: '判断表演是否连贯' }, {}, dir),
    /need local_evidence/,
  )

  const clipRequest = await buildRequest(
    {
      task: '看看这段表演',
      files: ['clip.mp4'],
      media_purpose: '判断表演和走位是否连贯',
      local_evidence: 'ffprobe 2.4s；抽帧 3 张；ASR 1 句',
    },
    {},
    dir,
  )
  assert.equal(clipRequest.notes.length, 2)
  assert.match(clipRequest.notes[0], /routing aids, not user or expert acceptance/)
  assert.ok(clipRequest.notes.some((note) => /cannot prove lip-sync, identity, or performance/.test(note)))
  assert.equal(clipRequest.body.contents[0].parts[1].inlineData.mimeType, 'video/mp4')

  const userAsked = await buildRequest(
    { task: '用户要求直接看这个片段', files: ['clip.mp4'], media_purpose: '看整体气质', user_requested_media_review: true },
    {},
    dir,
  )
  assert.match(userAsked.notes[0], /Clip-level reading, not a whole-film review/)

  const audioRequest = await buildRequest(
    {
      task: '听一下这句对白，口型对不对',
      files: ['voice.mp3'],
      media_purpose: '判断对白语气',
      local_evidence: '本地 ASR 转写已完成',
    },
    {},
    dir,
  )
  assert.ok(
    audioRequest.notes.some((note) => /audio-only; lip-sync/.test(note)),
    'audio-only lip-sync requests get a warning',
  )

  // 普通图片对照不需要 media_purpose，也不加 notes。
  const imageOnly = await buildRequest({ task: '这几张场景图哪张更贴近剧本', files: ['dot.png'] }, {}, dir)
  assert.deepEqual(imageOnly.notes, [])
  assert.deepEqual(precheckMedia({ task: 'x' }, [{ kind: 'inline', mimeType: 'image/png' }]), [])
  assert.throws(
    () => precheckMedia({ task: 'x' }, [{ kind: 'inline', mimeType: 'video/mp4' }]),
    /need media_purpose/,
  )

  await assert.rejects(() => buildRequest({ task: '看看这个', files: ['draft.docx'] }, {}, dir), /unsupported attachment/)
  await assert.rejects(() => buildRequest({ task: '看看这个', files: ['missing.png'] }, {}, dir), /cannot read/)
  await assert.rejects(() => buildRequest({ task: '   ' }, {}, dir), /task must be a non-empty string/)
  await assert.rejects(() => buildRequest({ task: 'x', max_tokens: 10 }, {}, dir), /max_tokens must be an integer/)
  await assert.rejects(() => buildRequest({ task: 'x', temperature: 3 }, {}, dir), /temperature must be a number/)
  await assert.rejects(() => buildRequest({ task: 'x', reasoning: 'extreme' }, {}, dir), /reasoning must be one of/)
} finally {
  globalThis.fetch = originalFetch
}

console.log('dsh-gemini: ok')
