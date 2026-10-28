import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileAudioSource, PACKET_BYTES } from '../server/audio'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

function path() {
  const directory = mkdtempSync(join(tmpdir(), 'mant-decoder-'))
  directories.push(directory)
  return join(directory, 'recording.wav')
}

test.skipIf(!Bun.which('ffmpeg'))('FFmpeg incrementally decodes exact PCM including a short final packet', async () => {
  const pcm = Buffer.alloc(3696)
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i / 19) * 8000), i)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  const recording = path()
  await Bun.write(recording, Buffer.concat([header, pcm]))
  const source = new FileAudioSource(recording)
  const packets: Uint8Array[] = []
  for await (const packet of source.packets(new AbortController().signal)) packets.push(packet)
  await source.close()
  expect(packets.map(packet => packet.length)).toEqual([PACKET_BYTES, PACKET_BYTES, PACKET_BYTES, 816])
  expect(Buffer.concat(packets)).toEqual(pcm)
})

test.skipIf(!Bun.which('ffmpeg'))('invalid media surfaces the decoder error and releases the child', async () => {
  const recording = path()
  await Bun.write(recording, 'This is not audio')
  const source = new FileAudioSource(recording)
  const run = async () => { for await (const _packet of source.packets(new AbortController().signal)) { /* Drain. */ } }
  await expect(run()).rejects.toThrow('Unable to decode recording')
  await source.close()
})
