import { join } from 'node:path'
import type { Archives } from './archive'
import type { Recording } from '../shared/protocol'
import type { CaptureRecording, CaptureSourceId, CaptureTrack } from '../shared/capture'
import { captureSources } from '../shared/capture'
import { SAMPLE_RATE } from './audio'

function wavHeader(bytes: number, channels: number) {
  const b = Buffer.alloc(44)
  b.write('RIFF'); b.writeUInt32LE(bytes + 36, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(SAMPLE_RATE, 24)
  b.writeUInt32LE(SAMPLE_RATE * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(bytes, 40)
  return b
}
export class CaptureRecorder {
  private tracks: Record<CaptureSourceId, { path: string; samples: number }>
  private closed = false
  constructor(private archives: Archives, readonly id: string) {
    this.tracks = Object.fromEntries(captureSources.map(source => {
      const path = join(archives.directory, `${id}.${source}.wav`)
      void archives.persistence.enqueue({ kind: 'open', path, data: wavHeader(0, 1) })
      return [source, { path, samples: 0 }]
    })) as typeof this.tracks
  }
  add(source: CaptureSourceId, startMs: number, pcm: Uint8Array) {
    if (this.closed) throw new Error('Capture recording is closed.')
    const track = this.tracks[source]
    let position = Math.round(startMs * SAMPLE_RATE / 1000)
    // Small converter rounding is aligned; larger overlaps are never replayed twice.
    if (position < track.samples) {
      const overlap = track.samples - position
      if (overlap > 240) throw new Error(`${source} capture clock overlapped by more than 10 ms.`)
      pcm = pcm.subarray(overlap * 2); position += overlap
    }
    if (!pcm.length) return
    if ((position * 2 + pcm.length) > 2_000_000_000) throw new Error('Capture reached the 2 GB per-track recording limit. Start a new session.')
    void this.archives.persistence.enqueue({ kind: 'write', path: track.path, data: pcm.slice(), position: 44 + position * 2 })
    track.samples = position + pcm.length / 2
  }
  close(durationMs: number) {
    if (this.closed) return
    this.closed = true
    let error: unknown
    for (const track of Object.values(this.tracks)) {
      try {
        track.samples = Math.max(track.samples, Math.round(durationMs * SAMPLE_RATE / 1000))
        const bytes = track.samples * 2
        void this.archives.persistence.enqueue({ kind: 'close', path: track.path, length: 44 + bytes, data: wavHeader(bytes, 1) })
      } catch (e) { error ??= e }

    }
    if (error) throw error
  }
  async save(recording: Recording, durationMs: number): Promise<Recording> {
    this.close(durationMs)
    await Promise.all(Object.values(this.tracks).map(track => this.archives.persistence.flush(track.path)))
    const tracks: CaptureTrack[] = []
    for (const source of captureSources) {
      const track = this.tracks[source]
      const name = `${this.id}.${source}.wav`
      const audio = await this.store(track.path, name)
      tracks.push({ sourceId: source, audioId: audio.id, name, durationMs: track.samples / 24 })
    }
    // A listening copy only; original synchronized mono tracks remain available.
    const mixedPath = join(this.archives.directory, `${this.id}.listening.wav`)
    if (!Bun.which('ffmpeg')) throw new Error('FFmpeg is required to create the call listening copy. Separate WAV originals were retained.')
    const ffmpeg = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', this.tracks['local-microphone'].path, '-i', this.tracks['remote-playback'].path,
      '-filter_complex', '[0:a][1:a]amerge=inputs=2[a]', '-map', '[a]', '-c:a', 'pcm_s16le', '-y', mixedPath], { stdout: 'ignore', stderr: 'pipe' })
    const error = await new Response(ffmpeg.stderr).text()
    if (await ffmpeg.exited !== 0) throw new Error(`Could not create listening copy: ${error.slice(-1000)}`)
    const mixed = await this.store(mixedPath, recording.name)
    const final = { ...mixed, replayId: this.id, capture: { ...recording.capture!, tracks } }
    await this.archives.keepAudio(final, mixedPath, 'audio/wav')
    return final
  }
  private async store(path: string, name: string) {
    const hasher = new Bun.CryptoHasher('sha256')
    const file = Bun.file(path)
    for await (const chunk of file.stream()) hasher.update(chunk)
    const recording: Recording = { id: hasher.digest('hex'), name, size: file.size, replayId: null }
    await this.archives.keepAudio(recording, path, 'audio/wav')
    return recording
  }
}
export interface CaptureJournalRow {
  kind: 'capture'; atMs: number
  event: 'start' | 'gap' | 'muted' | 'unmuted' | 'failure' | 'separation' | 'finalized' | 'turn_end' | 'local_speech' | 'metrics' | 'gain' | 'recovery'
  detail: string; sourceId?: CaptureSourceId; source?: Recording
}
export function capturePlaceholder(capture: CaptureRecording): Recording {
  return { id: new Bun.CryptoHasher('sha256').update(crypto.randomUUID()).digest('hex'), name: `Call ${new Date().toISOString().replaceAll(':', '-')}.wav`, size: 0, replayId: null, capture }
}
