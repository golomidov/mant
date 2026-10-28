import { BYTES_PER_MS, type AudioSource } from './audio'
import type { CaptureFrame, CaptureSourceId, NativeEvent } from '../shared/capture'
import { captureSources } from '../shared/capture'

// stdout is exclusively [u32LE JSON length, u32LE PCM length, JSON, PCM].
export class CaptureFrameParser {
  private pending = Buffer.alloc(0)
  push(chunk: Uint8Array, receive: (header: CaptureFrame | NativeEvent, pcm: Uint8Array) => void) {
    if (chunk.length > 1_048_576) throw new Error('Native IPC read exceeded 1 MB.')
    this.pending = Buffer.concat([this.pending, chunk])
    while (this.pending.length >= 8) {
      const json = this.pending.readUInt32LE(0), audio = this.pending.readUInt32LE(4)
      if (!json || json > 16_384 || audio > 192_000) throw new Error('Invalid native frame length.')
      const length = 8 + json + audio
      if (this.pending.length < length) break
      const value = JSON.parse(this.pending.subarray(8, 8 + json).toString()) as Record<string, unknown>
      if (value.readyMs !== undefined && (!Number.isFinite(value.readyMs) || Number(value.readyMs) < Number(value.clockMs) || Number(value.readyMs) - Number(value.clockMs) > 30_000)) throw new Error('Invalid native startup clock.')
      if (value.routeSignature !== undefined && (typeof value.routeSignature !== 'string' || value.routeSignature.length > 2000)) throw new Error('Invalid native route metadata.')
      const pcm = this.pending.subarray(8 + json, length)
      if (value.type === 'audio') {
        if (!captureSources.includes(value.sourceId as CaptureSourceId) || value.sampleRate !== 24000 || value.channels !== 1 || value.format !== 'pcm_s16le' ||
          !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || !Number.isFinite(value.captureMs) || Number(value.captureMs) < 0 || !Number.isInteger(value.frames) || Number(value.frames) <= 0 || Number(value.frames) * 2 !== pcm.length) throw new Error('Invalid native PCM metadata.')
      } else if (!['ready', 'error', 'discontinuity'].includes(String(value.type)) || audio || (value.message !== undefined && typeof value.message !== 'string') || (value.type === 'ready' && !Number.isFinite(value.clockMs))) throw new Error('Invalid native control frame.')
      receive(value as unknown as CaptureFrame | NativeEvent, pcm)
      this.pending = this.pending.subarray(length)
    }
  }
  finish() { if (this.pending.length) throw new Error('Native capture ended inside a frame.') }
}
export const pcmLevel = (pcm: Uint8Array) => {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let energy = 0
  for (let i = 0; i < pcm.length; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2
  return Math.sqrt(energy / Math.max(1, pcm.length / 2))
}
// One capture gain stage feeds the recording, activity gate and recognizer.
export function applyCaptureGain(input: Uint8Array, gainDb: number) {
  const pcm = new Uint8Array(input.length)
  const from = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const to = new DataView(pcm.buffer)
  const factor = 10 ** (gainDb / 20)
  let clipping = false
  for (let i = 0; i < input.length; i += 2) {
    const sample = from.getInt16(i, true) * factor
    clipping ||= sample >= 32767 || sample <= -32768
    to.setInt16(i, Math.max(-32768, Math.min(32767, Math.round(sample))), true)
  }
  return { pcm, clipping, level: pcmLevel(pcm) }
}
export interface TimedPcm { pcm: Uint8Array; startMs: number; endMs: number }
export type CapturedPacket = Uint8Array & { startMs: number; discontinuity: boolean }
// Same pull interface as file decoding, with bounded native push admission.
export class CaptureAudioSource implements AudioSource {
  private queue: CapturedPacket[] = []
  private ended = false
  private wake: (() => void) | null = null
  queuedBytes = 0
  push(pcm: Uint8Array, startMs: number, discontinuity = false) {
    if (this.ended) return
    if (this.queuedBytes + pcm.length > 48_000) throw new Error('Native recognition queue exceeded one second.')
    const packet = Object.assign(new Uint8Array(pcm), { startMs, discontinuity })
    this.queuedBytes += packet.length; this.queue.push(packet); this.wake?.()
  }
  async *packets(signal: AbortSignal): AsyncGenerator<CapturedPacket> {
    const abort = () => this.wake?.()
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        const packet = this.queue.shift()
        if (packet) {
          try { yield packet } finally { this.queuedBytes -= packet.length }
        } else if (this.ended) return
        else await new Promise<void>(resolve => { this.wake = resolve })
      }
    } finally { signal.removeEventListener('abort', abort); this.queue = []; this.queuedBytes = 0; this.wake = null }
  }
  async close() { this.ended = true; this.wake?.() }
}
// Recognition only: recordings always receive all original frames. Never compare
// the channels here: overlapping speech must not be discarded as echo.
export class ActivityGate {
  private preRoll: TimedPcm[] = []
  private active = false
  private quietMs = 0
  push(packet: TimedPcm): { packets: TimedPcm[]; commit: boolean } {
    const duration = packet.pcm.length / BYTES_PER_MS
    const speech = pcmLevel(packet.pcm) >= 0.008
    if (!this.active && !speech) {
      this.preRoll.push(packet)
      while (this.preRoll.length > 1 && this.preRoll.reduce((n, p) => n + p.endMs - p.startMs, 0) > 200) this.preRoll.shift()
      return { packets: [], commit: false }
    }
    const packets = this.active ? [packet] : [...this.preRoll, packet]
    this.preRoll = []; this.active = true
    this.quietMs = speech ? 0 : this.quietMs + duration
    const commit = this.quietMs >= 600
    if (commit) { this.active = false; this.quietMs = 0 }
    return { packets, commit }
  }
  reset() { this.preRoll = []; this.active = false; this.quietMs = 0 }
}
