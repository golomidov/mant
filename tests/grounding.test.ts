import { afterEach, expect, test } from 'bun:test'
import { ConversationTracker } from '../server/tracking'
import { emptyBrief, type Evidence, type Observation } from '../shared/analysis'
import type { Segment } from '../shared/protocol'
import type { InterpretationInput, Interpreter } from '../server/interpretation'
import type { TrackProposal } from '../server/analysis-schema'
import { unsupportedFragments, validateGrounding } from '../server/grounding'
const trackers: ConversationTracker[] = []
afterEach(() => trackers.splice(0).forEach(t => t.dispose()))
const segment = (id: string, text: string, order = 0): Segment => ({ sessionId: 'grounding', sourceId: 'recording', id, order, revision: 1, text, status: 'final' })
const evidence = (id: string): Evidence[] => [{ segmentId: id, revision: 1 }]
const response = (i: InterpretationInput, observations: TrackProposal['observations'], objectives: TrackProposal['objectives'] = []): TrackProposal => ({ sessionId: i.request.sessionId, runId: i.request.runId, requestId: i.request.id, observations, objectives, openQuestions: [], replanReasons: [] })
function claim(meaning: string, refs: Evidence[], grounding?: Observation['grounding']): TrackProposal['observations'][number] {
  return { id: null, type: 'claim', meaning, evidence: refs, status: 'established', relations: [{ objectiveId: 'material', relationship: 'answers' }], attention: 'normal', conditions: [], addressedToUser: false, hypothetical: false, quoted: false, reason: 'Interpret the supplied speech.', ...(grounding ? { grounding } : {}) }
}
function setup(interpreter: Interpreter) {
  const brief = emptyBrief(); brief.objectives = [{ id: 'material', kind: 'question', description: 'What material is used for the device body, and why?', completion: 'Know the named material and actual reason for choosing it.', origin: 'explicit', status: 'unexplored', evidence: [], reason: '', history: [] }]
  const tracker = new ConversationTracker({ sessionId: 'grounding', brief, interpreter, windowMs: 60_000, publish() {} }); trackers.push(tracker); return tracker
}

test('ASR-final Leaves cannot identify body material, advance a goal, or become a premise', async () => {
  const tracker = setup(async (_mode, i) => response(i, [claim("The body material is Leaves.", evidence('leaf'))], [{ id: 'material', status: 'partial', evidence: evidence('leaf'), reason: 'Found the material.' }]))
  tracker.ingest(segment('leaf', 'Leaves'), 100); await tracker.flush()
  expect(tracker.state.request?.outcome).toBe('applied')
  expect(tracker.state.observations[0]).toMatchObject({ status: 'retracted', relations: [] })
  expect(tracker.state.brief.objectives[0]).toMatchObject({ status: 'unexplored', evidence: [] })
})

test('later case material speech supports body inquiry without confirming the orphan noun or confusing buttons with case', async () => {
  const text = 'The Case materials can be soft rubbery changeable. Buttons with a combination of LCD and rubber according to the design.'
  let phase = 0
  const tracker = setup(async (_mode, i) => {
    if (phase++ === 0) return response(i, [claim('The body material is Leaves.', evidence('leaf'))])
    expect(i.ambiguousEvidence).toContainEqual({ segmentId: 'leaf', revision: 1 })
    return response(i, [claim('Leaves are chosen because they are soft, rubbery and changeable.', [...evidence('leaf'), ...evidence('case')]),
      claim('The case material is described as soft, rubbery and changeable; the exact material name and reason remain unclear.', evidence('case'), { kind: 'contextual', quotes: [{ segmentId: 'case', revision: 1, text: 'The Case materials can be soft rubbery changeable.' }], entityExplanation: 'In this device-design context, case refers to the outer body. The subsequent buttons sentence describes a separate component.' })],
      [{ id: 'material', status: 'partial', evidence: evidence('case'), reason: 'Case properties are known; exact material and rationale are not explicit.' }])
  })
  tracker.ingest(segment('leaf', 'Leaves'), 100); await tracker.flush()
  tracker.ingest(segment('case', text, 1), 200); await tracker.flush()
  const active = tracker.state.observations.filter(o => o.status !== 'retracted')
  expect(active).toHaveLength(1); expect(active[0]!.meaning).not.toContain('Leaves')
  expect(active[0]!.grounding?.kind).toBe('contextual')
  expect(tracker.state.brief.objectives[0]).toMatchObject({ status: 'partial', evidence: evidence('case') })
})

test('a one-word answer remains usable when grounded in an actual nearby spoken question', async () => {
  const tracker = setup(async (_mode, i) => response(i, [claim('The case is rubber.', [...evidence('question'), ...evidence('answer')], { kind: 'contextual', quotes: [{ segmentId: 'question', revision: 1, text: 'What material is the case made of?' }, { segmentId: 'answer', revision: 1, text: 'Rubber.' }], entityExplanation: 'The answer refers to the case in the immediately preceding question.' })]))
  tracker.ingest(segment('question', 'What material is the case made of?'), 100)
  tracker.ingest(segment('answer', 'Rubber.', 1), 200); await tracker.flush()
  expect(tracker.state.observations[0]?.status).toBe('established')
})

test('empty capture finalization packets do not orphan a short answer from its spoken question', async () => {
  const refs = [...evidence('question'), ...evidence('answer')]
  const tracker = setup(async (_mode, i) => {
    expect(i.ambiguousEvidence).not.toContainEqual(evidence('answer')[0])
    return response(i, [claim('The case is rubber.', refs, { kind: 'contextual', quotes: [
      { segmentId: 'question', revision: 1, text: 'What material is the case made of?' },
      { segmentId: 'answer', revision: 1, text: 'Rubber.' },
    ], entityExplanation: 'A direct response to the preceding spoken question.' })], [{ id: 'material', status: 'partial', evidence: refs, reason: 'Material stated; rationale still missing.' }])
  })
  tracker.ingest(segment('question', 'What material is the case made of?'), 100)
  for (let i = 1; i <= 8; i++) tracker.ingest(segment(`empty-${i}`, '', i), 100 + i)
  tracker.ingest(segment('answer', 'Rubber.', 9), 200)
  await tracker.flush()
  expect(tracker.state.request?.outcome).toBe('applied')
  expect(tracker.state.observations[0]?.status).toBe('established')
  expect(tracker.state.brief.objectives[0]?.status).toBe('partial')
  expect(unsupportedFragments([...refs, ...evidence('empty')], [segment('question', 'What material is the case made of?'), segment('empty', '', 1), segment('answer', 'Rubber.', 2)])).toEqual([])
})

test('valid quoted references omitted from the redundant evidence list still ground a contextual answer', async () => {
  const tracker = setup(async (_mode, input) => response(input, [claim('The case is rubber.', evidence('answer'), {
    kind: 'contextual', quotes: [
      { segmentId: 'question', revision: 1, text: 'What material is the case made of?' },
      { segmentId: 'answer', revision: 1, text: 'Rubber.' },
    ], entityExplanation: 'The short answer responds to this actual spoken question.',
  })], [{ id: 'material', status: 'partial', evidence: evidence('answer'), reason: 'The material was stated.' }]))
  tracker.ingest(segment('question', 'What material is the case made of?'), 100)
  tracker.ingest(segment('answer', 'Rubber.', 1), 200)
  await tracker.flush()
  expect(tracker.state.request?.outcome).toBe('applied')
  expect(tracker.state.observations[0]).toMatchObject({ status: 'established', evidence: [...evidence('answer'), ...evidence('question')] })
  expect(tracker.state.brief.objectives[0]?.status).toBe('partial')
})

test('a quoted short answer gains its actual spoken question when the model omits the contextual reference', async () => {
  const tracker = setup(async (_mode, input) => response(input, [claim('The case is rubber.', evidence('answer'), {
    kind: 'direct', quotes: [{ segmentId: 'answer', revision: 1, text: 'Rubber.' }], entityExplanation: 'A short spoken answer.',
  })], [{ id: 'material', status: 'partial', evidence: evidence('answer'), reason: 'The material was stated.' }]))
  tracker.ingest(segment('question', 'What material is the case made of?'), 100)
  tracker.ingest(segment('answer', 'Rubber.', 1), 200)
  await tracker.flush()
  expect(tracker.state.request?.outcome).toBe('applied')
  expect(tracker.state.observations[0]).toMatchObject({ status: 'established', grounding: { kind: 'contextual' } })
  expect(tracker.state.observations[0]!.grounding!.quotes).toContainEqual({ segmentId: 'question', revision: 1, text: 'What material is the case made of?' })
  expect(tracker.state.brief.objectives[0]?.status).toBe('partial')
})

test('normalizing quoted references cannot introduce missing or future transcript evidence', async () => {
  const tracker = setup(async (_mode, input) => response(input, [claim('The case is rubber.', evidence('answer'), {
    kind: 'contextual', quotes: [{ segmentId: 'future', revision: 1, text: 'What material is the case made of?' }], entityExplanation: 'An invented reference.',
  })]))
  tracker.ingest(segment('answer', 'Rubber.'), 100)
  await tracker.flush()
  expect(tracker.state.request?.outcome).toBe('error')
  expect(tracker.state.observations).toEqual([])
})

test('fabricated evidence quotations are rejected atomically', async () => {
  const tracker = setup(async (_mode, i) => response(i, [claim('The case is leaves.', evidence('case'), { kind: 'direct', quotes: [{ segmentId: 'case', revision: 1, text: 'The case is made from leaves.' }], entityExplanation: 'A claimed quote.' })]))
  tracker.ingest(segment('case', 'The case material can be soft and rubbery.'), 100); await tracker.flush()
  expect(tracker.state.request?.outcome).toBe('error'); expect(tracker.state.observations).toEqual([])
})

test('quote matching tolerates ASR punctuation but retains words, negation and numerical signs', () => {
  const source = segment('answer', 'Uh, Varvara Golomidova')
  const observation = (text: string) => claim('An attributed statement.', evidence('answer'), { kind: 'direct', quotes: [{ segmentId: 'answer', revision: 1, text }], entityExplanation: 'The source states this.' })
  expect(() => validateGrounding(observation('Varvara Golomidova.'), [source])).not.toThrow()
  expect(() => validateGrounding(observation('Varvara Golomidova is her favorite singer.'), [source])).toThrow()
  expect(() => validateGrounding(observation('5 degrees'), [{ ...source, text: '-5 degrees.' }])).toThrow()
  expect(() => validateGrounding(observation('+5 degrees'), [{ ...source, text: '-5 degrees.' }])).toThrow()
  expect(() => validateGrounding(observation('The price is 10.'), [{ ...source, text: 'The price is 100.' }])).toThrow()
  expect(() => validateGrounding(observation('It is optional.'), [{ ...source, text: 'It is not optional.' }])).toThrow()
})

test('discard retracts related findings, resets supported goals independently, and allows a different valid reading of the same speech', async () => {
  let phase = 0
  const tracker = setup(async (_mode, i) => {
    if (phase++ === 0) return response(i, [claim('The case is leaves.', evidence('case')), { ...claim('Leaves were chosen for flexibility.', evidence('case')), type: 'proposal' }], [{ id: 'material', status: 'answered', evidence: evidence('case'), reason: 'An incorrect reading.' }])
    return response(i, [{ ...claim('The case is leaves.', evidence('case')), type: 'agreement' }, claim('The case material is soft and rubbery; exact material not stated.', evidence('case'))])
  })
  tracker.state.brief.objectives.push({ ...structuredClone(tracker.state.brief.objectives[0]!), id: 'independent' })
  tracker.ingest(segment('case', 'The case material can be soft and rubbery.'), 100); await tracker.flush()
  tracker.state.brief.objectives[1]!.status = 'answered'
  const bad = tracker.state.observations[0]!
  tracker.discardObservation(bad.id, bad.version, 200)
  expect(tracker.state.observations.every(o => o.status === 'retracted')).toBe(true)
  expect(tracker.state.observations[0]?.discardedByUser).toBe(true)
  expect(tracker.state.observations[1]?.discardedByUser).toBe(false)
  expect(tracker.state.brief.objectives[0]).toMatchObject({ status: 'unexplored', evidence: [] })
  expect(tracker.state.brief.objectives[1]!.status).toBe('answered')
  await tracker.flush()
  const active = tracker.state.observations.filter(o => o.status !== 'retracted')
  expect(active).toHaveLength(1); expect(active[0]!.meaning).not.toContain('leaves')
})

test('discarded findings survive saved snapshots and invalidate in-flight confirmation', async () => {
  let resolve!: (value: unknown) => void; let later!: InterpretationInput; let calls = 0
  const tracker = setup(async (_mode, i) => { if (++calls === 1) return response(i, [claim('The case is leaves.', evidence('case'))]); later = i; return await new Promise(r => { resolve = r }) })
  tracker.ingest(segment('case', 'The case material can be soft and rubbery.'), 100); await tracker.flush()
  const saved = structuredClone(tracker.state)
  tracker.ingest(segment('next', 'We can change the design later.', 1), 200); const flight = tracker.flush()
  const bad = tracker.state.observations[0]!; tracker.discardObservation(bad.id, bad.version, 200)
  resolve(response(later, [claim('The case is leaves.', evidence('case'))])); await flight
  expect(tracker.state.request?.outcome).toBe('stale')
  tracker.restore(saved)
  expect(tracker.state.observations[0]).toMatchObject({ discardedByUser: true, status: 'retracted' })
})


test('missing material name and rationale prevent completion even if a model proposes answered', async () => {
  const tracker = setup(async (_mode, i) => response(i, [claim('The case material is described as soft and rubbery.', evidence('case'), { kind: 'contextual', quotes: [{ segmentId: 'case', revision: 1, text: 'The case material can be soft and rubbery.' }], entityExplanation: 'Case refers to the body in context.', unresolved: ['Exact material name', 'Reason for choosing it'] })], [{ id: 'material', status: 'answered', evidence: evidence('case'), reason: 'Properties were mentioned.' }]))
  tracker.ingest(segment('case', 'The case material can be soft and rubbery.'), 100); await tracker.flush()
  expect(tracker.state.brief.objectives[0]).toMatchObject({ status: 'partial', reason: 'Still unresolved: Exact material name; Reason for choosing it' })
})
