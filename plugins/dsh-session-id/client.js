/* eslint-disable */
/**
 * dsh-session-id —— 浏览器半边。
 *
 * 在会话标题栏（标题右侧那排 chip 的末尾）显示当前会话 ID 的短形式。
 * 点击把三行带说明的文字写进剪贴板（已知几个写几个），粘给别的会话不用猜：
 *
 *   会话 ID：session-<uuid>
 *   存储目录（会话日志所在）：/home/<user>/<dsh home>/sessions/--<project>--/session-<uuid>/
 *   工作目录（会话启动时的项目目录）：/home/<user>/<project>
 *
 * 第二行是这个会话在磁盘上的存储目录（`session.v4.jsonl.zstd` 所在目录），
 * 粘给另一个会话，对方就能直接去读那份日志，不用再翻 URL / 问用户路径；
 * 第三行是会话的工作目录，方便对方同时知道项目在哪。
 * 目录来自宿主路由 `/api/session.location`（宿主用 sessionPersistence 解析，
 * 存储根是 profile 配置，浏览器自己算不出来）；拿不到时退回只复制 ID，
 * 复制动作永远不为查目录失败而卡住。
 *
 * 挂载点：`conversation.session.header.actions`（list，session 作用域）。
 * 该 slot 的登记项按 order 升序排列，官方占用者：agent-team(-20)、agent-preset(-10)、
 * subagent-catalog(10)、job-list(20)；这里用 30 排在它们之后、utilities 之前。
 *
 * 只 require('react')：不依赖 @deepseek-ai/dsh-client-ui-primitives 的图标集，
 * 避免给插件引入客户端模块依赖；样式全部走宿主语义变量（--dsw-*），深浅色自动跟随。
 *
 * 宿主经 /plugins/dsh-session-id/client.js 提供本文件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-id',
  factory: (require) => {
    const exports = {}
    const react = require('react')

    /** 字典命名空间：与包名区分，避免和官方命名空间相撞。 */
    const NS = 'session-id'
    /** 样式标签稳定标识，用于「只注入一次」。 */
    const CSS_TAG_ID = 'dsh-session-id/badge.css'
    /**
     * 宿主位置路由。文档相对写法，与官方 `api/session.markdown` 等一致；
     * 该路由在 Connection 的认证围栏内，同源 fetch 自带会话 Cookie。
     */
    const LOCATION_ROUTE = 'api/session.location'
    /** 与标题栏既有 chip 同高（22px）、同圆角、同色阶，避免视觉上像外来控件。 */
    const CSS = [
      '.sid_badge{box-sizing:border-box;border:0;max-width:180px;height:22px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-fill-tsp-secondary);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:22px;padding:0 5px;gap:4px;display:inline-flex;align-items:center;white-space:nowrap;overflow:hidden;cursor:pointer;flex:none}',
      '@media (hover:hover){.sid_badge:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}',
      '.sid_badge:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.sid_text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono);font-variant-numeric:tabular-nums;letter-spacing:.01em}',
      '.sid_icon{flex:none;opacity:.7}',
      '.sid_badgeCopied{color:var(--dsw-alias-state-success-primary)}',
      '.sid_badgeCopied .sid_icon{opacity:1}'
    ].join('')

    /**
     * 字典：粘进剪贴板的每行都带角色说明（label*），tooltip 按
     * "目录已知 / 读取中 / 不可用"三态拼词，另外两条是点击动作说明。
     */
    const DICT = {
      zh: {
        copy: '复制会话 ID、存储目录与工作目录',
        copied: '已复制',
        labelId: '会话 ID：',
        labelDir: '存储目录（会话日志所在）：',
        labelCwd: '工作目录（会话启动时的项目目录）：',
        hintCopyAll: '点击复制以上内容',
        hintCopyId: '点击复制会话 ID',
        pending: '存储目录读取中…',
        unavailable: '存储目录暂不可用（会话未落盘或已不存在）'
      },
      en: {
        copy: 'Copy session ID, storage dir and working dir',
        copied: 'Copied',
        labelId: 'Session ID: ',
        labelDir: 'Storage dir (where this session log lives): ',
        labelCwd: 'Working dir (project directory of this session): ',
        hintCopyAll: 'Click to copy everything above',
        hintCopyId: 'Click to copy the session ID',
        pending: 'Reading storage dir…',
        unavailable: 'Storage dir unavailable (session not on disk yet or deleted)'
      }
    }

    /** 位置状态初值：刚挂载时还没查。 */
    const LOCATION_LOADING = Object.freeze({ phase: 'loading' })
    /** 查询失败（路由缺失/网络错误）：与"查到了但没落盘"共用"不可用"文案。 */
    const LOCATION_FAILED = Object.freeze({ phase: 'failed' })

    /** 只注入一次样式。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-session-id'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * 标题栏里显示的短形式：保留 `session-` 前缀 + UUID 第一段（8 位）。
     * 既像 ID 又不占宽；完整 ID 在 title 提示里，点击复制的也是完整内容。
     * @param {string} sessionId - 完整会话 ID。
     * @returns {string} 截断后的显示文本。
     */
    function shortId(sessionId) {
      const text = String(sessionId)
      const uuid = text.startsWith('session-') ? text.slice('session-'.length) : text
      const head = uuid.split('-')[0] ?? ''
      if (head.length < 6) return text
      return 'session-' + head
    }

    /**
     * 复制文本：每行前面带角色说明，粘给别的会话时对方不用猜哪行是什么。
     *
     *   会话 ID：session-<uuid>
     *   存储目录（会话日志所在）：/home/…/sessions/--项目--/session-<uuid>/
     *   工作目录（会话启动时的项目目录）：/home/…/项目
     *
     * 存储目录拿不到（未落盘/已删除/路由不可用）时只写带说明的 ID 一行——不猜路径。
     * @param {string} sessionId - 完整会话 ID。
     * @param {object} location - 位置状态。
     * @param {Function} t - 本命名空间的字典函数。
     * @returns {string} 写入剪贴板的文本。
     */
    function copyText(sessionId, location, t) {
      const lines = [t('labelId') + sessionId]
      if (location !== null && location.phase === 'ready' && location.dir !== null) {
        lines.push(t('labelDir') + location.dir)
        if (location.cwd !== null) lines.push(t('labelCwd') + location.cwd)
      }
      return lines.join('\n')
    }

    /**
     * 查一次会话存储位置。
     * @param {string} sessionId - 完整会话 ID。
     * @param {AbortSignal} signal - 卸载/切会话时取消。
     * @returns {Promise<object>} `{phase:'ready',dir,log,cwd}` 或 `{phase:'failed'}`。
     */
    async function fetchLocation(sessionId, signal) {
      const response = await fetch(LOCATION_ROUTE + '?sessionId=' + encodeURIComponent(sessionId), {
        signal,
        credentials: 'same-origin',
        headers: { accept: 'application/json' }
      })
      if (!response.ok) return LOCATION_FAILED
      let body
      try {
        body = await response.json()
      } catch {
        return LOCATION_FAILED
      }
      if (body === null || typeof body !== 'object') return LOCATION_FAILED
      return {
        phase: 'ready',
        dir: textOrNull(body.dir),
        log: textOrNull(body.log),
        cwd: textOrNull(body.cwd)
      }
    }

    /**
     * 取非空字符串，其余一律 null。
     * @param {unknown} value - 待检查的值。
     * @returns {string|null} 可用的字符串或 null。
     */
    function textOrNull(value) {
      return typeof value === 'string' && value !== '' ? value : null
    }

    /**
     * 复制文本：优先异步剪贴板；非安全上下文（老浏览器/无 https）退回 execCommand。
     * @param {string} text - 要写入剪贴板的文本。
     * @returns {Promise<void>}
     */
    async function writeClipboard(text) {
      // 新 API 在无权限/无焦点/非安全上下文时会 reject，不能只判存在性。
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(text)
          return
        } catch {
          /* 落到 execCommand 兜底 */
        }
      }
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      try {
        area.select()
        const ok = document.execCommand('copy')
        if (!ok) throw new Error('copy command was rejected')
      } finally {
        area.remove()
      }
    }

    /** 复制图标（两页叠放）；复制成功后换成对勾。 */
    function CopyIcon(props) {
      const copyShape = react.createElement(react.Fragment, null,
        react.createElement('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }),
        react.createElement('path', { d: 'M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2' })
      )
      const checkShape = react.createElement('path', { d: 'M3 8.2l3.2 3.2L13 4.6' })
      return react.createElement('svg', {
        className: 'sid_icon',
        width: 12,
        height: 12,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true'
      }, props.copied ? checkShape : copyShape)
    }

    /**
     * 标题栏上的会话 ID chip。
     * @param props - slot 注入的 `sessionId` 与本命名空间绑定的 `t`。
     * @returns {React.ReactElement|null} 会话 ID 尚未就绪时不渲染。
     */
    function SessionIdBadge(props) {
      const sessionId = props.sessionId
      const t = props.t
      const [copied, setCopied] = react.useState(false)
      const [location, setLocation] = react.useState(LOCATION_LOADING)
      // 点击处理里要同步读到最新位置：state 的更新是异步的，ref 才是同一拍的值。
      const locationRef = react.useRef(LOCATION_LOADING)
      const controller = react.useRef(null)
      const timer = react.useRef(0)

      /**
       * 发起（或重发）一次位置查询；新请求会取消上一个。
       * @param {string} id - 当前会话 ID。
       */
      function loadLocation(id) {
        if (controller.current !== null) controller.current.abort()
        const next = new AbortController()
        controller.current = next
        fetchLocation(id, next.signal).then((value) => {
          if (next.signal.aborted) return
          locationRef.current = value
          setLocation(value)
        }).catch(() => {
          if (next.signal.aborted) return
          locationRef.current = LOCATION_FAILED
          setLocation(LOCATION_FAILED)
        })
      }

      // 切会话时：清掉"已复制"状态与上一个会话的位置，再按新 ID 查一次。
      react.useEffect(() => {
        setCopied(false)
        if (timer.current) {
          clearTimeout(timer.current)
          timer.current = 0
        }
        locationRef.current = LOCATION_LOADING
        setLocation(LOCATION_LOADING)
        if (typeof sessionId === 'string' && sessionId !== '') loadLocation(sessionId)
        return () => {
          if (controller.current !== null) controller.current.abort()
        }
      }, [sessionId])

      // 卸载时清计时器，别让已销毁组件里跑 setState（Controller 由上面那个 effect 的清理收）。
      react.useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current)
      }, [])

      if (typeof sessionId !== 'string' || sessionId === '') return null

      const onClick = async () => {
        const current = locationRef.current
        try {
          await writeClipboard(copyText(sessionId, current, t))
        } catch {
          return
        }
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          timer.current = 0
          setCopied(false)
        }, 1500)
        // 目录还没拿到（点得太早、或上次查询失败）：补一次；这次先复制 ID，不让人干等。
        if (!(current.phase === 'ready' && current.dir !== null)) loadLocation(sessionId)
      }

      // tooltip 与剪贴板同文：看到什么就会复制什么（末尾再加一行点击说明）。
      const idLine = t('labelId') + sessionId
      let hint
      if (location.phase === 'ready' && location.dir !== null) {
        const lines = [idLine, t('labelDir') + location.dir]
        if (location.cwd !== null) lines.push(t('labelCwd') + location.cwd)
        hint = [...lines, t('hintCopyAll')].join('\n')
      } else if (location.phase === 'loading') {
        hint = [idLine, t('pending'), t('hintCopyId')].join('\n')
      } else {
        hint = [idLine, t('unavailable'), t('hintCopyId')].join('\n')
      }

      return react.createElement('button', {
        type: 'button',
        className: 'sid_badge' + (copied ? ' sid_badgeCopied' : ''),
        title: hint,
        'aria-label': t('copy'),
        'data-dsh-session-id': sessionId,
        'data-dsh-session-dir': location.phase === 'ready' && location.dir !== null ? location.dir : undefined,
        'data-dsh-session-location': location.phase,
        onClick
      },
        react.createElement('span', { className: 'sid_text' }, copied ? t('copied') : shortId(sessionId)),
        react.createElement(CopyIcon, { copied })
      )
    }

    /**
     * 客户端插件体：注册字典 + 标题栏入口。
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ensureStyle()
      ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-session-id: locale')
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'session-id',
        order: 30,
        locale: NS
      }, SessionIdBadge))
    }

    exports.name = 'session-id'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return exports
  }
})
