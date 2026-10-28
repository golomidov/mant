import { translationMatches } from '../shared/translations'
import { StatusArea } from './Reports'
import { useReport, useReports } from './report-hooks'
import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { ClientCommand, Delay, Mode, Recording, ReplaySpeed, SavedTranscript, Segment, SourceLibrary } from "../shared/protocol";
import { active, replaySpeeds } from "../shared/protocol";
import { initialState, reduceEvent } from "./state";
import "./App.css";
import { Column, Section } from "./Section";
import { PillSwitch } from "./PillSwitch";
import { EvidenceConnections } from "./EvidenceConnections";
import {
  briefWithPeople,
  emptyAnalysis,
  emptyBrief,
  type AnalysisMode,
  type AnalysisState,
  type AssistantAction,
} from "../shared/analysis";
import { Suggestions, TranscriptReply } from "./Suggestions";
import type { SuggestionAction, SuggestionMode, SuggestionState } from "../shared/suggestions";
import { AnalysisError, BriefEditor, Objectives, Observations, type Selection } from "./Assistant";
import { CaptureSetup } from "./CaptureSetup";
import { connectToServer } from "./connection";
import { captureSourceSummary, type CaptureSourceSummary } from "../shared/capture";
import { loadBriefCache } from "./brief-cache";
import { loadCaptureSetupCache } from "./capture-cache";
import { languageCode, languageName, languageSettings } from "../shared/languages";

const TranscriptLine = memo(function TranscriptLine({
  segment,
  highlighted,
  speaker,
  translation,
  targetLanguage,
  translationPartial,
}: {
  segment: Segment;
  highlighted: boolean;
  speaker: string | undefined;
  translation?: string;
  translationPartial?: boolean;
  targetLanguage: string;
}) {
  if (!segment.text) return null;
  speaker ??= segment.capture
    ? segment.sourceId === "local-microphone"
      ? "Local microphone · transmission unknown"
      : "Playback source · participants unknown"
    : undefined;
  return (
    <p
      id={`segment-${segment.id}`}
      data-revision={segment.revision}
      tabIndex={-1}
      className={`segment ${segment.status} ${highlighted ? "highlighted" : ""}`}
    >
      <span className="segment-state">{segment.status === "partial" ? "LIVE" : "✓"}</span>
      {speaker && <small className="speaker-label">{speaker}</small>}
      {segment.text}
      {translation && (
        <span className="transcript-translation" lang={targetLanguage}>
          <small>{languageName(targetLanguage)} translation{translationPartial ? " so far" : ""}</small>
          {translation}
        </span>
      )}
    </p>
  );
});
const formatTime = (value: number | undefined) =>
  value == null || !Number.isFinite(value) ? "—" : `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;

function App() {
  const [state, dispatch] = useReducer(reduceEvent, initialState);
  const [connection, setConnection] = useState("Connecting");
  const [serverReady, setServerReady] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [localAnalysis] = useState(() => emptyAnalysis("preparation", loadBriefCache()?.base ?? briefWithPeople(emptyBrief())));
  const [captureSummary, setCaptureSummary] = useState<CaptureSourceSummary | null>(() => {
    const setup = loadCaptureSetupCache();
    return setup?.selection ? captureSourceSummary(setup.selection, null, setup.labels) : null;
  });
  const [media, setMedia] = useState<Recording[]>([]);
  const [sourceChoice, setSourceChoice] = useState(() => {
    try {
      return localStorage.getItem("mant-live-setup") === "true" ? "capture" : "";
    } catch {
      return "";
    }
  });
  const [sourceOpen, setSourceOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const reviewRequest = useRef<AbortController | null>(null);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const reportError = useCallback((source: string, error: string | null) => setLocalErrors(previous => {
    const next = { ...previous }; if (error) next[source] = error; else delete next[source]; return next;
  }), []);
  const [translationPending, setTranslationPending] = useState(false);
  const [translationError, setTranslationError] = useState('');
  const [delay, setDelay] = useState<Delay>("minimal");
  const [playing, setPlaying] = useState(false);
  const [audioDuration, setAudioDuration] = useState<{ id: string; seconds: number } | null>(null);
  const workspace = useRef<HTMLElement | null>(null);
  const [archives, setArchives] = useState<SavedTranscript[]>([]);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("saved");
  const [suggestionMode, setSuggestionMode] = useState<SuggestionMode>("saved");
  const [selection, setSelection] = useState<Selection>(null);
  const [seekSeconds, setSeekSeconds] = useState("0");
  const [briefDirty, setBriefDirty] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const backgroundSocket = useRef<WebSocket | null>(null);
  const telemetry = useCallback((event: string, reason: string) => {
    void fetch('/api/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, reason }) }).catch(() => {});
  }, []);
  useEffect(() => connectToServer({
    url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/background`,
    background: true,
    onSocket: ws => { backgroundSocket.current = ws },
    onState: value => { if (value === 'Connected') telemetry('background-reconnect', 'background-connected') },
    onDisconnect: () => telemetry('background-reconnect', 'background-disconnect'),
    onInvalidMessage: () => {},
    onMessage: message => { startTransition(() => dispatch(message)) },
  }), [telemetry]);
  const audio = useRef<HTMLAudioElement | null>(null);
  const sourceInput = useRef<HTMLInputElement | null>(null);
  const sessionRef = useRef(state.session);
  const autoplay = useRef(false);
  const resumeOnReady = useRef(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    sessionRef.current = state.session;
  }, [state.session]);
  const session = state.session;
  const busy = !!session && active(session.phase);
  const captureChosen = sourceChoice === "capture" || (busy && !!session.capture);
  const mode: Mode = sourceChoice.startsWith("session:") ? "replay" : "live";
  const archiveId = mode === "replay" ? sourceChoice.slice(8) : "";
  const recording = media.find((item) => sourceChoice === `media:${item.id}`);
  const effectiveMode = busy ? session.mode : mode;
  const saved = archives.find((item) => item.id === archiveId);
  const selected = busy ? session.source : effectiveMode === "replay" ? (saved?.source ?? null) : (recording ?? null);
  const hasAudio = effectiveMode !== "replay" || (busy ? true : !!saved?.audioAvailable);
  const playbackRate = effectiveMode === "replay" ? (session?.replay && busy ? session.replay.speed : speed) : 1;
  const connected = connection === "Connected";
  useEffect(() => {
    try {
      localStorage.setItem("mant-live-setup", String(sourceChoice === "capture"));
    } catch {
      /* Setup remains available if browser storage is disabled. */
    }
  }, [sourceChoice]);
  const selectedEvidence =
    selection?.type === "observation"
      ? state.analysis?.observations.find((o) => o.id === selection.id)?.evidence
      : state.analysis?.brief.objectives.find((o) => o.id === selection?.id)?.evidence;
  const highlighted = new Set(selectedEvidence?.map((e) => e.segmentId));
  const readingLanguage = state.analysis ? languageSettings(state.analysis.brief).user : "en";
  function selectEvidence(value: Selection) {
    setSelection(value);
    following.current = false;
    const evidence =
      value?.type === "observation"
        ? state.analysis?.observations.find((o) => o.id === value.id)?.evidence
        : state.analysis?.brief.objectives.find((o) => o.id === value?.id)?.evidence;
    if (evidence?.[0]) {
      const target = document.getElementById(`segment-${evidence[0].segmentId}`);
      const list = scroller.current;
      if (target && list) list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top - 24;
    }
  }
  const assistantSend = useCallback(
    async (action: AssistantAction) => {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...action, sessionId: state.analysis?.sessionId ?? "preparation" }),
        signal: AbortSignal.timeout(action.action === "brief" ? 5000 : 60000),
      });
      if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
      return (await response.json()) as AnalysisState;
    },
    [state.analysis?.sessionId],
  );

  const suggestionSend = useCallback(
    async (action: SuggestionAction) => {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...action, sessionId: state.suggestions?.sessionId, runId: state.suggestions?.runId }),
      });
      if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
      return (await response.json()) as SuggestionState;
    },
    [state.suggestions?.sessionId, state.suggestions?.runId],
  );
  const refreshLibrary = useCallback(async () => {
    const response = await fetch("/api/library");
    if (!response.ok) throw new Error("Unable to load media and sessions. Check the server connection.");
    const library = (await response.json()) as SourceLibrary;
    setArchives(library.sessions);
    setMedia(library.media);
    reportError('Library', null);
  }, [reportError]);

  useLayoutEffect(() => {
    if (audio.current) {
      audio.current.defaultPlaybackRate = playbackRate;
      audio.current.playbackRate = playbackRate;
    }
  }, [playbackRate, selected?.id]);

  const send = useCallback((command: ClientCommand) => {
    if (socket.current?.readyState !== WebSocket.OPEN) {
      reportError('Connection', "The server connection is unavailable. Wait for reconnection.");
      return;
    }
    if (socket.current.bufferedAmount > 16_000) {
      telemetry('playback-pause', 'control-congestion');
      audio.current?.pause();
      reportError('Connection', "The application connection is congested. Playback paused; reconnect before continuing.");
      return;
    }
    socket.current.send(JSON.stringify(command));
  }, [reportError, telemetry]);

  async function chooseSource(value: string) {
    if (value === "add-source") {
      sourceInput.current?.click();
      return;
    }
    reviewRequest.current?.abort();
    reviewRequest.current = null;
    setReviewLoading(false);
    audio.current?.pause();
    autoplay.current = false;
    resumeOnReady.current = false;
    setSourceChoice(value);
    setSeekSeconds("0");
    setSelection(null);
    reportError('Saved call', null);
    if (!value.startsWith("session:")) return;
    setAnalysisMode("saved");
    setSuggestionMode("saved");
    following.current = false;
    if (scroller.current) scroller.current.scrollTop = 0;
    const controller = new AbortController();
    reviewRequest.current = controller;
    setReviewLoading(true);
    try {
      const response = await fetch(`/api/archives/${value.slice(8)}/review`, { method: "POST", signal: controller.signal });
      if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
    } catch (error) {
      if (!controller.signal.aborted) reportError('Saved call', (error as Error).message);
    } finally {
      if (reviewRequest.current === controller) {
        reviewRequest.current = null;
        setReviewLoading(false);
      }
    }
  }

  useEffect(() => () => reviewRequest.current?.abort(), []);

  useEffect(
    () =>
      connectToServer({
        url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
        onSocket: (ws) => {
          socket.current = ws;
        },
        onState: setConnection,
        onDisconnect: () => {
          telemetry('playback-pause', 'control-disconnect');
          audio.current?.pause();
          setServerReady(false);
          setCaptureSummary((previous) =>
            previous
              ? {
                  microphone: { ...previous.microphone, availability: "unknown" },
                  playback: { ...previous.playback, availability: "unknown" },
                }
              : null,
          );
        },
        onInvalidMessage: () => reportError('Connection', "Received an invalid server message. Reload the page."),
        onMessage: (message) => {
          try {
            dispatch(message);
            if (message.type === "snapshot") {
              if (backgroundSocket.current?.readyState === WebSocket.OPEN) backgroundSocket.current.send('snapshot');
              setServerReady(true);
              reportError('Connection', null);
              setConnectionEpoch((epoch) => epoch + 1);
              setCaptureSummary((previous) =>
                previous
                  ? {
                      microphone: { ...previous.microphone, availability: "checking" },
                      playback: { ...previous.playback, availability: "checking" },
                    }
                  : null,
              );
            }
            if (
              message.type === "snapshot" ||
              message.type === "ended" ||
              (message.type === "status" && message.session.phase === "ready")
            ) {
              void refreshLibrary().catch((error) => reportError('Library', (error as Error).message));
            }
            if (
              "session" in message &&
              message.session &&
              (message.type === "snapshot" || (message.type === "status" && message.session.phase === "configuring"))
            ) {
              setSourceChoice(
                message.session.capture
                  ? "capture"
                  : message.session.replay
                    ? `session:${message.session.replay.archiveId}`
                    : `media:${message.session.source.id}`,
              );
              if (message.session.replay) {
                setSpeed(message.session.replay.speed);
                setAnalysisMode(message.session.replay.analysisMode ?? "saved");
                setSuggestionMode(message.session.replay.suggestionMode ?? "saved");
              }
            }
          } catch {
            reportError('Connection', "Received an invalid server message. Reload the page.");
          }
        },
      }),
    [refreshLibrary, reportError, telemetry],
  );

  const play = useCallback(async (resume = false) => {
    const element = audio.current;
    if (!element || sessionRef.current?.capture) return;
    if (resume && sessionRef.current) element.currentTime = sessionRef.current.diagnostics.mediaMs / 1000;
    try {
      await element.play();
      reportError('Playback', null);
    } catch {
      reportError('Playback', "Playback could not start. Use Resume to allow playback, or choose MP3/WAV/M4A audio.");
    }
  }, [reportError]);

  useEffect(() => {
    if (session?.phase === "ready" && autoplay.current) {
      autoplay.current = false;
      void play(resumeOnReady.current);
      resumeOnReady.current = false;
    }
    if (session && ["paused", "draining", "ended", "error"].includes(session.phase)) {
      autoplay.current = false;
      audio.current?.pause();
    }
  }, [session, play]);

  useEffect(() => {
    if (!playing) return;
    const report = () => {
      const current = sessionRef.current;
      const element = audio.current;
      if (
        current &&
        !current.capture &&
        element &&
        ["ready", "running"].includes(current.phase) &&
        !element.paused &&
        socket.current?.readyState === WebSocket.OPEN
      ) {
        send({ type: "start", sessionId: current.id, playbackMs: element.currentTime * 1000 });
      }
    };
    report();
    const timer = setInterval(report, 40);
    return () => clearInterval(timer);
  }, [playing, send]);

  useLayoutEffect(() => {
    if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [state.segments]);

  async function upload(file: File | undefined, attachTo?: SavedTranscript) {
    if (!file) return;
    audio.current?.pause();
    setUploading(true);
    reportError('Upload', null);
    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      });
      if (!response.ok) {
        const body = (await response.json()) as { error: string };
        throw new Error(body.error);
      }
      const result = (await response.json()) as Recording;
      await refreshLibrary();
      if (attachTo) {
        if (result.id !== attachTo.source.id)
          throw new Error("This audio does not match the selected session. Choose its original recording.");
      } else setSourceChoice(`media:${result.id}`);
    } catch (error) {
      reportError('Upload', error instanceof Error ? error.message : "Upload failed. Try again.");
    } finally {
      setUploading(false);
    }
  }

  async function importTranscript(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    reportError('Import', null);
    try {
      const response = await fetch("/api/archives", { method: "POST", body: file, headers: { "Content-Type": "application/x-ndjson" } });
      if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
      const result = (await response.json()) as SavedTranscript;
      await refreshLibrary();
      await chooseSource(`session:${result.id}`);
    } catch (error) {
      reportError('Import', error instanceof Error ? error.message : "Transcript import failed.");
    } finally {
      setUploading(false);
    }
  }

  function start(restart = false) {
    if (!selected || busy || !connected || briefDirty || reviewLoading) return;
    const resume =
      !restart &&
      effectiveMode === "replay" &&
      session?.phase === "paused" &&
      session.replay?.archiveId === archiveId &&
      (session.replay.analysisMode ?? "saved") === analysisMode &&
      (session.replay.suggestionMode ?? "saved") === suggestionMode;
    const element = audio.current;
    if (element) {
      element.pause();
      if (!resume) element.currentTime = 0;
    }
    resumeOnReady.current = resume;
    reportError('Playback', null);
    following.current = true;
    autoplay.current = true;
    if (effectiveMode === "replay") {
      if (!saved?.audioAvailable) {
        autoplay.current = false;
        reportError('Playback', "Attach the original recording to replay this transcript.");
        return;
      }
      send({ type: "start", archiveId: saved.id, speed, analysisMode, suggestionMode, ...(restart ? { restart: true } : {}) });
    } else send({ type: "start", sourceId: selected.id, delay, mode: "live" });
  }

  function stop(reason?: "eof") {
    audio.current?.pause();
    autoplay.current = false;
    if (sessionRef.current)
      send({
        type: "stop",
        sessionId: sessionRef.current.id,
        playbackMs: sessionRef.current.capture ? sessionRef.current.diagnostics.mediaMs : (audio.current?.currentTime ?? 0) * 1000,
        ...(reason ? { reason } : {}),
      });
  }
  async function backToLiveSetup() {
    audio.current?.pause();
    autoplay.current = false;
    try {
      const response = await fetch("/api/capture/back", { method: "POST" });
      if (!response.ok) throw new Error(((await response.json()) as { error: string }).error);
      setSourceChoice("capture");
      reportError('Capture', null);
    } catch (error) {
      reportError('Capture', (error as Error).message);
    }
  }

  function changeSpeed(value: ReplaySpeed) {
    if (busy && session.mode === "replay")
      send({ type: "speed", sessionId: session.id, speed: value, playbackMs: (audio.current?.currentTime ?? 0) * 1000 });
    else setSpeed(value);
  }

  const replayId = effectiveMode === "replay" ? (busy ? session.replay?.archiveId : archiveId) : null;

  const sourceSession =
    captureChosen && session?.capture
      ? session
      : session &&
          session.mode === effectiveMode &&
          (effectiveMode === "replay" ? session.replay?.archiveId === archiveId : busy && session.source.id === selected?.id)
        ? session
        : null;
  const replaySession = sourceSession?.mode === "replay" ? sourceSession : null;
  const sourcePosition = sourceSession?.diagnostics.mediaMs ?? 0;
  const sourceDuration =
    effectiveMode === "replay"
      ? (replaySession?.replay?.durationMs ?? saved?.durationMs)
      : audioDuration && audioDuration.id === selected?.id
        ? audioDuration.seconds * 1000
        : undefined;
  const resumePlayback = busy && !session.capture && ["ready", "running"].includes(session.phase) && !playing;
  const resumeSession =
    !busy &&
    effectiveMode === "replay" &&
    session?.phase === "paused" &&
    session.replay?.archiveId === archiveId &&
    (session.replay.analysisMode ?? "saved") === analysisMode &&
    (session.replay.suggestionMode ?? "saved") === suggestionMode;
  const seekPosition = Number(seekSeconds) * 1000;
  const canSeek =
    !!replaySession &&
    connected &&
    !briefDirty &&
    Number.isFinite(seekPosition) &&
    seekPosition >= 0 &&
    seekPosition <= (replaySession.replay?.durationMs ?? 0);

  const sourceControls = (
    <>
      <label className="field source-select">
        Source
        <select
          value={
            busy && session.capture
              ? "capture"
              : busy
                ? session.replay
                  ? `session:${session.replay.archiveId}`
                  : `media:${session.source.id}`
                : sourceChoice
          }
          disabled={busy || uploading}
          onChange={(event) => {
            void chooseSource(event.target.value);
          }}
        >
          <option value="">Choose media or a saved session…</option>
          <option value="capture">Live Mac call</option>
          <option value="add-source">＋ Add media or session…</option>
          <optgroup label="Media files · start a new session">
            {media.map((item) => (
              <option key={item.id} value={`media:${item.id}`}>
                {item.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Saved calls · replay">
            {archives
              .filter((item) => item.source.capture)
              .map((item) => (
                <option key={item.id} value={`session:${item.id}`}>
                  {item.source.capture?.diagnostic ? "Audio check · " : ""}
                  {item.source.name} · {formatTime(item.durationMs / 1000)} · {item.id.slice(0, 8)}
                </option>
              ))}
          </optgroup>
          <optgroup label="Saved file sessions · replay">
            {archives
              .filter((item) => !item.source.capture)
              .map((item) => (
                <option key={item.id} value={`session:${item.id}`}>
                  {item.source.name} · {new Date(item.createdAt).toLocaleString()} · {item.id.slice(0, 8)}
                </option>
              ))}
          </optgroup>
        </select>
      </label>
      {!captureChosen && (
        <button
          disabled={!connected || uploading}
          onClick={() => {
            void refreshLibrary().catch((error) => reportError('Library', (error as Error).message));
          }}
        >
          Refresh sources
        </button>
      )}
      <input
        ref={sourceInput}
        type="file"
        hidden
        aria-label="Add media or session"
        accept="audio/*,video/*,.jsonl,.ndjson,application/x-ndjson"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            if (/\.(jsonl|ndjson)$/i.test(file.name) || /(?:ndjson|jsonl)/i.test(file.type)) void importTranscript(file);
            else void upload(file);
          }
          event.target.value = "";
        }}
      />
      {effectiveMode === "live" && (
        <details className="transcription-settings"><summary>Advanced</summary><label className="field">
          Transcription
          <select value={busy ? session.delay : delay} disabled={busy} onChange={(event) => setDelay(event.target.value as Delay)}>
            <option value="minimal">Fastest text</option>
            <option value="low">More context</option>
          </select>
        </label><p className="help">More context may improve accuracy while delaying text.</p></details>
      )}
    </>
  );

  const reportScope = (session?.id ?? "preparation") + ":" + sourceChoice;
  const [reportSession, setReportSession] = useState(reportScope);
  if (reportSession !== reportScope) { setReportSession(reportScope); setLocalErrors({}); setTranslationError(''); setTranslationPending(false) }
  useReports(Object.entries(localErrors).map(([source, summary]) => ({ id: 'local-' + source, source, summary, severity: 'error' })), session?.id);
  useReport('connection', { source: 'Connection', severity: connected ? 'success' : connection === 'Connecting' ? 'progress' : 'warning', summary: connected ? 'Connected' : connection + ' · waiting for server' });
  useReport('server-session', session?.message ? { source: session.capture ? 'Capture' : 'Playback', severity: 'error', summary: session.message } : null, session?.id);
  useReport('server-error', state.error && state.error !== session?.message ? { source: 'Session', severity: 'error', summary: state.error } : null, session?.id);
  useReport('transfer', uploading || reviewLoading ? { source: 'Sources', severity: 'progress', summary: uploading ? 'Uploading or importing source…' : 'Loading saved call…' } : null);
  useReport('persistence', session?.persistenceMessage ? { source: 'Persistence', severity: 'error', summary: session.persistenceMessage } : null, session?.id);
  useReport('session-phase', session && session.phase !== 'error' ? { source: session.capture ? 'Capture' : 'Playback', severity: ['ended', 'paused'].includes(session.phase) ? 'success' : 'progress', summary: session.phase === 'configuring' ? 'Starting session…' : session.phase === 'draining' ? 'Finishing session…' : session.phase === 'ended' ? 'Session finished' : session.phase === 'paused' ? 'Playback paused' : session.capture ? 'Capturing audio' : playing ? 'Playing recording' : 'Ready for playback' } : null, session?.id);
  useReport('missing-audio', saved && !saved.audioAvailable ? { source: 'Playback', severity: 'warning', summary: saved.source.name + ': Attach the original recording to replay audio and transcript together.' } : null, session?.id);
  const [translationStatus, setTranslationStatus] = useState(state.analysis?.translationStatus);
  if (translationStatus !== state.analysis?.translationStatus) { setTranslationStatus(state.analysis?.translationStatus); if (state.analysis?.translationStatus !== 'error') setTranslationError('') }
  useReport('translation', translationError || state.analysis?.translationStatus === 'error' || state.analysis?.translationStatus === 'translating' || translationPending ? {
    source: 'Translation', severity: translationPending || state.analysis?.translationStatus === 'translating' ? 'progress' : 'error',
    summary: translationPending || state.analysis?.translationStatus === 'translating' ? 'Translating messages into ' + languageName(readingLanguage) + '…' : translationError || state.analysis?.translationMessage || 'Translation failed.',
    action: { label: 'Retry translation', pending: translationPending || state.analysis?.translationStatus === 'translating', run: async () => {
      const requestedSession = state.analysis?.sessionId ?? 'preparation';
      const currentRequest = () => (sessionRef.current?.id ?? 'preparation') === requestedSession;
      setTranslationPending(true); setTranslationError('');
      try { const result = await assistantSend({ action: 'retry_translation' }); if (currentRequest() && result.translationStatus === 'error') setTranslationError(result.translationMessage || 'Translation failed.') }
      catch (error) { if (currentRequest()) setTranslationError((error as Error).message) } finally { if (currentRequest()) setTranslationPending(false) }
    } },
  } : null, session?.id);

  return (
    <main className="app-shell">
      <header className="masthead">
        <h1 className="brand" aria-label="Mant">
          <span className="brand-mark" aria-hidden="true">
            m
          </span>
          <span>mant</span>
        </h1>
        <div className="header-status"><span className={`connection ${connected ? "online" : ""}`}>
          <i />
          {connection}
        </span><StatusArea /></div>
      </header>
      <BriefEditor
        key={state.analysis?.sessionId ?? "preparation"}
        analysis={state.analysis ?? localAnalysis}
        send={assistantSend}
        onDirtyChange={setBriefDirty}
        connected={serverReady && !!state.analysis}
        connectionEpoch={connectionEpoch}
        knownUserId={state.suggestions?.userParticipantId ?? session?.source.capture?.selection.localParticipantId}
      />
      <Section
        className="source-panel"
        title="Source"
        onToggle={setSourceOpen}
        meta={
          <>
            {captureChosen ? (
              <span className="capture-title-devices">
                {(["microphone", "playback"] as const).map((source) => {
                  const device = captureSummary?.[source];
                  const availability = serverReady ? (device?.availability ?? "checking") : "unknown";
                  return (
                    <span
                      key={source}
                      className="capture-device-label"
                      data-availability={availability}

                    >
                      {source === "microphone" ? "Mic: " : "Audio: "}
                      {device?.name ?? (source === "microphone" ? "Microphone" : "Browser / app")}
                    </span>
                  );
                })}
              </span>
            ) : (
              <span className="capture-device-label" data-availability={serverReady && selected ? "available" : "unavailable"}>
                {selected?.name ?? "Choose media or a saved session"}
              </span>
            )}
            <span>{effectiveMode === "replay" ? "Saved session" : "New session"}</span>
            {effectiveMode === "replay" && <span>{playbackRate}×</span>}
            <span>
              {formatTime(sourcePosition / 1000)} / {formatTime(sourceDuration == null ? undefined : sourceDuration / 1000)}
            </span>
          </>
        }
      >
        {!captureChosen && (
          <div className="controls">
            {sourceControls}
            <div className="buttons">
              <button
                className="primary"
                onClick={() => {
                  if (resumePlayback) void play(true);
                  else start();
                }}
                disabled={
                  reviewLoading ||
                  briefDirty ||
                  !serverReady ||
                  !selected ||
                  !hasAudio ||
                  (busy && !resumePlayback) ||
                  uploading ||
                  !connected
                }
              >
                {resumePlayback || resumeSession ? "▶ Resume" : "▶ Start"}
              </button>
              <button onClick={() => stop()} disabled={!busy || (session?.phase === "draining" && session.mode === "live") || !connected}>
                ■ Stop
              </button>
              {effectiveMode === "replay" && (
                <button
                  onClick={() => start(true)}
                  disabled={reviewLoading || briefDirty || !selected || !hasAudio || busy || uploading || !connected}
                >
                  ↶ Restart
                </button>
              )}
            </div>
          </div>
        )}
        {captureChosen && (
          <CaptureSetup
            onSourcesChange={setCaptureSummary}
            sourceControls={sourceControls}
            session={session}
            busy={busy}
            connectionEpoch={connectionEpoch}
            discover={sourceOpen || (busy && !!session?.capture)}
            disabled={!serverReady || uploading || reviewLoading}
            assistantDisabled={briefDirty}
            delay={delay}
            beforeStart={() => {
              audio.current?.pause();
              autoplay.current = false;
              setSourceChoice("capture");
              reportError('Playback', null);
            }}
            stop={() => stop()}
          />
        )}
        {session && <button disabled={busy || briefDirty || !connected} onClick={() => void backToLiveSetup()}>Return to preparation</button>}
        {effectiveMode === "replay" && (
          <div className="replay-controls">
            <label className="field">
              Replay suggestions
              <select value={suggestionMode} disabled={busy} onChange={(e) => setSuggestionMode(e.target.value as SuggestionMode)}>
                <option value="saved">Replay saved suggestions</option>
                <option value="predictive">Predictive (model)</option>
                <option value="baseline">Baseline · turn end (model)</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label className="field">
              Analysis
              <select value={analysisMode} disabled={busy} onChange={(e) => setAnalysisMode(e.target.value as AnalysisMode)}>
                <option value="saved">Saved analysis</option>
                <option value="recompute">Recompute (model)</option>
              </select>
            </label>
            <PillSwitch
              label="Replay speed"
              value={playbackRate}
              disabled={uploading}
              onChange={changeSpeed}
              options={replaySpeeds.map((value) => ({ value, label: `${value}×` }))}
            />
            {replaySession && (
              <form
                className="seek-controls"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!canSeek) return;
                  audio.current?.pause();
                  autoplay.current = true;
                  resumeOnReady.current = true;
                  setSelection(null);
                  send({ type: "seek", sessionId: replaySession.id, playbackMs: seekPosition });
                }}
              >
                <label className="field">
                  Seek (seconds)
                  <input
                    type="number"
                    min="0"
                    step="any"
                    max={(replaySession.replay?.durationMs ?? 0) / 1000}
                    value={seekSeconds}
                    onChange={(e) => setSeekSeconds(e.target.value)}
                  />
                </label>
                <button type="submit" disabled={!canSeek}>
                  Seek
                </button>
              </form>
            )}
          </div>
        )}
        {effectiveMode === "replay" && saved && !saved.audioAvailable && !busy && (
          <div className="attach-audio">
            <label className="import-button">
              ↥ Attach original audio
              <input
                type="file"
                aria-label="Attach original audio"
                accept="audio/*,video/*"
                disabled={uploading}
                onChange={(event) => {
                  void upload(event.target.files?.[0], saved);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
        )}
        {!captureChosen && (
          <div className="playback">
            <audio
              ref={audio}
              onLoadedMetadata={() => {
                if (selected && audio.current) setAudioDuration({ id: selected.id, seconds: audio.current.duration });
              }}
              src={selected && hasAudio && !session?.capture ? `/api/sources/${selected.id}/audio` : undefined}
              preload="auto"
              onPlaying={() => setPlaying(true)}
              onWaiting={() => telemetry('playback-pause', 'media-waiting')}
              onPause={() => { setPlaying(false); telemetry("playback-pause", "media-pause") }}
              onEnded={() => stop("eof")}
              onError={() => reportError('Playback', "Unable to play the original recording. Attach browser-supported audio such as MP3 or PCM WAV.")}
            />
            {replayId && (
              <a className="archive-link" href={`/api/archives/${replayId}`} download>
                Download transcript log ↗
              </a>
            )}
            {selected && hasAudio && (
              <a href={`/api/sources/${selected.id}/audio`} download={selected.name}>
                {selected.capture ? "Stereo listening copy ↗" : "Original audio ↗"}
              </a>
            )}
            {selected?.capture?.tracks.map((track) => (
              <a key={track.sourceId} href={`/api/sources/${track.audioId}/audio`} download={track.name}>
                {track.sourceId} original ↗
              </a>
            ))}
          </div>
        )}
      </Section>
      <AnalysisError key={"analysis-" + state.analysis?.sessionId} analysis={state.analysis} send={assistantSend} />
      <section className="workspace" ref={workspace} aria-label="Conversation workspace" aria-busy={reviewLoading}>
        <Objectives
          analysis={state.analysis}
          selection={selection}
          select={selectEvidence}
          segments={state.segments}
          send={assistantSend}
        />
        <Column
          className="transcript-panel"
          title="Transcript"
          meta={
            <>
              <span>{state.order.length} segments</span>
              <button
                className="follow-latest"
                onClick={() => {
                  following.current = true;
                  if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
                }}
              >
                Follow latest ↓
              </button>
            </>
          }
        >
          <div
            className="transcript"
            tabIndex={0}
            ref={scroller}
            onScroll={() => {
              const element = scroller.current;
              if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 70;
            }}
            role="log"
            aria-label="Recording transcript"
            aria-live="off"
          >
            {state.order.length ? (
              state.order.map((id) => {
                const segment = state.segments.get(id)!;
                const translated = state.analysis?.translations?.[id];
                const show =
                  translationMatches(translated, segment) &&
                  translated.targetLanguage === readingLanguage &&
                  translated.sourceLanguage !== readingLanguage &&
                  languageCode(state.analysis?.brief.languages.call) !== readingLanguage;
                return (
                  <TranscriptLine
                    key={`${session?.id}:${id}`}
                    segment={segment}
                    highlighted={highlighted.has(id)}
                    speaker={state.analysis?.attributions[id]?.sourceLabel}
                    translation={show ? translated.text : undefined}
                    translationPartial={show && translated.sourceText !== undefined && translated.sourceText.length < segment.text.length}
                    targetLanguage={readingLanguage}
                  />
                );
              })
            ) : (
              <div className="empty">
                <span className="waveform">▂ ▅ ▃ ▇ ▄ ▂ ▆ ▃</span>
                <h3>{busy ? "Listening for the first words…" : "The words will appear here."}</h3>
                <p>
                  Choose a recording and press Start.
                  <br />
                  Partial text appears as soon as it arrives.
                </p>
              </div>
            )}
          </div>

          <TranscriptReply>
            {state.suggestions ? (
              <Suggestions
                key={state.suggestions.runId}
                state={state.suggestions}
                analysis={state.analysis}
                segments={state.segments}
                send={suggestionSend}
                assistantSend={assistantSend}
              />
            ) : (
              <div className="reply-empty">
                <h3>What you can say</h3>
                <p>Reply suggestions appear here as the conversation develops.</p>
              </div>
            )}
          </TranscriptReply>
        </Column>
        <Observations
          analysis={state.analysis}
          selection={selection}
          select={selectEvidence}
          segments={state.segments}
          send={assistantSend}
        />
        <EvidenceConnections workspace={workspace} selection={selection} evidence={selectedEvidence ?? []} />
      </section>
    </main>
  );
}

export default App;
