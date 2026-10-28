export type Delay = 'minimal' | 'low'
export type Phase = 'configuring' | 'ready' | 'running' | 'paused' | 'draining' | 'ended' | 'error'
export type Mode = 'live' | 'replay'
export type ReplaySpeed = 1 | 2 | 5 | 10
export const replaySpeeds: readonly ReplaySpeed[] = [1, 2, 5, 10]

export interface SavedTranscript {
  id: string
  source: Recording
  createdAt: string
  audioAvailable: boolean
  durationMs: number
}

export interface Recording {
  id: string
  name: string
  size: number
  replayId: string | null
  capture?: import('./capture').CaptureRecording
}

export interface SourceLibrary {
  media: Recording[]
  sessions: SavedTranscript[]
}

export interface Segment {
  sessionId: string
  sourceId: string
  id: string
  order: number
  revision: number
  text: string
  status: 'partial' | 'final'
  capture?: { startMs: number; endMs: number; separation?: 'unverified' | 'user-verified'; callTransmission: 'unknown' }
}

export interface Diagnostics {
  mediaMs: number
  sentMs: number
  queuedMs: number
}

export interface Session {
  id: string
  source: Recording
  mode: Mode
  delay: Delay
  phase: Phase
  diagnostics: Diagnostics
  message: string | null
  persistenceMessage?: string | null
  capture?: import('./capture').CaptureStatus
  replay?: { archiveId: string; speed: ReplaySpeed; durationMs: number; analysisMode?: AnalysisMode; suggestionMode?: SuggestionMode; review?: boolean }
}

// A playback Start acknowledges readiness, then reports the actual audio clock.
// Repeating this command never creates another run or provider connection.
export type ClientCommand =
  | { type: 'start'; sourceId: string; mode: 'live'; delay: Delay }
  | { type: 'start'; archiveId: string; speed: ReplaySpeed; restart?: boolean; analysisMode?: AnalysisMode; suggestionMode?: SuggestionMode }
  | { type: 'seek'; sessionId: string; playbackMs: number }
  | { type: 'speed'; sessionId: string; speed: ReplaySpeed; playbackMs?: number }
  | { type: 'start'; sessionId: string; playbackMs: number }
  | { type: 'stop'; sessionId: string; playbackMs: number; reason?: 'eof' }

export type ServerPayload =
  | { type: 'background'; analysis: AnalysisState; suggestions?: SuggestionState }
  | { type: 'snapshot'; session: Session | null; segments: Segment[]; analysis?: AnalysisState; suggestions?: SuggestionState }
  | { type: 'analysis'; analysis: AnalysisState }
  | { type: 'suggestions'; suggestions: SuggestionState }
  | { type: 'status'; session: Session }
  | { type: 'transcript'; segment: Segment; mediaMs?: number }
  | { type: 'error'; message: string }
  | { type: 'ended'; session: Session }

export type ServerEvent = ServerPayload & { sessionId: string | null; seq: number }

export const active = (phase: Phase) => !['ended', 'error', 'paused'].includes(phase)

export function parseCommand(value: unknown): ClientCommand {
  if (!value || typeof value !== 'object') throw new Error('Expected a command object.')
  const command = value as Record<string, unknown>
  if (command.type === 'start' && typeof command.sourceId === 'string' &&
      command.mode === 'live' &&
      (command.delay === 'minimal' || command.delay === 'low')) {
    return { type: 'start', sourceId: command.sourceId, mode: command.mode, delay: command.delay }
  }
  if ((command.type === 'start' || command.type === 'speed') && replaySpeeds.includes(command.speed as ReplaySpeed)) {
    if (command.type === 'start' && typeof command.archiveId === 'string') return { type: 'start', archiveId: command.archiveId, speed: command.speed as ReplaySpeed, ...(command.restart === true ? { restart: true } : {}), analysisMode: command.analysisMode === 'recompute' ? 'recompute' : 'saved', suggestionMode: ['predictive', 'baseline', 'off'].includes(String(command.suggestionMode)) ? command.suggestionMode as SuggestionMode : 'saved' }
    if (command.type === 'speed' && typeof command.sessionId === 'string') {
      if (command.playbackMs !== undefined && (typeof command.playbackMs !== 'number' || !Number.isFinite(command.playbackMs) || command.playbackMs < 0)) throw new Error('Invalid speed-change playback position.')
      return { type: 'speed', sessionId: command.sessionId, speed: command.speed as ReplaySpeed,
        ...(typeof command.playbackMs === 'number' ? { playbackMs: command.playbackMs } : {}) }
    }
  }
  if ((command.type === 'start' || command.type === 'stop' || command.type === 'seek') &&
      typeof command.sessionId === 'string' && typeof command.playbackMs === 'number' &&
      Number.isFinite(command.playbackMs) && command.playbackMs >= 0) {
    const playback = { sessionId: command.sessionId, playbackMs: command.playbackMs }
    if (command.type === 'seek') return { type: 'seek', ...playback }
    return command.type === 'start' ? { type: 'start', ...playback } : { type: 'stop', ...playback, ...(command.reason === 'eof' ? { reason: 'eof' as const } : {}) }
  }
  throw new Error('Invalid start or stop command.')
}
import type { AnalysisMode, AnalysisState } from './analysis'

import type { SuggestionMode, SuggestionState } from './suggestions'
