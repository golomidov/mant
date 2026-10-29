import type { Segment } from '../shared/protocol'
import type { TranscriptionTransport, TransportCallbacks } from './transcription'
import { credential, type BackendConnection } from './backend-settings'
import { appleRequest } from './apple-ai'
import { usageLedger } from './usage'
export function pcmWav(pcm: Uint8Array, sampleRate = 24000) {
  const result = Buffer.alloc(44 + pcm.length)
  result.write('RIFF'); result.writeUInt32LE(36 + pcm.length, 4); result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * 2, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(pcm.length, 40); result.set(pcm, 44)
  return result
}
export function pcm16k(pcm: Uint8Array) {
  const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const result = Buffer.alloc(Math.floor(pcm.length / 3) * 2)
  for (let i = 0; i < result.length / 2; i++) {
    const at = i * 1.5, left = Math.floor(at), right = Math.min(left + 1, pcm.length / 2 - 1), fraction = at - left
    result.writeInt16LE(Math.round(input.getInt16(left * 2, true) * (1 - fraction) + input.getInt16(right * 2, true) * fraction), i * 2)
  }
  return result
}
export function removeOverlap(previous: string, current: string) {
  const a = previous.trim().split(/\s+/), b = current.trim().split(/\s+/)
  const normalize = (s: string) => s.toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, '')
  for (let n = Math.min(a.length, b.length, 40); n > 0; n--) if (a.slice(-n).map(normalize).join(' ') === b.slice(0, n).map(normalize).join(' ')) return b.slice(n).join(' ')
  return current.trim()
}
// Five-second windows, one second of acoustic overlap, one serial request.
// Queue is bounded independently for each capture source; timeout cancels HTTP
// and suppresses late publication even when a server ignores cancellation.
export class WindowedTranscription implements TranscriptionTransport {
  private controller = new AbortController()
  private buffer = Buffer.alloc(0)
  private overlap = Buffer.alloc(0)
  private queuedBytes = 0
  private chain = Promise.resolve()
  private closed = false
  private failed = false
  private stopped = false
  private count = 0
  private previous = ''
  private nextStart: number | null = null
  private languages: string[]
  private abortCleanup = () => {}
  constructor(private sessionId: string, private sourceId: string, private callbacks: TransportCallbacks, private connection: BackendConnection, languages: string[], private request: typeof fetch = fetch) { this.languages = languages }
  async ready(signal: AbortSignal) {
    if (signal.aborted) throw new Error('Transcription cancelled.')
    const abort = () => this.close()
    signal.addEventListener('abort', abort, { once: true }); this.abortCleanup = () => signal.removeEventListener('abort', abort)
    if (this.connection.provider === 'apple-speech') {
      if (this.languages.length !== 1) throw new Error('Apple Speech requires one explicit conversation language. Select it before starting transcription.')
      const result = await appleRequest({ action: 'check', engine: 'speech', languages: this.languages }, this.controller.signal) as { available: boolean; issue?: string }
      if (!result.available) throw new Error(result.issue ?? 'Apple Speech unavailable; install language assets.')
    } else {
      credential(this.connection)
      const response = await this.request(new URL('/health', this.connection.endpoint), { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]) })
      if (!response.ok) throw new Error(`whisper.cpp health check failed (${response.status}). Start whisper-server with a multilingual model.`)
    }
  }
  setLanguages(languages: string[]) {
    if (JSON.stringify(languages) === JSON.stringify(this.languages)) return
    this.commit(); this.overlap = Buffer.alloc(0); this.languages = [...languages]
  }
  health() { return { unfinishedTurns: Number(this.queuedBytes > 0), bufferedBytes: this.queuedBytes + this.buffer.length } }
  async append(pcm: Uint8Array, timing?: { startMs: number; endMs: number }) {
    if (this.closed || this.failed || this.stopped) throw new Error('Local transcription is not writable.')
    if (pcm.length % 2) throw new Error('Incomplete PCM16 sample.')
    if (this.queuedBytes + this.buffer.length + pcm.length > 48000 * 20) throw new Error('Local transcription backlog exceeds 20 seconds. Use a faster model.')
    this.nextStart ??= timing?.startMs ?? 0
    this.buffer = Buffer.concat([this.buffer, pcm])
    while (this.buffer.length >= 240000) this.enqueue(240000)
  }
  commit() { if (this.buffer.length) this.enqueue(this.buffer.length) }
  private enqueue(bytes: number) {
    const fresh = this.buffer.subarray(0, bytes), overlapBytes = this.overlap.length
    const pcm = Buffer.concat([this.overlap, fresh])
    this.buffer = this.buffer.subarray(bytes)
    const startMs = (this.nextStart ?? 0) - overlapBytes / 48, endMs = (this.nextStart ?? 0) + bytes / 48
    this.nextStart = endMs; this.overlap = Buffer.from(fresh.subarray(Math.max(0, fresh.length - 48000)))
    const id = this.count++, languages = [...this.languages]
    this.queuedBytes += pcm.length
    this.chain = this.chain.then(async () => {
      if (this.closed || this.failed) return
      let text: string
      if (this.connection.provider === 'apple-speech') {
        const result = await appleRequest({ action: 'transcribe', wav: pcmWav(pcm).toString('base64'), languages }, this.controller.signal) as { text: string }
        text = result.text
      } else {
        const form = new FormData()
        form.set('file', new Blob([pcmWav(pcm16k(pcm), 16000)]), 'audio.wav'); form.set('response_format', 'verbose_json'); form.set('language', languages.length === 1 ? languages[0]! : 'auto'); form.set('temperature', '0')
        const key = this.connection.credentialEnv ? credential(this.connection) : null
        const response = await this.request(this.connection.endpoint!, { method: 'POST', body: form, headers: key ? { Authorization: `Bearer ${key}` } : undefined, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]) })
        if (!response.ok) throw new Error(`whisper.cpp inference failed (${response.status}). Check server model and /inference endpoint.`)
        const result = await response.json() as { text?: string }
        if (typeof result.text !== 'string') throw new Error('Malformed whisper.cpp output: text is missing.')
        text = result.text
      }
      if (typeof text !== 'string' || text.length > 24000) throw new Error('Malformed local transcription output.')
      if (this.closed || this.failed) return
      const reconciled = overlapBytes ? removeOverlap(this.previous, text) : text.trim()
      this.previous = text
      usageLedger.audio(this.sessionId, bytes / 48000, 'local')
      if (!reconciled) return
      const segment: Segment = { id: JSON.stringify([this.connection.provider, id]), sessionId: this.sessionId, sourceId: this.sourceId, order: id * 1000, revision: 1, status: 'final', text: reconciled, capture: { startMs: Math.max(0, startMs + overlapBytes / 48), endMs, callTransmission: 'unknown' } }
      this.callbacks.update(segment)
    }).catch(error => {
      if (this.closed || this.failed) return
      this.failed = true; this.controller.abort(); this.callbacks.error(error instanceof Error ? error : new Error('Local transcription failed.'))
    }).finally(() => { this.queuedBytes -= pcm.length })
  }
  async finish(timeoutMs = 6000) {
    if (!this.stopped) { this.commit(); this.stopped = true }
    let timer: ReturnType<typeof setTimeout> | undefined
    const complete = await Promise.race([this.chain.then(() => !this.failed && !this.closed), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })])
    clearTimeout(timer)
    if (!complete) this.close()
    return complete
  }
  close() { this.closed = true; this.abortCleanup(); this.controller.abort(); this.buffer = Buffer.alloc(0); this.overlap = Buffer.alloc(0) }
}
