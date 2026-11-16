# 02 · Codex 阶段与 DeepSeek 阶段：按模型事件核实

> 用户的原话是：「这不是你的错误，因为我中途换了 DeepSeek，你工作的时候是严谨的，会仔细核对这些参数，但是 DeepSeek 没有，它非常喜欢想当然。」（`session-78b8ee8a…` seq2139，2026-11-16 18:13:09）
> 本文只做一件事：**用日志里的模型事件把「谁在什么时间做了什么」分清**，并把「想当然」拆成可核实的机制，而不是给模型贴性格标签。

## 1. 归因方法（可复现）

1. `model/selection` 事件 = 用户/系统切换主模型，带 `seq` 与 `time`；
2. `request/header` 事件 = 每一次真实请求携带的 `provider/model/reasoningEffort`，用它给**每个 turn/step** 定位实际模型；
3. `assistant/message`、`tool/call`、`tool/result` 都带 `turn`/`seq`，据此把工具调用归到具体模型；
4. `compaction/summary` 事件 = 上下文被压缩替换，**换模型前后是否丢了不变量**必须单独核。

一个必须避免的错法：**按会话最后的模型给全程归因**。本项目的三个大会话都中途换过主模型，按会话归因会把 Codex 阶段的错算到 DeepSeek 头上，也会把 DeepSeek 阶段的纠正算给 Codex。

## 2. 有主模型切换的会话（全部，按时间）

| 会话 | 切换时间 | seq | 从 → 到 | 切点前/后各多少 turn |
|---|---|---|---|---|
| `session-3baf3ca6…` | 11-12 00:57:10 | 225/226 | `teamorouter-responses/gpt-6.1-sol` → `opendesign/deepseek-v4.1-flash`（eff max） | 切点前 1 turn，其后 18 turns 全 DeepSeek |
| `session-0f6eac2a…` | 11-12 21:14:56 | 454/455 | `opencode-go-gemini/gemini-4-argon` → `teamorouter-gemini/gemini-4-argon` | 同族换路由 |
| `session-08abaa6c…` | 11-13 02:38:01 | 7 | `magpie/auto/deepseek-v4.1-flash` → `magpie/teamorouter/gemini-4-carbon` | 资产卡 → Gemini |
| `session-71b7af9a…` | 11-13 06:20:02 / 06:43:12 / 06:49:12 | 259 / 260 / 279 | gemini-4-argon → gemini-4-argon(teamorouter) → gemini-4-carbon → gemini-4-argon | 路由抖动 |
| `session-05141dcc…` | 11-13 06:50:44 | 6 | `gemini-3.8-flash` → `gemini-4-carbon` | — |
| `session-9e5b4806…` | **11-16 01:24:24** | 3384 | `magpie/codex/gpt-6.1-sol`（eff high）→ `deepseek-official/deepseek-flash` | 切点前大量生产/交接工作，其后为 DeepSeek |
| `session-213b3228…` | **11-16 10:13:19** | 3714/3716 | `magpie/codex/gpt-6.1-sol`（eff high）→ `deepseek-official/deepseek-flash`（eff max） | **切点前 4 turns（02:44–10:13），其后 7 turns（10:13–11:0x）** |

其余会话没有 `model/selection` 事件：它们要么是子代理会话（继承父会话的 `magpie/auto/deepseek-v4.1-flash`，见项目 AGENTS.md 的「子代理一律用 magpie 的 deepseek flash」规则），要么是单次小会话。**子代理的措辞不能当成主模型行为**。

## 3. `session-213b3228…` 的逐 turn 归因（本审计的核心样本）

| turn | 时间范围 | 实际模型（`request/header` 实测） | 该 turn 里发生了什么 |
|---|---|---|---|
| 1 | 02:44–03:2x | `magpie/codex/gpt-6.1-sol` | 接手、读项目、9 次空字段 `video_generate` 失败、Gemini 设计请求 fetch failed、改为子代理稀疏参数下单成功 |
| 2 | 03:3x–04:1x | `magpie/codex/gpt-6.1-sol` | 生产编排（B1–B7）、Gemini 审片、`attempt` 报错 `max_tokens 700` |
| 3 | 05:4x–07:4x | `magpie/codex/gpt-6.1-sol` | v01 审片→v02 反馈→Gemini 12MB 超限；4 次 regen 源模式失败（07:57） |
| 4 | 07:4x–10:11 | `magpie/codex/gpt-6.1-sol` | v03 修复、2K 报价、**10:11:18 上下文压缩（seq3688）** |
| 5 | 10:13–10:2x | `deepseek-official/deepseek-flash` | 换模型后第一个 turn：读帧、接着做海报 |
| 6 | 10:27–10:37 | deepseek-flash | 海报 3 次 `image_generate`（含 1 次 `Error: terminated`） |
| 7 | 10:36–10:5x | deepseek-flash | **截帧当首帧**（10:46:02 seq4591）→ 3 条 768P（无台词文本）→ 未审即 2 条 2K（10:48:41）→ 10 秒下井镜头 → 用户三次质问（10:54/10:55） |
| 8 | 10:5x | deepseek-flash | 改回已批准关键帧 → 成功 → 用户「为什么非要截取帧？」 |
| 9 | 10:55–11:01 | deepseek-flash | 用批准关键帧出 V4 + 2K 成功；周原镜仍无台词文本→2K aborted |
| 10 | 11:02–11:0x | deepseek-flash | 用户纠正「参考音频≠台词」→ 改 `<d>` 台词重下 2 条 → Gemini ASR 报 `[object Object]` |

> 说明：turn 编号取日志 `turn` 字段；同一 turn 内 step 很多，所以时间跨度大。
>
> 另注：换模型的同一分钟（10:13:37，seq3723/3725）用户说了两句关键的话——「为什么总是要直接给 gemini 发视频？每次 fetch failed，你就没有想过为什么吗？」「请你继续，严谨的进行后续操作。**先完整阅读上下文**」。也就是说 DeepSeek 接手时**被明确要求先读上下文**，它也确实读了 30 张图，但摘要里缺的三条不变量无法靠「再多读几张图」补回来。

## 4. 换模型时到底丢了什么：压缩摘要的实证

`session-213b3228…` 在 **10:11:18（seq3688）** 做了一次 `compaction/summary`，**2 分钟后（10:13:19, seq3714）** 换成 DeepSeek。也就是说 DeepSeek 接手的不是完整历史，而是这份摘要。

对该摘要逐字统计关键词：

| 关键词 | 出现次数 | 含义 |
|---|---|---|
| `<d>` | **0** | 「台词必须写进 prompt 的 `<d>` 标签」这条不变量，摘要里没有 |
| `台词` | **0** | 同上（摘要本身以英文为主） |
| `音色` | **0** | 「reference_audio 只给音色」这条不变量，摘要里没有 |
| `关键帧` / `首帧` | **0 / 0** | 「已批准高清关键帧存在、优先复用」没有保留 |
| `first_frame` | 8 | 只保留了「参数模式」层面的描述 |
| `reference_audio` | 2 | 只保留了「reference 模式用 reference_images+reference_audio 代替 first_frame」 |
| `dialogue` | 2 | 只提到「23 条原生对白」这类统计 |

**同时**，这份摘要确实保留了另外两条教训：
- 「Root repeatedly passed all optional regen fields as empty strings…**Do not root-repeat fully populated regen schema**; delegate Flash sparse」→ 与之相符的是：换模型后**没有再犯**空字段错（换模型后的 9 次 `video_generate` 全部成功）；这只能说明「摘要保住了这条」与「行为变对」同向，不足以单独证明因果；
- 「**Lite768 directly regenerates 2K**（user already tested, erratum confirmed）」→ 换模型后 2K 再生成这件事本身没有走错（同样只是相关性证据）。

**机制判断（写成风险/促成因素，不写成唯一原因）**：压缩摘要**没有保留**三条画面/声音不变量（台词文本、参考音频语义、批准关键帧），这在设计上就是风险：模型只能按「看起来合理」的默认值补全，于是出现了用户观感里的「想当然」。

但这只是**促成因素**，不是免责解释：
- 日志能证明「摘要里没有这些词」，**不能证明**「错误只由摘要造成」；
- 执行侧的核验缺失是**独立存在**的问题——提交前没有 `read_image` 自检首帧、没有检查 prompt 里有没有台词、没有审 768 就升 2K，这些在任何上下文完整度下都属可核对的失误；
- 同一段对话里用户还明确要求过「先完整阅读上下文」（seq3725），说明「没读够」不是唯一解释。

**可核实的对照**：换模型后 7 个 turn 里，DeepSeek 一共做了 **41 次 `read_image`**，**第一次提交（10:46:26）之前就占了 30 次**（海报、联系表、`SRC_*.jpg` 源片联系表等）——**但它从未核对那张截帧**；对 `S01_001_no_person_first_1344x756.jpg` 的 `read_image` 发生在 **10:54:46（seq4731）**，即 3 条 768P + 2 条 2K 已经下完之后。更直接的证据是 seq4591 的 bash 脚本注释：`# 无人帧：raw 约10.9s（车与井口、无人）`——「无人」是写在注释里的断言，不是核对结果；把该文件读出来可见画面中有一名正在下梯的工人。

## 5. 两个阶段各自可核实的行为差异（不做性格归因）

| 维度 | Codex 段（02:44–10:13） | DeepSeek 段（10:13–11:0x） |
|---|---|---|
| 空字段参数 | 连续 9 次同参数重试（03:15–03:17），靠 harness 护栏才停 | 复用了稀疏参数（只传必要字段），**一次未犯** |
| 首帧来源 | 2K 试片、海报都用 `USER_SELECTED_…` 的定妆/批准图（例：N01 用 3840×2160 定妆帧） | 从成片 `-ss 10.9` 截 1344×756 帧当首帧（seq4591），文件名还写 `no_person`，实际画面有工人 |
| 台词 | Gemini 产出的 prompt 均含 `<d>[Chinese]…</d>`（seq447、seq740、seq856 等） | 3 条 prompt 只写 `speaking the line of <Audio 1>`（seq4609/4611/4808），无台词文本 |
| 2K 时机 | 先做 3 条 2K 试点并核帧数/PCM/SSIM 后才谈整批（seq3688 摘要：`First real regen usage…`、`Pilot operator checking this`） | 10:47:24 落地，10:48:41 就提交 2K，中间无审片记录 |
| Gemini 用途 | 图片/视频质检（2 次 `fetch failed`、1 次 12MB 超限，10:13 用户为此发火 seq3723） | 仅 1 次（ASR，落得 `Error: [object Object]`，随后用户 seq4917「你自己不会 ASR 吗」） |
| 失败后动作 | 失败→读日志→换方法（子代理稀疏参数、零成本探针） | 失败→先补提交→被用户质问后才回头核对输入图 |
| 明确承认的误判 | `attempt` 的 `max_tokens` 700 参数错（改 1024 即成功） | 自查后写下「参考音频不是台词音频…我没在提示词里写台词——这是错的」（seq4864，11:02） |

**反向也要说清**：DeepSeek 段并非全错——V4 改用批准关键帧后一次成功；`<d>` 台词写入后两条 768P 一次成功；它也在 seq4864 主动写出了正确流程。问题集中在「提交前的核对」与「不变量丢失」。

## 6. 结论（供后续会话使用）

1. **中途中换模型必须重发不变量清单**，不能只依赖压缩摘要；摘要至少应包含：台词写法（`<d>`）、`reference_audio` 语义、批准关键帧路径、稀疏参数规则、预算余额。
2. **压缩摘要要由人（或校验脚本）核对关键词**：本会话摘要里 `<d>`/台词/音色/关键帧出现 0 次，是可自动检测的信号。
3. 归因要写「哪一段是谁」，不要写「这个会话的模型怎样」——本会话两个阶段的行为差异本身就是证据。
