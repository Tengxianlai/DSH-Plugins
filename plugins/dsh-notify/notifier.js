/**
 * dsh-notify 的平台层：把「系统通知 + 提示音」封成一个可注入的 sink。
 *
 * 为什么在宿主侧也留一条：页面没连着（窗口关了）时没人能出声，只能由宿主
 * 用系统自带的东西补一下。页面连着时声音默认交给页面（见 index.js 的
 * `soundChannel`），因为宿主所在的机器不一定就是用户在看的机器——WSL 里的
 * DSH 没有声卡，浏览器却在 Windows 上。
 *
 * 三个后端，都只 spawn 系统自带的可执行文件，零运行时依赖：
 *   - macOS：`osascript` 发通知 + `afplay` 放系统提示音；
 *   - WSL：经互操作调 `powershell.exe`，`SoundPlayer` 放 `C:\Windows\Media`
 *     里的 wav，WinRT 弹 Toast；
 *   - 其它 Linux：`notify-send` 发通知 + `paplay` 放音（只有绝对路径才放）。
 *
 * 失败只 warn 一次，绝不因为通知发不出去而影响会话本身。
 */
import { spawn as spawnProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** macOS 系统提示音目录（`Ping`、`Glass`、`Submarine` 等都在这里）。 */
const MACOS_SOUND_DIR = '/System/Library/Sounds'

/** WSL/Windows 的提示音目录。 */
const WINDOWS_MEDIA_DIR = 'C:\\Windows\\Media'

/** WSL 上 PowerShell 的常规绝对路径；不在 PATH 里时也能找到。 */
const WINDOWS_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/** Windows Toast 的发送者身份（PowerShell 自己的已注册 AppID）。 */
const WINDOWS_TOAST_APP_ID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 系统里实际存在、且听起来不像报错的几个常用音，供文档与默认值使用。 */
export const SOUND_LABELS = [
  'Glass',
  'Ping',
  'Pop',
  'Tink',
  'Hero',
  'Submarine',
  'Funk',
  'Blow',
  'Bottle',
  'Frog',
  'Morse',
  'Purr',
  'Sosumi',
]

/**
 * WSL 宿主兜底时，四类提醒各自用的 Windows 系统音。
 *
 * 挑的原则和 macOS 一致：完成是清亮的 chimes，出错是下行的 Critical Stop，
 * 审批是短促的 Ding，提问是 Balloon。都取自 `C:\Windows\Media`，不需要随包带音频。
 */
export const WSL_SOUNDS = Object.freeze({
  turn: 'chimes.wav',
  error: 'Windows Critical Stop.wav',
  approval: 'Windows Ding.wav',
  question: 'Windows Balloon.wav',
})

/**
 * 判断宿主是不是跑在 WSL 里。
 *
 * 只看 `process.platform === 'linux'` 不够：WSL 也是 linux，但没有声卡和
 * 通知守护进程，却有 Windows 互操作。先看环境变量，再退回 `/proc/version`。
 *
 * @param {object} [options] - 注入点，自测时替换 `platform` / `env` / `readFile`。
 * @returns {boolean} 是否 WSL。
 */
export function detectWsl({
  platform = process.platform,
  env = process.env,
  readFile = readFileSync,
} = {}) {
  if (platform !== 'linux') return false
  if (typeof env.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME !== '') return true
  try {
    return /microsoft/i.test(readFile('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/**
 * 把配置里的 `sound` 解析成可播放的音频路径。
 *
 * 规则：`none`/空 → 不放音；以 `/` 开头 → 当作绝对路径；其余当作 macOS
 * 系统提示音名（带不带 `.aiff` 都行）。非 macOS 平台只有显式绝对路径才播。
 *
 * @param {unknown} sound - 配置里的提示音值。
 * @param {string} platform - `process.platform`。
 * @returns {string|undefined} 音频文件路径；不放音时为 `undefined`。
 */
export function resolveSound(sound, platform = process.platform) {
  if (typeof sound !== 'string' || sound === '' || sound === 'none') return undefined
  if (sound.startsWith('/')) return sound
  if (platform !== 'darwin') return undefined
  const file = sound.endsWith('.aiff') ? sound : `${sound}.aiff`
  return `${MACOS_SOUND_DIR}/${file}`
}

/**
 * WSL 宿主兜底时该放哪个 Windows wav。
 *
 * 配置里的系统音名是 macOS 的，在 Windows 上没有对应物；这里按提醒类别
 * 选音，忽略具体名字（`none` 仍然表示静音）。绝对路径在 WSL 上不转换，
 * 因为路径得跨文件系统映射，容易在别的机器上出错——要自定义就用页面播放。
 *
 * @param {unknown} sound - 配置里的提示音值。
 * @param {string} [kind] - 提醒类别（`turn`/`error`/`approval`/`question`）。
 * @returns {string|undefined} Windows 下的 wav 路径；不放音时为 `undefined`。
 */
export function windowsSoundPath(sound, kind = 'turn') {
  if (typeof sound !== 'string' || sound === '' || sound === 'none') return undefined
  if (sound.startsWith('/')) return undefined
  const name = WSL_SOUNDS[kind] ?? WSL_SOUNDS.turn
  return `${WINDOWS_MEDIA_DIR}\\${name}`
}

/**
 * 构造 `osascript` 的调用参数。
 *
 * 正文与标题走脚本参数（`on run argv`）而不是拼进脚本文本：会话标题里出现
 * 引号、反斜杠、`\n` 都不会破坏 AppleScript，也不需要转义。
 *
 * @param {string} title - 通知标题。
 * @param {string} body - 通知正文。
 * @param {string} [subtitle] - 可选的副标题（目前未使用，留作扩展）。
 * @returns {string[]} 可直接交给 `spawn('/usr/bin/osascript', args)` 的参数。
 */
export function notificationArgs(title, body, subtitle) {
  const hasSubtitle = typeof subtitle === 'string' && subtitle !== ''
  const command = hasSubtitle
    ? 'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)'
    : 'display notification (item 1 of argv) with title (item 2 of argv)'
  const script = ['on run argv', command, 'end run'].flatMap((line) => ['-e', line])
  return [...script, '--', body, title, ...(hasSubtitle ? [subtitle] : [])]
}

/**
 * 把 PowerShell 脚本编码成 `-EncodedCommand` 的参数。
 *
 * 为什么要编码：会话标题里可能有引号、反引号、`$`、中文，直接拼进命令行
 * 会被 PowerShell 或 WSL 互操作用坏；UTF-16LE base64 是 PowerShell 自己的
 * 转义方式，跨层不需要再加引号。
 *
 * @param {string} script - PowerShell 脚本正文。
 * @returns {string} base64（UTF-16LE）。
 */
export function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * 构造 `powershell.exe` 的通用参数。
 *
 * @param {string} script - PowerShell 脚本正文。
 * @returns {string[]} 可直接交给 `spawn(powershell, args)` 的参数。
 */
export function powershellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)]
}

/**
 * WSL 放音脚本：`SoundPlayer` 只认 wav，`PlaySync` 让进程活到放完为止
 * （用 `Play()` 的话 PowerShell 退出会把声音掐掉）。
 *
 * @param {string} wavPath - Windows 路径，例如 `C:\Windows\Media\chimes.wav`。
 * @returns {string} PowerShell 脚本。
 */
export function windowsSoundScript(wavPath) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$player = New-Object System.Media.SoundPlayer ${powershellLiteral(wavPath)}`,
    '$player.PlaySync()',
  ].join('\n')
}

/**
 * WSL 通知脚本：用 WinRT 弹一条 Toast。
 *
 * 标题与正文先 base64（UTF-8）再以字面量写进脚本，正文落在脚本里是纯
 * `[A-Za-z0-9+/=]`，怎么都不会被引号/换行破坏。Toast 的发送者显示为
 * 「Windows PowerShell」——横幅图标改不了，页面连着时不用这条通道。
 *
 * @param {string} title - 通知标题。
 * @param {string} body - 通知正文。
 * @returns {string} PowerShell 脚本。
 */
export function windowsToastScript(title, body) {
  const payload = (text) => Buffer.from(String(text ?? ''), 'utf8').toString('base64')
  return [
    '$ErrorActionPreference = "Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    `$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${payload(title)}"))`,
    `$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${payload(body)}"))`,
    '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$texts = $template.GetElementsByTagName("text")',
    '$texts.Item(0).AppendChild($template.CreateTextNode($title)) > $null',
    '$texts.Item(1).AppendChild($template.CreateTextNode($body)) > $null',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($template)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("${WINDOWS_TOAST_APP_ID}").Show($toast)`,
  ].join('\n')
}

/**
 * 把字符串写成 PowerShell 单引号字面量（单引号本身用两个单引号转义）。
 *
 * @param {string} value - 原值。
 * @returns {string} 可直接拼进脚本的字面量。
 */
function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * 找 `powershell.exe`：优先已挂载的绝对路径（不依赖 `appendWindowsPath`），
 * 找不到就交给 PATH。
 *
 * @param {object} [options] - 注入点，自测时替换 `exists`。
 * @returns {string} 可执行文件路径或命令名。
 */
export function resolveWindowsPowerShell({ exists = existsSync } = {}) {
  return exists(WINDOWS_POWERSHELL) ? WINDOWS_POWERSHELL : 'powershell.exe'
}

/**
 * 创建通知 sink。
 *
 * @param {object} [options] - 注入点，自测时把 `spawn` 换成假的。
 * @param {string} [options.platform] - 平台；默认 `process.platform`。
 * @param {boolean} [options.wsl] - 是否 WSL；默认自动探测。
 * @param {string} [options.powershell] - `powershell.exe` 路径；默认自动解析。
 * @param {Function} [options.spawn] - 启动子进程的函数；默认 `child_process.spawn`。
 * @param {object} [options.logger] - 宿主 logger，用于一次性告警。
 * @returns {{notify: Function, play: Function, post: Function, supported: boolean, wsl: boolean}}
 */
export function createNotifier({
  platform = process.platform,
  wsl = detectWsl({ platform }),
  powershell = resolveWindowsPowerShell(),
  spawn = spawnProcess,
  logger,
} = {}) {
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      logger?.warn?.('dsh-notify: %s', message)
    } catch {
      /* logger 不可用就算了，通知失败不该冒泡到会话 */
    }
  }

  const run = (command, args) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true })
      // 子进程启动失败（命令不存在等）走 error 事件；不挂监听会变成未捕获异常。
      child?.on?.('error', () => warnOnce(`${command} 启动失败`))
      child?.unref?.()
    } catch {
      warnOnce(`${command} 启动失败`)
    }
  }

  return {
    supported: platform === 'darwin' || platform === 'linux',
    wsl,
    /**
     * 只放提示音（宿主侧播放，不依赖页面）。
     *
     * @param {string|undefined} sound - 提示音名或绝对路径；`none`/空表示不放。
     * @param {string} [kind] - 提醒类别，WSL 上用来挑 Windows 系统音。
     */
    play(sound, kind = 'turn') {
      if (platform === 'darwin') {
        const path = resolveSound(sound, platform)
        if (path === undefined) return
        run('/usr/bin/afplay', [path])
        return
      }
      if (wsl) {
        if (typeof sound === 'string' && sound.startsWith('/')) {
          warnOnce('WSL 宿主兜底不支持自定义音频路径，请把声音交给页面播放')
          return
        }
        const path = windowsSoundPath(sound, kind)
        if (path === undefined) return
        run(powershell, powershellArgs(windowsSoundScript(path)))
        return
      }
      if (platform === 'linux') {
        const path = resolveSound(sound, platform)
        if (path === undefined) return
        run('paplay', [path])
      }
    },
    /**
     * 只发系统通知横幅（**不带音效**：音效由 {@link play} 单独放，避免响两声）。
     *
     * 注意：横幅上的图标由「谁发出的通知」决定——`osascript` / PowerShell 发出去
     * 的会显示各自的图标。想要 DSH 的鲸鱼图标，横幅要走页面里的 `Notification`
     * API（浏览器半体），宿主这条只在本机没有页面连接时兜底。
     *
     * @param {{title: string, body: string}} payload - 标题与正文。
     */
    post({ title, body }) {
      if (platform === 'darwin') {
        run('/usr/bin/osascript', notificationArgs(title, body))
        return
      }
      if (wsl) {
        run(powershell, powershellArgs(windowsToastScript(title, body)))
        return
      }
      if (platform === 'linux') {
        run('notify-send', [title, body])
        return
      }
      warnOnce(`平台 ${platform} 没有内置的系统通知通道`)
    },
    /**
     * 通知 + 提示音（两者都由宿主发出，图标不是 DSH 的）。
     *
     * @param {{title: string, body: string, sound?: string, kind?: string}} payload - 标题、正文与提示音。
     */
    notify({ title, body, sound, kind }) {
      this.post({ title, body })
      this.play(sound, kind)
    },
  }
}
