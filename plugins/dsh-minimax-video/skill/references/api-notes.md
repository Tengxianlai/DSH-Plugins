# H3 API notes

Snapshot: 2026-11-16 (list prices, not account bills). Check the official pages before promising a price or a limit.

- [Video generation guide](https://platform.minimax.io/docs/guides/video-generation)
- [Create task](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)
- [Query task](https://platform.minimax.io/docs/api-reference/video-generation-v2-query)
- [Regeneration](https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration)
- [Context-IR](https://platform.minimax.io/docs/api-reference/video-generation-v2-h3-context-ir)
- [Pricing (international)](https://platform.minimax.io/docs/pricing/overview)
- [Pricing (China)](https://platform.minimax.cn/docs/pricing/overview)

## Endpoints

| Operation | Method and path |
|---|---|
| Create video task | `POST /v2/video_generation` |
| Query one task (7-day window) | `GET /v2/query/video_generation/{task_id}` |
| List tasks | `GET /v2/video_generation` (plugin does not expose) |
| Cancel or delete | `DELETE /v2/video_generation/{task_id}` |
| Create Context-IR task | `POST /v2/h3_context_ir` |
| Create regeneration task | `POST /v2/video_regeneration` |

Base URL: `https://api.minimax.cn` (China) or `https://api.minimax.io` (international). Auth: `Authorization: Bearer <API key>`, `Content-Type: application/json`.

The official OpenAPI title says "Video V2 (Hailuo-03)"; the public model ids use `MiniMax-H3`.

## Create task fields

| Field | Required | Notes |
|---|---|---|
| `model` | yes | `MiniMax-H3`, `MiniMax-H3-Highspeed`, `MiniMax-H3-Lite`, `MiniMax-H3-Max` |
| `content` | yes | multimodal array; must contain one non-empty `text` item |
| `resolution` | yes | `480P`, `768P`, `2K`; tier matrix applies |
| `duration` | yes | integer; 4–15 s (Max 5–15 s) |
| `ratio` | conditional | text-to-video: required, not `adaptive`; image-to-video: always adaptive; reference: optional, default adaptive |
| `extra.prompt_expansion_mode` | no | Max only: `disabled`, `balanced` (default), `quality` |
| `callback_url` | no | verification `challenge` echo, then status pushes |
| `response_format` | no | `task` (default) or `flat` |

`aigc_watermark` appears in the China schema and the regeneration schema; the plugin does not expose it to avoid a regional schema mismatch.

## Content items and roles

| `type` | Shape | Role |
|---|---|---|
| `text` | `{type:"text", text:"..."}` | prompt; <= 7000 characters |
| `image_url` | `{type:"image_url", image_url:{url}, role}` | `first_frame`, `last_frame`, `reference_image`, `base_video` is video-only |
| `video_url` | `{type:"video_url", video_url:{url}, role}` | `reference_video`, `base_video` (regeneration only) |
| `audio_url` | `{type:"audio_url", audio_url:{url}, role}` | `reference_audio` |

`url` accepts a public URL, `mm_file://{file_id}`, or a data URI (`data:image/png;base64,...`, `data:video/mp4;base64,...`, `data:audio/wav;base64,...`).

**Mixing rule:** `reference_image` / `reference_video` / `reference_audio` cannot appear together with `first_frame` / `last_frame`. `last_frame` must be paired with `first_frame`.

Because `reference_audio` is a reference role, **`first_frame` + `reference_audio` is rejected**. For a recurring character's voice, use reference-to-video with `<Picture N>` + `<Audio N>`; for exact frame chaining, use `first_frame` and replace the voice in post. See `continuity-and-voice.md`.

## Media limits

| Asset | Limit |
|---|---|
| Image format | JPG, JPEG, PNG, WEBP, HEIC, HEIF |
| Image size | <= 30 MB; side 256–5760 px; aspect 0.4–2.5 |
| Image count | first frame 1, last frame 1, reference images 9 |
| Video format | MP4, MOV; H.264/AVC or H.265/HEVC; audio AAC or MP3 |
| Video size | <= 50 MB; side 256–5760 px; aspect 0.4–2.5; fps 23.976–60 |
| Video count/duration | <= 3 clips; each 2–15 s; total <= 15 s |
| Audio format | WAV, MP3 |
| Audio size/count | <= 15 MB; <= 3 clips; each 2–15 s; total <= 15 s |
| Mixed reference files | <= 12 |
| Request body | <= 64 MB total; Base64 inflates ~33% |

## Ratio matrix

| Mode | Default | Allowed | Notes |
|---|---|---|---|
| text-to-video | 16:9 | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | `adaptive` rejected |
| image-to-video | adaptive | — | follows the frame image; other values ignored |
| reference-to-video | adaptive | all concrete + adaptive | Lite rejects `adaptive` |

## Task lifecycle

`queued` → `running` → `succeeded` | `failed` | `cancelled`.

- Query only covers the last 7 days (`[T-7d, T)`); outside it returns `invalid task_id`.
- On success, `task.content.url` is the video; URLs are time-limited, so download promptly.
- `task.task_type`: `generation`, `h3_context_ir`, `regeneration`.
- `task.usage` is returned on success; video tasks use seconds, Context-IR uses tokens.
- Cancel/delete is status-dependent: `queued` → cancel; `succeeded`/`failed` → delete; `running` and `cancelled` return an error.
- Recommended poll interval is about 10 s.

## 768P → 2K regeneration

`POST /v2/video_regeneration`, model `MiniMax-H3`, resolution `2K`.

Two mutually exclusive source forms:

1. `source_task_id`: a succeeded `/v2/video_generation` task. **Whitelist access required**; owned by the same account; inside the 7-day window. No `content`.
2. `content` with exactly one `video_url` item whose `role` is `base_video`, plus the **same text and media used for the 768P generation**.

The base video must match H3's 768P output spec:

| Item | Requirement |
|---|---|
| Audio track | present (silent videos unsupported) |
| Frame rate | 24 fps |
| Width/height | both divisible by 32 |
| Area | 768×768 <= area <= 768×1344 |
| Frames | 107–362, step 17 (about 4–15 s) |

The `text` must be the final prompt actually used for the 768P source, not the pre-Context-IR draft. A mismatch can change the result. Regeneration re-bills the original input media (original reference-video seconds are charged again) and is always quoted as a **partial floor/upper range**, never as a single invoice-like price.

## Context-IR

`POST /v2/h3_context_ir` with `model: MiniMax-H3`, `content`, `duration`, optional `ratio`. It returns a task; on success read `task.content.prompt`. It does **not** create a video. `task_type` is `h3_context_ir`; usage is token-based. Use it to structure a vague prompt or assign reference roles before a deliberate 768P → 2K pipeline.

## Error codes seen in the docs

| Code | HTTP | Meaning | What to do |
|---|---|---|---|
| 1000 | 500 | internal error | retry later; keep `request_id` |
| 1002 | 429 | rate limit | back off and retry |
| 1004 | 401 | auth failed | check key and region |
| 1008 | 402 | insufficient balance | top up; check tier pricing |
| 1026 | 422 | sensitive content | rewrite the prompt or replace media |
| 2013 | 400 | missing/empty text item | always send one non-empty prompt |

Errors are OpenAI-shaped: `{type:"error", error:{type,message,http_code}, request_id}`. The trailing number in `message` is MiniMax's internal code. Always report `request_id` to support.

## Price snapshot (list, per second unless noted)

| Model | Resolution | CNY/s | USD/s |
|---|---|---|---|
| MiniMax-H3 | 2K | 0.80 | 0.13 |
| MiniMax-H3 | 768P | 0.50 | 0.08 |
| MiniMax-H3-Highspeed | 768P | 0.40 | 0.06 |
| MiniMax-H3-Highspeed | 480P | 0.26 | 0.04 |
| MiniMax-H3-Lite | 768P | 0.26 | 0.04 |
| MiniMax-H3-Lite | 480P | 0.16 | 0.025 |
| MiniMax-H3-Max | 768P | 0.50 | 0.08 |
| MiniMax-H3-Max | 480P | 0.33 | 0.05 |

- First 5 images free (Max: 2), then CNY 0.20 / USD 0.04 per image on H3 and Highspeed, CNY 0.13 / USD 0.02 on Lite, CNY 0.50 / USD 0.074 on Max.
- Input video is billed per second at the output resolution rate; Max has separate input rates (CNY 0.97 / USD 0.143 at 768P).
- Audio input is free.
- Regeneration is a **partial floor/upper** estimate, never one price: output CNY 0.30 / USD 0.05 per second, original reference-video seconds re-billed at the same input-video rate, plus images beyond 5 at CNY 0.15 / USD 0.025. Whether the base clip also pays an input-video charge is unconfirmed, so include that only in the upper bound.
- Context-IR: CNY 5.80 / USD 0.90 per M input tokens; CNY 23.00 / USD 3.60 per M output tokens.

Example assumptions, not a price promise: a 5 s standard-H3 768P generation (CNY 2.50) plus 5 s regeneration (CNY 1.50 output) is about CNY 4.00 at the floor; the upper bound is about CNY 5.50 only if the base clip also pays the CNY 0.30/s input-video charge. Original reference-video seconds add CNY 0.30/s to both bounds; images beyond the free allowance add their image fee. Direct 2K 5 s is about CNY 4.00. Do not claim a fixed ¥5.50 regeneration, a guaranteed saving, or a guaranteed loss; check the current regional catalog: [China pricing](https://platform.minimax.cn/docs/pricing/overview) / [international pricing](https://platform.minimax.io/docs/pricing/overview). The list prices, conservative upper bounds and raw usage reported here are estimates, not an actual account bill.

`video_budget`'s atomic cumulative reservations apply only to H3 generation and regeneration calls. Context-IR is token-priced, cannot carry a budget or max_cost, and needs explicit `allow_unbounded_cost:true` plus `override_reason`; it is not part of the reservation ledger. The ledger also does not include `image_generate` or Gemini/Claude token usage; a cross-tool total budget must be allocated by stage and reconciled with the other tools' receipts/usage by the lead, not assigned wholesale to `video_budget`.

## Measured output (smoke test, 2026-11-15)

A `MiniMax-H3-Lite` request at 480P, 4 s, 16:9 produced:

| Item | Measured |
|---|---|
| Dimensions | 864×480 (both divisible by 32) |
| Frame rate | 24 fps |
| Streams | H.264 video + AAC audio |
| Duration | 4.458 s (107 frames) |
| File size | 182 KB |

So the requested `duration` is nominal: H3 uses `17k + 5` frames, and a 4 s request lands at 107 frames. Check the real duration before cutting to a beat.

## Practical notes

- Download the MP4 as soon as the task succeeds; do not rely on the URL later.
- A 2K 15 s job is not instant; use `wait:false` or a short `wait_seconds` when the user wants to keep working.
- The plugin inlines local files up to the per-asset limits. Larger assets should be uploaded and passed as URLs; the 64 MB body cap is easy to hit with Base64.
- `response_format:"flat"` exists, but the plugin uses the default `task` shape because it is the same shape as query.
- `callback_url` needs a public HTTPS endpoint that echoes `challenge` within 3 seconds; not useful for a local desktop session.
- Tool-generated filenames are often UTC while approval messages/editing notes are local time. Normalize to one zone before claiming which take was approved; file mtime is not the approval time.
- Keep the downloaded original PNG and any transcoded JPEG as separate artifacts with separate hashes. A changed/re-encoded derivative does not prove the original was damaged.
