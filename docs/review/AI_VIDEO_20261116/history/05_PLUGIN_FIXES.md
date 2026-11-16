# 05 · 由本次审计可直接落地的插件缺陷与最小修改建议

> 说明：本文件只写**证据 + 建议**，本轮没有修改任何插件代码（task-8 的写入范围是 `docs/review/AI_VIDEO_20261116/history/`）。
> 行号以本仓当前提交为准（`git log -1` 见 `00_SESSION_INDEX.md` 同批产物；`plugins/dsh-gemini/index.js` 目前有**别的会话的未提交改动**，引用它时已注明）。
> 每条给：现象 → 证据 → 位置 → 最小改法 → 为什么值得做。
>
> ⚠️ **并发改动提示**：审计期间本仓工作树已有别的会话在重写 `plugins/dsh-minimax-video`（未提交，`git diff --stat` 约 +1454/−222 行：新增 `video_prepare`、`video_budget`、preflight 与预算台账）。因此下文行号以**提交版**为准，工作树里已漂移；`skill/SKILL.md` 在审计时**未被改动**（`git status` 无该文件），P2 仍然成立。

---

## P1｜`video_generate` 把空字符串当参数：一次返工里连续失败 9 次（含 7 次重复重试）

**现象**：模型习惯性把可选字段填成 `""`，工具直接抛错，且错误信息不点名字段；模型于是在同一参数上重试。

**证据**
- `session-213b3228…` 2026-11-16 03:15:09–03:17:05 / seq290–330：9 次 `video_generate` 全部 `Error: image input must be a non-empty path or URL`；参数含 `first_frame:""`、`last_frame:""`；seq336 harness 护栏记录 `consecutive_calls: 5`。
- 同一坑在 `session-9e5b4806…` seq2821（11-15 23:47）已由子代理定位并绕过：「只要完全省略这些可选字段就能正常走」。

**位置**
- `plugins/dsh-minimax-video/index.js:156-157`
  ```js
  firstFrame: args.first_frame === undefined ? undefined : resolveMedia(cwd, args.first_frame, 'image'),
  lastFrame:  args.last_frame  === undefined ? undefined : resolveMedia(cwd, args.last_frame,  'image'),
  ```
- `plugins/dsh-minimax-video/lib/media.js:53-56`
  ```js
  export function resolveMedia(cwd, input, kind) {
    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new Error(`${kind} input must be a non-empty path or URL`)
    }
  ```
- 工作树里的重写版把同一条校验搬到了 `lib/media.js:55-60` 的 `mediaInput()`（逻辑相同，仍对空串抛错、仍不点名字段）。

**最小改法**（两处都改，任一即可显著改善）
1. 在 `index.js` 加一个「空值归一」：`const val = (x) => (typeof x === 'string' && x.trim() === '' ? undefined : x)`，然后 `first_frame: val(args.first_frame) === undefined ? undefined : resolveMedia(...)`；`reference_images/videos/audio` 的数组同理过滤空串。
2. 在 `media.js` 的错误里带上字段名与来源：
   ```js
   throw new Error(`${kind} input must be a non-empty path or URL (field: ${field})`)
   ```
   并把 `field` 从调用点传进来（`'first_frame' | 'last_frame' | 'reference_images[i]' …`）。

**为什么值得做**：这是本项目里**少数可以完全自动化消除**的重复失败（9 次失败 + 1 次护栏中断），且不改变任何生成语义。

---

## P2｜`minimax-video` skill 没把「2K 直出」与「再生成的源条件」分开（一句真、一句错）

**先分清两件事（这是本条的要点）**

| 能力 | 事实 | 性质 |
|---|---|---|
| **direct generation** 的 2K | 只有 `MiniMax-H3` 能直出 2K；Highspeed / Lite / Max 直出上限 768P（480P 只在这三档）。 | **真限制**。`SKILL.md:23`、`:50-53` 的表述没错，**不应改** |
| **regeneration** 的源 | 官方 `/v2/video_regeneration` 只约束源的**物理规格**（24fps / 带音轨 / 宽高 32 整除 / 面积 768×768–768×1344 / 107–362 帧 step 17）；请求里的 `model:MiniMax-H3` 是**输出**模型；本地代码不做源型号校验。 | 「源必须是标准 H3 768P 输出」不成立——**错的是这一句** |

**现象**：`SKILL.md:118` 写 `Source must be a MiniMax-H3 768P output`，紧接在「2K only on MiniMax-H3」一节之后，读者自然连读成「只有标准 H3 的源才能升 2K」；于是出现「用户说能、模型说不能」的对抗（`session-2f08495b…` 就是为此开的会话）。

**实测 / 推导分级（不要把四档都说成已验证）**
- **已实测**：`MiniMax-H3-Lite` 768P 源 → 2K 再生成成功。用户 11-16 00:19 原话「实际是可以的，我测试过」（`9e5b4806` seq3011）；项目真实跑通（`213b3228` seq4786，task `463851531801158`，2K 10s 落盘）。
- **文档/schema 推导，未实测**：H3 / Highspeed / Max 的 768P 输出若满足同一物理规格，按官方 schema 也可作为 base video；**本审计没有这三档的实测样本**，只能写成「按 schema 可评估」，不能写成已验证。

**证据**
- 用户原话（`session-9e5b4806…` seq3011，11-16 00:19）：「> Lite 原片不能直接走官方 768P→2K 再生成接口」→「**实际是可以的，我测试过**」。
- 纠错会话（`session-2f08495b…`，11-16 00:21:48）：「用户明确纠正：Lite768P 可以走 2K 再生成…主代理此前照 minimax-video SKILL 和 video_models 说明错误断言只能标准 H3 源」；核查结论：本地 `buildRegenerationBody` 的 `model: 'MiniMax-H3'` 是**输出**模型，官方 schema 只约束物理规格；勘误落在 `docs/video/H3_LITE_PILOT_20261115/LITE_REGEN_ERRATUM.md`。

**位置**（本仓现状；`git log -- plugins/dsh-minimax-video/skill/SKILL.md` 只有建仓提交 `9bb14f2`，未按勘误更新）
- `plugins/dsh-minimax-video/skill/SKILL.md:23`：`- **2K only on MiniMax-H3.** Highspeed, Lite and Max stop at 768P; 480P exists only on those three.` ← **保留**
- `plugins/dsh-minimax-video/skill/SKILL.md:52`：Lite 行 `480P / 768P` ← **保留**
- `plugins/dsh-minimax-video/skill/SKILL.md:118`：`- Source must be a **MiniMax-H3 768P output**: 24 fps, audio track present, …` ← **要改**

**建议改法（只改 `:118`，`:23` 最多加一句交叉引用）**
- `:118` → `- Source must be an **H3 768P output that meets the physical spec** — the spec, not the source tier, is what matters: 24 fps, audio track present, width and height divisible by 32, area between 768×768 and 768×1344, 107–362 frames in steps of 17. The \`model\` sent to \`/v2/video_regeneration\` is the **output** model (\`MiniMax-H3\`), not a constraint on the source tier. Verified in practice for Lite 768P sources; other tiers follow the same documented physical spec.`
- （可选）`:23` 末尾加 `(This is about direct generation; regeneration from a 768P source is a separate path — see "768P → 2K regeneration".)`

**为什么值得做**：这是每个会话都会加载的最高杠杆文档，且当前文本会让人把两条不同规则读成一条。注意**不要动直出限制**——错的只是把直出限制外推到了再生成的源条件上。

## P3｜`video_regenerate` 的模式错误没有指路

**现象**：只给 `first_frame` 没给源片时，报 `provide exactly one of source_task_id or video`，但不说明「base-video 模式要 `video`，`source_task_id` 需要白名单」。

**证据**：`session-213b3228…` 07:57:58–07:58:58 / seq2837、2842、2847、2855 四连败（Codex 段）。

**位置**：`plugins/dsh-minimax-video/index.js`（`video_regenerate` 的参数校验与工具描述，约 `:500-590` 一带；`outDir` 解析在 `:583`）。

**建议**：错误信息补一行「which mode to use」：
```text
provide exactly one of source_task_id or video
  · base-video mode  → pass `video` (the 768P mp4) + the exact final prompt + all original media
  · source_task_id   → whitelist only, succeeded task within 7 days
```

**为什么值得做**：同一模式错在本项目出现 4 次，全部发生在「模型认为字段都能填」的 schema 上。

---

## P4｜下载落盘：`out_dir` 行为不透明 + 秒级文件名

**现象**：两个子代理对「`out_dir` 是否生效」给出相反结论（一个说无效、文件落 `generated-videos/` 并按同秒撞名覆盖；另一个说生效且各自落盘），主代理无法判断。

**证据**：`session-213b3228…` seq835（03:50:25）与 seq862（03:52:30）两条互相矛盾的汇报。

**位置**
- `plugins/dsh-minimax-video/index.js:409`（`args.out_dir === undefined ? join(cwd,'generated-videos') : resolve(cwd, args.out_dir)`）
- `plugins/dsh-minimax-video/index.js:113-115`（`timestamp()` = `YYYY-MM-DD_HH-MM-SS`，**秒级**）
- `plugins/dsh-minimax-video/index.js:170-175`（`downloadResult` 用 `stem` 组装文件名）

**建议**
1. 文件名 stem 带 task id 与毫秒：`` `${timestamp()}-${task.task_id}-${slugOf(...)}` ``；
2. 工具返回里**回显最终绝对路径**（这次争议的根因就是没有回显）；
3. 工具描述里明确「`out_dir` 为相对 cwd 的目录，不存在会创建；未传则 `generated-videos/`」。

**为什么值得做**：并行下单时「文件被覆盖」会直接毁掉可追溯性（本项目靠 sha256 台账才发现过一次覆盖）。

---

## P5｜Gemini：媒体附件需要「目的 + 本地证据」，且错误要可读

**现象**：视频/图片直接被丢给 Gemini 做质检；12MB 超限、`fetch failed`、`[object Object]` 三种失败都出现过。

**证据**：见 `03_FAILURE_PATTERNS.md` F11（`213b3228` seq126/134/1861/4905）与 `04_LOCAL_TOOLS.md`。

**位置与现状**
- `plugins/dsh-gemini/index.js:39`（`MAX_INLINE_BYTES = 12MB`）、`:146`（超限错误文案）。
- 工具描述 `plugins/dsh-gemini/index.js:478` 已写明「technical checks 归本地工具」「attaching audio/video requires media_purpose plus local_evidence」。
- **注意**：该文件当前有**其他会话的未提交改动**（`git status` 显示 `M plugins/dsh-gemini/index.js`，新增了对 `video|audio` 的 `LOCAL_MEDIA_HINT`、口型关键词识别、12MB 预检、错误对象处理）。本审计**未改**它，也不对未提交实现做结论。

**建议**（如尚未覆盖）
1. 附件里有 `video/*` 或 `audio/*` 时，**强制要求** `media_purpose` + `local_evidence`（缺失即拒绝并给出本地替代命令示例）；
2. 错误统一 `error instanceof Error ? error.message : JSON.stringify(error)`，杜绝 `[object Object]`；
3. 在返回里回显「本次附件的总字节数 / 是否被截断」，让调用方能自证没超限。

**为什么值得做**：本项目把 Gemini 当「视频质检员」的代价是**又慢又不可核实**，而本地工具已经在同一任务上证明更强（见 04）。

---

## P6｜项目侧（TanLu 仓，非本插件仓）应把 5 条不变量写成硬规则

**证据**：这 5 条在日志里都被反复踩：空字段（F6）、台词写 `<d>`（F2）、参考音频只做音色（F2）、批准关键帧优先（F1）、升 2K 前先审 768（F3）。截至审计时，TanLu 的 `AGENTS.md / STATE.md / README.md` 对「空字段」无任何记载。

**建议**（由项目 owner 决定，不在本仓改）：在 `AGENTS.md` 增一节「H3 下单前五条」：
1. 可选字段**要么不传、要么给真实值**，禁止 `""`；
2. 台词必须写在 prompt 的 `<d>[Chinese]…</d>`，`reference_audio` 只给音色；
3. 首帧只取「已批准关键帧 / 母版派生图」，从成片截帧必须先 `read_image` 自检语义；
4. 768P 审片通过（动作/台词/口型/首尾余量）才升 2K，一次返工只下 1 条候选；
5. 每条生成同时写 `task_id / 目录价 / 原始 prompt 文件 / 全部输入 sha256`，交付语区分「候选 / 技术通过 / 已采用」。

## P7｜压缩摘要模板：换模型前必须保留的字段

**证据**：`session-213b3228…` 10:11:18 的 `compaction/summary`（seq3688）里 `<d>`/`台词`/`音色`/`关键帧` 出现 **0 次**，2 分钟后换 DeepSeek，随后连犯 F1/F2/F3/F4。

**建议**：给 `/compact` 类摘要加一个「不变量清单」硬段（10 行以内），并在摘要生成后做一次关键词自检（缺 `<d>`、`reference_audio` 语义、批准关键帧路径、预算余额 就报警）。这条不一定要改 DSH 本体，项目侧交接文件也能实现同样效果。
