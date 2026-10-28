import type { Archives } from './archive'
import type { ReplaySpeed, SavedTranscript, Segment, ServerPayload, Session } from '../shared/protocol'
import { active } from '../shared/protocol'
import { safeMessage } from './errors'
import type { AnalysisMode, AnalysisRow, AnalysisState } from '../shared/analysis'
import type { SuggestionState } from '../shared/suggestions'

interface ReplayOptions {
  suggestionMode?: import('../shared/suggestions').SuggestionMode
  suggestion?(row: import('../shared/suggestions').SuggestionRow): void
  startMs?: number
  analysisMode?: AnalysisMode
  analysis?(row: AnalysisRow): void
  transcript?(row: import('./archive').ArchiveUpdate): void
}

// Used to validate replay rates and to time final events after audio ends.
export class ReplayClock {
  private position = 0
  private anchor: number
  constructor(private speed: ReplaySpeed, private now: () => number = () => performance.now(), initialMs = 0) { this.anchor = now(); this.position = initialMs }
  current() { return this.position + (this.now() - this.anchor) * this.speed }
  setSpeed(speed: ReplaySpeed) { this.position = this.current(); this.anchor = this.now(); this.speed = speed }
}

export class TranscriptReplay {
  readonly view: Session
  readonly segments = new Map<string, Segment>()
  private timeline: ReplayClock | null = null
  private tail: ReplayClock | null = null
  private wake: (() => void) | null = null
  private work: Promise<void> = Promise.resolve()
  private stopped = false
  private replaced = false
  private lastReport = performance.now()
  private endedMedia = 0
  private releasedMs = 0
  get availablePositionMs() { return this.releasedMs }

  constructor(private saved: SavedTranscript, private archives: Archives, speed: ReplaySpeed,
    private emit: (payload: ServerPayload) => void, private options: ReplayOptions = {}) {
    this.view = {
      id: crypto.randomUUID(), source: saved.source, mode: 'replay', delay: 'minimal', phase: 'configuring', message: null,
      replay: { archiveId: saved.id, speed, durationMs: saved.durationMs, analysisMode: options.analysisMode ?? 'saved', suggestionMode: options.suggestionMode ?? 'saved' },
      diagnostics: { mediaMs: options.startMs ?? 0, sentMs: 0, queuedMs: 0 },
    }
  }

  start() {
    this.work = this.run().catch(error => this.fail(error instanceof Error ? error : new Error('Transcript replay failed.')))
    return this.work
  }

  // Review loads the final saved state without a playback clock, callbacks,
  // timers, audio requirements or incremental event publication.
  async inspect() {
    let analysis: AnalysisState | null = null
    let suggestions: SuggestionState | null = null
    for await (const row of this.archives.events(this.saved.id)) {
      this.releasedMs = Math.max(this.releasedMs, row.atMs + (row.tailMs ?? 0))
      if (row.kind === 'analysis') { analysis = row.state; continue }
      if (row.kind === 'suggestion') { suggestions = row.state; continue }
      const segment = { ...row.segment, sessionId: this.view.id, sourceId: row.segment.capture ? row.segment.sourceId : this.view.source.id }
      const old = this.segments.get(segment.id)
      if (!old || old.revision < segment.revision) this.segments.set(segment.id, segment)
    }
    this.releasedMs = Math.max(this.releasedMs, this.saved.durationMs)
    this.view.diagnostics.mediaMs = this.saved.durationMs
    this.view.phase = 'ended'
    this.view.replay!.review = true
    return { analysis, suggestions }
  }

  private publish() { this.emit({ type: 'status', session: structuredClone(this.view) }) }

  setSpeed(speed: ReplaySpeed, positionMs?: number) {
    if (['ended', 'error'].includes(this.view.phase)) return
    if (positionMs !== undefined && active(this.view.phase) && !this.tail) this.clock(positionMs)
    // Rebase validation at the audio position, so pausing or changing rate adds no wall-clock credit.
    if (this.timeline) this.timeline = new ReplayClock(speed, undefined, this.view.diagnostics.mediaMs)
    this.tail?.setSpeed(speed)
    this.view.replay!.speed = speed
    this.wake?.()
    this.publish()
  }

  clock(positionMs: number) {
    if (!active(this.view.phase) || this.stopped || this.tail) return
    if (!this.timeline) {
      if (Math.abs(positionMs - this.view.diagnostics.mediaMs) > 250 * this.view.replay!.speed) throw new Error('Replay position jumped. Resume at the paused position.')
      this.timeline = new ReplayClock(this.view.replay!.speed, undefined, this.view.diagnostics.mediaMs)
    }
    if (positionMs + 100 < this.view.diagnostics.mediaMs || positionMs > this.timeline.current() + 250 * this.view.replay!.speed) {
      throw new Error('Replay position jumped. Stop and start again from the beginning.')
    }
    this.view.diagnostics.mediaMs = Math.max(this.view.diagnostics.mediaMs, positionMs)
    this.view.phase = 'running'
    this.lastReport = performance.now()
    this.wake?.()
  }

  endPlayback(positionMs: number) {
    if (!active(this.view.phase) || this.stopped) return
    this.clock(positionMs)
    this.endedMedia = this.view.diagnostics.mediaMs
    this.tail = new ReplayClock(this.view.replay!.speed)
    this.view.phase = 'draining'
    this.publish()
    this.wake?.()
  }

  stop(positionMs = this.view.diagnostics.mediaMs) {
    if (!active(this.view.phase)) return
    if (!this.tail) this.clock(positionMs)
    this.view.phase = 'paused'
    this.timeline = null
    this.tail = null
    this.wake?.()
    this.publish()
  }

  resume(speed: ReplaySpeed) {
    if (this.view.phase !== 'paused') return
    this.view.replay!.speed = speed
    this.timeline = null
    this.lastReport = performance.now()
    this.view.phase = 'ready'
    this.wake?.()
    this.publish()
  }

  private async waitUntil(positionMs: number, transcript = true): Promise<boolean> {
    while (!this.stopped) {
      if (this.view.phase === 'paused') {
        await new Promise<void>(resolve => { this.wake = () => { this.wake = null; resolve() } })
        continue
      }
      const current = this.tail ? this.endedMedia + this.tail.current() : this.view.diagnostics.mediaMs
      if (current >= positionMs && this.timeline) return true
      if (!this.tail && performance.now() - this.lastReport > (this.view.phase === 'ready' ? 30_000 : 10_000)) throw new Error('Replay playback stopped reporting. Resume playback or start replay again.')
      if (transcript && this.tail && positionMs > this.endedMedia + 60_000) throw new Error('Transcript events extend more than 60 seconds beyond the original audio. Check that this is the matching recording.')
      if (this.view.phase !== 'ready') this.publish()
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.wake = null; resolve() }
        const timer = setTimeout(finish, this.tail ? Math.min(250, Math.max(1, (positionMs - current) / this.view.replay!.speed)) : 250)
        this.wake = finish
      })
    }
    return false
  }

  private async run() {
    this.publish()
    this.view.phase = 'ready'
    this.publish()
    let lastPosition = 0
    for await (const row of this.archives.events(this.saved.id)) {
      const due = row.atMs + (row.tailMs ?? 0)
      lastPosition = Math.max(lastPosition, due)
      if (lastPosition > (this.options.startMs ?? -1) && !await this.waitUntil(lastPosition, row.kind === 'transcript' && lastPosition === due)) break
      if (this.stopped) break
      this.releasedMs = lastPosition
      if (row.kind === 'suggestion') { this.options.suggestion?.(row); continue }
      if (row.kind === 'analysis') { this.options.analysis?.(row); continue }
      const segment = { ...row.segment, sessionId: this.view.id, sourceId: row.segment.capture ? row.segment.sourceId : this.view.source.id }
      const old = this.segments.get(segment.id)
      if (old && old.revision >= segment.revision) continue
      this.segments.set(segment.id, segment)
      this.emit({ type: 'transcript', segment, mediaMs: due })
      this.options.transcript?.({ ...row, segment })
    }
    // An incomplete journal covers only part of its original recording.
    // Finish at the last saved event instead of playing the untranscribed remainder.
    if (!this.stopped) await this.waitUntil(this.saved.durationMs, false)
    if (['error', 'ended'].includes(this.view.phase)) return
    this.view.phase = 'ended'
    if (!this.replaced) this.emit({ type: 'ended', session: structuredClone(this.view) })
  }

  async fail(error: Error) {
    if (['ended', 'error'].includes(this.view.phase)) return
    this.stopped = true
    this.wake?.()
    this.view.phase = 'error'
    this.view.message = safeMessage(error.message)
    this.emit({ type: 'error', message: this.view.message })
    this.emit({ type: 'ended', session: structuredClone(this.view) })
  }

  async shutdown(replaced = false) { this.replaced = replaced; this.stopped = true; this.wake?.(); await this.work }
}
