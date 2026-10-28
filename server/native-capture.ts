import { diagnostic, isolate } from './diagnostics'
import { resolve } from 'node:path'
import type { CaptureFrame, CaptureGains, CaptureInventory, CaptureSelection, CaptureSourceId, CaptureStatus, NativeEvent } from '../shared/capture'
import { captureSources, defaultCaptureGains, parseCaptureGains } from '../shared/capture'
import type { Delay, Segment, ServerPayload, Session } from '../shared/protocol'
import type { Archives } from './archive'
import type { TranscriptionTransport, TransportFactory } from './transcription'
import { ActivityGate, CaptureAudioSource, CaptureFrameParser, applyCaptureGain } from './capture-audio'
import { capturePlaceholder, CaptureRecorder, type CaptureJournalRow } from './capture-recording'
import { PACKET_BYTES, BYTES_PER_MS, SpeechBoundary } from './audio'
import { safeMessage } from './errors'

export const helperPath = resolve(import.meta.dir, '../native/build/Mant Capture.app/Contents/MacOS/MantCapture')
// Native capture has no credentials, including inherited model keys.
const helperEnvironment = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG })
export async function captureInventory(): Promise<CaptureInventory> {
  if (process.platform !== 'darwin' || !await Bun.file(helperPath).exists()) return { os: process.platform, architecture: process.arch, minimumMacOS: '13.0', supported: false, microphonePermission: 'unknown', playbackPermission: 'unknown', microphones: [], targets: [], problem: 'Build the macOS helper with bun run capture:build on a Mac.' }
  const child = Bun.spawn([helperPath, '--list'], { env: helperEnvironment(), stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 30_000)
  try {
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(error.slice(-2000) || 'Native device enumeration failed. Check macOS permissions.')
    return JSON.parse(output) as CaptureInventory
  } finally { clearTimeout(timer) }
}
interface Options {
  selection: CaptureSelection; delay: Delay
  archives: Archives; transport: TransportFactory
  emit(payload: ServerPayload): void
  boundary?(source: CaptureSourceId, atMs: number): void
  spawnHelper?(): ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>
  expectedRoute?: string
  gains?: CaptureGains
  routeChanged?(route: string): void
  retryDelays?: readonly number[]
}
export const captureRetryDelays = [0, 1000, 2000, 4000] as const
interface Channel {
  transport: TranscriptionTransport | null; gate: ActivityGate; boundary: SpeechBoundary
  sequence: number; endMs: number; audio: CaptureAudioSource; work: Promise<void>; turnStartMs: number | null
  recognitionGap: boolean
}
export class NativeCaptureSession {
  setLanguages(languages: string[]) { for (const channel of Object.values(this.channels)) channel.transport?.setLanguages?.(languages) }
  readonly view: Session
  readonly segments = new Map<string, Segment>()
  private channels: Record<CaptureSourceId, Channel>
  private child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>> | null = null
  private recorder: CaptureRecorder | null = null
  private controller = new AbortController()
  private originHostMs: number | null = null
  private originServerMs: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private finishing: Promise<void> | null = null
  private startWork: Promise<void> = Promise.resolve()
  private readWork: Promise<void> = Promise.resolve()
  private stopping = false
  private failure: Error | null = null
  private created = false
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private attemptOffset = 0
  private gapStart: number | null = null
  private streamReadyAt: number | null = null
  private attempt = 0
  private recoveryController = new AbortController()
  private clippingUntil: Record<CaptureSourceId, number> = { 'local-microphone': 0, 'remote-playback': 0 }
  constructor(private options: Options) {
    const capture: CaptureStatus = {
      sources: Object.fromEntries(captureSources.map(id => [id, { level: 0, receivedMs: 0, sentMs: 0, lagMs: 0, lastAudioMs: null, started: false, audible: false, clipping: false, gainDb: (options.gains ?? defaultCaptureGains())[id] }])) as CaptureStatus['sources'], problems: [], recovery: { state: 'idle', attempt: 0, message: null } }
    this.view = { id: crypto.randomUUID(), source: capturePlaceholder({ selection: options.selection, tracks: [], clock: 'host-monotonic', callTransmission: 'unknown', gains: parseCaptureGains(options.gains) }),
      mode: 'live', delay: options.delay, phase: 'configuring', message: null, capture,
      diagnostics: { mediaMs: 0, sentMs: 0, queuedMs: 0 } }
    this.channels = Object.fromEntries(captureSources.map(id => [id, { transport: null, gate: new ActivityGate(), boundary: new SpeechBoundary(), sequence: -1, endMs: 0, audio: new CaptureAudioSource(), work: Promise.resolve(), turnStartMs: null, recognitionGap: false }])) as typeof this.channels
  }
  get transcriptionHealth() { return { unfinishedTurns: Object.values(this.channels).reduce((n, c) => n + (c.transport?.health?.().unfinishedTurns ?? 0), 0) } }
  private emit(payload: ServerPayload) { isolate('publication', this.view.id, () => this.options.emit(payload)) }
  private publish() { this.emit({ type: 'status', session: structuredClone(this.view) }) }
  private journal(event: CaptureJournalRow['event'], detail: string, sourceId?: CaptureSourceId) {
    if (this.created) isolate('capture-persistence', this.view.id, () => this.options.archives.append(this.view.id, { kind: 'capture', event, detail, atMs: this.view.diagnostics.mediaMs, ...(sourceId ? { sourceId } : {}) }))
  }
  start() { this.startWork = this.run().catch(error => this.fail(error as Error)); return this.startWork }
  private async run() {
    diagnostic('start', { sessionId: this.view.id, workType: 'capture-start' })
    this.publish()
    if (!this.options.spawnHelper && (process.platform !== 'darwin' || !await Bun.file(helperPath).exists())) throw new Error('Build Mant Capture on macOS with bun run capture:build.')
    if (!Bun.which('ffmpeg')) throw new Error('Install FFmpeg before capture so synchronized listening copies can be saved.')
    for (const source of captureSources) this.channels[source].transport = this.options.transport(this.view.id, source, this.view.delay, {
      update: segment => { try { this.update(source, segment) } catch (e) { void this.fail(e as Error) } },
      error: error => { void this.fail(error) },
    })
    await Promise.all(captureSources.map(source => this.channels[source].transport!.ready(this.controller.signal)))
    if (this.stopping) return
    this.options.archives.create(this.view.id, this.view.source); this.created = true
    this.recorder = new CaptureRecorder(this.options.archives, this.view.id)
    this.journal('start', JSON.stringify(this.view.source.capture))
    for (const id of captureSources) this.channels[id].work = this.pump(id).catch(error => { void this.fail(error as Error) })
    this.readWork = this.captureLoop().catch(error => { if (!this.stopping) void this.fail(error as Error) })
  }
  private async captureLoop() {
    while (!this.stopping) {
      let child: typeof this.child = null
      let stderr: Promise<void> = Promise.resolve()
      try {
        child = this.options.spawnHelper?.() ?? Bun.spawn([helperPath], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: helperEnvironment() })
        this.child = child
        child.stdin.write(JSON.stringify(this.options.selection) + '\n'); await child.stdin.flush()
        let errors = ''
        stderr = (async () => { for await (const chunk of child!.stderr) errors = (errors + new TextDecoder().decode(chunk)).slice(-2000) })()
        const parser = new CaptureFrameParser()
        let rejectRead!: (error: Error) => void
        const interrupted = new Promise<never>((_resolve, reject) => { rejectRead = reject })
        this.readyTimer = setTimeout(() => rejectRead(new Error('Capture did not start within 30 seconds. Check macOS permission prompts.')), 30_000)
        const read = (async () => {
          for await (const chunk of child!.stdout) parser.push(chunk, (header, pcm) => this.receive(header, pcm))
          parser.finish()
          const code = await child!.exited; await stderr
          if (!this.stopping) throw new Error(`Capture helper exited (${code}). ${errors || 'Check selected devices and permissions.'}`)
        })()
        try { await Promise.race([read, interrupted]) }
        finally {
          clearTimeout(this.readyTimer!); this.readyTimer = null
          if (!this.stopping) child.kill()
          await Promise.allSettled([read, child.exited, stderr])
        }
        return
      } catch (error) {
        if (child) { child.kill(); await Promise.allSettled([child.exited, stderr]) }
        if (this.stopping) return
        this.child = null
        this.gapStart ??= this.elapsed()
        for (const source of captureSources) {
          const channel = this.channels[source]
          channel.sequence = -1; channel.gate.reset(); channel.boundary = new SpeechBoundary(); channel.turnStartMs = null
          channel.transport?.commit()
          const stats = this.view.capture!.sources[source]
          stats.level = 0; stats.started = false; stats.clipping = false
        }
        this.originHostMs = null
        const delays = this.options.retryDelays ?? captureRetryDelays
        if (this.attempt >= delays.length) {
          this.view.capture!.recovery = { state: 'failed', attempt: this.attempt, message: safeMessage((error as Error).message) }
          throw new Error(`Capture could not reconnect after ${delays.length} attempts. ${(error as Error).message} Retry with the same app and microphone.`)
        }
        const delay = delays[this.attempt++]!
        this.view.capture!.recovery = { state: 'retrying', attempt: this.attempt, message: safeMessage((error as Error).message) }
        this.journal('recovery', JSON.stringify({ attempt: this.attempt, delayMs: delay, message: safeMessage((error as Error).message) }))
        this.publish()
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.recoveryController.signal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, delay)
          this.recoveryController.signal.addEventListener('abort', done, { once: true })
          if (this.recoveryController.signal.aborted) done()
        })
      }
    }
  }
  private receive(header: CaptureFrame | NativeEvent, pcm: Uint8Array) {
    if (this.stopping) return
    if (header.type !== 'audio' && header.routeSignature) this.observeRoute(header.routeSignature)
    if (header.type === 'error' || header.type === 'discontinuity') throw new Error(header.message ?? 'Capture interrupted.')
    if (header.type === 'ready') {
      if (this.originHostMs !== null) throw new Error('Duplicate capture clock origin.')
      clearTimeout(this.readyTimer!); this.readyTimer = null
      diagnostic('ready', { sessionId: this.view.id, workType: 'capture-helper' })
      const startupMs = (header.readyMs ?? header.clockMs!) - header.clockMs!
      this.attemptOffset = this.originServerMs === null ? 0 : Math.max(0, this.elapsed() - startupMs)
      this.originHostMs = header.clockMs!; this.originServerMs ??= performance.now() - startupMs
      this.streamReadyAt = performance.now()
      for (const id of captureSources) this.view.capture!.sources[id].started = true
      if (this.gapStart !== null) { this.journal('gap', `Capture interruption ${Math.max(0, this.elapsed() - this.gapStart).toFixed(1)} ms; missing time retained on both tracks.`); this.gapStart = null }
      this.view.capture!.recovery = { state: 'idle', attempt: this.attempt, message: null }
      this.view.source.replayId = this.view.id
      if (this.view.phase === 'configuring') { this.view.phase = 'ready'; this.publish() }
      this.view.phase = 'running'; this.publish()
      if (this.timer) return
      this.timer = setInterval(() => {
        const now = performance.now()
        if (this.streamReadyAt !== null && now - this.streamReadyAt >= 10_000 && captureSources.every(id => this.view.capture!.sources[id].started)) this.attempt = 0
        this.view.diagnostics.mediaMs = Math.max(this.view.diagnostics.mediaMs, this.elapsed())
        this.view.diagnostics.queuedMs = Math.max(...captureSources.map(id => this.channels[id].audio.queuedBytes / BYTES_PER_MS))
        this.view.diagnostics.sentMs = captureSources.reduce((n, id) => n + this.view.capture!.sources[id].sentMs, 0)
        this.view.capture!.problems = captureSources.flatMap(source => {
          const stats = this.view.capture!.sources[source]
          if (now - (this.originServerMs! + (stats.lastAudioMs ?? 0)) > 3000) stats.level = 0
          return source === 'remote-playback' && this.elapsed() > 5000 && (stats.lastAudioMs === null || this.elapsed() - stats.lastAudioMs > 5000) ? ['Waiting for audio from the selected source.'] : []
        })
        this.publish()
      }, 250)
      return
    }
    if (this.originHostMs === null) throw new Error('Audio arrived before the capture clock.')
    const frame = header as CaptureFrame
    this.view.diagnostics.mediaMs = Math.max(this.view.diagnostics.mediaMs, this.elapsed())
    const channel = this.channels[frame.sourceId]
    let startMs = frame.captureMs - this.originHostMs + this.attemptOffset
    if (startMs < this.attemptOffset) {
      pcm = pcm.subarray(Math.min(pcm.length, Math.ceil((this.attemptOffset - startMs) * 24) * 2))
      startMs = this.attemptOffset
    }
    const endMs = startMs + pcm.length / BYTES_PER_MS
    const lag = this.elapsed() - startMs
    // Pipe delivery can pause during device startup or a busy server turn.
    // Arrival lag is not a capture-clock discontinuity: retain original audio
    // and shed stale recognition work instead of restarting both devices.
    if (lag < -5000) throw new Error(`${frame.sourceId} capture timestamp is ${Math.round(-lag)} ms ahead of the capture clock.`)
    if (frame.sequence !== channel.sequence + 1) throw new Error(`${frame.sourceId} lost or repeated a capture frame.`)
    const discontinuity = channel.endMs > 0 && (channel.sequence < 0 || startMs - channel.endMs > 80)
    if (discontinuity && startMs > channel.endMs) {
      this.journal('gap', `Missing ${(startMs - channel.endMs).toFixed(1)} ms; original timing retained.`, frame.sourceId)
    }
    channel.sequence = frame.sequence; channel.endMs = endMs
    if (!pcm.length) return
    const stats = this.view.capture!.sources[frame.sourceId]
    const adjusted = applyCaptureGain(pcm, stats.gainDb)
    pcm = adjusted.pcm
    if (adjusted.clipping) this.clippingUntil[frame.sourceId] = performance.now() + 1000
    stats.level = adjusted.level; stats.clipping = performance.now() < this.clippingUntil[frame.sourceId]; stats.receivedMs += pcm.length / BYTES_PER_MS; stats.lagMs = Math.max(0, lag)
    if (stats.level >= 0.008) { stats.lastAudioMs = startMs; stats.audible = true }
    this.recorder!.add(frame.sourceId, startMs, pcm)
    if (lag > 1000 || channel.audio.queuedBytes + pcm.length > BYTES_PER_MS * 1000) {
      if (!channel.recognitionGap) this.journal('metrics', `Recognition fell behind; delayed audio retained in the recording. Delivery lag ${Math.round(Math.max(0, lag))} ms.`, frame.sourceId)
      channel.recognitionGap = true
      return
    }
    channel.audio.push(pcm, startMs, discontinuity || channel.recognitionGap)
    channel.recognitionGap = false
  }
  private observeRoute(route: string) {
    const previous = this.view.source.capture!.routeSignature ?? this.options.expectedRoute
    if (previous && route !== previous) {
      this.journal('gap', 'Physical audio route changed. Recording and recognition continue.')
      for (const channel of Object.values(this.channels)) { channel.gate.reset(); channel.transport?.commit() }
    }
    this.view.source.capture!.routeSignature = route
    this.options.routeChanged?.(route)
    if (previous && previous !== route) this.publish()
  }
  private async pump(sourceId: CaptureSourceId) {
    const channel = this.channels[sourceId]
    const stats = this.view.capture!.sources[sourceId]
    for await (const pcm of channel.audio.packets(this.controller.signal)) {
      const startMs = pcm.startMs
      if (pcm.discontinuity) { channel.gate.reset(); channel.transport?.commit(); channel.turnStartMs = null }
      for (let offset = 0; offset < pcm.length; offset += PACKET_BYTES) {
        if (this.controller.signal.aborted) break
        const bytes = pcm.subarray(offset, offset + PACKET_BYTES)
        const start = startMs + offset / BYTES_PER_MS
        const result = channel.gate.push({ pcm: bytes, startMs: start, endMs: start + bytes.length / BYTES_PER_MS })
        if (result.packets.length && channel.turnStartMs === null) {
          channel.turnStartMs = result.packets[0]!.startMs
          if (sourceId === 'local-microphone') { this.journal('local_speech', 'Local capture activity; call transmission unknown.', sourceId); isolate('suggestion-boundary', this.view.id, () => this.options.boundary?.(sourceId, start)) }
        }
        for (const packet of result.packets) {
          await channel.transport!.append(packet.pcm, packet)
          stats.sentMs += packet.pcm.length / BYTES_PER_MS
          if (channel.boundary.add(packet.pcm)) channel.transport!.commit()
        }
        if (result.commit) {
          channel.transport!.commit()
          if (sourceId === 'remote-playback') { const at = start + bytes.length / BYTES_PER_MS - 600; this.journal('turn_end', 'Energy boundary estimate; human review required.', sourceId); isolate('suggestion-boundary', this.view.id, () => this.options.boundary?.(sourceId, at)) }
          channel.turnStartMs = null
        }
      }
    }
  }
  private elapsed() { return this.originServerMs === null ? 0 : performance.now() - this.originServerMs }
  private update(sourceId: CaptureSourceId, segment: Segment) {
    if (this.controller.signal.aborted) return
    const channel = this.channels[sourceId]
    const startMs = segment.capture?.startMs ?? channel.turnStartMs ?? channel.endMs
    const endMs = segment.capture?.endMs ?? channel.endMs
    const id = JSON.stringify([sourceId, segment.id])
    const old = this.segments.get(id)
    const normalized: Segment = { ...segment, id, sourceId, sessionId: this.view.id,
      order: Math.round(startMs * 1000) * 2 + (sourceId === 'remote-playback' ? 1 : 0), revision: Math.max(segment.revision, (old?.revision ?? 0) + 1),
      capture: { startMs, endMs, callTransmission: 'unknown' } }
    this.segments.set(id, normalized)
    const diagnostics = this.view.diagnostics
    if (!this.stopping) diagnostics.mediaMs = Math.max(diagnostics.mediaMs, this.elapsed())
    isolate('transcript-persistence', this.view.id, () => this.options.archives.append(this.view.id, { kind: 'transcript', atMs: diagnostics.mediaMs, receivedElapsedMs: this.elapsed(), tailMs: this.stopping ? Math.max(0, this.elapsed() - diagnostics.mediaMs) : 0, segment: normalized }))
    isolate('transcript-publication', this.view.id, () => this.emit({ type: 'transcript', segment: normalized }))
  }
  clock(_positionMs: number) {} // native host clock is independent of SPA lifetime
  setGains(gains: CaptureGains) {
    if (this.stopping) throw new Error('Capture has finished. Adjust levels in live setup for the next recording.')
    const parsed = parseCaptureGains(gains)
    for (const id of captureSources) this.view.capture!.sources[id].gainDb = parsed[id]
    // Initial levels live in the header; subsequent levels are timestamped events.
    if (!this.created) this.view.source.capture!.gains = parsed
    this.journal('gain', JSON.stringify(parsed)); this.publish()
  }
  stop(_positionMs?: number) { void this.finish() }
  fail(error: Error) { diagnostic('error', { sessionId: this.view.id, workType: 'capture', reason: 'capture-or-recognition-failed' }); this.failure ??= error; return this.finish(error) }
  private finish(error?: Error): Promise<void> {
    if (this.finishing) return this.finishing
    this.stopping = true
    this.recoveryController.abort()
    this.view.diagnostics.mediaMs = Math.max(this.view.diagnostics.mediaMs, this.elapsed(), ...Object.values(this.channels).map(c => c.endMs))
    this.finishing = (async () => {
      if (this.timer) clearInterval(this.timer)
      clearTimeout(this.readyTimer!); this.readyTimer = null
      this.view.phase = 'draining'; this.publish()
      const child = this.child
      const killTimer = child ? setTimeout(() => child.kill(), 1500) : null
      if (child) {
        try { child.stdin.write('stop\n'); await child.stdin.end() } catch { /* An exited helper already released capture. */ }
        await child.exited
      }
      if (killTimer) clearTimeout(killTimer)
      await this.readWork
      await Promise.all(captureSources.map(id => this.channels[id].audio.close()))
      await Promise.all(captureSources.map(id => this.channels[id].work))
      error ??= this.failure ?? undefined
      if (!error) {
        try {
          const results = await Promise.all(captureSources.map(id => this.channels[id].transport?.finish() ?? true))
          if (results.includes(false)) this.view.message = 'Final transcription timed out; partial revisions retained.'
        } catch (e) { error = e as Error }
      }
      this.controller.abort()
      for (const channel of Object.values(this.channels)) channel.transport?.close()
      const durationMs = Math.max(this.view.diagnostics.mediaMs, ...Object.values(this.channels).map(c => c.endMs))
      if (this.created) {
        if (this.gapStart !== null) this.journal('gap', `Capture interruption from ${this.gapStart.toFixed(1)} to ${durationMs.toFixed(1)} ms; missing time retained on both tracks.`)
        if (error) { try { this.journal('failure', safeMessage(error.message)) } catch { /* Retain recovery WAVs even if journaling failed. */ } }
        try {
          if (this.recorder) {
            this.view.source = await this.recorder.save(this.view.source, durationMs)
            this.options.archives.append(this.view.id, { kind: 'capture', event: 'finalized', atMs: durationMs, detail: 'Separate originals and synchronized stereo listening copy saved.', source: this.view.source })
          }
          this.options.archives.append(this.view.id, { kind: 'end', atMs: durationMs, complete: !error })
        } catch { try { this.recorder?.close(durationMs) } catch { /* Retain originals. */ }; this.view.persistenceMessage = 'Recording persistence failed. Transcript delivery continued.'; diagnostic('error', { sessionId: this.view.id, workType: 'persistence', reason: 'capture-finalization-failed' }) }
        try { await this.options.archives.flush(this.view.id) } catch { diagnostic('error', { sessionId: this.view.id, workType: 'persistence', reason: 'finalize-flush-failed' }) }
      }
      this.view.diagnostics.mediaMs = durationMs
      this.view.diagnostics.sentMs = captureSources.reduce((n, id) => n + this.view.capture!.sources[id].sentMs, 0)
      this.view.phase = error ? 'error' : 'ended'
      for (const stats of Object.values(this.view.capture!.sources)) { stats.started = false; stats.level = 0; stats.clipping = false }
      if (!error) this.view.capture!.recovery = { state: 'idle', attempt: 0, message: null }
      if (error) this.view.message = safeMessage(error.message)
      this.emit({ type: 'ended', session: structuredClone(this.view) })
    })()
    return this.finishing
  }
  async shutdown() { this.stopping = true; this.controller.abort(); await this.startWork; await this.finish() }
  async settled() { await this.finishing }
}
