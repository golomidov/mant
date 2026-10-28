import { afterEach, expect, test } from 'bun:test'
import { emptyBrief } from '../shared/analysis'
import { languageCode, languageSettings, recognitionLanguages, supportedLanguages } from '../shared/languages'
import { ConversationTracker } from '../server/tracking'
import type { InterpretationInput, Interpreter } from '../server/interpretation'
import type { Segment } from '../shared/protocol'
import { Archives } from '../server/archive'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const trackers: ConversationTracker[] = []
afterEach(() => trackers.splice(0).forEach(t => t.dispose()))
const segment = (text: string, revision = 1): Segment => ({ sessionId: 'languages', sourceId: 'audio', id: 'speech', order: 0, revision, text, status: 'final' })
const result = (input: InterpretationInput) => ({ sessionId: input.request.sessionId, runId: input.request.runId, requestId: input.request.id, observations: [], objectives: [], openQuestions: [], replanReasons: [] })
function tracker(interpreter: Interpreter, conversation = '') {
  const brief = emptyBrief()
  brief.languages.user = 'en'; brief.languages.call = conversation
  brief.objectives = [{ id: 'city', kind: 'question', description: 'Which city does the speaker live in?', completion: 'The city is named in the call.', origin: 'explicit', status: 'unexplored', evidence: [], reason: '', history: [] }]
  const t = new ConversationTracker({ sessionId: 'languages', brief, interpreter, windowMs: 60_000, publish() {} })
  trackers.push(t); return t
}

test('language choices include Russian and use English as the reading default', () => {
  expect(supportedLanguages.map(l => l.code)).toEqual(['en', 'it', 'es', 'fr', 'de', 'ru'])
  expect(languageCode('Italian')).toBe('it')
  expect(languageCode('en-US')).toBe('en')
  expect(languageCode('français')).toBe('fr')
  expect(languageCode('Russian')).toBe('ru')
  expect(languageCode('Русский')).toBe('ru')
  expect(languageCode('ru-RU')).toBe('ru')
  expect(recognitionLanguages('Spanish')).toEqual(['es'])
  expect(recognitionLanguages('Russian')).toEqual(['ru'])
  expect(recognitionLanguages('')).toEqual(['en', 'it', 'es', 'fr', 'de', 'ru'])
  expect(languageSettings(emptyBrief())).toEqual({ user: 'en', conversation: '', automatic: true })
})

test('building objectives cannot replace Auto or explicit language settings with the language of the brief', async () => {
  const t = tracker(async (_mode, input) => ({ sessionId: input.request.sessionId, runId: input.request.runId, requestId: input.request.id, items: [], objectives: [], sides: [], participants: [], clarifications: [], languages: { call: 'English', user: 'English' } }))
  t.state.brief.languages.user = 'fr'
  await t.extractBrief()
  expect(t.state.brief.languages.call).toBe('')
  expect(t.state.brief.languages.user).toBe('fr')
  const brief = structuredClone(t.state.brief); brief.languages.call = 'de'; t.editBrief(brief, brief.version)
  await t.extractBrief()
  expect(t.state.brief.languages.call).toBe('de')
  expect(t.state.brief.languages.user).toBe('fr')
})

for (const [code, speech] of [['en', 'I live in Madrid.'], ['it', 'Vivo a Madrid.'], ['es', 'Vivo en Madrid.'], ['fr', "Je vis à Madrid."], ['de', 'Ich wohne in Madrid.'], ['ru', 'Я живу в Мадриде.']] as const) {
  test(`English objectives can use ${code} speech while translation remains separate from original evidence`, async () => {
    const t = tracker(async (_mode, input) => ({ ...result(input), detectedLanguage: code,
      translations: [{ segmentId: 'speech', revision: 1, sourceLanguage: code, targetLanguage: 'en', text: 'I live in Madrid.' }],
      observations: [{ id: null, type: 'claim', meaning: 'The speaker lives in Madrid.', evidence: input.request.inputs, status: 'established', relations: [{ objectiveId: 'city', relationship: 'answers' }], attention: 'normal', conditions: [], addressedToUser: false, hypothetical: false, quoted: false, reason: 'The city is stated.', grounding: { kind: 'direct', quotes: [{ segmentId: 'speech', revision: 1, text: speech }], entityExplanation: 'A first-person statement.', unresolved: [] } }],
      objectives: [{ id: 'city', status: 'answered', evidence: input.request.inputs, reason: 'The city was named.' }],
    }))
    const original = segment(speech)
    t.ingest(original, 100); await t.flush()
    expect(t.state.request?.outcome).toBe('applied')
    expect(t.state.brief.objectives[0]!.status).toBe('answered')
    expect(t.state.brief.objectives[0]!.description).toBe('Which city does the speaker live in?')
    expect(t.state.observations[0]!.grounding!.quotes[0]!.text).toBe(speech)
    expect(original.text).toBe(speech)
    expect(t.state.detectedLanguage).toBe(code)
    if (code === 'en') expect(t.state.translations?.speech).toBeUndefined()
    else expect(t.state.translations?.speech?.text).toBe('I live in Madrid.')
  })
}

test('same-language settings suppress translations and changing My language clears old translations and protects the choice', async () => {
  const t = tracker(async (_mode, input) => ({ ...result(input), detectedLanguage: 'es', translations: [{ segmentId: 'speech', revision: 1, sourceLanguage: 'es', targetLanguage: input.languages!.user, text: 'I live in Madrid.' }] }), 'es')
  t.ingest(segment('Vivo en Madrid.'), 100); await t.flush()
  expect(t.state.translations?.speech).toBeDefined()
  const brief = structuredClone(t.state.brief); brief.languages.user = 'es'
  t.editBrief(brief, brief.version)
  expect(t.state.translations).toEqual({})
  expect(t.state.brief.protectedIds).toContain('language:user')
  await t.flush()
  expect(t.state.translations).toEqual({})
})

test('transcript revisions hide old translations immediately and future translation references reject atomically', async () => {
  const t = tracker(async (_mode, input) => ({ ...result(input), detectedLanguage: 'es', translations: [{ segmentId: 'speech', revision: input.request.inputs[0]!.revision, sourceLanguage: 'es', targetLanguage: 'en', text: 'I live in Madrid.' }] }))
  t.ingest(segment('Vivo en Madrid.'), 100); await t.flush()
  expect(t.state.translations?.speech?.revision).toBe(1)
  t.ingest(segment('Vivo en Valencia.', 2), 200)
  expect(t.state.translations?.speech).toBeUndefined()
  const bad = tracker(async (_mode, input) => ({ ...result(input), translations: [{ segmentId: 'speech', revision: 99, sourceLanguage: 'es', targetLanguage: 'en', text: 'Invented future translation.' }] }))
  bad.ingest(segment('Vivo en Madrid.'), 100); await bad.flush()
  expect(bad.state.request?.outcome).toBe('error')
  expect(bad.state.translations).toBeUndefined()
})

test('Auto detects a switch between supported languages while an explicit setting remains authoritative', async () => {
  let detected = 'en'
  const t = tracker(async (_mode, input) => ({ ...result(input), detectedLanguage: detected, translations: detected === 'fr' ? [{ segmentId: 'speech', revision: 2, sourceLanguage: 'fr', targetLanguage: 'en', text: 'I live in Madrid.' }] : [] }))
  t.ingest(segment('I live in Madrid.'), 100); await t.flush()
  expect(t.state.detectedLanguage).toBe('en')
  detected = 'fr'; t.ingest(segment("Je vis à Madrid.", 2), 200); await t.flush()
  expect(languageSettings(t.state.brief, t.state.detectedLanguage).conversation).toBe('fr')
  expect(t.state.translations?.speech?.sourceLanguage).toBe('fr')
  const edited = structuredClone(t.state.brief); edited.languages.call = 'it'; t.editBrief(edited, edited.version)
  expect(languageSettings(t.state.brief, t.state.detectedLanguage).conversation).toBe('it')
  const unsupported = structuredClone(t.state.brief); unsupported.languages.user = 'ja'
  expect(() => t.editBrief(unsupported, unsupported.version)).toThrow('Choose a supported language')
})

test('translations and detection survive archive import and saved review without changing original speech', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mant-language-archive-'))
  try {
    const archives = new Archives(directory); const id = crypto.randomUUID()
    const t = tracker(async (_mode, input) => ({ ...result(input), detectedLanguage: 'es', translations: [{ segmentId: 'speech', revision: 1, sourceLanguage: 'es', targetLanguage: 'en', text: 'I live in Madrid.' }] }))
    const speech = segment('Vivo en Madrid.'); t.ingest(speech, 100); await t.flush()
    const state = structuredClone(t.state); state.sessionId = id; state.request!.sessionId = id
    archives.create(id, { id: 'a'.repeat(64), name: 'Spanish call.wav', size: 0, replayId: id })
    archives.append(id, { kind: 'transcript', atMs: 100, segment: { ...speech, sourceId: 'a'.repeat(64), sessionId: id } })
    archives.append(id, { kind: 'analysis', atMs: 100, effectiveMs: 100, reason: 'track', state })
    await archives.flush(id)
    const imported = await archives.import(Bun.file(archives.path(id)).stream())
    const events = await Array.fromAsync(archives.events(imported.id))
    const saved = events.find(e => e.kind === 'analysis')!
    if (saved.kind !== 'analysis') throw new Error('Missing saved analysis')
    expect(saved.state.translations?.speech).toEqual(state.translations!.speech)
    expect(saved.state.detectedLanguage).toBe('es')
    expect((await Array.fromAsync(archives.updates(imported.id)))[0]!.segment.text).toBe('Vivo en Madrid.')
    state.translations!.speech!.revision = 99
    const invalid = crypto.randomUUID(); archives.create(invalid, { id: 'a'.repeat(64), name: 'Invalid.wav', size: 0, replayId: invalid })
    archives.append(invalid, { kind: 'transcript', atMs: 100, segment: { ...speech, sourceId: 'a'.repeat(64), sessionId: invalid } })
    state.sessionId = invalid
    archives.append(invalid, { kind: 'analysis', atMs: 100, effectiveMs: 100, reason: 'track', state })
    await archives.flush(invalid)
    await expect(archives.import(Bun.file(archives.path(invalid)).stream())).rejects.toThrow('missing or future')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
