import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Archives } from '../server/archive'
import { TranscriptReplay } from '../server/replay'
import { SuggestionCoordinator } from '../server/suggestions'
import { emptyAnalysis } from '../shared/analysis'
import type { SuggestionInput, SuggestionRow, SuggestionState } from '../shared/suggestions'
import { parseSuggestionRow } from '../server/suggestion-schema'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const f of cleanups.splice(0)) await f() })
async function until(predicate: () => boolean) { for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(1); expect(predicate()).toBe(true) }
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mant-suggest-replay-')); const archives = new Archives(directory)
  const id = crypto.randomUUID(); const source = { id: 'a'.repeat(64), name: 'office.wav', size: 100, replayId: id }
  archives.create(id, source)
  const analysis = emptyAnalysis(id)
  archives.append(id, { kind: 'analysis', atMs: 0, effectiveMs: 0, reason: 'initial', state: analysis })
  const first = { sessionId: id, sourceId: source.id, id: 's1', order: 0, revision: 1, text: 'We expect regular attendance', status: 'partial' as const }
  archives.append(id, { kind: 'transcript', atMs: 100, segment: first })
  const states: SuggestionRow[] = []
  const coordinator = new SuggestionCoordinator({ sessionId: id, windowMs: 60_000, analysis: () => analysis, media: () => 120, publish: (state, reason) => states.push({ kind: 'suggestion', atMs: 120, reason, state }),
    generator: async (input, _signal, publish) => publish({ sessionId: input.sessionId, runId: input.runId, requestId: input.requestId, type: 'direction', recommended: true,
      direction: { directionId: null, label: 'Clarify attendance', move: 'clarify', objectiveIds: [], meaning: 'Ask about frequency.', opening: 'How often would I need to attend?', continuation: null, evidence: [{ segmentId: 's1', revision: 1 }], observationIds: [], assumptions: [], status: 'provisional' } }) })
  coordinator.ingest(first, 100); await coordinator.flush()
  for (const row of states) archives.append(id, row)
  const savedState = structuredClone(coordinator.state); coordinator.dispose()
  archives.append(id, { kind: 'transcript', atMs: 2000, segment: { ...first, revision: 2, text: 'We expect regular attendance except after onboarding.', status: 'final' } })
  const future = emptyAnalysis(id); future.openQuestions = ['FUTURE: exception after onboarding']; future.version = 9
  archives.append(id, { kind: 'analysis', atMs: 2100, effectiveMs: 2000, reason: 'track', state: future })
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }))
  return { id, archives, saved: await archives.get(id), savedState }
}

test('saved suggestions replay at their publication position, survive import and preserve direction identities', async () => {
  const f = await fixture(); let state: SuggestionState | null = null
  const replay = new TranscriptReplay(f.saved, f.archives, 10, () => {}, { suggestion: row => { state = row.state } })
  cleanups.unshift(() => replay.shutdown()); void replay.start(); replay.clock(100)
  await until(() => replay.segments.size === 1); expect(state).toBeNull()
  replay.clock(130); await until(() => state !== null)
  expect((state as SuggestionState | null)?.directions[0]?.id).toBe(f.savedState.directions[0]?.id)
  await f.archives.flush(f.id)
  await f.archives.flush(f.id)
  const imported = await f.archives.import(Bun.file(f.archives.path(f.id)).stream())
  const rows: SuggestionRow[] = []; for await (const row of f.archives.events(imported.id)) if (row.kind === 'suggestion') rows.push(row)
  expect(rows.at(-1)?.state.sessionId).toBe(imported.id)
  expect(rows.at(-1)?.state.request?.input.transcript[0]?.sessionId).toBe(imported.id)
})

test('suggestion recomputation and seeking consume only progressively released transcript and analysis', async () => {
  const f = await fixture(); const contexts: SuggestionInput[] = []
  const analysis = emptyAnalysis('playback')
  let coordinator!: SuggestionCoordinator
  const replay = new TranscriptReplay(f.saved, f.archives, 10, payload => { if (payload.type === 'transcript') coordinator.ingest(payload.segment, payload.mediaMs!) }, {
    startMs: 130, suggestionMode: 'predictive', suggestion: () => {}, analysis: () => {},
  })
  analysis.sessionId = replay.view.id
  coordinator = new SuggestionCoordinator({ sessionId: replay.view.id, windowMs: 60_000, analysis: () => analysis, media: () => replay.view.diagnostics.mediaMs,
    generator: async (input, _signal, publish) => { contexts.push(input); publish({ sessionId: input.sessionId, runId: input.runId, requestId: input.requestId, type: 'wait', message: 'Keep listening.' }) }, publish() {} })
  cleanups.unshift(async () => { coordinator.dispose(); await replay.shutdown() })
  void replay.start(); await until(() => replay.segments.size === 1); await coordinator.flush()
  expect(contexts).toHaveLength(1)
  expect(contexts[0]?.transcript.map(s => s.text)).toEqual(['We expect regular attendance'])
  expect(JSON.stringify(contexts)).not.toContain('onboarding'); expect(JSON.stringify(contexts)).not.toContain('FUTURE')
  expect(contexts[0]?.recent).toEqual([]); expect(contexts[0]?.observations).toEqual([])
})

test('saved-call review returns final suggestions and final transcript revisions immediately', async () => {
  const f = await fixture()
  const replay = new TranscriptReplay(f.saved, f.archives, 1, () => { throw new Error('Review must publish one complete snapshot instead.') })
  cleanups.unshift(() => replay.shutdown())
  const final = await replay.inspect()
  expect(final.suggestions?.directions[0]?.id).toBe(f.savedState.directions[0]?.id)
  expect(final.analysis?.version).toBe(9)
  expect(replay.segments.get('s1')?.revision).toBe(2)
})

test('archive imports reject suggestion provenance that refers to a future revision', async () => {
  const f = await fixture()
  const content = await Bun.file(f.archives.path(f.id)).text()
  const rows = content.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  const bad = rows.find(r => r.kind === 'suggestion' && (r.state as SuggestionState).request !== null) as unknown as SuggestionRow
  bad.state.request!.input.transcript[0]!.revision = 999
  await expect(f.archives.import(new Blob([rows.map(r => JSON.stringify(r)).join('\n')]).stream())).rejects.toThrow('future transcript')
})

test('saved suggestion inputs preserve capture timing through validation, library indexing, replay and import', async () => {
  const f = await fixture()
  const rows = (await Bun.file(f.archives.path(f.id)).text()).trim().split('\n').map(line => JSON.parse(line))
  const capture = { startMs: 20, endMs: 100, separation: 'unverified', callTransmission: 'unknown' } as const
  for (const row of rows) {
    if (row.kind === 'transcript') row.segment.capture = capture
    if (row.kind === 'suggestion' && row.state.request) {
      row.state.request.input.transcript.forEach((s: Record<string, unknown>) => { s.capture = capture })
      expect(parseSuggestionRow(row).state.request!.input.transcript[0]!.capture).toEqual(capture)
    }
  }
  await Bun.write(f.archives.path(f.id), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  expect((await f.archives.list()).map(s => s.id)).toContain(f.id)
  const events = await Array.fromAsync(f.archives.events(f.id))
  expect(events.filter(e => e.kind === 'suggestion').length).toBeGreaterThan(0)
  await f.archives.flush(f.id)
  const imported = await f.archives.import(Bun.file(f.archives.path(f.id)).stream())
  const suggestions = (await Array.fromAsync(f.archives.events(imported.id))).filter(e => e.kind === 'suggestion')
  expect(suggestions.at(-1)!.state.request!.input.transcript[0]!.capture).toEqual(capture)
})

test('bilingual reply text and reading language persist through archive import and review', async () => {
  const f = await fixture()
  const state = structuredClone(f.savedState)
  for (const direction of [...state.directions, ...state.history]) {
    direction.language = 'es'; direction.opening = '¿Con qué frecuencia debo ir?'
    direction.translation = { language: 'en', opening: 'How often should I go?', continuation: null }
  }
  state.request!.input.languages = { user: 'en', conversation: 'es', automatic: false }
  state.request!.input.brief.languages.user = 'en'
  f.archives.append(f.id, { kind: 'suggestion', atMs: 2200, reason: 'published', state })
  await f.archives.flush(f.id)
  const imported = await f.archives.import(Bun.file(f.archives.path(f.id)).stream())
  const review = new TranscriptReplay(imported, f.archives, 1, () => {})
  cleanups.unshift(() => review.shutdown())
  const final = await review.inspect()
  expect(final.suggestions!.directions[0]).toMatchObject({ language: 'es', opening: '¿Con qué frecuencia debo ir?', translation: { language: 'en', opening: 'How often should I go?' } })
  expect(final.suggestions!.request!.input.languages).toEqual({ user: 'en', conversation: 'es', automatic: false })
})
