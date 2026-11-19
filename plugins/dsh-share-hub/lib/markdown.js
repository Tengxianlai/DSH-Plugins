/**
 * 轻量 GFM 渲染器（零依赖）：会话正文里最常见的 Markdown 结构。
 *
 * 覆盖：围栏代码（``` / ~~~，带语言高亮）、ATX 标题、引用（可嵌套）、
 * 有序/无序列表（缩进嵌套、任务清单）、GFM 表格（对齐）、分割线、段落；
 * 行内：代码、加粗、斜体、删除线、[文字](链接)、![图](链接)、裸 URL。
 *
 * 安全：所有文本先转义；链接只认 http(s)；原始 HTML 一律当文本，不执行。
 * 未知结构按段落处理（保留换行）——宁可少渲染，不猜。
 */

/** 语言关键字表（不够用时退回纯文本，不报错）。 */
const KEYWORDS = Object.freeze({
  js: new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'of', 'in', 'new', 'class', 'extends', 'import', 'from', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'this', 'super', 'null', 'undefined', 'true', 'false', 'switch', 'case', 'break', 'continue', 'do', 'delete', 'yield', 'static', 'get', 'set']),
  ts: new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'of', 'in', 'new', 'class', 'extends', 'implements', 'interface', 'type', 'enum', 'import', 'from', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'this', 'super', 'null', 'undefined', 'true', 'false', 'switch', 'case', 'break', 'continue', 'do', 'delete', 'yield', 'as', 'readonly', 'public', 'private', 'protected', 'static', 'declare', 'namespace']),
  python: new Set(['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'lambda', 'yield', 'async', 'await', 'None', 'True', 'False', 'self', 'break', 'continue', 'global', 'nonlocal', 'assert', 'del', 'is']),
  bash: new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'in', 'return', 'export', 'local', 'readonly', 'unset', 'echo', 'cd', 'set', 'source', 'alias', 'sudo', 'grep', 'sed', 'awk', 'cat', 'tail', 'curl', 'ssh', 'scp', 'rsync', 'systemctl', 'docker', 'git', 'npm', 'pnpm', 'node'])
})

/** 常见语言别名。 */
const ALIAS = Object.freeze({
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  py: 'python', python3: 'python',
  jsonc: 'json', json5: 'json'
})

/**
 * HTML 转义。
 * @param {string} value - 原文。
 * @returns {string} 转义结果。
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/* ------------------------------------------------------------------ */
/* 行内                                                                */
/* ------------------------------------------------------------------ */

/** 强调：加粗、斜体、删除线（在已转义文本上做）。 */
function emphasize(text) {
  let out = text
  out = out.replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>')
  out = out.replace(/~~([^~\n]+)~~/gu, '<del>$1</del>')
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/gu, '$1<em>$2</em>')
  return out
}

/**
 * 行内渲染：代码 → 图片 → 链接 → 裸 URL → 强调。
 * 各类替换先进占位符，避免后续规则把已生成的标签再咬一口。
 * @param {string} raw - 原文（未转义）。
 * @returns {string} HTML。
 */
export function renderInline(raw) {
  const store = []
  /** 存一段已生成的 HTML 并返回占位符。 */
  const keep = (html) => {
    store.push(html)
    return `\u0001${store.length - 1}\u0001`
  }
  let text = escapeHtml(raw)
  text = text.replace(/`([^`\n]+)`/gu, (_, code) => keep(`<code>${code}</code>`))
  text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gu, (_, alt, url) => keep(`<img src="${url}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`))
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, (_, label, url) => keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${emphasize(label)}</a>`))
  text = text.replace(/(^|[\s(（])(https?:\/\/[^\s<\u0001，。；：！？、)]+)/gu, (_, lead, url) => `${lead}${keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`)
  text = emphasize(text)
  return text.replace(/\u0001(\d+)\u0001/gu, (_, index) => store[Number(index)])
}

/* ------------------------------------------------------------------ */
/* 代码高亮                                                            */
/* ------------------------------------------------------------------ */

/**
 * JSON 高亮：键、字符串、数字、true/false/null。
 * @param {string} code - 代码。
 * @returns {string} HTML。
 */
function highlightJson(code) {
  const token = /("(?:\\.|[^"\\])*")(\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/gu
  let out = ''
  let last = 0
  for (const match of code.matchAll(token)) {
    const index = match.index ?? 0
    out += escapeHtml(code.slice(last, index))
    if (match[2] !== undefined) {
      out += `<span class="tok-key">${escapeHtml(match[1])}</span><span class="tok-punc">${escapeHtml(match[2])}</span>`
    } else if (match[3] !== undefined) {
      out += `<span class="tok-str">${escapeHtml(match[3])}</span>`
    } else if (match[4] !== undefined) {
      out += `<span class="tok-lit">${match[4]}</span>`
    } else {
      out += `<span class="tok-num">${escapeHtml(match[5])}</span>`
    }
    last = index + match[0].length
  }
  out += escapeHtml(code.slice(last))
  return out
}

/**
 * 通用高亮：注释、字符串、数字、关键字。
 * @param {string} code - 代码。
 * @param {Set<string>} keywords - 关键字表。
 * @returns {string} HTML。
 */
function highlightGeneric(code, keywords) {
  const token = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)/gu
  let out = ''
  let last = 0
  for (const match of code.matchAll(token)) {
    const index = match.index ?? 0
    out += escapeHtml(code.slice(last, index))
    if (match[1] !== undefined) out += `<span class="tok-com">${escapeHtml(match[1])}</span>`
    else if (match[2] !== undefined) out += `<span class="tok-str">${escapeHtml(match[2])}</span>`
    else if (match[3] !== undefined) out += `<span class="tok-num">${escapeHtml(match[3])}</span>`
    else if (keywords.has(match[4])) out += `<span class="tok-kw">${escapeHtml(match[4])}</span>`
    else out += escapeHtml(match[4])
    last = index + match[0].length
  }
  out += escapeHtml(code.slice(last))
  return out
}

/**
 * 按语言给代码上色；不认识的语言原样转义。
 * @param {string} code - 代码。
 * @param {string} language - 语言标签。
 * @returns {string} HTML。
 */
export function highlightCode(code, language) {
  const raw = String(language ?? '').trim().toLowerCase()
  const lang = ALIAS[raw] ?? raw
  if (lang === 'json' && looksLikeJson(code)) return highlightJson(code)
  if (KEYWORDS[lang] !== undefined) return highlightGeneric(code, KEYWORDS[lang])
  return escapeHtml(code)
}

/** 整段是否合法 JSON（不合法就不硬套 JSON 高亮）。 */
function looksLikeJson(text) {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 块                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 围栏代码块（语言头 + 高亮）。
 * @param {string} code - 代码。
 * @param {string} language - 语言。
 * @returns {string} HTML。
 */
export function codeBlock(code, language) {
  const label = language === '' ? 'code' : language
  return `<div class="code"><div class="code-head">${escapeHtml(label)}</div><pre><code>${highlightCode(code, language)}</code></pre></div>`
}

/** 列表项前缀：`-`、`*`、`+`、`1.`、`1)`。 */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u

/**
 * 解析一段列表（含缩进嵌套与任务清单）。
 * @param {ReadonlyArray<string>} lines - 行。
 * @param {number} start - 起始行号。
 * @param {number} baseIndent - 本层缩进。
 * @returns {{html:string, next:number}} 结果。
 */
function parseList(lines, start, baseIndent) {
  const first = lines[start].match(LIST_ITEM)
  const ordered = /^\d/u.test(first[2])
  const items = []
  let i = start
  while (i < lines.length) {
    const match = lines[i].match(LIST_ITEM)
    if (match === null) break
    const indent = match[1].length
    if (indent < baseIndent) break
    if (indent > baseIndent) {
      if (items.length === 0) break
      const nested = parseList(lines, i, indent)
      items[items.length - 1].nested += nested.html
      i = nested.next
      continue
    }
    const isOrdered = /^\d/u.test(match[2])
    if (items.length > 0 && isOrdered !== ordered) break
    let content = match[3]
    let task = ''
    const taskMatch = content.match(/^\[( |x|X)\]\s+/u)
    if (taskMatch !== null) {
      task = `<input type="checkbox" disabled${taskMatch[1].toLowerCase() === 'x' ? ' checked' : ''}> `
      content = content.slice(taskMatch[0].length)
    }
    // 续行：比当前项缩进更深、且不是新的列表项，算同一项的段落。
    const continuation = []
    i += 1
    while (i < lines.length) {
      const next = lines[i]
      if (next.trim() === '') break
      if (LIST_ITEM.test(next)) break
      const deeper = (next.match(/^(\s*)/u)?.[1].length ?? 0) > indent
      if (!deeper) break
      continuation.push(next.trim())
      i += 1
    }
    const body = continuation.length === 0
      ? renderInline(content)
      : `${renderInline(content)}<br>${continuation.map(renderInline).join('<br>')}`
    items.push({ inner: `${task}${body}`, nested: '' })
  }
  const tag = ordered ? 'ol' : 'ul'
  return { html: `<${tag}>${items.map((item) => `<li>${item.inner}${item.nested}</li>`).join('')}</${tag}>`, next: i }
}

/** 表格分隔行：`|---|:--:|`。 */
const TABLE_DELIMITER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/u

/**
 * 按 `|` 切单元格（忽略首尾竖线）。
 * @param {string} line - 表格行。
 * @returns {string[]} 单元格原文。
 */
function splitRow(line) {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim())
}

/**
 * 解析 GFM 表格。
 * @param {ReadonlyArray<string>} lines - 行。
 * @param {number} start - 表头行号。
 * @returns {{html:string, next:number}|null} 结果，不像表格时 null。
 */
function parseTable(lines, start) {
  const header = lines[start]
  const delimiter = lines[start + 1]
  if (header === undefined || delimiter === undefined) return null
  if (!header.includes('|') || !TABLE_DELIMITER.test(delimiter)) return null
  const cells = splitRow(header)
  const aligns = splitRow(delimiter).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return ''
  })
  if (aligns.length !== cells.length) return null
  const rows = []
  let i = start + 2
  while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
    rows.push(splitRow(lines[i]))
    i += 1
  }
  const th = cells.map((cell, index) => `<th${aligns[index] === '' ? '' : ` class="ta-${aligns[index]}"`}>${renderInline(cell)}</th>`).join('')
  const body = rows.map((row) => `<tr>${cells.map((_, index) => `<td${aligns[index] === '' ? '' : ` class="ta-${aligns[index]}"`}>${renderInline(row[index] ?? '')}</td>`).join('')}</tr>`).join('')
  return { html: `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`, next: i }
}

/**
 * 块级渲染。
 * @param {string} text - 原文。
 * @returns {string} HTML。
 */
export function renderBlocks(text) {
  const lines = String(text).replace(/\r\n/gu, '\n').split('\n')
  const html = []
  let i = 0
  let paragraph = []

  const flush = () => {
    if (paragraph.length === 0) return
    html.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/gu, '<br>')}</p>`)
    paragraph = []
  }

  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(/^(```+|~~~+)\s*([^\s`]*)\s*$/u)
    if (fence !== null) {
      flush()
      const marker = fence[1]
      const language = fence[2]
      i += 1
      const buffer = []
      while (i < lines.length && !new RegExp(`^${marker[0] === '`' ? '```+' : '~~~+'}\\s*$`, 'u').test(lines[i])) {
        buffer.push(lines[i])
        i += 1
      }
      i += 1
      html.push(codeBlock(buffer.join('\n'), language))
      continue
    }

    if (line.includes('|') && TABLE_DELIMITER.test(lines[i + 1] ?? '')) {
      const table = parseTable(lines, i)
      if (table !== null) {
        flush()
        html.push(table.html)
        i = table.next
        continue
      }
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/u)
    if (heading !== null) {
      flush()
      const level = Math.min(6, heading[1].length + 1)
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      i += 1
      continue
    }

    if (/^>\s?/u.test(line)) {
      flush()
      const buffer = []
      while (i < lines.length && /^>\s?/u.test(lines[i])) {
        buffer.push(lines[i].replace(/^>\s?/u, ''))
        i += 1
      }
      html.push(`<blockquote>${renderBlocks(buffer.join('\n'))}</blockquote>`)
      continue
    }

    if (LIST_ITEM.test(line)) {
      flush()
      const list = parseList(lines, i, line.match(/^(\s*)/u)[1].length)
      html.push(list.html)
      i = list.next
      continue
    }

    if (/^\s*---+\s*$/u.test(line)) {
      flush()
      html.push('<hr>')
      i += 1
      continue
    }

    if (line.trim() === '') {
      flush()
      i += 1
      continue
    }

    paragraph.push(line)
    i += 1
  }
  flush()
  return html.join('\n')
}
