/* eslint-disable */
/**
 * dsh-notify —— 浏览器半边。
 *
 * 只做一件事：接住宿主推来的 SSE 横幅帧，用页面的 `Notification` API 弹系统通知。
 *
 * 为什么横幅必须在页面里弹：macOS 通知横幅上的图标由「谁发出的通知」决定。
 * 宿主用 `osascript` 发出去只会显示脚本编辑器的图标；页面里的 `Notification`
 * 走的是 DSH 自己的 App 身份，横幅上就是那条鲸鱼。点击横幅时把窗口拉回前台。
 *
 * 提示音不在这里放：网页面拿不到 `/System/Library/Sounds`，且后台标签会被节流；
 * 声音由宿主用 `afplay` 播（声音和横幅是两条独立的通道，同时发生）。
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
     * 弹一条系统通知；点了把窗口拉回前台。
     * @param {object} payload - 宿主推来的 `{ title, body, kind }`。
     * @param {Function} [focus] - 聚焦窗口的动作，自测时注入。
     */
    function show(payload, focus = () => { try { window.focus() } catch { /* 浏览器可能不允许 */ } }) {
      if (typeof Notification === 'undefined') return undefined
      // 'default' 在桌面应用里已经由宿主授权放行；只有明确拒绝才不发。
      if (Notification.permission === 'denied') return undefined
      const title = typeof payload?.title === 'string' ? payload.title : ''
      const body = typeof payload?.body === 'string' ? payload.body : ''
      if (title === '') return undefined
      let notification
      try {
        notification = new Notification(title, { body, silent: true, tag: TAG })
      } catch {
        // 权限被拦或在不受支持的上下文里构造失败：静默放弃，声音仍在。
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
     * 客户端插件体：订阅宿主横幅通道。
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      if (typeof EventSource === 'undefined') return
      ctx.effect(() => {
        const source = new EventSource(EVENTS_PATH)
        const onMessage = (event) => {
          const payload = parseFrame(event.data)
          if (payload !== undefined) show(payload)
        }
        source.addEventListener('message', onMessage)
        return () => {
          source.removeEventListener('message', onMessage)
          source.close()
        }
      }, 'dsh-notify: banner stream')
    }

    exports.name = 'notify'
    exports.apply = apply
    exports.show = show
    exports.parseFrame = parseFrame
    exports.EVENTS_PATH = EVENTS_PATH
    return exports
  }
})
