# dsh-notify

会话需要你回来时，在系统里发一条通知 + 一声提示音，不用一直盯着窗口。

四类时机，**各有各的音效**，也各自能关：

| 时机 | 触发点 | 标题 | 默认音效 |
|---|---|---|---|
| 本轮完成 | `session/event` 的 `turn/end`（用 `turn/start` 算耗时） | `本轮完成 · <会话标题>` / `用时 3 分 20 秒` | `Glass`（清亮） |
| 本轮出错 | 同上，`reason.kind === 'error'` | `本轮出错 · <会话标题>` / `出错：provider 500` | `Basso`（低音，像出错） |
| 等待审批 | `approval/request` 瀑布里旁听，再把决定权交回 `next()` | `需要审批 · <会话标题>` / `bash 等待你的决定：写沙箱外文件` | `Submarine`（声呐） |
| 等待回答 | `user-questions/request` 同上 | `等待回答 · <会话标题>` / `用 pnpm 还是 npm？` | `Ping`（短促） |

不用看屏幕，听一声就知道是「干完了」「炸了」还是「等你点头」。

会话标题优先取 `sessionTitle` 服务（和侧栏显示的一致），取不到就用工作目录名。

以下几类 `turn/end` 故意不响：`aborted`（你自己按了停止，人就在跟前）、`forked`（fork 复制历史）、
`interrupted`（崩溃后补写的关闭标记）。

## 两条通道：横幅走页面，声音走宿主

macOS 通知横幅上的图标，由**发出这条通知的 App** 决定，任何参数都改不了：

- 宿主侧用 `osascript` 发，横幅显示的是「脚本编辑器」的图标（不是 DSH）；
- 页面里的 `Notification` API 走的是 DSH 自己的 App 身份，横幅上是**那条鲸鱼**，
  点击横幅还能把窗口拉回前台。

所以这个插件是 host + web 两个半体：

```
host 监听 cordis 事件 ──声音──▶ afplay /System/Library/Sounds/<name>.aiff
                     └─横幅──▶ SSE /plugins/dsh-notify/events ──▶ 页面 Notification（鲸鱼图标）
                     └─没人连着时兜底──▶ osascript 系统通知（脚本编辑器图标）
```

页面连着时用页面弹横幅（图标正确、可点击聚焦）；页面没连着（窗口关了、应用还在 Dock 里）时，
自动退回宿主发的系统通知——图标改不了，但至少能看见。声音永远走宿主：
页面拿不到 `/System/Library/Sounds`，后台标签还会被节流。

## 配置

默认值即开箱可用。要改就在 profile 的 `cordis.patch.yml` 里按行 id `notify` 覆盖：

```yaml
- id: notify
  name: dsh-notify
  config:
    minTurnSeconds: 45          # 只有跑超过 45 秒的回合才吵我
    sounds:
      turn: Hero                # 完成换成更隆重的
      error: Funk               # 出错换成更刺耳的
      approval: Submarine       # 没写的那两类保持默认
    includeSubagents: false
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `turnEnd` | `true` | 本轮结束（含出错）时提醒 |
| `approval` | `true` | 有工具调用等待审批时提醒 |
| `question` | `true` | 智能体在等你回答（`ask_user_question` 等）时提醒 |
| `sounds.turn` | `'Glass'` | 本轮完成的音效 |
| `sounds.error` | `'Basso'` | 本轮出错的音效 |
| `sounds.approval` | `'Submarine'` | 等待审批的音效 |
| `sounds.question` | `'Ping'` | 等待回答的音效 |
| `sound` | 无 | 一刀切：写一个就把四类统一成它（`none` = 只发通知不响） |
| `minTurnSeconds` | `15` | 短于该秒数的回合不提醒；`0` = 每轮都提醒 |
| `includeSubagents` | `false` | 子代理会话是否也提醒；默认只有根会话响，否则一次任务会被子代理刷屏 |
| `dedupeSeconds` | `5` | 同一会话内两次提醒的最小间隔（只作用于「本轮完成/出错」；审批和提问总是立刻提醒） |

音效值可以是：macOS 系统提示音名（`/System/Library/Sounds/` 下的，`ls` 一下就有）、
任意音频文件绝对路径，或 `none`。可选名字：`Basso` `Blow` `Bottle` `Frog` `Funk` `Glass`
`Hero` `Morse` `Ping` `Pop` `Purr` `Sosumi` `Submarine` `Tink`。

为什么有 `minTurnSeconds`：宿主看不见你此刻是不是正盯着这个会话，所以用回合耗时当代理——
几秒钟就答完的回合多半是你正在看的那一轮，不吵；跑久了的才提醒。

## 图标

- **通知横幅**：桌面应用里是 DSH 自己的鲸鱼图标（横幅由页面发出，见上）。
- **Plugins 页面里的这一行**：`icon.svg`，同样是那条鲸鱼（取自 `dsh-web-frontend` 的 favicon 矢量），
  青绿 `#2f6f6a`，深色主题下自动转米白。

## 安装与生效

新装走 Plugins 页面或 `plugin_manager install_bundle`（target 用本目录绝对路径）。装完**必须重启 dsh-web**：
宿主半边的路由在启动时注册，浏览器半边的 `client.js` 也在启动时进模块图。

- 桌面应用（`Electron`）：页面里的通知由宿主已授权的会话放行，不需要额外点允许。
- 用浏览器直接开 `http://127.0.0.1:<port>`：第一次需要在浏览器里允许该站点发通知，否则只有声音。
- 第一次响的时候，macOS 可能弹「DeepSeek Harness 想发送通知」——允许即可；拒绝的话横幅不显示，
  提示音仍然会响（`afplay` 不需要授权）。

其它平台：Linux 走 `notify-send`（提示音只在音效配成绝对路径时用 `paplay` 播）；
Windows 暂不支持，社区里 `@99galaxy/dsh-turn-notify` 是 Windows 版。

## 已知取舍

- **窗口关掉时横幅图标退回脚本编辑器**：应用还在 Dock 里跑、但没有页面连接，只能由宿主发通知。
  声音不受影响。
- **看不见焦点**：窗口就在眼前、你正看着这一轮，超过门槛的回合也会响。嫌吵就调大 `minTurnSeconds`。
- **只认宿主事件**：DSH 宿主进程没跑（应用整个退出）时不会有任何通知。
- **旁听不改变审批语义**：插件只观察 `approval/request`，永远 `next()` 下去；审批策略、自动审查等
  其它 answerer 的行为不受影响。
- **多开窗口**：每个页面各连一条 SSE，各自弹各自的通知。

## 自测

```sh
node --check index.js && node --check client.js
node test/host.test.mjs
node test/client.test.mjs
```

自测全部在假 ctx / 假 notifier / 假 EventSource / 假 spawn 上跑，不弹通知也不放音。
