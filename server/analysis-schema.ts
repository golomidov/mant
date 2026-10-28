import { Type, StringEnum, validateToolArguments, type JsonObject, type Static, type TSchema } from '@earendil-works/pi-ai'
import { supportedLanguageCodes } from '../shared/languages'

const text = Type.String({ maxLength: 4000 })
const id = Type.String({ minLength: 1, maxLength: 160 })
const nullableId = Type.Union([id, Type.Null()])
const list = <T extends TSchema>(schema: T, maxItems = 64) => Type.Array(schema, { maxItems })
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false })
const choice = <const T extends readonly string[]>(...values: T) => StringEnum(values)
export const evidenceSchema = object({ segmentId: id, revision: Type.Integer({ minimum: 0 }) })
export const segmentCaptureSchema = object({ startMs: Type.Number({ minimum: 0 }), endMs: Type.Number({ minimum: 0 }), separation: Type.Optional(choice('unverified', 'user-verified')), callTransmission: Type.Literal('unknown') })
const evidence = list(evidenceSchema, 32)
const origin = choice('explicit', 'inferred')
const status = choice('unexplored', 'partial', 'answered', 'expressed', 'achieved', 'blocked', 'dropped')
const objectiveFields = {
  id, kind: choice('question', 'say', 'outcome'), description: text, completion: text, origin, timing: Type.Optional(choice('opening', 'anytime')),
}
const historySchema = object({ status, reason: text, evidence, atMs: Type.Number({ minimum: 0 }) })
export const objectiveSchema = object({ ...objectiveFields, status, evidence, reason: text, history: Type.Array(historySchema), confirmedByUser: Type.Optional(Type.Boolean()) })
const briefFields = {
  items: list(object({ id, category: choice('purpose', 'background', 'preference', 'compromise', 'boundary', 'user_fact', 'interpretation'), text, origin })),
  sides: list(object({ id, name: text })), participants: list(object({ id, name: text, sideId: nullableId })),
  languages: object({ call: text, user: Type.Optional(text) }), clarifications: list(text, 3),
}
export const briefSchema = object({ ...briefFields, version: Type.Integer({ minimum: 0 }), analysisVersion: Type.Optional(Type.Integer({ minimum: 0 })), protectedIds: list(id, 260), preparation: Type.String({ maxLength: 40000 }), userParticipantId: Type.Optional(id), conversationSideId: Type.Optional(id), answers: Type.String({ maxLength: 12000 }), objectives: list(objectiveSchema) })
export const attributionSchema = object({ participantId: nullableId, sideId: nullableId, sourceLabel: text, revision: Type.Integer({ minimum: 0 }) })
export const groundingSchema = object({ kind: choice('direct', 'contextual', 'uncertain'), quotes: list(object({ ...evidenceSchema.properties, text: Type.String({ minLength: 1, maxLength: 1200 }) }), 8), entityExplanation: text, unresolved: Type.Optional(list(text, 8)) })
const observationFields = {
  grounding: Type.Optional(groundingSchema),
  type: choice('claim', 'question', 'request', 'proposal', 'condition', 'objection', 'agreement', 'commitment', 'correction', 'contradiction'),
  meaning: text, evidence, status: choice('provisional', 'established', 'retracted'),
  relations: list(object({ objectiveId: id, relationship: choice('answers', 'expresses', 'supports', 'blocks', 'qualifies', 'changes_scope') })),
  attention: choice('normal', 'important', 'urgent'), conditions: list(text, 12), addressedToUser: Type.Boolean(), hypothetical: Type.Boolean(), quoted: Type.Boolean(), reason: text,
}
export const observationSchema = object({ ...observationFields, id, version: Type.Integer({ minimum: 0 }), speaker: attributionSchema, correctedByUser: Type.Boolean(), discardedByUser: Type.Optional(Type.Boolean()), effectiveMs: Type.Number({ minimum: 0 }) })
const identity = { sessionId: id, runId: id, requestId: id }
export const briefProposalSchema = object({ ...identity, ...briefFields, objectives: list(object(objectiveFields)) })
// People are application-owned until diarization can establish identities.
export const briefExtractionSchema = object({ ...briefProposalSchema.properties,
  sides: Type.Array(briefFields.sides.items, { maxItems: 0 }),
  participants: Type.Array(briefFields.participants.items, { maxItems: 0 }),
})
export const selectionAssessmentSchema = object({ selectionId: id, status: choice('uncertain', 'expressed', 'partial', 'departed', 'interrupted'), evidence, reason: text })
const translationsSchema = list(object({ ...evidenceSchema.properties, sourceLanguage: choice(...supportedLanguageCodes), targetLanguage: choice(...supportedLanguageCodes), text: Type.String({ minLength: 1, maxLength: 24000 }) }), 16)
export const trackProposalSchema = object({ ...identity,
  detectedLanguage: Type.Optional(choice(...supportedLanguageCodes, 'unknown')),
  translations: Type.Optional(translationsSchema),
  observations: list(object({ ...observationFields, id: Type.Union([id, Type.Null()]) }), 32),
  objectives: list(object({ id, status, evidence, reason: text })),
  openQuestions: list(text, 12), replanReasons: list(text, 8), selectionAssessment: Type.Optional(Type.Union([selectionAssessmentSchema, Type.Null()])),
})
export type BriefProposal = Static<typeof briefProposalSchema>
export type TrackProposal = Static<typeof trackProposalSchema>
export function trackSchemaFor(input: { selection?: { id: string } | null; request: { sessionId: string; runId: string; id: string; inputs: { segmentId: string; revision: number }[] }; observations: { id: string }[]; brief: { objectives: { id: string; kind: 'question' | 'say' | 'outcome'; status: string }[] } }, cacheable = false) {
  // Pi strict sampling accepts flat objects, not unions of object schemas.
  // The coordinator checks exact ID/revision pairs and kind/status compatibility.
  const reference = !cacheable && input.request.inputs.length ? object({ segmentId: StringEnum([...new Set(input.request.inputs.map(e => e.segmentId))]), revision: Type.Integer({ minimum: 0 }) }) : evidenceSchema
  const evidence = Type.Array(reference, { minItems: 1, maxItems: 32 })
  const observation = trackProposalSchema.properties.observations.items
  const objective = trackProposalSchema.properties.objectives.items
  const goals = input.brief.objectives.filter(o => o.status !== 'dropped')
  const relations = observation.properties.relations.items
  const statuses = cacheable ? choice('unexplored', 'partial', 'answered', 'expressed', 'achieved', 'blocked') : goals.every(goal => goal.kind === 'question') ? choice('unexplored', 'partial', 'answered', 'blocked') : goals.every(goal => goal.kind === 'outcome') ? choice('unexplored', 'partial', 'achieved', 'blocked') : choice('unexplored', 'partial', 'answered', 'expressed', 'achieved', 'blocked')
  return object({ ...trackProposalSchema.properties, selectionAssessment: input.selection ? object({ ...selectionAssessmentSchema.properties, selectionId: cacheable ? id : Type.Literal(input.selection.id), evidence: Type.Array(reference, { maxItems: 32 }) }) : Type.Null(),
    detectedLanguage: choice(...supportedLanguageCodes, 'unknown'),
    translations: Type.Array(translationsSchema.items, { maxItems: 0 }),
    ...(cacheable ? identity : { sessionId: Type.Literal(input.request.sessionId), runId: Type.Literal(input.request.runId), requestId: Type.Literal(input.request.id) }),
    observations: list(object({ ...observation.properties, evidence, grounding: object({ ...groundingSchema.properties, unresolved: list(text, 8) }),
      id: cacheable ? Type.Union([id, Type.Null()]) : input.observations.length ? Type.Union([StringEnum(input.observations.map(o => o.id)), Type.Null()]) : Type.Null(),
      relations: Type.Array(object({ ...relations.properties, objectiveId: !cacheable && goals.length ? StringEnum(goals.map(o => o.id)) : id }), { maxItems: cacheable || goals.length ? 64 : 0 }),
    }), 32),
    objectives: Type.Array(object({ ...objective.properties, evidence, id: !cacheable && goals.length ? StringEnum(goals.map(goal => goal.id)) : id, status: statuses }), { maxItems: cacheable || goals.length ? 64 : 0 }),
  })
}
const clock = Type.Number({ minimum: 0 })
const nullableClock = Type.Union([clock, Type.Null()])
const requestSchema = object({ id, sessionId: id, runId: id, mode: choice('BRIEF', 'TRACK'), briefVersion: clock,
  inputs: Type.Array(evidenceSchema), observationVersions: Type.Record(Type.String(), clock), attributionVersions: Type.Record(Type.String(), clock),
  availableAt: clock, scheduledAt: clock, startedAt: clock, completedAt: nullableClock, appliedAt: nullableClock, effectiveMs: clock,
  outcome: choice('running', 'applied', 'stale', 'error'), schedulingDelayMs: nullableClock, inferenceMs: nullableClock, totalDelayMs: nullableClock, provisionalBeforeFinal: Type.Boolean(),
})
export const analysisStateSchema = object({ sessionId: id, runId: id, version: clock, brief: briefSchema,
  translationStatus: Type.Optional(choice('idle', 'translating', 'error')), translationMessage: Type.Optional(Type.Union([text, Type.Null()])),
  detectedLanguage: Type.Optional(text),
  translations: Type.Optional(Type.Record(Type.String(), object({ revision: Type.Integer({ minimum: 0 }), sourceLanguage: text, targetLanguage: text, text: Type.String({ minLength: 1, maxLength: 24000 }), sourceText: Type.Optional(Type.String({ maxLength: 100000 })) }))),
  observations: Type.Array(observationSchema), attributions: Type.Record(Type.String(), attributionSchema), openQuestions: list(text, 12),
  replan: object({ needed: Type.Boolean(), reasons: list(text, 16), version: clock }), status: choice('idle', 'scheduled', 'analyzing', 'error', 'saved'),
  briefRequest: Type.Optional(Type.Union([requestSchema, Type.Null()])), briefStatus: Type.Optional(choice('idle', 'analyzing', 'error')), briefMessage: Type.Optional(Type.Union([text, Type.Null()])),
  message: Type.Union([text, Type.Null()]), analyzedThroughMs: clock, availableThroughMs: clock, pendingSegments: clock, request: Type.Union([requestSchema, Type.Null()]), journalId: nullableId,
})
export const analysisRowSchema = object({ kind: Type.Literal('analysis'), atMs: clock, tailMs: Type.Optional(clock), effectiveMs: clock,
  reason: choice('initial', 'brief_user', 'brief_model', 'observation_user', 'objective_user', 'translation', 'attribution', 'transcript_revision', 'track', 'request', 'progress'), state: analysisStateSchema,
})
export function validate<T extends TSchema>(schema: T, value: unknown): Static<T> {
  try {
    // Use the same schema/validation boundary as Pi agent tools. Clone because
    // Pi may normalize arguments; never mutate incoming application state.
    return validateToolArguments({ name: 'state', description: 'Application state', parameters: schema }, {
      type: 'toolCall', id: 'validation', name: 'state', arguments: structuredClone(value) as JsonObject,
    }) as Static<T>
  } catch { throw new Error('Invalid structured analysis data. No changes applied.') }
}
