# AI video production: reusable local-first workflow

Use this at the start of a new AI-video project and after a model switch or compaction. It is the project-level companion to the H3 tool/API skill. Existing user instructions and explicit approvals remain authoritative.

## 1. Division of work

| Work | Default owner and evidence |
|---|---|
| Story, dialogue, narration, creative prompt text | Gemini 4 Argon under the user's writer/approval rules |
| Inventory, parameter checks, ASR, ffprobe, decode, frame metrics, hashes, request/source reconciliation | Local tools; DeepSeek subagents investigate and reconcile bounded evidence |
| Identity/action/space comparison | Actual selected images or frame sequences inspected by an agent with suitable vision support; source/approval/lineage checked locally |
| A remaining editorial question needing multimodal synthesis | A bounded Gemini image/short-clip request with media_purpose and local_evidence; state what local checks cannot answer |
| Adoption, conflicts, integration, final limits | Lead; separate agent review, user acceptance and client/school acceptance |

A filename, high model score, new mtime, ASR result or inclusion in a collection is not approval. A scan of every frame measures its configured signals; it does not understand every action. No unrequested paid quality experiment is needed to test this workflow.

## 2. Start with a persistent contract

The plugin's local entry is `../production/cli.mjs`, relative to this skill's Base directory. Derive the installed plugin directory from the loaded skill location; do not hardcode another project's machine path.

```sh
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" init --root "$PWD" --id project-name
```

This creates `.ai-video/project.json` with no budget and no approved assets. It never overwrites an existing manifest. Register actual approved bytes and their decision evidence, not a list inferred from filenames:

```sh
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" register --id HERO_ROOT_v1 --kind character --file assets/hero.png --origin user_supplied
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" approve --id HERO_ROOT_v1 --by user --evidence 'session/message or retained approval record'
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" register --id SITE_MASTER_v1 --kind scene --file assets/site.png --origin user_supplied
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" approve --id SITE_MASTER_v1 --by director --evidence 'authorized director adoption record'
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" register --id S01_START_v1 --kind keyframe --file assets/S01_start.png --origin generated_original --roots HERO_ROOT_v1,SITE_MASTER_v1
```

Registering defaults to candidate. `--origin` is required and must be one of `generated_original`, `video_frame`, `external_capture`, `user_supplied`, `derived_render`; a filename or extension is not an origin classification. Approve a keyframe only after its real identity, spatial state and use have been reviewed. If source bytes change, register a new version; do not update an old hash to hide drift. Preserve older review/adoption history. A later explicit user selection may supersede an old rejection; record the actual decision and scope.

The minimal shot record uses asset IDs:

```json
{
  "id": "S01",
  "characters": ["HERO_ROOT_v1"],
  "scenes": ["SITE_MASTER_v1"],
  "keyframes": ["S01_START_v1"],
  "voice_refs": [],
  "dialogue": []
}
```

Load it with `shot --spec path/to/shot.json`. Dialogue entries are `{speaker,line}` with exact approved words; voice_refs are accepted native audio asset IDs. A keyframe's root_ids carry identity/space without blindly resending every card. Multiple start/end/action states need explicit selection; do not pick the latest or longest file.

## 3. Budget is a batch limit, not a repeated per-call limit

```sh
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" budget --id approved-batch-1 --limit 10 --currency CNY --evidence 'actual user authorization for this scope'
```

The example amount is illustrative, not authorization. Use only the user's actual approved scope/cap. The tool-level video_budget ledger tracks reservations across calls; the project declaration supplies its budget id/limit/currency. Changing an existing declared budget requires an explicit amendment reason and corresponding ledger reconciliation. Unknown submitted orders keep their reservation until reconciled. A timeout does not mean no charge; list price is not an account bill. Do not sum old caps into a new balance.

`video_budget`'s atomic cumulative reservations cover **H3 generation and regeneration calls only**. Context-IR is token-priced, cannot carry a budget or a per-call max_cost, and needs an explicit `allow_unbounded_cost:true` plus `override_reason`; it is not part of the reservation ledger. The reservations also do not include `image_generate` spend or Gemini/Claude token usage. If the user gives one cross-tool total budget, the lead must allocate it by stage and merge the other tools' receipts/usage separately; do not assign the whole total to `video_budget`. List prices, conservative upper bounds and raw usage are not an actual bill.

## 4. Generate requests from approved sources

After Gemini supplies the approved prompt text, construct a request using the shot's declared keyframe:

```sh
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" request --shot S01 --model MiniMax-H3-Lite --resolution 768P --duration 7 --prompt-file prompts/S01.txt --out requests/S01_v1.json
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" check --request requests/S01_v1.json
```

For several keyframes choose `--keyframe-id` explicitly or record primary_keyframe. With voice_refs the builder uses reference_images + reference_audio; without them it uses first_frame. The two modes have different opening-frame behavior. Review the generated file's args and actual images before video_prepare. The command does not call a model or authorize payment.

For a new keyframe/image derivation, export the actual required roots explicitly while there is no approved same-shot keyframe yet:

```sh
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" references --shot S01 --ids HERO_ROOT_v1,SITE_MASTER_v1 --out refs/S01_refs.json
```

The explicit `--ids` list must cover this shot's required character/scene roots; the exporter recomputes each file's hash and fails on drift. This is the bootstrap path, not a default re-send of an old keyframe. Once a same-shot keyframe is approved, video `request` takes that keyframe (`--keyframe-id` when several) and inherits its `root_ids`; the exporter's default `references --shot S01` path is for that approved-keyframe case. The image tool's references_file supports source ids/hashes/roles, and explicit required references must be included. Do not pass the full character library or all scene cards by habit. Reuse means carrying correct identity and space, not maximizing reference count.

`asset_ids` binds each media slot to a registered asset id (needed for hash collisions and role clarity); `source_asset_id` binds the local source of a `source_task_id` regeneration. Both are accepted in the H3 tool schema and included in the plan fingerprint.

Before a paid call, inspect prepared diagnostics: actual sources and hashes, roles, expected words, requested/estimated duration, nominal versus actual source duration, regional estimate and cumulative reservation. If a required asset/line/root is missing, fix it. Do not make an override true simply to clear the error.

## 5. Review locally; register only supported conclusions

Local metadata and full-frame metrics:

```sh
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" inspect --file takes/S01_768.mp4 --out qa/S01_local.json --scan-all
```

This decodes every frame and measures luma after scaling to 320 px. It records decoded versus declared counts and strict decoder status. It does not prove hands, identity, physical causality, lip sync, acting or subjective sound quality. Open appropriate actual frame sequences/contact sheets for the question; midpoint-only thumbnails cannot show a whole action.

Cached local ASR:

```sh
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" inspect --file takes/S01_768.mp4 --out qa/S01_asr.json --asr --expected 'approved line'
```

`--asr` uses the configured local toolchain (shared `$DSH_HOME/state/dsh-minimax-video/toolchain.json`, `DSH_ASR_PYTHON`/`DSH_ASR_MODEL`, or an existing project runtime). Only when none exists, pass `--asr-python` and `--asr-model` explicitly; missing local dependencies are a clear error, never a download. ASR is not implicit: a plain metadata/`--scan-all` inspection never transcribes the whole clip just because a toolchain is configured. The helper refuses automatic model downloads and cloud fallback. Local ASR reports `review_required` (mismatch/homophone) rather than rewriting the approved text; homophones, omissions, boundary estimates and timbre still need separate interpretation. Waveform/silence evidence refines timing; token timestamps are not exact phoneme boundaries.

Register the accepted source video with its raw untrimmed bytes and root_ids linking the selected keyframe. For a `source_task_id` regeneration also register the downloaded local source with `--task-id <same remote task id>`; the request must carry `source_asset_id`, and the asset's `task_id`/`provenance.task_id` must equal `source_task_id`. H3 additionally requires the local journal's `download.sha256` to match the source. Without that traceable local source/QC evidence, use the video mode that submits the local file and original inputs instead.

Record source-bound QC with `qc --id SOURCE --kind frame_scan|asr|motion_review|voice_review|identity_review --status pass|fail|review_required --evidence REPORT.json --by REVIEWER --note SCOPE`. Evidence JSON must identify source_sha256; its own hash is retained.

- `frame_scan` machine pass means `machine_pass_scope: decode_and_coverage`: decode succeeded, coverage is verified and the metric structure is valid. It does not approve content. Black/static frames remain `review_required`/suspicion; do not force a regeneration merely because a legitimate shot is dark or static.
- `asr` mismatch cannot be a machine pass. Record `--status review_required`; `--review-decision` defaults to `pending`, and pending/rejected block 2K. Only after an actual review listen, with a stated scope, use `--review-decision accepted` (the original raw ASR mismatch stays attached).
- `motion_review` (and `voice_review`/`identity_review`) needs a declared review record and an accepted reviewer decision; a machine signal scan does not become an action pass.

The review file is a `dsh.ai-video-review/1` record and the QC record keeps the same acceptance status; do not invent extra fields:

```json
{
  "schema": "dsh.ai-video-review/1",
  "kind": "motion_review",
  "source_sha256": "<same source hash>",
  "decision": "accepted",
  "scope": "what was actually watched and accepted",
  "reviewer": "agent/director name",
  "authority": "declared",
  "content_approval": "not_asserted"
}
```

```sh
node "$VIDEO_PLUGIN_DIR/production/cli.mjs" qc --id SOURCE --kind motion_review --status pass --evidence qa/S01_motion.json --by agent --note 'watched the full clip action' --review-decision accepted
```

Only accepted768 candidates proceed to2K. Preserve raw768 + native audio + final prompt + all input bytes/hashes + task id/receipt. Lite768 can use official2K regeneration if the physical source requirements hold: 24 fps, native audio, width/height divisible by 32, area 768×768–768×1344, and 107–362 frames on the 17-frame grid. The local preflight reads those fields from the retained local-qa evidence and blocks a wrong source before payment. Direct2K tier restrictions are separate. Regeneration must use the original final request. An earlier candidate's transcript does not approve the final candidate.

## 6. Minimal changes and honest delivery

Freeze adopted manifest/spec/mix, master audio, subtitle typography and actual media hashes. Text-only or one-line audio feedback should reuse clean picture and rebuild only affected layers. Patch accepted PCM within the needed window and verify outside-window retention; do not normalize/remix an accepted whole film merely because the delivery platform changes.

**Time and converted derivatives.** Tool-generated filenames often use UTC while approval messages and editing notes use local time; normalize to one zone before claiming which take was approved, and never treat file mtime as the approval time. Keep the downloaded original PNG and its transcoded JPEG as separate artifacts with separate hashes; a changed or re-encoded derivative does not prove the original was damaged.

For upload caps, compute bitrate budget and check actual decimal bytes, decoded duration/frames and audio. A CRF setting alone does not promise a size. Avoid changing an accepted AAC track when scaling only video. Native editing project capability and external burned text layers must be described accurately.

Archive only confirmed unused/duplicate inputs after checking current/historical projects, regeneration inputs, native voice/identity anchors and explicit adoption. A directory named cache may be a real dependency. Keep checksums, old/new mappings and recovery instructions. Physical archive paths and old rejection names cannot replace the adoption ledger.

## 7. The contract survives summaries and model changes

Keep a short project handoff outside the conversational summary, for example `.ai-video/HANDOFF.md`, with:

1. Frozen baseline/version and current actual adoption tables.
2. Exact pending dialogue/narration and designated writer.
3. Shot asset ids/hashes: approved keyframe, character/scene roots, native voice reference roles.
4. Planned request mode, nominal duration and measured source intervals; local evidence still missing.
5. Budget id/cap/reserved unknown orders; task ids and request/receipt paths.
6. What passed at technical/agent/user/client levels and what did not.
7. The next smallest authorized action; protected outputs and other sessions' changes.

After compaction or switching models, read the handoff, registry, current adoption and actual inputs again. A summary saying “continue the movie” is insufficient. Before submission run the executable preflight rather than relying on remembered prose.

Common production mistakes include contradictory reference inputs, literal dialogue omitted, premature2K, lost task ids, repeated empty optional fields, stale ability guidance and identity roots not propagated. This workflow turns their checkable parts into data/tool validation; remaining visual and editorial judgments stay explicit.
