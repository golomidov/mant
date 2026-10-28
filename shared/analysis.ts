export type ObjectiveStatus = 'unexplored' | 'partial' | 'answered' | 'expressed' | 'achieved' | 'blocked' | 'dropped'
export type Origin = 'explicit' | 'inferred'
export interface Evidence { segmentId: string; revision: number }
export interface Objective {
  id: string
  kind: 'question' | 'say' | 'outcome'
  timing?: 'opening' | 'anytime'
  description: string
  completion: string
  origin: Origin
  status: ObjectiveStatus
  evidence: Evidence[]
  reason: string
  history: { status: ObjectiveStatus; reason: string; evidence: Evidence[]; atMs: number }[]
  confirmedByUser?: boolean
}
export interface Brief {
  version: number
  /** Last version that changed inputs used by live analysis. Draft text saves do not. */
  analysisVersion?: number
  protectedIds: string[]
  preparation: string
  answers: string
  items: { id: string; category: 'purpose' | 'background' | 'preference' | 'compromise' | 'boundary' | 'user_fact' | 'interpretation'; text: string; origin: Origin }[]
  objectives: Objective[]
  sides: { id: string; name: string }[]
  participants: { id: string; name: string; sideId: string | null }[]
  userParticipantId?: string
  conversationSideId?: string
  languages: { call: string; user?: string }
  clarifications: string[]
}
export interface Attribution { participantId: string | null; sideId: string | null; sourceLabel: string; revision: number }
export interface Observation {
  id: string
  version: number
  type: 'claim' | 'question' | 'request' | 'proposal' | 'condition' | 'objection' | 'agreement' | 'commitment' | 'correction' | 'contradiction'
  meaning: string
  evidence: Evidence[]
  speaker: Attribution
  status: 'provisional' | 'established' | 'retracted'
  relations: { objectiveId: string; relationship: 'answers' | 'expresses' | 'supports' | 'blocks' | 'qualifies' | 'changes_scope' }[]
  attention: 'normal' | 'important' | 'urgent'
  conditions: string[]
  addressedToUser: boolean
  hypothetical: boolean
  quoted: boolean
  grounding?: { kind: 'direct' | 'contextual' | 'uncertain'; quotes: (Evidence & { text: string })[]; entityExplanation: string; unresolved?: string[] }
  discardedByUser?: boolean
  correctedByUser: boolean
  effectiveMs: number
  reason: string
}
export interface AnalysisRequest {
  id: string; sessionId: string; runId: string; mode: 'BRIEF' | 'TRACK'; briefVersion: number
  inputs: Evidence[]
  observationVersions: Record<string, number>
  attributionVersions: Record<string, number>
  availableAt: number; scheduledAt: number; startedAt: number; completedAt: number | null; appliedAt: number | null
  effectiveMs: number
  outcome: 'running' | 'applied' | 'stale' | 'error'
  schedulingDelayMs: number | null; inferenceMs: number | null; totalDelayMs: number | null
  provisionalBeforeFinal: boolean
}
export interface AnalysisState {
  sessionId: string
  runId: string
  version: number
  brief: Brief
  observations: Observation[]
  attributions: Record<string, Attribution>
  openQuestions: string[]
  replan: { needed: boolean; reasons: string[]; version: number }
  status: 'idle' | 'scheduled' | 'analyzing' | 'error' | 'saved'
  message: string | null
  analyzedThroughMs: number
  availableThroughMs: number
  pendingSegments: number
  briefRequest?: AnalysisRequest | null
  briefStatus?: 'idle' | 'analyzing' | 'error'
  briefMessage?: string | null
  request: AnalysisRequest | null
  journalId: string | null
  detectedLanguage?: string
  translations?: Record<string, TranscriptTranslation>
  translationStatus?: 'idle' | 'translating' | 'error'
  translationMessage?: string | null
}
export interface TranscriptTranslation { revision: number; sourceLanguage: string; targetLanguage: string; text: string; sourceText?: string }

export type AnalysisReason = 'initial' | 'brief_user' | 'brief_model' | 'observation_user' | 'objective_user' | 'translation' | 'attribution' | 'transcript_revision' | 'track' | 'request' | 'progress'
export interface AnalysisRow { kind: 'analysis'; atMs: number; tailMs?: number; effectiveMs: number; reason: AnalysisReason; state: AnalysisState }
export type AnalysisMode = 'saved' | 'recompute'
export type AssistantAction =
  | { action: 'brief'; version: number; brief: Brief }
  | { action: 'extract'; version: number; brief: Brief }
  | { action: 'extract' | 'retry' | 'retry_translation' }
  | { action: 'confirm_objective'; id: string; version: number; evidence: Evidence[] }
  | { action: 'discard'; id: string; version: number }
  | { action: 'correct'; id: string; version: number; meaning: string; status: Observation['status'] }
  | { action: 'attribute'; segmentIds: string[]; participantId: string | null; sideId: string | null; sourceLabel: string }

export function emptyBrief(): Brief {
  return { version: 0, protectedIds: [], preparation: '', answers: '', items: [], objectives: [], sides: [], participants: [], languages: { call: '' }, clarifications: [] }
}

export const briefAnalysisVersion = (brief: Brief) => brief.analysisVersion ?? brief.version

/** Keep the user's identity explicit without guessing who a named participant is. */
export function briefWithPeople(brief: Brief, knownUserId?: string | null): Brief {
  const result = structuredClone(brief)
  let me = result.participants.find(p => p.id === result.userParticipantId)
    ?? result.participants.find(p => p.id === knownUserId)
  if (!me) {
    me = { id: crypto.randomUUID(), name: 'Me', sideId: null }
    result.participants.unshift(me)
  }
  let mySide = result.sides.find(side => side.id === me.sideId)
  if (!mySide) {
    mySide = { id: crypto.randomUUID(), name: 'My side' }
    result.sides.unshift(mySide)
    me.sideId = mySide.id
  }
  let otherSide = result.sides.find(side => side.id === result.conversationSideId && side.id !== mySide.id)
    ?? result.sides.find(side => side.id !== mySide.id)
  if (!otherSide) {
    otherSide = { id: crypto.randomUUID(), name: 'Other side' }
    result.sides.push(otherSide)
  }
  result.userParticipantId = me.id
  result.conversationSideId = otherSide.id
  result.protectedIds = [...new Set([...result.protectedIds, me.id, mySide.id, otherSide.id])]
  return result
}
export function emptyAnalysis(sessionId: string, brief = emptyBrief()): AnalysisState {
  return { sessionId, runId: crypto.randomUUID(), version: 0, brief: structuredClone(brief), observations: [], attributions: {}, openQuestions: [], replan: { needed: false, reasons: [], version: 0 }, status: 'idle', message: null, analyzedThroughMs: 0, availableThroughMs: 0, pendingSegments: 0, request: null, journalId: null }
}
