/**
 * PDF 适配器：把打印版 HTML 在本机转成 PDF。
 *
 * 只用本机 Chromium 内核，不碰云端、不引 npm 依赖：
 *   - Web/Node 宿主（WSL 等）：Playwright 缓存的 chromium → 系统 chrome/chromium
 *   - Windows 桌面宿主：Edge（系统自带，Chromium 内核）→ Chrome
 *   - 显式配置 `chromiumPath` 优先
 *
 * 找不到可执行文件时抛错并给出安装提示，不静默降级成别的格式。
 */

import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 允许的候选路径（含 %ENV% 与 ~ 展开）。 */
function candidates(override) {
  const list = []
  if (typeof override === 'string' && override.trim() !== '') list.push(override.trim())
  if (process.platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA ?? ''
    list.push(
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData === '' ? '' : join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
    )
  } else {
    const home = process.env.HOME ?? ''
    list.push(
      join(home, '.cache', 'ms-playwright', 'current', 'chrome'),
      join(home, '.cache', 'ms-playwright', 'chromium_headless_shell-1254', 'chrome-headless-shell-linux64', 'headless_shell'),
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/snap/bin/chromium'
    )
  }
  return list.filter((item) => item !== '')
}

/**
 * 选一个可用的 Chromium 内核。
 * @param {string} [override] - 配置里的显式路径。
 * @returns {Promise<string|null>} 可执行文件路径。
 */
export async function findChromium(override) {
  for (const candidate of candidates(override)) {
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // 继续试下一个
    }
  }
  return null
}

/**
 * 把 HTML 渲染成 PDF。
 * @param {object} request - 参数。
 * @param {string} request.html - 打印版 HTML。
 * @param {string} request.outPath - 目标 PDF 路径。
 * @param {string} [request.chromiumPath] - 显式 Chromium 路径。
 * @param {number} [request.timeoutMs] - 超时（默认 90s）。
 * @returns {Promise<{bytes:number, chromium:string}>} 结果。
 */
export async function htmlToPdf({ html, outPath, chromiumPath, timeoutMs = 90_000 }) {
  const binary = await findChromium(chromiumPath)
  if (binary === null) {
    throw new Error('找不到本机 Chromium 内核：请安装 Chrome/Edge/Chromium，或在插件配置里填 chromiumPath')
  }
  const workdir = await mkdtemp(join(tmpdir(), 'share-hub-pdf-'))
  const htmlPath = join(workdir, 'doc.html')
  try {
    await writeFile(htmlPath, html, 'utf8')
    const args = [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      '--disable-extensions',
      `--user-data-dir=${join(workdir, 'profile')}`,
      `--print-to-pdf=${outPath}`,
      pathToFileURL(htmlPath).href
    ]
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Chromium 生成 PDF 超时（${Math.round(timeoutMs / 1000)}s）`))
      }, timeoutMs)
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolvePromise()
        else reject(new Error(`Chromium 退出码 ${code}：${stderr.slice(-800)}`))
      })
    })
    void result
    const bytes = await readFile(outPath)
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('Chromium 没有产出有效 PDF（文件头不是 %PDF-）')
    }
    return { bytes: bytes.length, chromium: binary }
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
}
