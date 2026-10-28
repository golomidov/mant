export const SAMPLE_RATE = 24_000
export const BYTES_PER_MS = SAMPLE_RATE * 2 / 1000
export const PACKET_MS = 20
export const PACKET_BYTES = PACKET_MS * BYTES_PER_MS

// At most one packet is retained, including an odd trailing byte between reads.
export class PcmFramer {
  private pending = new Uint8Array(PACKET_BYTES)
  private length = 0;

  *push(chunk: Uint8Array): Generator<Uint8Array> {
    let offset = 0
    while (offset < chunk.length) {
      const count = Math.min(PACKET_BYTES - this.length, chunk.length - offset)
      this.pending.set(chunk.subarray(offset, offset + count), this.length)
      offset += count
      this.length += count
      if (this.length === PACKET_BYTES) {
        yield this.pending
        this.pending = new Uint8Array(PACKET_BYTES)
        this.length = 0
      }
    }
  }

  finish(): Uint8Array {
    if (this.length % 2) throw new Error('Decoder produced an incomplete PCM16 sample.')
    const result = this.pending.slice(0, this.length)
    this.length = 0
    return result
  }
}

// Energy-based boundaries are deliberately independent of transcript rendering.
export class SpeechBoundary {
  private silenceMs = 0
  private speech = false
  private durationMs = 0

  add(pcm: Uint8Array): boolean {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    let energy = 0
    for (let i = 0; i < pcm.byteLength; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2
    const speaking = Math.sqrt(energy / (pcm.byteLength / 2)) > 0.012
    const duration = pcm.byteLength / BYTES_PER_MS
    this.durationMs += duration
    this.speech ||= speaking
    this.silenceMs = speaking ? 0 : this.silenceMs + duration
    // Also bound exceptionally long speech or silence buffers. All PCM is kept.
    if ((this.speech && this.silenceMs >= 600) || this.durationMs >= 15_000) {
      this.silenceMs = 0
      this.speech = false
      this.durationMs = 0
      return true
    }
    return false
  }
}

export interface AudioSource {
  packets(signal: AbortSignal): AsyncGenerator<Uint8Array>
  close(): Promise<void>
}

export class FileAudioSource implements AudioSource {
  private process: ReturnType<typeof Bun.spawn< 'ignore', 'pipe', 'pipe'>> | null = null

  constructor(private path: string) {}

  async *packets(signal: AbortSignal): AsyncGenerator<Uint8Array> {
    if (!Bun.which('ffmpeg')) throw new Error('FFmpeg is missing. Install ffmpeg and restart the server.')
    const child = Bun.spawn([
      'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-protocol_whitelist', 'file,pipe', '-i', this.path,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-c:a', 'pcm_s16le', '-f', 's16le', '-blocksize', String(PACKET_BYTES), 'pipe:1',
    ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    this.process = child
    let decoderError = ''
    // Drain stderr concurrently, retaining only a bounded tail.
    const stderr = (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of child.stderr) decoderError = (decoderError + decoder.decode(chunk)).slice(-2000)
    })()
    const cancel = () => child.kill()
    signal.addEventListener('abort', cancel, { once: true })
    const framer = new PcmFramer()
    let decodedBytes = 0
    try {
      for await (const chunk of child.stdout) {
        if (signal.aborted) return
        if (chunk.byteLength > 256_000) throw new Error('Decoder output exceeded the bounded read buffer.')
        decodedBytes += chunk.byteLength
        for (const packet of framer.push(chunk)) {
          if (signal.aborted) return
          yield packet
        }
      }
      const code = await child.exited
      await stderr
      if (signal.aborted) return
      if (code !== 0) throw new Error(`Unable to decode recording: ${decoderError || `FFmpeg exited ${code}`}`)
      if (!decodedBytes) throw new Error('The recording contains no decodable audio. Choose a nonempty recording.')
      const tail = framer.finish()
      if (tail.length) yield tail
    } finally {
      signal.removeEventListener('abort', cancel)
      child.kill()
      await child.exited
      await stderr
      this.process = null
    }
  }

  async close() {
    const child = this.process
    if (child) { child.kill(); await child.exited }
  }
}
