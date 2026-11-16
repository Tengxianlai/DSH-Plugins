# 06 · 缺口、边界与「不能下结论」的地方

> 原则：读不到就写读不到，不猜；不属于本项目的正文不读、不写；能定位但不在当前存储的，明确说「不在」。

---

## G1｜Mac 侧 DSH 会话日志不在当前存储（最大缺口）

**事实（本次实测）**
- 本机 `~/.dsh-wsl/sessions` 与 `~/.dsh/sessions` 两个 home 下，**没有任何一个会话的 `cwd` 是 `/Users/...`**（逐会话读首行 `session` 记录核对，共 65 + 3 个）。
- `/mnt/m` 当前**未挂载**：`ls /mnt/m` → `cannot open directory '/mnt/m': No such device`（另一个会话 `session-9e5b4806…` seq12 里用户说「Mac 文件可通过 Windows M 盘访问」，说明当时挂载过；现在没有）。
- Mac→WSL 的迁移是**按项目目录**做的，不是按会话：`session-9e5b4806…` seq586（11-15 17:32）显示 `git fetch --no-tags .work/mac-receive-20261115/incoming HEAD:refs/remotes/mac-lan/handoff-20261115`，`rev-list --left-right --count HEAD...mac-lan/handoff-20261115` = `0 33`，随后 `git switch -c director-wsl-v03`；源是 `\\10.0.0.20\tengxlper\DSH_ZONE\VideoStudio\Projects\TanLu-CJU75th`。

**能纳入的部分（已写进 `01_TIMELINE.md` C 段）**
- WSL 侧接手会话 `session-9e5b4806…`（11-15 17:13 起）里，对 Mac 侧工作的引用与验收；
- 交接文件与校验痕迹（`docs/handoff/WSL_DIRECTOR_HANDOFF_20261115.md`、`.work/mac-receive-20261115/bootstrap/`、提交 `02362c8` / 基线 `434e2fc`）；
- `session-a2dc12c7…`（Mac 接收 task-1）与 `session-7a429f12…`（task-2 运动修复）的执行记录。

**不能纳入的部分（明确缺口）**
- Mac 上 DSH 会话本身的对话正文、工具调用与预算记录：**不在本机**，无法审计；
- 因此凡是「Mac 阶段发生了什么」的表述，本审计只引用 WSL 侧会话里的**转述与验收记录**，不把它们写成 Mac 会话的一手事实。

---

## G2｜Codex CLI 时代（11-11 之前）没有日志

- 本存储最早的会话是 **2026-11-11 23:49:47**（`session-3baf3ca6…`）。
- 更早的工作只能从引用看出：`E:\Document\ClaudeDesktop\探路修改稿\交接单_给AI接手.md`（`3baf3ca6` seq11）、`/mnt/e/Videos/《探路》交付_20261107/探路_交付版_2K.mp4`（`1b8435f1` 会话读取）、`/mnt/e/Document/ChatGPT/AIVIDEO/delivery/tanlu-final-20261107/finish_film.py`（mtime 11-07 19:05）。
- 结论：**「Codex 阶段」在本审计里只能指 `magpie/codex/gpt-6.1-sol` 在 DSH 里跑的那几段**，不能指 Codex CLI 的历史对话——那段没有日志。

---

## G3｜旧 home `~/.dsh` 里的 3 个副本：2 个是过期快照

| 会话 | `~/.dsh`（旧） | `~/.dsh-wsl`（主） | 判定 |
|---|---|---|---|
| `session-3baf3ca6…` | 6,293,636 B / sha `9754412a2f9f…` | 6,293,636 B / sha `9754412a2f9f…` | **完全相同** |
| `session-0f6eac2a…` | 697,048 B / sha `a724aaff3168…` | 697,130 B / sha `517dbc63f2d3…` | 旧副本少 82 B，**过期快照** |
| `session-463b745b…` | 46,190 B / sha `576f1b931066…` | 46,271 B / sha `5278ae28f92e…` | 旧副本少 81 B，**过期快照** |

处理：审计以 `~/.dsh-wsl` 为主存储；旧 home 不重复计数、不混用。

---

## G4｜存储里存在但不属于「本项目历史」的会话

| 会话 | 位置 | 处理 |
|---|---|---|
| `session-e0082ed4-22f2-4adf-bcf6-b0c224f4918f` | `--mnt-c-Users-Tengxlper-Documents-Codex-2026-11-12-session-4b9cf203…--` | cwd 在 Codex 目录，内容只有一条 `DEEPSEEK FLASH TEST OK` 冒烟测试；**非《探路》正文**，只做 header 级确认，未引用其内容 |
| `session-a51386a3-1962-4bc4-8903-1fe8f5ed307d` 等其它项目目录 | `--home-tengxlper-DSH_ZONE--`、`Personal-*`、`Projects-DSH-Plugins`、`TEST-*`、`tmp-*` | 只读 header 确认 `cwd`，**未读正文** |
| `session-51d4af5c-e97e-472f-8133-cbd1f4b42884` | TanLu 目录 | 0 条用户消息、0 次工具调用（只有 `model/selection`），属空会话；索引保留但无内容可审 |
| `session-463b745b…` | TanLu 目录 | 2 条用户消息、0 次工具调用（消息投递残留） |

## G5｜本次审计自身产生的会话（不计入历史）

2026-11-16 18:15 起，TanLu 存储里新增 5 个会话，均属本次审计动作：

| 会话 | 创建 | 说明 |
|---|---|---|
| `session-63a534ab-713c-41ca-b70b-8f7df818defd` | 18:15:31 | **本审计会话**（`history-auditor`，task-8） |
| `session-0101f477-5461-4029-a0f7-745bd2d45205` | 18:15:31 | 并行审计会话（task-9 本地工具/复用盘点） |
| `session-2bd3c992…` / `session-7a0b9360…` | 18:18:16 | 父会话 `session-78b8ee8a…` 派出的审计子代理会话 |
| `session-75b82758…` | 18:20:14 | 同上（另一路审计子代理） |

因此索引表共 65 行（63 条历史 + 2 条审计），事后新增的 3 条子代理会话未入表（它们的 `parentSession` 指向 `session-78b8ee8a`，属审计产物）。

## G6｜读法上的限制（避免把摘要当全文）

- 本次是**摘要级取证**：每条 `tool/call` 的入参截到 1,400 字符、`tool/result` 截到 900 字符、助手正文截到 1,200 字符；对超长 prompt（H3 三字段 prompt 常在 2–6k 字符）只保留了开头，**凡引用 prompt 原文的结论都注明了截断位置或改用可核对的短字段**（如 `first_frame`、`model`、`duration`、`out_dir`、task_id）。
- 两个超大日志（`session-213b3228…` 9.4 MB、`session-9e5b4806…` 7.4 MB 压缩）是全量流式解析的，事件计数与 seq 完整；但正文只保留摘要。
- 图片只对**两张关键证据**做了实际视觉核对：`S01_001_no_person_first_1344x756.jpg`（画中有人）与 `S01_001_f01_c7aebe8056.png`（画中无人）。其余图片的判断来自日志文本，不声称看过。
- 音频未听；一切「听感」结论都注明来自日志中的转述（并标明那是转述）。

## G7｜未审计、但可能与本主题相关

- TanLu 仓内其它 `docs/review/*`（`CLOSEOUT_20261116`、`FEEDBACK_*`、`MOTION_v0*_ASR` 等）是**产物文档**，不是会话日志，本任务未做内容审计（部分被日志引用时只做了路径级引用）。
- 本插件仓 `plugins/dsh-gemini/index.js` 当前有**其他会话的未提交改动**，本审计只读、未修改，也不对其实现正确性下结论。
- Mac 侧 DSH 会话、Codex CLI 会话、以及 11-11 之前的任何对话记录：**不存在于当前可访问存储**（见 G1、G2）。
