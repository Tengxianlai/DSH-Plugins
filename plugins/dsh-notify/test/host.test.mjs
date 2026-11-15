/**
 * dsh-notify 自测：全部在假 ctx / 假 notifier / 假 spawn 上跑，不弹通知、不放音。
 *
 * 跑法：node test/host.test.mjs（仓根 `npm run verify` 会带上）
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_SOUNDS,
  DEFAULTS,
  EVENTS_PATH,
  apply,
  describeApproval,
  describeQuestion,
  describeTurnEnd,
  formatDuration,
  isMuted,
  normalizeConfig,
  sessionTitle,
  soundRoute,
  start,
  truncate,
} from '../index.js'
import {
  WSL_SOUNDS,
  createNotifier,
  detectWsl,
  encodePowerShell,
  notificationArgs,
  powershellArgs,
  resolveSound,
  resolveWindowsPowerShell,
  windowsSoundPath,
  windowsSoundScript,
  windowsToastScript,
} from '../notifier.js'

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

/** 假宿主上下文：记录监听器，effect 立即执行并收集清理函数。 */
function createCtx({ title } = {}) {
  const handlers = new Map()
  const cleanups = []
  const routes = []
  return {
    handlers,
    cleanups,
    routes,
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(factory) {
      cleanups.push(factory())
      return () => {}
    },
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => {
              const index = routes.indexOf(route)
              if (index >= 0) routes.splice(index, 1)
            }
          },
        }
      }
      if (name !== 'sessionTitle') return undefined
      return { get: () => (title === undefined ? undefined : { title }) }
    },
    logger: {
      warnings: [],
      warn(format, message) {
        this.warnings.push({ format, message })
      },
    },
  }
}

/** 假通知 sink：横幅（post）与音效（play）分开记录。 */
function createSink() {
  return {
    calls: [],
    sounds: [],
    play(sound) {
      this.sounds.push(sound)
    },
    post(event) {
      this.calls.push(event)
    },
  }
}

/** 派发一个 emit 事件的所有监听器。 */
const emit = (ctx, event, ...args) => (ctx.handlers.get(event) ?? []).map((fn) => fn(...args))

/** 在「时间已过 offset 毫秒」的时钟下执行，用来伪造回合耗时。 */
function atTime(offset, run) {
  const real = Date.now
  Date.now = () => real() + offset
  try {
    return run()
  } finally {
    Date.now = real
  }
}

const rootSession = (cwd = '/Users/someone/Projects/demo') => ({ header: { cwd } })
const subagentSession = () => ({ header: { cwd: '/Users/someone/Projects/demo', origin: 'subagent' } })

/**
 * 装配一套「插件 + 假 ctx + 假 sink」。
 * @param {object} [overrides] - 配置覆盖项。
 * @param {object} [options] - `title` 控制会话标题服务，`platform` 控制声音路由。
 */
function boot(overrides = {}, options = {}) {
  const ctx = createCtx(options)
  const sink = createSink()
  const config = normalizeConfig({ ...DEFAULTS, ...overrides })
  const api = start(ctx, config, sink, { platform: options.platform ?? 'linux' })
  return { ctx, sink, config, api }
}

console.log('dsh-notify')

test('配置默认值与非法值回落到默认', () => {
  const fallback = { ...DEFAULTS, sounds: { ...DEFAULT_SOUNDS } }
  assert.deepEqual(normalizeConfig(undefined), fallback)
  assert.deepEqual(normalizeConfig(null), fallback)
  assert.deepEqual(normalizeConfig('oops'), fallback)
  const custom = normalizeConfig({
    turnEnd: false,
    sound: 'Ping',
    minTurnSeconds: 0,
    includeSubagents: true,
    dedupeSeconds: 1,
    soundChannel: 'page',
  })
  assert.equal(custom.turnEnd, false)
  assert.deepEqual(custom.sounds, {
    turn: 'Ping',
    approval: 'Ping',
    question: 'Ping',
    error: 'Ping',
  })
  assert.equal(custom.minTurnSeconds, 0)
  assert.equal(custom.includeSubagents, true)
  assert.equal(custom.dedupeSeconds, 1)
  assert.equal(custom.soundChannel, 'page')
  const broken = normalizeConfig({
    approval: 'yes',
    sound: '',
    minTurnSeconds: -3,
    dedupeSeconds: Number.NaN,
    soundChannel: 'speaker',
  })
  assert.equal(broken.approval, DEFAULTS.approval)
  assert.deepEqual(broken.sounds, DEFAULT_SOUNDS)
  assert.equal(broken.minTurnSeconds, DEFAULTS.minTurnSeconds)
  assert.equal(broken.dedupeSeconds, DEFAULTS.dedupeSeconds)
  assert.equal(broken.soundChannel, 'auto')
})

test('声音路由：页面优先，macOS + auto 保留宿主原生提示音', () => {
  const auto = { soundChannel: 'auto', pageConnected: true }
  assert.equal(soundRoute({ ...auto, platform: 'linux' }), 'page')
  assert.equal(soundRoute({ ...auto, platform: 'darwin' }), 'host')
  assert.equal(soundRoute({ ...auto, platform: 'linux', pageConnected: false }), 'host')
  assert.equal(soundRoute({ soundChannel: 'page', pageConnected: true, platform: 'darwin' }), 'page')
  assert.equal(soundRoute({ soundChannel: 'page', pageConnected: false, platform: 'linux' }), 'host')
  assert.equal(soundRoute({ soundChannel: 'host', pageConnected: true, platform: 'linux' }), 'host')
})

test('静音判定认 none 与空串', () => {
  assert.equal(isMuted('none'), true)
  assert.equal(isMuted(''), true)
  assert.equal(isMuted(undefined), true)
  assert.equal(isMuted('Glass'), false)
  assert.equal(isMuted('/tmp/ding.wav'), false)
})

test('时长格式化', () => {
  assert.equal(formatDuration(0), '0 秒')
  assert.equal(formatDuration(8_400), '8 秒')
  assert.equal(formatDuration(199_000), '3 分 19 秒')
  assert.equal(formatDuration(180_000), '3 分钟')
})

test('截断按码点走，不劈开 emoji', () => {
  assert.equal(truncate('short', 10), 'short')
  assert.equal(truncate('  padded  ', 10), 'padded')
  const cut = truncate('🎉🎉🎉🎉', 3)
  assert.equal([...cut].length, 3)
  assert.equal(cut, '🎉🎉…')
})

test('回合结束的正文按原因分档', () => {
  assert.deepEqual(describeTurnEnd({ kind: 'completed' }, 8_000), { kind: 'turn', body: '用时 8 秒' })
  assert.deepEqual(describeTurnEnd({ kind: 'blocked' }, 8_000), { kind: 'turn', body: '受阻 · 用时 8 秒' })
  assert.deepEqual(describeTurnEnd({ kind: 'max-tokens' }, 8_000), { kind: 'turn', body: '达到输出上限 · 用时 8 秒' })
  assert.equal(describeTurnEnd({ kind: 'aborted' }, 8_000), undefined)
  assert.equal(describeTurnEnd({ kind: 'forked' }, 8_000), undefined)
  assert.equal(describeTurnEnd({ kind: 'interrupted' }, 8_000), undefined)
  assert.deepEqual(describeTurnEnd({ kind: 'completed' }, undefined), { kind: 'turn', body: '本轮已结束' })
  assert.deepEqual(describeTurnEnd(undefined, 8_000), { kind: 'turn', body: '用时 8 秒' })
})

test('审批与提问的正文带上关键信息', () => {
  assert.equal(describeApproval({ toolName: 'bash' }), 'bash 等待你的决定')
  assert.equal(describeApproval({ toolName: 'bash', reason: '需要写沙箱外文件' }), 'bash 等待你的决定：需要写沙箱外文件')
  assert.equal(describeApproval({}), '工具调用 等待你的决定')
  assert.equal(describeQuestion({ questions: [{ question: '选哪个方案？' }] }), '选哪个方案？')
  assert.equal(
    describeQuestion({ questions: [{ question: 'A?' }, { question: 'B?' }] }),
    'A?（共 2 个问题）',
  )
  assert.equal(describeQuestion({}), '有提问等待你的回答')
})

test('会话标题：标题服务优先，其次工作目录名', () => {
  const session = rootSession()
  assert.equal(sessionTitle({ get: () => ({ get: () => ({ title: '修登录重试' }) }) }, session), '修登录重试')
  assert.equal(sessionTitle({ get: () => undefined }, session), 'demo')
  assert.equal(sessionTitle({ get: () => ({ get: () => { throw new Error('boom') } }) }, session), 'demo')
  assert.equal(sessionTitle({}, { header: {} }), 'DSH 会话')
})

test('长回合结束会通知，标题带会话名，正文带耗时', () => {
  const { ctx, sink } = boot({ minTurnSeconds: 15 }, { title: '修登录重试' })
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(20_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  assert.equal(sink.calls.length, 1)
  assert.equal(sink.calls[0].title, '本轮完成 · 修登录重试')
  assert.equal(sink.calls[0].body, '用时 20 秒')
  assert.equal(sink.sounds[0], DEFAULT_SOUNDS.turn)
})

test('短回合按门槛静音', () => {
  const { ctx, sink } = boot({ minTurnSeconds: 15 })
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(5_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  assert.equal(sink.calls.length, 0)
})

test('门槛 0 时每轮都提醒；fork 复制历史不算干完活', () => {
  const { ctx, sink } = boot({ minTurnSeconds: 0 })
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(1_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'forked' } } }))
  assert.equal(sink.calls.length, 0)
  atTime(2_000, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 2 } }))
  atTime(3_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }))
  assert.equal(sink.calls.length, 1)
})

test('同一会话内的连续提醒会被去重', () => {
  const { ctx, sink } = boot({ minTurnSeconds: 0, dedupeSeconds: 5 })
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(1_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  atTime(2_000, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 2 } }))
  atTime(3_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }))
  assert.equal(sink.calls.length, 1)
})

test('审批旁听会通知，并把决定权原样交回 next()', () => {
  const { ctx, sink } = boot({}, { title: '修登录重试' })
  const session = rootSession()
  const request = { agent: { session }, toolName: 'bash', reason: '写沙箱外文件' }
  let delegated = 0
  const results = emit(ctx, 'approval/request', request, () => {
    delegated += 1
    return Promise.resolve('allowed-once')
  })
  assert.equal(delegated, 1)
  assert.equal(results.length, 1)
  assert.equal(sink.calls.length, 1)
  assert.equal(sink.calls[0].title, '需要审批 · 修登录重试')
  assert.equal(sink.calls[0].body, 'bash 等待你的决定：写沙箱外文件')
})

test('旁听自身出错也不影响审批链路', () => {
  const { ctx } = boot()
  // 造一个让取标题/通知必然抛错的 sink。
  const exploding = {
    play() {
      throw new Error('spawn exploded')
    },
  }
  const local = start(ctx, normalizeConfig(DEFAULTS), exploding)
  assert.ok(local)
  const request = { agent: { session: rootSession() }, toolName: 'bash' }
  const failing = createCtx()
  const sink = { play() { throw new Error('nope') } }
  start(failing, normalizeConfig(DEFAULTS), sink)
  let delegated = 0
  emit(failing, 'approval/request', request, () => {
    delegated += 1
    return Promise.resolve('allowed-once')
  })
  assert.equal(delegated, 1)
  assert.ok(failing.logger.warnings.length >= 1)
})

test('提问通知带问题数', () => {
  const { ctx, sink } = boot()
  emit(ctx, 'user-questions/request', {
    agent: { session: rootSession() },
    questions: [{ question: '用 pnpm 还是 npm？' }, { question: '要不要跑测试？' }],
  }, () => Promise.resolve({ answers: [] }))
  assert.equal(sink.calls.length, 1)
  assert.equal(sink.calls[0].title, '等待回答 · demo')
  assert.equal(sink.calls[0].body, '用 pnpm 还是 npm？（共 2 个问题）')
})

test('子代理会话默认静音，includeSubagents 打开后才提醒', () => {
  const quiet = boot({ minTurnSeconds: 0 })
  const child = subagentSession()
  atTime(0, () => emit(quiet.ctx, 'session/event', child, { type: 'turn/start', data: { turn: 1 } }))
  atTime(1_000, () => emit(quiet.ctx, 'session/event', child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  assert.equal(quiet.sink.calls.length, 0)

  const loud = boot({ minTurnSeconds: 0, includeSubagents: true })
  atTime(0, () => emit(loud.ctx, 'session/event', child, { type: 'turn/start', data: { turn: 1 } }))
  atTime(1_000, () => emit(loud.ctx, 'session/event', child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  assert.equal(loud.sink.calls.length, 1)
})

test('各自开关独立生效', () => {
  const { ctx, sink } = boot({ turnEnd: false, approval: false, question: false, minTurnSeconds: 0 })
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(1_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  emit(ctx, 'approval/request', { agent: { session }, toolName: 'bash' }, () => Promise.resolve('rejected'))
  emit(ctx, 'user-questions/request', { agent: { session }, questions: [{ question: '?' }] }, () => Promise.resolve({ answers: [] }))
  assert.equal(sink.calls.length, 0)
})

test('提示音配置透传给 sink；会话销毁后计时表被清空', () => {
  const { ctx, sink, api } = boot({ sound: 'Ping', minTurnSeconds: 0 })
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  assert.equal(api.turnStartedAt.size, 1)
  atTime(1_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  assert.equal(sink.sounds[0], 'Ping')
  atTime(2_000, () => emit(ctx, 'session/disposed', session))
  assert.equal(api.turnStartedAt.size, 0)
  assert.equal(api.lastNotifiedAt.size, 0)
})

test('卸载后不再有监听器', () => {
  const { ctx, sink, api } = boot({ minTurnSeconds: 0 })
  for (const dispose of api.disposeAll) dispose()
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(1_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  assert.equal(sink.calls.length, 0)
})

test('提示音解析：系统音名 / 绝对路径 / none / 非 macOS', () => {
  assert.equal(resolveSound('Glass', 'darwin'), '/System/Library/Sounds/Glass.aiff')
  assert.equal(resolveSound('Glass.aiff', 'darwin'), '/System/Library/Sounds/Glass.aiff')
  assert.equal(resolveSound('/tmp/ding.wav', 'darwin'), '/tmp/ding.wav')
  assert.equal(resolveSound('none', 'darwin'), undefined)
  assert.equal(resolveSound('', 'darwin'), undefined)
  assert.equal(resolveSound(undefined, 'darwin'), undefined)
  assert.equal(resolveSound('Glass', 'linux'), undefined)
  assert.equal(resolveSound('/tmp/ding.wav', 'linux'), '/tmp/ding.wav')
})

test('osascript 参数：正文/标题各占一个 argv，不拼进脚本', () => {
  const args = notificationArgs('DSH 标题', '正文 "引号" \\ 反斜杠')
  assert.ok(args.includes('on run argv'))
  assert.deepEqual(args.slice(-3), ['--', '正文 "引号" \\ 反斜杠', 'DSH 标题'])
  const withSubtitle = notificationArgs('T', 'B', 'S')
  assert.deepEqual(withSubtitle.slice(-4), ['--', 'B', 'T', 'S'])
})

test('macOS 上先发通知再放提示音；none 时只发通知', () => {
  const spawned = []
  const spawn = (command, args) => {
    spawned.push({ command, args })
    return { on() {}, unref() {} }
  }
  const notifier = createNotifier({ platform: 'darwin', spawn })
  notifier.notify({ title: 'T', body: 'B', sound: 'Glass' })
  assert.equal(spawned.length, 2)
  assert.equal(spawned[0].command, '/usr/bin/osascript')
  assert.equal(spawned[1].command, '/usr/bin/afplay')
  assert.deepEqual(spawned[1].args, ['/System/Library/Sounds/Glass.aiff'])

  spawned.length = 0
  notifier.notify({ title: 'T', body: 'B', sound: 'none' })
  assert.equal(spawned.length, 1)
})

/** 解开 `-EncodedCommand` 的 base64（UTF-16LE），断言用的是 PowerShell 自己的转义。 */
const decodePowerShell = (args) => {
  assert.equal(args.at(-2), '-EncodedCommand')
  return Buffer.from(args.at(-1), 'base64').toString('utf16le')
}

test('WSL 探测：环境变量、/proc/version、非 linux 都不误判', () => {
  assert.equal(detectWsl({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), true)
  assert.equal(
    detectWsl({ platform: 'linux', env: {}, readFile: () => 'Linux version 5.15 microsoft-standard-WSL2' }),
    true,
  )
  assert.equal(detectWsl({ platform: 'linux', env: {}, readFile: () => 'Linux version 6.1.0 arch' }), false)
  assert.equal(detectWsl({ platform: 'darwin', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), false)
  assert.equal(
    detectWsl({
      platform: 'linux',
      env: {},
      readFile: () => {
        throw new Error('ENOENT')
      },
    }),
    false,
  )
})

test('WSL 提示音按类别映射到 Windows 系统 wav，静音与自定义路径不硬映射', () => {
  assert.equal(windowsSoundPath('Glass', 'turn'), 'C:\\Windows\\Media\\chimes.wav')
  assert.equal(windowsSoundPath('Basso', 'error'), 'C:\\Windows\\Media\\Windows Critical Stop.wav')
  assert.equal(windowsSoundPath('Submarine', 'approval'), 'C:\\Windows\\Media\\Windows Ding.wav')
  assert.equal(windowsSoundPath('Ping', 'question'), 'C:\\Windows\\Media\\Windows Balloon.wav')
  assert.equal(windowsSoundPath('Glass', '没见过的类别'), 'C:\\Windows\\Media\\chimes.wav')
  assert.equal(windowsSoundPath('none', 'turn'), undefined)
  assert.equal(windowsSoundPath('', 'turn'), undefined)
  assert.equal(windowsSoundPath('/tmp/ding.wav', 'turn'), undefined)
  assert.equal(Object.keys(WSL_SOUNDS).length, 4)
})

test('PowerShell 脚本：编码可还原，标题/正文不进脚本文本', () => {
  assert.equal(Buffer.from(encodePowerShell('Write-Output 1'), 'base64').toString('utf16le'), 'Write-Output 1')
  const title = `本轮 "完成" 'x' $env:PATH`
  const body = '正文\n换行 & 符号'
  const script = windowsToastScript(title, body)
  assert.ok(script.includes('ToastNotificationManager'))
  assert.ok(script.includes(Buffer.from(title, 'utf8').toString('base64')))
  assert.ok(!script.includes('本轮'), '标题不应该以明文进脚本')
  const sound = decodePowerShell(powershellArgs(windowsSoundScript(windowsSoundPath('Glass', 'error'))))
  assert.ok(sound.includes('Windows Critical Stop.wav'))
  assert.ok(sound.includes('PlaySync'))
})

test('WSL 宿主：放音与 Toast 都经 powershell.exe，互操作参数正确', () => {
  const spawned = []
  const spawn = (command, args) => {
    spawned.push({ command, args })
    return { on() {}, unref() {} }
  }
  const notifier = createNotifier({
    platform: 'linux',
    wsl: true,
    powershell: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    spawn,
  })
  assert.equal(notifier.wsl, true)

  notifier.play('Glass', 'error')
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].command, '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
  assert.ok(decodePowerShell(spawned[0].args).includes('Windows Critical Stop.wav'))

  spawned.length = 0
  notifier.post({ title: '需要审批 · demo', body: 'bash 等待你的决定' })
  assert.equal(spawned.length, 1)
  assert.ok(decodePowerShell(spawned[0].args).includes('ToastNotificationManager'))

  spawned.length = 0
  notifier.play('none', 'turn')
  assert.equal(spawned.length, 0, 'none 不启动进程')
})

test('WSL 自定义绝对路径只 warn 一次（请把声音交给页面）', () => {
  const warnings = []
  const spawned = []
  const notifier = createNotifier({
    platform: 'linux',
    wsl: true,
    powershell: 'powershell.exe',
    spawn: (command, args) => {
      spawned.push({ command, args })
      return { on() {}, unref() {} }
    },
    logger: { warn: (format, message) => warnings.push(message) },
  })
  notifier.play('/tmp/ding.wav', 'turn')
  notifier.play('/tmp/ding.wav', 'turn')
  assert.equal(spawned.length, 0)
  assert.equal(warnings.length, 1)
})

test('powershell.exe 优先走已挂载的绝对路径，找不到再交给 PATH', () => {
  assert.equal(
    resolveWindowsPowerShell({ exists: () => true }),
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  )
  assert.equal(resolveWindowsPowerShell({ exists: () => false }), 'powershell.exe')
})

test('不支持的系统 / 启动失败只 warn 一次，不抛错', () => {
  const warnings = []
  const logger = { warn: (format, message) => warnings.push(message) }
  const windows = createNotifier({ platform: 'win32', spawn: () => ({ on() {}, unref() {} }), logger })
  windows.notify({ title: 'T', body: 'B', sound: 'none' })
  windows.notify({ title: 'T', body: 'B', sound: 'none' })
  assert.equal(warnings.length, 1)

  const throwing = createNotifier({
    platform: 'darwin',
    spawn: () => {
      throw new Error('ENOENT')
    },
    logger,
  })
  throwing.notify({ title: 'T', body: 'B', sound: 'none' })
  assert.equal(warnings.length, 2)
})

test('四类时机默认四种不同的提示音', () => {
  const distinct = new Set(Object.values(DEFAULT_SOUNDS))
  assert.equal(distinct.size, 4)
  assert.equal(DEFAULT_SOUNDS.turn, 'Glass')
  assert.equal(DEFAULT_SOUNDS.approval, 'Submarine')
  assert.equal(DEFAULT_SOUNDS.question, 'Ping')
  assert.equal(DEFAULT_SOUNDS.error, 'Basso')
})

test('异常结束单独成类：标题「本轮出错」，音效用 error 那一档', () => {
  const { ctx, sink } = boot({ minTurnSeconds: 0 }, { title: '修登录重试' })
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(30_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'provider 500' } } } }))
  assert.equal(sink.calls.length, 1)
  assert.equal(sink.calls[0].title, '本轮出错 · 修登录重试')
  assert.equal(sink.calls[0].body, '出错：provider 500')
  assert.equal(sink.sounds[0], DEFAULT_SOUNDS.error)
})

test('三类提醒各自带自己的音效', () => {
  const { ctx, sink } = boot({ minTurnSeconds: 0 })
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(30_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  emit(ctx, 'approval/request', { agent: { session }, toolName: 'bash' }, () => Promise.resolve('allowed-once'))
  emit(ctx, 'user-questions/request', { agent: { session }, questions: [{ question: '选哪个？' }] }, () => Promise.resolve({ answers: [] }))
  assert.deepEqual(sink.sounds, [
    DEFAULT_SOUNDS.turn,
    DEFAULT_SOUNDS.approval,
    DEFAULT_SOUNDS.question,
  ])
  assert.deepEqual(sink.calls.map((call) => call.title.split(' · ')[0]), ['本轮完成', '需要审批', '等待回答'])
})

test('只改某一类音效，其余保持默认', () => {
  const { ctx, sink } = boot({ minTurnSeconds: 0, sounds: { approval: 'Hero' } })
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(30_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  emit(ctx, 'approval/request', { agent: { session }, toolName: 'bash' }, () => Promise.resolve('rejected'))
  assert.deepEqual(sink.sounds, [DEFAULT_SOUNDS.turn, 'Hero'])
})

test('sound 一刀切（含 none）覆盖四类', () => {
  const { ctx, sink } = boot({ minTurnSeconds: 0, sound: 'none' })
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(30_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } }))
  emit(ctx, 'approval/request', { agent: { session }, toolName: 'bash' }, () => Promise.resolve('rejected'))
  assert.deepEqual(sink.sounds, ['none', 'none'])
})

test('插件入口不把返回值交给 Cordis（普通对象会被当成非法 effect）', () => {
  const ctx = createCtx()
  assert.equal(apply(ctx, { sound: 'none', minTurnSeconds: 0 }), undefined)
  // 四类监听器 + 一条 SSE 路由都挂上了，且没有真的 spawn 任何东西（用例里没有触发事件）。
  assert.deepEqual([...ctx.handlers.keys()].sort(), [
    'approval/request',
    'session/disposed',
    'session/event',
    'user-questions/request',
  ])
  assert.equal(ctx.cleanups.length, 1)
})

test('浏览器半体连着时：横幅走页面，声音也交给页面（Linux 宿主）', () => {
  const { ctx, sink, api } = boot({ minTurnSeconds: 0 }, { platform: 'linux' })
  assert.equal(ctx.routes.length, 1)
  assert.equal(ctx.routes[0].path, EVENTS_PATH)
  assert.equal(ctx.routes[0].kind, 'exact')

  const written = []
  const closes = []
  const res = {
    writeHead(status) { this.status = status },
    write(chunk) { written.push(chunk) },
    on(event, handler) { if (event === 'close') closes.push(handler) },
    end() {},
  }
  ctx.routes[0].handler({ method: 'GET' }, res)
  assert.equal(res.status, 200)
  assert.equal(api.clients.size, 1)
  assert.ok(written[0].startsWith(': connected'), '连上先写一行注释帧')

  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(30_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))

  // 宿主不发声也不发系统通知；横幅帧里带 sound，页面自己放。
  assert.deepEqual(sink.sounds, [])
  assert.equal(sink.calls.length, 0)
  const frame = written.at(-1)
  assert.ok(frame.startsWith('data: '))
  const payload = JSON.parse(frame.slice('data: '.length))
  assert.equal(payload.title, '本轮完成 · demo')
  assert.equal(payload.body, '用时 30 秒')
  assert.equal(payload.kind, 'turn')
  assert.equal(payload.sound, 'turn')

  // 页面关掉：声音和横幅都回到宿主。
  for (const close of closes) close()
  assert.equal(api.clients.size, 0)
  atTime(60_000, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 2 } }))
  atTime(90_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }))
  assert.equal(sink.sounds.length, 1)
  assert.equal(sink.calls.length, 1)
  assert.equal(sink.calls[0].title, '本轮完成 · demo')
})

test('macOS 宿主 + auto：页面连着时仍由宿主放原生提示音', () => {
  const { ctx, sink } = boot({ minTurnSeconds: 0 }, { platform: 'darwin' })
  const written = []
  ctx.routes[0].handler(
    { method: 'GET' },
    { writeHead() {}, write(chunk) { written.push(chunk) }, on() {}, end() {} },
  )
  const session = rootSession()
  atTime(0, () => emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(30_000, () => emit(ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  assert.deepEqual(sink.sounds, [DEFAULT_SOUNDS.turn])
  assert.equal(sink.calls.length, 0, '有页面时横幅仍走页面')
  const payload = JSON.parse(written.at(-1).slice('data: '.length))
  assert.equal(payload.sound, undefined, '宿主已经发声，页面不要重复响')
})

test('soundChannel: host 强制宿主发声；sound: none 时页面也不响', () => {
  const host = boot({ minTurnSeconds: 0, soundChannel: 'host' }, { platform: 'linux' })
  const written = []
  host.ctx.routes[0].handler(
    { method: 'GET' },
    { writeHead() {}, write(chunk) { written.push(chunk) }, on() {}, end() {} },
  )
  const session = rootSession()
  atTime(0, () => emit(host.ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(30_000, () => emit(host.ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  assert.deepEqual(host.sink.sounds, [DEFAULT_SOUNDS.turn])
  assert.equal(JSON.parse(written.at(-1).slice('data: '.length)).sound, undefined)

  const muted = boot({ minTurnSeconds: 0, sound: 'none' }, { platform: 'linux' })
  const mutedFrames = []
  muted.ctx.routes[0].handler(
    { method: 'GET' },
    { writeHead() {}, write(chunk) { mutedFrames.push(chunk) }, on() {}, end() {} },
  )
  atTime(0, () => emit(muted.ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } }))
  atTime(30_000, () => emit(muted.ctx, 'session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  assert.deepEqual(muted.sink.sounds, [])
  assert.equal(JSON.parse(mutedFrames.at(-1).slice('data: '.length)).sound, undefined)
})

test('SSE 路由只接受 GET；卸载时路由与连接一起收掉', () => {
  const { ctx, api } = boot({ minTurnSeconds: 0 })
  const res = { writeHead(status) { this.status = status }, write() {}, on() {}, end() {} }
  ctx.routes[0].handler({ method: 'POST' }, res)
  assert.equal(res.status, 405)

  ctx.routes[0].handler({ method: 'GET' }, res)
  assert.equal(api.clients.size, 1)
  for (const cleanup of ctx.cleanups) cleanup()
  assert.equal(api.clients.size, 0)
  assert.equal(ctx.routes.length, 0)
})

console.log(`\n${failed === 0 ? '通过' : '失败'}：${passed} 项通过，${failed} 项失败`)
if (failed > 0) process.exit(1)
