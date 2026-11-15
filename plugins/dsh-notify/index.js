/**
 * dsh-notify —— 会话需要你回来时，发一条系统通知 + 一声提示音。
 *
 * 四类时机，各有各的提示音与可独立开关的开关：
 *   - 等待审批：`approval/request` 瀑布里旁听一句，然后把决定权交回 `next()`；
 *   - 等待回答：`user-questions/request` 同上（`ask_user_question` 之类）；
 *   - 本轮完成：`session/event` 里的 `turn/end`，用 `turn/start` 记的起点算耗时；
 *   - 本轮出错：同上，`turn/end` 的 `reason.kind === 'error'`，单独一类音效，
 *     这样不用看屏幕也知道是「干完了」还是「炸了」。
 *
 * 为什么要「耗时门槛」：宿主看不见你此刻是不是正盯着这个会话，所以用
 * `minTurnSeconds` 当代理——几秒钟就答完的回合不吵你，跑久了的才提醒。
 * 想看每一轮都响，把它设成 0。
 *
 * 通知走系统自带的 `osascript`/`afplay`（见 notifier.js），不依赖页面、
 * 不需要浏览器通知权限，窗口关掉也照样响。
 */

import { basename } from 'node:path'
import { createNotifier } from './notifier.js'

export const name = 'notify'

/**
 * 各时机的默认提示音（macOS 系统提示音名）。
 *
 * 挑的原则是「三秒内能分辨」：完成是清亮的高音，审批是低频声呐，提问是短促的 ping，
 * 出错是经典的系统错误低音。
 */
export const DEFAULT_SOUNDS = Object.freeze({
  /** 本轮正常结束。 */
  turn: 'Glass',
  /** 有工具调用等待审批。 */
  approval: 'Submarine',
  /** 智能体在等你回答问题。 */
  question: 'Ping',
  /** 本轮异常结束。 */
  error: 'Basso',
})

/** 默认值；用户可在 profile 的 patch 里按行 id `notify` 覆盖。 */
export const DEFAULTS = Object.freeze({
  /** 本轮结束（`turn/end`）时提醒。 */
  turnEnd: true,
  /** 有工具调用等待审批时提醒。 */
  approval: true,
  /** 智能体在等你回答问题（`ask_user_question` 等）时提醒。 */
  question: true,
  /** 短于该秒数的回合不提醒；0 表示每轮都提醒。 */
  minTurnSeconds: 15,
  /** 子代理会话是否也提醒（默认只在根会话提醒，否则一次任务会被子代理刷屏）。 */
  includeSubagents: false,
  /** 同一会话内两次提醒的最小间隔（秒）；审批/提问不受限。 */
  dedupeSeconds: 5,
})

/** 四类时机的标题前缀。 */
const LABELS = Object.freeze({
  turn: '本轮完成',
  error: '本轮出错',
  approval: '需要审批',
  question: '等待回答',
})

/** 通知正文的最大长度；macOS 通知本身也会截断，这里先截一次更可控。 */
const MAX_BODY = 180

/**
 * 宿主 → 浏览器半体的 SSE 端点。
 *
 * 为什么要这条通道：macOS 通知横幅上的图标由「谁发出的通知」决定，
 * `osascript` 发出去只会显示脚本编辑器的图标；只有页面里的 `Notification`
 * API 才带 DSH 自己的鲸鱼图标。所以横幅默认交给页面显示，宿主只管声音；
 * 页面没连着（窗口关掉了）时，才退回宿主发系统通知。
 */
export const EVENTS_PATH = '/plugins/dsh-notify/events'

/**
 * 不值得提醒的结束原因：
 * `forked`/`interrupted` 不是「干完活」（前者是 fork 复制历史，后者是崩溃后补写的关闭标记），
 * `aborted` 是你自己按了停止——人就在跟前，不用再响一声。
 */
const QUIET_REASONS = new Set(['aborted', 'forked', 'interrupted'])

/**
 * 归一化用户配置：类型不对就用默认值，不让一行写错的 YAML 让插件起不来。
 *
 * 音效可以按类细调（`sounds.turn` / `sounds.approval` …），也可以用一个
 * `sound` 一刀切覆盖全部四类（`sound: none` 就是只发通知不响）。
 *
 * @param {unknown} raw - `cordis.patch.yml` 里该行的 `config`。
 * @returns {typeof DEFAULTS & {sounds: typeof DEFAULT_SOUNDS}} 完整配置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const seconds = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback)
  const sounds = { ...DEFAULT_SOUNDS }
  const custom = source.sounds
  if (custom !== null && typeof custom === 'object') {
    for (const kind of Object.keys(DEFAULT_SOUNDS)) {
      const value = custom[kind]
      if (typeof value === 'string' && value !== '') sounds[kind] = value
    }
  }
  // 一刀切：写一个 `sound` 就把四类统一成它（含 `none`）。
  if (typeof source.sound === 'string' && source.sound !== '') {
    for (const kind of Object.keys(sounds)) sounds[kind] = source.sound
  }
  return {
    turnEnd: bool(source.turnEnd, DEFAULTS.turnEnd),
    approval: bool(source.approval, DEFAULTS.approval),
    question: bool(source.question, DEFAULTS.question),
    minTurnSeconds: seconds(source.minTurnSeconds, DEFAULTS.minTurnSeconds),
    includeSubagents: bool(source.includeSubagents, DEFAULTS.includeSubagents),
    dedupeSeconds: seconds(source.dedupeSeconds, DEFAULTS.dedupeSeconds),
    sounds,
  }
}

/**
 * 把毫秒时长写成中文口语形式。
 *
 * @param {number} ms - 时长。
 * @returns {string} 例如 `8 秒`、`3 分 20 秒`。
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`
}

/**
 * 按码点截断，避免把 emoji 劈成半个。
 *
 * @param {string} text - 原文。
 * @param {number} limit - 最大码点数。
 * @returns {string} 截断后的文本（超长时补省略号）。
 */
export function truncate(text, limit) {
  const value = typeof text === 'string' ? text.trim() : ''
  const points = [...value]
  return points.length <= limit ? value : `${points.slice(0, limit - 1).join('')}…`
}

/**
 * 描述一次 `turn/end`：属于哪一类提醒、正文写什么。
 *
 * @param {unknown} reason - `turn/end` 的 `reason`（`{ kind, ... }`）。
 * @param {number|undefined} elapsedMs - 本轮耗时；没记到起点时为 `undefined`。
 * @returns {{kind: 'turn'|'error', body: string}|undefined} 不值得提醒的结束原因返回 `undefined`。
 */
export function describeTurnEnd(reason, elapsedMs) {
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
  if (QUIET_REASONS.has(kind)) return undefined
  const spent = elapsedMs === undefined ? '' : `用时 ${formatDuration(elapsedMs)}`
  const withSpent = (prefix, separator) => (spent === '' ? prefix : `${prefix}${separator}${spent}`)
  if (kind === 'error') {
    const message = truncate(reason?.error?.message, 100)
    return { kind: 'error', body: message === '' ? withSpent('出错', ' · ') : `出错：${message}` }
  }
  switch (kind) {
    case 'blocked':
      return { kind: 'turn', body: withSpent('受阻', ' · ') }
    case 'max-tokens':
      return { kind: 'turn', body: withSpent('达到输出上限', ' · ') }
    default:
      return { kind: 'turn', body: spent === '' ? '本轮已结束' : spent }
  }
}

/**
 * 描述一次审批请求的通知正文。
 *
 * @param {object} request - `approval/request` 的载荷。
 * @returns {string} 正文。
 */
export function describeApproval(request) {
  const tool = typeof request?.toolName === 'string' && request.toolName !== '' ? request.toolName : '工具调用'
  const reason = truncate(request?.reason, 100)
  return reason === '' ? `${tool} 等待你的决定` : `${tool} 等待你的决定：${reason}`
}

/**
 * 描述一次等待回答的通知正文。
 *
 * @param {object} request - `user-questions/request` 的载荷。
 * @returns {string} 正文。
 */
export function describeQuestion(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const first = truncate(questions[0]?.question, 120)
  const head = first === '' ? '有提问等待你的回答' : first
  return questions.length > 1 ? `${head}（共 ${questions.length} 个问题）` : head
}

/**
 * 取会话标题：优先用户/模型生成的标题，其次工作目录名，最后兜底文案。
 *
 * @param {object} ctx - 宿主上下文（用来找可选的 `sessionTitle` 服务）。
 * @param {object} session - 会话对象。
 * @returns {string} 通知标题里的会话名。
 */
export function sessionTitle(ctx, session) {
  try {
    const title = ctx?.get?.('sessionTitle')?.get?.(session)?.title
    if (typeof title === 'string' && title.trim() !== '') return title.trim()
  } catch {
    /* 标题服务缺失或未就绪时静默降级 */
  }
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return basename(cwd)
  return 'DSH 会话'
}

/**
 * 插件入口：装配真实通知 sink 后启动。
 *
 * 注意：这里不能把 {@link start} 的返回值交回去——Cordis 把插件回调的返回
 * 值当作 effect 处理，返回一个普通对象会报 `Invalid effect`，整条 entry 不激活。
 *
 * @param {object} ctx - 宿主 Cordis 上下文。
 * @param {object} [rawConfig] - 该行的 `config`。
 */
export function apply(ctx, rawConfig = {}) {
  start(ctx, normalizeConfig(rawConfig), createNotifier({ logger: ctx?.logger }))
}

/**
 * 真正的接线逻辑；`notifier` 由参数注入，自测时换成假的。
 *
 * @param {object} ctx - 宿主 Cordis 上下文（只用到 `on`/`effect`/`get`/`logger`）。
 * @param {object} config - {@link normalizeConfig} 的结果。
 * @param {{notify: Function}} notifier - 通知 sink。
 * @returns {object} 采集到的 disposer 与内部状态，便于自测断言。
 */
export function start(ctx, config, notifier) {
  const turnStartedAt = new Map()
  const lastNotifiedAt = new Map()

  const isSubagent = (session) => session?.header?.origin === 'subagent'
  const allowed = (session) => config.includeSubagents || !isSubagent(session)

  /** 已连上的浏览器半体（SSE 连接）；有连接就让页面弹横幅（带 DSH 图标）。 */
  const clients = new Set()

  /**
   * 往所有页面连接推一条横幅帧；写失败就当作该连接已死。
   * @param {{title: string, body: string, kind: string}} payload - 横幅内容。
   */
  const publish = (payload) => {
    const line = `data: ${JSON.stringify(payload)}\n\n`
    for (const res of clients) {
      try {
        res.write(line)
      } catch {
        clients.delete(res)
      }
    }
  }

  const send = (session, kind, body) => {
    const title = `${LABELS[kind]} · ${sessionTitle(ctx, session)}`
    const text = truncate(body, MAX_BODY)
    const sound = config.sounds?.[kind] ?? DEFAULT_SOUNDS[kind]
    try {
      // 提示音永远由宿主放：页面拿不到 /System/Library/Sounds，且宿主放音
      // 不受标签页节流影响。
      notifier.play?.(sound)
      if (clients.size > 0) publish({ title, body: text, kind })
      else notifier.post?.({ title, body: text })
    } catch (error) {
      try {
        ctx?.logger?.warn?.('dsh-notify: %s', error?.message ?? String(error))
      } catch {
        /* 通知链路的失败到此为止 */
      }
    }
  }

  const onSessionEvent = (session, event) => {
    if (session === undefined || event === undefined) return
    if (event.type === 'turn/start') {
      turnStartedAt.set(session, Date.now())
      return
    }
    if (event.type !== 'turn/end') return
    const startedAt = turnStartedAt.get(session)
    turnStartedAt.delete(session)
    if (!config.turnEnd || !allowed(session)) return
    const elapsed = startedAt === undefined ? undefined : Date.now() - startedAt
    // 耗时门槛：短回合多半是你正在看的那一轮，不吵。
    if (elapsed !== undefined && elapsed < config.minTurnSeconds * 1000) return
    const described = describeTurnEnd(event.data?.reason, elapsed)
    if (described === undefined) return
    const previous = lastNotifiedAt.get(session) ?? 0
    if (Date.now() - previous < config.dedupeSeconds * 1000) return
    lastNotifiedAt.set(session, Date.now())
    send(session, described.kind, described.body)
  }

  const onApproval = (request, next) => {
    try {
      if (config.approval) {
        const session = request?.agent?.session
        if (session === undefined || allowed(session)) send(session, 'approval', describeApproval(request))
      }
    } catch {
      /* 旁听不能影响审批链路 */
    }
    // 我们只旁听，不参与决策：决定权原样交回后面的 answerer。
    return next()
  }

  const onQuestion = (request, next) => {
    try {
      if (config.question) {
        const session = request?.agent?.session
        if (session === undefined || allowed(session)) send(session, 'question', describeQuestion(request))
      }
    } catch {
      /* 同上 */
    }
    return next()
  }

  const onDisposed = (session) => {
    turnStartedAt.delete(session)
    lastNotifiedAt.delete(session)
  }

  const disposeAll = [
    ctx.on('session/event', onSessionEvent, { global: true }),
    ctx.on('session/disposed', onDisposed, { global: true }),
    ctx.on('approval/request', onApproval, { global: true }),
    ctx.on('user-questions/request', onQuestion, { global: true }),
  ]

  // --- 宿主 → 页面的 SSE 通道 ---------------------------------------------
  /** 把横幅通道挂到 web 服务器的路由表上；失败只是退回宿主通知。 */
  const registerBannerRoute = (webServer) => {
    if (typeof webServer?.register !== 'function') return undefined
    try {
      return webServer.register({
        kind: 'exact',
        path: EVENTS_PATH,
        handler: (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405)
            response.end()
            return
          }
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          // 注释行让页面 EventSource 立刻进入 open 状态，也让宿主立刻记下这条连接。
          response.write(': connected\n\n')
          clients.add(response)
          response.on?.('close', () => { clients.delete(response) })
        },
      })
    } catch (error) {
      try {
        ctx?.logger?.warn?.('dsh-notify: %s', error?.message ?? String(error))
      } catch {
        /* 路由注册失败就退回宿主通知 */
      }
      return undefined
    }
  }

  let disposeRoute
  if (typeof ctx.inject === 'function') {
    // webServer 可能比本插件晚挂载：`ctx.inject` 等到它出现再注册，web 层卸载时
    // 路由随子 fiber 一起收掉。纯 headless 部署里这段永远不跑，横幅走宿主通知。
    ctx.inject(['webServer'], (scope) => {
      scope.effect(() => {
        const dispose = registerBannerRoute(scope.webServer)
        return () => { dispose?.() }
      }, 'dsh-notify: banner route')
    })
  } else {
    let webServer
    try {
      webServer = ctx.get?.('webServer')
    } catch {
      webServer = undefined
    }
    disposeRoute = registerBannerRoute(webServer)
  }

  ctx.effect(() => () => {
    turnStartedAt.clear()
    lastNotifiedAt.clear()
    disposeRoute?.()
    for (const res of clients) {
      try {
        res.end?.()
      } catch {
        /* 连接已经断了就算了 */
      }
    }
    clients.clear()
  }, 'dsh-notify: 计时、去重表与页面连接')

  return { disposeAll, turnStartedAt, lastNotifiedAt, clients, disposeRoute }
}

export default { name, apply }
