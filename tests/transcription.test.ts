import { afterEach, expect, test } from 'bun:test'
import { OpenAITranscription } from '../server/transcription'
import type { Segment } from '../shared/protocol'
import { usageLedger, liveTranscribeUsdPerMinute } from '../server/usage'
import { safeMessage } from '../server/errors'

const originalKey = process.env.OPENAI_API_KEY
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach(clean => clean())
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalKey
})

function fakeProvider(confirm = true) {
  process.env.OPENAI_API_KEY = 'sk-test-only-not-a-credential'
  const received: Record<string, unknown>[] = []
  const updates: Segment[] = []
  const errors: Error[] = []
  // No network, credentials, or external processes: simulate the socket boundary.
  const peer = {
    readyState: WebSocket.OPEN, bufferedAmount: 0,
    onopen: null, onmessage: null, onerror: null, onclose: null,
    send(message: string) {
      const event = JSON.parse(message) as Record<string, unknown>
      received.push(event)
      if (event.type === 'session.update' && confirm) queueMicrotask(() => send({ type: 'session.updated', session: event.session }))
    },
    close() {},
  } as unknown as WebSocket
  function send(event: object) { peer.onmessage?.call(peer, new MessageEvent('message', { data: JSON.stringify(event) })) }
  const adapter = new OpenAITranscription('session', 'recording', 'minimal', {
    update: segment => updates.push(segment), error: error => errors.push(error),
  }, (url, options) => {
    expect(url).toBe('wss://api.openai.com/v1/realtime?intent=transcription')
    expect(options.headers.Authorization).toBe('Bearer sk-test-only-not-a-credential')
    queueMicrotask(() => peer.onopen?.call(peer, new Event('open')))
    return peer
  })
  cleanup.push(() => adapter.close())
  return { adapter, received, updates, errors, send }
}

async function waitFor(check: () => boolean) {
  const end = performance.now() + 1000
  while (!check()) { if (performance.now() > end) throw new Error('Timed out waiting for local fake provider'); await Bun.sleep(1) }
}

test('adapter confirms documented configuration and forwards partial text before commit', async () => {
  const fake = fakeProvider()
  await fake.adapter.ready(new AbortController().signal)
  const configuration = fake.received[0] as { session: { audio: { input: { transcription: object; turn_detection: unknown } } } }
  expect(configuration.session.audio.input.transcription).toEqual({ model: 'gpt-live-transcribe', languages: ['en', 'it', 'es', 'fr', 'de', 'ru'], delay: 'minimal' })
  expect(configuration.session.audio.input.turn_detection).toBe(null)
  await fake.adapter.append(new Uint8Array(960))
  fake.send({ type: 'conversation.item.input_audio_transcription.delta', event_id: 'delta', item_id: 'a', content_index: 0, delta: 'Ciao' })
  await waitFor(() => fake.updates.length === 1)
  expect(fake.updates[0]?.text).toBe('Ciao')
  expect(fake.received.some(event => event.type === 'input_audio_buffer.commit')).toBe(false)
  const finishing = fake.adapter.finish(100)
  await waitFor(() => fake.received.some(event => event.type === 'input_audio_buffer.commit'))
  // A terminal <100ms buffer receives silence padding, preserving all real samples.
  const appends = fake.received.filter(event => event.type === 'input_audio_buffer.append')
  expect(appends.map(event => Buffer.from(String(event.audio), 'base64').length)).toEqual([960, 3840])
  fake.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', content_index: 0, transcript: 'Ciao.' })
  expect(await finishing).toBe(true)
  expect(fake.updates.at(-1)?.text).toBe('Ciao.')
  expect(new Set(fake.updates.map(segment => segment.id)).size).toBe(1)
})

test('changing conversation language updates the active recognition session without reconnecting or losing transcript state', async () => {
  const fake = fakeProvider()
  await fake.adapter.ready(new AbortController().signal)
  fake.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first', content_index: 0, transcript: 'Hola.' })
  fake.adapter.setLanguages(['ru'])
  await Bun.sleep(1)
  const updates = fake.received.filter(e => e.type === 'session.update') as { session: { audio: { input: { transcription: { languages: string[] } } } } }[]
  expect(updates).toHaveLength(2)
  expect(updates.at(-1)!.session.audio.input.transcription.languages).toEqual(['ru'])
  fake.adapter.setLanguages(['ru'])
  expect(fake.received.filter(e => e.type === 'session.update')).toHaveLength(2)
  fake.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'second', content_index: 0, transcript: 'Здравствуйте.' })
  expect(fake.updates.map(s => s.text)).toEqual(['Hola.', 'Здравствуйте.'])
  expect(fake.errors).toEqual([])
})

test('does not resolve readiness until session.updated; reports actual provider errors safely', async () => {
  const fake = fakeProvider(false)
  let ready = false
  const readiness = fake.adapter.ready(new AbortController().signal).then(() => { ready = true }, error => error as Error)
  await waitFor(() => fake.received.length > 0)
  expect(ready).toBe(false)
  fake.send({ type: 'error', error: { code: 'model_not_found', message: 'gpt-live-transcribe unavailable for sk-test-only-not-a-credential' } })
  const error = await readiness
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('model_not_found')
  expect((error as Error).message).toContain('gpt-live-transcribe unavailable')
  expect((error as Error).message).not.toContain('sk-test')
})

test('finalization has a bounded timeout and duplicate events do not duplicate text', async () => {
  const fake = fakeProvider()
  await fake.adapter.ready(new AbortController().signal)
  await fake.adapter.append(new Uint8Array(4800))
  const event = { type: 'conversation.item.input_audio_transcription.delta', event_id: 'same', item_id: 'a', content_index: 0, delta: 'Hi' }
  fake.send(event)
  fake.send(event)
  await waitFor(() => fake.updates.length > 0)
  expect(await fake.adapter.finish(10)).toBe(false)
  expect(fake.updates).toHaveLength(1)
})

test('accepts a successful acknowledgement that omits delay, as the live service does', async () => {
  const fake = fakeProvider(false)
  const readiness = fake.adapter.ready(new AbortController().signal)
  fake.send({ type: 'session.updated', session: { type: 'transcription', audio: { input: {
    format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-live-transcribe' }, turn_detection: null,
  } } } })
  await readiness
  expect(fake.errors).toHaveLength(0)
})

test('rejects an explicitly different model or delay instead of falling back', async () => {
  const fake = fakeProvider(false)
  const readiness = fake.adapter.ready(new AbortController().signal)
  fake.send({ type: 'session.updated', session: { type: 'transcription', audio: { input: {
    format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-transcribe', delay: 'low' }, turn_detection: null,
  } } } })
  await expect(readiness).rejects.toThrow('did not confirm')
})

test('missing key fails before opening any connection', async () => {
  delete process.env.OPENAI_API_KEY
  const adapter = new OpenAITranscription('s', 'a', 'low', { update() {}, error() {} }, () => { throw new Error('Must not connect') })
  await expect(adapter.ready(new AbortController().signal)).rejects.toThrow('OPENAI_API_KEY is missing')
  expect(safeMessage('Incorrect API key: sk-abc***123')).toBe('Incorrect API key: [redacted]')
})


test('transcription accounting counts committed audio once, includes terminal padding, and ignores duplicate completion events', async () => {
  const fake = fakeProvider(); await fake.adapter.ready(new AbortController().signal)
  const before = usageLedger.snapshot('session')
  await fake.adapter.append(new Uint8Array(960)); fake.adapter.commit(); fake.adapter.commit()
  fake.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'metered', content_index: 0, transcript: 'Hello.' })
  fake.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'metered', content_index: 0, transcript: 'Hello.' })
  const after = usageLedger.snapshot('session')
  expect(after.requests - before.requests).toBe(1)
  expect(after.audioSeconds - before.audioSeconds).toBeCloseTo(.1)
  expect(after.usd - before.usd).toBeCloseTo(.1 / 60 * liveTranscribeUsdPerMinute)
})

test('sparse capture timing survives silence suppression, delayed finals and provider item reordering', async () => {
  const fake = fakeProvider()
  await fake.adapter.ready(new AbortController().signal)
  await fake.adapter.append(new Uint8Array(4800), { startMs: 1000, endMs: 1100 })
  fake.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', content_index: 0, delta: 'First turn' })
  expect(fake.updates.at(-1)!.capture?.startMs).toBe(1000)
  fake.adapter.commit()
  fake.send({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null })
  // No audio append for the intervening 8.9 seconds of silence.
  await fake.adapter.append(new Uint8Array(4800), { startMs: 10_000, endMs: 10_100 })
  fake.adapter.commit()
  fake.send({ type: 'input_audio_buffer.committed', item_id: 'b', previous_item_id: 'a' })
  fake.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', content_index: 0, transcript: 'Second turn.' })
  fake.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', content_index: 0, transcript: 'First turn.' })
  const first = fake.updates.at(-1)!, second = fake.updates.at(-2)!
  expect(first.capture).toEqual({ startMs: 1000, endMs: 1100, callTransmission: 'unknown' })
  expect(second.capture?.startMs).toBe(10_000)
  expect(fake.received.filter(e => e.type === 'input_audio_buffer.append')).toHaveLength(2)
})
