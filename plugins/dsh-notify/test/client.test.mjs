/**
 * dsh-notify 浏览器半体自测：用假的 window / EventSource / Notification / AudioContext
 * 载入 client.js，确认它订阅了宿主的 SSE 端点、把帧变成系统通知、按帧里的 `sound`
 * 合成提示音，并在首次手势里解锁音频与通知权限。
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
/** 记录 window 上挂过的手势监听器。 */
const windowListeners = new Map()
/** 被聚焦的次数。 */
let focused = 0

class FakeNotification {
  static permission = 'granted'
  static requested = 0

  static requestPermission() {
    FakeNotification.requested += 1
    return Promise.resolve('default')
  }

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

/** 记下每一次排进时间线的振荡器，供断言「响了几声」。 */
const oscillators = []

class FakeAudioContext {
  /** 新建上下文时的初始状态；自测里改成 `'suspended'` 模拟没有用户手势。 */
  static initialState = 'running'

  /** `'running'`：resume 成功；`'suspended'`：resume 后仍然没跑起来（浏览器拦了）。 */
  static resumeBehavior = 'running'

  static instances = []

  constructor() {
    this.state = FakeAudioContext.initialState
    this.currentTime = 0
    this.resumes = 0
    FakeAudioContext.instances.push(this)
  }

  get destination() {
    return { name: 'destination' }
  }

  resume() {
    this.resumes += 1
    if (FakeAudioContext.resumeBehavior === 'running') this.state = 'running'
    return Promise.resolve()
  }

  createOscillator() {
    const oscillator = {
      type: 'sine',
      frequency: {
        setValueAtTime() {},
        exponentialRampToValueAtTime() {},
      },
      connect() {},
      start() {},
      stop() {},
    }
    oscillators.push(oscillator)
    return oscillator
  }

  createGain() {
    return {
      gain: {
        setValueAtTime() {},
        exponentialRampToValueAtTime() {},
      },
      connect() {},
    }
  }
}

let envelope
globalThis.window = {
  focus() {
    focused += 1
  },
  addEventListener(type, handler) {
    const list = windowListeners.get(type) ?? []
    list.push(handler)
    windowListeners.set(type, list)
  },
  removeEventListener(type, handler) {
    const list = windowListeners.get(type) ?? []
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  },
  __ModuleLoader__: {
    load(definition) {
      envelope = definition
    },
  },
}
globalThis.Notification = FakeNotification
globalThis.EventSource = FakeEventSource
globalThis.AudioContext = FakeAudioContext

await import(pathToFileURL(new URL('../client.js', import.meta.url).pathname).href)

console.log('dsh-notify · client')

/** 每次用例前清空通知、振荡器与窗口监听器。 */
const reset = () => {
  notifications.length = 0
  oscillators.length = 0
  focused = 0
  windowListeners.clear()
  FakeNotification.permission = 'granted'
  FakeNotification.requested = 0
  FakeAudioContext.instances.length = 0
  FakeAudioContext.initialState = 'running'
  FakeAudioContext.resumeBehavior = 'running'
}

/** 装配一个客户端插件实例，返回它和清理函数。 */
const mount = () => {
  const plugin = envelope.factory(() => {})
  const cleanups = []
  plugin.apply({
    effect(factory) {
      cleanups.push(factory())
    },
  })
  return { plugin, cleanups }
}

test('模块信封：id 与宿主 SSE 端点一致，四类提示音齐全', () => {
  assert.ok(envelope !== undefined, 'client.js 没有调用 __ModuleLoader__.load')
  assert.equal(envelope.id, 'dsh-notify')
  const plugin = envelope.factory(() => {
    throw new Error('客户端半边不应该 require 任何模块')
  })
  assert.equal(plugin.name, 'notify')
  assert.equal(plugin.EVENTS_PATH, HOST_EVENTS_PATH)
  assert.deepEqual(Object.keys(plugin.CUES).sort(), ['approval', 'error', 'question', 'turn'])
  for (const cue of Object.values(plugin.CUES)) {
    assert.ok(Array.isArray(cue) && cue.length > 0)
    for (const note of cue) assert.ok(Number.isFinite(note.freq))
  }
})

test('apply 订阅横幅流并挂手势监听，卸载时全部收掉', () => {
  reset()
  const { cleanups } = mount()
  assert.equal(sources.length, 1)
  assert.equal(sources[0].url, HOST_EVENTS_PATH)
  assert.equal(cleanups.length, 2, '一条 SSE + 一条手势监听')
  assert.deepEqual([...windowListeners.keys()].sort(), ['keydown', 'pointerdown'])

  for (const cleanup of cleanups) cleanup()
  assert.equal(sources[0].closed, true)
  assert.equal([...windowListeners.values()].flat().length, 0)
})

test('收到帧就弹通知：正文来自宿主，静音、可点击聚焦', () => {
  reset()
  const { plugin } = mount()
  plugin.handle({ title: '需要审批 · demo', body: 'bash 等待你的决定', kind: 'approval' })

  assert.equal(notifications.length, 1)
  const notification = notifications[0]
  assert.equal(notification.title, '需要审批 · demo')
  assert.equal(notification.options.body, 'bash 等待你的决定')
  assert.equal(notification.options.silent, true, '没有 sound 字段时仍静音')
  notification.onclick()
  assert.equal(focused, 1)
  assert.equal(notification.closed, true)
})

test('带 sound 的帧会合成提示音，并让系统通知闭嘴', () => {
  reset()
  const { plugin } = mount()
  plugin.handle({ title: '本轮完成 · demo', body: '用时 30 秒', kind: 'turn', sound: 'turn' })

  assert.ok(oscillators.length >= 2, 'turn 有两声')
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].options.silent, true, '页面已经响过，别再响一声')
})

test('音频没解锁时不排队，改让系统通知自己响一声', () => {
  reset()
  FakeAudioContext.initialState = 'suspended'
  FakeAudioContext.resumeBehavior = 'stay-suspended'
  const { plugin } = mount()
  plugin.handle({ title: '本轮出错 · demo', body: '出错：provider 500', kind: 'error', sound: 'error' })

  assert.equal(oscillators.length, 0)
  assert.equal(FakeAudioContext.instances.length, 1)
  assert.equal(FakeAudioContext.instances[0].resumes, 1)
  assert.equal(notifications[0].options.silent, false, '页面放不出声，退回系统提示音')
})

test('未知类别或浏览器不支持 Web Audio 时安静返回 false', () => {
  reset()
  const { plugin } = mount()
  assert.equal(plugin.playCue('没见过的类别'), false)
  const saved = globalThis.AudioContext
  try {
    delete globalThis.AudioContext
    assert.equal(plugin.playCue('turn'), false)
  } finally {
    globalThis.AudioContext = saved
  }
  assert.equal(oscillators.length, 0)
})

test('首次手势解锁音频并申请通知权限（只申请一次）', () => {
  reset()
  FakeNotification.permission = 'default'
  // 没有手势前浏览器把 AudioContext 挂在 suspended，手势里必须 resume 一次。
  FakeAudioContext.initialState = 'suspended'
  mount()
  const gesture = windowListeners.get('pointerdown')[0]
  gesture()

  assert.equal(FakeAudioContext.instances.length, 1)
  assert.equal(FakeAudioContext.instances[0].state, 'running')
  assert.equal(FakeAudioContext.instances[0].resumes, 1)
  assert.equal(FakeNotification.requested, 1)

  // 再点一次不重复申请权限。
  gesture()
  assert.equal(FakeNotification.requested, 1)
})

test('通知权限被明确拒绝时不弹（声音仍走页面）', () => {
  reset()
  FakeNotification.permission = 'denied'
  const { plugin } = mount()
  plugin.handle({ title: '本轮完成 · demo', body: '用时 8 秒', sound: 'turn' })
  assert.equal(notifications.length, 0)
  assert.ok(oscillators.length >= 2, '横幅没有，声音不能没有')
})

test('自测计划：10 条、四类轮流、声音类别跟着走', () => {
  const plugin = envelope.factory(() => {})
  const payloads = plugin.buildTestPayloads()
  assert.equal(payloads.length, 10)
  assert.deepEqual(
    payloads.map((payload) => payload.kind),
    ['turn', 'error', 'approval', 'question', 'turn', 'error', 'approval', 'question', 'turn', 'error'],
  )
  assert.equal(payloads[0].title, '【自测 1/10】本轮完成')
  for (const payload of payloads) {
    assert.ok(payload.title.includes('自测'))
    assert.equal(payload.sound, payload.kind)
  }
  assert.equal(plugin.TEST_HASH, '#dsh-notify-test')
})

test('自测每 10 秒一条，10 条后自动停表', () => {
  reset()
  const timers = []
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const originalInfo = console.info
  globalThis.setInterval = (fn, ms) => {
    timers.push({ fn, ms, cleared: false })
    return timers.length
  }
  globalThis.clearInterval = (id) => {
    const timer = timers[id - 1]
    if (timer !== undefined) timer.cleared = true
  }
  console.info = () => {}
  try {
    const plugin = envelope.factory(() => {})
    const stop = plugin.startSelfTest()
    assert.equal(timers.length, 1)
    assert.equal(timers[0].ms, 10_000)
    for (let round = 0; round < 12; round += 1) timers[0].fn()
    assert.equal(notifications.length, 10)
    assert.equal(timers[0].cleared, true)
    stop()
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    console.info = originalInfo
  }
})

test('坏帧与缺标题的帧被丢弃', () => {
  reset()
  const { plugin } = mount()
  assert.equal(plugin.parseFrame('not json'), undefined)
  assert.equal(plugin.parseFrame('null'), undefined)
  plugin.handle(plugin.parseFrame('not json'))
  plugin.handle({ body: '没有标题' })
  assert.equal(notifications.length, 0)
})

console.log(`\n${failed === 0 ? '通过' : '失败'}：${passed} 项通过，${failed} 项失败`)
if (failed > 0) process.exit(1)
