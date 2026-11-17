# dsh-notify

会话需要你回来时，在系统里发一条通知 + 一声提示音，不用一直盯着窗口。

四类时机，**各有各的音效**，也各自能关：

| 时机 | 触发点 | 标题 | 页面合成的音色（默认） |
|---|---|---|---|
| 本轮完成 | `session/event` 的 `turn/end`（用 `turn/start` 算耗时） | `本轮完成 · <会话标题>` / `用时 3 分 20 秒` | A5→E6 两声上行，像木琴 |
| 本轮出错 | 同上，`reason.kind === 'error'` | `本轮出错 · <会话标题>` / `出错：provider 500` | G4→C4 两声下行，闷 |
| 等待审批 | `approval/request` 瀑布里旁听，再把决定权交回 `next()` | `需要审批 · <会话标题>` / `bash 等待你的决定：写沙箱外文件` | 640→426 Hz 慢速下滑，像声呐 |
| 等待回答 | `user-questions/request` 同上 | `等待回答 · <会话标题>` / `用 pnpm 还是 npm？` | C6→G6 两个短促高音 |

不用看屏幕，听一声就知道是「干完了」「炸了」还是「等你点头」。

会话标题优先取 `sessionTitle` 服务（和侧栏显示的一致），取不到就用工作目录名。

以下几类 `turn/end` 故意不响：`aborted`（你自己按了停止，人就在跟前）、`forked`（fork 复制历史）、
`interrupted`（崩溃后补写的关闭标记）。

## 两条通道：横幅走页面，声音跟着屏幕走

通知横幅上的图标由**发出这条通知的 App** 决定，任何参数都改不了；而**声音必须从你面前那台
设备出来**——宿主可能跑在 WSL、容器或远程服务器上，根本没有声卡。所以这个插件是 host + web
两个半体，各管一头：

```
host 监听 cordis 事件 ──横幅──▶ SSE /plugins/dsh-notify/events ──▶ 页面 Notification（鲸鱼图标）
                     └─声音──▶ 页面连着：页面 Web Audio 合成（在你的浏览器所在的设备响）
                               页面没连着：宿主兜底
                                 macOS  → afplay /System/Library/Sounds/<name>.aiff
                                 WSL    → powershell.exe SoundPlayer 放 C:\Windows\Media\*.wav
                                 Linux  → paplay <绝对路径>
```

为什么声音不永远交给宿主：WSL 里的 DSH 没有声卡，`afplay`/`paplay`/`notify-send` 一个都没有；
浏览器却一定在用户的 Windows 桌面上。反过来，页面关掉时没人能出声，才由宿主经系统通道兜底。

**macOS 例外**：`soundChannel: auto` 时，macOS 宿主保留原来的 `afplay` 原生提示音，页面不重复
发声——这样 Mac 桌面端一直是原来那套 `Glass`/`Basso`/`Submarine`/`Ping`，不因为升级插件换音色。
页面连着但宿主是 macOS、而你其实在另一台设备上看时，把 `soundChannel` 设成 `page`。

## 平台矩阵

| 场景 | 横幅 | 声音 |
|---|---|---|
| macOS 桌面应用（宿主与页面同一台 Mac） | 页面 Notification（DSH 鲸鱼图标） | 宿主 `afplay` 系统提示音 |
| Windows 浏览器 → WSL 里的 DSH | 页面 Notification（Chrome/Edge 通知） | 页面 Web Audio（四类固定音色） |
| 浏览器关掉、应用还在后台 | 宿主兜底：WSL 弹 PowerShell Toast；macOS `osascript`；Linux `notify-send` | 宿主兜底（同上，WSL 放 `C:\Windows\Media` 的 wav） |
| 远程浏览器连别的机器上的宿主 | 页面 Notification | `auto` 时由页面发声；`host` 时在宿主那台机器响 |

WSL 兜底依赖 Windows 互操作（默认开启，`/etc/wsl.conf` 里 `interop.enabled` 不能是 `false`）。
插件只 spawn 系统自带命令，零运行时依赖；`powershell.exe` 缺失或互操作被关时只 warn 一次，
页面那条通道不受影响。

## 第一次使用：手势与权限

浏览器的两条策略需要一次用户交互：

1. **AudioContext 需要用户手势才能出声**——第一次点击/按键页面时插件顺手解锁，之后后台标签
   也能正常发声（音频不被节流）。
2. **通知权限**——桌面应用已预授权；普通浏览器第一次需要允许 `dsh.soarteng.cn` 发通知，插件会
   在首次点击时申请。拒绝了就只有声音，没有横幅。

如果某次提醒到达时页面还没解锁音频，插件不会把声音排队（免得之后一起炸出来），而是让**系统
通知自己响一声**（`silent: false`）作为兜底。

## 配置

默认值即开箱可用。要改就在 profile 的 `cordis.patch.yml` 里按行 id `notify` 覆盖：

```yaml
- id: notify
  name: dsh-notify
  config:
    minTurnSeconds: 45          # 只有跑超过 45 秒的回合才吵我
    soundChannel: host          # 声音固定在宿主放（页面只弹横幅）
    sounds:
      turn: Hero                # macOS 宿主换成更隆重的
      error: Funk               # macOS 宿主换成更刺耳的
      approval: Submarine       # 没写的那两类保持默认
    includeSubagents: false
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `turnEnd` | `true` | 本轮结束（含出错）时提醒 |
| `approval` | `true` | 有工具调用等待审批时提醒 |
| `question` | `true` | 智能体在等你回答（`ask_user_question` 等）时提醒 |
| `sounds.turn` | `'Glass'` | 宿主通道的本轮完成音效 |
| `sounds.error` | `'Basso'` | 宿主通道的本轮出错音效 |
| `sounds.approval` | `'Submarine'` | 宿主通道的等待审批音效 |
| `sounds.question` | `'Ping'` | 宿主通道的等待回答音效 |
| `sound` | 无 | 一刀切：写一个就把四类统一成它（`none` = 只发通知不响） |
| `soundChannel` | `'auto'` | `auto` 页面优先（macOS 宿主保留原生音）；`page` 永远页面发声；`host` 永远宿主发声 |
| `minTurnSeconds` | `15` | 短于该秒数的回合不提醒；`0` = 每轮都提醒 |
| `includeSubagents` | `false` | 子代理会话是否也提醒；默认只有根会话响，否则一次任务会被子代理刷屏 |
| `dedupeSeconds` | `5` | 同一会话内两次提醒的最小间隔（只作用于「本轮完成/出错」；审批和提问总是立刻提醒） |

`sounds.*` 是**宿主通道**的音效：macOS 系统提示音名（`/System/Library/Sounds/` 下的，`ls` 一下
就有）、任意音频文件绝对路径，或 `none`。可选名字：`Basso` `Blow` `Bottle` `Frog` `Funk` `Glass`
`Hero` `Morse` `Ping` `Pop` `Purr` `Sosumi` `Submarine` `Tink`。

在页面通道（Windows 浏览器 + WSL 宿主、或 `soundChannel: page`）里，四类提醒用上面表格里的固定
合成音色，这样不带音频素材、不依赖宿主文件；`none` 仍然能静音。宿主的自定义绝对路径只对宿主
通道生效——WSL 上路径还要跨文件系统映射，所以不做转换，配了会 warn 一次。

为什么有 `minTurnSeconds`：宿主看不见你此刻是不是正盯着这个会话，所以用回合耗时当代理——
几秒钟就答完的回合多半是你正在看的那一轮，不吵；跑久了的才提醒。

## 图标

- **通知横幅**：桌面应用里是 DSH 自己的鲸鱼图标（横幅由页面发出，见上）；浏览器里是浏览器自己的
  通知外观；宿主兜底时是「脚本编辑器」/「Windows PowerShell」的图标。
- **Plugins 页面里的这一行**：`icon.svg`，同样是那条鲸鱼（取自 `dsh-web-frontend` 的 favicon 矢量），
  青绿 `#2f6f6a`，深色主题下自动转米白。

## 安装与生效

新装走 Plugins 页面或 `plugin_manager install_bundle`（target 用本目录绝对路径）。装完**必须重启 dsh-web**：
宿主半边的路由在启动时注册，浏览器半边的 `client.js` 也在启动时进模块图。

- 桌面应用（`Electron`）：页面里的通知由宿主已授权的会话放行，不需要额外点允许。
- 用浏览器直接开：第一次需要在浏览器里允许该站点发通知，否则只有声音（插件会在首次点击时申请）。
- WSL 宿主：确认 `/mnt/c` 已挂载、Windows 互操作可用；`powershell.exe` 会在需要宿主兜底时才启动。

其它平台：原生 Linux 用 `notify-send` + `paplay`（提示音只在音效配成绝对路径时用 `paplay` 播）；
Windows 上的 DSH 宿主暂不支持，社区里 `@99galaxy/dsh-turn-notify` 是 Windows 版。

## 已知取舍

- **页面关掉时横幅图标退回脚本编辑器 / Windows PowerShell**：没有人替页面发通知，只能由宿主发。
- **页面关掉时声音也可能没有**：Linux 没装 `paplay`、WSL 互操作被关时，宿主兜底放不出声。
- **页面必需一次手势**：从没点过页面就到达的提醒，声音退回系统通知的默认提示音。
- **看不见焦点**：窗口就在眼前、你正看着这一轮，超过门槛的回合也会响。嫌吵就调大 `minTurnSeconds`。
- **只认宿主事件**：DSH 宿主进程没跑（应用整个退出）时不会有任何通知。
- **旁听不改变审批语义**：插件只观察 `approval/request`，永远 `next()` 下去；审批策略、自动审查等
  其它 answerer 的行为不受影响。
- **多开窗口**：每个页面各连一条 SSE，各自弹通知、各自发声。

## 自测

```sh
node --check index.js && node --check notifier.js && node --check client.js
node test/host.test.mjs
node test/client.test.mjs
```

自测全部在假 ctx / 假 notifier / 假 EventSource / 假 AudioContext / 假 spawn 上跑，不弹通知也不放音；
`node test/client.test.mjs` 会核对四类音色与静音/兜底逻辑。

### 在浏览器里跑 10 条真机自测

想知道 Windows/桌面端的横幅和提示音到底通不通，用这个 opt-in 模式（不带 hash 时完全不生效）：

1. 地址后面加 `#dsh-notify-test`，例如 `https://dsh.soarteng.cn/#dsh-notify-test`，回车后**刷新一次**
   （`client.js` 在 dsh-web 启动时读盘，改了插件必须重启 dsh-web，再刷新页面）。
2. 在页面上点一下：这一步会解锁 AudioContext 并弹出通知权限，允许它。
3. 2.5 秒后开始，**每 10 秒一条，四类轮流，共 10 条**；走的是和真实提醒完全相同的
   `handle()` 路径（页面横幅 + Web Audio 提示音），控制台会打印 `【自测 i/10】`。

自测只影响这一次页面加载；关掉或重新打开不带 hash 的地址就恢复原样。
