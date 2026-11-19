/**
 * 离线自测：不联网、不碰真实 profile。
 *
 * 覆盖：脱敏、快照规范化、三种渲染、导出文件名/转义、只读服务路由与越界防护、
 * 分享目录的创建/撤销/过期清理、以及本机 Chromium 转 PDF（找不到时跳过并说明）。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redact } from '../lib/redact.js'
import { normalizeMessages, renderHtml, renderMarkdown, renderPrintHtml, groupTurns, deriveTitle } from '../lib/render.js'
import { openStore } from '../lib/store.js'
import { startShareServer } from '../lib/server.js'
import { findChromium, htmlToPdf } from '../lib/pdf.js'

const results = []
/**
 * 记录一条断言结果。
 * @param {string} name - 用例名。
 * @param {() => Promise<void>|void} fn - 用例。
 */
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) })
  }
}

/** 构造一条假消息；source.kind 与真实会话一致（user / model / tool / system-prompt）。 */
function msg(role, blocks, kind) {
  const sourceKind = kind ?? (role === 'assistant' ? 'model' : role === 'tool' ? 'tool' : role === 'system' ? 'system-prompt' : 'user')
  return { id: `${role}-1`, role, source: { kind: sourceKind }, content: blocks }
}

const FIXTURE = [
  msg('system', [{ type: 'text', text: '系统注入内容不应出现' }]),
  msg('user', [{ type: 'text', text: '你好，<script>alert(1)</script>\n```js\nconst a = 1\n```' }]),
  msg('assistant', [
    { type: 'reasoning', text: '先想一想' },
    { type: 'text', text: '这是回答，密钥 sk-abcdefghijklmnopqrstuvwxyz 与路径 /home/alice/x' },
    { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"/home/alice/a"}' }
  ]),
  msg('tool', [{ type: 'text', text: '文件内容' }]),
  // 注入上下文：DSH 用 user 角色发，但 source.kind 不是 user —— 正是要过滤掉的那类。
  msg('user', [{ type: 'text', text: 'AGENTS.md 注入上下文不应出现在分享里' }], 'agent-instructions')
]

await check('脱敏：密钥与家目录被替换', () => {
  const out = redact('sk-abcdefghijklmnopqrstuvwxyz /home/alice/x AKIAABCDEFGHIJKLMNOP')
  assert.ok(out.includes('[REDACTED:api-key]'))
  assert.ok(out.includes('~/x'))
  assert.ok(out.includes('[REDACTED:aws-key]'))
  assert.ok(!out.includes('alice'))
})

await check('规范化：丢弃 system，默认不带工具与结果', () => {
  const messages = normalizeMessages(FIXTURE, {})
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].tools.length, 0)
  assert.equal(messages[1].reasoning, '')
  assert.ok(messages[1].text.includes('[REDACTED:api-key]'))
})

await check('规范化：打开开关后带工具、结果、思考', () => {
  const messages = normalizeMessages(FIXTURE, { includeToolCalls: true, includeToolResults: true, includeReasoning: true, redact: false })
  assert.equal(messages.length, 3)
  assert.equal(messages[1].tools[0].name, 'read')
  assert.ok(messages[1].reasoning.includes('先想一想'))
  assert.equal(messages[2].role, 'tool')
})

await check('注入上下文：user 角色的 AGENTS.md/技能目录被过滤', () => {
  const messages = normalizeMessages(FIXTURE, { includeToolCalls: true, includeReasoning: true })
  assert.equal(messages.some((message) => message.text.includes('AGENTS.md')), false)
  assert.equal(messages.filter((message) => message.role === 'user').length, 1)
})

await check('分轮与标题：按用户消息切轮，标题取首问', () => {
  const messages = normalizeMessages(FIXTURE, {})
  const turns = groupTurns(messages)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].question.role, 'user')
  assert.equal(deriveTitle(messages, 'session-x'), '你好，<script>alert(1)</script>')
})


await check('配置：默认值合并与 volatile 解引用', async () => {
  const { readConfig, DEFAULTS } = await import('../index.js')
  const plain = readConfig({})
  assert.equal(plain.publicBaseUrl, DEFAULTS.publicBaseUrl)
  assert.equal(plain.port, DEFAULTS.port)
  const live = readConfig({
    publicBaseUrl: { get: () => 'https://share.example.com/s/' },
    port: { get: () => 4100 },
    redact: { get: () => false }
  })
  assert.equal(live.publicBaseUrl, 'https://share.example.com/s/')
  assert.equal(live.port, 4100)
  assert.equal(live.redact, false)
  assert.equal(live.includeToolCalls, DEFAULTS.includeToolCalls)
})

await check('Markdown：表格 / 嵌套列表 / 任务清单 / 强调', async () => {
  const { renderBlocks } = await import('../lib/markdown.js')
  const md = [
    '| 列 A | 列 B |',
    '| :--- | ---: |',
    '| `x` | **1** |',
    '',
    '- 一级',
    '  - 二级 ~~删除~~',
    '- [x] 已完成',
    '',
    '正文 *斜体* 与 https://example.com/a'
  ].join('\n')
  const html = renderBlocks(md)
  assert.ok(html.includes('<table>'))
  assert.ok(html.includes('class="ta-left"'))
  assert.ok(html.includes('class="ta-right"'))
  assert.ok(html.includes('<li>一级<ul><li>二级'))
  assert.ok(html.includes('二级'))
  assert.ok(html.includes('type="checkbox" disabled checked'))
  assert.ok(html.includes('<del>删除</del>'))
  assert.ok(html.includes('<em>斜体</em>'))
  assert.ok(html.includes('href="https://example.com/a"'))
})

await check('Markdown：代码高亮与不安全链接', async () => {
  const { renderBlocks } = await import('../lib/markdown.js')
  const html = renderBlocks('```json\n{"a": 1, "b": true}\n```\n\n[x](javascript:alert(1))')
  assert.ok(html.includes('tok-key'))
  assert.ok(html.includes('tok-num'))
  assert.ok(html.includes('tok-lit'))
  assert.ok(!html.includes('href="javascript:'))
})

await check('HTML：转义脚本、保留代码块、不泄露 system', () => {
  const doc = { title: '测试 <b>标题</b>', messages: normalizeMessages(FIXTURE, {}) }
  const html = renderHtml(doc)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('class="code"'))
  assert.ok(html.includes('第 1 轮'))
  assert.ok(html.includes('工具调用'))
  assert.ok(!html.includes('系统注入内容'))
  assert.ok(!html.includes('AGENTS.md'))
  assert.ok(html.includes('&lt;b&gt;标题'))
})

await check('Markdown：角色分节与代码围栏', () => {
  const md = renderMarkdown({ title: 'T', messages: normalizeMessages(FIXTURE, {}) })
  assert.ok(md.startsWith('# T'))
  assert.ok(md.includes('## 第 1 轮'))
  assert.ok(md.includes('### 你'))
  assert.ok(md.includes('### 助手'))
  assert.ok(md.includes('```js'))
})

await check('打印 HTML：含 @page 与浅色打印样式', () => {
  const html = renderPrintHtml({ title: 'T', messages: normalizeMessages(FIXTURE, {}) })
  assert.ok(html.includes('@page'))
  assert.ok(html.includes('11.5pt'))
  assert.ok(html.includes('size:A4'))
})

const home = await mkdtemp(join(tmpdir(), 'share-hub-verify-'))
try {
  const store = await openStore({ home })
  await check('存储：创建/列出/撤销', async () => {
    const item = await store.create({ title: 'A', sessionId: 's1', ttlHours: 1 })
    assert.equal(store.list().length, 1)
    await writeFile(join(store.sitesDir, item.id, 'index.html'), '<h1>hi</h1>')
    assert.equal(await store.revoke(item.id), true)
    assert.equal(store.list().length, 0)
  })

  await check('存储：过期清理', async () => {
    const item = await store.create({ title: 'B', sessionId: 's2', ttlHours: 1 })
    store.state.items[item.id].expiresAt = Date.now() - 1
    const dropped = await store.sweep()
    assert.equal(dropped, 1)
    assert.equal(store.isLive(item.id), false)
  })

  await check('只读服务：命中、越界、过期', async () => {
    const item = await store.create({ title: 'C', sessionId: 's3', ttlHours: 1 })
    await writeFile(join(store.sitesDir, item.id, 'index.html'), '<!doctype html><h1>ok</h1>')
    const server = await startShareServer({ sitesDir: store.sitesDir, port: 0, isLive: (id) => store.isLive(id) })
    try {
      const base = `http://127.0.0.1:${server.port}`
      const ok = await fetch(`${base}/s/${item.id}/`)
      assert.equal(ok.status, 200)
      assert.ok((await ok.text()).includes('<h1>ok</h1>'))
      assert.equal((await fetch(`${base}/s/${item.id}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).status, 403)
      assert.equal((await fetch(`${base}/s/zzzzzzzz/`)).status, 404)
      assert.equal((await fetch(`${base}/healthz`)).status, 200)
      assert.equal((await fetch(`${base}/s/${item.id}/`, { method: 'POST' })).status, 405)
      store.state.items[item.id].expiresAt = Date.now() - 1
      assert.equal((await fetch(`${base}/s/${item.id}/`)).status, 404)
    } finally {
      await server.close()
    }
  })

  const chromium = await findChromium('')
  if (chromium === null) {
    results.push({ name: 'PDF：跳过（本机没有 Chromium 内核）', ok: true, skipped: true })
  } else {
    await check('PDF：本机 Chromium 生成有效 PDF', async () => {
      const out = join(home, 'out.pdf')
      const doc = { title: 'PDF 测试', messages: normalizeMessages(FIXTURE, {}) }
      const result = await htmlToPdf({ html: renderPrintHtml(doc), outPath: out, timeoutMs: 60_000 })
      assert.ok(result.bytes > 1000)
      const bytes = await readFile(out)
      assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-')
    })
  }
} finally {
  await rm(home, { recursive: true, force: true })
}

const harnessHome = await mkdtemp(join(tmpdir(), 'share-hub-routes-'))
process.env.DSH_HOME = harnessHome
try {
  const { apply } = await import('../index.js')
  const routes = new Map()
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    connection: {
      fetch: {
        register(definition) {
          routes.set(definition.path, definition)
          return () => routes.delete(definition.path)
        }
      }
    },
    sessionQuery: {
      readSession: async (id) => ({ session: { id }, events: [] })
    },
    logger: { info() {}, warn() {} },
    on() { return () => {} },
    provide() {}
  }
  apply(ctx, { port: 0, publicBaseUrl: 'https://example.test/s/' })

  const call = async (path, body) => {
    const pathname = path.split('?')[0]
    const definition = routes.get(pathname)
    assert.ok(definition !== undefined, `路由未注册：${path}`)
    const request = body === undefined
      ? new Request(`http://localhost${path}`, { method: 'GET', headers: { host: 'localhost' } })
      : new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { host: 'localhost', 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    return definition.fetch(request)
  }

  await check('路由：生成链接写入只读目录', async () => {
    const response = await call('/api/share-hub/link', { sessionId: 'session-test-1', ttlHours: 1 })
    const data = await response.json()
    assert.equal(response.status, 200)
    assert.ok(data.url.startsWith('https://example.test/s/'))
    assert.ok(data.id.length >= 6)
    const html = await readFile(join(harnessHome, 'share-hub', 'sites', data.id, 'index.html'), 'utf8')
    assert.ok(html.includes('<!doctype html>'))
  })

  await check('路由：导出 HTML 并下载', async () => {
    const response = await call('/api/share-hub/export', { sessionId: 'session-test-1', format: 'html' })
    const data = await response.json()
    assert.equal(response.status, 200)
    assert.ok(data.name.endsWith('.html'))
    const download = await call(`/api/share-hub/download?name=${encodeURIComponent(data.name)}`)
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.ok((download.headers.get('content-disposition') ?? '').startsWith('attachment;'))
  })

  await check('路由：下载名白名单挡住越界', async () => {
    const definition = routes.get('/api/share-hub/download')
    const response = await definition.fetch(new Request('http://localhost/api/share-hub/download?name=..%2Fstate.json', { headers: { host: 'localhost' } }))
    assert.equal(response.status, 400)
  })

  await check('路由：列表与撤销', async () => {
    const list = await (await call('/api/share-hub/list')).json()
    assert.ok(list.items.length >= 1)
    const id = list.items[0].id
    const revoked = await (await call('/api/share-hub/revoke', { id })).json()
    assert.equal(revoked.revoked, true)
    const after = await (await call('/api/share-hub/list')).json()
    assert.equal(after.items.some((item) => item.id === id), false)
  })

  for (const dispose of disposers) dispose()
} finally {
  delete process.env.DSH_HOME
  await rm(harnessHome, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? (item.skipped ? 'SKIP' : 'ok  ') : 'FAIL'}  ${item.name}${item.ok ? '' : `\n      ${item.error}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exitCode = 1
