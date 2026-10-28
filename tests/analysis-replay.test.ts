import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Archives } from '../server/archive'
import { TranscriptReplay } from '../server/replay'
import { ConversationTracker } from '../server/tracking'
import { emptyAnalysis, emptyBrief } from '../shared/analysis'
import type { InterpretationInput } from '../server/interpretation'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mant-understanding-'))
  const archives = new Archives(directory)
  const id = crypto.randomUUID()
  const source = { id: 'b'.repeat(64), name: 'conversation.wav', size: 100, replayId: id }
  archives.create(id, source)
  const initial = emptyAnalysis(id, { ...emptyBrief(), preparation: 'Resolve the delivery date.' })
  archives.append(id, { kind: 'analysis', atMs: 0, effectiveMs: 0, reason: 'initial', state: initial })
  const segment = { sessionId: id, sourceId: source.id, id: 's1', order: 0, revision: 1, text: 'Delivery takes two', status: 'partial' as const }
  archives.append(id, { kind: 'transcript', atMs: 100, segment })
  const middle = structuredClone(initial)
  middle.version = 1
  middle.openQuestions = ['Two what?']
  middle.analyzedThroughMs = 100
  archives.append(id, { kind: 'analysis', atMs: 120, effectiveMs: 100, reason: 'track', state: middle })
  const edited = structuredClone(middle)
  edited.brief.version++
  edited.brief.preparation = 'Clarify the deadline and penalties.'
  archives.append(id, { kind: 'analysis', atMs: 150, effectiveMs: 150, reason: 'brief_user', state: edited })
  archives.append(id, { kind: 'transcript', atMs: 2000, segment: { ...segment, revision: 2, text: 'Delivery takes twelve weeks.', status: 'final' } })
  const future = structuredClone(edited)
  future.openQuestions = ['FUTURE SUMMARY — twelve weeks exceeds deadline.']
  future.version = 9
  future.analyzedThroughMs = 2000
  archives.append(id, { kind: 'analysis', atMs: 2100, effectiveMs: 2000, reason: 'track', state: future })
  cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }) })
  return { archives, id, saved: await archives.get(id), initial, middle, future }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(1)
  expect(predicate()).toBe(true)
}

test('saved analysis is released at availability position, not its earlier evidence position', async () => {
  const f = await fixture()
  const tracker = new ConversationTracker({ sessionId: 'playback', enabled: false, publish() {} })
  const replay = new TranscriptReplay(f.saved, f.archives, 10, () => {}, { analysis: row => tracker.restore(row.state) })
  cleanups.unshift(async () => { tracker.dispose(); await replay.shutdown() })
  void replay.start()
  replay.clock(100)
  await until(() => replay.segments.size === 1)
  expect(tracker.state.openQuestions).toEqual([])
  replay.clock(130)
  await until(() => tracker.state.openQuestions.length > 0)
  expect(tracker.state.openQuestions).toEqual(['Two what?'])
  expect(tracker.state.openQuestions.join()).not.toContain('FUTURE')
})

test('selecting a saved call loads its full end state without playback, audio or incremental callbacks', async () => {
  const f = await fixture()
  const events: unknown[] = []
  const replay = new TranscriptReplay(f.saved, f.archives, 1, event => events.push(event), {
    analysis: () => { throw new Error('Review must not replay intermediate analysis.') },
    transcript: () => { throw new Error('Review must not trigger live tracking.') },
  })
  cleanups.unshift(() => replay.shutdown())
  expect(f.saved.audioAvailable).toBe(false)
  const final = await replay.inspect()
  expect(replay.view.phase).toBe('ended')
  expect(replay.view.replay?.review).toBe(true)
  expect(replay.view.diagnostics.mediaMs).toBe(f.saved.durationMs)
  expect(replay.availablePositionMs).toBe(f.saved.durationMs)
  expect(replay.segments.get('s1')).toMatchObject({ sessionId: replay.view.id, revision: 2, text: 'Delivery takes twelve weeks.' })
  expect(final.analysis?.version).toBe(9)
  expect(final.analysis?.openQuestions).toEqual(f.future.openQuestions)
  expect(events).toEqual([])

  // Explicit Start/Restart constructs a fresh progressive run at zero.
  const started = new TranscriptReplay(f.saved, f.archives, 1, () => {})
  cleanups.unshift(() => started.shutdown())
  void started.start()
  await until(() => started.view.phase === 'ready')
  expect(started.segments.size).toBe(0)
  expect(started.view.diagnostics.mediaMs).toBe(0)
  expect(started.view.replay?.review).toBeUndefined()
})

test('recompute consumes progressively released text and brief edits, never saved model conclusions or future text', async () => {
  const f = await fixture()
  const contexts: InterpretationInput[] = []
  const tracker = new ConversationTracker({ sessionId: 'playback', windowMs: 60_000, interpreter: async (_mode, input) => {
    contexts.push(input)
    return { sessionId: input.request.sessionId, runId: input.request.runId, requestId: input.request.id, observations: [], objectives: [], openQuestions: [], replanReasons: [] }
  }, publish() {} })
  const replay = new TranscriptReplay(f.saved, f.archives, 10, payload => {
    if (payload.type === 'transcript') tracker.ingest(payload.segment, payload.mediaMs!)
  }, { analysisMode: 'recompute', analysis: row => tracker.replayUserEdit(row.state, row.reason, row.atMs) })
  tracker.state.sessionId = replay.view.id
  cleanups.unshift(async () => { tracker.dispose(); await replay.shutdown() })
  void replay.start()
  replay.clock(160)
  await until(() => tracker.state.brief.version === 1)
  await tracker.flush()
  expect(contexts).toHaveLength(1)
  expect(contexts[0]!.transcript.map(s => s.text)).toEqual(['Delivery takes two'])
  expect(contexts[0]!.observations).toEqual([])
  expect(JSON.stringify(contexts)).not.toContain('twelve')
  expect(JSON.stringify(contexts)).not.toContain('FUTURE')
  expect(tracker.state.brief.preparation).toBe('Clarify the deadline and penalties.')
  expect(tracker.state.openQuestions).toEqual([])
})

test('a backward seek creates a clean run and restores only the brief version and transcript available there', async () => {
  const f = await fixture()
  const tracker = new ConversationTracker({ sessionId: 'seek', enabled: false, publish() {} })
  const replay = new TranscriptReplay(f.saved, f.archives, 10, () => {}, { startMs: 130, analysis: row => tracker.restore(row.state) })
  cleanups.unshift(async () => { tracker.dispose(); await replay.shutdown() })
  void replay.start()
  await until(() => tracker.state.openQuestions.length > 0)
  expect(tracker.state.brief.version).toBe(0)
  expect(tracker.state.brief.preparation).toBe('Resolve the delivery date.')
  expect(replay.segments.get('s1')?.revision).toBe(1)
  expect(tracker.state.openQuestions).toEqual(['Two what?'])
  expect(tracker.state.runId).not.toBe(f.initial.runId)
  expect(replay.view.diagnostics.mediaMs).toBe(130)
})

test('analysis rows, revision history and pre-call edit history survive import and a separate corrected replay journal', async () => {
  const f = await fixture()
  const imported = await f.archives.import(Bun.file(f.archives.path(f.id)).stream())
  const rows = []
  for await (const row of f.archives.events(imported.id)) rows.push(row)
  expect(rows.filter(row => row.kind === 'transcript')).toHaveLength(2)
  expect(rows.filter(row => row.kind === 'analysis')).toHaveLength(4)
  expect(rows.every(row => row.kind === 'transcript' ? row.segment.sessionId === imported.id : row.state.sessionId === imported.id)).toBe(true)
  const fork = crypto.randomUUID()
  await f.archives.forkAt(f.id, fork, 160)
  const forkRows = []
  for await (const row of f.archives.events(fork)) forkRows.push(row)
  expect(forkRows.filter(row => row.kind === 'transcript')).toHaveLength(1)
  expect(JSON.stringify(forkRows)).not.toContain('FUTURE')
  f.archives.savePreparation(f.middle)
  f.archives.savePreparation(f.future)
  expect((await new Archives(f.archives.directory).preparation())?.version).toBe(9)
})

test('import rejects analysis that depends on transcript material not released yet', async () => {
  const f = await fixture()
  const malicious = structuredClone(f.initial)
  malicious.request = { id: 'future', sessionId: f.id, runId: malicious.runId, mode: 'TRACK', briefVersion: 0, inputs: [{ segmentId: 'not-released', revision: 1 }], observationVersions: {}, attributionVersions: {}, availableAt: 0, scheduledAt: 0, startedAt: 0, completedAt: null, appliedAt: null, effectiveMs: 0, outcome: 'running', schedulingDelayMs: null, inferenceMs: null, totalDelayMs: null, provisionalBeforeFinal: false }
  const content = `${JSON.stringify({ kind: 'header', version: 1, id: f.id, source: f.saved.source, createdAt: new Date().toISOString() })}\n${JSON.stringify({ kind: 'analysis', atMs: 0, effectiveMs: 0, reason: 'track', state: malicious })}\n`
  await expect(f.archives.import(new Blob([content]).stream())).rejects.toThrow('missing or future')
})
