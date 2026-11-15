# Content recipes

These are prompt recipes, not API parameters. The user's names — 故事型, 演绎型, 叙述型 — map to three balances of the same three-field prompt:

| User label | Recipe | What dominates |
|---|---|---|
| 故事型 | narrative story | shot plan and change of state |
| 演绎型 | performance / dialogue | face, voice, line timing |
| 叙述型 | voiceover narration | off-screen voice plus b-roll |
| 产品型 | product / e-commerce | object detail and controlled light |
| 品牌型 | brand film / trailer | tone, scale, a single idea |
| 动作型 | action / battle | physical continuity and impacts |
| 蒙太奇 | montage / MV | rhythm and match cuts |
| 动画型 | animation / stylized | a consistent visual grammar |
| 界面型 | UI / game demo | readable screen motion |

Pick one before writing. A clip that tries to be a story, a product demo and a brand film at once usually fails all three.

## Duration budget

| Duration | Beats | Cuts | Typical shape |
|---|---|---|---|
| 4–5 s | 1 | 0–1 | one action, one reveal, one line |
| 6–8 s | 2 | 1 | setup → reaction |
| 9–12 s | 2–3 | 1–2 | setup → turn → payoff |
| 13–15 s | 3 | 2–3 | setup → turn → payoff → button |

One beat = one change the viewer can name. If you cannot say the change in one sentence, the clip is overloaded.

## 1. Narrative story (故事型)

**Use for:** a tiny story with a turn, a trailer beat, a short drama scene, a joke with a payoff.

**Shape:** a person wants something → an obstacle or discovery → a reaction. The last shot should change the meaning of the first.

- 5 s: one action that implies the story ("she hides the letter as the door opens").
- 10 s: setup + reaction; cut on the reveal.
- 15 s: setup + turn + payoff; keep the camera calm and let the cut do the work.

**Skeleton:**

```text
integrated_multimodal_description: [Shot 1] Cinematic live-action, 2.39:1. A cramped late-night kitchen, one warm pendant light, rain on the window. A woman in her late thirties, damp hair, grey hoodie, stands over the sink, holding a folded letter without opening it. She breathes once, then turns the letter face down. The camera pushes in with small amplitude at slow speed. [Shot 2] At 00:06.200, the camera cuts to a close-up of the letter on the wet counter; a thumb presses the crease flat, then withdraws. The pendant light flickers once.

overall_soundscape: Rain ticking on glass, the fridge humming, the soft wet slap of the letter against the counter, one unsteady breath.

non_diegetic_music: A single low piano note, repeated with long gaps, no resolution.
```

**Sound:** the turn usually has a sound accent (a click, a breath, a door). Put it in the shot where it happens.

**Pitfalls:** explaining backstory in the prompt; three actions in 5 s; a cut that only changes angle.

## 2. Performance / dialogue (演绎型)

**Use for:** monologue, talking head, two-hander, lip-sync, character reveal, screen-test energy.

**Shape:** one face, one line, one shift in the eyes. The camera should be stable and close; the performance carries the clip.

- 5 s: one short line (about 10–14 words) plus a reaction.
- 10 s: two lines or one line plus a long look.
- 15 s: 22–28 words maximum, with a beat before or after.

**Skeleton:**

```text
integrated_multimodal_description: [Shot 1] Live-action, 1.85:1, medium close-up, eye level. A man in his fifties, grey stubble, dark wool coat, sits across a bare table in a pale interview room. He looks at the off-screen interviewer, then down at his hands, then back up. The camera sits still on a tripod; that exact shot size holds from the first frame to the last. He says, quietly, with a dry rasp (S1): <d>[English] I didn't come back for the money.</d> He blinks once and holds the interviewer's eyeline.

overall_soundscape: A quiet room, a chair creaking once, the fabric of his coat shifting, a slow exhale through the nose.

non_diegetic_music: N/A.
```

**Sound:** voice first. Room tone should be quiet but present; a completely dead room sounds synthetic. Do not add score under a confession unless the genre wants it.

**Pitfalls:** two speakers in one shot; a line too long for the duration; camera movement during the line; describing emotion ("he looks guilty") instead of behavior ("his jaw tightens, his eyes drop").

## 3. Voiceover narration (叙述型)

**Use for:** documentary, essay film, brand narration, explainer, memory piece, b-roll with a voice.

**Shape:** an off-screen voice carries meaning; the images illustrate, contradict or widen it. The on-screen person must not look like they are speaking.

- 5 s: one image, one sentence.
- 10 s: two images, one sentence plus a turn.
- 15 s: two or three images, 22–28 words.

**Skeleton:**

```text
integrated_multimodal_description: [Shot 1] Documentary, 16:9, wide shot, overcast dawn. A frozen harbour, grey water, a single fishing boat at the pier, gulls on the rail. No people in frame. The camera drifts right at slow speed, revealing a row of empty crates. [Shot 2] At 00:07.000, the camera cuts to a close-up of a gloved hand coiling wet rope, breath visible in the cold.

A woman's voice, low and measured, says in an off-screen voiceover while no one on screen speaks and all on-screen lips remain closed: <d>[Chinese] 那年冬天，港口比人先醒来。</d>

overall_soundscape: Wind across the harbour, rope creaking, water slapping the hull, one distant gull.

non_diegetic_music: Sparse sustained strings, slow, no percussion.
```

**Sound:** keep the voice dry and forward; ambience low; music restrained. The line is the spine.

**Pitfalls:** showing a person whose lips move while the voice is off-screen; too many words; b-roll that merely repeats the line instead of adding an image.

## 4. Product / e-commerce (产品型)

**Use for:** product hero, feature reveal, packaging, fashion, food, unboxing.

**Shape:** one product, one light idea, one movement that reveals a feature. The product must stay consistent in shape, color and label.

- 5 s: one hero move (arc or push) on one product.
- 10 s: detail cut plus hero.
- 15 s: texture → feature → hero, three shots maximum.

**Skeleton:**

```text
integrated_multimodal_description: [Shot 1] High-end commercial, 9:16, macro. A matte-black wireless earbud case on a polished concrete plinth, one hard key light from the upper left, a thin rim light on the right edge. The case rotates slowly on a turntable; the lid opens with a soft magnetic click. The camera arcs around it with small amplitude at slow speed, keeping the logo in the left third. [Shot 2] At 00:04.800, the camera cuts to a macro of the brushed-metal hinge, then racks focus to the LED dot.

overall_soundscape: A quiet studio, the magnetic click of the lid, a low air-conditioning hum, the faint squeak of the turntable.

non_diegetic_music: Minimal electronic pulse, 90 BPM, one deep sub hit on the lid opening.
```

**Sound:** product sounds are selling points; make them specific and close. Avoid a generic whoosh.

**Pitfalls:** label drift (counts of letters/points wander — keep packaging simple or show it briefly); hands in macro; more than one product idea; a "floating in space" background with no light logic.

## 5. Brand film / trailer (品牌型)

**Use for:** manifesto, launch teaser, title card, premium brand mood, event open.

**Shape:** one idea, stated in one image, then escalated. Scale and negative space matter more than plot.

- 5 s: one iconic image plus a title beat.
- 10 s: two images that rhyme.
- 15 s: three images building to a logo or line.

**Skeleton:**

```text
integrated_multimodal_description: [Shot 1] Cinematic, 2.39:1, anamorphic. A lone female captain stands before a colossal curved observation window on a dark starship bridge; a fleet assembles in a violet nebula outside. She does not move. The camera pushes in with small amplitude at slow speed. [Shot 2] At 00:06.000, the camera cuts to a medium close-up in profile as a blinding cyan jump flash floods the bridge; she braces, eyes narrowed. The light dies; the window is empty.

overall_soundscape: Deep engine thrum, console chirps, a sub-bass boom, then a stark mechanical hum in sudden quiet.

non_diegetic_music: Brass and strings rising in a slow crescendo, cut off abruptly into one sustained low cello note.
```

**Sound:** the cut to silence is often the strongest brand beat. Use it deliberately.

**Pitfalls:** casting a "story" into 15 s; too many logos; a score that resolves when the film should feel unresolved.

## 6. Action / battle (动作型)

**Use for:** fight beat, chase, creature reveal, impact, sports.

**Shape:** one continuous physical action with a clear geography, then an impact. The camera should be close to the action but not chaotic.

- 5 s: one impact or one dodge.
- 10 s: wind-up + impact.
- 15 s: approach + exchange + consequence.

**Skeleton:**

```text
integrated_multimodal_description: [Shot 1] Gritty live-action, 2.39:1, low angle, handheld. A rain-soaked alley, sodium light, steam from a grate. A courier in a torn yellow jacket sprints toward camera, vaults a low crate, lands badly, and keeps running. The camera tracks backward at a fast walking pace, half a metre above the ground, keeping him centre frame. [Shot 2] At 00:05.400, the camera cuts to a close-up of a boot skidding on wet concrete, then a hard low-angle shot as a shadowed figure fills the alley behind him.

overall_soundscape: Rain, wet footsteps, a crate skidding, a sharp metallic clang, both men breathing hard.

non_diegetic_music: Fast percussive strings, 140 BPM, a hard hit on the vault.
```

**Sound:** impacts need a frame; name them in the shot where they land.

**Pitfalls:** describing a whole fight in 15 s; camera shake substituting for choreography; no spatial anchor (where are they, what is between them?); weightless impacts.

## 7. Montage / MV (蒙太奇)

**Use for:** music video, fashion montage, travel memory, process montage, title sequence.

**Shape:** separate images share a look and a rhythm; no continuous geography is required. Cuts land on the music.

- 5 s: one image, one move.
- 10 s: two or three images with a shared motif.
- 15 s: four or five short images; each must read in under 2 s.

**Skeleton:**

```text
integrated_multimodal_description: [Shot 1] 16:9, 35 mm film look, warm tungsten and deep teal shadows. A woman in a red slip dress spins under a bare bulb in an empty ballroom; dust in the air. Static shot, slight handheld drift. [Shot 2] At 00:02.400, the camera cuts to a close-up of her heel leaving the floor. [Shot 3] At 00:04.100, the camera cuts to a wide shot of the same room, now empty, the bulb swinging.

overall_soundscape: Room reverb, fabric moving, a heel tapping, the bulb filament buzzing.

non_diegetic_music: A slow 6/8 waltz with tremolo strings and a single female hum, building in intensity.
```

**Sound:** if the final film will carry an external song, set `non_diegetic_music: N/A` and keep only diegetic sound; add the song in the edit.

**Pitfalls:** no shared motif; cutting faster than the model can render distinct images; expecting frame-accurate music sync (it is approximate).

## 8. Animation / stylized (动画型)

**Use for:** anime, 3D CG, stop-motion, painterly, comic, game cinematic.

**Shape:** commit to one visual grammar and keep it consistent; stylized motion can be broader than live action.

- 5 s: one stylized action.
- 10 s: action plus reaction.
- 15 s: a mini-sequence with one transformation.

**Skeleton:**

```text
integrated_multimodal_description: [Shot 1] Hand-drawn 2D anime, 16:9, cel-shaded, limited palette of indigo, bone white and vermilion. A young courier on a bicycle coasts down a steep shrine road at dusk; paper talismans flutter from the handlebars. The camera tracks alongside at slow speed, then tilts up to the torii gate. [Shot 2] At 00:06.000, the camera cuts to a low angle as the bicycle lifts off the last step, talismans bursting into red sparks.

overall_soundscape: Freewheel ticking, wind, paper fluttering, a wooden step cracking, sparks hissing.

non_diegetic_music: Taiko and shamisen, fast, with a breath before the jump.
```

**Sound:** stylized worlds still need physical sound logic; it sells the weight.

**Pitfalls:** mixing anime and photoreal language; "Studio Ghibli style" (use visual traits instead of a studio name); inconsistent character design across cuts.

## 9. UI / game demo (界面型)

**Use for:** app promo, UI motion, game HUD, feature reveal, interactive prototype.

**Shape:** the screen is the subject; motion must be readable and the interface must stay consistent. Keep text short.

- 5 s: one transition or one feature.
- 10 s: scroll + hover + result.
- 15 s: problem screen → interaction → result, three shots.

**Skeleton:**

```text
integrated_multimodal_description: [Shot 1] Clean product UI motion demo, 16:9, dark carbon background with a soft blue rim light. A smartphone floats centre frame, screen facing camera, showing a minimal fitness dashboard: one large ring, three stat tiles, a bottom tab bar. The camera pushes in with small amplitude at slow speed as the ring fills from 20% to 80%. [Shot 2] At 00:04.500, the camera cuts to a macro of the thumb tapping "Start", the button compressing, a subtle haptic ripple spreading across the glass.

overall_soundscape: A quiet studio, a soft UI tick, one low whoosh on the transition.

non_diegetic_music: Light electronic bed, 100 BPM, no melody.
```

**Sound:** UI sounds should be minimal and consistent; one tick per interaction, not a symphony.

**Pitfalls:** long paragraphs on screen; fake brand names that drift; unreadable small text; camera moves that make the UI unreadable.

## Mixing recipes

A 15 s brand film can contain a 5 s performance beat and a 3 s product insert. That is fine: choose the dominant recipe, then borrow one beat from another. Do not average the skeletons; write the dominant one and cut to the borrowed beat.
