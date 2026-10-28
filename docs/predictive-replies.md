# Reply suggestions

Live sessions prepare short reply openings from incoming partial speech, independently of recognition and tracking. Saved replay offers saved suggestions, predictive generation and a turn-end baseline. Saved mode makes no suggestion requests.

Set **My language** and **Conversation language** in Call brief. Openings and continuations use the conversation language, with translations into your reading language when they differ. The interface stays English.

The reply footer shows the recommendation and compact alternatives. **Pin this reply** retains wording while you speak; **Unpin reply** resumes automatic recommendations. **Generate another** explicitly requests a different move. Selecting or pinning never creates spoken evidence, agreement or objective completion.

New speech, corrections and brief or attribution edits can mark wording for reassessment. Pinned wording remains visible with a warning. Expression tracking requires actual later speech attributed to Me; silence and selection cannot establish expression. Without reliable attribution, expression remains uncertain.

One active generation request and one coalesced pending update bound concurrency. Complete validated records publish incrementally; incomplete JSON and commentary never enter the UI. Session, brief, transcript, observation and attribution versions guard publication. Seek and disposal cancel work; late results cannot apply.

Inputs include recent/relevant transcript segments, goal definitions, supported observations and selected intent. Unsupported fragments, discarded findings and stale evidence cannot support a new direction. Generation inputs and revisions persist in journals; in-memory history is bounded. Saved turn boundaries support baseline replay. Manual benchmarking and browser visibility receipts have been removed.

`SUGGEST_MODEL` defaults to `ANALYSIS_MODEL`, then `gpt-6-luna`. `SUGGEST_COALESCE_MS` defaults to 180 ms (20–2000); `SUGGEST_MIN_INTERVAL_MS` defaults to 4000 ms (0–30000). Explicit Another reply bypasses automatic pacing. Requests have a 20-second deadline and 2000-token output cap.

Regression coverage lives in the suggestion coordinator, model and replay tests. The optional paid conversation-goals smoke is documented in the [README](../README.md). Reply usefulness and response gaps require real-call evaluation.
