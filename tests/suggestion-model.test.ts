import { afterEach, expect, test } from 'bun:test'
import { models } from '../server/interpretation'
import { generateSuggestions } from '../server/suggestion-model'
import { usageLedger } from '../server/usage'
import { emptyBrief } from '../shared/analysis'
import type { SuggestionInput } from '../shared/suggestions'
import { SuggestionDecoder, suggestionOutputSchema, type SuggestRecord } from '../server/suggestion-output'
import { suggestionReferences } from '../server/interpretation-references'

const originalStream = models.streamSimple, originalKey = process.env.OPENAI_API_KEY, originalModel = process.env.SUGGEST_MODEL
afterEach(() => {
  models.streamSimple = originalStream
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey
  if (originalModel === undefined) delete process.env.SUGGEST_MODEL; else process.env.SUGGEST_MODEL = originalModel
})

const identity = { sessionId: 'session', runId: 'run', requestId: 'request' }
function strictObjects(schema: unknown) {
  if (!schema || typeof schema !== 'object') return
  if (Array.isArray(schema)) { schema.forEach(strictObjects); return }
  const node = schema as Record<string, unknown>
  if (node.type === 'object') {
    expect(node.additionalProperties).toBe(false)
    expect(new Set(node.required as string[])).toEqual(new Set(Object.keys(node.properties as object)))
  }
  Object.values(node).forEach(strictObjects)
}
function direction(): Omit<Extract<SuggestRecord, { type: 'direction' }>, 'sessionId' | 'runId' | 'requestId' | 'recommended'> {
  return { type: 'direction', direction: { directionId: null, label: 'Ask', move: 'clarify', objectiveIds: [], meaning: 'Clarify the condition.',
    opening: 'What about "braces } [" and \\ paths?\nСпасибо.', continuation: null, evidence: [{ segmentId: 's1', revision: 1 }], observationIds: [], assumptions: [], status: 'ready', language: 'en', translation: null } }
}

test('native suggestion schema requires closed objects, language and nullable translation throughout', () => {
  strictObjects(suggestionOutputSchema)
  expect(suggestionOutputSchema.type).toBe('object')
  expect(JSON.stringify(suggestionOutputSchema)).not.toContain('requestId')
})

test('structured suggestions publish complete records across every possible chunk split and preserve escaped strings', () => {
  const first = direction(), second = direction()
  second.direction.opening = 'Could you explain the exception?'
  const text = JSON.stringify({ records: [first, second] }, null, 2)
  for (let split = 0; split <= text.length; split++) {
    const records: SuggestRecord[] = []
    const decoder = new SuggestionDecoder(identity, record => records.push(record))
    decoder.push(text.slice(0, split)); decoder.push(text.slice(split)); decoder.finish()
    expect(records).toEqual([{ ...identity, ...first, recommended: true }, { ...identity, ...second, recommended: false }])
  }
  const records: SuggestRecord[] = []
  const decoder = new SuggestionDecoder(identity, record => records.push(record))
  for (const char of text) decoder.push(char)
  decoder.finish(); expect(records).toHaveLength(2)
})

test('structured decoder rejects missing fields, extra output, wait mixtures, too many records and incomplete envelopes', () => {
  const invalid = [
    '{"records":[]}', '{"records":[', '{"records":[]} trailing', '{"other":[]}',
    JSON.stringify({ records: [{ ...direction(), direction: { ...direction().direction, language: undefined } }] }),
    JSON.stringify({ records: [{ ...direction(), direction: { ...direction().direction, translation: undefined } }] }),
    JSON.stringify({ records: [direction(), { type: 'wait', message: 'Wait' }] }),
    JSON.stringify({ records: [{ type: 'wait', message: 'Wait' }, direction()] }),
    JSON.stringify({ records: Array.from({ length: 4 }, direction) }),
    JSON.stringify({ records: [{ type: 'wait', message: 'Wait', requestId: 'forged' }] }),
    '{"records":[' + JSON.stringify(direction()) + ',]}',
  ]
  for (const text of invalid) {
    const decoder = new SuggestionDecoder(identity, () => {})
    expect(() => { decoder.push(text); decoder.finish() }).toThrow()
  }
})

for (const model of ['gpt-4.1-mini', 'gpt-6-luna']) test(`${model} sends a native strict schema and structured context through the real Pi adapter`, async () => {
  process.env.OPENAI_API_KEY = 'sk-test-only-not-a-credential'; process.env.SUGGEST_MODEL = model
  let payload: Record<string, any> | undefined
  models.streamSimple = ((model, context, options) => originalStream.call(models, model, context, { ...options, onPayload: async value => {
    payload = await options?.onPayload?.(value, model) as Record<string, any>
    throw new Error('Stopped before network')
  } })) as typeof models.streamSimple
  const input: SuggestionInput = { ...identity, revision: 1, briefVersion: 0, brief: emptyBrief(), observations: [], transcript: [], tail: '', floor: null, selected: null, recent: [], mediaMs: 0, availableAt: 0, style: 'Brief' }
  await expect(generateSuggestions(input, new AbortController().signal, () => {})).rejects.toThrow()
  expect(payload?.tools[0].type).toBe('function')
  expect(payload?.tools[0].strict).toBe(true)
  expect(payload?.tool_choice).toEqual({ type: 'function', name: 'propose_directions' })
  expect(payload?.parallel_tool_calls).toBe(false)
  strictObjects(payload?.tools[0].parameters)
  const serializedInput = JSON.stringify(payload?.input)
  expect(serializedInput).toContain('call_context'); expect(serializedInput).toContain('task_state')
  expect(serializedInput).not.toContain('requestId')
  expect(payload?.prompt_cache_key).toBe('mant:session:SUGGEST')
  if (model === 'gpt-6-luna') {
    expect(payload?.reasoning).toEqual({ effort: 'none' })
    expect(payload?.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' })
    expect(serializedInput).toContain('prompt_cache_breakpoint')
  } else expect(serializedInput).not.toContain('prompt_cache_breakpoint')
})

test('malformed suggestion records cancel paid generation and settle its usage ledger', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-only-not-a-credential'
  let providerSignal: AbortSignal | undefined
  models.streamSimple = ((...[_model, _context, options]: Parameters<typeof models.streamSimple>) => {
    providerSignal = options?.signal
    const result = new Promise(resolve => providerSignal?.addEventListener('abort', () => resolve({ stopReason: 'aborted', usage: { totalTokens: 0 } }), { once: true }))
    return Object.assign((async function* () {
      yield { type: 'toolcall_start', contentIndex: 0, partial: { content: [{ type: 'toolCall', name: 'propose_directions' }] } }
      yield { type: 'toolcall_delta', delta: '{"records":[{malformed}\n' }
    })(), { result: () => result })
  }) as unknown as typeof models.streamSimple
  const sessionId = crypto.randomUUID()
  const input: SuggestionInput = { sessionId, runId: 'run', requestId: 'request', revision: 1, briefVersion: 0, brief: emptyBrief(), observations: [], transcript: [], tail: '', floor: null, selected: null, recent: [], mediaMs: 0, availableAt: 0, style: 'Brief' }
  await expect(generateSuggestions(input, new AbortController().signal, () => {})).rejects.toThrow()
  expect(providerSignal?.aborted).toBe(true)
  expect(usageLedger.snapshot(sessionId)).toMatchObject({ pending: 0, unreported: 1, requests: 1 })
})

test('commentary, including malformed JSON and assistant delimiters, cannot enter the forced-tool decoder', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-only-not-a-credential'
  const input: SuggestionInput = { ...identity, revision: 1, briefVersion: 0, brief: emptyBrief(), observations: [],
    transcript: [{ id: 'canonical-id', sessionId: 'session', sourceId: 'audio', order: 1, revision: 1, text: 'A condition.', status: 'partial', attribution: { participantId: null, sideId: null, sourceLabel: 'Remote', revision: 0 } }],
    tail: 'A condition.', floor: null, selected: null, recent: [], mediaMs: 0, availableAt: 0, style: 'Brief' }
  const wire = direction(); wire.direction.evidence = [{ segmentId: suggestionReferences(input).input.transcript[0]!.id, revision: 1 }]
  const usage = { input: 100, output: 30, cacheRead: 20, cacheWrite: 0, totalTokens: 150, cost: { input: .00001, output: .000015, cacheRead: .0000002, cacheWrite: 0, total: .0000252 } }
  models.streamSimple = (() => Object.assign((async function* () {
    yield { type: 'text_delta', contentIndex: 0, delta: '{bad JSON}\n</|assistant|>' }
    yield { type: 'toolcall_start', contentIndex: 1, partial: { content: [{ type: 'text', text: 'commentary' }, { type: 'toolCall', name: 'propose_directions' }] } }
    for (const char of JSON.stringify({ records: [wire] })) yield { type: 'toolcall_delta', contentIndex: 1, delta: char }
  })(), { result: async () => ({ stopReason: 'toolUse', usage }) })) as unknown as typeof models.streamSimple
  const records: SuggestRecord[] = []
  await generateSuggestions(input, new AbortController().signal, record => records.push(record as SuggestRecord))
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ ...identity, recommended: true, direction: { evidence: [{ segmentId: 'canonical-id', revision: 1 }] } })
})

test('complete suggestion envelopes validate every record before any publication', async () => {
  const { completeSuggestionRecords } = await import('../server/suggestion-output')
  const published: SuggestRecord[] = []
  expect(() => {
    for (const record of completeSuggestionRecords(identity, { records: [direction(), { type: 'wait', message: 'Invalid mixture' }] })) published.push(record)
  }).toThrow()
  expect(published).toEqual([])
})
