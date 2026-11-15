/* eslint-disable */
/**
 * dsh-notify —— 浏览器半边。
 *
 * 两件事：
 *   1. 接住宿主推来的 SSE 帧，用页面的 `Notification` API 弹系统通知；
 *   2. 帧里带 `sound` 时，用 Web Audio 就地合成一声提示音。
 *
 * 为什么声音在这里放：声音得从**用户面前那台设备**出来。宿主可能跑在 WSL、
 * 容器或远程服务器上，根本没有声卡（WSL 里的 DSH 就是）；而页面一定在用户
 * 的电脑/手机里。所以 `soundChannel: auto` 时，页面连着就由页面发声，宿主
 * 只在没有页面连接时兜底。
 *
 * 用 Web Audio 合成而不是加载音频文件：不用随包带素材、不用额外路由、不受
 * CORS 限制，四类提醒各有固定的音色（见 {@link CUES}）。浏览器要求一次用户
 * 手势才能出声，所以首次点击/按键时顺手解锁 AudioContext。
 *
 * 横幅图标：页面里的 `Notification` 走 DSH 自己的 App 身份，横幅上是那条鲸鱼；
 * 点击横幅把窗口拉回前台。通知本身静音（`silent`），声音由上面那条通道负责。
 *
 * 宿主经 `/plugins/dsh-notify/client.js` 提供本文件，SSE 端点是
 * `/plugins/dsh-notify/events`（与 ../index.js 的 EVENTS_PATH 必须一致）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory: () => {
    const exports = {}

    /** 与宿主 `EVENTS_PATH` 相同的端点；改一处必须改两处，client.test.mjs 会核对。 */
    const EVENTS_PATH = '/plugins/dsh-notify/events'

    /** 通知去重标签：同类提醒只保留最新一条，别在通知中心堆一串。 */
    const TAG = 'dsh-notify'

    /**
     * 四类提醒的合成音色。
     *
     * 每个音是 `{ freq, delay, duration, waveform, volume, glideTo? }`，频率用十二
     * 平均律的绝对赫兹值。挑的原则是「三秒内能分辨」：
     *   - `turn`     A5 → E6 两个上行正弦音，像木琴敲两下（完成）；
     *   - `error`    G4 → C4 两个下行三角波，闷、往下掉（出错）；
     *   - `approval` 640 → 426 Hz 的慢速下滑长音，像声呐（等你点头）；
     *   - `question` C6 → G6 两个短促高音（等你回答）。
     */
    const CUES = {
      turn: [
        { freq: 880, delay: 0, duration: 0.18, waveform: 'sine', volume: 0.16 },
        { freq: 1318.51, delay: 0.12, duration: 0.34, waveform: 'sine', volume: 0.14 },
      ],
      error: [
        { freq: 392, delay: 0, duration: 0.2, waveform: 'triangle', volume: 0.18 },
        { freq: 261.63, delay: 0.22, duration: 0.44, waveform: 'triangle', volume: 0.18 },
      ],
      approval: [
        { freq: 640, delay: 0, duration: 0.9, waveform: 'sine', volume: 0.11, glideTo: 426.67 },
      ],
      question: [
        { freq: 1046.5, delay: 0, duration: 0.14, waveform: 'sine', volume: 0.14 },
        { freq: 1568, delay: 0.16, duration: 0.2, waveform: 'sine', volume: 0.11 },
      ],
    }

    /** 本次页面生命周期里唯一的 AudioContext；第一次需要发声时才创建。 */
    let audio

    /** 通知权限只申请一次，用户拒绝后不再骚扰。 */
    let permissionRequested = false

    /**
     * 取（必要时创建）AudioContext。
     *
     * @returns {AudioContext|undefined} 浏览器不支持 Web Audio 时返回 `undefined`。
     */
    function ensureAudio() {
      if (audio !== undefined) return audio
      const Constructor =
        typeof AudioContext === 'function'
          ? AudioContext
          : typeof webkitAudioContext === 'function'
            ? webkitAudioContext
            : undefined
      if (Constructor === undefined) return undefined
      try {
        audio = new Constructor()
      } catch {
        audio = undefined
      }
      return audio
    }

    /**
     * 在首次用户手势里解锁音频：浏览器只允许手势之后让 AudioContext 进入 running。
     *
     * @returns {boolean} 是否拿到了可用的 AudioContext。
     */
    function unlockAudio() {
      const context = ensureAudio()
      if (context === undefined) return false
      if (context.state === 'running') return true
      try {
        const resumed = context.resume?.()
        if (resumed !== null && typeof resumed?.catch === 'function') resumed.catch(() => {})
      } catch {
        return false
      }
      return true
    }

    /**
     * 申请系统通知权限。
     *
     * 浏览器里 `Notification.permission` 默认是 `'default'`，此时构造通知会抛
     * 异常（被下面的 catch 吞掉），横幅就永远不出现。桌面应用已经预授权，不受影响。
     */
    function requestPermission() {
      if (typeof Notification === 'undefined') return
      if (typeof Notification.requestPermission !== 'function') return
      if (Notification.permission !== 'default' || permissionRequested) return
      permissionRequested = true
      try {
        const result = Notification.requestPermission()
        if (result !== null && typeof result?.catch === 'function') result.catch(() => {})
      } catch {
        /* 老实现走回调，拒绝就算了：声音仍然有 */
      }
    }

    /**
     * 把一条合成音色排进 AudioContext 的时间线。
     *
     * @param {AudioContext} context - 已运行的音频上下文。
     * @param {string} kind - 提醒类别（`turn`/`error`/`approval`/`question`）。
     * @returns {boolean} 是否排上了。
     */
    function scheduleCue(context, kind) {
      const cue = CUES[kind]
      if (cue === undefined) return false
      const origin = context.currentTime + 0.02
      for (const note of cue) {
        const start = origin + (note.delay ?? 0)
        const end = start + (note.duration ?? 0.2)
        const oscillator = context.createOscillator()
        const envelope = context.createGain()
        oscillator.type = note.waveform ?? 'sine'
        oscillator.frequency.setValueAtTime(note.freq, start)
        if (typeof note.glideTo === 'number') {
          oscillator.frequency.exponentialRampToValueAtTime(note.glideTo, end)
        }
        // 指数包络：10ms 起音，随后衰减到听不见。用 0.0001 而不是 0，指数
        // 曲线不能穿过零。
        envelope.gain.setValueAtTime(0.0001, start)
        envelope.gain.exponentialRampToValueAtTime(note.volume ?? 0.14, start + 0.012)
        envelope.gain.exponentialRampToValueAtTime(0.0001, end)
        oscillator.connect(envelope)
        envelope.connect(context.destination)
        oscillator.start(start)
        oscillator.stop(end + 0.05)
      }
      return true
    }

    /**
     * 放一声提示音。
     *
     * 上下文还没跑起来（用户没跟页面交互过）就不排队：排了会在之后某次手势里
     * 一起炸出来。返回 `false` 让调用方退回「让系统通知自己响一声」。
     *
     * @param {string} kind - 提醒类别。
     * @returns {boolean} 是否真的排上了声音。
     */
    function playCue(kind) {
      if (typeof kind !== 'string' || CUES[kind] === undefined) return false
      const context = ensureAudio()
      if (context === undefined) return false
      if (context.state === 'suspended') {
        try {
          const resumed = context.resume?.()
          if (resumed !== null && typeof resumed?.catch === 'function') resumed.catch(() => {})
        } catch {
          return false
        }
      }
      if (context.state !== 'running') return false
      try {
        return scheduleCue(context, kind)
      } catch {
        return false
      }
    }

    /**
     * 弹一条系统通知；点了把窗口拉回前台。
     *
     * @param {object} payload - 宿主推来的 `{ title, body, kind }`。
     * @param {Function} [focus] - 聚焦窗口的动作，自测时注入。
     * @param {object} [options] - 附加选项。
     * @param {boolean} [options.silent] - 是否让通知静音；页面已经放过声就静音，
     *   页面放不出声时留 `false` 让系统通知自己响一声。
     * @returns {Notification|undefined} 构造出来的通知。
     */
    function show(payload, focus = () => { try { window.focus() } catch { /* 浏览器可能不允许 */ } }, { silent = true } = {}) {
      if (typeof Notification === 'undefined') return undefined
      // 'default' 在桌面应用里已经由宿主授权放行；只有明确拒绝才不发。
      if (Notification.permission === 'denied') return undefined
      const title = typeof payload?.title === 'string' ? payload.title : ''
      const body = typeof payload?.body === 'string' ? payload.body : ''
      if (title === '') return undefined
      let notification
      try {
        notification = new Notification(title, { body, silent, tag: TAG })
      } catch {
        // 权限没授予或在不受支持的上下文里构造失败：静默放弃，声音仍在。
        return undefined
      }
      try {
        notification.onclick = () => {
          focus()
          notification.close()
        }
      } catch {
        /* 老实现可能不允许赋值 onclick，横幅本身已经弹出 */
      }
      return notification
    }

    /** 解析一帧 SSE `data`；坏帧直接丢弃。 */
    function parseFrame(data) {
      try {
        const value = JSON.parse(data)
        return value !== null && typeof value === 'object' ? value : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 处理一帧：先发声（如果宿主要求页面发声），再弹通知。
     *
     * @param {object} payload - 解析后的帧。
     * @returns {Notification|undefined} 弹出来的通知。
     */
    function handle(payload) {
      const wantsSound = typeof payload?.sound === 'string' && payload.sound !== ''
      const played = wantsSound ? playCue(payload.sound) : false
      // 页面放不出声（没手势解锁 / 不支持 Web Audio）时，让系统通知自己响一声，
      // 至少不会全静音；静音配置（没有 `sound` 字段）仍然保持静音。
      return show(payload, undefined, { silent: !wantsSound || played })
    }

    /**
     * 客户端插件体：订阅宿主横幅通道，并在首次手势里解锁音频与通知权限。
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      if (typeof EventSource !== 'undefined') {
        ctx.effect(() => {
          const source = new EventSource(EVENTS_PATH)
          const onMessage = (event) => {
            const payload = parseFrame(event.data)
            if (payload === undefined) return
            handle(payload)
          }
          source.addEventListener('message', onMessage)
          return () => {
            source.removeEventListener('message', onMessage)
            source.close()
          }
        }, 'dsh-notify: banner stream')
      }
      if (typeof window === 'object' && window !== null && typeof window.addEventListener === 'function') {
        ctx.effect(() => {
          const onGesture = () => {
            unlockAudio()
            requestPermission()
          }
          const events = ['pointerdown', 'keydown']
          for (const type of events) window.addEventListener(type, onGesture, { passive: true })
          return () => {
            for (const type of events) window.removeEventListener(type, onGesture)
          }
        }, 'dsh-notify: audio unlock & notification permission')
      }
    }

    exports.name = 'notify'
    exports.apply = apply
    exports.show = show
    exports.handle = handle
    exports.playCue = playCue
    exports.unlockAudio = unlockAudio
    exports.requestPermission = requestPermission
    exports.parseFrame = parseFrame
    exports.CUES = CUES
    exports.EVENTS_PATH = EVENTS_PATH
    return exports
  },
})
