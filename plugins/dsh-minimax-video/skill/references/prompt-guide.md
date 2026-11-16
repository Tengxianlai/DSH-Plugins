# H3 prompt guide

The H3 API takes one `text` item plus optional media. Plain prose works, but the model was trained and is documented around a three-field structure that also appears in Context-IR output. Production prompts use it because it makes timing, dialogue and sound reliable.

This guide is a practical convention, not an extra API parameter. The three fields are all inside the same `prompt` string.

## Skeleton

```text
integrated_multimodal_description: [Shot 1] <style and format>. <framing and subject>. <place and spatial anchors>. <action and state change>. <camera>. <light and color>.
[Shot 2] At 00:04.500, the camera cuts to <new information>. <action>. <camera>. <light>.

overall_soundscape: <1-4 sentences of ambience, physical action, non-verbal human sound>.

non_diegetic_music: <1-3 sentences of score: instruments, tempo, rhythm, dynamics; or N/A>.
```

Field names and order are fixed. Do not add a fourth field. Do not number the fields differently.

## integrated_multimodal_description

This is the shot script. It carries everything visible and everything synchronized to a shot.

### Shot 1

- No timestamp. Start with `[Shot 1]`.
- Establish, in this order: style/format (live-action, cinematic, anime, 3D, archival, etc.), framing (wide, medium, close-up, macro), subject (age, build, hair, wardrobe, posture), place and spatial anchors, then the action and the change of state.
- Name the light: direction, quality, color temperature, practical sources.
- One clear action or emotional beat. Do not stack three actions into a 4 s shot.

### Later shots

```text
[Shot 2] At 00:04.500, the camera cuts to a close-up of the hands as the lid swings open.
```

- Use `[Shot N] At MM:SS.mmm, the camera cuts to ...`. Times must strictly increase and stay inside the clip.
- A cut must add information, viewpoint, space, state or time. If it only reframes slightly, move the camera instead.
- At most about three shots in 10 s. More cuts than that read as a slideshow.
- Do not restate the whole scene at every cut, but do re-identify who is in the new shot; H3 does not keep an off-screen cast list.

### Camera sentences

Write the move into the action, not as a tag list:

```text
The camera pushes in with small amplitude at slow speed, settling on the brass key in her hand.
```

```text
The camera trucks right, keeping her in the left third while the background crowd slides past.
```

See `camera.md` for the vocabulary and durations.

### Dialogue

Give every vocal source a stable speaker id and put only the language plus exact words inside `<d>`:

```text
the baker, a middle-aged man with a calm, slightly raspy voice (S1), sets down the loaf and says: <d>[English] First batch of the morning.</d>
```

- `(S1)`, `(S2)` … only for people, characters, narrators or other actual vocal sources. Reuse the same id across shots.
- Identity, delivery and action stay outside `<d>`; only `[Language]` and the exact line go inside.
- Keep the user's words and punctuation verbatim. Do not translate their line unless they ask.
- One speaker per shot. Two speakers in one shot often puts a voice on the wrong mouth.
- Put a short beat after the line so the ending is not clipped.
- Across clips, voice consistency is a separate problem: `reference_audio` cannot be combined with `first_frame`. Use reference mode with `<Picture N>` + `<Audio N>`, or chain frames and dub later. See `continuity-and-voice.md`.

### Voiceover

```text
she says in an off-screen voiceover while her lips remain completely closed: <d>[Chinese] 那年冬天，海面结了冰。</d>
```

State that the on-screen lips stay closed. Otherwise the model may animate a speaking mouth.

### Speech that crosses a cut

- Use `<scenetrans>` in both connected segments and say the audio is continuous.
- Use `<cutoff>` when the clip ends mid-line.

### Visible text

Put on-screen text in English double quotation marks, preserve its original language and punctuation, and say where it sits:

```text
a red vertical banner on the right reads "今日营业".
```

Text is a common failure point. Keep it short, high-contrast and explicitly placed.

### Physical detail beats adjectives

Prefer age, hair, fabric, posture, object material, weather, distance and light direction over "beautiful", "epic" or "cinematic quality". The style word can open the prompt; the rest should be observable.

### Positive phrasing

There is no negative prompt. Guidance is effectively 1.0, so every word is rendered:

- Bad: "no cars, no people".
- Good: "an empty rain-slick street, closed shutters, one flickering sign".

If something must not move, say what it does: "the camera sits still on a tripod; that exact shot size holds from the first frame to the last."

Hands are a known weak point: counts and plurals invite extra fingers. Keep hands in wide/medium shots; for a macro insert, show the object alone.

## overall_soundscape

One continuous paragraph, 1–4 sentences, covering what is heard **in the scene**:

- ambience (room tone, weather, traffic, crowd)
- physical action (shutters scraping, trays clinking, fabric, footsteps)
- non-verbal human sound (breath, laugh, gasp)
- decisive impacts that belong to a specific shot

Do not repeat dialogue or music here. Do not name sounds nothing in the shot can make: a generic city bed may return as hiss. Use `N/A` only for explicit total silence.

## non_diegetic_music

One to three sentences for score the characters cannot hear. Name instruments, tempo/rhythm and dynamic evolution:

```text
A soft acoustic-guitar pattern at a moderate tempo with sparse upright-bass notes, rising slightly as the door opens.
```

Use `N/A` when there is no score. Avoid abstract mood words on their own ("sad music"); they give the model less to work with than "a lone cello, slow, one sustained note".

## Image-to-video alignment

When a first or last frame is supplied, add an alignment line before the three fields. This tells the model exactly when the picture is pinned.

First frame only:

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
```

First and last frame:

```text
How the reference pictures align with the target video — Picture 1 (from [Shot 1]) aligns with the 0.00-second mark of the target video; Picture 2 (from [Shot 3]) aligns with the 8.00-second mark of the target video.
```

Last frame only is not a supported API combination: last frame requires a first frame.

For first-and-last-frame clips, describe the **observable path** between the two images: what changes, in what order, and what causes it. Do not merely restate both images.

## Reference-to-video schema

For complex reference jobs, a longer structured prompt is easier to control. One community-tested shape:

```text
subject_definitions:
<Subject 1> a woman in her thirties, red wool coat, silver bob, a thin scar above the left brow.
<Picture 1> the woman's face and coat, front view.
<Picture 2> the alley: wet brick, green door, one sodium lamp.
<Video 1> the camera rhythm: slow lateral track, two cuts.
<Audio 1> the woman's voice: low, measured, Mandarin.

summary:
[reference generation] The woman from <Subject 1> walks through the alley from <Picture 2>, matching the camera rhythm of <Video 1>, and speaks in the voice of <Audio 1>.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair, coat, scar.
<Picture 2> (appears in [Shot 1]): partially_preserved - layout, door, lamp color; weather may change.
<Video 1>: attribute_transfer - camera rhythm only, not subject or place.
<Audio 1>: reference - timbre and delivery, new words.

detailed_description:
The target video is live-action, 2.39:1, cool sodium light with a warm door practical. [Shot 1] ...
```

Retention markers for visible references: `fully_preserved`, `partially_preserved`, `attribute_transfer`, `weak_reference`. For audio: `fully_copy`, `partially_copy`, `reference`, `weak_reference`. Say what is free as well as what is fixed.

Keep every label stable across all sections. Do not create a standalone `<Picture N>` when the picture only defines a subject; cite it inside that subject definition.

## Drafting order

Write the prompt in this invisible order, then weave it into the fields:

1. format/style
2. reference responsibilities
3. identity
4. spatial map
5. first-frame state
6. timed action
7. performance
8. optics / camera / focus
9. physics and materials
10. light and color
11. synchronized sound
12. stable-state locks ("the camera stays on a tripod; the coat color holds")
13. known failure exclusions, phrased positively

The order is a checklist, not a required sentence order. The final prompt should read as prose, not as a form.

## Speech timing

| Words | Comfortable length | Notes |
|---|---|---|
| 10 | ~5 s | one short line, room for a beat |
| 16 | ~8 s | dialogue plus reaction |
| 22 | ~12 s | clear at normal pace |
| 28 | ~15 s | practical maximum |
| 34 | >15 s | too fast or truncated |

English planning heuristic: `seconds ≈ words / 3.3 / 0.57`; the fill factor is an allowance, not a measured speech interval. The table is not a Chinese word-count rule. Chinese needs character/syllable-based planning and an actual local ASR plus waveform check after generation. Requested duration, returned source duration, spoken interval and used edit interval must remain separate. Leave breathing/tail room; do not mechanically truncate an adopted short source or its last syllable.

## Final check

- Does Shot 1 establish style, subject, place and action before any cut?
- Is every cut time increasing and inside the duration?
- Is there one primary camera move per shot?
- Does each speaker have one stable id and one exact line?
- Is voiceover marked with closed lips?
- Does `overall_soundscape` avoid dialogue and music?
- Is `non_diegetic_music` either specific or `N/A`?
- Is every reference label defined and assigned a job?
- Is anything phrased as a negation that should be a positive state?
