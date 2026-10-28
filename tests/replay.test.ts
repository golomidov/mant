import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Archives } from '../server/archive'
import { ReplayClock, TranscriptReplay } from '../server/replay'
import type { ServerPayload } from '../shared/protocol'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

test('speed changes preserve the current position and support 1×, 2×, 5× and 10×', () => {
  let now = 0
  const clock = new ReplayClock(1, () => now)
  now = 10
  expect(clock.current()).toBe(10)
  clock.setSpeed(2)
  now = 20
  expect(clock.current()).toBe(30)
  clock.setSpeed(5)
  now = 30
  expect(clock.current()).toBe(80)
  clock.setSpeed(10)
  now = 40
  expect(clock.current()).toBe(180)
})

async function setup(speed: 1 | 2 | 5 | 10 = 10) {
  const directory = mkdtempSync(join(tmpdir(), 'mant-replay-'))
  const archives = new Archives(directory)
  const id = crypto.randomUUID()
  const source = { id: 'a'.repeat(64), name: 'original.wav', size: 100, replayId: id }
  archives.create(id, source)
  const segment = { sessionId: id, sourceId: source.id, id: 'first', order: 0, revision: 1, text: 'Pronto', status: 'partial' as const }
  archives.append(id, { kind: 'transcript', atMs: 100, segment })
  archives.append(id, { kind: 'transcript', atMs: 200, segment: { ...segment, revision: 2, text: 'Pronto?', status: 'final' } })
  const events: ServerPayload[] = []
  const saved = await archives.get(id)
  const replay = new TranscriptReplay(saved, archives, speed, event => events.push(event))
  const work = replay.start()
  cleanups.push(async () => { await replay.shutdown(); rmSync(directory, { recursive: true, force: true }) })
  return { archives, saved, replay, work, events }
}

test('replay follows played audio and ends at the last saved event without waiting for the full WAV', async () => {
  const fixture = await setup()
  await Bun.sleep(1)
  expect(fixture.replay.view.phase).toBe('ready')
  expect(fixture.replay.segments.size).toBe(0)
  fixture.replay.clock(0)
  await Bun.sleep(15)
  fixture.replay.clock(100)
  await Bun.sleep(1)
  expect(fixture.replay.segments.get('first')?.text).toBe('Pronto')
  fixture.replay.setSpeed(5)
  expect(fixture.replay.view.replay?.speed).toBe(5)
  fixture.replay.clock(200)
  await Bun.sleep(1)
  expect(fixture.replay.segments.get('first')?.text).toBe('Pronto?')
  expect(fixture.replay.segments.size).toBe(1)
  await fixture.work
  expect(fixture.replay.view.phase).toBe('ended')
  expect(fixture.replay.view.diagnostics.sentMs).toBe(0)
})

test('Stop freezes replay; resuming at a different speed retains its position and segment revisions', async () => {
  const fixture = await setup()
  await Bun.sleep(1)
  fixture.replay.clock(0)
  fixture.replay.clock(100)
  await Bun.sleep(1)
  fixture.replay.stop(100)
  fixture.replay.stop(100)
  expect(fixture.replay.view.phase).toBe('paused')
  expect(fixture.replay.view.diagnostics.mediaMs).toBe(100)
  expect(fixture.replay.segments.get('first')?.revision).toBe(1)
  await Bun.sleep(5)
  expect(fixture.replay.segments.get('first')?.revision).toBe(1)
  fixture.replay.resume(1)
  fixture.replay.clock(100)
  expect(fixture.replay.view.diagnostics.mediaMs).toBe(100)
  fixture.replay.clock(200)
  await fixture.work
  expect(fixture.replay.segments.get('first')?.revision).toBe(2)
  expect(fixture.events.filter(event => event.type === 'ended')).toHaveLength(1)
})

test('a separate restarted replay explicitly begins at zero with empty transcript state', async () => {
  const fixture = await setup()
  fixture.replay.clock(100)
  await Bun.sleep(1)
  fixture.replay.stop(100)
  await fixture.replay.shutdown()
  const restarted = new TranscriptReplay(fixture.saved, fixture.archives, 10, () => {})
  const work = restarted.start()
  expect(restarted.segments.size).toBe(0)
  expect(restarted.view.diagnostics.mediaMs).toBe(0)
  await restarted.shutdown()
  await work
})

test('10× to 1× changes rebase at the reported audio position without resetting the transcript cursor', async () => {
  const fixture = await setup(10)
  fixture.replay.clock(0)
  fixture.replay.clock(100)
  await Bun.sleep(1)
  for (let n = 0; n < 100 && !fixture.replay.segments.has('first'); n++) await Bun.sleep(1)
  fixture.replay.setSpeed(1, 100)
  expect(fixture.replay.view.diagnostics.mediaMs).toBe(100)
  expect(fixture.replay.segments.get('first')?.revision).toBe(1)
  fixture.replay.clock(120)
  fixture.replay.setSpeed(10, 120)
  fixture.replay.clock(140)
  fixture.replay.setSpeed(1, 140)
  expect(fixture.replay.view.diagnostics.mediaMs).toBe(140)
  expect(fixture.replay.view.replay?.speed).toBe(1)
  fixture.replay.stop(140)
  expect(fixture.replay.view.phase).toBe('paused')
  expect(fixture.replay.segments.get('first')?.text).toBe('Pronto')
})

test('Stop cancels a pending final event after audio EOF without releasing future text', async () => {
  const fixture = await setup()
  await fixture.replay.shutdown()
  await fixture.work
  fixture.archives.append(fixture.saved.id, { kind: 'transcript', atMs: 200, tailMs: 1000,
    segment: { sessionId: fixture.saved.id, sourceId: fixture.saved.source.id, id: 'first', order: 0, revision: 3, text: 'future final', status: 'final' } })
  const replay = new TranscriptReplay(fixture.saved, fixture.archives, 10, () => {})
  const work = replay.start()
  cleanups.push(() => replay.shutdown())
  replay.clock(200)
  await Bun.sleep(2)
  replay.endPlayback(200)
  await Bun.sleep(2)
  replay.stop()
  expect(replay.view.phase).toBe('paused')
  await replay.shutdown()
  await work
  expect(replay.view.phase).toBe('ended')
  expect(replay.segments.get('first')?.text).toBe('Pronto?')
})
