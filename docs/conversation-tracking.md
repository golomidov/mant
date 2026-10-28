# Briefing and conversation tracking

Run `bun install`, then `bun --no-env-file run dev` and open http://127.0.0.1:5173. Supply `OPENAI_API_KEY` in the server process environment. Recognition and interpretation use that server credential; it is never sent to the browser. The installed Pi packages are `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` 1.4.0, installed using `@latest`. Schemas and runtime validation use Pi's public exports; there is no direct TypeBox dependency.

`ANALYSIS_MODEL` defaults to `gpt-6-luna` and must be in Pi's OpenAI catalog. `ANALYSIS_COALESCE_MS` defaults to 350 ms (configurable between 20 and 5000 ms). This window coalesces incoming text; it is not a promised response time. Requests have a 45-second timeout, bounded output and no automatic provider retries. Missing credentials or failed analysis leave transcription running and expose a retry control.

Automatic TRACK requests start at least 6 seconds apart (`ANALYSIS_MIN_INTERVAL_MS`); translation requests start at least 2 seconds apart (`TRANSLATION_MIN_INTERVAL_MS`). Both settings accept 0–30000 ms. Manual retry bypasses automatic pacing. Transcript publication, revision invalidation and pending indicators remain immediate. Settings and goal definitions occupy stable structured messages before current speech and progress, with explicit cache boundaries on supported models. Translation uses a fixed strict schema across batch sizes and reuses translations across text-identical ASR finalization. Unrelated descriptive chatter produces no observations; direct questions, important conditions, commitments and risks remain eligible without a matching objective.

**Retry analysis** waits for a fresh attempt on unprocessed transcript revisions and reports the resulting success or failure. Stopping native capture pauses automatic tracking without disposing the pending analysis, so Retry still works after capture ends. Translation has its own retry action and does not restart analysis. Provider and SDK failures report a safe error category instead of hiding every cause behind a generic model failure.

## Use the brief and live tracking

Call brief remains editable before the connection is ready. A local copy restores it immediately on refresh, and edits made while disconnected are kept on the device until synchronization succeeds. Server snapshots update the authoritative base without dropping newer local changes. Building objectives still requires the server. Source discovery runs separately and never blocks briefing.

1. Enter the **Call goal** in **Call brief**, then choose **Build objectives**. Edits save automatically after a short pause or when leaving a field. Saving the goal or instructions preserves existing objectives, findings and replies; it does not restart analysis. Build objectives waits for any pending save and extracts targets from the newest draft. Existing objectives remain intact if building fails. Answer any essential clarification questions and build again, or continue with unknown details. Extraction uses one Pi agent turn and a local proposal tool; it cannot perform external actions.
2. Put context, requirements, preferences and boundaries in Call goal. The one Objectives editor contains questions and desired outcomes, each with a description and an observable completion condition. Objectives are assessed independently. Participants and languages share one group below the goal: Me always exists, with My name and My language; Other side sets the conversation side and Conversation language. There are no controls for adding sides or participants; extraction does not propose new people. Existing saved identities remain readable for historical attribution. Clarification answers refine extracted entries; manually edited objectives and language choices survive rebuilding. Call goal and Additional instructions retain the user's exact text: extracted or legacy context is never appended to them. Context is still extracted internally for interpretation; it does not duplicate objective definitions.
3. Wait for the brief to show Saved before starting. There is no Save edits button; a failed save retains the draft and offers Retry saving. For live tracking, use the existing **Live transcription** recording workflow and press **Start**. No second recognition request is made. The brief remains editable during playback. Under **Objectives**, expand a target and choose **Delete objective**, to remove it automatically. Observation links to deleted targets are cleared. Historical dropped targets remain readable in older logs; the active editor has one removal action.
4. Objectives appear on the left; recent observations appear on the right. Select either to inspect its explanation and evidence. The supporting transcript is highlighted without changing its order or keys. An evidence label warns when the displayed transcript has since been revised. Retractions and status history remain inspectable, and full versions are retained in the journal.
5. Expand an observation to correct its meaning/status or a specific segment's speaker/source. Corrections are protected from subsequent inference. Use the configured Me and conversation side, or retain an unidentified remote speaker. New participants and sides are not created by objective extraction. Attribution never assumes arbitrary stereo channels correspond to different people. Changing attribution updates existing observations, retaining their IDs.

An established observation is an adequately complete attributed statement, not an independently verified fact. Commitments and agreements are explicit observation types, rather than automatic interpretations of estimates. Unexpected risks can require attention without matching a goal. The observation filter can show active items, important items, or retracted history.

## Languages and translations

Under Call brief → Participants & languages, set **My language** (English by default) and **Conversation language**. Both support English, Italian, Spanish, French, German and Russian. Conversation language also offers **Auto**, which detects speech during tracking and displays the detected language in the selector. Choosing a language saves it automatically. Rebuilding objectives retains these choices; the language of the written brief does not silently replace Auto. The app interface stays English.

Objectives match speech by meaning across languages. English objectives can be advanced by Spanish speech, for example, while the observation explanation is written in My language. Original transcript words and revisions remain the evidence; translations never supply independent proof.

When the languages differ, transcript segments show their translation underneath, and suggested openings/continuations appear in the conversation language with a translation into My language below them. A separate translation queue processes every nonempty message, including short answers, in batches of up to eight. It checks revisions per message, so changing speech or a failed understanding request cannot discard translations for other messages. Equal-language settings omit translations. Auto also handles supported language switches. Transcript revisions immediately hide older translations. Saving new language settings clears incompatible translations, reprocesses available speech, and updates recognition language hints without reconnecting. Translation progress and errors are visible, with **Retry translation** to catch up after a failure. Opening or refreshing saved-session review displays persisted translations without requesting missing ones. Playback or an explicit language change can fill missing translations without recomputing understanding. Live translations and reply wording persist in saved journals.

Use **Confirmed** on an objective, or beside a related Next move confirmation/clarification, when you know the information is covered. This immediately marks the question answered or outcome achieved, records your confirmation in history, and removes related suggestions without another spoken question or model request. Later tracking preserves your decision; revised supporting speech or an explicit correction reopens it for review. Pinning a reply alone does not confirm an objective.

## Replay and recompute

Choose **Saved recording replay**, then a recording and an understanding mode:

Selecting a saved session immediately loads the entire transcript at its latest revisions and the final saved objectives, observations and suggestions. The source phase reads **Review**. This works even if the original audio is missing, starts no playback or model requests, and survives a browser refresh. **Start** or **Restart** begins a fresh progressive replay from zero using the selected Analysis and Replay suggestions modes in Audio source. Choose **Recompute (model)** before starting to run analysis again.

- **Replay saved analysis** releases persisted analysis at its recorded availability positions, without calling a model. Older transcript-only logs have no semantic results to display. Editing saved playback creates a separate journal; it does not overwrite the original.
- **Recompute progressively (model)** sends only transcript revisions released by the audio clock. It starts with the recorded initial brief (or the current preparation for a legacy transcript), then releases historical brief edits and explicit user corrections at their original positions. Saved model observations, summaries and objective conclusions are excluded. Recomputed results are saved in a new library run; The run remains available in the saved-session library.

Existing speed controls, Stop/Resume and Restart remain available. Change the understanding mode while stopped; choosing a different mode starts a fresh run. **Seek / restore state** creates a new session/run, clears incompatible inference, and restores only the transcript and brief information available at that position. In recompute mode, historical material up to the seek position is then interpreted afresh, so there can be visible analysis lag. Seeking to a later position releases the preceding material as a burst; normal uninterrupted recompute releases it progressively.

The original source recording and replay offsets are preserved. Transcript availability offsets are not spoken-word timestamps. Model completion has a separate processing clock and availability position, and each result retains its evidence-effective position. A late analysis result is never displayed earlier merely because its evidence occurred earlier. Analysis may continue after playback stops or ends; wait for pending material to drain before selecting the completed run from the library.

## State and persistence

`server/tracking.ts` owns stable IDs, state versions, transcript revision dependencies, status transitions and user corrections. `server/interpretation.ts` implements BRIEF and TRACK with common interpretation rules. TRACK uses one strict structured proposal with a stable wire schema; exact observation, objective and evidence IDs are checked locally rather than embedded as changing schema enums. Exact ID/revision pairs and objective kind/status combinations are checked by the coordinator; object unions are not sent to Pi's strict schema converter. Runtime validation and deterministic application still check all references and session/run/request identities.

There is one active TRACK request per session. A revision watermark over the authoritative transcript retains all unprocessed segments; requests take at most 16 pending segments, up to 32 additional relevant/recent segments and 40 observations. Context has a 100 KB hard limit and fails visibly rather than silently discarding pending text. Existing corrections and important observations receive priority. No growing full transcript or previous model conversation is resent. Brief changes invalidate the affected inference inputs; unrelated journal/UI fields do not. Append-only speech can yield provisional results while a continuation is pending; replacement text invalidates incompatible interpretations immediately.

Existing JSONL headers and transcript rows remain compatible. Additional `analysis` rows preserve brief versions, observation changes, objective histories, attribution corrections, request start/completion/application times and input provenance. Retired receipt rows and objective priority/dependency fields are not supported. Preparation edits are retained in `TRANSCRIPT_DIR/preparation.jsonl`, including before a recording starts. Imported logs validate evidence references against revisions already encountered, rejecting future or missing dependencies.

Future speaker workers can read the existing source audio independently and submit ordinary attribution events through `/api/assistant` once they can reliably align a segment. Current ASR does not supply reliable word intervals; there is no automatic diarization or interval import, and arrival times are never used to invent alignment. Mixed/uncertain speech stays unknown.

## Measure and validate

Technical status and pipeline panels have been removed. Analysis failures appear as an error with Retry. Internal request identity, scheduling, evidence revision checks and media clocks continue to protect playback and interpretation.

```sh
bun test
bun run typecheck
bun run lint
bun run build
```

Ordinary tests use mocked transports and make no paid calls. The optional live conversation-goals smoke is documented below.

## Remaining limits

Interpretation is fallible and needs review. This milestone prepares an understanding layer; it does not solve reply latency. The current interface presents the most recent 60 matching observations. State and append-only journals retain history and can grow during long calls; checkpoint/compaction and cross-session retrieval are not implemented. Existing JSONL row/import limits (1 MB per row, 64 MiB per import) and the single local playback controller still apply. Oversized context fails visibly and retains pending material for a retry. Speaker interval alignment and automatic diarization are future work.

### Communication goals and preparation

Objectives can be questions to resolve, things to say, or desired outcomes. A “Thing to say” becomes “Said” when complete, established speech attributed to Me conveys its meaning, including a paraphrase in another language. Pinning is optional and does not complete anything. “Said” records local speech, without claiming that another participant heard it. Partial, hypothetical, quoted, or unidentified speech cannot complete a communication goal. Transcript and attribution corrections reopen unsupported completion; manual completion remains available.

Set timing to Opening for points to introduce before the conversation starts. Missing timing means Anytime. A missed opening remains pending. Build objectives separates independent disclosures, so one opening can cover several goals while each completes independently. Facts included only as background do not create a disclosure goal.

“What you can say” shows up to three useful moves, one recommended. Each includes speech in the conversation language and a translation into My language when needed. Explicit brief facts and objectives can support preparation before any transcript exists; their references are stored separately from speech evidence. With an unknown conversation language, preparation uses My language and is labeled accordingly. Changing the brief or language invalidates stale preparation.

Simpler, Shorter, and Alternative wording replace one move's phrasing while retaining its intent, objective links, references, and constraints. Sibling moves remain available. Generate another requests a different useful move. Quick phrases is a separate expandable set for thinking time, repetition, slower speech, clarification, and transitions; it never changes objective progress.

Older archives retain their original objective kinds. Missing direction basis retains the legacy transcript interpretation. Saved replay does not generate new suggestions. Run `bun --no-env-file scripts/conversation-goals-smoke.ts --live` with configured model credentials for the semantic regression covering the English interview brief, an Italian opening, rephrasing, and independent spoken completion.
