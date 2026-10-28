import type { Attribution, Brief, Evidence, Observation } from './analysis'
import type { Segment } from './protocol'
import { defaultLanguageModel } from './models'

export type SuggestionMode = 'off' | 'saved' | 'predictive' | 'baseline'
export type Expression = 'uncertain' | 'expressed' | 'partial' | 'departed' | 'interrupted'
export interface SuggestionInput {
  rephrase?: { id: string; version: number; transformation: 'simpler' | 'shorter' | 'alternative'; direction: Direction }
  generation?: 'another'
  languages?: { user: string; conversation: string; automatic?: boolean }
  sessionId: string; runId: string; requestId: string; revision: number; briefVersion: number
  brief: Brief; observations: Observation[]
  rejectedFindings?: Pick<Observation, 'id' | 'meaning' | 'evidence'>[]
  transcript: (Segment & { attribution: Attribution })[]
  tail: string; floor: Attribution | null
  selected: { selectionId: string; directionId: string; version: number; move: DirectionDraft['move']; meaning: string; opening: string; objectiveIds: string[]; assumptions: string[]; historicalEvidence: Evidence[]; warning: string | null } | null
  recent: Pick<Direction, 'id' | 'label' | 'meaning' | 'opening'>[]
  mediaMs: number; availableAt: number; style: string
}
export interface DirectionDraft {
  directionId: string | null
  label: string; move: 'answer' | 'clarify' | 'explain' | 'check' | 'negotiate' | 'confirm' | 'return'
  objectiveIds: string[]; meaning: string; opening: string; continuation: string | null
  basis?: 'brief' | 'transcript' | 'neutral'
  briefReferences?: string[]
  evidence: Evidence[]; observationIds: string[]; assumptions: string[]
  status: 'provisional' | 'ready'
  language?: string
  translation?: { language: string; opening: string; continuation: string | null } | null
}
export interface Direction extends Omit<DirectionDraft, 'directionId'> {
  id: string; version: number; requestId: string
  provenance: { sessionId: string; runId: string; requestId: string; briefVersion: number; basis?: 'brief' | 'transcript' | 'neutral'; briefReferences?: string[]; inputs: Evidence[]; observationVersions: Record<string, number>; attributionVersions: Record<string, number>; tail: string; knownDiscardIds?: string[] }
  publishedAt: number; publishedMediaMs: number
  lifecycle: 'active' | 'reassess' | 'withdrawn'; warning: string | null; invalidatedMediaMs: number | null
}
export interface DirectionSelection {
  id: string; direction: Direction; selectedAt: number; mediaMs: number
  speechAfter: Evidence[]; userParticipantId: string | null
  warning: string | null
  expression: Expression; reason: string; evidence: Evidence[]
}
export interface SuggestionRequest {
  id: string; input: SuggestionInput; startedAt: number; completedAt: number | null
  firstPublishedAt: number | null; outcome: 'running' | 'complete' | 'obsolete' | 'error'
}
export interface SuggestionState {
  sessionId: string; runId: string; version: number; mode: SuggestionMode
  configuration: { model: string; temperature: number; maxTokens: number; promptVersion: string; coalesceMs: number }
  style: string; userParticipantId: string | null
  directions: Direction[]; recommendedId: string | null; selected: DirectionSelection | null
  history: Direction[]; turns: { id: string; endMs: number }[]
  request: SuggestionRequest | null; status: 'idle' | 'scheduled' | 'generating' | 'waiting' | 'error' | 'saved'
  message: string | null
}
export type SuggestionReason = 'initial' | 'request' | 'published' | 'recommendation' | 'waiting' | 'invalidated' | 'selected' | 'released' | 'expression' | 'config' | 'turn_end'
export interface SuggestionRow { kind: 'suggestion'; atMs: number; tailMs?: number; reason: SuggestionReason; state: SuggestionState }
export type SuggestionAction =
  | { action: 'suggest_config'; mode: 'off' | 'predictive' | 'baseline'; style: string; userParticipantId: string | null }
  | { action: 'suggest_another' }
  | { action: 'suggest_rephrase'; id: string; version: number; transformation: 'simpler' | 'shorter' | 'alternative' }
  | { action: 'suggest_select'; id: string; version: number }
  | { action: 'suggest_release'; selectionId: string }
export function emptySuggestions(sessionId: string, mode: SuggestionMode = 'predictive'): SuggestionState {
  return { sessionId, runId: crypto.randomUUID(), version: 0, mode, configuration: { model: defaultLanguageModel, temperature: .2, maxTokens: 2000, promptVersion: 'suggest-v5-conversation-goals', coalesceMs: 180 }, style: 'Short, natural, conversational.', userParticipantId: null, directions: [], recommendedId: null, selected: null, history: [], turns: [], request: null, status: mode === 'saved' ? 'saved' : 'waiting', message: null }
}
export const directionKey = (direction: Pick<Direction, 'id' | 'version'>) => `${direction.id}:${direction.version}`
