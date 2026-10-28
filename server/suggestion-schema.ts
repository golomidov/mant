import { Type, StringEnum } from '@earendil-works/pi-ai'
import { attributionSchema, briefSchema, evidenceSchema, observationSchema, segmentCaptureSchema, validate } from './analysis-schema'
import { draftSchema } from './suggestion-model'
import type { SuggestionRow } from '../shared/suggestions'
const id = Type.String({ minLength: 1, maxLength: 160 })
const text = Type.String({ maxLength: 4000 })
const clock = Type.Number({ minimum: 0 })
const nullableClock = Type.Union([clock, Type.Null()])
const nullableText = Type.Union([text, Type.Null()])
const evidence = Type.Array(evidenceSchema, { maxItems: 64 })
const segment = Type.Object({ sessionId: id, sourceId: id, id, order: clock, revision: clock, text: Type.String({ maxLength: 24000 }), status: StringEnum(['partial', 'final'] as const), capture: Type.Optional(segmentCaptureSchema), attribution: attributionSchema }, { additionalProperties: false })
const provenance = Type.Object({ sessionId: id, runId: id, requestId: id, briefVersion: clock, basis: Type.Optional(draftSchema.properties.basis), briefReferences: Type.Optional(draftSchema.properties.briefReferences), inputs: evidence,
  observationVersions: Type.Record(Type.String(), clock), attributionVersions: Type.Record(Type.String(), clock), tail: Type.String({ maxLength: 30000 }), knownDiscardIds: Type.Optional(Type.Array(id, { maxItems: 8 })) }, { additionalProperties: false })
const { directionId: _directionId, ...draftFields } = draftSchema.properties
const direction = Type.Object({ ...draftFields, id, version: clock, requestId: id, provenance,
  publishedAt: clock, publishedMediaMs: clock, lifecycle: StringEnum(['active', 'reassess', 'withdrawn'] as const), warning: nullableText, invalidatedMediaMs: nullableClock,
}, { additionalProperties: false })
const selection = Type.Object({ id, direction, selectedAt: clock, mediaMs: clock, speechAfter: evidence, userParticipantId: nullableText,
  warning: nullableText, expression: StringEnum(['uncertain', 'expressed', 'partial', 'departed', 'interrupted'] as const), reason: text, evidence }, { additionalProperties: false })
const input = Type.Object({ sessionId: id, runId: id, requestId: id, revision: clock, briefVersion: clock, brief: briefSchema,
  rephrase: Type.Optional(Type.Object({ id, version: clock, transformation: StringEnum(['simpler', 'shorter', 'alternative'] as const), direction }, { additionalProperties: false })),
  generation: Type.Optional(Type.Literal('another')),
  languages: Type.Optional(Type.Object({ user: text, conversation: text, automatic: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
  rejectedFindings: Type.Optional(Type.Array(Type.Object({ id, meaning: text, evidence }, { additionalProperties: false }), { maxItems: 8 })), observations: Type.Array(observationSchema, { maxItems: 16 }), transcript: Type.Array(segment, { maxItems: 18 }), tail: Type.String({ maxLength: 30000 }), floor: Type.Union([attributionSchema, Type.Null()]),
  selected: Type.Union([Type.Object({ selectionId: id, directionId: id, version: clock, move: draftSchema.properties.move, meaning: text, opening: text, objectiveIds: Type.Array(id), assumptions: Type.Array(text), historicalEvidence: evidence, warning: nullableText }, { additionalProperties: false }), Type.Null()]), recent: Type.Array(Type.Object({ id, label: text, meaning: text, opening: text }), { maxItems: 6 }), mediaMs: clock, availableAt: clock, style: text }, { additionalProperties: false })
export const suggestionStateSchema = Type.Object({ sessionId: id, runId: id, version: clock, mode: StringEnum(['off', 'saved', 'predictive', 'baseline'] as const), configuration: Type.Object({ model: text, temperature: clock, maxTokens: clock, promptVersion: text, coalesceMs: clock }, { additionalProperties: false }), style: text, userParticipantId: nullableText,
  directions: Type.Array(direction, { maxItems: 3 }), recommendedId: nullableText, selected: Type.Union([selection, Type.Null()]), history: Type.Array(direction, { maxItems: 120 }), turns: Type.Array(Type.Object({ id, endMs: clock }, { additionalProperties: false }), { maxItems: 80 }),
  request: Type.Union([Type.Null(), Type.Object({ id, input, startedAt: clock, completedAt: nullableClock, firstPublishedAt: nullableClock, outcome: StringEnum(['running', 'complete', 'obsolete', 'error'] as const) }, { additionalProperties: false })]),
  status: StringEnum(['idle', 'scheduled', 'generating', 'waiting', 'error', 'saved'] as const), message: nullableText }, { additionalProperties: false })
export const suggestionRowSchema = Type.Object({ kind: Type.Literal('suggestion'), atMs: clock, tailMs: Type.Optional(clock), reason: StringEnum(['initial', 'request', 'published', 'recommendation', 'waiting', 'invalidated', 'selected', 'released', 'expression', 'config', 'turn_end'] as const), state: suggestionStateSchema }, { additionalProperties: false })
export const parseSuggestionRow = (value: unknown): SuggestionRow => validate(suggestionRowSchema, value)
