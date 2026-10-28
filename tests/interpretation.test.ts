import { afterEach, expect, test } from 'bun:test'
import { interpret, models, type InterpretationInput } from '../server/interpretation'
import { briefWithPeople, emptyBrief } from '../shared/analysis'
import { ModelRequestError, modelRequestError } from '../server/errors'
import { ConversationTracker } from '../server/tracking'
import { trackSchemaFor } from '../server/analysis-schema'

const originalKey = process.env.OPENAI_API_KEY, originalModel = process.env.ANALYSIS_MODEL
const stream = models.streamSimple
const complete = models.complete
afterEach(() => {
  models.streamSimple = stream; models.complete = complete
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey
  if (originalModel === undefined) delete process.env.ANALYSIS_MODEL; else process.env.ANALYSIS_MODEL = originalModel
})
function input(mode: 'BRIEF' | 'TRACK' = 'BRIEF'): InterpretationInput {
  const brief = briefWithPeople(emptyBrief()); brief.preparation = 'Which city does the speaker live in?'
  return { brief, observations: [], transcript: [], pending: [],
    request: { id: 'request', sessionId: 'session', runId: 'run', mode, briefVersion: brief.version, inputs: [], observationVersions: {}, attributionVersions: {},
      availableAt: 0, scheduledAt: 0, startedAt: 0, completedAt: null, appliedAt: null, effectiveMs: 0, outcome: 'running', schedulingDelayMs: null, inferenceMs: null, totalDelayMs: null, provisionalBeforeFinal: false } }
}
function strictObjects(value: unknown) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach(strictObjects); return }
  const schema = value as Record<string, unknown>
  if (schema.type === 'object') {
    expect(schema.additionalProperties).toBe(false)
    expect(new Set(schema.required as string[])).toEqual(new Set(Object.keys(schema.properties as object)))
  }
  Object.values(schema).forEach(strictObjects)
}

for (const mode of ['BRIEF', 'TRACK'] as const) test(`${mode} sends native strict schemas with closed objects and required nullable optional fields`, async () => {
  process.env.OPENAI_API_KEY = 'sk-test-only-not-a-credential'; process.env.ANALYSIS_MODEL = 'gpt-4.1-mini'
  const supplied = input(mode)
  if (mode === 'TRACK') {
    supplied.brief.objectives = ['Name', 'Singer', 'Year', 'City'].map((description, i) => ({ id: `question-${i}`, kind: 'question', description, completion: 'The fact is known.', origin: 'explicit', status: 'unexplored', evidence: [], reason: '', history: [] }))
    supplied.request.inputs = [{ segmentId: 'first', revision: 1 }, { segmentId: 'second', revision: 3 }]
    supplied.transcript = supplied.request.inputs.map(({ segmentId, revision }, order) => ({ id: segmentId, revision, order, sessionId: 'session', sourceId: 'audio', status: 'final', text: 'Developing speech.', attribution: { participantId: null, sideId: null, sourceLabel: 'Playback', revision: 0 } }))
    supplied.pending = ['first', 'second']
  }
  if (mode === 'BRIEF') {
    supplied.brief.preparation = 'Understand:\n- Name\n- Favorite singer\n- Year of birth\n- Current city\n\nIdentify the name.'
    supplied.brief.items = [{ id: 'old-context', category: 'purpose', text: 'An obsolete generated requirement.', origin: 'explicit' }]
    supplied.brief.objectives = ['Understand the name', 'Identify the name', 'What is the year of birth?'].map((description, i) => ({ id: `old-${i}`, kind: 'question', description, completion: 'The fact is known.', origin: 'explicit', status: 'unexplored', evidence: [], reason: '', history: [] }))
    supplied.brief.protectedIds.push('old-2')
  }
  const before = structuredClone(supplied)
  let payload: Record<string, any> | undefined
  let contextSent: Parameters<typeof models.streamSimple>[1] | undefined
  const capture = async (value: unknown) => { payload = value as Record<string, any>; throw new Error('Stopped before any network request') }
  const realStream = stream.bind(models)
  models.streamSimple = ((model, context, options) => { contextSent = context; return realStream(model, context, { ...options, onPayload: async (value, model) => capture(await options?.onPayload?.(value, model) ?? value) }) }) as typeof models.streamSimple
  models.complete = ((model, context, options) => Reflect.apply(complete, models, [model, context, { ...options, onPayload: async (value: unknown) => capture(await options?.onPayload?.(value, model) ?? value) }])) as typeof models.complete
  await expect(interpret(mode, supplied, new AbortController().signal)).rejects.toThrow()
  expect(supplied).toEqual(before)
  expect(payload).toBeDefined()
  expect(payload!.tool_choice).toEqual({ type: 'function', name: 'propose_state' })
  expect(payload!.prompt_cache_key).toBe(`mant:session:${mode}:plain`)
  const tool = payload!.tools[0]
  expect(tool.strict).toBe(true)
  strictObjects(tool.parameters)
  if (mode === 'BRIEF') {
    expect(tool.parameters.properties.languages.required).toContain('user')
    expect(JSON.stringify(tool.parameters.properties.languages.properties.user)).toContain('null')
    expect(tool.parameters.properties.participants.maxItems).toBe(0)
    expect(tool.parameters.properties.sides.maxItems).toBe(0)
    const message = contextSent!.messages.find(message => message.role === 'user')!
    const content = typeof message.content === 'string' ? message.content : message.content.map(part => 'text' in part ? part.text : '').join('')
    const sent = JSON.parse(content.split('\nCURRENT TASK:')[0]!)
    expect(sent.brief.preparation).toBe(supplied.brief.preparation)
    expect(sent.brief.items).toEqual([])
    expect(sent.brief.objectives.map((o: { id: string }) => o.id)).toEqual(['old-2'])
    expect(sent.previousObjectivesForIdMatching).toEqual(supplied.brief.objectives.slice(0, 2).map(({ id, kind, description, completion }) => ({ id, kind, description, completion })))
    expect(content).not.toContain('An obsolete generated requirement.')
  }
})

test('TRACK cacheable schemas stay identical across request IDs, evidence, observations and objectives', () => {
  const first = input('TRACK'), second = input('TRACK')
  second.request.id = 'new-request'; second.request.sessionId = 'another-session'; second.request.runId = 'new-run'
  second.request.inputs = [{ segmentId: 'new-segment', revision: 2 }]
  second.brief.objectives = [{ id: 'goal', kind: 'outcome', status: 'partial', description: 'Agree a date', completion: 'A date is agreed', origin: 'explicit', evidence: [], reason: '', history: [] }]
  expect(JSON.stringify(trackSchemaFor(first, true))).toBe(JSON.stringify(trackSchemaFor(second, true)))
  expect(JSON.stringify(trackSchemaFor(first))).not.toBe(JSON.stringify(trackSchemaFor(second)))
  first.selection = { id: 'first-selection' } as NonNullable<InterpretationInput['selection']>
  second.selection = { id: 'second-selection' } as NonNullable<InterpretationInput['selection']>
  expect(JSON.stringify(trackSchemaFor(first, true))).toBe(JSON.stringify(trackSchemaFor(second, true)))
})

test('Luna TRACK explicitly disables reasoning and preserves stable cache routing in the real SDK payload', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-only-not-a-credential'; process.env.ANALYSIS_MODEL = 'gpt-6-luna'
  let payload: Record<string, unknown> | undefined
  models.complete = ((model, context, options) => Reflect.apply(complete, models, [model, context, { ...options, onPayload: async (value: unknown) => {
    payload = await options?.onPayload?.(value, model) as Record<string, unknown>
    throw new Error('Stopped before any network request')
  } }])) as typeof models.complete
  await expect(interpret('TRACK', input('TRACK'), new AbortController().signal)).rejects.toThrow()
  expect(payload?.reasoning).toEqual({ effort: 'none' })
  expect(payload?.prompt_cache_key).toBe('mant:session:TRACK:plain')
})

test('agent/provider failures report their real category instead of a missing-proposal or configuration guess', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-only-not-a-credential'; process.env.ANALYSIS_MODEL = 'gpt-4.1-mini'
  models.streamSimple = () => { throw new Error('OpenAI API error (400): Invalid schema for function propose_state; invalid_function_parameters') }
  await expect(interpret('BRIEF', input(), new AbortController().signal)).rejects.toMatchObject({ code: 'schema' })
  expect(modelRequestError(new Error('401: incorrect API key sk-sensitive')).message).not.toContain('sk-sensitive')
  expect(modelRequestError(new Error('429 rate limit exceeded')).code).toBe('quota')
  expect(modelRequestError(new Error('Connection error.')).code).toBe('connection')
})

test('TRACK preserves SDK/provider error categories even when complete returns an error message instead of throwing', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-only-not-a-credential'; process.env.ANALYSIS_MODEL = 'gpt-4.1-mini'
  for (const [errorMessage, code] of [
    ['Tool "propose_state" requires JSON-schema constrained sampling, but object and array unions are unsupported.', 'schema'],
    ['401 incorrect API key sk-sensitive', 'authentication'],
    ['429 rate limit exceeded', 'quota'],
  ]) {
    models.complete = (async model => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], stopReason: 'error', errorMessage,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
    })) as typeof models.complete
    await expect(interpret('TRACK', input('TRACK'), new AbortController().signal)).rejects.toMatchObject({ code, task: 'analysis' })
  }
})

test('brief extraction preserves user-facing failure details while leaving the brief definitions intact', async () => {
  const brief = briefWithPeople(emptyBrief()); brief.preparation = 'A saved call goal.'
  const tracker = new ConversationTracker({ sessionId: 'session', brief, enabled: false, publish() {}, interpreter: async () => { throw new ModelRequestError('schema') } })
  try {
    await tracker.extractBrief()
    expect(tracker.state.briefMessage).toBe(new ModelRequestError('schema').message)
    expect(tracker.state.briefRequest?.outcome).toBe('error')
    expect(tracker.state.brief).toEqual(brief)
  } finally { tracker.dispose() }
})
