# Continuity and voice across clips

H3 outputs one 4–15 s clip per call, so a scene often spans several calls. Select the approved same-shot keyframe and its character/scene lineage first. A video screenshot is an exception for an actual continuation state: explain the need and inspect the frame before submission. This page describes the available continuity modes; it does not make tail-frame chaining the default.

Two kinds of continuity pull in opposite directions:

| What must stay consistent | Mechanism | Billing |
|---|---|---|
| Exact visual continuation | last frame of clip A → `first_frame` of clip B | image input |
| Face, hair, costume, prop | `reference_image` + `<Picture N>` | first 5 images free (Max 2) |
| Voice timbre and delivery | `reference_audio` + `<Audio N>` | audio input free |
| Motion, camera, editing rhythm | `reference_video` + `<Video N>` | input seconds billed |

## The conflict nobody warns you about

`first_frame` / `last_frame` and `reference_image` / `reference_video` / `reference_audio` are **mutually exclusive in one request**. `reference_audio` is a reference role, so:

> You cannot pin clip A's last frame as clip B's first frame **and** pass a voice reference in the same call.

The plugin rejects that combination before sending it. Pick one of three workflows.

## A. Reference mode: identity + voice, no frame pin

Best for a dialogue-driven series where the same character speaks across many clips.

- Supply a character sheet `<Picture 1>` (face, hair, wardrobe) and one clean voice sample `<Audio 1>`.
- Use `reference_images` + `reference_audio`, **not** `first_frame`.
- On every clip, name both and give them jobs:

```text
subject_definitions:
<Subject 1> the woman in her thirties, red wool coat, silver bob, thin scar above the left brow.
<Picture 1> her face, hair and coat, front view, neutral light.
<Audio 1> her voice: low, measured, Mandarin, slight rasp.

summary:
[reference generation] <Subject 1> speaks in the voice of <Audio 1>.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair, coat, scar.
<Picture 1> (appears in [Shot 1]): fully_preserved - face, hair, coat.
<Audio 1>: reference - timbre and delivery, new words.

detailed_description:
... she says in the voice of <Audio 1>: <d>[Chinese] 你走的时候，海还没结冰。</d> ...
```

- Keep the style sentence, speaker id and voice reference identical on every clip.
- Start each clip from a similar pose and blocking, described in words. Accept small visual jumps at the joins; the voice is the anchor.
- Do not also pass `first_frame`; the API will reject the mix.

**Trade-off:** identity and voice stay stable, but the first frame is not pixel-identical to the previous clip. Cut on motion, a reaction, or a match cut to hide the join.

## B. Frame-chain mode: exact visuals, dub later

Best for an action scene, a continuous camera move, or a match cut where a visible jump would break the illusion.

- `first_frame` = the last frame of clip A.
- Do **not** pass reference audio; H3 will invent a new voice for each clip.
- For a recurring character, either accept the voice drift or plan to replace the voice:
  1. Generate the visual with no dialogue (or neutral dialogue).
  2. Set `overall_soundscape: N/A` and `non_diegetic_music: N/A` if you want a clean plate. H3 still produces an audio track, so mute or replace it in the edit.
  3. Dub with one consistent TTS/voice clone, then align lips or use a lip-sync pass.
- Keep the style sentence and light direction identical; describe the new action from the pinned pose.

**Trade-off:** the join is seamless, but the native voice is not carried across clips.

## C. One-clip dialogue: avoid the problem

If the exchange fits 15 s, keep it in one generation. Then there is no cross-clip voice drift.

- One speaker per shot; two speakers in one shot often puts a voice on the wrong mouth.
- 22 words is comfortable, 28 is the practical maximum at normal pace.
- For a two-hander, use two shots and cut between them; each shot gets its own speaker.
- If the whole scene is under ~12 s, this is usually the best quality-per-yuan option.

## Voice reference recipe

A voice reference is only as good as the sample:

- One clean **3–10 s** recording per character is a useful target; the API accepts 2–15 s per clip. Retain the actual accepted source.
- Use the **same adopted native voice sample** on later clips. It may be extracted from an accepted earlier H3 character seed after checking one speaker, speech quality, ambience and music. The sample supplies timbre; its words need not match the new line. Do not substitute an old animatic TTS guide for an adopted native character voice.
- WAV or MP3, 2–15 s per clip, <= 15 MB, up to 3 clips, total <= 15 s.
- Name it `<Audio 1>` and state what is preserved:
  - `reference` — timbre and delivery, new words (normal dialogue).
  - `fully_copy` — reuse the exact audio.
  - `partially_copy` — reuse part of it.
  - `weak_reference` — loose inspiration only.
- Once the audio reference is attached, drop timbre adjectives from the prose (the reference carries them) and describe delivery and emotion instead: "quiet, measured, a beat before the last word".
- Keep the speaker id `(S1)` stable across shots. Do not renumber between clips.
- Keep the same language tag inside `<d>`. Switching language can change the voice.
- For voiceover, write "off-screen voiceover ... lips remain completely closed" and use the same `<Audio 1>`.
- If the voice still drifts: shorten the line, reduce the number of shots, and use a 5–8 s steady-speech reference rather than a 2 s clip.

## Decision table

| Priority | Workflow | What you accept |
|---|---|---|
| Voice consistency across many clips | A: reference image + reference audio | small visual jumps; no frame pin |
| Exact visual continuation | B: last frame → first frame | new voice per clip; dub in post |
| Short exchange, best quality per yuan | C: one clip | must fit 4–15 s |
| Both voice and exact frame | not possible in one API call | A then post-align, or B then dub |

## Checks before you submit

1. Am I mixing `first_frame` with `reference_audio`? The plugin will reject it; choose A or B.
2. Is the voice reference clean, 3 s+, and the same file as the previous clip?
3. Is the speaker id stable, and is there only one speaker in the shot?
4. Does the exact line fit the intended spoken interval plus breathing/tail? The 3.3 words/s heuristic applies to English word counts; Chinese needs character/syllable estimation and an actual local speech check.
5. Does `retention_analysis` say what is copied and what is free?
6. If chaining frames, did I describe the path from the pinned pose instead of restating the image?
