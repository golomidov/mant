import type { AudioSource } from './audio'
import { BYTES_PER_MS, SpeechBoundary } from './audio'
import type { Archives } from './archive'
import type { Delay, Recording, Segment, ServerPayload, Session } from '../shared/protocol'
import { active } from '../shared/protocol'
import type { TranscriptionTransport, TransportFactory } from './transcription'
import { diagnostic, isolate } from './diagnostics'
import { safeMessage } from './errors'

interface SessionOptions {
  source: Recording
  mode: 'live'
  delay: Delay
  audio: AudioSource
  transport: TransportFactory
  archives: Archives
  emit(payload: ServerPayload): void
}

export class ConversationSession {
  readonly view: Session
  readonly segments = new Map<string, Segment>()
  private transport: TranscriptionTransport | null = null
  private controller = new AbortController()
  private wake: (() => void) | null = null
  private stopped = false
  private playbackEndedAt: number | null = null
  private finishing: Promise<void> | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private lastClock = performance.now()
  private beganAt: number | null = null
  private archived = false
  private work: Promise<void> = Promise.resolve()
  private lastStatus = 0

  constructor(private options: SessionOptions) {
    this.view = {
      id: crypto.randomUUID(), source: options.source, mode: options.mode, delay: options.delay, phase: 'configuring', message: null,
      diagnostics: { mediaMs: 0, sentMs: 0, queuedMs: 0 },
    }
  }

  get transcriptionHealth() { return this.transport?.health?.() }
  start() {
    this.work = this.run().catch(error => this.fail(error instanceof Error ? error : new Error('Session failed.')))
    return this.work
  }
  setLanguages(languages: string[]) { this.transport?.setLanguages?.(languages) }

  private emit(payload: ServerPayload) { isolate('publication', this.view.id, () => this.options.emit(payload)) }
  private publish() {
    this.lastStatus = performance.now()
    this.emit({ type: 'status', session: structuredClone(this.view) })
  }

  private update(segment: Segment) {
    if (!active(this.view.phase)) return
    const now = performance.now()
    this.segments.set(segment.id, segment)
    if (this.archived) isolate('transcript-persistence', this.view.id, () => this.options.archives.append(this.view.id, {
      kind: 'transcript', atMs: this.view.diagnostics.mediaMs, receivedElapsedMs: this.elapsed(), segment,
      tailMs: this.playbackEndedAt === null ? 0 : Math.max(0, now - this.playbackEndedAt),
    }))
    isolate('transcript-publication', this.view.id, () => this.emit({ type: 'transcript', segment }))
  }

  private elapsed() { return this.beganAt === null ? 0 : performance.now() - this.beganAt }

  clock(positionMs: number) {
    if (!['ready', 'running'].includes(this.view.phase) || this.stopped) return
    if (positionMs + 100 < this.view.diagnostics.mediaMs) throw new Error('Playback moved backward. Stop and start a new session.')
    const now = performance.now()
    if (this.beganAt === null) {
      if (positionMs > 250) throw new Error('Playback must start at the beginning of the recording.')
      this.beganAt = now - positionMs
    }
    // Reject accelerated clocks/seeking; no future audio can be sent to the provider.
    if (positionMs > this.elapsed() + 200) throw new Error('Playback jumped ahead. Seeking and accelerated playback are unavailable during a session.')
    this.view.phase = 'running'
    this.view.diagnostics.mediaMs = Math.max(this.view.diagnostics.mediaMs, positionMs)
    this.lastClock = now
    this.wake?.()
    if (now - this.lastStatus >= 250) this.publish()
  }

  stop(positionMs = this.view.diagnostics.mediaMs) {
    if (!active(this.view.phase) || this.stopped) return
    if (this.view.phase === 'running' || this.view.phase === 'ready') this.clock(positionMs)
    this.stopped = true
    this.playbackEndedAt = performance.now()
    if (this.view.phase === 'configuring') {
      this.controller.abort()
      void this.finish()
    } else {
      this.view.phase = 'draining'
      this.publish()
      this.wake?.()
    }
  }

  private async waitUntil(positionMs: number): Promise<boolean> {
    while (!this.controller.signal.aborted) {
      if (positionMs <= this.view.diagnostics.mediaMs + 0.01) return true
      if (this.stopped) return false
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = null
    }
    return false
  }

  private async run() {
    this.publish()
    if (this.options.mode === 'live') {
      this.transport = this.options.transport(this.view.id, this.view.source.id, this.options.delay, {
        update: segment => {
          try { this.update(segment) } catch (error) { void this.fail(error as Error) }
        },
        error: error => { void this.fail(error) },
      })
      await this.transport.ready(this.controller.signal)
      if (this.controller.signal.aborted) return
      this.options.archives.create(this.view.id, this.view.source)
      this.archived = true
      this.view.source = { ...this.view.source, replayId: this.view.id }
    } else if (!this.view.source.replayId) throw new Error('No saved transcript exists for this recording. Transcribe it first.')
    if (this.controller.signal.aborted) return
    this.view.phase = 'ready'
    this.publish()
    this.lastClock = performance.now()
    this.watchdog = setInterval(() => {
      const limit = this.view.phase === 'ready' ? 30_000 : 10_000
      if (performance.now() - this.lastClock > limit && !this.stopped) {
        void this.fail(new Error('Playback clock stopped. Resume playback promptly after reconnecting, or start a new session.'))
      }
    }, 500)
    if (!await this.waitUntil(0.1)) { await this.finish(); return }
    {
      const boundary = new SpeechBoundary()
      for await (const packet of this.options.audio.packets(this.controller.signal)) {
        const duration = packet.byteLength / BYTES_PER_MS
        this.view.diagnostics.queuedMs = duration
        const sent = this.view.diagnostics.sentMs
        const allowed = await this.waitUntil(sent + duration)
        if (this.controller.signal.aborted) break
        const remainingBytes = Math.max(0, Math.floor((this.view.diagnostics.mediaMs - sent) * BYTES_PER_MS / 2) * 2)
        const audible = allowed ? packet : packet.subarray(0, remainingBytes)
        if (audible.length) {
          if (this.view.diagnostics.mediaMs - sent > 1000) throw new Error('Audio delivery is over one second behind playback. Stopped to avoid accumulating lag.')
          await this.transport!.append(audible)
          this.view.diagnostics.sentMs += audible.byteLength / BYTES_PER_MS
          if (boundary.add(audible)) this.transport!.commit()
        }
        if (!allowed) break
      }
    }
    await this.finish()
  }

  private finish(): Promise<void> {
    if (this.finishing) return this.finishing
    this.finishing = (async () => {
      if (!active(this.view.phase)) return
      this.view.phase = 'draining'
      this.playbackEndedAt ??= performance.now()
      this.publish()
      let complete = true
      try {
        if (this.transport && !this.controller.signal.aborted) complete = await this.transport.finish()
        if (!active(this.view.phase)) return
        this.view.message = complete ? null : 'Final transcription timed out after 6 seconds. Provisional segments were retained.'
        if (this.archived) this.options.archives.append(this.view.id, { kind: 'end', atMs: this.elapsed(), complete })
        if (this.archived) { try { await this.options.archives.flush(this.view.id) } catch { diagnostic('error', { sessionId: this.view.id, workType: 'persistence', reason: 'finalize-flush-failed' }) } }
        this.view.phase = 'ended'
        await this.cleanup()
        this.emit({ type: 'ended', session: structuredClone(this.view) })
      } catch (error) { await this.fail(error as Error) }
    })()
    return this.finishing
  }

  async fail(error: Error) {
    diagnostic('error', { sessionId: this.view.id, workType: 'transcription', reason: 'session-failed' })
    if (!active(this.view.phase)) return
    this.view.phase = 'error'
    const message = safeMessage(error.message)
    this.view.message = message
    await this.cleanup()
    this.emit({ type: 'error', message })
    this.emit({ type: 'ended', session: structuredClone(this.view) })
  }

  private async cleanup() {
    this.controller.abort()
    this.wake?.()
    this.wake = null
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.transport?.close()
    await this.options.audio.close()
    this.view.diagnostics.queuedMs = 0
  }

  async shutdown() {
    if (active(this.view.phase)) {
      this.stop()
      await this.work
    }
    await this.cleanup()
  }
}
