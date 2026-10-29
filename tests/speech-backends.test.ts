import { expect, test } from 'bun:test'
import { DeepgramTranscription } from '../server/deepgram-transcription'
import { WindowedTranscription, removeOverlap, pcm16k } from '../server/windowed-transcription'
import type { Segment } from '../shared/protocol'
class Socket {
  readyState = WebSocket.OPEN
  bufferedAmount = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  send(data: unknown) { this.sent.push(data) }
  close() {}
  event(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }) }
}
function deepgram() {
  const socket = new Socket(), updates: Segment[] = [], errors: Error[] = []
  const transport = new DeepgramTranscription('session', 'source', { update: s => updates.push(s), error: e => errors.push(e) }, { provider: 'deepgram', model: 'nova-3', credentialEnv: 'MANT_TEST_DEEPGRAM' }, ['en'], () => socket as unknown as WebSocket)
  return { transport, socket, updates, errors }
}
test('Deepgram normalizes replacement interims with stable IDs, timestamps and final revisions, then drains explicitly', async () => {
  process.env.MANT_TEST_DEEPGRAM = 'test-key'
  const f = deepgram()
  try {
    const ready = f.transport.ready(new AbortController().signal); f.socket.onopen?.(); await ready
    await f.transport.append(new Uint8Array(9600), { startMs: 4000, endMs: 4200 })
    const event = (text: string, final = false) => f.socket.event({ type: 'Results', start: 0, duration: .2, is_final: final, channel: { alternatives: [{ transcript: text }] } })
    event('Anna'); event('Anna did not'); event('Anna did not agree.', true); event('stale interim')
    expect(f.updates.map(s => s.text)).toEqual(['Anna', 'Anna did not', 'Anna did not agree.'])
    expect(new Set(f.updates.map(s => s.id)).size).toBe(1)
    expect(f.updates.at(-1)).toMatchObject({ revision: 3, status: 'final', capture: { startMs: 4000, endMs: 4200 } })
    const finished = f.transport.finish(100)
    f.socket.event({ type: 'Metadata' }); f.socket.onclose?.({ code: 1000 })
    expect(await finished).toBe(true); expect(f.errors).toHaveLength(0)
  } finally { f.transport.close(); delete process.env.MANT_TEST_DEEPGRAM }
})
test('Deepgram rejects unexpected disconnects during draining and cancels readiness', async () => {
  process.env.MANT_TEST_DEEPGRAM = 'test-key'
  const f = deepgram()
  try {
    const ready = f.transport.ready(new AbortController().signal); f.socket.onopen?.(); await ready
    const finish = f.transport.finish(100); f.socket.onclose?.({ code: 1006 })
    expect(await finish).toBe(false); expect(f.errors).toHaveLength(1)
    const second = deepgram(), controller = new AbortController()
    const pending = second.transport.ready(controller.signal); controller.abort()
    await expect(pending).rejects.toThrow('cancelled'); second.transport.close()
  } finally { f.transport.close(); delete process.env.MANT_TEST_DEEPGRAM }
})
test('local windows resample PCM to 16k, reconcile overlap, preserve source time and final-drain tails', async () => {
  const updates: Segment[] = [], errors: Error[] = [], sizes: number[] = []
  let n = 0
  const request = (async (_url, options) => {
    if (!options?.body) return Response.json({ status: 'ok' })
    const file = (options.body as FormData).get('file') as Blob
    sizes.push(file.size)
    return Response.json({ text: n++ ? '42 units. We did not agree.' : 'Anna proposed 42 units.' })
  }) as typeof fetch
  const transport = new WindowedTranscription('s', 'microphone', { update: s => updates.push(s), error: e => errors.push(e) }, { provider: 'whisper', model: 'multilingual', endpoint: 'http://127.0.0.1/inference' }, ['en'], request)
  try {
    await transport.ready(new AbortController().signal)
    await transport.append(new Uint8Array(240000), { startMs: 3000, endMs: 8000 })
    await transport.append(new Uint8Array(48000), { startMs: 8000, endMs: 9000 })
    expect(await transport.finish(1000)).toBe(true)
    expect(sizes).toEqual([160044, 64044])
    expect(updates.map(s => s.text)).toEqual(['Anna proposed 42 units.', 'We did not agree.'])
    expect(updates.at(-1)?.capture).toMatchObject({ startMs: 8000, endMs: 9000 })
    expect(errors).toEqual([])
  } finally { transport.close() }
  expect(pcm16k(new Uint8Array(48000)).length).toBe(32000)
  expect(removeOverlap('Привет Анна.', 'Анна. Нет, не 42.')).toBe('Нет, не 42.')
})
test('local adapters quarantine late results after cancellation and reject unbounded backlog', async () => {
  let release!: (r: Response) => void
  const updates: Segment[] = []
  const transport = new WindowedTranscription('s', 'source', { update: s => updates.push(s), error() {} }, { provider: 'whisper', endpoint: 'http://localhost/inference', model: 'test' }, ['ru'], (async (_url, options) => options?.body ? new Promise<Response>(resolve => { release = resolve }) : Response.json({})) as typeof fetch)
  await transport.ready(new AbortController().signal)
  await transport.append(new Uint8Array(240000)); await Bun.sleep(0)
  await expect(transport.append(new Uint8Array(1000000))).rejects.toThrow('backlog')
  const done = transport.finish(5)
  expect(await done).toBe(false)
  release(Response.json({ text: 'late' })); await Bun.sleep(0)
  expect(updates).toEqual([])
})
test('local adapters report malformed output and language switches are captured per queued window', async () => {
  const languages: string[] = [], errors: Error[] = []
  const transport = new WindowedTranscription('s', 'source', { update() {}, error: e => errors.push(e) }, { provider: 'whisper', endpoint: 'http://localhost/inference', model: 'test' }, ['it'], (async (_url, options) => {
    if (!options?.body) return Response.json({})
    languages.push(String((options.body as FormData).get('language')))
    return Response.json(languages.length === 1 ? { text: 'Ciao.' } : { invalid: true })
  }) as typeof fetch)
  try {
    await transport.ready(new AbortController().signal)
    await transport.append(new Uint8Array(240000)); transport.setLanguages(['ru']); await transport.append(new Uint8Array(240000))
    expect(await transport.finish(1000)).toBe(false)
    expect(languages).toEqual(['it', 'ru']); expect(errors[0]?.message).toContain('Malformed')
  } finally { transport.close() }
})
