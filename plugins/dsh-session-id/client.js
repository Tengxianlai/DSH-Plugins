/* eslint-disable */
/**
 * dsh-session-id —— 浏览器半边。
 *
 * 在会话标题栏（标题右侧那排 chip 的末尾）显示当前会话 ID 的短形式，
 * 点击把完整 `session-<uuid>` 复制到剪贴板。目的：把会话交给另一个会话/排查时，
 * 不用再翻 URL、翻日志或让用户手动找。
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

    /** 字典：标题栏这一处只用到三条文案。 */
    const DICT = {
      zh: {
        copy: '复制会话 ID',
        copied: '已复制',
        hint: '会话 ID：{id}\n点击复制完整 ID'
      },
      en: {
        copy: 'Copy session ID',
        copied: 'Copied',
        hint: 'Session ID: {id}\nClick to copy the full ID'
      }
    }

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
     * 既像 ID 又不占宽；完整 ID 在 title 提示里，点击复制的也是完整 ID。
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
      const timer = react.useRef(0)

      // 切会话时清掉上一个会话的"已复制"状态，避免短形式换成新 ID 后仍显示成功色。
      react.useEffect(() => {
        setCopied(false)
        if (timer.current) {
          clearTimeout(timer.current)
          timer.current = 0
        }
      }, [sessionId])

      // 卸载时清计时器，别让已销毁组件里跑 setState。
      react.useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current)
      }, [])

      if (typeof sessionId !== 'string' || sessionId === '') return null

      const onClick = async () => {
        try {
          await writeClipboard(sessionId)
        } catch {
          return
        }
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          timer.current = 0
          setCopied(false)
        }, 1500)
      }

      return react.createElement('button', {
        type: 'button',
        className: 'sid_badge' + (copied ? ' sid_badgeCopied' : ''),
        title: t('hint', { id: sessionId }),
        'aria-label': t('copy'),
        'data-dsh-session-id': sessionId,
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
