import { expect, test } from 'bun:test'
import { callModelContext } from '../server/model-context'
import { emptyBrief } from '../shared/analysis'
import type { InterpretationInput } from '../server/interpretation'
import { interpretationReferences } from '../server/interpretation-references'

function fixture() {
  const brief = emptyBrief()
  brief.objectives = [{ id: 'goal', kind: 'question', description: 'What is the date?', completion: 'The date is stated.', origin: 'explicit', status: 'unexplored', evidence: [], history: [], reason: '' }]
  const transcript: InterpretationInput['transcript'] = Array.from({ length: 4 }, (_, index) => ({ id: `segment-${index}`, sessionId: 'session', sourceId: 'audio', order: index, revision: 1, status: index === 3 ? 'partial' : 'final', text: `Speech ${index}`, attribution: { participantId: null, sideId: null, sourceLabel: 'Playback', revision: 0 } }))
  return { brief, transcript, task: { observations: [], pending: ['segment-3'] } }
}

test('goal definitions and finalized speech retain identical message prefixes as progress and partial speech change', () => {
  const input = fixture(), first = callModelContext(input)
  input.brief.version++; input.brief.objectives[0]!.status = 'partial'
  input.brief.objectives[0]!.history.push({ status: 'partial', reason: 'Changed', evidence: [], atMs: 123 })
  input.transcript[3]!.text += ' continued'; input.transcript[3]!.revision++
  const second = callModelContext(input)
  expect(first.messages.slice(0, 4)).toEqual(second.messages.slice(0, 4))
  expect(first.messages[4]).not.toEqual(second.messages[4])
  expect(first.messages[5]).not.toEqual(second.messages[5])
  expect(JSON.stringify(second.messages)).not.toContain('atMs')
  expect(JSON.stringify(second.messages)).not.toContain('history')
  input.brief.objectives[0]!.description = 'What is the new date?'
  expect(callModelContext(input).messages[0]).not.toEqual(first.messages[0])
})

test('explicit cache writes end at rules, definitions and at most two finalized speech messages, never the dynamic suffix', () => {
  const context = callModelContext(fixture())
  const native = { input: [{ type: 'additional_tools', role: 'developer', tools: [] }, { role: 'developer', content: 'Static rules' }, ...context.messages.map(message => ({ role: message.role, content: [{ type: 'input_text', text: message.content }] }))], store: false }
  const before = structuredClone(native)
  const payload = context.cachePayload(native, true) as Record<string, any>
  const marked = payload.input.flatMap((message: Record<string, any>) => (message.content ?? []).filter((part: Record<string, unknown>) => part.prompt_cache_breakpoint).map((part: Record<string, unknown>) => part.text))
  expect(marked).toHaveLength(4)
  expect(marked[0]).toBe('Static rules')
  expect(marked[1]).toContain('call_context')
  expect(marked.join('')).not.toContain('task_state')
  expect(marked.join('')).not.toContain('Speech 3')
  expect(payload.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' })
  expect(native).toEqual(before)
  expect(context.cachePayload(native, false)).toEqual(native)
})

test('transcript aliases stay stable when the context window rolls or another segment is appended', () => {
  const fixtureInput = fixture()
  const input = { ...fixtureInput, request: { inputs: [], attributionVersions: {} }, observations: [], pending: [] } as unknown as InterpretationInput
  const first = interpretationReferences(input)
  input.transcript.shift()
  const next = interpretationReferences(input)
  expect(first.input.transcript.slice(1).map(s => s.id)).toEqual(next.input.transcript.map(s => s.id))
  const id = next.input.transcript[0]!.id
  expect(next.restore({ evidence: [{ segmentId: id, revision: 1 }] })).toEqual({ evidence: [{ segmentId: input.transcript[0]!.id, revision: 1 }] })
})
