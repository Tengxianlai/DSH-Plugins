# MiniMax H3 video

MiniMax H3 / Hailuo 3 produces one 4–15 second clip with native sound (Max: 5–15). Use this skill for H3 planning, reference selection, generation, recovery or 768P→2K regeneration. For a new AI film, first read `production-workflow.md`: project registry, local QA, evidence boundaries and handoff apply across projects and models.

## Division of work

- **Gemini 4 Argon:** screenplay, dialogue, narration and creative prompt writing under the user's approval rules. A necessary editorial judgment may use selected images/short clips with a stated purpose and local evidence.
- **Local tools + DeepSeek subagents:** inspect actual inputs, source hashes, ffprobe, decoding, ASR, waveform/silence boundaries, full-frame metrics, contact sheets, parameter checks and evidence reconciliation. Do not send routine technical checks to a paid multimodal API.
- **Lead:** resolve conflicts, review evidence and limits, integrate versions. Model PASS is not user approval. A model change or compressed summary does not reset project constraints.

## Tools and spending

| Need | Tool / local entry |
|---|---|
| Model matrix, regional price snapshot | `video_models` (offline) |
| Validate sources/contract/cost without generating | `video_prepare`, or `dry_run:true` |
| Declare/check cumulative batch budget | `video_budget` |
| Generate after valid preparation | `video_generate` |
| Recover/query/wait/download the same task | `video_task` |
| Official accepted 768P source → 2K | `video_regenerate` |
| Optional paid Context-IR prompt expansion | `video_prompt_enhance` |
| Register approved assets/build request/local QA | `../production/cli.mjs` (local only; see `production-workflow.md`) |

Read `video_models` before model/price decisions. List-price estimates are not account charges. Set the approved batch budget before spending; a per-call cap does not replace a cumulative budget. Unknown submitted orders keep their reservation until reconciled. The `video_budget` ledger covers **H3 generation and regeneration calls only**; Context-IR is token-priced, cannot carry a budget or max_cost, requires explicit `allow_unbounded_cost:true` plus `override_reason`, and is not part of the reservation ledger. It also excludes `image_generate` and Gemini/Claude token spend. A user-given cross-tool total budget must be allocated by stage and merged with those other receipts/usage by the lead, not entered wholesale into `video_budget`. List prices, conservative upper bounds and raw usage are not the actual account bill. Never treat a client timeout as a free failed generation or submit again just to get a response. Query the recorded task.

Use the prepared plan and inspect its actual sources, reference roles, exact dialogue and cost. If blocked, repair the cause; do not set override flags just to finish. Two repetitions of the same failure trigger diagnosis, not another paid draw. Optional unused media fields should be omitted; empty placeholders are not source files.

## Reference selection comes before prompt writing

1. Find the registered same-shot approved keyframe matching the intended starting state. Prefer its original high-quality bytes.
2. Verify its character/scene lineage and current hash. An approved keyframe may already carry the identity and spatial roots; do not blindly attach every card again and mix views.
3. Use a video screenshot only for a necessary exact continuation/action state and record why the approved keyframe is unsuitable. Open the actual screenshot: check people, hands, props and space before paying.
4. A reused keyframe must fit this shot's speaker/action/time. Similar filenames or convenient duration do not establish compatibility.
5. Preserve latest explicit adoption decisions alongside older review history. A filename containing REJECTED is not the final adoption state. File recency, model score, or collection inclusion is not approval.

Registered production is validated by `.ai-video/project.json`: sources are matched by content hash, roots inherited through `root_ids`, shot dependencies checked, and screenshot substitution requires a reason. Registration requires an explicit `--origin` (`generated_original`, `video_frame`, `external_capture`, `user_supplied`, `derived_render`). For deriving a new keyframe/image before any same-shot keyframe is approved, bootstrap references with explicit `--ids HERO_ROOT_v1,SITE_MASTER_v1` (must cover the shot's required roots); do not default-send an old keyframe. Once a keyframe is approved, the video `request` uses it (or `--keyframe-id`) and inherits its roots. `asset_ids` binds media slots to registered asset ids; `source_asset_id` binds a byTask regeneration source; both are accepted in the H3 schema and plan fingerprint. Missing approval, drift or scope conflicts must be resolved before generation.

## Modes and hard API constraints

- One call is one clip: H3/Highspeed/Lite 4–15 integer seconds; Max 5–15. There is no extension endpoint. For a long film, plan separate shots. A tail-frame chain is an option when exact continuation is needed, not the default replacement for approved keyframes.
- Requested duration is nominal. Source duration, frame count, spoken interval, handles and used interval are different measurements. A 4-second request may return 107 frames / about 4.46 seconds at 24fps.
- **Direct generation of 2K** is available on `MiniMax-H3` only. Lite/Highspeed/Max direct generation stops at 768P. This is distinct from the regeneration source rule below.
- `first_frame` pins the opening image and determines the frame shape; `last_frame` requires `first_frame`. Frames cannot be mixed with any `reference_*` inputs.
- `reference_images` supplies identity, costume, scene, composition or style; it does not pin the exact first frame. Name `<Picture 1>`… and assign each a specific job.
- `reference_audio` supplies timbre/music/rhythm/effect texture, **not the words to speak**. Name `<Audio 1>`… and write the exact approved dialogue in the prompt.
- `reference_videos` supplies motion/camera/editing rhythm or sound. Name `<Video 1>`… and assign its role.
- Text-to-video needs a concrete ratio; image-to-video follows the image. Reference mode defaults adaptive except Lite requires a concrete ratio.
- Prompt ≤7000 characters. Describe the target positively; do not expect a negative phrase to remove a worker already visible in the source image.
- H3 produces sound. Specify appropriate scene sound and score separately. Check the actual result even when requesting quiet or no score.

For recurring voice + approved visual, use reference mode with a suitable approved image and native voice sample; accept that the opening frame is not pinned. For exact frame continuation, use frame mode and explicitly plan how voice consistency will be handled. Do not silently mix mutually exclusive inputs. Full choices: `references/continuity-and-voice.md`.

## Tier choice without a mandatory ladder

| Tier | Direct resolution | Typical use |
|---|---|---|
| MiniMax-H3 | 768P, 2K | final/direct 2K or quality-critical work |
| MiniMax-H3-Highspeed | 480P, 768P | selected fast iteration |
| MiniMax-H3-Lite | 480P, 768P | economical iteration; accepted 768P can be regenerated to 2K |
| MiniMax-H3-Max | 480P, 768P | multi-asset reference and controlled expansion |

Do not require Lite480→Highspeed768→H3 as a fixed paid sequence. Choose the smallest useful experiment, review it, and retain adopted sources. If an accepted 768P source already exists, assess official regeneration. Direct 2K may be cheaper for a known final request; check the current regional catalog. Do not regenerate an unreviewed draft just because quota remains.

## Prompt and exact speech

Creative text follows the user's designated writer. The API accepts prose; the usual three fields are:

```text
integrated_multimodal_description: [Shot 1] subject, place, state, one motivated camera move, observable action and exact synchronized speech.

overall_soundscape: specific scene ambience, physical sounds and non-verbal voice.

non_diegetic_music: the intended score, or N/A.
```

Dialogue must appear as literal approved text, for example `<d>[Chinese]批准的原句</d>`; the language label and actual words both belong in the prompt. “Speaking the line of Audio 1” is incomplete. A voice sample may speak a different sentence. `dialogue` in preparation binds the expected words; it does not replace the prompt text.

Separate a voice sample's timbre from acting direction, pace and pauses. The first character seed can be a single-speaker native H3 scene without TTS reference; extract an accepted native sample for later shots. Do not substitute historical animatic TTS for an adopted character voice.

English words/second are only a planning heuristic and cannot be applied to a Chinese sentence by treating it as one space-delimited word. Check actual speech after generation. Plan breathing and tail time, normally about one second at each end for new sources, but do not mechanically trim an already accepted short source or cut its last syllable. Record exceptions.

One primary camera move per shot; a cut must add information. Keep style stable across related shots. Detailed recipes: `references/prompt-guide.md`, `references/camera.md`, `references/video-types.md`, `references/examples.md`.

## Local review before adoption or 2K

1. ffprobe actual dimensions/fps/frames/audio/duration; decode locally.
2. Run cached local ASR for specified dialogue; compare with approved text. Resolve homophones/omissions rather than rewriting the script to match ASR.
3. Check speech boundaries with waveform/silence evidence; ASR token timestamps are not exact cut points.
4. Scan every decoded frame for measurable signals where relevant; inspect suitable frame sequences/contact sheets for action and identity. A signal scan does not understand hands or prove natural acting.
5. Review action motivation/recovery, speaker identity, unwanted sounds and actual opening/tail. Retain original 768P + native audio + final prompt + all original input bytes/task receipts.

Record source QC through the local CLI; evidence is hash-bound to the source. `frame_scan` `pass` means `machine_pass_scope: decode_and_coverage` (decode + verified coverage + valid metric structure), not content acceptance; dark/static shots stay suspicion for motion/agent review rather than forcing a regeneration. An ASR mismatch can only be recorded `review_required`; `--review-decision` defaults to `pending` and blocks 2K. Use `--review-decision accepted` only after an actual listen with a stated scope; `motion_review`/identity/voice reviews need a declared accepted reviewer decision (`dsh.ai-video-review/1`). A plain metadata scan never triggers ASR implicitly; use `--asr`/`--expected` with the configured local toolchain.

Technical evidence, agent review, user acceptance and school/client acceptance are separate. Never label a subset scan, midpoint contact sheet, successful ASR, or model PASS as full-film human listening or phoneme-level lip-sync verification.

## Official 768P → 2K regeneration

`video_regenerate` is a regeneration pass, not an arbitrary upscaler.

- **Lite 768P sources can use the official 2K regeneration channel.** This was verified in production. `MiniMax-H3` in the regeneration request names the output model; it does not prohibit a Lite source. Direct-generation model restrictions above still apply.
- Validate physical source requirements: 24fps, audio present, width/height divisible by32, area 768×768–768×1344, 107–362 frames in steps of17. The local preflight reads these fields from the retained local-qa evidence and blocks a non-conforming base source before payment. Preserve the untrimmed source.
- Base-video mode resubmits the **exact final prompt actually used** and **all original reference inputs**. Use the stored request/bytes and check hashes; a renamed or later “similar” image is not the same input.
- `source_task_id` mode additionally requires account whitelist access and a succeeded task within7days. In a registered project it also needs `source_asset_id` whose `task_id`/`provenance.task_id` equals `source_task_id`, plus that source's retained QC; H3 additionally checks the local journal's `download.sha256` against it. Without that traceable local source, use the video mode that resubmits the local file and original inputs instead of improvising another remote source at QC time.
- Bind local QC evidence to this source hash. A transcript/scan from an earlier candidate does not validate the final take. Registered production requires retained source QC before regeneration.
- Compare clock/frame geometry and retain the accepted native audio if appropriate. Regeneration may redraw details; do not promise pixel identity or automatically replace accepted original sound.
- Regeneration re-bills relevant inputs and output seconds. Its estimate is not the account bill.

## Handoff invariants

After a model switch or compaction, re-read the project's short production contract and current adoption ledger. Preserve: actual baseline, exact speech, role of each reference, approved asset IDs/hashes, native voice choice, budget/held orders, pending task IDs, source review status and next minimal action. Do not compress these into “continue producing the film.”

Load `production-workflow.md` for the reusable contract, local CLI and startup/handoff template. Official references remain in `references/api-notes.md`; actual tool validation and verified production corrections take precedence over a stale generic recipe.
