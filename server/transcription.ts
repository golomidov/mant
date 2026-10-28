import type { Delay, Segment } from '../shared/protocol'
import { TranscriptState } from './reconcile'
import { usageLedger } from './usage'
import { diagnostic, providerMetadata } from './diagnostics'
import { safeMessage } from './errors'
import { recognitionLanguages } from '../shared/languages'

export interface TranscriptionTransport {
  ready(signal: AbortSignal): Promise<void>
  append(pcm: Uint8Array, timing?: { startMs: number; endMs: number }): Promise<void>
  commit(): void
  finish(timeoutMs?: number): Promise<boolean>
  close(): void
  setLanguages?(languages: string[]): void
  health?(): { unfinishedTurns: number; bufferedBytes: number }
}

export interface TransportCallbacks {
  update(segment: Segment): void
  error(error: Error): void
}

export type TransportFactory = (sessionId: string, sourceId: string, delay: Delay, callbacks: TransportCallbacks) => TranscriptionTransport
type SocketFactory = (url: string, options: { headers: Record<string, string> }) => WebSocket

export class OpenAITranscription implements TranscriptionTransport {
  private socket: WebSocket | null = null
  private state: TranscriptState
  private pending = 0
  private uncommittedBytes = 0
  private closed = false
  private settleReady: ((error?: Error) => void) | null = null
  private wakeFinish: (() => void) | null = null
  private seenEvents = new Set<string>()
  private completedItems = new Set<string>()
  private captureSpan: { startMs: number; endMs: number } | null = null
  private committedSpans: { startMs: number; endMs: number }[] = []
  private connectionId = crypto.randomUUID()
  private itemSpans = new Map<string, { startMs: number; endMs: number }>()

  constructor(private sessionId: string, private sourceId: string, private delay: Delay, private callbacks: TransportCallbacks,
    private connect: SocketFactory = (url, options) => new WebSocket(url, options), private languages: string[] = recognitionLanguages('')) {
    this.state = new TranscriptState(sessionId, sourceId)
  }

  ready(signal: AbortSignal): Promise<void> {
    const key = process.env.OPENAI_API_KEY
    if (!key) return Promise.reject(new Error('OPENAI_API_KEY is missing from the server environment. Set it and restart the server.'))
    if (signal.aborted) return Promise.reject(new Error('Session stopped.'))
    const startedAt = performance.now()
    diagnostic('start', { sessionId: this.sessionId, sourceId: this.sourceId, workType: 'recognition-start', requestId: this.connectionId })
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => done(new Error('OpenAI session configuration timed out after 15 seconds.')), 15_000)
      const abort = () => done(new Error('Session stopped.'))
      const done = (error?: Error) => {
        if (settled) return
        settled = true
        diagnostic(error ? signal.aborted ? 'cancel' : 'error' : 'finish', { sessionId: this.sessionId, sourceId: this.sourceId, workType: 'recognition-start', requestId: this.connectionId, durationMs: performance.now() - startedAt, ...providerMetadata(error) })
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.settleReady = null
        if (error) reject(error)
        else resolve()
      }
      this.settleReady = done
      signal.addEventListener('abort', abort, { once: true })
      let socket: WebSocket
      try {
        socket = this.connect('wss://api.openai.com/v1/realtime?intent=transcription', { headers: { Authorization: `Bearer ${key}` } })
      } catch (error) { done(new Error(safeMessage(error instanceof Error ? error.message : 'Unable to connect to OpenAI.'))); return }
      this.socket = socket
      socket.onopen = () => this.configure()
      socket.onmessage = event => {
        try { this.receive(JSON.parse(String(event.data)) as Record<string, unknown>) }
        catch (error) { this.fail(error instanceof Error ? error : new Error('Invalid provider event.')) }
      }
      socket.onerror = event => {
        const detail = 'message' in event ? String(event.message) : 'connection or authentication failed'
        this.fail(new Error(`OpenAI WebSocket error: ${detail}`))
      }
      socket.onclose = event => {
        if (!this.closed) this.fail(new Error(`OpenAI disconnected (${event.code}): ${event.reason || 'Check credentials, model access, and network.'}`))
      }
    })
  }

  private configure() {
    this.send({ type: 'session.update', session: { type: 'transcription', audio: { input: {
      format: { type: 'audio/pcm', rate: 24000 },
      transcription: { model: 'gpt-live-transcribe', languages: this.languages, delay: this.delay },
      turn_detection: null,
    } } } })
  }
  setLanguages(languages: string[]) {
    if (JSON.stringify(this.languages) === JSON.stringify(languages)) return
    this.languages = [...languages]
    if (this.socket?.readyState === WebSocket.OPEN) this.configure()
  }

  health() { return { unfinishedTurns: this.pending, bufferedBytes: this.socket?.bufferedAmount ?? 0 } }
  private fail(error: Error) {
    if (this.closed) return
    diagnostic('error', { sessionId: this.sessionId, sourceId: this.sourceId, workType: 'transcription', ...providerMetadata(error), reason: 'provider-failure' })
    error = new Error(safeMessage(error.message))
    this.settleReady?.(error)
    this.callbacks.error(error)
    this.wakeFinish?.()
  }

  private receive(event: Record<string, unknown>) {
    if (this.closed) return
    if (typeof event.event_id === 'string') {
      if (this.seenEvents.has(event.event_id)) return
      this.seenEvents.add(event.event_id)
      if (this.seenEvents.size > 2048) this.seenEvents.delete(this.seenEvents.values().next().value!)
    }
    if (event.type === 'error') {
      const error = event.error as { message?: string; code?: string } | undefined
      diagnostic('provider-error', { sessionId: this.sessionId, sourceId: this.sourceId, workType: 'transcription', ...providerMetadata(error), providerRequestId: typeof event.event_id === 'string' ? event.event_id : undefined })
      this.fail(new Error(`OpenAI ${error?.code ?? 'error'}: ${error?.message ?? 'Unknown provider error'}`))
    } else if (event.type === 'session.updated') {
      const session = event.session as { type?: string; audio?: { input?: { transcription?: { model?: string; delay?: string }; turn_detection?: unknown; format?: { type?: string; rate?: number } } } } | undefined
      const input = session?.audio?.input
      if (session?.type !== 'transcription' || input?.transcription?.model !== 'gpt-live-transcribe' ||
          // The live service may acknowledge an update without echoing delay.
          (input.transcription.delay !== undefined && input.transcription.delay !== this.delay) || input.turn_detection != null ||
          input.format?.type !== 'audio/pcm' || input.format.rate !== 24000) {
        const confirmed = { type: session?.type, model: input?.transcription?.model, delay: input?.transcription?.delay,
          turn_detection: input?.turn_detection, format: input?.format }
        this.fail(new Error(`OpenAI did not confirm the requested gpt-live-transcribe PCM24k configuration and delay. Received: ${JSON.stringify(confirmed)}`))
      } else this.settleReady?.()
    } else if (event.type === 'input_audio_buffer.committed' && typeof event.item_id === 'string') {
      const span = this.committedSpans.shift()
      if (span) this.itemSpans.set(event.item_id, span)
      const previous = typeof event.previous_item_id === 'string' ? event.previous_item_id : null
      for (const segment of this.state.committed(event.item_id, previous)) this.deliver(segment, (JSON.parse(segment.id) as [string, number])[0])
    } else if (typeof event.item_id === 'string' && typeof event.content_index === 'number') {
      const final = event.type === 'conversation.item.input_audio_transcription.completed'
      const delta = event.type === 'conversation.item.input_audio_transcription.delta'
      if (final || delta) {
        const text = final ? event.transcript : event.delta
        if (typeof text !== 'string') throw new Error('Provider transcription text is missing.')
        for (const segment of this.state.update(event.item_id, event.content_index, text, final)) this.deliver(segment, event.item_id)
        if (final && !this.completedItems.has(event.item_id)) {
          this.completedItems.add(event.item_id)
          this.pending = Math.max(0, this.pending - 1)
          this.wakeFinish?.()
        }
      } else if (event.type === 'conversation.item.input_audio_transcription.failed') {
        const error = event.error as { message?: string } | undefined
        diagnostic('provider-error', { sessionId: this.sessionId, sourceId: this.sourceId, workType: 'transcription', ...providerMetadata(error) })
        this.fail(new Error(`OpenAI transcription failed: ${error?.message ?? 'Unknown error'}`))
      }
    }
  }

  private deliver(segment: Segment, itemId: string) {
    const span = this.itemSpans.get(itemId) ?? this.committedSpans[0] ?? this.captureSpan
    this.callbacks.update(span ? { ...segment, capture: { ...span, callTransmission: 'unknown' } } : segment)
  }

  private send(event: object) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('OpenAI connection is not open.')
    this.socket.send(JSON.stringify(event))
  }

  async append(pcm: Uint8Array, timing?: { startMs: number; endMs: number }) {
    if (!this.socket || this.socket.bufferedAmount > 64_000) throw new Error('OpenAI audio backpressure exceeded 64 KB. Stopped to avoid an increasing backlog.')
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') })
    this.uncommittedBytes += pcm.byteLength
    if (timing) this.captureSpan = { startMs: this.captureSpan?.startMs ?? timing.startMs, endMs: timing.endMs }
  }

  commit() {
    if (!this.uncommittedBytes) return
    if (this.pending >= 16) throw new Error('OpenAI has 16 unfinished turns. Stopped instead of building an invisible transcription backlog.')
    // Realtime requires at least 100ms per commit; pad only the terminal short tail.
    if (this.uncommittedBytes < 4800) {
      this.send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800 - this.uncommittedBytes).toString('base64') })
    }
    this.send({ type: 'input_audio_buffer.commit' })
    if (this.captureSpan) this.committedSpans.push(this.captureSpan)
    this.captureSpan = null
    usageLedger.audio(this.sessionId, Math.max(4800, this.uncommittedBytes) / 48000)
    this.uncommittedBytes = 0
    this.pending++
  }

  async finish(timeoutMs = 6000): Promise<boolean> {
    this.commit()
    if (!this.pending) return true
    return new Promise(resolve => {
      const timer = setTimeout(() => done(false), timeoutMs)
      const done = (complete: boolean) => { clearTimeout(timer); this.wakeFinish = null; resolve(complete) }
      this.wakeFinish = () => { if (this.pending === 0 || this.closed) done(this.pending === 0) }
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.settleReady?.(new Error('Session closed.'))
    this.wakeFinish?.()
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null
      this.socket.close()
      this.socket = null
    }
  }
}
