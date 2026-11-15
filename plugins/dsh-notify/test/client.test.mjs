/**
 * dsh-notify 浏览器半体自测：用假的 window / EventSource / Notification 载入 client.js，
 * 确认它订阅了宿主的 SSE 端点、把帧变成系统通知、点击时聚焦窗口。
 *
 * 跑法：node test/client.test.mjs（仓根 `npm run verify` 会带上）
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { EVENTS_PATH as HOST_EVENTS_PATH } from '../index.js'

let failed = 0
let passed = 0

/**
 * 跑一条断言，打印结果但不中断后续用例。
 * @param {string} name - 用例名。
 * @param {Function} run - 用例体。
 */
const test = (name, run) => {
  try {
    run()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}`)
    console.error(String(error?.stack ?? error).split('\n').slice(0, 6).join('\n'))
  }
}

/** 记录每次构造出来的通知。 */
const notifications = []
/** 记录 EventSource 实例。 */
const sources = []
/** 被聚焦的次数。 */
let focused = 0

class FakeNotification {
  static permission = 'granted'

  constructor(title, options) {
    this.title = title
    this.options = options
    this.closed = false
    notifications.push(this)
  }

  close() {
    this.closed = true
  }
}

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closed = false
    sources.push(this)
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }

  /** 模拟宿主推来一帧。 */
  dispatch(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  close() {
    this.closed = true
  }
}

let envelope
globalThis.window = {
  focus() {
    focused += 1
  },
  __ModuleLoader__: {
    load(definition) {
      envelope = definition
    },
  },
}
globalThis.Notification = FakeNotification
globalThis.EventSource = FakeEventSource

await import(pathToFileURL(new URL('../client.js', import.meta.url).pathname).href)

console.log('dsh-notify · client')

test('模块信封：id 与宿主 SSE 端点一致', () => {
  assert.ok(envelope !== undefined, 'client.js 没有调用 __ModuleLoader__.load')
  assert.equal(envelope.id, 'dsh-notify')
  const plugin = envelope.factory(() => {
    throw new Error('客户端半边不应该 require 任何模块')
  })
  assert.equal(plugin.name, 'notify')
  assert.equal(plugin.EVENTS_PATH, HOST_EVENTS_PATH)
})

test('apply 订阅宿主横幅流，卸载时关掉连接', () => {
  const plugin = envelope.factory(() => {})
  const cleanups = []
  plugin.apply({
    effect(factory) {
      cleanups.push(factory())
    },
  })
  assert.equal(sources.length, 1)
  assert.equal(sources[0].url, HOST_EVENTS_PATH)
  assert.equal(cleanups.length, 1)
  cleanups[0]()
  assert.equal(sources[0].closed, true)
})

test('收到帧就弹通知：正文来自宿主，静音、可点击聚焦', () => {
  notifications.length = 0
  focused = 0
  const plugin = envelope.factory(() => {})
  plugin.apply({ effect(factory) { factory() } })
  const source = sources.at(-1)
  source.dispatch('message', { data: JSON.stringify({ title: '需要审批 · demo', body: 'bash 等待你的决定', kind: 'approval' }) })

  assert.equal(notifications.length, 1)
  const notification = notifications[0]
  assert.equal(notification.title, '需要审批 · demo')
  assert.equal(notification.options.body, 'bash 等待你的决定')
  assert.equal(notification.options.silent, true)
  notification.onclick()
  assert.equal(focused, 1)
  assert.equal(notification.closed, true)
})

test('坏帧与缺标题的帧被丢弃', () => {
  notifications.length = 0
  const plugin = envelope.factory(() => {})
  plugin.apply({ effect(factory) { factory() } })
  const source = sources.at(-1)
  source.dispatch('message', { data: 'not json' })
  source.dispatch('message', { data: JSON.stringify({ body: '没有标题' }) })
  assert.equal(notifications.length, 0)
})

test('通知权限被明确拒绝时不弹（声音仍由宿主负责）', () => {
  notifications.length = 0
  FakeNotification.permission = 'denied'
  try {
    const plugin = envelope.factory(() => {})
    plugin.apply({ effect(factory) { factory() } })
    sources.at(-1).dispatch('message', { data: JSON.stringify({ title: '本轮完成 · demo', body: '用时 8 秒' }) })
    assert.equal(notifications.length, 0)
  } finally {
    FakeNotification.permission = 'granted'
  }
})

console.log(`\n${failed === 0 ? '通过' : '失败'}：${passed} 项通过，${failed} 项失败`)
if (failed > 0) process.exit(1)
