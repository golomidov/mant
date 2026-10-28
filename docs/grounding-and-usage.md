# Grounding and usage

Tracking requires transcript quotations, revision-linked evidence, a direct/contextual/uncertain grounding description and an explanation of subject links. Prior model interpretations and objective reasons are not corroborating evidence. Missing completion facts prevent answered/achieved status.

Guards retract findings supported only by orphan one-word fragments and prevent dependent progress or suggestions. A short answer remains usable when evidence includes the actual nearby spoken question. Quotation validation rejects changed words, negation, numerical signs, missing references and future revisions; punctuation differences are tolerated. Interpretation remains fallible.

**Mark wrong · discard finding** records an explicit rejection, retracts findings sharing its evidence, clears dependent progress and flags stale replies. A supported different reading remains possible, but the rejected meaning cannot simply return under a new ID. On saved replay, discarding forks the journal into progressive recomputation; the original journal and audio remain intact.

The server checks usage every five seconds and at shutdown, printing `[usage totals]` only when totals change. Totals include request attempts by BRIEF, TRACK, TRANSLATE and SUGGEST, committed ASR chunks, provider token counts, estimated USD, submitted ASR duration, pending requests and missing usage. PCM packets are not separate inference requests. Canceled and failed calls count; missing usage is not assumed free. Estimates are not account invoices.

Counters begin at server startup. Preparation contributes to server totals; conversation totals include that conversation only. Usage logs exclude transcript contents, prompts and credentials.

Opening or refreshing Call brief makes no model request. **Build objectives** starts extraction. Saved review displays persisted translations; playback, language changes or Retry translation can request missing translations. Equal-language text requires no translation request.

Run `bun test` for grounding, rejection, translation and usage regressions.
