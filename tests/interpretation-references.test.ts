import { expect, test } from 'bun:test'
import { interpretationReferences, suggestionReferences } from '../server/interpretation-references'
import { emptyBrief } from '../shared/analysis'
import type { InterpretationInput } from '../server/interpretation'
import type { SuggestionInput } from '../shared/suggestions'

test('request aliases round-trip nested ASR references without changing canonical state or quoted speech', () => {
  const id = JSON.stringify(['remote-playback', JSON.stringify(['provider-item', 0])])
  const input: InterpretationInput = {
    brief: emptyBrief(), observations: [], pending: [id], ambiguousEvidence: [{ segmentId: id, revision: 2 }],
    transcript: [{ id, sessionId: 'session', sourceId: 'remote-playback', order: 1, revision: 2, text: 'McCray,', status: 'final', attribution: { participantId: null, sideId: null, sourceLabel: 'Playback', revision: 1 } }],
    request: { id: 'request', sessionId: 'session', runId: 'run', mode: 'TRACK', briefVersion: 0, inputs: [{ segmentId: id, revision: 2 }], observationVersions: {}, attributionVersions: { [id]: 1 }, availableAt: 0, scheduledAt: 0, startedAt: 0, completedAt: null, appliedAt: null, effectiveMs: 100, outcome: 'running', schedulingDelayMs: null, inferenceMs: null, totalDelayMs: null, provisionalBeforeFinal: false },
  }
  const original = structuredClone(input)
  const normalized = interpretationReferences(input)
  const alias = normalized.input.transcript[0]!.id
  expect(alias).toMatch(/^s[0-9a-f]{12}$/)
  expect(normalized.input.pending).toEqual([alias])
  expect(normalized.input.request.inputs).toEqual([{ segmentId: alias, revision: 2 }])
  expect(normalized.input.request.attributionVersions).toEqual({ [alias]: 1 })
  expect(normalized.input.ambiguousEvidence).toEqual([{ segmentId: alias, revision: 2 }])
  const restored = normalized.restore({ observations: [{ evidence: [{ segmentId: alias, revision: 2 }], grounding: { quotes: [{ segmentId: alias, revision: 2, text: 'McCray,' }] } }], objectives: [{ evidence: [{ segmentId: alias, revision: 2 }] }], selectionAssessment: { evidence: [{ segmentId: alias, revision: 2 }] } }) as { observations: { evidence: unknown[]; grounding: { quotes: unknown[] } }[]; objectives: { evidence: unknown[] }[]; selectionAssessment: { evidence: unknown[] } }
  expect(restored.observations[0]!.evidence).toEqual([{ segmentId: id, revision: 2 }])
  expect(restored.observations[0]!.grounding.quotes).toEqual([{ segmentId: id, revision: 2, text: 'McCray,' }])
  expect(restored.objectives[0]!.evidence).toEqual([{ segmentId: id, revision: 2 }])
  expect(restored.selectionAssessment.evidence).toEqual([{ segmentId: id, revision: 2 }])
  expect(input).toEqual(original)

  input.transcript.push({ ...input.transcript[0]!, id: alias, order: 2 })
  const collision = interpretationReferences(input)
  expect(collision.input.transcript[0]!.id).not.toBe(alias)
  expect(collision.restore({ evidence: [{ segmentId: 'unprovided', revision: 99 }] })).toEqual({ evidence: [{ segmentId: 'unprovided', revision: 99 }] })
})

test('suggestion aliases preserve canonical references and never rewrite speech or historical evidence', () => {
  const id = JSON.stringify(['remote-playback', JSON.stringify(['provider-item', 0])])
  const input: SuggestionInput = { sessionId: 'session', runId: 'run', requestId: 'request', revision: 1, briefVersion: 0, brief: emptyBrief(), observations: [],
    transcript: [{ id, sessionId: 'session', sourceId: 'remote-playback', order: 1, revision: 2, text: 'Say segment-1.', status: 'final', attribution: { participantId: null, sideId: null, sourceLabel: 'Playback', revision: 0 } }],
    selected: null, recent: [], floor: null, tail: 'Say segment-1.', mediaMs: 100, availableAt: 0, style: 'Brief', rejectedFindings: [{ id: 'rejected', meaning: 'segment-1', evidence: [{ segmentId: 'historical', revision: 1 }] }] }
  const original = structuredClone(input)
  const normalized = suggestionReferences(input)
  const alias = normalized.input.transcript[0]!.id
  expect(alias).toMatch(/^s[0-9a-f]{12}$/)
  expect(normalized.input.transcript[0]!.text).toBe('Say segment-1.')
  expect(normalized.input.rejectedFindings).toEqual(input.rejectedFindings)
  expect(normalized.restore({ direction: { opening: 'Say segment-1.', evidence: [{ segmentId: alias, revision: 2 }] } })).toEqual({ direction: { opening: 'Say segment-1.', evidence: [{ segmentId: id, revision: 2 }] } })
  expect(input).toEqual(original)
})
