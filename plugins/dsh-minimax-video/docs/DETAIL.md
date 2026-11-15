# MiniMax H3 video

Five tools and one loadable skill for MiniMax H3 (Hailuo 3 / Hailuo-03 / 海螺 H3), the multimodal video model that returns one 4–15 second clip with native synchronized sound.

## What it covers

- **Four tiers**: `MiniMax-H3` (768P/2K quality), `MiniMax-H3-Highspeed` (480P/768P), `MiniMax-H3-Lite` (480P/768P budget), `MiniMax-H3-Max` (480P/768P multi-asset reference plus prompt expansion).
- **Three input modes**: text-to-video, image-to-video with first and/or last frame, and reference-to-video with up to 9 images, 3 clips and 3 audio clips.
- **Official 768P-to-2K regeneration**: by source task id (whitelist) or by 768P source video plus the original prompt and media.
- **Official H3-Context-IR**: turn a vague draft or a set of references into a structured prompt without generating a video.
- **Catalog and cost**: `video_models` prints the resolution/duration matrix, input limits and the 2026-11-15 list-price snapshot for both the China (CNY) and international (USD) regions.

## Tools

| Tool | What it does |
|---|---|
| `video_models` | Tier, resolution, duration, price, limits and regeneration rules. No network. |
| `video_generate` | Creates a task, waits, downloads the MP4, returns its path and cost estimate. |
| `video_task` | Query, wait, download, cancel a queued task or delete a finished record. |
| `video_regenerate` | Official 768P to 2K regeneration. |
| `video_prompt_enhance` | H3-Context-IR prompt structuring only. |

Every parameter carries its effect and its constraints in the tool schema, so a caller can choose `model`, `resolution`, `duration`, `ratio` and reference roles without reading the vendor docs first.

## The skill

The bundle registers `minimax-video`, loaded on demand. It contains:

- the three-field prompt shape and shot timeline;
- camera vocabulary with amplitude, speed and duration guidance;
- dialogue, voiceover and soundscape rules, including a words-per-second budget;
- nine content recipes (story, performance, voiceover, product, brand, action, montage, animation, UI);
- the 768P-to-2K pipeline and the API/error reference.

The recipe names are prompt strategies, not API parameters.

## Quick start

1. Call `video_models` to choose a tier and see the price.
2. Write the prompt with the `minimax-video` skill, or call `video_prompt_enhance` first.
3. Call `video_generate` with the prompt and, optionally, `first_frame` / `last_frame` or `reference_*`.
4. The MP4 lands in `generated-videos/` unless the task hits the wait cap; then use `video_task`.

## Important limits

- One call produces one 4–15 s clip. There is no extension endpoint; longer films are separate clips joined externally.
- 2K is only available on `MiniMax-H3`; 480P is only on Highspeed, Lite and Max; Max starts at 5 seconds.
- First/last frames and reference media are mutually exclusive, so a pinned first frame and a recurring voice reference cannot be sent in one call. The skill's `continuity-and-voice` reference gives the three workflows (reference mode, frame chain plus dub, or one-clip dialogue).
- Regeneration is not a generic upscaler: the source must be an H3 768P output with audio, 24 fps, dimensions divisible by 32 and 107–362 frames. It also costs more than direct 2K for the same duration.
- Local media is inlined up to the per-asset limits; large assets should be URLs because the whole request body is capped at 64 MB.
- Prices are a snapshot; update `lib/catalog.js` and the skill's `api-notes.md` after a vendor price change.

## Verification

The offline self-test covers tool registration, schemas, the tier/resolution/duration matrix, ratio and exclusivity rules, request bodies including `base_video`, cost estimates, media inlining and all skill documents. It makes no network request and incurs no charge. A paid end-to-end smoke test was run on 2026-11-15: Lite, 480P, 4 s, 16:9 produced a 864×480, 24 fps, H.264 + AAC, 4.46 s MP4 and the download completed.
