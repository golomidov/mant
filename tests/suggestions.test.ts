import { afterEach, expect, test } from 'bun:test'
import { SuggestionCoordinator } from '../server/suggestions'
import { SuggestionDecoder, type SuggestGenerator } from '../server/suggestion-model'
import { ConversationTracker } from '../server/tracking'
import { type SuggestionInput, type SuggestionState } from '../shared/suggestions'
import { emptyAnalysis, type AnalysisState } from '../shared/analysis'
import type { Segment } from '../shared/protocol'
import type { Objective } from '../shared/analysis'
const goal = (id: string): Objective => ({ id, kind: 'question', description: 'Clarify office frequency', completion: 'Know ongoing and onboarding attendance requirements', origin: 'explicit', status: 'unexplored', evidence: [], reason: '', history: [] })
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(f => f()))
const segment = (text: string, revision = 1, status: Segment['status'] = 'partial', id = 's1', order = 0): Segment => ({ sessionId: 'session', sourceId: 'audio', id, order, revision, text, status })
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
function draft(input: SuggestionInput, recommended = true, opening = 'How often would I need to be in the office?') {
  return { sessionId: input.sessionId, runId: input.runId, requestId: input.requestId, type: 'direction', recommended,
    direction: { directionId: null, label: recommended ? 'Clarify frequency' : 'Clarify exceptions', move: 'clarify', objectiveIds: ['question'], meaning: 'Clarify the attendance condition.', opening, continuation: null, evidence: input.transcript.map(s => ({ segmentId: s.id, revision: s.revision })), observationIds: [], assumptions: ['The attendance condition is still developing.'], status: 'ready' } }
}
function setup(generator: SuggestGenerator, options: { mode?: 'predictive' | 'baseline'; windowMs?: number; minIntervalMs?: number } = {}) {
  const analysis = emptyAnalysis('session'); analysis.brief.objectives = [goal('question')]
  const states: SuggestionState[] = []; let media = 100; let now = 10
  const coordinator = new SuggestionCoordinator({ sessionId: 'session', mode: options.mode, windowMs: options.windowMs ?? 60_000, minIntervalMs: options.minIntervalMs, generator, analysis: () => analysis, media: () => media, now: () => now, publish: state => states.push(state) })
  cleanups.push(() => coordinator.dispose())
  return { coordinator, analysis, states, media: (value: number) => { media = value }, now: (value: number) => { now = value } }
}

test('automatic updates are paced, invalidate stale wording immediately, and explicit another bypasses a queued delay', async () => {
  let calls = 0
  const f = setup(async (input, _signal, publish) => { calls++; publish(draft(input, true, calls === 1 ? 'How often is office attendance required?' : 'Which exceptions are possible?')) }, { windowMs: 1, minIntervalMs: 100 })
  f.coordinator.ingest(segment('Office attendance is required regularly.', 1), 100)
  await f.coordinator.flush()
  f.now(20)
  f.coordinator.ingest(segment('Office attendance is required regularly, with exceptions.', 2), 200)
  expect(f.coordinator.state.directions[0]?.lifecycle).toBe('reassess')
  await Bun.sleep(12)
  expect(calls).toBe(1)
  f.coordinator.another()
  await Bun.sleep(12)
  expect(calls).toBe(2)
  expect(f.coordinator.state.request?.input.transcript[0]?.revision).toBe(2)
})

test('replies use the conversation language and preserve a separate translation into My language', async () => {
  const f = setup(async (input, _signal, publish) => {
    expect(input.languages).toMatchObject({ user: 'en', conversation: 'es' })
    const record = draft(input, true, '¿Con qué frecuencia tendría que ir a la oficina?')
    publish({ ...record, direction: { ...record.direction, continuation: '¿Y durante la incorporación?', language: 'es', translation: { language: 'en', opening: 'How often would I need to go to the office?', continuation: 'And during onboarding?' } } })
  })
  f.analysis.brief.languages = { ...f.analysis.brief.languages, user: 'en', call: 'es' }
  f.coordinator.ingest(segment('Esperamos asistencia presencial regularmente.', 1, 'final'), 100)
  await f.coordinator.flush()
  expect(f.coordinator.state.directions[0]).toMatchObject({ language: 'es', opening: '¿Con qué frecuencia tendría que ir a la oficina?', translation: { language: 'en', opening: 'How often would I need to go to the office?', continuation: 'And during onboarding?' } })
})

test('goal autosaves preserve pinned replies and never trigger another generation', async () => {
  let calls = 0
  const f = setup(async (input, _signal, publish) => {
    calls++
    expect(input.brief.preparation).toBe('')
    expect(input.brief.answers).toBe('')
    publish(draft(input))
  }, { windowMs: 5 })
  const tracker = new ConversationTracker({ sessionId: 'session', brief: f.analysis.brief, enabled: false,
    publish(state, reason) { Object.assign(f.analysis, state); f.coordinator.analysisChanged(reason) },
  })
  cleanups.push(() => tracker.dispose())
  tracker.publishInitial()
  f.coordinator.ingest(segment('Office attendance is expected.', 1, 'final'), 100)
  await f.coordinator.flush()
  const first = f.coordinator.state.directions[0]!
  f.coordinator.select(first.id, first.version)
  const selected = structuredClone(f.coordinator.state.selected)
  const edited = { ...structuredClone(tracker.state.brief), preparation: 'New goal still being written.', answers: 'New instructions.' }
  tracker.editBrief(edited, edited.version)
  await Bun.sleep(25)
  expect(calls).toBe(1)
  expect(f.coordinator.state.directions[0]?.lifecycle).toBe('active')
  expect(f.coordinator.state.selected).toEqual(selected)
})

test('goal autosaves do not obsolete in-flight reply generation', async () => {
  const waiting = gate()
  let calls = 0
  const f = setup(async (input, _signal, publish) => { calls++; await waiting.promise; publish(draft(input)) }, { windowMs: 5 })
  const tracker = new ConversationTracker({ sessionId: 'session', brief: f.analysis.brief, enabled: false,
    publish(state, reason) { Object.assign(f.analysis, state); f.coordinator.analysisChanged(reason) },
  })
  cleanups.push(() => tracker.dispose())
  tracker.publishInitial()
  f.coordinator.ingest(segment('Office attendance is expected.', 1, 'final'), 100)
  const flight = f.coordinator.flush()
  const edited = { ...structuredClone(tracker.state.brief), preparation: 'An unfinished new goal.' }
  tracker.editBrief(edited, edited.version)
  waiting.resolve(); await flight; await Bun.sleep(25)
  expect(calls).toBe(1)
  expect(f.coordinator.state.request?.outcome).toBe('complete')
  expect(f.coordinator.state.directions[0]?.lifecycle).toBe('active')
})

test('same-language replies suppress duplicate translations and mismatched-language replies cannot publish', async () => {
  const same = setup(async (input, _signal, publish) => {
    const record = draft(input)
    publish({ ...record, direction: { ...record.direction, language: 'en', translation: { language: 'en', opening: record.direction.opening, continuation: null } } })
  })
  same.analysis.brief.languages = { ...same.analysis.brief.languages, user: 'en', call: 'en' }
  same.coordinator.ingest(segment('We expect regular office attendance.', 1, 'final'), 100)
  await same.coordinator.flush()
  expect(same.coordinator.state.directions[0]?.translation).toBeNull()
  const wrong = setup(async (input, _signal, publish) => publish({ ...draft(input), direction: { ...draft(input).direction, language: 'en', translation: null } }))
  wrong.analysis.brief.languages.call = 'es'
  wrong.coordinator.ingest(segment('Esperamos asistencia presencial regularmente.', 1, 'final'), 100)
  await wrong.coordinator.flush()
  expect(wrong.coordinator.state.request?.outcome).toBe('error')
  expect(wrong.coordinator.state.directions).toEqual([])
})

test('Russian replies have English translations, and Russian-to-Russian replies omit translations', async () => {
  for (const user of ['en', 'ru']) {
    const f = setup(async (input, _signal, publish) => {
      const record = draft(input, true, 'Как часто нужно приходить в офис?')
      publish({ ...record, direction: { ...record.direction, language: 'ru', translation: user === 'en' ? { language: 'en', opening: 'How often do I need to come to the office?', continuation: null } : null } })
    })
    f.analysis.brief.languages = { ...f.analysis.brief.languages, user, call: 'ru' }
    f.coordinator.ingest(segment('Мы ожидаем регулярного присутствия в офисе.', 1, 'final'), 100)
    await f.coordinator.flush()
    expect(f.coordinator.state.request?.outcome).toBe('complete')
    expect(f.coordinator.state.directions[0]?.language).toBe('ru')
    if (user === 'en') expect(f.coordinator.state.directions[0]?.translation?.opening).toBe('How often do I need to come to the office?')
    else expect(f.coordinator.state.directions[0]?.translation).toBeNull()
  }
})

test('Generate another replaces a pinned reply and explicitly asks for a different approach', async () => {
  const inputs: SuggestionInput[] = []
  const f = setup(async (input, _signal, publish) => {
    inputs.push(input)
    const record = draft(input, true, input.generation ? 'Are there exceptions during onboarding?' : undefined)
    if (input.generation) record.direction.meaning = 'Explore exceptions during onboarding.'
    publish(record)
  })
  f.coordinator.ingest(segment('Office attendance is expected.', 1, 'final'), 100); await f.coordinator.flush()
  const first = f.coordinator.state.directions[0]!
  f.coordinator.select(first.id, first.version)
  f.coordinator.another(); await f.coordinator.flush()
  expect(f.coordinator.state.selected).toBeNull()
  expect(inputs[1]?.generation).toBe('another')
  expect(inputs[1]?.recent.some(d => d.opening === first.opening)).toBe(true)
  expect(f.coordinator.state.directions[0]?.opening).toBe('Are there exceptions during onboarding?')
})

test('Generate another reports repeated output instead of claiming a replacement, and supersedes an older flight', async () => {
  const pause = gate(); let count = 0
  const f = setup(async (input, _signal, publish) => { if (++count === 2) await pause.promise; publish(draft(input)) })
  f.coordinator.ingest(segment('Office attendance is expected.', 1, 'final'), 100); await f.coordinator.flush()
  f.coordinator.another(); const flight = f.coordinator.flush()
  f.coordinator.another(); pause.resolve(); await flight
  expect(f.coordinator.state.history).toHaveLength(1)
  await f.coordinator.flush()
  expect(f.coordinator.state.history).toHaveLength(1)
  expect(f.coordinator.state.message).toContain('No different reply')
  expect(f.coordinator.state.status).toBe('waiting')
})

test('confirmation clears the related pinned suggestion and removes the objective from future generation', async () => {
  const f = setup(async (input, _signal, publish) => publish(draft(input)))
  f.coordinator.ingest(segment('Office attendance is expected.', 1, 'final'), 100); await f.coordinator.flush()
  const first = f.coordinator.state.directions[0]!
  f.coordinator.select(first.id, first.version)
  f.analysis.brief.objectives[0]!.status = 'answered'; f.analysis.brief.objectives[0]!.confirmedByUser = true
  f.coordinator.analysisChanged('objective_user')
  expect(f.coordinator.state.selected).toBeNull()
  expect(f.coordinator.state.recommendedId).toBeNull()
  await f.coordinator.flush()
  expect(f.coordinator.state.request?.input.brief.objectives).toEqual([])
})

test('recommended coherent record publishes while alternatives are still generating; partial JSON stays hidden', async () => {
  const pause = gate()
  const f = setup(async (input, _signal, publish) => {
    const decoder = new SuggestionDecoder(input, publish)
    const wire = (recommended: boolean, opening?: string) => ({ type: 'direction', direction: { ...draft(input, recommended, opening).direction, language: 'en', translation: null } })
    const line = JSON.stringify(wire(true))
    decoder.push('{"records":[')
    decoder.push(line.slice(0, -5))
    expect(f.coordinator.state.directions).toHaveLength(0)
    decoder.push(line.slice(-5))
    expect(f.coordinator.state.directions).toHaveLength(1)
    await pause.promise
    decoder.push(',' + JSON.stringify(wire(false, 'Could we discuss possible exceptions?')) + ']}')
    decoder.finish()
  })
  f.coordinator.ingest(segment('We expect regular attendance in the office'), 100)
  const work = f.coordinator.flush()
  expect(f.coordinator.state.status).toBe('generating')
  expect(f.coordinator.state.directions[0]?.opening).toContain('How often')
  pause.resolve(); await work
  expect(f.coordinator.state.directions).toHaveLength(2)
  const first = f.states.find(s => s.directions.length === 1)!
  expect(first.recommendedId).toBe(first.directions[0]!.id)
})

test('unfinished or malformed records never become visible, including at stream EOF', () => {
  const records: unknown[] = []
  const decoder = new SuggestionDecoder({ sessionId: 'session', runId: 'run', requestId: 'request' }, r => records.push(r))
  decoder.push('{"records":[{"type":"direction","direction":{"opening":"Half')
  expect(records).toHaveLength(0)
  expect(() => decoder.finish()).toThrow()
  expect(records).toHaveLength(0)
})

test('late qualification, negation, changed numbers and transcript corrections withdraw actionability while preserving selected wording', async () => {
  for (const text of ['We expect regular attendance in the office, but exceptions are possible.', 'We do NOT expect regular attendance.', 'We expect attendance 5 days, actually 2 days.']) {
    const f = setup(async (i, _s, publish) => publish(draft(i)))
    f.coordinator.ingest(segment('We expect regular attendance in the office'), 100); await f.coordinator.flush()
    const direction = f.coordinator.state.directions[0]!
    f.coordinator.select(direction.id, direction.version)
    f.media(200); f.coordinator.ingest(segment(text, 2), 200)
    expect(f.coordinator.state.directions[0]?.lifecycle).toBe('reassess')
    expect(f.coordinator.state.selected?.direction.opening).toBe(direction.opening)
    expect(f.coordinator.state.selected?.warning).toBeTruthy()
    expect(() => f.coordinator.select(direction.id, direction.version)).toThrow()
  }
})

test('a qualification in a new ASR segment invalidates the preceding direction, without treating final as turn end', async () => {
  const f = setup(async (i, _s, publish) => publish(draft(i)), { mode: 'baseline' })
  f.coordinator.ingest(segment('Regular office attendance.', 1, 'final'), 100)
  await f.coordinator.flush(); expect(f.coordinator.state.request).toBeNull()
  f.coordinator.turnEnd(100); await f.coordinator.flush()
  expect(f.coordinator.state.directions).toHaveLength(1)
  f.media(200); f.coordinator.ingest(segment('except during onboarding.', 1, 'partial', 's2', 1), 200)
  expect(f.coordinator.state.directions[0]?.lifecycle).toBe('reassess')
})

test('selection and release never create spoken evidence, agreement or objective progress', async () => {
  const f = setup(async (i, _s, publish) => publish(draft(i)))
  const before = structuredClone(f.analysis)
  f.coordinator.ingest(segment('We expect attendance.'), 100); await f.coordinator.flush()
  const d = f.coordinator.state.directions[0]!
  f.coordinator.select(d.id, d.version)
  expect(f.analysis).toEqual(before)
  expect(f.coordinator.state.selected).toMatchObject({ expression: 'uncertain', evidence: [] })
  f.coordinator.release(f.coordinator.state.selected!.id)
  expect(f.coordinator.state.selected).toBeNull(); expect(f.analysis.observations).toHaveLength(0)
})

test('semantic expression uses TRACK with differently worded attributed user speech; unknown attribution stays uncertain', async () => {
  for (const known of [true, false]) {
    let analysis!: AnalysisState
    const f = setup(async (i, _s, publish) => publish(draft(i)))
    f.analysis.brief.participants = [{ id: 'me', name: 'Me', sideId: null }]
    if (known) f.coordinator.configure('predictive', 'Short', 'me')
    f.coordinator.ingest(segment('We expect office attendance.'), 100); await f.coordinator.flush()
    const d = f.coordinator.state.directions[0]!; f.coordinator.select(d.id, d.version)
    const tracker = new ConversationTracker({ sessionId: 'session', brief: f.analysis.brief, windowMs: 60_000, selection: () => f.coordinator.selection(), assess: value => f.coordinator.assess(value),
      interpreter: async (_mode, input) => {
        expect(input.selection?.direction.opening).toContain('How often')
        return { sessionId: input.request.sessionId, runId: input.request.runId, requestId: input.request.id, observations: [], objectives: [], openQuestions: [], replanReasons: [],
          selectionAssessment: { selectionId: input.selection!.id, status: 'expressed', evidence: [{ segmentId: 'user', revision: 1 }], reason: 'Asks for the number of on-site days using different wording.' } }
      }, publish: state => { analysis = state } })
    cleanups.push(() => tracker.dispose())
    const user = segment('How many days a week is that on site?', 1, 'final', 'user', 1)
    if (known) { const attribution = { participantId: 'me', sideId: null, sourceLabel: 'My microphone', revision: 1 }; f.analysis.attributions.user = attribution; tracker.state.attributions.user = attribution }
    f.coordinator.ingest(user, 200); tracker.ingest(user, 200); await tracker.flush()
    expect(f.coordinator.state.selected?.expression).toBe(known ? 'expressed' : 'uncertain')
    expect(analysis.brief.objectives[0]?.status).toBe('unexplored')
  }
})

test('partial, departed and interrupted assessments require user evidence after selection; silence is never completion', async () => {
  const f = setup(async (i, _s, publish) => publish(draft(i)))
  f.analysis.brief.participants = [{ id: 'me', name: 'Me', sideId: null }]; f.coordinator.configure('predictive', 'Short', 'me')
  f.coordinator.ingest(segment('We expect attendance.'), 100); await f.coordinator.flush()
  const d = f.coordinator.state.directions[0]!; f.coordinator.select(d.id, d.version)
  const selectionId = f.coordinator.state.selected!.id
  f.coordinator.assess({ selectionId, status: 'expressed', evidence: [], reason: 'Silence.' })
  expect(f.coordinator.state.selected?.expression).toBe('uncertain')
  f.analysis.attributions.user = { participantId: 'me', sideId: null, sourceLabel: 'Me', revision: 1 }
  f.coordinator.ingest(segment('Could you clarify', 1, 'partial', 'user', 1), 200)
  for (const status of ['partial', 'departed'] as const) {
    f.coordinator.assess({ selectionId, status, evidence: [{ segmentId: 'user', revision: 1 }], reason: 'Mock semantic assessment of actual speech.' })
    expect(f.coordinator.state.selected?.expression).toBe(status)
  }
  f.coordinator.assess({ selectionId, status: 'expressed', evidence: [{ segmentId: 'user', revision: 1 }], reason: 'Partial speech.' })
  expect(f.coordinator.state.selected?.expression).toBe('departed')
  f.analysis.attributions.remote = { participantId: 'remote', sideId: null, sourceLabel: 'Remote', revision: 1 }
  f.coordinator.ingest(segment('Sorry, let me explain that first.', 1, 'final', 'remote', 2), 250)
  f.coordinator.assess({ selectionId, status: 'interrupted', evidence: [{ segmentId: 'user', revision: 1 }, { segmentId: 'remote', revision: 1 }], reason: 'Remote participant interrupted the unfinished user question.' })
  expect(f.coordinator.state.selected?.expression).toBe('interrupted')
})

test('one active request and one pending snapshot coalesce many updates without repeatedly aborting or starving publication', async () => {
  const pause = gate(); const contexts: SuggestionInput[] = []; const signals: AbortSignal[] = []
  const f = setup(async (i, signal, publish) => { contexts.push(i); signals.push(signal); if (contexts.length === 1) await pause.promise; publish(draft(i)) })
  f.coordinator.ingest(segment('Regular attendance in the office'), 100)
  const work = f.coordinator.flush()
  for (let n = 2; n <= 20; n++) f.coordinator.ingest(segment('Regular attendance in the office' + ' please'.repeat(n), n), n * 100)
  expect(contexts).toHaveLength(1); expect(signals[0]?.aborted).toBe(false)
  pause.resolve(); await work
  expect(f.coordinator.state.history).toHaveLength(1)
  await f.coordinator.flush()
  expect(contexts).toHaveLength(2)
  expect(contexts[1]?.transcript[0]?.revision).toBe(20)
})

test('new negation makes in-flight work obsolete; the pending revision runs after it finishes', async () => {
  const pause = gate(); let calls = 0
  const f = setup(async (i, _signal, publish) => { if (++calls === 1) await pause.promise; publish(draft(i)) })
  f.coordinator.ingest(segment('Office attendance is required'), 100); const work = f.coordinator.flush()
  f.coordinator.ingest(segment('Office attendance is required, but not every week', 2), 200)
  pause.resolve(); await work
  expect(f.coordinator.state.request?.outcome).toBe('obsolete'); expect(f.coordinator.state.directions).toHaveLength(0)
  await f.coordinator.flush(); expect(calls).toBe(2); expect(f.coordinator.state.directions).toHaveLength(1)
})

test('seek or restart rejects obsolete model results even if provider ignores abort', async () => {
  const pause = gate()
  const f = setup(async (i, _s, publish) => { await pause.promise; publish(draft(i)) })
  f.coordinator.ingest(segment('Please clarify office attendance.'), 100); const work = f.coordinator.flush()
  f.coordinator.dispose(); const count = f.states.length; pause.resolve(); await work
  expect(f.states).toHaveLength(count); expect(f.coordinator.state.directions).toHaveLength(0)
})

test('unrelated analysis versions do not reject results; identity and unsupported references do', async () => {
  for (const bad of ['none', 'identity', 'evidence']) {
    const pause = gate()
    const f = setup(async (i, _s, publish) => { await pause.promise; const record = draft(i); if (bad === 'identity') record.runId = 'other'; if (bad === 'evidence') record.direction.evidence = [{ segmentId: 'future', revision: 99 }]; publish(record) })
    f.coordinator.ingest(segment('Office attendance is expected.'), 100); const work = f.coordinator.flush()
    f.analysis.version++; f.analysis.journalId = 'unrelated'; pause.resolve(); await work
    expect(f.coordinator.state.directions.length).toBe(bad === 'none' ? 1 : 0)
  }
})

test('baseline and predictive use identical bounded model context; ASR finalization alone never triggers baseline', async () => {
  const inputs: SuggestionInput[] = []
  const baseline = setup(async (i, _s, publish) => { inputs.push(i); publish(draft(i)) }, { mode: 'baseline' })
  baseline.coordinator.ingest(segment('We expect office attendance.', 1, 'final'), 100); await baseline.coordinator.flush()
  expect(inputs).toHaveLength(0)
  baseline.coordinator.turnEnd(100); await baseline.coordinator.flush()
  expect(inputs).toHaveLength(1)
  expect(inputs[0]?.observations).toEqual([])
  expect(inputs[0]?.transcript[0]?.text).toBe('We expect office attendance.')
  const predictiveInputs: SuggestionInput[] = []
  const predictive = setup(async (i, _s, publish) => { predictiveInputs.push(i); publish(draft(i)) })
  predictive.coordinator.ingest(segment('We expect office attendance.', 1, 'final'), 100); await predictive.coordinator.flush()
  const comparable = (input: SuggestionInput) => ({ brief: input.brief, observations: input.observations, transcript: input.transcript, tail: input.tail, floor: input.floor, selected: input.selected, style: input.style })
  expect(comparable(inputs[0]!)).toEqual(comparable(predictiveInputs[0]!))
  expect(baseline.coordinator.state.configuration).toEqual(predictive.coordinator.state.configuration)
})

test('baseline explicit refresh waits for a marked turn, and matching direction revisions keep application identity', async () => {
  let calls = 0
  const f = setup(async (i, _s, publish) => { calls++; publish(draft(i)) }, { mode: 'baseline' })
  f.coordinator.ingest(segment('Office attendance is expected.'), 100); f.coordinator.another(); await f.coordinator.flush()
  expect(calls).toBe(0)
  f.coordinator.turnEnd(100); await f.coordinator.flush()
  const id = f.coordinator.state.directions[0]!.id
  f.media(200); f.coordinator.ingest(segment('Office attendance is expected during onboarding.', 2), 200)
  f.coordinator.another(); await f.coordinator.flush(); expect(calls).toBe(1)
  f.coordinator.turnEnd(200); await f.coordinator.flush()
  expect(f.coordinator.state.directions[0]!.id).toBe(id)
  expect(f.coordinator.state.directions[0]!.version).toBe(2)
})

test('completion is withdrawn on spoken transcript or attribution corrections', async () => {
  const f = setup(async (i, _s, publish) => publish(draft(i)))
  f.analysis.brief.participants = [{ id: 'me', name: 'Me', sideId: null }]; f.coordinator.configure('predictive', 'Short', 'me')
  f.coordinator.ingest(segment('Office attendance is required.'), 100); await f.coordinator.flush()
  const d = f.coordinator.state.directions[0]!; f.coordinator.select(d.id, d.version)
  f.analysis.attributions.user = { participantId: 'me', sideId: null, sourceLabel: 'Me', revision: 1 }
  f.coordinator.ingest(segment('Which days do I need to come in?', 1, 'final', 'user', 1), 200)
  f.coordinator.assess({ selectionId: f.coordinator.state.selected!.id, status: 'expressed', evidence: [{ segmentId: 'user', revision: 1 }], reason: 'Semantic question match.' })
  expect(f.coordinator.state.selected?.expression).toBe('expressed')
  f.coordinator.ingest(segment('Which days did they come in?', 2, 'final', 'user', 1), 210)
  expect(f.coordinator.state.selected?.expression).toBe('uncertain')
  f.analysis.attributions.user.participantId = null; f.analysis.attributions.user.revision++
  f.coordinator.analysisChanged('attribution')
  expect(f.coordinator.state.selected?.evidence).toEqual([])
})


test('raw orphan words cannot steer replies even without TRACK, and discarded premises invalidate old selections', async () => {
  const orphan = setup(async (i, _s, publish) => publish(draft(i, true, 'Why are leaves used for the body?')))
  orphan.coordinator.ingest(segment('Leaves', 1, 'final'), 100); orphan.coordinator.another(); await orphan.coordinator.flush()
  expect(orphan.coordinator.state.directions).toEqual([]); expect(orphan.coordinator.state.status).toBe('waiting')
  const f = setup(async (i, _s, publish) => { const record = draft(i, true, i.generation ? 'Are there exceptions to attendance?' : undefined); if (i.generation) record.direction.meaning = 'Understand exceptions to attendance.'; publish(record) })
  f.coordinator.ingest(segment('Office attendance is expected.'), 100); await f.coordinator.flush()
  const old = f.coordinator.state.directions[0]!; f.coordinator.select(old.id, old.version)
  f.analysis.observations.push({ id: 'rejected', version: 1, type: 'claim', meaning: 'Office attendance is mandatory every day.', evidence: [{ segmentId: 's1', revision: 1 }], relations: [{ objectiveId: 'question', relationship: 'answers' }], status: 'retracted', speaker: { participantId: null, sideId: null, sourceLabel: 'Unknown', revision: 0 }, attention: 'normal', conditions: [], addressedToUser: false, hypothetical: false, quoted: false, correctedByUser: true, discardedByUser: true, effectiveMs: 100, reason: 'User marked wrong.' })
  f.coordinator.analysisChanged('observation_user')
  expect(f.coordinator.state.selected?.warning).toBeTruthy()
  f.coordinator.another(); await f.coordinator.flush()
  const fresh = f.coordinator.state.directions[0]!
  expect(fresh.provenance.knownDiscardIds).toContain('rejected')
  f.coordinator.select(fresh.id, fresh.version)
  expect(f.coordinator.state.selected?.warning).toBeNull()
})
