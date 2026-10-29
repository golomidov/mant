# Changelog

## 0.0.2 — Unreleased

- Independent cloud or local backends for transcription, translation, brief preparation, conversation analysis, and reply suggestions, including mixed and fully local setups.
- Text-model support through Pi for OpenAI, Anthropic, Google Gemini, OpenRouter, and compatible local servers such as LM Studio, llama.cpp, and Ollama.
- Deepgram streaming and local whisper.cpp transcription adapters, plus a separate macOS helper for Apple Speech, Apple Translation, and experimental Foundation Models.
- Interactive backend settings with per-task assignments, credential environment references, validation, and explicit compatibility probes. Existing OpenAI configuration remains the default.
- Backend-aware language choices that account for task support, installed speech assets, and translation pairs. Incompatible saved choices show an explanation, and unsupported new choices are rejected before inference.
- Provider-aware health, diagnostics, and usage reporting, with recording benchmarks and input-dependent Apple generation probes.
- Preserved transcription across OpenAI language changes by committing buffered speech before reconfiguration.

## 0.0.1

- Live transcription and recording playback in six languages.
- Mac microphone and application audio capture with separate tracks.
- Autosaved call preparation and named brief templates.
- Evidence-based objective tracking, translations, and reply suggestions.
- Saved-session replay, corrections, and progressive recomputation.

The app is in early development. Persisted formats may change between versions.
