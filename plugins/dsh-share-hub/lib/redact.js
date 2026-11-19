/**
 * 脱敏：把常见凭据形态与本机绝对路径替换掉。
 *
 * 尽力而为，不是保证：业务机密、客户名、内网 IP 挡不住。UI 里必须如实提示。
 * 顺序有讲究：先长模式后短模式，避免 `sk-` 把 `sk-ant-` 拆坏。
 */

/** @type {ReadonlyArray<{re: RegExp, replacement: string}>} */
const RULES = Object.freeze([
  // PEM 私钥块：整块替换，跨行匹配。
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, replacement: '[REDACTED:private-key]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/gu, replacement: '[REDACTED:aws-key]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, replacement: '[REDACTED:github-token]' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/gu, replacement: '[REDACTED:anthropic-key]' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/gu, replacement: '[REDACTED:api-key]' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/gu, replacement: 'Bearer [REDACTED:token]' },
  { re: /\b(api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}["']?/giu, replacement: '$1: [REDACTED]' },
  // 本机绝对路径：/home/<user>/… 与 /Users/<user>/…
  { re: /\/home\/[A-Za-z0-9._-]+/gu, replacement: '~' },
  { re: /\/Users\/[A-Za-z0-9._-]+/gu, replacement: '~' },
  // Windows 用户目录
  { re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/gu, replacement: '~' }
])

/**
 * 对一段文本做脱敏。
 * @param {string} text - 原始文本。
 * @returns {string} 脱敏后的文本。
 */
export function redact(text) {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const rule of RULES) out = out.replace(rule.re, rule.replacement)
  return out
}

/**
 * 对消息数组逐条脱敏（只处理字符串字段）。
 * @param {ReadonlyArray<object>} messages - 规范化后的消息。
 * @returns {object[]} 新数组，原数组不变。
 */
export function redactMessages(messages) {
  return messages.map((message) => ({
    ...message,
    text: redact(message.text),
    reasoning: message.reasoning === undefined ? undefined : redact(message.reasoning),
    tools: message.tools.map((tool) => ({
      ...tool,
      arguments: redact(tool.arguments)
    })),
    results: message.results.map((result) => redact(result))
  }))
}
