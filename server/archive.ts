import { archiveIndex } from './archive-indexer'
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Recording, SavedTranscript, Segment } from '../shared/protocol'
import type { AnalysisRow, AnalysisState, Evidence } from '../shared/analysis'
import type { SuggestionRow, SuggestionState } from '../shared/suggestions'
import { parseSuggestionRow } from './suggestion-schema'
import { analysisRowSchema, analysisStateSchema, validate } from './analysis-schema'
import type { CaptureJournalRow } from './capture-recording'
import { parseCaptureSelection, parseCaptureGains, captureSources } from '../shared/capture'

export interface ArchiveHeader { kind: 'header'; version: 1; id: string; source: Recording; createdAt: string }
export interface ArchiveUpdate { kind: 'transcript'; atMs: number; receivedElapsedMs?: number; tailMs?: number; segment: Segment }
export interface ArchiveEnd { kind: 'end'; atMs: number; complete: boolean }
export type ArchiveRow = ArchiveHeader | ArchiveUpdate | ArchiveEnd | AnalysisRow | SuggestionRow | CaptureJournalRow

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'

/** Retired draft fields are migrated only on preparation restore, not in archives. */
function restorePreparation(value: unknown): AnalysisState {
  if (object(value) && object(value.brief)) {
    const brief = value.brief
    delete brief.contextInPreparation
    if (object(brief.languages)) {
      const languages = brief.languages
      // The old interface language became the user's reading/translation language.
      languages.user ??= languages.interface ?? languages.reply
      delete languages.interface
      delete languages.reply
      if (languages.user === undefined) delete languages.user
    }
  }
  return validate(analysisStateSchema, value)
}

function analysisReferences(state: AnalysisState, revisions: Map<string, Set<number>>) {
  const evidence = (items: Evidence[]) => items.every(e => revisions.get(e.segmentId)?.has(e.revision))
  const objectives = new Set(state.brief.objectives.map(o => o.id))
  const participant = (id: string | null) => id === null || state.brief.participants.some(p => p.id === id)
  const side = (id: string | null) => id === null || state.brief.sides.some(s => s.id === id)
  if (state.observations.some(o => o.grounding?.quotes.some(q => !o.evidence.some(e => e.segmentId === q.segmentId && e.revision === q.revision)) || !evidence(o.evidence) || o.relations.some(r => !objectives.has(r.objectiveId)) || !participant(o.speaker.participantId) || !side(o.speaker.sideId)) ||
    (state.brief.userParticipantId !== undefined && !participant(state.brief.userParticipantId)) ||
    (state.brief.conversationSideId !== undefined && !side(state.brief.conversationSideId)) ||
    Object.entries(state.translations ?? {}).some(([segmentId, translation]) => !evidence([{ segmentId, revision: translation.revision }])) ||
    state.brief.objectives.some(o => !evidence(o.evidence) || o.history.some(h => !evidence(h.evidence))) ||
    state.brief.participants.some(p => !side(p.sideId)) ||
    Object.entries(state.attributions).some(([id, attribution]) => !revisions.has(id) || !participant(attribution.participantId) || !side(attribution.sideId)) ||
    state.request && !evidence(state.request.inputs)) throw new Error('Analysis references missing or future transcript evidence, objectives or participants.')
}

function header(value: unknown): ArchiveHeader {
  if (!object(value) || value.kind !== 'header' || value.version !== 1 || typeof value.id !== 'string' ||
      typeof value.createdAt !== 'string' || value.createdAt.length > 64 || !Number.isFinite(Date.parse(value.createdAt)) || !object(value.source) ||
      typeof value.source.id !== 'string' || value.source.id.length > 128 || typeof value.source.name !== 'string' ||
      value.source.name.length > 240 || value.id.length > 128 || !finite(value.source.size)) {
    throw new Error('Invalid transcript header. Choose a Mant JSONL transcript log.')
  }
  return { kind: 'header', version: 1, id: value.id, createdAt: new Date(value.createdAt).toISOString(),
    source: { id: value.source.id, name: value.source.name, size: value.source.size,
      replayId: typeof value.source.replayId === 'string' ? value.source.replayId : null,
      ...(value.source.capture ? { capture: captureMetadata(value.source.capture) } : {}) } }
}

function captureMetadata(value: unknown): import('../shared/capture').CaptureRecording {
  if (!object(value) || (value.separation !== undefined && !['unverified', 'user-verified'].includes(String(value.separation))) || (value.diagnostic !== undefined && typeof value.diagnostic !== 'boolean') || value.clock !== 'host-monotonic' || value.callTransmission !== 'unknown' || !Array.isArray(value.tracks) || value.tracks.length > 2) throw new Error('Invalid capture metadata.')
  const tracks = value.tracks.map((track: unknown) => {
    if (!object(track) || !captureSources.includes(track.sourceId as typeof captureSources[number]) || typeof track.audioId !== 'string' || !/^[a-f0-9]{64}$/.test(track.audioId) || typeof track.name !== 'string' || track.name.length > 240 || !finite(track.durationMs)) throw new Error('Invalid capture track.')
    return track as unknown as import('../shared/capture').CaptureTrack
  })
  if (value.routeSignature !== undefined && (typeof value.routeSignature !== 'string' || value.routeSignature.length > 2000)) throw new Error('Invalid capture route.')
  return { selection: parseCaptureSelection(value.selection), separation: value.separation as 'unverified' | 'user-verified' ?? 'unverified', ...(typeof value.diagnostic === 'boolean' ? { diagnostic: value.diagnostic } : {}), clock: 'host-monotonic', callTransmission: 'unknown', tracks, gains: parseCaptureGains(value.gains), ...(typeof value.routeSignature === 'string' ? { routeSignature: value.routeSignature } : {}) }
}

function row(value: unknown): Exclude<ArchiveRow, ArchiveHeader> {
  if (!object(value) || !finite(value.atMs)) throw new Error('Invalid transcript row or replay timestamp.')
  if (value.kind === 'capture') {
    if (!['start', 'gap', 'muted', 'unmuted', 'failure', 'separation', 'finalized', 'turn_end', 'local_speech', 'metrics', 'gain', 'recovery'].includes(String(value.event)) || typeof value.detail !== 'string' || value.detail.length > 4000 || (value.sourceId !== undefined && !captureSources.includes(value.sourceId as typeof captureSources[number]))) throw new Error('Invalid capture event.')
    if (value.source !== undefined) value.source = header({ kind: 'header', version: 1, id: crypto.randomUUID(), source: value.source, createdAt: new Date().toISOString() }).source
    return value as unknown as CaptureJournalRow
  }
  if (value.kind === 'suggestion') return parseSuggestionRow(value)
  if (value.kind === 'analysis') return validate(analysisRowSchema, value)
  if (value.kind === 'end' && typeof value.complete === 'boolean') return { kind: 'end', atMs: value.atMs, complete: value.complete }
  if (value.kind !== 'transcript' || !object(value.segment)) throw new Error('Invalid transcript event.')
  const segment = value.segment
  if (typeof segment.id !== 'string' || typeof segment.sessionId !== 'string' || typeof segment.sourceId !== 'string' ||
      typeof segment.text !== 'string' || !finite(segment.order) || !Number.isInteger(segment.order) ||
      !finite(segment.revision) || !Number.isInteger(segment.revision) ||
      (segment.status !== 'partial' && segment.status !== 'final') ||
      (value.tailMs !== undefined && !finite(value.tailMs)) ||
      (value.receivedElapsedMs !== undefined && !finite(value.receivedElapsedMs))) throw new Error('Invalid transcript segment.')
  if (segment.capture !== undefined && (!object(segment.capture) || !finite(segment.capture.startMs) || !finite(segment.capture.endMs) || segment.capture.endMs < segment.capture.startMs || (segment.capture.separation !== undefined && !['unverified', 'user-verified'].includes(String(segment.capture.separation))) || segment.capture.callTransmission !== 'unknown')) throw new Error('Invalid capture transcript timing.')
  return { kind: 'transcript', atMs: value.atMs, tailMs: value.tailMs as number | undefined,
    receivedElapsedMs: value.receivedElapsedMs as number | undefined, segment: segment as unknown as Segment }
}

// Bounded incremental UTF-8/JSONL parsing, including a final line without a newline.
async function* lines(path: string): AsyncGenerator<unknown> {
  let pending = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for await (const chunk of Bun.file(path).stream()) {
    pending += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      if (newline > 1_000_000) throw new Error('Transcript row exceeds the 1 MB limit.')
      const line = pending.slice(0, newline).trim()
      pending = pending.slice(newline + 1)
      if (line) yield JSON.parse(line) as unknown
    }
    if (pending.length > 1_000_000) throw new Error('Transcript row exceeds the 1 MB limit.')
  }
  pending += decoder.decode()
  if (pending.trim()) yield JSON.parse(pending) as unknown
}

import { persistenceFor } from './persistence'
import { diagnostic } from './diagnostics'

export class Archives {
  readonly persistence
  async flush(id?: string) { await this.persistence.flush(id ? this.path(id) : undefined) }
  async shutdown() { await this.persistence.shutdown() }
  constructor(readonly directory: string, persistence = persistenceFor(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.persistence = persistence
    this.persistence.onError = (_path, error) => { diagnostic('error', { workType: 'persistence', reason: 'disk-write-failed', code: error.name }); this.onError?.(error) }
  }
  onError?: (error: Error) => void

  path(id: string) {
    if (!/^[\da-f-]{36}$/.test(id)) throw new Error('Invalid archive ID.')
    return join(this.directory, `${id}.jsonl`)
  }

  private audioMetadataPath(sourceId: string) {
    if (!/^[a-f0-9]{64}$/.test(sourceId)) throw new Error('Invalid recording content ID.')
    return join(this.directory, `${sourceId}.audio.json`)
  }

  async audio(sourceId: string): Promise<{ path: string; contentType: string } | null> {
    if (!/^[a-f0-9]{64}$/.test(sourceId)) return null
    const metadata = Bun.file(this.audioMetadataPath(sourceId))
    if (await metadata.exists()) {
      try {
        const value: unknown = await metadata.json()
        if (object(value) && typeof value.file === 'string' && value.file.startsWith(`${sourceId}.`) &&
            /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(value.file) && typeof value.contentType === 'string') {
          const path = join(this.directory, value.file)
          if (await Bun.file(path).exists()) return { path, contentType: value.contentType }
        }
      } catch { /* A matching original can repair missing or damaged metadata below. */ }
    }
    // A content-addressed audio file placed beside the log needs no separate attachment.
    for (const extension of ['wav', 'mp3', 'm4a', 'mp4', 'webm', 'ogg', 'flac', 'opus', 'aac']) {
      const path = join(this.directory, `${sourceId}.${extension}`)
      const file = Bun.file(path)
      if (!await file.exists()) continue
      const hasher = new Bun.CryptoHasher('sha256')
      for await (const chunk of file.stream()) hasher.update(chunk)
      if (hasher.digest('hex') !== sourceId) continue
      const contentType = extension === 'wav' ? 'audio/wav' : file.type || 'application/octet-stream'
      await Bun.write(this.audioMetadataPath(sourceId), JSON.stringify({ file: `${sourceId}.${extension}`, contentType }))
      return { path, contentType }
    }
    return null
  }

  async keepAudio(recording: Recording, path: string, contentType: string) {
    const extension = recording.name.split('.').at(-1)?.toLowerCase()
    const suffix = extension && /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'media'
    const file = `${recording.id}.${suffix}`
    const destination = join(this.directory, file)
    const staging = join(this.directory, `.${recording.id}.${crypto.randomUUID()}.audio-upload`)
    const metadataStaging = `${staging}.json`
    try {
      const existing = Bun.file(destination)
      if (!await existing.exists() || existing.size !== recording.size) {
        await Bun.write(staging, Bun.file(path))
        renameSync(staging, destination)
      }
      await Bun.write(metadataStaging, JSON.stringify({ file, contentType, recording: { ...recording, replayId: null } }))
      renameSync(metadataStaging, this.audioMetadataPath(recording.id))
    } finally {
      rmSync(staging, { force: true })
      rmSync(metadataStaging, { force: true })
    }
    return { path: destination, contentType }
  }

  create(id: string, source: Recording) {
    const value: ArchiveHeader = { kind: 'header', version: 1, id, source, createdAt: new Date().toISOString() }
    void this.persistence.enqueue({ kind: 'append', path: this.path(id), data: `${JSON.stringify(value)}\n`, exclusive: true })
  }

  append(id: string, value: Exclude<ArchiveRow, ArchiveHeader>) {
    void this.persistence.enqueue({ kind: 'append', path: this.path(id), data: `${JSON.stringify(value)}\n` })
  }

  async get(id: string): Promise<SavedTranscript> {
    await this.flush(id)
    const saved = await archiveIndex(id, this.path(id))
    return { ...saved, audioAvailable: !!await this.audio(saved.source.id) }
  }

  async list(): Promise<SavedTranscript[]> {
    try { await this.flush() } catch { diagnostic('error', { workType: 'persistence', reason: 'library-flush-failed' }) }
    const saved: SavedTranscript[] = []
    for (const file of readdirSync(this.directory).filter(file => /^[\da-f-]{36}\.jsonl$/.test(file))) {
      try { saved.push(await this.get(file.slice(0, -6))) } catch { /* Keep foreign/interrupted files on disk, but don't list invalid headers. */ }
    }
    return saved.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async recordings(sessions?: SavedTranscript[]): Promise<Recording[]> {
    const media = new Map<string, Recording>()
    const saved = sessions ?? await this.list()
    const listeningCopies = new Set(saved.filter(s => s.source.capture).map(s => s.source.id))
    for (const session of saved) {
      if (session.source.capture) continue
      if (session.audioAvailable && !media.has(session.source.id)) media.set(session.source.id, { ...session.source, replayId: null })
    }
    for (const name of readdirSync(this.directory)) {
      const match = /^([a-f0-9]{64})\.audio\.json$/.exec(name)
      if (!match) continue
      const id = match[1]!
      if (listeningCopies.has(id)) continue
      try {
        const stored = await this.audio(id)
        if (!stored) continue
        const metadata: unknown = await Bun.file(join(this.directory, name)).json()
        const recording = object(metadata) && object(metadata.recording) ? metadata.recording : null
        // A captured call's listening mix must never become a single-source
        // recognition input. Choose its saved session or separate originals.
        if (recording?.capture) continue
        if (recording?.id === id && typeof recording.name === 'string' && recording.name.length <= 240) {
          media.set(id, { id, name: recording.name, size: Bun.file(stored.path).size, replayId: null })
        } else if (!media.has(id)) {
          media.set(id, { id, name: `${id.slice(0, 12)}.${stored.path.split('.').at(-1)}`, size: Bun.file(stored.path).size, replayId: null })
        }
      } catch { /* Damaged or missing media cannot be selected for a new session. */ }
    }
    return [...media.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async latest(sourceId: string): Promise<string | null> {
    return (await this.list()).find(value => value.source.id === sourceId)?.id ?? null
  }

  async import(body: ReadableStream<Uint8Array>): Promise<SavedTranscript> {
    const id = crypto.randomUUID()
    const incoming = join(this.directory, `.${id}.upload`)
    const validated = join(this.directory, `.${id}.validated`)
    const writer = Bun.file(incoming).writer()
    try {
      let size = 0
      for await (const chunk of body) {
        size += chunk.byteLength
        if (size > 64 * 1024 * 1024) throw new Error('Transcript exceeds the 64 MB import limit.')
        writer.write(chunk)
        await writer.flush()
      }
      await writer.end()
      let original: ArchiveHeader | null = null
      let previousMs = 0
      let count = 0
      const revisions = new Map<string, Set<number>>()
      for await (const value of lines(incoming)) {
        if (!original) {
          original = header(value)
          appendFileSync(validated, `${JSON.stringify({ ...original, id })}\n`, { mode: 0o600, flag: 'wx' })
        } else {
          const entry = row(value)
          if (entry.kind === 'transcript') {
            if ((entry.segment.sourceId !== original.source.id && !(original.source.capture && captureSources.includes(entry.segment.sourceId as typeof captureSources[number]))) || entry.segment.sessionId !== original.id) throw new Error('Transcript contains events from a different recording or session.')
            if (entry.atMs < previousMs) throw new Error('Transcript replay timestamps must be in recording order.')
            previousMs = entry.atMs
            entry.segment = { ...entry.segment, sessionId: id }
            if (!revisions.has(entry.segment.id)) revisions.set(entry.segment.id, new Set())
            revisions.get(entry.segment.id)!.add(entry.segment.revision)
            count++
          }
          if (entry.kind === 'analysis') {
            if (entry.state.sessionId !== original.id) throw new Error('Analysis belongs to a different session.')
            entry.state.sessionId = id
            entry.state.journalId = id
            if (entry.state.request) entry.state.request.sessionId = id
            if (entry.state.briefRequest) entry.state.briefRequest.sessionId = id
            analysisReferences(entry.state, revisions)
          }
          if (entry.kind === 'suggestion') {
            if (entry.state.sessionId !== original.id) throw new Error('Suggestions belong to a different session.')
            suggestionReferences(entry.state, revisions)
            remapSuggestions(entry.state, id)
          }
          appendFileSync(validated, `${JSON.stringify(entry)}\n`)
        }
      }
      if (!original || (!count && !original.source.capture?.diagnostic)) throw new Error('The log contains no transcript updates to replay.')
      // Publish only a completely validated import. Existing archives are never overwritten.
      renameSync(validated, this.path(id))
      return this.get(id)
    } finally {
      try { await writer.end() } catch { /* Already ended or aborted. */ }
      rmSync(incoming, { force: true })
      rmSync(validated, { force: true })
    }
  }

  async *updates(id: string): AsyncGenerator<ArchiveUpdate> {
    for await (const entry of this.events(id)) if (entry.kind === 'transcript') yield entry
  }

  async *captureEvents(id: string): AsyncGenerator<CaptureJournalRow> {
    await this.flush(id)
    for await (const value of lines(this.path(id))) {
      if (object(value) && value.kind === 'capture') {
        const entry = row(value)
        if (entry.kind === 'capture') yield entry
      }
    }
  }

  async *events(id: string): AsyncGenerator<ArchiveUpdate | AnalysisRow | SuggestionRow> {
    await this.flush(id)
    let first = true
    const revisions = new Map<string, Set<number>>()
    for await (const value of lines(this.path(id))) {
      if (first) { header(value); first = false; continue }
      const entry = row(value)
      if (entry.kind === 'transcript') {
        if (!revisions.has(entry.segment.id)) revisions.set(entry.segment.id, new Set())
        revisions.get(entry.segment.id)!.add(entry.segment.revision)
      }
      if (entry.kind === 'suggestion') suggestionReferences(entry.state, revisions)
      if (entry.kind === 'analysis') analysisReferences(entry.state, revisions)
      if (entry.kind === 'analysis' || entry.kind === 'transcript' || entry.kind === 'suggestion') yield entry
    }
  }

  async preparation(): Promise<AnalysisState | null> {
    const path = join(this.directory, 'preparation.jsonl')
    await this.persistence.flush(path)
    const file = Bun.file(path)
    if (!await file.exists() || !file.size) return null
    // Preparation is append-only history; startup only needs the newest state.
    let bytes = Math.min(file.size, 65536)
    while (true) {
      const start = Math.max(0, file.size - bytes)
      const rows = (await file.slice(start).text()).split('\n')
      if (start) rows.shift() // The window can begin inside an older UTF-8 row.
      const latest = rows.findLast(row => row.trim())
      if (latest) {
        if (latest.length > 1_000_000) throw new Error('Preparation row exceeds the 1 MB limit.')
        return restorePreparation(JSON.parse(latest))
      }
      if (!start) return null
      if (bytes >= 4_000_008) throw new Error('Preparation row exceeds the 1 MB limit.')
      bytes = Math.min(file.size, bytes * 2, 4_000_008)
    }
  }
  savePreparation(state: AnalysisState) {
    return this.persistence.enqueue({ kind: 'append', path: join(this.directory, 'preparation.jsonl'), data: `${JSON.stringify(state)}\n` })
  }
  async initialBrief(id: string) {
    let brief: import('../shared/analysis').Brief | null = null
    for await (const entry of this.events(id)) {
      if (entry.atMs + (entry.tailMs ?? 0) > 0) break
      if (entry.kind === 'analysis' && ['initial', 'brief_user', 'brief_model'].includes(entry.reason)) brief = entry.state.brief
    }
    return brief
  }
  async forkAt(originalId: string, id: string, positionMs: number) {
    const original = await this.get(originalId)
    this.create(id, { ...original.source, replayId: id })
    let through = 0
    for await (const entry of this.events(originalId)) {
      through = Math.max(through, entry.atMs + (entry.tailMs ?? 0))
      if (through > positionMs) break
      if (entry.kind === 'transcript') this.append(id, { ...entry, segment: { ...entry.segment, sessionId: id } })
      else if (entry.kind === 'suggestion') { const copy = structuredClone(entry); remapSuggestions(copy.state, id); this.append(id, copy) }
      else this.append(id, { ...entry, state: { ...entry.state, sessionId: id, journalId: id,
        request: entry.state.request ? { ...entry.state.request, sessionId: id } : null,
        ...(entry.state.briefRequest ? { briefRequest: { ...entry.state.briefRequest, sessionId: id } } : {}) } })
    }
  }
}

function remapSuggestions(state: SuggestionState, sessionId: string) {
  state.sessionId = sessionId
  const directions = [...state.directions, ...state.history, ...(state.selected ? [state.selected.direction] : [])]
  if (state.request) {
    state.request.input.sessionId = sessionId
    state.request.input.transcript.forEach(s => { s.sessionId = sessionId })
  }
  directions.forEach(d => { d.provenance.sessionId = sessionId })
}
function suggestionReferences(state: SuggestionState, revisions: Map<string, Set<number>>) {
  const check = (evidence: Evidence[]) => { if (evidence.some(e => !revisions.get(e.segmentId)?.has(e.revision))) throw new Error('Suggestions reference missing or future transcript evidence.') }
  for (const d of [...state.directions, ...state.history, ...(state.selected ? [state.selected.direction] : [])]) { check(d.evidence); check(d.provenance.inputs) }
  if (state.selected) { check(state.selected.evidence); check(state.selected.speechAfter) }
  if (state.request) {
    const input = state.request.input
    check(input.transcript.map(s => ({ segmentId: s.id, revision: s.revision })))
    input.observations.forEach(o => check(o.evidence))
    input.rejectedFindings?.forEach(o => check(o.evidence))
    input.brief.objectives.forEach(o => { check(o.evidence); o.history.forEach(h => check(h.evidence)) })
    if (input.selected) check(input.selected.historicalEvidence)
  }
}

// Used exclusively by the index worker; replay/import keep the same validation.
export async function readArchiveIndex(id: string, path: string): Promise<Omit<SavedTranscript, 'audioAvailable'>> {
  const file = Bun.file(path)
  if (!await file.exists()) throw new Error('Saved transcript not found. Import the JSONL file again.')
  const first = (await file.slice(0, 8192).text()).split('\n')[0]
  const value = header(JSON.parse(first!))
  let durationMs = 0
  for await (const raw of lines(path)) {
    if (!object(raw)) throw new Error('Invalid transcript event.')
    if (raw.kind === 'header') continue
    // The library needs the envelope, not model-state normalization. Full
    // analysis/suggestion validation remains at replay and import boundaries.
    if (raw.kind === 'analysis' || raw.kind === 'suggestion') {
      if (!finite(raw.atMs) || raw.tailMs !== undefined && !finite(raw.tailMs)) throw new Error('Invalid replay timestamp.')
      durationMs = Math.max(durationMs, raw.atMs + (raw.tailMs as number | undefined ?? 0))
      continue
    }
    const update = row(raw)
    if (update.kind === 'end' && !value.source.capture) continue
    durationMs = Math.max(durationMs, update.atMs + ('tailMs' in update ? update.tailMs ?? 0 : 0))
    if (update.kind === 'capture' && update.source) value.source = update.source
  }
  return { id, source: value.source, createdAt: value.createdAt, durationMs }
}
