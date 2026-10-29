import type { Segment } from '../shared/protocol'
import type { TranscriptionTransport, TransportCallbacks } from './transcription'
import { credential, type BackendConnection } from './backend-settings'
import { safeMessage } from './errors'
import { usageLedger } from './usage'

type Connect = (url: string, options: { headers: Record<string, string> }) => WebSocket
export class DeepgramTranscription implements TranscriptionTransport {
  private socket: WebSocket | null = null
  private closed = false
  private draining = false
  private drained = false
  private failed = false
  private finalMetadata = false
  private multilingual = false
  private bytes = 0
  private origin: number | null = null
  private segments = new Map<number, Segment>()
  private settleReady?: (error?: Error) => void
  private wake?: () => void
  private keepAlive?: ReturnType<typeof setInterval>
  constructor(private sessionId: string, private sourceId: string, private callbacks: TransportCallbacks, private connection: BackendConnection, private languages: string[], private connect: Connect = (url, options) => new WebSocket(url, options)) {}
  ready(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('Transcription cancelled.'))
    const key = credential(this.connection)
    this.multilingual = this.languages.length > 1
    const url = new URL(this.connection.endpoint ?? 'wss://api.deepgram.com/v1/listen')
    url.search = new URLSearchParams({ model: this.connection.model ?? 'nova-3', encoding: 'linear16', sample_rate: '24000', channels: '1', interim_results: 'true', punctuate: 'true', language: this.languages.length === 1 ? this.languages[0]! : 'multi' }).toString()
    return new Promise((resolve, reject) => {
      let settled = false
      const abort = () => { done(new Error('Transcription cancelled.')); this.close() }
      const timer = setTimeout(() => { done(new Error('Deepgram connection timed out.')); this.close() }, 15_000)
      const done = (error?: Error) => {
        if (settled) return
        settled = true; clearTimeout(timer); this.settleReady = undefined
        if (error) { signal.removeEventListener('abort', abort); reject(error) } else resolve()
      }
      this.settleReady = done
      // Keep cancellation connected after readiness, until close.
      signal.addEventListener('abort', abort, { once: true })
      this.cleanup = () => signal.removeEventListener('abort', abort)
      try {
        const socket = this.socket = this.connect(url.toString(), { headers: { Authorization: `Token ${key}` } })
        socket.onopen = () => { done(); this.keepAlive = setInterval(() => { if (!this.draining && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'KeepAlive' })) }, 3000) }
        socket.onmessage = event => { try { this.receive(JSON.parse(String(event.data))) } catch (error) { this.fail(error) } }
        socket.onerror = () => this.fail(new Error('Deepgram connection failed. Check credentials and network.'))
        socket.onclose = event => {
          if (this.draining && !this.failed && this.finalMetadata && event.code === 1000) { this.drained = true; this.wake?.() }
          else if (!this.closed) this.fail(new Error('Deepgram disconnected before final draining.'))
        }
      } catch (error) { done(error instanceof Error ? error : new Error('Deepgram connection failed.')); this.close() }
    })
  }
  private cleanup = () => {}
  private fail(error: unknown) {
    if (this.closed || this.failed) return
    this.failed = true
    const safe = new Error(safeMessage(error instanceof Error ? error.message : 'Invalid Deepgram event.'))
    this.settleReady?.(safe); this.callbacks.error(safe); this.wake?.()
  }
  private receive(event: Record<string, any>) {
    if (this.closed || this.failed) return
    if (event.type === 'Error' || event.err_code) throw new Error(`Deepgram: ${event.description ?? event.err_msg ?? 'provider failure'}`)
    if (event.type === 'Metadata' && this.draining) this.finalMetadata = true
    if (event.type !== 'Results') return
    const text = event.channel?.alternatives?.[0]?.transcript
    if (typeof text !== 'string' || !Number.isFinite(event.start) || !Number.isFinite(event.duration)) throw new Error('Malformed Deepgram transcript.')
    const start = Math.round(event.start * 1000), end = start + Math.round(event.duration * 1000)
    const old = this.segments.get(start)
    if ((!text.trim() && !old) || old?.status === 'final') return
    const segment: Segment = { sessionId: this.sessionId, sourceId: this.sourceId, id: JSON.stringify(['deepgram', start]), order: start, revision: (old?.revision ?? 0) + 1, text, status: event.is_final ? 'final' : 'partial', capture: { startMs: (this.origin ?? 0) + start, endMs: (this.origin ?? 0) + end, callTransmission: 'unknown' } }
    this.segments.set(start, segment); this.callbacks.update(segment)
  }
  async append(pcm: Uint8Array, timing?: { startMs: number; endMs: number }) {
    if (this.closed || this.failed || this.draining || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Deepgram connection is not writable.')
    if (this.socket.bufferedAmount > 64_000) throw new Error('Deepgram audio backpressure exceeded 64 KB.')
    if (this.origin === null && timing) this.origin = timing.startMs
    this.socket.send(pcm); this.bytes += pcm.byteLength
  }
  commit() { if (this.socket?.readyState === WebSocket.OPEN && !this.draining && this.bytes) this.socket.send(JSON.stringify({ type: 'Finalize' })) }
  setLanguages(languages: string[]) {
    if (this.multilingual) { this.languages = [...languages]; return }
    if (JSON.stringify(languages) !== JSON.stringify(this.languages)) this.fail(new Error('Deepgram language configuration changed. Stop and restart transcription to apply it; no audio was silently reassigned.'))
  }
  health() { return { unfinishedTurns: [...this.segments.values()].filter(s => s.status === 'partial').length + Number(this.draining && !this.drained), bufferedBytes: this.socket?.bufferedAmount ?? 0 } }
  async finish(timeoutMs = 6000) {
    if (this.closed || this.failed) return false
    if (!this.draining) {
      this.draining = true; clearInterval(this.keepAlive)
      this.socket?.send(JSON.stringify({ type: 'CloseStream' }))
      usageLedger.audio(this.sessionId, this.bytes / 48000, 'deepgram')
    }
    if (this.drained) return true
    return new Promise<boolean>(resolve => {
      const done = () => { clearTimeout(timer); this.wake = undefined; resolve(this.drained && !this.failed) }
      const timer = setTimeout(done, timeoutMs); this.wake = done
    })
  }
  close() {
    if (this.closed) return
    this.closed = true; clearInterval(this.keepAlive); this.cleanup(); this.settleReady?.(new Error('Deepgram session closed.')); this.wake?.()
    if (this.socket) { this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null; this.socket.close(); this.socket = null }
  }
}
