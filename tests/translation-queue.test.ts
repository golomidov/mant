import { afterEach, expect, test } from 'bun:test'
import { ConversationTracker } from '../server/tracking'
import { emptyBrief } from '../shared/analysis'
import type { Segment } from '../shared/protocol'
import type { Translator } from '../server/translation'

const trackers: ConversationTracker[] = []
afterEach(() => trackers.splice(0).forEach(t => t.dispose()))
const segment = (id: string, revision = 1, status: Segment['status'] = 'final'): Segment => ({ sessionId: 'translation', sourceId: 'audio', id, order: Number(id.slice(1)) || 0, revision, status, text: `Русское сообщение ${id}, версия ${revision}.` })
function setup(translator: Translator, enabled = true, options: { autoTranslate?: boolean; windowMs?: number; translationMinIntervalMs?: number } = {}) {
  const brief = emptyBrief(); brief.languages = { ...brief.languages, user: 'en', call: 'ru' }
  const tracker = new ConversationTracker({ sessionId: 'translation', brief, translator, enabled, windowMs: 60_000, ...options, interpreter: async () => { throw new Error('Tracking failed') }, publish() {} })
  trackers.push(tracker); return tracker
}
const translated: Translator = async input => input.segments.map(s => ({ segmentId: s.id, revision: s.revision, sourceLanguage: 'ru', text: `English ${s.id} revision ${s.revision}.` }))
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

test('translation pacing coalesces revisions and an explicit retry bypasses the automatic delay', async () => {
  let calls = 0
  const t = setup(async (input, signal) => { calls++; return translated(input, signal) }, false, { windowMs: 1, translationMinIntervalMs: 100 })
  t.ingest(segment('s1', 1, 'partial'), 0); await t.flushTranslations()
  t.ingest(segment('s1', 2, 'partial'), 10); t.ingest(segment('s1', 3, 'partial'), 20)
  await Bun.sleep(12)
  expect(calls).toBe(1)
  await t.retryTranslations()
  expect(calls).toBe(2)
  expect(t.state.translations?.s1?.revision).toBe(3)
})

test('every Russian message translates despite failed tracking, in bounded batches, including short replies', async () => {
  const sizes: number[] = []
  const t = setup(async (input, signal) => { sizes.push(input.segments.length); return translated(input, signal) })
  for (let i = 0; i < 21; i++) t.ingest({ ...segment(`s${i}`), ...(i === 0 ? { text: 'Да.' } : {}) }, i * 100)
  await t.flush()
  expect(t.state.status).toBe('error')
  for (let i = 0; i < 3; i++) await t.flushTranslations()
  expect(sizes).toEqual([8, 8, 5])
  expect(Object.keys(t.state.translations!)).toHaveLength(21)
  expect(t.state.translations!.s0!.targetLanguage).toBe('en')
})

test('a revised segment does not discard translations for the other messages in flight', async () => {
  const pause = gate()
  const t = setup(async (input, signal) => { await pause.promise; return translated(input, signal) })
  t.ingest(segment('s1'), 0); t.ingest(segment('s2', 1, 'partial'), 10)
  const flight = t.flushTranslations()
  t.ingest(segment('s2', 2), 20); t.ingest(segment('s3'), 30)
  pause.resolve(); await flight
  expect(t.state.translations?.s1?.text).toBe('English s1 revision 1.')
  expect(t.state.translations?.s2).toBeUndefined()
  await t.flushTranslations()
  expect(t.state.translations?.s2?.revision).toBe(2)
  expect(t.state.translations?.s3).toBeDefined()
})

test('text-identical finalization reuses an already completed translation; actual text corrections still translate', async () => {
  let calls = 0
  const t = setup(async (input, signal) => { calls++; return translated(input, signal) })
  const partial = segment('s1', 1, 'partial')
  t.ingest(partial, 10); await t.flushTranslations()
  t.ingest({ ...partial, revision: 2, status: 'final' }, 20); await t.flushTranslations()
  expect(calls).toBe(1)
  expect(t.state.translations?.s1?.revision).toBe(2)
  t.ingest({ ...partial, text: 'Исправленный текст.', revision: 3, status: 'final' }, 30); await t.flushTranslations()
  expect(calls).toBe(2)
  expect(t.state.translations?.s1?.revision).toBe(3)
})

test('same-language detection results are reused through text-identical ASR finalization', async () => {
  let calls = 0
  const t = setup(async input => { calls++; return input.segments.map(s => ({ segmentId: s.id, revision: s.revision, sourceLanguage: 'en', text: '' })) })
  const partial = { ...segment('s1', 1, 'partial'), text: 'English speech.' }
  t.ingest(partial, 10); await t.flushTranslations()
  t.ingest({ ...partial, revision: 2, status: 'final' }, 20); await t.flushTranslations()
  expect(calls).toBe(1)
  expect(t.state.translations?.s1).toBeUndefined()
})

test('saved playback translates without recomputing understanding and retains translations across saved snapshots', async () => {
  const t = setup(translated, false)
  t.ingest(segment('s1'), 0)
  const saved = structuredClone(t.state)
  await t.flushTranslations()
  expect(t.state.translations?.s1).toBeDefined()
  t.restore(saved)
  expect(t.state.translations?.s1).toBeDefined()
  expect(t.state.request).toBeNull()
})

test('idle saved-call review preserves saved translations without model calls; an explicit retry drains missing translations', async () => {
  let calls = 0
  const t = setup(async (input, signal) => { calls++; return translated(input, signal) }, false, { autoTranslate: false, windowMs: 5 })
  for (let i = 0; i < 12; i++) t.ingest(segment(`s${i}`), i * 10)
  const saved = structuredClone(t.state)
  saved.translations = { s0: { revision: 1, sourceLanguage: 'ru', targetLanguage: 'en', text: 'Saved translation.' } }
  t.restore(saved)
  const edited = { ...structuredClone(t.state.brief), preparation: 'Change only the goal.' }
  t.editBrief(edited, edited.version)
  await Bun.sleep(25)
  expect(calls).toBe(0)
  expect(t.state.translations?.s0?.text).toBe('Saved translation.')
  expect(t.state.translationStatus).toBe('idle')
  await t.retryTranslations(); await Bun.sleep(25)
  expect(calls).toBe(2)
  expect(Object.keys(t.state.translations!)).toHaveLength(12)
  expect(t.state.request).toBeNull()
  const changedLanguage = structuredClone(t.state.brief); changedLanguage.languages.user = 'fr'
  t.editBrief(changedLanguage, changedLanguage.version)
  await Bun.sleep(25)
  expect(calls).toBe(4)
  expect(t.state.translations?.s0?.targetLanguage).toBe('fr')
})

test('language changes invalidate in-flight translations and translate the available history in the new reading language', async () => {
  const pause = gate()
  const t = setup(async (input, signal) => { await pause.promise; return translated(input, signal) })
  t.ingest(segment('s1'), 0)
  const flight = t.flushTranslations()
  const brief = structuredClone(t.state.brief); brief.languages.user = 'de'
  t.editBrief(brief, brief.version)
  pause.resolve(); await flight
  expect(t.state.translations).toEqual({})
  await t.flushTranslations()
  expect(t.state.translations?.s1?.targetLanguage).toBe('de')
})

test('translation errors remain retryable and same-language settings require no model request', async () => {
  let fail = true; let calls = 0
  const t = setup(async (input, signal) => { calls++; if (fail) throw new Error('Provider error'); return translated(input, signal) })
  t.ingest(segment('s1'), 0); await t.flushTranslations()
  expect(t.state.translationStatus).toBe('error')
  fail = false; await t.retryTranslations()
  expect(t.state.translations?.s1).toBeDefined()
  const brief = structuredClone(t.state.brief); brief.languages.user = 'ru'; t.editBrief(brief, brief.version)
  t.ingest(segment('s2'), 20); await t.flushTranslations()
  expect(calls).toBe(2)
})

test('switching to equal languages during translation clears the busy state and rejects the old result', async () => {
  const pause = gate()
  const t = setup(async (input, signal) => { await pause.promise; return translated(input, signal) })
  t.ingest(segment('s1'), 0)
  const flight = t.flushTranslations()
  const brief = structuredClone(t.state.brief); brief.languages.user = 'ru'; t.editBrief(brief, brief.version)
  pause.resolve(); await flight
  expect(t.state.translations).toEqual({})
  expect(t.state.translationStatus).toBe('idle')
})

test('continuous append-only speech publishes translations before the provider finalizes the turn', async () => {
  const pause = gate()
  const t = setup(async (input, signal) => { await pause.promise; return translated(input, signal) })
  const speech = { ...segment('s1', 1, 'partial'), text: 'Я живу в Мадриде' }
  t.ingest(speech, 0)
  const flight = t.flushTranslations()
  for (let revision = 2; revision <= 20; revision++) t.ingest({ ...speech, revision, text: speech.text + ' и продолжаю говорить'.repeat(revision) }, revision * 100)
  pause.resolve(); await flight
  expect(t.state.translations?.s1).toMatchObject({ revision: 1, sourceText: speech.text, text: 'English s1 revision 1.' })
  const { translationMatches } = await import('../shared/translations')
  const current = { ...speech, revision: 20, text: speech.text + ' и продолжаю говорить'.repeat(20) }
  expect(translationMatches(t.state.translations?.s1, current)).toBe(true)
  // A new suffix keeps already translated speech visible while catching up.
  t.ingest({ ...current, revision: 21, text: current.text + '.' }, 2100)
  expect(t.state.translations?.s1?.text).toBe('English s1 revision 1.')
  await t.flushTranslations()
  expect(t.state.translations?.s1?.revision).toBe(21)
  // Replacing that source prefix withdraws it immediately, including in the UI
  // before the lower-priority analysis update arrives.
  const correction = { ...current, revision: 22, text: 'Я не живу в Мадриде.' }
  expect(translationMatches(t.state.translations?.s1, correction)).toBe(false)
  t.ingest(correction, 2200)
  expect(t.state.translations?.s1).toBeUndefined()
})

test('text-identical ASR finalization accepts in-flight translation without another model call', async () => {
  const pause = gate(); let calls = 0
  const t = setup(async (input, signal) => { calls++; await pause.promise; return translated(input, signal) })
  const speech = segment('s1', 1, 'partial')
  t.ingest(speech, 0)
  const flight = t.flushTranslations()
  t.ingest({ ...speech, revision: 2, status: 'final' }, 10)
  pause.resolve(); await flight
  expect(t.state.translations?.s1?.revision).toBe(2)
  await t.flushTranslations()
  expect(calls).toBe(1)
})
