# Complete examples

Copy the structure, not the content. Each example is a single `prompt` string for one clip.

## 1. Text-to-video, 10 s narrative

```text
integrated_multimodal_description: [Shot 1] Cinematic live-action, 2.39:1, anamorphic. A narrow lighthouse stairwell at night: whitewashed brick, a single caged bulb, a rope handrail worn smooth. An old keeper in a navy wool sweater climbs slowly, one hand on the rail, a brass oil can in the other. His breath is short. The camera tracks behind him at a slow walking pace, slightly below eye level, keeping his shoulders in the lower third. [Shot 2] At 00:05.800, the camera cuts to a medium close-up at the lamp-room door. He stops, listens, and looks up as the rotating beam sweeps across his face, lighting one eye at a time. He does not open the door.

overall_soundscape: Wind pressure on the glass, the creak of the stair treads, the oil can sloshing, the keeper's short breaths, a low metallic groan from the lamp mechanism.

non_diegetic_music: A lone low cello, slow bowing, one note changing pitch as the beam passes.
```

## 2. Image-to-video, first and last frame, 8 s

Inputs: `first_frame` = woman kneeling in a dry field; `last_frame` = same framing, field green and wet, sapling in front of her.

```text
How the reference pictures align with the target video — Picture 1 (from [Shot 1]) aligns with the 0.00-second mark of the target video; Picture 2 (from [Shot 2]) aligns with the 8.00-second mark of the target video.

integrated_multimodal_description: [Shot 1] Live-action, 16:9, overcast soft light. A woman in her thirties, dusty canvas jacket, hair tied back, kneels in a dry cracked field and presses a small sapling into the soil with both hands. The camera sits at eye level, static, framing her centre with the horizon low. She packs the earth, sits back on her heels, and looks at the plant. [Shot 2] At 00:05.200, the same framing holds as the light shifts from grey to a clean late-afternoon gold; the field around her is now green and wet, the sapling taller, its leaves moving in a light wind. She wipes her hands on her trousers and exhales.

overall_soundscape: Dry earth crumbling, then soft wet soil, wind moving through leaves, a quiet exhale, distant birds returning.

non_diegetic_music: Warm acoustic guitar, slow arpeggio, opening into a sustained major chord at the light change.
```

Why it works: it describes the **path** — soil, light, plant height, her action — instead of restating two images.

## 3. Performance, 8 s monologue

```text
integrated_multimodal_description: [Shot 1] Live-action, 1.85:1, medium close-up, eye level, soft window light from the left. A woman in her late forties, short silver hair, dark turtleneck, sits at a kitchen table with a cold cup of tea. She looks down, then lifts her eyes to the off-screen interviewer. The camera sits still on a tripod; that exact shot size holds from the first frame to the last. She speaks quietly, with a low, measured voice (S1): <d>[Chinese] 你走的时候，海还没结冰。</d> She holds the eyeline for a beat, then blinks and looks back at the cup.

overall_soundscape: A quiet kitchen, the refrigerator hum, a clock ticking somewhere, the soft click of the cup settling on the saucer, one slow breath.

non_diegetic_music: N/A.
```

Note: one speaker, one line, stable framing, a beat after the line. The line is 11 Chinese characters, comfortable in 8 s.

## 4. Voiceover documentary, 10 s

```text
integrated_multimodal_description: [Shot 1] Documentary, 16:9, wide shot, blue hour. A frozen harbour: grey ice, a single fishing boat tied at the pier, ropes stiff with frost, no people. The camera drifts right at slow speed, revealing a row of empty crates and a closed shed. [Shot 2] At 00:06.000, the camera cuts to a close-up of a bare hand tying a rope around a cleat, breath visible, then releasing it.

A woman's voice, low and measured, says in an off-screen voiceover while no one on screen speaks and all on-screen lips remain closed: <d>[Chinese] 那年冬天，港口比人先醒来。</d>

overall_soundscape: Ice settling, wind across the harbour, rope creaking, water slapping a hull, one distant gull.

non_diegetic_music: Sparse sustained strings, slow, no percussion.
```

## 5. Reference-to-video, 10 s product film

Inputs: `<Picture 1>` the bottle, `<Picture 2>` the bathroom set, `<Picture 3>` the model's face, `<Audio 1>` a three-second voice reference.

```text
subject_definitions:
<Subject 1> a woman in her early thirties, dark hair in a low bun, bare shoulders, calm expression.
<Picture 1> a frosted amber glass bottle with a brushed-brass cap, no visible label text.
<Picture 2> a travertine bathroom at late afternoon, one high window, steam, a wet stone counter.
<Picture 3> the woman's face and hair, front view, neutral light.
<Audio 1> the woman's voice: low, soft, slightly breathy, Mandarin.

summary:
[reference generation] <Subject 1> stands at the counter from <Picture 2>, holds the bottle from <Picture 1>, and speaks in the voice of <Audio 1>.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair, bare shoulders.
<Picture 1> (appears in [Shot 1]): fully_preserved - bottle shape, amber glass, brass cap; no label text.
<Picture 2> (appears in [Shot 1]): partially_preserved - travertine, window light, steam; layout may simplify.
<Audio 1>: reference - timbre and delivery, new words.

detailed_description:
The target video is a premium skincare commercial, 9:16, soft late-afternoon window light, warm stone and amber palette, shallow depth of field. [Shot 1] Medium close-up: <Subject 1> stands at the travertine counter, hair damp, steam drifting behind her. She lifts the bottle from <Picture 1> into frame, turns it once so the brass cap catches the light, and says in the voice of <Audio 1>: <d>[Chinese] 先把夜放下。</d> The camera pushes in with small amplitude at slow speed, settling on the bottle and her hand. She sets it down and looks out of frame.

overall_soundscape: Steam hissing softly, a wet bottle base touching stone, water dripping, one quiet exhale.

non_diegetic_music: Warm analogue synth pad, slow, with a single soft piano note on the bottle landing.
```

## 6. 768P → 2K pipeline as tool calls

```json
{"prompt":"integrated_multimodal_description: [Shot 1] ...","model":"MiniMax-H3","resolution":"768P","duration":5,"ratio":"16:9"}
```

After the 768P clip is downloaded:

```json
{"video":"generated-videos/2026-11-15_01-30-00-lighthouse.mp4","prompt":"integrated_multimodal_description: [Shot 1] ...","duration":5}
```

The regeneration `prompt` must be the **final prompt actually sent** for the 768P clip, and every original image/video/audio must be supplied again. If the source was made by `source_task_id` and the account has whitelist access, the short form is:

```json
{"source_task_id":"424010985738629"}
```

For a deliberate full-2K workflow, structure the prompt first:

```json
{"prompt":"A keeper climbs a lighthouse at night and hears something at the lamp-room door.","duration":10}
```

then pass the returned `prompt` to `video_generate` at 768P, inspect the clip, and only then regenerate. Do not rewrite the prompt between the 768P generation and the 2K regeneration.
