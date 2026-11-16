# Gemini 4 Argon 多模态

`gemini` 是一个“能看材料再给判断的合作者”，主要承担文学/文字工作：写剧本、文案、对白、旁白，拿场景图和剧本对照，读 PDF 和长文，比较同一场景的多个版本。一次调用返回一段文本。

## 分工

- **Gemini**：文学/文字创作与改写、长文分析，以及需要整体判断的图片/短片。
- **本地工具 + DeepSeek 子代理**：ASR 转录、逐帧扫描、ffprobe、解码、接触表、音画同步等技术质检。抽帧和 ASR 只是证据，不能当口型/身份/表演的终审，片段级判断也不等于整片审看。
- 音/视频附件必须说明 `media_purpose` 并给出 `local_evidence`；用户明确要求 Gemini 直接看片段时可用 `user_requested_media_review=true` 代替本地证据。图片对照不需要这些。

## 为什么单独做一个工具

- **请求里没有 Harness 身份段。** 插件自己拼一段很短的中性 system instruction，只有“读材料、直接回答、不确定就说”三句；没有 `DeepSeek Harness` 品牌句，也没有 `@` 文件引用段。上游看到的是一个普通客户端，而不是 agent harness。
- **不预设写作模式。** 没有 `mode`，没有“只准输出正文”的约束。问什么、看什么、要什么格式，全在 `task` 里用自然语言说。
- **多模态。** 图片、PDF、视频/音频片段、文本文件都可以按路径附上；每个附件前有“文件 N：路径”的标签，Gemini 能按路径指认。
- **只回文本。** 思考内容（`thought: true` 的 part）被丢弃，答案直接可用。
- **模型固定 Argon。** 不开放 Carbon/Hydrogen。

## 参数

| 参数 | 说明 |
|---|---|
| `task` | 必填。自然语言的问题或请求：项目背景、材料位置、要比较什么、什么算问题。 |
| `source` | 长文本材料（剧本、访谈、设定、清单）。没有就不传。 |
| `files` | 附件路径或 URL：图片、PDF、片段、文本文件。 |
| `reasoning` | `low` / `medium` / `high`，默认 `medium`。 |
| `max_tokens` | 输出预算，1024–65536，默认 16384（含思考 token）。 |
| `temperature` | 0–2，默认 0.7。 |
| `media_purpose` | 附音/视频时必填：必须由 Gemini 整体判断的内容。 |
| `local_evidence` | 音/视频的本地证据：ffprobe、裁片/抽帧、本地 ASR 或摘要。 |
| `user_requested_media_review` | 用户明确要求 Gemini 看片段时置 true，免本地证据。 |
| `auto_escalate` | 默认 false；true 才允许预算耗尽无正文时放大一次重试。 |

## 用量与重试

返回 `text`、`model`、`reasoning`、`input_tokens`、`output_tokens`、`total_tokens`（全 attempt 可计量值累计）、`usage_complete`、`unknown_usage_attempts`、`attempt_count`、`attempts`，以及可选的 `notes`、`finish_reason`、`truncated`。

- 每个 attempt 记录 `kind`（`request` / `auth-fallback` / `budget-retry`）、`status`、`max_output_tokens`、`usage_status`（`measured` / `partial` / `unknown`）和已报的 token 数。
- 上游没报 token 时字段缺省、计为未知，不按 0 冒充已计量；401 失败通常 usage 未知。
- 空正文最终失败：错误消息含 attempt 数与累计 usage，`error.attempts` / `error.usage` 可读。
- 重试有界：401 回退最多 1 次；预算翻倍只在 `auto_escalate=true` 时最多 1 次，且不超过 65536。没有其它隐藏重试。
- 渲染给模型的内容包含正文、`[note]` 证据边界与一行 `[usage]` 摘要（attempt 数、token、是否完整），费用在对话里可见。

## 附件类型与上限

- 图片：`png/jpg/jpeg/webp/gif/bmp`
- 文档：`pdf`；文本类 `txt/md/csv/json/srt/vtt/yaml/html`
- 视频/音频：`mp4/mov/webm`、`mp3/wav/ogg`
- 合计上限 12MB（原始字节；base64 后约 16MB，给请求留余量）
- 本地文件先 stat 汇总体积，超限在读入/base64 之前失败；远端按流式累计读，超过 12MB 立即截断并取消，不信任 `content-length`
- 远端 URL 的 query/hash 会被去掉，带签名的链接不会出现在标签、提示词或错误里
- 文本附件和返回正文超过 20 万字符会截断
- docx/xlsx 等二进制先抽文本或转 PDF，工具不会解析
- 超限或音视频缺目的/证据时，错误给出本地流程（ffprobe、裁片/抽帧、ASR、子代理复核），不自动多次付费重试

## 一次典型的对照请求

```
gemini(
  task="我们现在在做一部雨夜短片。剧本和分镜表在 source 里，场景图在 files 里，按场次命名。请对照检查时间、地点、人物、道具、光线有没有明显对不上的地方；只指出最确定的几处，并说明依据。",
  source="（剧本 + 分镜表）",
  files=["scenes/s01-rain-alley.png", "scenes/s02-doorway.png", "scenes/s03-rooftop.png"],
  reasoning="high",
)
```

## 配置

`cordis.patch.yml` 里默认：

```yaml
baseURL: https://api.teamorouter.com/v1beta
```

密钥按顺序取：

1. 凭据存储里的 `TEAMOROUTER_API_KEY`；
2. `$DSH_HOME/secrets/teamorouter.env` 里的同名变量。

请求走原生 Gemini `generateContent`，先发 `Authorization: Bearer`；遇到 401 再用 `x-goog-api-key` 重试一次。`thinkingLevel` 映射为 `LOW` / `MEDIUM` / `HIGH`。

## 限制

- 一次调用一个独立请求，不续接 Gemini 侧会话；多轮追问要把上一轮结论和材料一起重新给出。
- 只返回文本，不返回文件或工具调用；它不会读写工作区。
- 长材料 + `high` 思考会慢；`max_tokens` 太小可能只剩思考没有正文。
- 上游是 TeamoRouter，是否触发 Google 的提示词指纹取决于它的转发路径；本插件只保证请求里不含 Harness 指纹段。

## 兼容性（0.4.0）

顶层 token 字段改为全 attempt 累计；`auto_escalate` 默认关闭（旧版自动放大预算的行为需显式开启）；带音/视频的旧式调用需要补 `media_purpose` 与 `local_evidence`。新增字段可忽略。
