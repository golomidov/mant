# Live Mac calls

Mant can capture a selected physical microphone and application playback independently. The React SPA remains the interface; a small Swift helper captures audio while Bun owns transcription, recording, reasoning and persistence. Starting/stopping Mant never answers, hangs up, mutes or controls a call.

**Implementation is available; real cellular relay and conference capture are not yet hardware-verified.** Successful build, arriving buffers, synthetic audio and music playback do not establish that a particular call is capturable. Audio sources, live meters and independent gain controls are available; the audio-test workflow has been removed. Use the explicit routed-input fallback if application capture is silent or leaks sources.

## Build and run

Requirements: macOS **13.0 or newer**, Xcode Command Line Tools with a compatible macOS SDK, Bun and FFmpeg. This development host reports macOS **27.0.1 (26A434), arm64**, Xcode **27.1 (27A9275)**. The native helper has been compiled and its non-recording API/OS probe run on that host. macOS 13 and Intel deployment are supported by the API/deployment target but have not been hardware-tested.

```sh
bun install
bun run capture:build
"native/build/Mant Capture.app/Contents/MacOS/MantCapture" --probe
# Set OPENAI_API_KEY in the server process environment, as for existing sessions.
bun --no-env-file run dev
# Open http://127.0.0.1:5173
```

For the built SPA: `bun run build`, then `bun --no-env-file run start` and open http://127.0.0.1:3001. Last selections and per-source gains survive browser and server restarts in capture-setup.sqlite beside the transcript library. No API keys are supplied to the capture executable: Bun gives it an explicit environment containing only PATH, HOME, TMPDIR and LANG. Live analysis uses the existing server model settings and two independent recognition sessions.

`capture:build` compiles `native/MantCapture/main.swift` with deployment target 13.0, copies the usage descriptions into `native/build/Mant Capture.app`, and signs the bundle with identifier `local.mant.capture`. Default signing is local ad-hoc signing. Keep the bundle at this path. For an enduring developer identity across rebuilds, set `MANT_CAPTURE_SIGN_IDENTITY` to your existing codesigning identity before building. No certificate installation or TCC modifications are performed. A changed signature/path can require re-granting access. This bundle is a local build, not a notarized distribution.

Apple documents [ScreenCaptureKit audio capture](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio) as introduced on macOS 13.0; [application content filtering](<https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(display:including:exceptingwindows:)>) selects current running applications. The helper uses one primary playback backend: ScreenCaptureKit, with independent AVFoundation capture sessions for selected audio inputs. It uses [AVCaptureSession.synchronizationClock](https://developer.apple.com/documentation/avfoundation/avcapturesession/synchronizationclock) (macOS 12.3+) to convert microphone timing to the host clock. Core Audio process metadata is additional target discovery on macOS 14.2+, not another capture backend.

## iPhone cellular calls answered on the Mac

Follow [Apple's current cellular relay instructions](https://support.apple.com/en-us/102405). For the initial supported workflow:

1. Use the same Apple Account on the iPhone, Mac and FaceTime. Enable FaceTime and select the iPhone number as a reachable/caller number in FaceTime on both devices. The iPhone needs an activated cellular plan.
2. Keep the iPhone turned on and nearby. Enable Wi-Fi on both devices and use the same local network; the Mac can connect through Wi-Fi or Ethernet. Check that local-network restrictions or isolation do not prevent the devices communicating. Apple's separately configured carrier Wi-Fi Calling can extend the nearby-iPhone requirement; use the nearby/same-network configuration for initial testing.
3. On iPhone: Settings → Apps → Phone → Calls on Other Devices → Allow Calls on Other Devices. Enable this Mac in the list.
4. On Mac: FaceTime → Settings → sign in with the matching account, select the phone number, and enable **Calls from iPhone**.
5. Arrange an incoming cellular test call yourself. **Answer its incoming notification directly on the Mac.** Newer macOS versions also have Apple's Phone app. Mant does not place or answer any calls.
6. In the call interface/audio settings, explicitly choose the physical microphone and headphones you intend to use. Verify that you hear the other end and that they can hear you before starting Mant. Keep headphones connected throughout the call.
7. In Mant choose the same physical microphone and the application rendering the call playback under Audio sources. The app list updates automatically after opening the call app; Refresh sources checks immediately. If the application is absent or its audio is silent, choose Routed audio input and use the BlackHole fallback below.

This is **cellular-call relay**, not FaceTime Handoff. We do not promise that an arbitrary already-active iPhone cellular call can transfer onto the Mac. Apple's documented direction of continuing a Mac call on the iPhone does not establish the reverse workflow. Answering on the Mac is the supported starting point. USB and iPhone Mirroring are not used as call-audio interfaces.

## Audio sources and live use

1. Choose **Source → Live Mac call**. Devices are checked immediately after reload or reconnection, even with Source collapsed. While the page is visible, each completed check schedules another after five seconds. Returning to the page or opening Source also checks immediately. Saved names show checking until discovery completes; only a successful check that cannot find the selected source marks it unavailable. Failed discovery shows unable to check and retries automatically. Open **Audio sources** to select the microphone, incoming application or routed audio input. Your microphone uses the persistent Me participant from Call brief. **Refresh sources** checks available devices and applications immediately, including during recording. Concurrent checks are combined. Background checks preserve selections, gains, and the current recording. An unavailable saved source stays selected; Mant does not silently replace it. Brief editing remains available during discovery or reconnection.
2. Brief edits save automatically. Once the brief shows Saved, press **Start**. Capture uses two independent recognition connections. No audio test, sample, track-preview or separation-confirmation step is required or available.
3. Use the microphone and incoming-audio meters and independent gain controls while recording. Each gain ranges from −12 to +24 dB in 1 dB steps; Reset returns it to 0 dB. Gain affects Mant’s recording and recognition only. Clipping is measured before PCM clamping. There is no automatic gain control.
4. Permission failures and capture errors appear as actionable messages. Silence waits for incoming audio. Actual stream errors trigger bounded reconnection to the same sources.
5. Press **Stop** to finish and save the separate tracks and listening mix. The actual call stays running. Choose its saved session to replay it, or return to live setup for another call.

Polling pauses while the page is hidden and resumes immediately when it becomes visible. Native enumeration has a 30-second timeout; the client bounds a request to 35 seconds, then retries after five seconds. Playback-enumeration failures leave successfully discovered microphones available. Availability describes enumeration, not audible signal or guaranteed capture permission.

The helper is owned by the server. Backgrounding or reloading the SPA does not create another capture or recognition stream. Sources and gains persist across restarts. Live sessions retain the 2 GB per-source recording limit. Mant does not claim verified separation or infer individual remote participants from an application selection.

## Routing and leakage

Start with headphones and a physical microphone. There is no verified headset configuration yet; record its exact make, connection, input/output rates and call app when testing. App-specific ScreenCaptureKit capture includes only the selected application's current process set; it does not identify individual conference participants or their sides. Browser application capture can include **all tabs and browser helper audio**, not just the call tab. Keep Mant's SPA and other media in a different, quiet browser/application when capturing a browser call.

`excludesCurrentProcessAudio` excludes the native helper's process, not every browser that hosts Mant. Mant stops its own audio elements before capture, suppresses the media player while capture is active, and disables concurrent session playback. Downloads opened in other players and other browser tabs are outside Mant's control. In the routed-input fallback, all audio routed to BlackHole is included; silence unrelated applications and use application-specific output selection where available. Never play replay while live capture or a call output route is active.

No automatic echo cancellation or cross-channel suppression is applied. Both people can speak at once. If audio contains echo or duplicated speech, stop capture and correct the route or headset before restarting. Remote participant identity remains unknown unless explicitly attributed. Microphone identity is an explicit user mapping, not diarization.

## Manual BlackHole fallback and restoration

No drivers are installed automatically or bundled. Use an existing suitable installation, or install BlackHole 2ch through its [official distribution](https://existential.audio/blackhole/), which also documents a Homebrew option. Driver distribution terms have not been evaluated for bundling because Mant does not distribute it.

1. Note the current system output, call application's output/input, sample rates and any existing Audio MIDI Setup configuration so you can restore them.
2. Open **Audio MIDI Setup** → Audio Devices. Create a **Multi-Output Device** containing your headphones and **BlackHole 2ch**.
3. Match supported sample rates (typically 48 kHz) across the two outputs. Select an appropriate primary clock device and enable drift correction on the other device as Audio MIDI Setup permits. Recheck when Bluetooth changes profile/rate. Do not assume one device's nominal rate describes both clocks.
4. Set the call application's output to the Multi-Output Device. If it lacks an independent output selector, set the system output to that device. Confirm you still hear playback in the headphones.
5. In Mant select **BlackHole 2ch** as the playback **input** source and the physical microphone separately as the local source.
6. **Keep the call application's microphone set to the physical microphone**, never BlackHole or the Multi-Output Device. Routing remote playback into the call microphone creates a feedback loop.
7. Run all separation checks on the intended call. An Aggregate Device does not automatically mix or separate channels; it is not a substitute for this explicit output route.

Restore: stop Mant capture and replay, set the call output and system output back to the original headphones/device, retain/reset the call microphone to the physical microphone, and verify normal call audio. Remove the temporary Multi-Output Device only after it is no longer selected. Keep or uninstall BlackHole yourself using its official instructions; Mant never changes system routes or removes a driver. A system-output fallback includes unrelated playback, so its exclusion check may require silencing every unrelated app and recording that limitation in the review.

## Timing, silence and persistence

- Stable source IDs are `local-microphone` and `remote-playback`. Provider segment IDs are namespaced by source. Both use mono PCM16 at 24 kHz and independent provider sessions; there is no recognition mix.
- Each native input has its own AVAudioConverter, recreated on format changes. AVCapture timestamps are converted from the session synchronization clock to the common host monotonic clock; ScreenCaptureKit PTS uses that host timebase. Timestamp sanity bounds reject invalid clock mappings.
- A framed stdout transport carries JSON metadata plus separate binary PCM. It includes source ID, per-source sequence, capture time, sample rate, format and frame count. stderr is drained separately and has no audio. Parsing handles arbitrary chunk boundaries. Native pending output is capped at 1 MB; recognition queues at one second per source; provider buffers/commits keep their existing bounds. Delayed packets are retained in the originals while stale or excess recognition work is skipped, keeping the devices connected and recognition bounded.
- `CaptureAudioSource` implements the existing pull-based AudioSource interface; file replay's browser pacing stays intact. Native sessions use the host/server clock and never a backgrounded browser timer.
- **Silent channels are not continually sent for recognition.** An independent energy gate holds at most about 200 ms of onset pre-roll, sends speech with 600 ms of trailing silence, commits, then sends no PCM until activity resumes. Long active turns retain the existing 15-second commit limit. Full audio recording is never gated. This simple detector can miss very quiet speech or stay active on noise; it is not diarization. The two provider connections remain configured while capture runs; no silent append traffic is sent after hangover.
- Supplied-audio capture spans are associated with provider items, so suppressing 30 seconds of silence does not move the next transcript 30 seconds earlier. These are **turn/audio-buffer spans, not word timestamps**. Timeline order follows capture start time, including out-of-order provider finals; revision availability remains separately timestamped for replay and evaluation.
- Separate mono WAV originals include zero-filled timestamp gaps and overlap across sources. Small timestamp/converter rounding overlaps are trimmed within a track so samples are not replayed twice. Overlaps exceeding 10 ms, invalid timestamps or sequence loss trigger recovery. Delivery lag over one second does not restart either device: the original timestamped audio remains in the recording, and the next fresh recognition packet starts a new speech boundary. Delayed startup handshakes retain buffered audio. Sample-rate changes rebuild the converter while preserving physical identity. Actual stream interruptions reconnect to the same app and microphone; missing time remains in both tracks.
- Capture journals include source selection, initial gain settings, timestamped gain changes, recovery attempts, gaps, failures, estimated turn ends, local activity and final track metadata. Gain is applied once before recording, activity detection and recognition; replay plays the saved PCM without applying capture gain again. Older archives default missing gains to 0 dB. Stop retains both content-addressed originals and a synchronized stereo listening copy (local left, playback right). The listening copy never replaces originals. Raw recovery WAVs remain beside the journal as well; no capture files are automatically deleted.
- Saved sessions replay the stereo listening copy with source-preserving transcript revisions, suggestions, selected directions and FOLLOW through the existing replay pipeline. Original tracks remain in the archive library. Recompute predictive and baseline modes consume progressively released saved transcripts and preserve source attribution; the normal saved mode needs no API key. Do not choose the listening copy as single-source fresh recognition when evaluating separation.
- If the helper/server crashes, incomplete raw `<session-id>.<source-id>.wav` tracks and the append-only journal remain on disk. Their WAV length header is finalized on graceful stop; forced termination may leave an unfinished header. These recovery files are not advertised as a validated replay. No missing time is silently compressed.

Actual native process/stream errors are reported separately from silence. Mant retries the same selected app and microphone immediately, then after 1, 2 and 4 seconds. After four unsuccessful retries it stops, saves the available tracks, and offers **Retry**. Ten seconds of uninterrupted capture resets the retry budget. Stop also cancels a pending retry. A restart records a timeline gap. Physical output changes reset the activity gate while recording and recognition continue. Microphone replacement is never automatic. A quiet playback source stays in a waiting state. Silent or unshareable telephone helper audio may require the routed-input fallback.

## End-to-end checks operated by the user

No calls are placed automatically. Run these checks once on **an actual iPhone cellular call answered on this Mac**, then on **one named conference application/browser call**:

- [ ] Record OS/build, call app/version, headphone model/connection, microphone, output device, rates and selected playback bundle/helper or BlackHole route.
- [ ] Verify both ends can hear normally before Mant. Use an ordinary recording to check local speech, incoming speech, overlap and silence in the separate saved tracks.
- [ ] Confirm no substantial playback in local microphone, no unexpected local voice in playback, no unrelated app leakage and no Mant replay recapture.
- [ ] Start from a saved brief with one explicit question and one outcome. Watch separate partial transcripts and observations while the other end speaks. Capture a qualification/correction to test withdrawal of obsolete suggestions.
- [ ] Note whether a **useful** suggestion is visibly ready before the real remote turn end. Select a direction, say a paraphrase, and verify FOLLOW assesses actual local evidence. Say a different response to check partial/departed behavior. Stay silent to verify selection/silence do not count as expressed.
- [ ] Mute the call app and speak: Mant must retain transmission uncertainty.
- [ ] Background and reload the SPA; capture should continue once, and reconnect should restore the session. Stop/start repeatedly without orphan helpers/provider connections.
- [ ] Disconnect/change headset, change Bluetooth profile or restart the call app. Check automatic reconnection, the visible gap, and retained originals. Exercise Retry after recovery is exhausted.
- [ ] Stop Mant and keep talking on the call to confirm the call is unaffected.
- [ ] End/leave the call or restore output routing. Replay the saved session, listen to separate originals, and verify gaps, overlap, revision timing, source labels, selection and FOLLOW.

## Verification

Run `bun test` for synthetic parser, gate, recording, replay and lifecycle coverage. Real iPhone relay, conference audio separation, headset changes and reply usefulness still require the call checks above.
