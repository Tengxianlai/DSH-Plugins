# dsh-gemini

用 Gemini 4 Argon 写、看、读、对照。工具名 `gemini`，直连 TeamoRouter 的原生 Gemini `generateContent`；你可以用自然语言提问，并把剧本、场景图、分镜、PDF、片段一起交给它。

## 分工（0.4.0 起）

- **Gemini 负责文学/文字工作**：剧本、对白、旁白、文案、改写、长文分析，以及需要“看完材料再给判断”的图片/短片综合判断。
- **技术质检走本地**：ASR 转录、逐帧扫描、ffprobe、解码、接触表、音画同步这类活由本地工具 + DeepSeek 子代理完成。抽帧和 ASR 只是证据，不能拿来当口型、身份或表演的终审，片段级判断也不等于整片审看。
- 音/视频附件需要 `media_purpose`，并且要提供 `local_evidence`（除非用户明确要求 Gemini 直接看片段，则置 `user_requested_media_review=true`）。这是路由门槛，不是用户或专家验收。
- 图片对照不受此限制：普通场景图、分镜图、版本比较照常直接传。

## 为什么

- **请求里没有 Harness 身份段。** 插件自己拼一段很短的中性 system instruction，没有 `DeepSeek Harness` 品牌句，也没有 `@` 文件引用段。上游看到的是一个普通客户端，而不是 agent harness。
- **它是合作者，不是写作模式。** 没有 `mode`、没有“只准写正文”的硬约束；问题怎么问、要它看什么、输出什么格式，都由 `task` 决定。
- **能看图。** 图片、PDF、视频/音频片段按路径内联进请求，每个附件带“文件 N：路径”标签，Gemini 可以按路径指认。
- **模型固定 `gemini-4-argon`**，没有 model 参数，不开放 Carbon/Hydrogen。

## 工具

`gemini`

| 参数 | 说明 |
|---|---|
| `task` | 必填。自然语言的问题或请求：项目背景、材料位置、要比较什么、什么算问题。 |
| `source` | 长文本材料：剧本、访谈、设定、清单。没有就不传。 |
| `files` | 附件路径或 URL：图片、PDF、mp4/mov/webm、mp3/wav/ogg、文本文件。 |
| `reasoning` | `low` / `medium` / `high`，默认 `medium`。密集对照或深度分析用 high。 |
| `max_tokens` | 1024–65536，默认 16384（含思考 token）。 |
| `temperature` | 0–2，默认 0.7。 |
| `media_purpose` | 附音/视频时必填：一句话说明必须由 Gemini 整体判断什么（表演、节奏、连续性、画面内动作）。 |
| `local_evidence` | 音视频附件的本地证据：ffprobe 结果、裁片/抽帧路径、本地 ASR 转录，或一句话摘要。 |
| `user_requested_media_review` | 默认 false。用户明确要求 Gemini 直接看片段时置 true，可免 `local_evidence`。 |
| `auto_escalate` | 默认 false：一次调用只付一次请求。置 true 才允许“思考耗尽预算且无正文”时放大一次预算重试（上限 65536）。 |

返回：

```
{
  text, model, reasoning,
  input_tokens, output_tokens, total_tokens,   // 所有 attempt 中可计量值的累计
  usage_complete, unknown_usage_attempts,      // 是否有 attempt 的 token 未知
  attempt_count, attempts: [{ attempt, kind, status, max_output_tokens,
                              usage_status, input_tokens?, output_tokens?, total_tokens?,
                              thought_tokens?, finish_reason?, error? }],
  notes?, finish_reason?, truncated?
}
```

- `attempts` 记录每个 HTTP attempt：正常 `request`、401 后的 `auth-fallback`、显式开启的 `budget-retry`。
- `usage_status` 为 `measured` / `partial` / `unknown`；上游没报 token 时字段缺省，**不按 0 冒充已计量**，累计值只加真实可用的数字。401 失败通常没有 usage，会被标成 `unknown`。
- 空正文最终失败时，错误消息里带 attempt 数和累计 usage，`error.attempts` / `error.usage` 也可读。
- 重试有界：401 回退最多 1 次；预算翻倍重试只在 `auto_escalate=true` 时发生，最多 1 次且不超过 65536。没有其它隐藏重试。
- 工具把正文、`[note]` 证据边界和一行 `[usage]` 摘要一起交给模型，所以对话里直接能看到本次调用的 attempt 数与 token 情况。

## 附件

- 支持：`png/jpg/jpeg/webp/gif/bmp`、`pdf`、`mp4/mov/webm`、`mp3/wav/ogg`、`txt/md/csv/json/srt/vtt/yaml/html`。
- 本地路径相对会话工作目录解析，也可以给绝对路径或 http(s) URL。
- 所有附件合计上限 12MB（base64 后会膨胀，留出请求余量）。**本地文件先 stat 汇总体积，超限在读取和编码之前报错**；远端不看 `content-length`，按流式累计读，一到 12MB 就截断并取消，不会先 `arrayBuffer` 整个读完。
- 远端 URL 的 query/hash 会被去掉：带签名的链接不会进入附件标签、提示词或错误信息。
- 附件超限或音视频缺少目的/证据时，错误会给出本地流程（ffprobe、ffmpeg 裁片/抽帧、本地 ASR、子代理复核），不会自动发起多次付费请求，也不会编造某个项目的固定路径。
- 单个文本附件超过 20 万字符会截断；返回正文超过 20 万字符也会截断并标 `[truncated]`。
- 不支持的二进制（docx/xlsx 等）请先抽出文本，或转成 PDF 再传。

## 配置与密钥

`cordis.patch.yml` 默认 `baseURL: https://api.teamorouter.com/v1beta`。密钥取凭据存储的 `TEAMOROUTER_API_KEY`，缺失时回退 `$DSH_HOME/secrets/teamorouter.env`。不要在本仓或 profile 写明文。

## 安装

由 `plugin_manager` 的 `install_bundle` 托管安装，target 用本目录的绝对路径（相对仓根是 `plugins/dsh-gemini`）。

宿主半边改动可通过关/开插件行热加载；工具定义在重新装载时更新。

## 兼容性（0.4.0）

- 顶层 `input_tokens` / `output_tokens` / `total_tokens` 由“末次 attempt”改为“所有 attempt 可计量值的累计”；单 attempt 调用数值不变。
- `auto_escalate` 默认 false：旧版在思考耗尽预算时自动放大重试的行为不再默认发生，需要显式开启；开启后两次 attempt 都会出现在 `attempts` 里。
- 带音/视频附件、又没说明 `media_purpose` + `local_evidence` 的旧式调用会被明确拒绝；图片调用不受影响。
- 新增字段均可忽略，旧输出字段保留。

## 自检

```sh
node --check index.js
node scripts/verify.mjs
```

自测会检查：工具注册、文本 + 图片 + 文本附件组装与路径标签、类型拒绝、默认 medium/0.7、system prompt 不含 Harness 指纹、思考 part 被过滤、401 回退与未知 usage、默认不重试、显式预算重试的累计 usage、空正文失败的费用可见、HTTP 失败记录、stat 预检、远端流式截断、URL 脱敏、音视频目的/证据门槛。不会发真实网络请求。
