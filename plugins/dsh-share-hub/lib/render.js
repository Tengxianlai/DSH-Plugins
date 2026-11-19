/**
 * 会话快照渲染：把派生出来的 Message 数组变成可分享的产物。
 *
 * 一份模型、三种输出：
 *   - renderHtml      为「人读」设计的单文件文章页（链接分享 / 下载）
 *   - renderPrintHtml A4 打印版（本机 Chromium print-to-pdf 的输入）
 *   - renderMarkdown  按轮次组织的 Markdown（进知识库 / 二次编辑）
 *
 * 版式参考 dsh-session-export 的报告页（KPI → 轮次时间线），正文交给
 * ./markdown.js 的 GFM 渲染器（表格、嵌套列表、任务清单、代码高亮）。
 */

import { redactMessages } from './redact.js'
import { escapeHtml, renderBlocks, codeBlock } from './markdown.js'

/** 默认渲染选项。 */
export const DEFAULTS = Object.freeze({
  includeToolCalls: false,
  includeToolResults: false,
  includeReasoning: false,
  redact: true
})

/** 角色 → 显示名。 */
const ROLE_LABEL = Object.freeze({ user: '你', assistant: '助手', tool: '工具' })

/**
 * 把 Message[] 规范化成本插件的消息形状。
 * 只保留 user / assistant / tool 三种可见角色；system / developer 属于注入上下文，不导出。
 * @param {ReadonlyArray<any>} messages - 已派生好的 Message 数组。
 * @param {object} [options] - 渲染选项。
 * @returns {object[]} 规范化消息。
 */
export function normalizeMessages(messages, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const out = []
  for (const message of messages ?? []) {
    const role = message?.role
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue
    // 只收「真人输入 / 模型输出 / 工具结果」。DSH 把注入上下文（AGENTS.md、运行时快照、
    // 技能目录、时间上下文）也发成 user 角色消息，只是 source.kind 不同——不按 source 过滤
    // 就会把系统提示词一起分享出去。
    const kind = message?.source?.kind
    if (role === 'user' && kind !== 'user') continue
    if (role === 'assistant' && kind !== 'model') continue
    if (role === 'tool' && kind !== 'tool') continue
    const one = { role, text: '', reasoning: '', tools: [], results: [] }
    for (const block of message.content ?? []) {
      if (block?.type === 'text') one.text += block.text
      else if (block?.type === 'reasoning' && opts.includeReasoning) one.reasoning += block.text
      else if (block?.type === 'tool-call' && opts.includeToolCalls) {
        one.tools.push({ name: String(block.name ?? 'tool'), arguments: String(block.arguments ?? '') })
      }
    }
    if (role === 'tool') {
      if (!opts.includeToolResults) continue
      one.results.push(one.text)
      one.text = ''
    }
    if (one.text.trim() === '' && one.reasoning.trim() === '' && one.tools.length === 0 && one.results.length === 0) continue
    out.push(one)
  }
  return opts.redact ? redactMessages(out) : out
}

/**
 * 把消息按轮次分组：一条用户消息开启一轮，其后直到下一条用户消息都算这一轮的回答。
 * @param {ReadonlyArray<object>} messages - 规范化消息。
 * @returns {Array<{index:number, question:object|null, answers:object[]}>} 轮次。
 */
export function groupTurns(messages) {
  const turns = []
  for (const message of messages ?? []) {
    if (message.role === 'user') {
      turns.push({ index: turns.length + 1, question: message, answers: [] })
      continue
    }
    if (turns.length === 0) turns.push({ index: 1, question: null, answers: [] })
    turns[turns.length - 1].answers.push(message)
  }
  return turns
}

/**
 * 统计概览（KPI 卡）。
 * @param {ReadonlyArray<object>} messages - 规范化消息。
 * @returns {{turns:number, questions:number, chars:number, codeBlocks:number, tools:number}} 统计。
 */
export function statsOf(messages) {
  let questions = 0
  let chars = 0
  let codeBlocks = 0
  let tools = 0
  for (const message of messages ?? []) {
    if (message.role === 'user') questions += 1
    chars += message.text.length
    codeBlocks += countFences(message.text)
    tools += message.tools.length
  }
  return { turns: groupTurns(messages).length, questions, chars, codeBlocks, tools }
}

/** 数一段文本里的围栏代码块个数。 */
function countFences(text) {
  const matches = String(text).match(/^```/gmu)
  return matches === null ? 0 : Math.floor(matches.length / 2)
}

/**
 * 会话标题：优先用第一条用户消息，其次会话 id。
 * @param {ReadonlyArray<object>} messages - 规范化消息。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 标题。
 */
export function deriveTitle(messages, sessionId) {
  const first = (messages ?? []).find((message) => message.role === 'user' && message.text.trim() !== '')
  if (first === undefined) return `DSH 会话 ${String(sessionId).slice(0, 12)}`
  const line = first.text.trim().split('\n')[0].replace(/^[#>*\-\s]+/u, '').trim()
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}

/** 时间格式化（本地时区，分钟精度）。 */
function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * KPI 卡片。
 * @param {object} stats - 统计。
 * @returns {string} HTML。
 */
function kpiHtml(stats) {
  const cards = [
    ['轮次', String(stats.turns)],
    ['提问', String(stats.questions)],
    ['字数', stats.chars >= 1000 ? `${(stats.chars / 1000).toFixed(1)}k` : String(stats.chars)],
    ['代码块', String(stats.codeBlocks)],
    ['工具调用', String(stats.tools)]
  ]
  return `<section class="kpis">${cards.map(([label, value]) => `<div class="kpi"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${escapeHtml(value)}</div></div>`).join('')}</section>`
}

/**
 * 一条消息的正文（含思考、工具、结果）。
 * @param {object} message - 消息。
 * @param {object} options - {print:boolean}。
 * @returns {string} HTML。
 */
function messageBody(message, options) {
  const parts = []
  if (message.reasoning !== undefined && message.reasoning.trim() !== '') {
    parts.push(`<details class="reasoning"><summary>思考过程</summary>${renderBlocks(message.reasoning)}</details>`)
  }
  if (message.text.trim() !== '') parts.push(renderBlocks(message.text))
  if (message.tools.length > 0) {
    const body = message.tools.map((tool) => `<div class="tool"><span class="tool-name">${escapeHtml(tool.name)}</span>${codeBlock(prettyJson(tool.arguments), 'json')}</div>`).join('')
    parts.push(options.print === true
      ? `<div class="tools"><div class="tools-title">工具调用 · ${message.tools.length}</div>${body}</div>`
      : `<details class="tools"><summary>工具调用 · ${message.tools.length}</summary>${body}</details>`)
  }
  if (message.results.length > 0) {
    const body = message.results.map((result) => codeBlock(shorten(result, 2000), 'result')).join('')
    parts.push(options.print === true
      ? `<div class="tools"><div class="tools-title">工具结果</div>${body}</div>`
      : `<details class="tools"><summary>工具结果</summary>${body}</details>`)
  }
  return parts.join('\n')
}

/** 尝试把 JSON 字符串格式化，失败就原样返回。 */
function prettyJson(value) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return shorten(String(value), 1200)
  }
}

/** 截断过长文本。 */
function shorten(value, limit) {
  const text = String(value)
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（省略 ${text.length - limit} 字符）`
}

/**
 * 正文：按轮次排。
 * @param {object} doc - 文档。
 * @param {object} options - {print:boolean}。
 * @returns {string} HTML。
 */
function bodyHtml(doc, options) {
  const turns = groupTurns(doc.messages ?? [])
  if (turns.length === 0) return '<p class="empty">这个会话还没有可导出的消息。</p>'
  return `<main class="turns">${turns.map((turn) => `<article class="turn" id="turn-${turn.index}">
  <div class="turn-no">第 ${turn.index} 轮</div>
  ${turn.question === null ? '' : `<div class="q"><div class="role">${escapeHtml(ROLE_LABEL.user)}</div>${renderBlocks(turn.question.text)}</div>`}
  ${turn.answers.map((answer) => `<div class="a"><div class="role">${escapeHtml(ROLE_LABEL[answer.role] ?? answer.role)}</div>${messageBody(answer, options)}</div>`).join('\n')}
</article>`).join('\n')}</main>`
}

/** 文档头 + KPI。 */
function headerHtml(doc) {
  const stats = statsOf(doc.messages ?? [])
  const meta = [
    doc.exportedAt === undefined ? '' : `导出于 ${formatTime(doc.exportedAt)}`,
    doc.cwd === undefined ? '' : doc.cwd
  ].filter((item) => item !== '').map((item) => `<span>${escapeHtml(item)}</span>`).join('<i>·</i>')
  return `<header class="hero">
  <div class="eyebrow">DSH 会话 · 只读快照</div>
  <h1>${escapeHtml(doc.title ?? 'DSH 会话')}</h1>
  <div class="meta">${meta}</div>
</header>
${kpiHtml(stats)}`
}

/** 屏幕版 CSS。 */
const SCREEN_CSS = `
:root{--bg:#fcfcfd;--fg:#1c1f23;--muted:#6b7280;--line:#e6e8eb;--card:#fff;--accent:#2563eb;--q-bg:#f4f7ff;--code-bg:#f6f8fa;--inline-bg:#eef1f4;--font:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--tok-kw:#cf222e;--tok-str:#0a3069;--tok-num:#0550ae;--tok-com:#6e7781;--tok-key:#8250df;--tok-lit:#0550ae}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#21262d;--card:#161b22;--accent:#58a6ff;--q-bg:#101a2b;--code-bg:#161b22;--inline-bg:#21262d;--tok-kw:#ff7b72;--tok-str:#a5d6ff;--tok-num:#79c0ff;--tok-com:#8b949e;--tok-key:#d2a8ff;--tok-lit:#79c0ff}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:15.5px/1.8 var(--font);-webkit-font-smoothing:antialiased}
.page{max-width:820px;margin:0 auto;padding:56px 28px 96px}
.hero{margin-bottom:28px}
.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
h1{margin:0 0 10px;font-size:30px;line-height:1.32;font-weight:650;letter-spacing:-.01em;word-break:break-word}
.meta{color:var(--muted);font-size:12.5px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.meta i{font-style:normal;opacity:.4}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:10px;margin:22px 0 8px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
.kpi-label{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.kpi-value{font-size:21px;font-weight:650;margin-top:3px;font-variant-numeric:tabular-nums}
.turn{border-top:1px solid var(--line);padding:30px 0 6px;margin-top:30px}
.turn:first-child{border-top:0;margin-top:12px;padding-top:12px}
.turn-no{font:600 11px/1 var(--mono);letter-spacing:.12em;color:var(--muted);margin-bottom:10px}
.role{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.q{background:var(--q-bg);border-left:3px solid var(--accent);border-radius:0 12px 12px 0;padding:16px 20px}
.q .role{color:var(--accent)}
.a{margin-top:20px;padding-left:4px}
p{margin:0 0 12px}
p:last-child{margin-bottom:0}
strong{font-weight:650}
em{font-style:italic}
del{opacity:.65}
h2,h3,h4,h5{margin:22px 0 8px;line-height:1.4;font-weight:650}
h2{font-size:19px}h3{font-size:17px}h4,h5{font-size:15px}
ul,ol{margin:0 0 12px;padding-left:22px}
li{margin:3px 0}
li ul,li ol{margin:4px 0}
li input[type=checkbox]{margin:0 6px 0 0;vertical-align:-1px}
blockquote{margin:12px 0;padding:6px 0 6px 14px;border-left:3px solid var(--line);color:var(--muted)}
blockquote p{margin:0 0 6px}
blockquote p:last-child{margin-bottom:0}
hr{border:0;border-top:1px solid var(--line);margin:22px 0}
code{font-family:var(--mono);font-size:.88em;background:var(--inline-bg);border-radius:4px;padding:.12em .36em}
.code{margin:14px 0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--code-bg)}
.code-head{padding:7px 12px;font:10.5px/1.4 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line)}
.code pre{margin:0;padding:12px 14px;overflow:auto;font:12.5px/1.65 var(--mono);white-space:pre;tab-size:2}
.code pre code{background:none;padding:0;font-size:inherit}
.tok-kw{color:var(--tok-kw)}.tok-str{color:var(--tok-str)}.tok-num{color:var(--tok-num)}.tok-com{color:var(--tok-com);font-style:italic}.tok-key{color:var(--tok-key)}.tok-lit{color:var(--tok-lit)}.tok-punc{color:var(--muted)}
.table-wrap{overflow-x:auto;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--q-bg);font-weight:650}
tr:nth-child(even) td{background:color-mix(in srgb,var(--card) 70%,var(--bg))}
.ta-center{text-align:center}.ta-right{text-align:right}
img{max-width:100%;height:auto;border-radius:8px;margin:6px 0}
.tools,.reasoning{margin-top:14px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;background:var(--card)}
.tools summary,.reasoning summary{cursor:pointer;font-size:12px;color:var(--muted);user-select:none}
.tools-title{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding:2px 0 6px}
.tool{margin:8px 0}
.tool-name{display:inline-block;font:600 11.5px/1.6 var(--mono);color:var(--accent);margin-bottom:6px}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media (max-width:560px){.page{padding:36px 16px 72px}h1{font-size:24px}.q{padding:14px 16px}}
`

/** 打印版附加 CSS。 */
const PRINT_CSS = `
@page{size:A4;margin:16mm 15mm}
body{background:#fff;color:#111;font-size:11.5pt;line-height:1.7}
.page{max-width:none;padding:0}
.hero{margin-bottom:18px}
h1{font-size:22pt}
.kpis{grid-template-columns:repeat(5,1fr);margin:14px 0 0}
.kpi{border-color:#ddd;background:#fafafa;padding:8px 10px}
.kpi-value{font-size:15pt}
.turn{border-top:1px solid #ddd;padding-top:16px;margin-top:20px}
.q{background:#f6f8ff;border-left-color:#2f6feb}
.code{border-color:#ddd;background:#fafafa}
.code pre{font-size:9pt}
table{font-size:9.5pt}
th,td{border-color:#ddd}
th{background:#f2f2f2}
.tools,.reasoning{border-color:#ddd;background:#fafafa}
footer{margin-top:28px;font-size:9pt}
a{color:#111;text-decoration:none}
`

/**
 * 拼完整 HTML。
 * @param {object} doc - 文档。
 * @param {string} css - 版式 CSS。
 * @param {object} options - {print:boolean}。
 * @returns {string} HTML。
 */
function pageHtml(doc, css, options) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(doc.title ?? 'DSH 会话')}</title>
<style>${css}</style>
</head>
<body>
<div class="page">
${headerHtml(doc)}
${bodyHtml(doc, options)}
<footer>由 DSH Share Hub 生成${doc.notice === undefined ? '' : ` · ${escapeHtml(doc.notice)}`}</footer>
</div>
</body>
</html>
`
}

/**
 * 屏幕版单文件 HTML。
 * @param {object} doc - 文档。
 * @returns {string} HTML。
 */
export function renderHtml(doc) {
  return pageHtml(doc, SCREEN_CSS, { print: false })
}

/**
 * 打印版 HTML（A4，供本机 Chromium 转 PDF）。
 * @param {object} doc - 文档。
 * @returns {string} HTML。
 */
export function renderPrintHtml(doc) {
  return pageHtml(doc, `${SCREEN_CSS}${PRINT_CSS}`, { print: true })
}

/**
 * Markdown 版：按轮次组织。
 * @param {object} doc - 文档。
 * @returns {string} Markdown。
 */
export function renderMarkdown(doc) {
  const turns = groupTurns(doc.messages ?? [])
  const lines = [`# ${doc.title ?? 'DSH 会话'}`, '']
  if (doc.exportedAt !== undefined) {
    lines.push(`> 导出于 ${formatTime(doc.exportedAt)}${doc.cwd === undefined ? '' : ` · ${doc.cwd}`}`, '')
  }
  for (const turn of turns) {
    lines.push(`## 第 ${turn.index} 轮`, '')
    if (turn.question !== null) {
      lines.push('### 你', '', turn.question.text.trim(), '')
    }
    for (const answer of turn.answers) {
      lines.push(`### ${ROLE_LABEL[answer.role] ?? answer.role}`, '')
      if (answer.reasoning !== undefined && answer.reasoning.trim() !== '') {
        lines.push('<details><summary>思考过程</summary>', '', answer.reasoning.trim(), '', '</details>', '')
      }
      if (answer.text.trim() !== '') lines.push(answer.text.trim(), '')
      for (const tool of answer.tools) {
        lines.push('> 工具调用：' + tool.name, '', '```json', shorten(tool.arguments, 600), '```', '')
      }
      for (const result of answer.results) lines.push('```', shorten(result, 2000), '```', '')
    }
  }
  lines.push('---', '', '由 DSH Share Hub 生成本地快照。', '')
  return lines.join('\n')
}
