import { describe, expect, test } from 'bun:test'
import { BYTES_PER_MS, PACKET_BYTES, PcmFramer, SpeechBoundary } from '../server/audio'

describe('PCM framing', () => {
  test('preserves every sample across arbitrary and odd-sized chunks', () => {
    const original = Uint8Array.from({ length: PACKET_BYTES * 8 + 246 }, (_, index) => index % 251)
    const framer = new PcmFramer()
    const packets: Uint8Array[] = []
    let offset = 0
    let seed = 42
    while (offset < original.length) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const length = seed % 1301 + 1
      packets.push(...framer.push(original.subarray(offset, offset + length)))
      offset += length
    }
    packets.push(framer.finish())
    expect(packets.slice(0, -1).every(packet => packet.length === PACKET_BYTES)).toBe(true)
    expect(packets.at(-1)?.length).toBe(246)
    expect(Buffer.concat(packets)).toEqual(Buffer.from(original))
  })

  test('rejects an invalid terminal half sample instead of silently corrupting PCM', () => {
    const framer = new PcmFramer()
    expect([...framer.push(new Uint8Array([1]))]).toEqual([])
    expect(() => framer.finish()).toThrow('incomplete PCM16 sample')
  })

  test('commits after speech and silence, preserving the next onset', () => {
    const detector = new SpeechBoundary()
    const voice = new Uint8Array(PACKET_BYTES)
    const view = new DataView(voice.buffer)
    for (let i = 0; i < voice.length; i += 2) view.setInt16(i, 4000, true)
    expect(detector.add(voice)).toBe(false)
    const silence = new Uint8Array(PACKET_BYTES)
    for (let i = 0; i < 29; i++) expect(detector.add(silence)).toBe(false)
    expect(detector.add(silence)).toBe(true)
    expect(detector.add(voice)).toBe(false)
    for (let i = 0; i < 29; i++) expect(detector.add(silence)).toBe(false)
    expect(detector.add(silence)).toBe(true)
    expect(PACKET_BYTES / BYTES_PER_MS).toBe(20)
  })
})
