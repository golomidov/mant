import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AudioSource } from '../server/audio'
import { PACKET_BYTES } from '../server/audio'
import { Archives } from '../server/archive'
import { ConversationSession } from '../server/session'
import { TranscriptReplay } from '../server/replay'
import type { TranscriptionTransport, TransportCallbacks } from '../server/transcription'
import type { ServerPayload } from '../shared/protocol'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

class FakeTransport implements TranscriptionTransport {
  packets: Uint8Array[] = []
  commits = 0
  closed = false
  finals = true
  onReady: (() => void) | null = null
  constructor(readonly sessionId: string, readonly sourceId: string, readonly callbacks: TransportCallbacks, readonly deferred = false) {}
  async ready(signal: AbortSignal) {
    if (!this.deferred) return
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error('Cancelled'))
      this.onReady = () => { signal.removeEventListener('abort', abort); resolve() }
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  async append(pcm: Uint8Array) {
    this.packets.push(pcm.slice())
    this.callbacks.update({ sessionId: this.sessionId, sourceId: this.sourceId, id: 'segment', order: 0,
      revision: this.packets.length, text: 'partial now', status: 'partial' })
  }
  commit() { this.commits++ }
  async finish() {
    this.commit()
    if (this.finals) this.callbacks.update({ sessionId: this.sessionId, sourceId: this.sourceId, id: 'segment', order: 0,
      revision: 999, text: 'Final text.', status: 'final' })
    return this.finals
  }
  close() { this.closed = true }
}

function setup(packetCount: number, deferred = false) {
  const directory = mkdtempSync(join(tmpdir(), 'mant-test-'))
  const events: ServerPayload[] = []
  let decoded = 0
  let sourceClosed = false
  let transport: FakeTransport
  const source: AudioSource = {
    async *packets() { for (let i = 0; i < packetCount; i++) { decoded++; yield new Uint8Array(PACKET_BYTES) } },
    async close() { sourceClosed = true },
  }
  const archives = new Archives(directory)
  const session = new ConversationSession({
    source: { id: 'source', name: 'test.wav', size: 123, replayId: null }, mode: 'live', delay: 'minimal', audio: source, archives,
    transport: (id, source, _delay, callbacks) => { transport = new FakeTransport(id, source, callbacks, deferred); return transport },
    emit: event => events.push(structuredClone(event)),
  })
  const work = session.start()
  cleanups.push(async () => { await session.shutdown(); rmSync(directory, { recursive: true, force: true }) })
  return { session, work, events, archives, source, get transport() { return transport! }, get decoded() { return decoded }, get sourceClosed() { return sourceClosed } }
}

test('waits for readiness and actual playback; emits partials before any speech boundary', async () => {
  const fixture = setup(4, true)
  expect(fixture.decoded).toBe(0)
  fixture.transport.onReady!()
  await Bun.sleep(1)
  expect(fixture.session.view.phase).toBe('ready')
  expect(fixture.decoded).toBe(0)
  fixture.session.clock(0)
  await Bun.sleep(25)
  fixture.session.clock(20)
  await Bun.sleep(1)
  expect(fixture.transport.packets.length).toBe(1)
  expect(fixture.transport.commits).toBe(0)
  expect(fixture.events.some(event => event.type === 'transcript' && event.segment.status === 'partial')).toBe(true)
  expect(fixture.decoded).toBeLessThanOrEqual(2)
  fixture.session.stop(25)
  fixture.session.stop(25)
  await fixture.work
  expect(fixture.session.view.diagnostics.sentMs).toBe(25)
  expect(fixture.transport.closed).toBe(true)
  expect(fixture.sourceClosed).toBe(true)
  expect(fixture.session.view.phase).toBe('ended')
  expect(fixture.session.segments.size).toBe(1)
  expect(fixture.session.segments.get('segment')?.text).toBe('Final text.')
})

test('Stop during configuration cancels readiness and cleans up exactly one run', async () => {
  const fixture = setup(2, true)
  fixture.session.stop()
  fixture.session.stop()
  await fixture.work
  await fixture.session.shutdown()
  expect(fixture.transport.closed).toBe(true)
  expect(fixture.decoded).toBe(0)
  expect(fixture.session.view.phase).toBe('ended')
  expect(fixture.events.filter(event => event.type === 'ended')).toHaveLength(1)
})

test('provider failure cleans up; late callbacks cannot mutate a finished session', async () => {
  const fixture = setup(2)
  await Bun.sleep(1)
  fixture.session.clock(0)
  await fixture.session.fail(new Error('Provider disconnected'))
  await fixture.work
  fixture.transport.callbacks.update({ sessionId: fixture.session.view.id, sourceId: 'source', id: 'late', order: 0, revision: 1, text: 'late', status: 'final' })
  expect(fixture.session.segments.size).toBe(0)
  expect(fixture.transport.closed).toBe(true)
  expect(fixture.sourceClosed).toBe(true)
  expect(fixture.session.view.phase).toBe('error')
})

test('EOF flushes final audio and retains provisional text on bounded finalization timeout', async () => {
  const fixture = setup(1)
  await Bun.sleep(1)
  fixture.transport.finals = false
  fixture.session.clock(0)
  await Bun.sleep(25)
  fixture.session.clock(20)
  await fixture.work
  expect(fixture.transport.packets).toHaveLength(1)
  expect(fixture.session.view.message).toContain('timed out')
  expect(fixture.session.segments.get('segment')?.status).toBe('partial')
})

test('saved replay follows playback and never constructs a recognition transport', async () => {
  const fixture = setup(1)
  await Bun.sleep(1)
  fixture.session.clock(0)
  await Bun.sleep(25)
  fixture.session.clock(20)
  await fixture.work
  const events: ServerPayload[] = []
  const replay = new TranscriptReplay(await fixture.archives.get(fixture.session.view.id), fixture.archives, 1, event => events.push(event))
  const work = replay.start()
  cleanups.push(() => replay.shutdown())
  await Bun.sleep(1)
  expect(replay.view.phase).toBe('ready')
  expect(events.filter(event => event.type === 'transcript')).toHaveLength(0)
  replay.clock(0)
  await Bun.sleep(25)
  replay.clock(20)
  await Bun.sleep(1)
  replay.endPlayback(20)
  await work
  expect(replay.segments.get('segment')?.text).toBe('Final text.')
  expect(replay.view.phase).toBe('ended')
  expect(await fixture.archives.latest('source')).toBe(fixture.session.view.id)
})
