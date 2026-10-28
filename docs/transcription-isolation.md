# Live transcription isolation and diagnostics

Audio delivery and transcript events take priority over translation, tracking, objective building and suggestions. Each model work type has one logical active request, independent cancellation and a deadline: translation 30 seconds, tracking and brief extraction 45 seconds, suggestions 20 seconds. Brief extraction no longer waits for tracking. Each keeps its own request state; brief results use `briefRequest`, `briefStatus` and `briefMessage`.

Pending transcript revisions are coalesced by segment ID. Translation uses batches of eight and tracking batches of sixteen pending segments. Results retain revision, language, session and version guards. Failed and timed-out model work remains pending for manual retry; new incoming speech does not automatically retry a failed flow. Disposed sessions and cancelled requests cannot apply late results.

Live archive rows and captured WAV packets are submitted to an ordered Bun persistence worker. Packet positions retain the original capture timestamps, including gaps. Archive APIs flush before reads; raw callers of `archives.path()` must explicitly await `archives.flush(id)` before reading or exporting. Recording finalization waits for the track files, and server shutdown drains pending writes. Persistence errors appear separately from transcription errors.

`/ws` carries transcript, session status and playback controls. `/ws/background` carries analysis and suggestions. Background delivery retains only the latest replaceable update per type and sends a current snapshot on reconnect. Background sequence numbers never advance the transcript cursor. React applies background updates in a transition. A failed background connection does not pause file playback.

Diagnostics start automatically. Startup prints the absolute path to `TRANSCRIPT_DIR/diagnostics/events.jsonl`. The worker rotates that file plus four older files at 10 MB each. Records contain run/session/source/work/request identifiers, queue and timing metadata, safe provider codes/status/request IDs when supplied, and five-second live health samples. Browser reconnect and playback-pause reasons are included. Speech, audio, prompts, model output, credentials and arbitrary error messages are excluded. Queues are bounded and dropped diagnostic records are counted.

Summarize one session (use the active session ID, which can differ from the source archive ID):

```sh
bun run diagnostics SESSION_ID
bun run diagnostics SESSION_ID /absolute/path/to/transcripts/diagnostics
```

Omit the session ID to summarize all retained records. Output includes event counts and the latest 200 errors, cancellations, disconnects, pauses or potential stall samples. Long silence can produce a potential-stall sample; it is evidence for investigation, not proof of a provider fault.

Validation includes unresolved model requests during synthetic audio and transcript revisions; deadline cancellation and late-result rejection; manual retry; throwing callbacks; bounded background queues and reconnect state; delayed disk writes, WAV offsets and flush ordering; diagnostic rotation, metadata redaction, overload and disk failures. Existing revision, language, archive and session-replacement tests remain in the full suite.

A production-browser fault run used an eight-second synthetic saved recording. While background sockets repeatedly disconnected, playback advanced from 0.391 to 3.703 seconds, three transcript updates arrived, the control socket count stayed at one, and there were zero pause calls. The background connection recovered after 15 connection attempts. The test used synthetic data and no model credentials.
