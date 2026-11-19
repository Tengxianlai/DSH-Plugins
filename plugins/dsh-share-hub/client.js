/* eslint-disable */
/**
 * dsh-share-hub —— 浏览器半体（0.2.0：现代面板 + 配置可见）。
 *
 * 标题栏按钮 → `shell.overlay` 浮层。面板结构：
 *   头部（图标 + 标题 + 目标地址）→ 分段 tab（分享 / 管理）→ 卡片式表单 → 结果卡片。
 *
 * 宿主经 /plugins/dsh-share-hub/client.js 提供本文件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-share-hub',
  factory: (require) => {
    const exports = {}
    const react = require('react')

    /** 字典命名空间（与包名区分，避免和官方命名空间撞）。 */
    const NS = 'share-hub'
    /** 样式标签稳定标识，用于「只注入一次」。 */
    const CSS_TAG_ID = 'dsh-share-hub/share.css'

    const CSS = [
      '.sh_button{box-sizing:border-box;border:0;height:22px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-fill-tsp-secondary);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:22px;padding:0 7px;gap:4px;display:inline-flex;align-items:center;white-space:nowrap;cursor:pointer;flex:none;transition:background .15s,color .15s}',
      '@media (hover:hover){.sh_button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}',
      '.sh_button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',

      '.sh_overlay{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(10,12,18,.42);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);animation:sh_fade .16s ease-out}',
      '@keyframes sh_fade{from{opacity:0}to{opacity:1}}',
      '@keyframes sh_rise{from{opacity:0;transform:translateY(8px) scale(.99)}to{opacity:1;transform:none}}',
      '.sh_panel{box-sizing:border-box;width:min(680px,100%);max-height:min(84vh,760px);display:flex;flex-direction:column;border-radius:18px;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#ddd) 80%,transparent);box-shadow:0 32px 80px rgba(0,0,0,.38),0 2px 8px rgba(0,0,0,.12);animation:sh_rise .18s cubic-bezier(.2,.8,.2,1)}',
      '@media (prefers-reduced-motion:reduce){.sh_overlay,.sh_panel{animation:none}}',

      '.sh_head{display:flex;align-items:center;gap:12px;padding:18px 22px 14px}',
      '.sh_icon{width:36px;height:36px;flex:none;border-radius:12px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#4f7cff,#8b5cf6);box-shadow:0 6px 16px rgba(79,124,255,.32)}',
      '.sh_titles{flex:1;min-width:0}',
      '.sh_title{font-size:15px;font-weight:650;letter-spacing:.01em}',
      '.sh_sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px;font-family:var(--dsw-font-mono,ui-monospace,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sh_close{width:30px;height:30px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:18px;line-height:1;display:grid;place-items:center}',
      '.sh_close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',

      '.sh_tabs{display:flex;gap:4px;margin:0 22px;padding:4px;border-radius:12px;background:var(--dsw-alias-fill-tsp-secondary,rgba(127,127,127,.1));width:fit-content}',
      '.sh_tab{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:6px 14px;border-radius:9px;font-size:12px;font-weight:500;transition:background .15s,color .15s}',
      '.sh_tab.on{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.1)}',

      '.sh_body{padding:16px 22px 22px;overflow:auto;display:flex;flex-direction:column;gap:14px}',
      '.sh_card{border:1px solid var(--dsw-alias-border-l2,#e6e8eb);border-radius:14px;padding:14px 16px;background:var(--dsw-alias-bg-base,#fff)}',
      '.sh_card-title{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:8px;font-weight:600}',

      '.sh_switchrow{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l2,#f0f0f0)}',
      '.sh_switchrow:first-of-type{border-top:0;padding-top:2px}',
      '.sh_switchtext{flex:1;min-width:0}',
      '.sh_switchlabel{font-size:12.5px;color:var(--dsw-alias-label-primary)}',
      '.sh_switchdesc{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:1px}',
      '.sh_switch{position:relative;width:36px;height:20px;flex:none;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 35%,transparent);cursor:pointer;transition:background .18s}',
      '.sh_switch.on{background:var(--dsw-alias-state-business-primary,#2f6feb)}',
      '.sh_switch .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .18s}',
      '.sh_switch.on .knob{transform:translateX(16px)}',
      '.sh_switch input{position:absolute;opacity:0;inset:0;cursor:pointer}',

      '.sh_chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.sh_chip{border:1px solid var(--dsw-alias-border-l2,#ddd);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:6px 12px;font-size:12px;cursor:pointer;transition:all .15s}',
      '.sh_chip:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sh_chip.on{background:var(--dsw-alias-state-business-primary,#2f6feb);border-color:transparent;color:#fff}',

      '.sh_actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.sh_btn{box-sizing:border-box;height:36px;padding:0 15px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#ddd);background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:6px;text-decoration:none;transition:all .15s}',
      '.sh_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sh_btn:disabled{opacity:.45;cursor:default}',
      '.sh_btn.primary{background:linear-gradient(135deg,#4f7cff,#7c5cff);border:0;color:#fff;box-shadow:0 6px 16px rgba(79,124,255,.28)}',
      '.sh_btn.primary:hover{filter:brightness(1.05)}',

      '.sh_spin{width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;animation:sh_spin .7s linear infinite}',
      '@keyframes sh_spin{to{transform:rotate(360deg)}}',

      '.sh_result{border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 7%,transparent);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;font-size:12.5px}',
      '.sh_result-head{display:flex;align-items:center;gap:8px;font-weight:600}',
      '.sh_badge{width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#1a7f37);color:#fff;display:grid;place-items:center;font-size:11px}',
      '.sh_linkbox{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11.5px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#e6e8eb);border-radius:8px;padding:8px 10px;word-break:break-all;color:var(--dsw-alias-label-secondary)}',
      '.sh_linkbox a{color:var(--dsw-alias-state-business-primary,#2f6feb);text-decoration:none}',
      '.sh_meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.sh_mini{height:26px;padding:0 10px;border-radius:7px;font-size:11.5px;border:1px solid var(--dsw-alias-border-l2,#ddd);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}',
      '.sh_mini:hover{background:var(--dsw-alias-interactive-bg-hover)}',

      '.sh_item{display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2,#e6e8eb);border-radius:12px;font-size:12px;transition:background .15s}',
      '.sh_item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sh_item .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sh_muted{color:var(--dsw-alias-label-tertiary)}',
      '.sh_err{color:var(--dsw-alias-state-danger-primary,#d33);font-size:12px}',
      '.sh_empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:10px 2px}',
      '.sh_note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.65}',
      '.sh_note code{font-family:var(--dsw-font-mono,ui-monospace,monospace);background:var(--dsw-alias-fill-tsp-secondary,rgba(127,127,127,.12));padding:1px 5px;border-radius:4px}'
    ].join('')

    const DICT = {
      zh: {
        share: '分享',
        title: '分享会话',
        subtitle: '只读链接 · 本地导出',
        tabShare: '分享',
        tabManage: '管理分享',
        content: '内容',
        tools: '工具调用',
        toolsDesc: '折叠展示工具名与参数',
        results: '工具结果',
        resultsDesc: '包含工具返回正文（可能很长）',
        reasoning: '思考过程',
        reasoningDesc: '包含模型的推理内容',
        redact: '脱敏',
        redactDesc: '替换密钥、令牌与本机路径',
        ttl: '链接有效期',
        ttl1h: '1 小时',
        ttl24h: '1 天',
        ttl72h: '3 天',
        ttl7d: '7 天',
        makeLink: '生成链接',
        exportPdf: 'PDF',
        exportHtml: 'HTML',
        exportMd: 'Markdown',
        export: '导出',
        working: '处理中…',
        copy: '复制',
        copied: '已复制',
        open: '打开',
        revoke: '撤销',
        empty: '还没有活动中的分享',
        linkHint: '链接由本机只读服务提供，经配置的中转地址访问；撤销后立即失效。',
        exportHint: '导出在本机生成，下载后自己保存，不上传第三方。',
        linkReady: '链接已生成',
        fileReady: '文件已生成',
        download: '下载',
        expires: '到期',
        close: '关闭',
        target: '发布地址'
      },
      en: {
        share: 'Share',
        title: 'Share session',
        subtitle: 'Read-only link · local export',
        tabShare: 'Share',
        tabManage: 'Manage',
        content: 'Content',
        tools: 'Tool calls',
        toolsDesc: 'Collapsed tool name and arguments',
        results: 'Tool results',
        resultsDesc: 'Include tool output text (may be long)',
        reasoning: 'Reasoning',
        reasoningDesc: 'Include model reasoning',
        redact: 'Redact',
        redactDesc: 'Mask keys, tokens and local paths',
        ttl: 'Link lifetime',
        ttl1h: '1 hour',
        ttl24h: '1 day',
        ttl72h: '3 days',
        ttl7d: '7 days',
        makeLink: 'Create link',
        exportPdf: 'PDF',
        exportHtml: 'HTML',
        exportMd: 'Markdown',
        export: 'Export',
        working: 'Working…',
        copy: 'Copy',
        copied: 'Copied',
        open: 'Open',
        revoke: 'Revoke',
        empty: 'No active shares',
        linkHint: 'Served by the local read-only server through your configured relay. Revoking kills it immediately.',
        exportHint: 'Generated locally and downloaded to your machine.',
        linkReady: 'Link ready',
        fileReady: 'File ready',
        download: 'Download',
        expires: 'Expires',
        close: 'Close',
        target: 'Publishing to'
      }
    }

    /** 模块级弹层状态：标题栏按钮与 overlay 座位之间唯一的桥。 */
    const overlayStore = {
      state: { open: false, sessionId: '', tab: 'share' },
      listeners: new Set(),
      set(patch) {
        overlayStore.state = { ...overlayStore.state, ...patch }
        for (const listener of overlayStore.listeners) listener()
      }
    }

    /** 订阅弹层状态。 */
    function useOverlayState() {
      const [state, setState] = react.useState(overlayStore.state)
      react.useEffect(() => {
        const listener = () => setState(overlayStore.state)
        overlayStore.listeners.add(listener)
        listener()
        return () => { overlayStore.listeners.delete(listener) }
      }, [])
      return state
    }

    /** 只注入一次样式。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-share-hub'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * 同源 API 调用。
     * @param {string} path - 路由。
     * @param {object} [body] - POST 负载；省略则 GET。
     * @returns {Promise<object>} JSON。
     */
    async function api(path, body) {
      const response = await fetch(path, body === undefined ? { method: 'GET' } : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      const text = await response.text()
      let payload = {}
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        payload = { error: text }
      }
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    /** 字节数 → 人类可读。 */
    function humanSize(bytes) {
      if (!Number.isFinite(bytes)) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    /** 本地时间短格式。 */
    function shortTime(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** 写剪贴板；Clipboard API 不可用时退回 textarea。 */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        let ok = false
        try {
          ok = document.execCommand('copy')
        } catch {
          ok = false
        }
        area.remove()
        return ok
      }
    }

    /** 标题栏入口：只负责开弹层。 */
    function ShareEntry(props) {
      const sessionId = props.sessionId
      const t = props.t
      if (typeof sessionId !== 'string' || sessionId === '') return null
      return react.createElement('button', {
        className: 'sh_button',
        title: t('title'),
        onClick: () => overlayStore.set({ open: true, sessionId, tab: 'share' })
      },
        react.createElement(ShareIcon, { size: 12 }),
        react.createElement('span', null, t('share'))
      )
    }

    /** 弹层（挂在 shell.overlay）。 */
    function ShareOverlay(props) {
      const t = props.t
      const overlay = useOverlayState()
      const [busy, setBusy] = react.useState('')
      const [error, setError] = react.useState('')
      const [result, setResult] = react.useState(null)
      const [items, setItems] = react.useState([])
      const [status, setStatus] = react.useState(null)
      const [copied, setCopied] = react.useState('')
      const [options, setOptions] = react.useState({ includeToolCalls: false, includeToolResults: false, includeReasoning: false, redact: true })
      const [ttlHours, setTtlHours] = react.useState(72)
      const sessionId = overlay.sessionId
      const open = overlay.open
      const tab = overlay.tab

      react.useEffect(() => {
        if (!open) return undefined
        setError('')
        setResult(null)
        setBusy('')
        void loadStatus()
        void loadList()
        const onKey = (event) => {
          if (event.key === 'Escape') overlayStore.set({ open: false })
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      if (!open) return null

      async function loadStatus() {
        try {
          const data = await api('api/share-hub/status')
          setStatus(data)
          setOptions((current) => ({ ...current, redact: data.redact === true }))
          if (Number.isFinite(data.ttlHours)) setTtlHours(data.ttlHours)
        } catch {
          setStatus(null)
        }
      }

      async function loadList() {
        try {
          const data = await api('api/share-hub/list')
          setItems(Array.isArray(data.items) ? data.items : [])
        } catch (err) {
          setError(String(err.message || err))
        }
      }

      async function createLink() {
        setBusy('link')
        setError('')
        try {
          const data = await api('api/share-hub/link', { sessionId, ttlHours, options })
          setResult({ kind: 'link', url: data.url, id: data.id, expiresAt: data.expiresAt })
          await loadList()
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy('')
        }
      }

      async function exportFile(format) {
        setBusy(format)
        setError('')
        try {
          const data = await api('api/share-hub/export', { sessionId, format, options })
          setResult({ kind: 'file', name: data.name, bytes: data.bytes, url: data.url, format })
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy('')
        }
      }

      async function revoke(id) {
        try {
          await api('api/share-hub/revoke', { id })
          await loadList()
          if (result !== null && result.id === id) setResult(null)
        } catch (err) {
          setError(String(err.message || err))
        }
      }

      async function copy(value, key) {
        if (await copyText(value)) {
          setCopied(key)
          setTimeout(() => setCopied(''), 1500)
        }
      }

      const toggle = (key) => setOptions((current) => ({ ...current, [key]: !current[key] }))

      function switchRow(key, label, desc) {
        return react.createElement('div', { className: 'sh_switchrow', key },
          react.createElement('div', { className: 'sh_switchtext' },
            react.createElement('div', { className: 'sh_switchlabel' }, label),
            react.createElement('div', { className: 'sh_switchdesc' }, desc)
          ),
          react.createElement('div', { className: 'sh_switch' + (options[key] === true ? ' on' : '') },
            react.createElement('span', { className: 'knob' }),
            react.createElement('input', { type: 'checkbox', checked: options[key] === true, onChange: () => toggle(key), 'aria-label': label })
          )
        )
      }

      function chips() {
        const values = [['1', t('ttl1h')], ['24', t('ttl24h')], ['72', t('ttl72h')], ['168', t('ttl7d')]]
        return react.createElement('div', { className: 'sh_chips' }, values.map(([value, label]) =>
          react.createElement('button', {
            key: value,
            className: 'sh_chip' + (String(ttlHours) === value ? ' on' : ''),
            onClick: () => setTtlHours(Number(value))
          }, label)
        ))
      }

      function button(label, kind, onClick, spinning) {
        return react.createElement('button', {
          className: 'sh_btn' + (kind === 'primary' ? ' primary' : ''),
          disabled: busy !== '',
          onClick
        }, spinning ? react.createElement('span', { className: 'sh_spin' }) : null, label)
      }

      function shareBody() {
        return [
          react.createElement('div', { className: 'sh_card', key: 'content' },
            react.createElement('div', { className: 'sh_card-title' }, t('content')),
            switchRow('includeToolCalls', t('tools'), t('toolsDesc')),
            switchRow('includeToolResults', t('results'), t('resultsDesc')),
            switchRow('includeReasoning', t('reasoning'), t('reasoningDesc')),
            switchRow('redact', t('redact'), t('redactDesc'))
          ),
          react.createElement('div', { className: 'sh_card', key: 'ttl' },
            react.createElement('div', { className: 'sh_card-title' }, t('ttl')),
            chips()
          ),
          react.createElement('div', { className: 'sh_actions', key: 'actions' },
            button(busy === 'link' ? t('working') : t('makeLink'), 'primary', createLink, busy === 'link'),
            button(busy === 'pdf' ? t('working') : t('exportPdf'), 'ghost', () => exportFile('pdf'), busy === 'pdf'),
            button(busy === 'html' ? t('working') : t('exportHtml'), 'ghost', () => exportFile('html'), busy === 'html'),
            button(busy === 'markdown' ? t('working') : t('exportMd'), 'ghost', () => exportFile('markdown'), busy === 'markdown')
          ),
          error === '' ? null : react.createElement('div', { className: 'sh_err', key: 'err' }, error),
          result === null ? null : result.kind === 'link'
            ? react.createElement('div', { className: 'sh_result', key: 'result' },
              react.createElement('div', { className: 'sh_result-head' },
                react.createElement('span', { className: 'sh_badge' }, '✓'), t('linkReady')
              ),
              react.createElement('div', { className: 'sh_linkbox' },
                react.createElement('a', { href: result.url, target: '_blank', rel: 'noreferrer' }, result.url)
              ),
              react.createElement('div', { className: 'sh_meta' },
                react.createElement('button', { className: 'sh_mini', onClick: () => copy(result.url, result.id) }, copied === result.id ? t('copied') : t('copy')),
                react.createElement('span', null, `${t('expires')} ${shortTime(result.expiresAt)}`)
              )
            )
            : react.createElement('div', { className: 'sh_result', key: 'result' },
              react.createElement('div', { className: 'sh_result-head' },
                react.createElement('span', { className: 'sh_badge' }, '✓'), `${t('fileReady')} · ${humanSize(result.bytes)}`
              ),
              react.createElement('div', { className: 'sh_meta' },
                react.createElement('a', { className: 'sh_mini', href: result.url, download: result.name }, `${t('download')} ${result.name}`)
              )
            ),
          react.createElement('div', { className: 'sh_note', key: 'note' }, t('linkHint'), react.createElement('br'), t('exportHint'))
        ]
      }

      function manageBody() {
        if (items.length === 0) return react.createElement('div', { className: 'sh_empty' }, t('empty'))
        return items.map((item) => react.createElement('div', { className: 'sh_item', key: item.id },
          react.createElement('span', { className: 'grow', title: item.title }, item.title),
          react.createElement('span', { className: 'sh_muted' }, shortTime(item.expiresAt)),
          react.createElement('button', { className: 'sh_mini', onClick: () => copy(item.url, item.id) }, copied === item.id ? t('copied') : t('copy')),
          react.createElement('a', { className: 'sh_mini', href: item.url, target: '_blank', rel: 'noreferrer' }, t('open')),
          react.createElement('button', { className: 'sh_mini', onClick: () => revoke(item.id) }, t('revoke'))
        ))
      }

      return react.createElement('div', {
        className: 'sh_overlay',
        onClick: (event) => {
          if (event.target === event.currentTarget) overlayStore.set({ open: false })
        }
      }, react.createElement('div', { className: 'sh_panel', role: 'dialog', 'aria-label': t('title') },
        react.createElement('div', { className: 'sh_head' },
          react.createElement('div', { className: 'sh_icon' }, react.createElement(ShareIcon, { size: 17 })),
          react.createElement('div', { className: 'sh_titles' },
            react.createElement('div', { className: 'sh_title' }, t('title')),
            react.createElement('div', { className: 'sh_sub' }, status === null ? t('subtitle') : `${t('target')} ${status.publicBaseUrl}`)
          ),
          react.createElement('button', { className: 'sh_close', onClick: () => overlayStore.set({ open: false }), 'aria-label': t('close') }, '×')
        ),
        react.createElement('div', { className: 'sh_tabs' },
          react.createElement('button', { className: 'sh_tab' + (tab === 'share' ? ' on' : ''), onClick: () => overlayStore.set({ tab: 'share' }) }, t('tabShare')),
          react.createElement('button', { className: 'sh_tab' + (tab === 'manage' ? ' on' : ''), onClick: () => overlayStore.set({ tab: 'manage' }) }, t('tabManage'))
        ),
        react.createElement('div', { className: 'sh_body' }, tab === 'share' ? shareBody() : manageBody())
      ))
    }

    /** 分享图标（箭头出框）。 */
    function ShareIcon(props) {
      const size = props?.size ?? 13
      return react.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
        react.createElement('path', { d: 'M12 15V3' }),
        react.createElement('path', { d: 'm8 7 4-4 4 4' }),
        react.createElement('path', { d: 'M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5' })
      )
    }

    /**
     * 客户端插件体：字典 + 标题栏入口 + overlay 弹层。
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ensureStyle()
      ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-share-hub: locale')
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'share-hub',
        order: 25,
        locale: NS
      }, ShareEntry))
      try {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'share-hub-overlay',
          order: 50,
          locale: NS
        }, ShareOverlay))
      } catch (error) {
        console.warn('[share-hub] shell.overlay 注册失败，弹层不可用：', error)
      }
    }

    exports.name = 'share-hub'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return exports
  }
})
