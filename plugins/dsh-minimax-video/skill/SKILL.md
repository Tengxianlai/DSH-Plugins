# MiniMax H3 video

MiniMax H3 — also written Hailuo 3, Hailuo-03, 海螺 H3 — turns text, images, video and audio into **one 4–15 second clip with native synchronized sound**: dialogue, foley, ambience and score are generated with the picture, not added later. Four tiers share one API but not one feature matrix.

Use this skill before writing or reviewing an H3 prompt, choosing a tier or resolution, blocking camera moves, designing a multi-shot clip, or running the 768P-to-2K regeneration.

## Route the request

| Need | Tool |
|---|---|
| Tier, resolution, duration, price, limits | `video_models` |
| A new clip from text, first/last frames, or reference media | `video_generate` |
| Status, wait, download, cancel/delete | `video_task` |
| Official 768P → 2K regeneration | `video_regenerate` |
| Structure a vague prompt or assign reference roles | `video_prompt_enhance` (H3-Context-IR) |

Call `video_models` before answering "which model / how much"; its price snapshot is the source of truth in this plugin.

## Hard constraints

- **One call = one clip, 4–15 s** (Max: 5–15 s). There is no extension endpoint. For a longer piece, generate several clips and join them; carry the last frame into the next clip as `first_frame` for continuity.
- **Duration is nominal.** H3 renders `17k + 5` frames at 24 fps: a 4 s request is 107 frames ≈ 4.46 s, so the file can run slightly longer than the number you passed. Leave headroom when cutting to a fixed beat.
- **2K only on `MiniMax-H3`.** Highspeed, Lite and Max stop at 768P; 480P exists only on those three.
- **Frames and references are mutually exclusive.** `first_frame`/`last_frame` is image-to-video; `reference_image`/`reference_video`/`reference_audio` is reference-to-video. Never mix them.
- **`last_frame` needs `first_frame`.**
- **Prompt ≤ 7000 characters** per text item.
- **H3 always produces audio.** Write the sound you want. If the user truly wants silence, say it explicitly in both sound fields (`overall_soundscape: N/A`, `non_diegetic_music: N/A`).
- **No negative prompts.** Guidance is effectively 1.0: every word renders. "No cars" tends to add cars. Describe what is present instead ("an empty rain-slick street").
- **Text-to-video needs a concrete ratio** (default 16:9). Image-to-video follows the frame image. Reference-to-video defaults to adaptive; Lite must name a concrete ratio.

## Longer than one clip

H3 has no extension endpoint. Two continuity tools pull in opposite directions:

- **Exact visual join:** use the last frame of clip A as `first_frame` of clip B.
- **Recurring voice:** use `reference_audio` + `<Audio 1>`, but reference audio **cannot** be combined with `first_frame` in one request.

So choose one:

1. **Reference mode** — `<Picture 1>` character sheet + `<Audio 1>` voice reference on every clip. Voice and identity stay stable; accept small visual jumps at the joins.
2. **Frame chain** — last frame → `first_frame` for a seamless join. H3 invents a new voice each clip; dub the recurring character later.
3. **One clip** — if the exchange fits 15 s, keep it in one generation. This is usually the best quality per yuan.

Full recipes and a decision table: `references/continuity-and-voice.md`.

## Pick a tier

| Tier | Use it for | Resolution | Duration |
|---|---|---|---|
| `MiniMax-H3` | final quality, 2K delivery | 768P / 2K | 4–15 s |
| `MiniMax-H3-Highspeed` | everyday social content | 480P / 768P | 4–15 s |
| `MiniMax-H3-Lite` | drafts, variants, batch tests | 480P / 768P | 4–15 s |
| `MiniMax-H3-Max` | many reference assets + prompt expansion | 480P / 768P | 5–15 s |

A sensible loop: **Lite 480P 4 s to test the idea → Highspeed 768P to test motion and sound → H3 2K for delivery.** Direct 2K is usually cheaper than 768P plus regeneration; regenerate when you already have a 768P cut you like, or when you deliberately iterate at 768P.

## The prompt is a small shot script

The API accepts plain prose, but H3's Context-IR output and production prompts use a three-field shape. Write it in English; keep only exact dialogue, on-screen text and proper nouns in their original language.

```text
integrated_multimodal_description: [Shot 1] <style, framing, subject, place, action, camera, light> [Shot 2] At 00:04.500, the camera cuts to <new information>.

overall_soundscape: <1–4 sentences: ambience, action sounds, non-verbal human sounds>

non_diegetic_music: <1–3 sentences: instruments, tempo, dynamics; or N/A>
```

- `[Shot 1]` has no timestamp. Later cuts use `[Shot 2] At 00:04.500, the camera cuts to ...`, strictly increasing and inside the clip.
- A cut must add information, viewpoint, space, state or time. For a modest reframing, move the camera instead of cutting.
- Keep the style sentence stable across clips of the same film.
- 350–500 English words is a useful ceiling for a complex 10–15 s clip; a simple 5 s clip needs far less. Correct timing beats word count.

See `references/prompt-guide.md` for dialogue tags, voiceover, reference labels, alignment lines and retention markers.

## Block the camera, do not decorate it

Name one primary move per shot, with type, direction, amplitude and speed only when they matter:

- `push in` / `pull out` — the camera body moves.
- `zoom in` / `zoom out` — focal length changes, camera stays.
- `pan` / `tilt` — pivot from a fixed position.
- `truck` / `pedestal` — translate sideways / vertically.
- `arc` / `tracking` / `static` / `POV` / `roll` / `handheld`.

Write it as prose inside the shot, not as a tag list. `references/camera.md` has the full table, durations and failure modes.

## Sound is part of the direction

- Put shot-synchronized dialogue, singing, diegetic music and decisive impacts in `integrated_multimodal_description`.
- `overall_soundscape` covers ambience, physical action and non-verbal voice for the whole clip. Name only sounds something in the shot makes; a generic "city traffic" bed can come back as hiss.
- `non_diegetic_music` is score the characters cannot hear. Describe instruments, tempo and dynamics, not abstract emotion.
- Speech is about 3.3 words per second and fills roughly 57% of a clip: 22 words is comfortable, 28 is the practical maximum, 34 is too fast. Size the clip to the line, and leave a beat after it.

## References: assign a job to every asset

In reference-to-video, name each asset in the prompt and state what is preserved:

- `<Picture 1>` … `<Picture 9>` — identity, costume, prop, environment, style, composition.
- `<Video 1>` … `<Video 3>` — motion, camera structure, editing rhythm, or the clip's own sound.
- `<Audio 1>` … `<Audio 3>` — voice timbre, music, rhythm, effect texture.
- `<Subject 1>` … — a reusable visible identity assembled from the pictures.

Say **what is copied and what is free**: "the woman's face and red coat follow `<Picture 1>`; the alley layout follows `<Picture 2>`; the camera rhythm follows `<Video 1>`; everything else is new." Ambiguous references get averaged into a new face.

## Content archetypes

The user's labels — 故事型, 演绎型, 叙述型 — are not API parameters. They are three different balances of shot plan, performance and sound. `references/video-types.md` gives recipes for:

narrative story · performance / dialogue · voiceover narration · product / e-commerce · brand film · action · montage / MV · animation / stylized · UI / game demo.

Read the matching recipe before writing, then adapt it; do not paste a template unchanged.

## 768P → 2K regeneration

`video_regenerate` calls the official `/v2/video_regeneration` endpoint. It is **not** a generic upscaler:

- Source must be a **MiniMax-H3 768P output**: 24 fps, audio track present, width and height divisible by 32, area between 768×768 and 768×1344, 107–362 frames in steps of 17 (about 4–15 s).
- Base-video mode must resubmit the **exact final prompt and all original reference media**; a mismatch can change the result.
- `source_task_id` mode needs whitelist access and a succeeded task inside the 7-day query window.
- Regeneration re-bills the original input media and costs output + input-video seconds. For a 5 s clip, 768P + regeneration is usually more expensive than direct 2K.

## Before you submit: a five-point check

1. **Length**: does the action or line fit 4–15 s? If not, split it.
2. **One idea per shot**: is there a clear subject, action and change of state?
3. **Camera**: one named move, motivated by the action?
4. **Sound**: dialogue timed, ambience specific, score separate?
5. **References**: every `<Picture>`, `<Video>`, `<Audio>` named and given a job?

## References

- `references/prompt-guide.md` — three-field prompt, timeline, dialogue, sound, reference schema.
- `references/camera.md` — movement vocabulary, amplitude/speed, shot duration, common errors.
- `references/video-types.md` — nine content recipes with shot plans and skeletons.
- `references/examples.md` — complete prompts across modes.
- `references/continuity-and-voice.md` — last-frame chaining, the first_frame/reference_audio conflict, voice-reference recipe and decision table.
- `references/api-notes.md` — endpoint/field/limit/error reference and the pricing snapshot.

Official docs: [video generation](https://platform.minimax.io/docs/guides/video-generation), [create task](https://platform.minimax.io/docs/api-reference/video-generation-v2-create), [regeneration](https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration), [Context-IR](https://platform.minimax.io/docs/api-reference/video-generation-v2-h3-context-ir).
