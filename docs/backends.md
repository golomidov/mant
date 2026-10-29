# Mant AI backends

Run `bun run settings` to add reusable backend connections and assign transcription,
translation, brief preparation, analysis and suggestions independently. Configuration
is backend-only. Save and restart Mant to apply it. Cancel at any prompt to leave the
file unchanged. `bun run settings -- check` validates settings, credentials, catalog
models and local Apple availability without contacting cloud services.

`bun run settings -- check --probe` explicitly contacts each assigned backend. It
may incur API charges. Text probes exercise the actual task schemas, including
nested suggestion unions and translation revisions. Speech probes send silence and
exercise connection and final draining; they do not measure recognition accuracy.
A successful probe is a compatibility check, not a quality guarantee.

Settings live in ignored `data/backend-settings.json`. Override the path with
`MANT_SETTINGS_PATH`. Settings have `version: 1`, `connections`, and five `tasks`.
Only credential **environment-variable names** are saved. Set their values in the
server environment; the settings CLI never asks for a secret. The app uses
`--no-env-file`. No settings file preserves `OPENAI_API_KEY`, `ANALYSIS_MODEL`,
`SUGGEST_MODEL`, and the existing OpenAI realtime configuration.

Example mixed configuration:

```json
{
  "version": 1,
  "connections": {
    "speech": { "provider": "apple-speech" },
    "gemma": {
      "provider": "local", "model": "gemma-3-12b-it",
      "endpoint": "http://127.0.0.1:1234/v1",
      "capabilities": { "structured": "json", "contextWindow": 8192, "maxTokens": 4096 }
    },
    "claude": {
      "provider": "anthropic", "model": "claude-sonnet-4-5",
      "credentialEnv": "ANTHROPIC_API_KEY"
    }
  },
  "tasks": {
    "transcription": "speech", "translation": "gemma", "brief": "claude",
    "analysis": "gemma", "suggestions": "claude"
  }
}
```

Use the CLI's catalog inspector for installed cloud model IDs. Pi 1.4 routes OpenAI,
Anthropic, Google Gemini and OpenRouter. Model installation and endpoint management
remain external. Cloud connections can override `endpoint`; local connections require
it. Credentials use `credentialEnv`, defaulting to `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, or `DEEPGRAM_API_KEY`.
Keyless local servers need no credential reference.

For a fully local setup, bind all four text tasks to one or more `local` connections,
and transcription to `whisper` or `apple-speech`. Neither requires an OpenAI key.
`apple-translation` can replace the translation binding independently.

## Local text servers

| Server | Example base URL | Setup |
| --- | --- | --- |
| LM Studio | `http://127.0.0.1:1234/v1` | Load a model, start the local server, use its exact model ID. |
| llama.cpp | `http://127.0.0.1:8080/v1` | Start llama-server with a model and a chat template supporting tools or JSON schema. |
| Ollama | `http://127.0.0.1:11434/v1` | Serve an installed model by its exact tag. |

Set `capabilities.structured` to `tools` or `json`. JSON mode uses schema-constrained
OpenAI-compatible responses; tools use Pi's normalized calls. Context and output
limits can be overridden using `contextWindow` and `maxTokens`. Compatibility is
model-specific: Gemma through an endpoint is separate from Gemini Nano in Chrome.
Mant does not implement Chrome Prompt API or experimental Gemma audio inference.

Pi's text APIs require streaming HTTP support from the server. Complete structured
results work without incremental publication; a server that cannot stream HTTP is
reported incompatible. By default OpenAI suggestions publish progressively, and other
providers publish validated complete results. Set `capabilities.incremental: true`
to enable normalized tool streaming after testing a provider/model. Set it to false
to disable progressive publication. All results still pass domain validation of
references, evidence and revisions. Malformed, truncated or incompatible output
fails the affected task. Providers are never switched automatically.

## Speech

- `openai`: model `gpt-live-transcribe`, existing PCM24k realtime behavior.
- `deepgram`: model `nova-3`, optional WebSocket endpoint (default Deepgram listen).
  Streams PCM24k with replacement interims, final revisions and provider timestamps.
  Auto mode requests multilingual recognition; a single language requests that
  language. Changing a single-language session requires a restart and reports that
  explicitly. Multilingual sessions continue on the same stream. Final draining
  requires terminal metadata and a normal close, not merely a disconnected socket.
- `whisper`: separately installed `whisper-server`, multilingual model, inference
  endpoint such as `http://127.0.0.1:8080/inference`. Mant checks `/health`, resamples
  audio to PCM16k WAV, and posts multipart inference requests. Input windows are
  five seconds, with one second of overlap. Boundaries can flush shorter windows.
  Overlapping word prefixes are reconciled conservatively. Output has window-level
  capture timestamps; repeated speech and changed overlap hypotheses need quality
  evaluation. Queueing is serial per source and bounded to 20 seconds of audio.
- `apple-speech`: same bounded windows through a separate Swift SpeechAnalyzer
  helper. Select one explicit conversation language. Auto-language recognition is
  incompatible; changes apply to subsequent windows. This first adapter emits
  final window results, with chunked latency, rather than streaming Apple interims.

All adapters own cancellation, backpressure and draining. Timed-out local inference
cannot publish late results. Incoming audio and microphone use separate transports.
Capture remains implemented by Mant Capture and does not import or depend on AI
frameworks. Saved-session replay uses the existing replay path.

## Apple engines

Build with `bun run ai:build` using macOS and an SDK containing Speech, Translation
and FoundationModels. The executable is separate from Mant Capture. Runtime guards
require macOS 26+; dynamic Foundation Models schemas require macOS 26.4+.
`bun --no-env-file scripts/probe-apple.ts` reports the engines independently.

Speech checks supported and installed locales before use. Translation identifies the
source language and refuses missing language-pair assets instead of initiating a
headless download. Install the pair in the macOS Translate app. Foundation Models is
experimental: it checks Apple Intelligence availability, requested languages and
queryable context capacity, then generates using a dynamic schema. Unsupported
schema constructs fail explicitly. Short local context windows can make Mant's full
prompts unsuitable; exceeding context is a task failure, never a fallback trigger.

`capabilities.languages` restricts a connection to explicit Mant language codes;
Apple's live checks supply actual engine support. Russian availability differs
between Speech, Translation and Foundation Models. Never infer one engine's support
from another. Sandboxed command execution can hide macOS language services; run
local checks in a normal terminal when the sandbox cannot reach them.

## Health, diagnostics and costs

`/api/health` includes per-task provider/model identity, execution location,
capabilities and configuration availability. Connectivity is `unchecked` until an
explicit probe; health never sends paid requests. Apple local checks are cached for
30 seconds. Diagnostics add provider/model/connection identity without logging keys,
request payloads or speech. Errors redact referenced credentials and common token
variables.

Pi catalog costs remain estimates. Local text, whisper and Apple have zero API
charges; this excludes hardware/electricity. Deepgram audio pricing is unknown rather
than inheriting OpenAI rates. Token counts and pricing unavailable from a server are
marked by `tokens-unknown` and `pricing-unknown` counters. Custom cloud endpoints
have unknown pricing. Numeric USD totals only sum known estimates; inspect unknown
counters before interpreting totals.

## Recording benchmarks

Run `bun run benchmark:backends manifest.json report.json` with the intended settings.
The harness paces audio in real time, runs streams within each case concurrently,
handles configured language switches, and reports WER when a human reference is
provided, first-result latency, final-draining latency, sampled Mant RSS and peak/final
buffered backlog plus mean buffered backlog over the last ten seconds of input. It does not measure external model-server or native-helper memory.
Missing references yield unknown accuracy, never an invented score. Reports contain
transcript text; choose an appropriate local output path.

```json
{
  "cases": [
    { "name": "English names numbers negation", "streams": [
      { "path": "/recordings/en.wav", "language": "en", "reference": "Anna did not agree to 42 units." }
    ] },
    { "name": "Italian", "streams": [
      { "path": "/recordings/it.wav", "language": "it", "reference": "Anna non ha accettato 42 unità." }
    ] },
    { "name": "Russian", "streams": [
      { "path": "/recordings/ru.wav", "language": "ru", "reference": "Анна не согласилась на 42 единицы." }
    ] },
    { "name": "Language switch", "streams": [
      { "path": "/recordings/switch.wav", "language": "en", "switches": [{ "atMs": 5000, "language": "it" }] }
    ] },
    { "name": "Incoming and microphone", "streams": [
      { "path": "/recordings/incoming.wav", "language": "en" },
      { "path": "/recordings/microphone.wav", "language": "en" }
    ] }
  ]
}
```

Use representative consented recordings and references for each installed backend;
compare latency and backlog during long calls as well as short fixtures. See
[verification results](backend-verification.md) for what was actually exercised.

Primary implementation references: [Pi 1.4](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/README.md),
[Deepgram streaming](https://developers.deepgram.com/docs/lower-level-websockets),
[whisper.cpp server](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md),
[Apple Speech](https://developer.apple.com/documentation/speech/speechtranscriber),
[Apple Translation](https://developer.apple.com/documentation/translation/translationsession),
[Foundation Models](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel).

Language selectors query /api/languages and intersect support across the configured
tasks. Reading choices exclude ASR restrictions; conversation choices include ASR
and the text tasks that process speech. Apple Speech readiness and installed
translation pairs further narrow the choices. Auto is unavailable for Apple
Speech and uses only eligible conversation languages on other backends. Existing
incompatible saved choices remain visible with an explanation and an available
replacement can be selected. Unsupported new edits and live starts are rejected
with a corrective message. No language or backend is changed automatically.

Run `bun --no-env-file scripts/probe-apple.ts --probe` for the input-dependent
Foundation Models checks: fresh request IDs, exact revisions, contrasting
acceptance/negation, a corrected quantity and verbatim evidence. A constant Hello
response, a stale response, or incorrect facts cause the probe to exit nonzero.
Availability checks request an engine inventory rather than demanding that every
engine support a fixed language list.
