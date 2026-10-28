import type { Segment, ServerEvent, Session } from '../shared/protocol'
import type { SuggestionState } from '../shared/suggestions'
import type { AnalysisState } from '../shared/analysis'

export interface ViewState {
  session: Session | null
  segments: Map<string, Segment>
  order: string[]
  seq: number
  error: string | null
  suggestions: SuggestionState | null
  analysis: AnalysisState | null
}

export const initialState: ViewState = {
  session: null, segments: new Map(), order: [], seq: -1, error: null,
  analysis: null, suggestions: null,
}

export function reduceEvent(state: ViewState, event: ServerEvent): ViewState {
  if (event.type === 'background') {
    if (event.sessionId !== (state.session?.id ?? null)) return state
    const analysis = state.analysis?.runId === event.analysis.runId && state.analysis.version > event.analysis.version ? state.analysis : event.analysis
    const suggestions = state.suggestions?.runId === event.suggestions?.runId && state.suggestions && state.suggestions.version > (event.suggestions?.version ?? -1) ? state.suggestions : event.suggestions ?? null
    return { ...state, analysis, suggestions }
  }
  // Only snapshots can reset the sequence after a server restart.
  if (event.type === 'snapshot') {
    const segments = new Map(event.segments.map(segment => [segment.id, segment]))
    return { ...initialState, seq: event.seq, session: event.session, segments,
      order: [...segments.values()].sort((a, b) => a.order - b.order).map(segment => segment.id),
      error: event.session?.message ?? null, suggestions: event.suggestions ?? (event.session?.id === state.session?.id ? state.suggestions : null), analysis: event.analysis ?? (event.session?.id === state.session?.id ? state.analysis : null) }
  }
  if (event.type !== 'analysis' && event.type !== 'suggestions' && event.seq <= state.seq) return state
  if (event.type === 'status') {
    if (event.sessionId !== state.session?.id) {
      if (event.session.phase !== 'configuring') return state
      return { ...initialState, seq: event.seq, session: event.session, analysis: null }
    }
    return { ...state, seq: event.seq, session: event.session,
      error: ['configuring', 'ready', 'running'].includes(event.session.phase) && !event.session.message ? null : state.error }
  }
  if (event.sessionId !== (state.session?.id ?? null)) return state
  if (event.type === 'suggestions') {
    if (event.suggestions.sessionId !== (state.session?.id ?? 'preparation')) return state
    if (state.suggestions?.runId === event.suggestions.runId && state.suggestions.version >= event.suggestions.version) return state
    return { ...state, suggestions: event.suggestions }
  }
  if (event.type === 'analysis') {
    if (event.analysis.sessionId !== (state.session?.id ?? 'preparation')) return state
    if (state.analysis?.runId === event.analysis.runId && state.analysis.version >= event.analysis.version) return state
    return { ...state, analysis: event.analysis }
  }
  if (event.type === 'error') return { ...state, seq: event.seq, error: event.message }
  if (event.type === 'ended') {
    if (event.session.id !== state.session?.id) return state
    return { ...state, seq: event.seq, session: event.session, error: event.session.message ?? state.error }
  }
  const segment = event.segment
  if (segment.sessionId !== state.session?.id || (segment.sourceId !== state.session.source.id && !(state.session.source.capture && ['local-microphone', 'remote-playback'].includes(segment.sourceId)))) return state
  const old = state.segments.get(segment.id)
  if (old && segment.revision <= old.revision) return state
  // Reuse all unaffected segment objects and the order array for ordinary deltas.
  const segments = new Map(state.segments)
  segments.set(segment.id, segment)
  const order = !old || old.order !== segment.order
    ? [...segments.values()].sort((a, b) => a.order - b.order).map(segment => segment.id) : state.order
  return { ...state, seq: event.seq, segments, order }
}
