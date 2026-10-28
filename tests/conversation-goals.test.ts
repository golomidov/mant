import { afterEach, expect, test } from 'bun:test'
import { briefWithPeople, emptyAnalysis, emptyBrief, type Objective } from '../shared/analysis'
import { ConversationTracker } from '../server/tracking'
import type { TrackProposal } from '../server/analysis-schema'
import { analysisStateSchema, validate } from '../server/analysis-schema'
import { SuggestionCoordinator } from '../server/suggestions'
import { parseSuggestionRow } from '../server/suggestion-schema'
import type { DirectionDraft, SuggestionInput } from '../shared/suggestions'
import type { Segment } from '../shared/protocol'
import { quickPhrases } from '../shared/quick-phrases'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(f => f()))
const objective = (id: string, description: string): Objective => ({ id, kind: 'say', timing: 'opening', description, completion: 'My speech conveys this fact.', origin: 'explicit', status: 'unexplored', evidence: [], reason: '', history: [] })
function brief() {
  const b = briefWithPeople(emptyBrief())
  b.preparation = 'Before we start, tell them this is my first interview in Italian and my company experience has been in English.'
  b.languages.call = 'it'; b.languages.user = 'en'
  b.objectives = [objective('first', 'Tell them this is my first interview in Italian.'), objective('english', 'Tell them my company experience has been in English.')]
  return b
}
function tracking(options: { who?: 'me' | 'other' | 'unknown'; partial?: boolean; hypothetical?: boolean; quoted?: boolean; gaps?: readonly string[] } = {}) {
  const b = brief()
  const tracker = new ConversationTracker({ sessionId: 'goals', brief: b, windowMs: 60_000, autoTranslate: false,
    interpreter: async (_mode, input) => ({ sessionId: input.request.sessionId, runId: input.request.runId, requestId: input.request.id,
      observations: [{ id: null, type: 'claim', meaning: b.objectives[0]!.description, evidence: input.request.inputs, status: 'established', relations: [{ objectiveId: 'first', relationship: 'expresses' }], attention: 'normal', conditions: [], addressedToUser: false, hypothetical: options.hypothetical ?? false, quoted: options.quoted ?? false, reason: 'Spoken paraphrase.', grounding: { kind: 'direct', quotes: input.transcript.map(s => ({ segmentId: s.id, revision: s.revision, text: s.text })), entityExplanation: 'Attributed speaker.', unresolved: [...options.gaps ?? []] } }],
      objectives: [{ id: 'first', status: 'expressed', evidence: input.request.inputs, reason: 'The user conveyed the meaning in Italian.' }], openQuestions: [], replanReasons: [],
    } satisfies TrackProposal), publish() {} })
  cleanups.push(() => tracker.dispose())
  const s: Segment = { sessionId: 'goals', sourceId: 'local', id: 'speech', revision: 1, order: 0, status: options.partial ? 'partial' : 'final', text: 'È la prima volta che faccio un colloquio in italiano.' }
  tracker.state.attributions.speech = { participantId: options.who === 'unknown' ? null : options.who === 'other' ? 'other' : b.userParticipantId!, sideId: null, sourceLabel: 'Speech', revision: 1 }
  tracker.ingest(s, 100)
  return { tracker, s }
}
test('Italian paraphrase expresses one English communication objective without pinning or acknowledgment', async () => {
  const { tracker, s } = tracking()
  await tracker.flush()
  expect(tracker.state.request?.outcome).toBe('applied')
  expect(tracker.state.brief.objectives.map(o => o.status)).toEqual(['expressed', 'unexplored'])
  tracker.ingest({ ...s, revision: 2, text: 'Non è il mio primo colloquio in italiano.' }, 200)
  expect(tracker.state.brief.objectives[0]!.status).toBe('unexplored')
})
for (const [name, options] of Object.entries({ unknown: { who: 'unknown' }, other: { who: 'other' }, partial: { partial: true }, hypothetical: { hypothetical: true }, quoted: { quoted: true }, incomplete: { gaps: ['Missing completion clause'] } } as const)) {
  test(`${name} speech cannot complete communication objectives`, async () => {
    const { tracker } = tracking(options)
    await tracker.flush()
    expect(tracker.state.brief.objectives[0]!.status).not.toBe('expressed')
  })
}
test('attribution correction reopens Said; manual completion uses Said', async () => {
  const { tracker } = tracking()
  await tracker.flush()
  tracker.attribute(['speech'], null, null, 'Unknown', 200)
  expect(tracker.state.brief.objectives[0]!.status).not.toBe('expressed')
  const o = tracker.state.brief.objectives[0]!
  tracker.confirmObjective(o.id, tracker.state.brief.version, o.evidence, 250)
  expect(tracker.state.brief.objectives[0]).toMatchObject({ status: 'expressed', confirmedByUser: true })
})
function preparation(onGenerate?: (input: SuggestionInput) => Promise<void>) {
  const analysis = emptyAnalysis('goals', brief())
  const coordinator = new SuggestionCoordinator({ sessionId: 'goals', analysis: () => analysis, media: () => 0, windowMs: 60_000,
    generator: async (input, _signal, publish) => {
      await onGenerate?.(input)
      const original = input.rephrase?.direction
      const direction: DirectionDraft = original ? { ...original, directionId: original.id, opening: 'È il mio primo colloquio in italiano; ho lavorato in inglese.', translation: { language: 'en', opening: 'It is my first interview in Italian; I have worked in English.', continuation: null } } : {
        directionId: null, label: 'Introduce my language experience', move: 'explain', objectiveIds: ['first', 'english'], meaning: 'Share my interview and working languages.', opening: 'Prima di iniziare, è il mio primo colloquio in italiano; nelle aziende ho lavorato in inglese.', continuation: null, language: 'it', translation: { language: 'en', opening: 'Before we start, this is my first interview in Italian; in companies I have worked in English.', continuation: null }, evidence: [], observationIds: [], basis: 'brief', briefReferences: ['first', 'english'], assumptions: [], status: 'ready',
      }
      // Rephrase direction snapshots carry coordinator metadata; publish only draft fields.
      const { directionId, label, move, objectiveIds, meaning, opening, continuation, language, translation, evidence, observationIds, basis, briefReferences, assumptions, status } = direction
      publish({ sessionId: input.sessionId, runId: input.runId, requestId: input.requestId, type: 'direction', recommended: true, direction: { directionId, label, move, objectiveIds, meaning, opening, continuation, language, translation, evidence, observationIds, basis, briefReferences, assumptions, status } })
      if (!original) publish({ sessionId: input.sessionId, runId: input.runId, requestId: input.requestId, type: 'direction', recommended: false, direction: { ...direction, label: 'Ask about the format', move: 'check', objectiveIds: [], meaning: 'Ask how the interview will proceed.', opening: 'Come si svolgerà il colloquio?', translation: { language: 'en', opening: 'How will the interview proceed?', continuation: null } } })
    }, publish() {} })
  cleanups.push(() => coordinator.dispose())
  coordinator.analysisChanged('brief_model')
  return { coordinator, analysis }
}
test('opening preparation has brief provenance, no fabricated speech, and round trips through archive validation', async () => {
  const { coordinator } = preparation()
  await coordinator.flush()
  expect(coordinator.state.directions).toHaveLength(2)
  expect(coordinator.state.directions[0]).toMatchObject({ objectiveIds: ['first', 'english'], evidence: [], provenance: { basis: 'brief', briefReferences: ['first', 'english'], inputs: [] } })
  expect(parseSuggestionRow({ kind: 'suggestion', atMs: 0, reason: 'published', state: coordinator.state }).state.directions).toHaveLength(2)
})
for (const transformation of ['simpler', 'shorter', 'alternative'] as const) test(`${transformation} replaces only its target and preserves intent and references`, async () => {
  const { coordinator } = preparation()
  await coordinator.flush()
  const [first, sibling] = structuredClone(coordinator.state.directions)
  coordinator.rephrase(first!.id, first!.version, transformation)
  await coordinator.flush()
  expect(coordinator.state.request?.outcome).toBe('complete')
  expect(coordinator.state.directions[0]).toMatchObject({ id: first!.id, version: first!.version + 1, meaning: first!.meaning, objectiveIds: first!.objectiveIds, briefReferences: first!.briefReferences, assumptions: first!.assumptions })
  expect(coordinator.state.directions[1]).toEqual(sibling)
  expect(() => coordinator.rephrase(first!.id, first!.version, transformation)).toThrow('changed')
})
test('brief edits invalidate openings while missed opening objectives remain pending', async () => {
  const { coordinator, analysis } = preparation()
  await coordinator.flush()
  analysis.brief.version++
  analysis.brief.objectives[0]!.description = 'Changed fact'
  coordinator.analysisChanged('brief_user')
  expect(coordinator.state.directions.every(d => d.lifecycle === 'reassess')).toBe(true)
  expect(analysis.brief.objectives.every(o => o.status === 'unexplored')).toBe(true)
})
test('legacy archives retain objective kind, absent timing, and transcript provenance interpretation', () => {
  const state = emptyAnalysis('legacy')
  state.brief.objectives = [{ ...objective('legacy', 'Learn the interview language.'), kind: 'question' }]
  delete state.brief.objectives[0]!.timing
  const restored = validate(analysisStateSchema, state)
  expect(restored.brief.objectives[0]!.kind).toBe('question')
  expect(restored.brief.objectives[0]!.timing).toBeUndefined()
})
test('quick phrases cover all supported languages and remain independent of objectives', () => {
  expect(Object.keys(quickPhrases).sort()).toEqual(['de', 'en', 'es', 'fr', 'it', 'ru'])
  for (const phrases of Object.values(quickPhrases)) expect(phrases).toHaveLength(5)
  expect(emptyBrief().objectives).toEqual([])
})

test('brief changes discard a rephrase already in flight without replacing siblings', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { coordinator, analysis } = preparation(async input => { if (input.rephrase) await gate })
  await coordinator.flush()
  const original = structuredClone(coordinator.state.directions)
  coordinator.rephrase(original[0]!.id, original[0]!.version, 'simpler')
  const work = coordinator.flush()
  analysis.brief.version++
  coordinator.analysisChanged('brief_user')
  release(); await work
  expect(coordinator.state.request?.outcome).toBe('obsolete')
  expect(coordinator.state.directions.map(d => [d.id, d.version, d.opening])).toEqual(original.map(d => [d.id, d.version, d.opening]))
})

test('unknown conversation language prepares in My language and regenerates when speech language becomes known', async () => {
  const analysis = emptyAnalysis('goals', brief())
  analysis.brief.languages.call = ''
  const languages: string[] = []
  const coordinator = new SuggestionCoordinator({ sessionId: 'goals', analysis: () => analysis, media: () => 0, windowMs: 60_000,
    generator: async (input, _signal, publish) => {
      const language = input.languages!.conversation || input.languages!.user
      languages.push(language)
      publish({ sessionId: input.sessionId, runId: input.runId, requestId: input.requestId, type: 'direction', recommended: true, direction: { directionId: null, label: 'Introduce myself', move: 'explain', objectiveIds: ['first'], meaning: 'Disclose my first Italian interview.', opening: language === 'it' ? 'È il mio primo colloquio in italiano.' : 'This is my first interview in Italian.', continuation: null, language, translation: language === 'en' ? null : { language: 'en', opening: 'This is my first interview in Italian.', continuation: null }, evidence: [], observationIds: [], basis: 'brief', briefReferences: ['first'], assumptions: [], status: 'ready' } })
    }, publish() {} })
  cleanups.push(() => coordinator.dispose())
  coordinator.analysisChanged('brief_model'); await coordinator.flush()
  expect(coordinator.state.directions[0]!.language).toBe('en')
  analysis.detectedLanguage = 'it'
  coordinator.analysisChanged('track')
  expect(coordinator.state.directions[0]!.lifecycle).toBe('reassess')
  await coordinator.flush()
  expect(languages).toEqual(['en', 'it'])
  expect(coordinator.state.directions[0]!.language).toBe('it')
})

test('saved replay never generates preparation or rephrasing', async () => {
  let calls = 0
  const analysis = emptyAnalysis('goals', brief())
  const coordinator = new SuggestionCoordinator({ sessionId: 'goals', mode: 'saved', analysis: () => analysis, media: () => 0, generator: async () => { calls++ }, publish() {} })
  cleanups.push(() => coordinator.dispose())
  coordinator.analysisChanged('brief_model'); coordinator.another(); await coordinator.flush()
  expect(calls).toBe(0)
  expect(() => coordinator.rephrase('saved', 1, 'shorter')).toThrow('read-only')
})
