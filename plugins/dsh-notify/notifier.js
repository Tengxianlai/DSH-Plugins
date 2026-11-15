/**
 * dsh-notify 的平台层：把「系统通知 + 提示音」封成一个可注入的 sink。
 *
 * 为什么在宿主侧做：页面里的 Notification API 受通知权限、焦点策略和
 * 音频自动播放策略三重限制，而且窗口关掉就没了。宿主进程用系统自带的
 * `osascript` / `afplay` 发通知与放音，不受这些限制，也不需要浏览器授权。
 *
 * 只 spawn 系统自带可执行文件，零运行时依赖；失败只 warn 一次，绝不因为
 * 通知发不出去而影响会话本身。
 */
import { spawn as spawnProcess } from 'node:child_process'

/** macOS 系统提示音目录（`Ping`、`Glass`、`Submarine` 等都在这里）。 */
const MACOS_SOUND_DIR = '/System/Library/Sounds'

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
 * 创建通知 sink。
 *
 * @param {object} [options] - 注入点，自测时把 `spawn` 换成假的。
 * @param {string} [options.platform] - 平台；默认 `process.platform`。
 * @param {Function} [options.spawn] - 启动子进程的函数；默认 `child_process.spawn`。
 * @param {object} [options.logger] - 宿主 logger，用于一次性告警。
 * @returns {{notify: (event: {title: string, body: string, sound?: string}) => void, supported: boolean}}
 */
export function createNotifier({ platform = process.platform, spawn = spawnProcess, logger } = {}) {
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
    /**
     * 只放提示音（宿主侧播放，不依赖页面）。
     * @param {string|undefined} sound - 提示音名或绝对路径；`none`/空表示不放。
     */
    play(sound) {
      const path = resolveSound(sound, platform)
      if (path === undefined) return
      if (platform === 'darwin') run('/usr/bin/afplay', [path])
      else if (platform === 'linux') run('paplay', [path])
    },
    /**
     * 只发系统通知横幅（**不带音效**：音效由 {@link play} 单独放，避免响两声）。
     *
     * 注意：横幅上的图标由「谁发出的通知」决定——`osascript` 发出去的会显示
     * 脚本编辑器的图标。想要 DSH 的鲸鱼图标，横幅要走页面里的 Notification
     * API（浏览器半体），宿主这条只在本机没有页面连接时兜底。
     *
     * @param {{title: string, body: string}} payload - 标题与正文。
     */
    post({ title, body }) {
      if (platform === 'darwin') {
        run('/usr/bin/osascript', notificationArgs(title, body))
      } else if (platform === 'linux') {
        run('notify-send', [title, body])
      } else {
        warnOnce(`平台 ${platform} 没有内置的系统通知通道`)
      }
    },
    /**
     * 通知 + 提示音（两者都由宿主发出，图标是脚本编辑器的）。
     * @param {{title: string, body: string, sound?: string}} payload - 标题、正文与提示音。
     */
    notify({ title, body, sound }) {
      this.post({ title, body })
      this.play(sound)
    },
  }
}
