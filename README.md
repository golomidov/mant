# Mant

A local, multilingual assistant that helps you prepare before a call, then follows the live transcript, tracks your objectives, and suggests replies during the conversation automatically.

**Version 0.0.2 · Early development.** Designed for one person running it locally.

## What it does

- Prepare call objectives, follow live speech, translate the conversation, and suggest grounded replies.
- Choose cloud or local AI independently for transcription, translation, brief preparation, analysis, and suggestions. Mix providers or use a fully local setup.
- Use OpenAI, Anthropic, Gemini, OpenRouter, or local text models through servers such as LM Studio. Speech options include OpenAI realtime, Deepgram, whisper.cpp, and Apple Speech; Apple Translation and experimental Foundation Models are also available.
- Choose languages supported by your setup. Language options account for each task's capabilities and installed Apple assets, with explanations for unavailable choices.
- Record separate microphone and incoming audio tracks, then replay saved sessions and review evidence and corrections.

## Demos

### Capture a call

![Live call capture](docs/images/progress.png)

Usage videos coming soon.

## Requirements

- **Bun 1.4** (the pinned development and CI version).
- **FFmpeg** on your PATH; tested with **9.0.2**.
- **Configured AI backends**: OpenAI is the default and requires an API key. Other cloud providers need their own credentials; a fully local setup needs installed models and compatible local servers or Apple engines. Cloud requests may incur API charges. Saved replay works without credentials when model features are disabled.
- For live Mac capture: **macOS 13+** and **Xcode Command Line Tools**. Transcribing files does not require the native helper.
- For Apple AI engines: **macOS 26+**, the separate AI helper, and the required language assets. Foundation Models also requires Apple Intelligence and macOS 26.4+. Engine and language availability vary.

## Get started

Clone or download this repository, then run from its directory:

```sh
bun install --frozen-lockfile
export OPENAI_API_KEY="your-api-key"
bun run dev
```

Open **http://127.0.0.1:5173**. Set your languages in **Call brief**, enter your goals, and choose **Build objectives**. Under **Source**, add a recording or choose a saved session, then press **Start**.

The commands above use the default OpenAI setup. To choose other providers or local models, run `bun run settings`, assign a backend to each task, and restart Mant. See [AI backend setup](docs/backends.md) for installation requirements and compatibility checks.

For live Mac calls, first run `bun run capture:build`, then choose **Live Mac call**, your microphone, and the incoming application or routed input. Follow the [Mac capture setup](docs/macos-capture.md) for permissions and routing.

To run the built app:

```sh
bun run build
bun run start
```

Open **http://127.0.0.1:3001**.

## Configuration and data

Run `bun run settings` to configure reusable backend connections and assign them to tasks. Settings are saved in ignored `data/backend-settings.json` and apply after a server restart. The file stores credential environment-variable names, never credentials. Cancelling leaves the file unchanged.

Run `bun run settings -- check` to validate your setup. Add `--probe` to explicitly test connectivity and task compatibility; cloud probes may incur API charges. Models, local servers, and Apple language assets are installed separately.

Set credentials and runtime options in the server process environment. Scripts deliberately ignore `.env` files. Without a settings file, the existing OpenAI environment-variable configuration applies.

| Variable         | Default            | Purpose                                     |
| ---------------- | ------------------ | ------------------------------------------- |
| `OPENAI_API_KEY` | —                  | Server-side API credential                  |
| `MANT_SETTINGS_PATH` | `data/backend-settings.json` | Backend settings file override |
| `PORT`           | `3001`             | Server port; development proxy expects 3001 |
| `TRANSCRIPT_DIR` | `data/transcripts` | Storage directory, relative to the project  |
| `ANALYSIS_MODEL` | `gpt-6-luna`       | Interpretation and translation model        |
| `SUGGEST_MODEL`  | Analysis model     | Reply suggestion model                      |

The server listens on loopback. Recordings, transcripts, and saved briefs stay on disk. Cloud-backed tasks send the relevant audio or conversation context to their configured provider; on-device backends process it locally. API keys stay on the server. Local data is ignored by Git and is never automatically deleted. Backend failures are reported for the affected task; Mant does not switch providers automatically.

## Development

Built with **React 19.3**, **TypeScript 7**, **Vite 8.3**, **Oxlint 1.90.0**, and **Pi 1.4**. Exact dependency resolutions are recorded in `bun.lock`.

```sh
bun test
bun run lint
bun run build
```

The build includes type checking; `bun run typecheck` runs it separately. Tests use fake model transports and make no paid requests. CI runs the checks on Linux and macOS and compiles the Mac capture helper.

See [contributing](CONTRIBUTING.md) and the [changelog](CHANGELOG.md).

## Learn more

- [Call briefs, objectives, languages, and replay](docs/conversation-tracking.md)
- [Reply suggestions](docs/predictive-replies.md)
- [Mac capture setup](docs/macos-capture.md)
- [Cloud and local AI backend setup, language availability, and benchmarks](docs/backends.md)
- [Grounding, corrections, and usage](docs/grounding-and-usage.md)
- [Diagnostics](docs/transcription-isolation.md)

Model findings can be wrong. There is no automatic speaker diarization; call capture and audio separation depend on the application and hardware. Historical journals using retired schemas may no longer load.

Licensed under the [MIT License](LICENSE).
