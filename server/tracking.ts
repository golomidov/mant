import { translationMatches } from '../shared/translations'
import { briefAnalysisVersion, emptyAnalysis, type AnalysisReason, type AnalysisRequest, type AnalysisState, type Attribution, type Brief, type Evidence, type Objective, type Observation } from '../shared/analysis'
import type { DirectionSelection, Expression } from '../shared/suggestions'
import type { Segment } from '../shared/protocol'
import { briefProposalSchema, briefSchema, observationSchema, trackProposalSchema, validate, type BriefProposal, type TrackProposal } from './analysis-schema'
import { contextualQuestions, unsupportedFragments, validateGrounding } from './grounding'
import { interpret, type InterpretationInput, type Interpreter } from './interpretation'
import { languageCode, languageSettings, supportedLanguages } from '../shared/languages'
import { translateSegments, type Translator } from './translation'
import { deadline, diagnostic, isolate, providerMetadata } from './diagnostics'
import { modelRequestError } from './errors'

interface Material { segment: Segment; availableAt: number; atMs: number }
interface Options {
  sessionId: string; brief?: Brief; enabled?: boolean; autoTranslate?: boolean; windowMs?: number; minIntervalMs?: number; translationMinIntervalMs?: number; interpreter?: Interpreter; translator?: Translator; now?: () => number
  requestTimeoutMs?: number; translationTimeoutMs?: number
  latest?(segmentId: string): Segment | undefined
  attribution?(segment: Segment): Attribution | undefined
  selection?(): DirectionSelection | null
  assess?(value: { selectionId: string; status: Expression; evidence: Evidence[]; reason: string }): void
  publish(state: AnalysisState, reason: AnalysisReason, effectiveMs: number): void
}
const unknownSpeaker = (): Attribution => ({ participantId: null, sideId: null, sourceLabel: 'Unidentified participant', revision: 0 })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const canonical = (text: string) => text.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
const overlaps = (a: Evidence[], b: Evidence[]) => a.some(left => b.some(right => left.segmentId === right.segmentId))
const definition = (objective: Objective) => ({ id: objective.id, kind: objective.kind, ...(objective.timing ? { timing: objective.timing } : {}), description: objective.description, completion: objective.completion, origin: objective.origin })

// The coordinator, not the model, owns IDs, versions and writes.
// Pending text lives once in the transcript map. The bounded request selects a
// batch by revision watermark, so a slow model never loses earlier segments.
export class ConversationTracker {
  state: AnalysisState
  private material = new Map<string, Material>()
  private processed = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private flight: Promise<void> | null = null
  private briefFlight: Promise<void> | null = null
  private briefQueued: { atMs: number } | null = null
  private translationController = new AbortController()
  private trackingFailed = false
  private translationFailed = false
  private controller = new AbortController()
  private disposed = false
  private scheduledAt: number | null = null
  private now: () => number
  private infer: Interpreter
  private windowMs: number
  private minIntervalMs: number
  private translationMinIntervalMs: number
  private lastStartedAt = -Infinity
  private translationLastStartedAt = -Infinity
  private manualBrief: Brief | null = null
  private manualObservations = new Map<string, Observation>()
  private manualAttributions = new Map<string, Attribution>()
  private lastProgressAt = 0
  private translationTimer: ReturnType<typeof setTimeout> | null = null
  private translationFlight: Promise<void> | null = null
  private translated = new Map<string, number>()
  private translationEpoch = 0
  private translate: Translator | null
  private manualObjectives = new Map<string, Objective>()

  constructor(private options: Options) {
    this.state = emptyAnalysis(options.sessionId, options.brief)
    this.state.brief.objectives.forEach(o => { o.status = o.status === 'dropped' ? 'dropped' : 'unexplored'; o.evidence = []; o.history = []; o.reason = ''; delete o.confirmedByUser })
    this.now = options.now ?? (() => performance.now())
    this.infer = options.interpreter ?? interpret
    this.translate = options.translator ?? (options.interpreter ? null : translateSegments)
    this.windowMs = options.windowMs ?? Math.max(20, Math.min(5000, Number(process.env.ANALYSIS_COALESCE_MS) || 350))
    // Explicit coordinator timing (tests/replay tools) retains caller control.
    this.minIntervalMs = options.minIntervalMs ?? (options.windowMs === undefined ? Math.max(0, Math.min(30_000, Number(process.env.ANALYSIS_MIN_INTERVAL_MS ?? 6000) || 0)) : 0)
    this.translationMinIntervalMs = options.translationMinIntervalMs ?? (options.windowMs === undefined ? Math.max(0, Math.min(30_000, Number(process.env.TRANSLATION_MIN_INTERVAL_MS ?? 2000) || 0)) : 0)
  }

  private pending() { return [...this.material.values()].filter(row => this.processed.get(row.segment.id) !== row.segment.revision).sort((a, b) => a.segment.order - b.segment.order) }
  private latest(id: string) { return this.options.latest ? this.options.latest(id) : this.material.get(id)?.segment }
  private emit(reason: AnalysisReason, effectiveMs = this.state.analyzedThroughMs) {
    if (this.disposed) return
    this.state.version++
    this.state.pendingSegments = this.options.enabled === false ? 0 : this.pending().length
    isolate('publication', this.state.sessionId, () => this.options.publish(structuredClone(this.state), reason, effectiveMs), () => { this.state.message = 'Analysis publication failed. Transcript continues.' })
  }
  publishInitial() { this.emit('initial', 0) }
  private signal(reasons: string[]) {
    const unique = [...new Set(reasons.map(reason => reason.slice(0, 180)))].slice(0, 5)
    this.state.replan = { needed: unique.length > 0, reasons: unique, version: this.state.replan.version + (same(unique, this.state.replan.reasons) ? 0 : 1) }
  }
  ingest(segment: Segment, atMs: number, availableAt = this.now()) {
    if (this.disposed || segment.sessionId !== this.state.sessionId) return
    const previous = this.material.get(segment.id)
    if (previous && previous.segment.revision >= segment.revision) return
    diagnostic('enqueue', { sessionId: this.state.sessionId, sourceId: segment.sourceId, workType: 'tracking', queueDepth: this.pending().length + (previous ? 0 : 1), oldestPendingMs: this.pending().length ? this.now() - Math.min(...this.pending().map(row => row.availableAt)) : 0 })
    this.material.set(segment.id, { segment: structuredClone(segment), atMs, availableAt: previous && this.processed.get(segment.id) !== previous.segment.revision ? previous.availableAt : availableAt })
    if (previous?.segment.text === segment.text && this.translated.get(segment.id) === previous.segment.revision) {
      this.translated.set(segment.id, segment.revision)
      const translation = this.state.translations?.[segment.id]
      if (translation?.revision === previous.segment.revision) translation.revision = segment.revision
    }
    if (this.state.translations && !translationMatches(this.state.translations[segment.id], segment)) delete this.state.translations[segment.id]
    if (!this.state.attributions[segment.id]) {
      isolate('attribution', this.state.sessionId, () => { const attribution = this.options.attribution?.(segment); if (attribution) this.state.attributions[segment.id] = attribution })
    }
    this.state.availableThroughMs = Math.max(this.state.availableThroughMs, atMs)
    for (const objective of this.state.brief.objectives) if (objective.confirmedByUser && objective.evidence.some(e => e.segmentId === segment.id && e.revision !== segment.revision)) {
      this.setStatus(objective, 'partial', [], 'Supporting speech changed; review your confirmation.', atMs)
      this.emit('transcript_revision', atMs)
    }
    if (!segment.text.trim() && !previous?.segment.text.trim()) { this.processed.set(segment.id, segment.revision); return }
    this.scheduleTranslations()
    if (previous && this.options.enabled !== false) {
      const extension = !!previous.segment.text.trim() && segment.text.startsWith(previous.segment.text)
      let invalidated = false
      this.state.observations = this.state.observations.map(observation => {
        if (observation.status === 'retracted' || !observation.evidence.some(e => e.segmentId === segment.id && e.revision !== segment.revision)) return observation
        if (extension && observation.status === 'provisional') return observation
        invalidated = true
        return { ...observation, version: observation.version + 1, status: extension ? 'provisional' : 'retracted', reason: extension ? 'Speech continues; awaiting possible qualifications.' : 'Supporting transcript was revised; awaiting reassessment.' }
      })
      if (invalidated) {
        if (extension) this.state.brief.objectives.filter(o => o.status !== 'dropped' && o.evidence.some(e => e.segmentId === segment.id)).forEach(o => this.setStatus(o, 'partial', o.evidence, 'Speech continues; completion requires reassessment.', atMs))
        else this.invalidateObjectives('Supporting transcript was revised.', atMs)
        this.signal([extension ? 'Speech qualification requires reassessment' : 'Transcript correction requires reassessment'])
        this.emit('transcript_revision', atMs)
      }
    }
    this.schedule()
    this.state.pendingSegments = this.options.enabled === false ? 0 : this.pending().length
    if (this.options.enabled !== false && this.now() - this.lastProgressAt >= 250) { this.lastProgressAt = this.now(); this.emit('progress', atMs) }
  }
  private userExpression(observation: Observation) {
    const user = this.state.brief.userParticipantId
    return !!user && observation.speaker.participantId === user && observation.evidence.length > 0 && observation.evidence.every(e => {
      const segment = this.latest(e.segmentId)
      return segment?.revision === e.revision && segment.status === 'final' && this.state.attributions[e.segmentId]?.participantId === user
    })
  }
  private invalidateObjectives(reason: string, atMs: number, compatible: (evidence: Evidence) => boolean = () => false) {
    for (const objective of this.state.brief.objectives) {
      if (objective.status === 'dropped' || !objective.evidence.length) continue
      if (objective.confirmedByUser && objective.evidence.every(e => this.latest(e.segmentId)?.revision === e.revision)) continue
      const supporting = this.state.observations.filter(o => o.status !== 'retracted' && o.relations.some(r => r.objectiveId === objective.id) && overlaps(o.evidence, objective.evidence))
      const valid = objective.evidence.every(e => this.material.get(e.segmentId)?.segment.revision === e.revision || compatible(e)) && supporting.length > 0
      if (!valid) this.setStatus(objective, 'unexplored', [], reason, atMs)
      else if (['answered', 'expressed', 'achieved', 'blocked'].includes(objective.status)) {
        const relationship = objective.status === 'expressed' ? 'expresses' : objective.status === 'answered' ? 'answers' : objective.status === 'blocked' ? 'blocks' : 'supports'
        if (!supporting.some(o => o.status === 'established' && !o.grounding?.unresolved?.length && !o.hypothetical && !o.quoted && o.relations.some(r => r.objectiveId === objective.id && r.relationship === relationship) && (objective.status !== 'expressed' || this.userExpression(o)) && (objective.status !== 'achieved' || (['agreement', 'commitment'].includes(o.type) && !o.conditions.length)))) this.setStatus(objective, 'partial', objective.evidence, 'Supporting statement or conditions changed; completion requires reassessment.', atMs)
      }
    }
  }
  private setStatus(objective: Objective, status: Objective['status'], evidence: Evidence[], reason: string, atMs: number) {
    if (objective.status === status && same(objective.evidence, evidence) && objective.reason === reason) return
    objective.status = status; objective.evidence = structuredClone(evidence); objective.reason = reason
    if (!['answered', 'expressed', 'achieved'].includes(status)) { delete objective.confirmedByUser; this.manualObjectives.delete(objective.id) }
    objective.history.push({ status, evidence: structuredClone(evidence), reason, atMs })
  }
  private schedule() {
    if (this.trackingFailed || this.disposed || this.options.enabled === false || this.timer || this.flight || !this.pending().length) return
    this.scheduledAt = this.now()
    this.state.status = 'scheduled'
    this.emit('request')
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, Math.max(this.windowMs, this.minIntervalMs - (this.now() - this.lastStartedAt)))
  }
  pauseTracking() {
    this.options.enabled = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
  async retry() {
    if (this.disposed) throw new Error('This analysis session has ended. Open the saved call to analyze it again.')
    if (this.flight) await this.flight
    if (this.disposed) throw new Error('The analysis session changed. Retry in the current call.')
    this.options.enabled = true; this.trackingFailed = false
    if (this.pending().length) await this.flush()
    else { this.state.message = null; this.state.status = 'idle'; this.emit('request') }
  }
  async retryTranslations() { this.translationFailed = false; await this.flushTranslations() }

  private translationPending() {
    const target = languageSettings(this.state.brief).user
    if (languageCode(this.state.brief.languages.call) === target) return []
    return [...this.material.values()].filter(({ segment }) => segment.text.trim() && this.translated.get(segment.id) !== segment.revision && !(this.state.translations?.[segment.id]?.revision === segment.revision && this.state.translations[segment.id]!.targetLanguage === target))
      .sort((a, b) => Number(b.segment.status === 'final') - Number(a.segment.status === 'final') || a.segment.order - b.segment.order)
  }
  private translationLanguagesChanged(previous: Brief) {
    if (languageSettings(previous).user === languageSettings(this.state.brief).user && languageCode(previous.languages.call) === languageCode(this.state.brief.languages.call)) return false
    this.translationController.abort(); this.translationController = new AbortController()
    this.translationFailed = false
    this.state.translations = {}; this.translated.clear(); this.translationEpoch++
    this.state.translationStatus = 'idle'; this.state.translationMessage = null
    return true
  }
  private scheduleTranslations(explicit = false) {
    if (this.translationFailed || !explicit && this.options.autoTranslate === false || !this.translate || this.disposed || this.translationTimer || this.translationFlight || !this.translationPending().length) return
    diagnostic('enqueue', { sessionId: this.state.sessionId, workType: 'translation', queueDepth: this.translationPending().length })
    this.translationTimer = setTimeout(() => { this.translationTimer = null; void this.flushTranslations() }, Math.max(this.windowMs, this.translationMinIntervalMs - (this.now() - this.translationLastStartedAt)))
  }
  flushTranslations(): Promise<void> {
    if (this.translationTimer) clearTimeout(this.translationTimer); this.translationTimer = null
    if (this.translationFlight) return this.translationFlight
    const segments = this.translationPending().slice(0, 8).map(row => structuredClone(row.segment))
    if (!this.translate || this.disposed || !segments.length) return Promise.resolve()
    this.translationLastStartedAt = this.now()
    const targetLanguage = languageSettings(this.state.brief).user
    const epoch = this.translationEpoch
    const requestId = crypto.randomUUID()
    this.state.translationStatus = 'translating'; this.state.translationMessage = null; this.emit('translation')
    let failed = false
    this.translationFlight = (async () => {
      try {
        const translations = await deadline('translation', this.state.sessionId, requestId, this.options.translationTimeoutMs ?? 30_000, this.translationController.signal, signal => this.translate!({ sessionId: this.state.sessionId, targetLanguage, segments }, signal), { queueDepth: this.translationPending().length, oldestPendingMs: this.now() - Math.min(...this.translationPending().map(row => row.availableAt)), sourceId: new Set(segments.map(s => s.sourceId)).size === 1 ? segments[0]!.sourceId : 'multiple' })
        if (this.disposed || epoch !== this.translationEpoch) { diagnostic('stale-result', { sessionId: this.state.sessionId, workType: 'translation', requestId }); return }
        if (translations.length !== segments.length || new Set(translations.map(t => t.segmentId)).size !== segments.length || translations.some(t => !segments.some(s => s.id === t.segmentId && s.revision === t.revision) || ![...supportedLanguages.map(l => l.code), 'unknown'].includes(t.sourceLanguage) || !t.text.trim() && t.sourceLanguage !== targetLanguage && t.sourceLanguage !== 'unknown')) throw new Error('Incomplete translation.')
        for (const translation of translations) {
          const original = segments.find(s => s.id === translation.segmentId)!
          const latest = this.latest(translation.segmentId)
          if (!latest || !latest.text.startsWith(original.text)) { diagnostic('stale-result', { sessionId: this.state.sessionId, workType: 'translation', requestId }); continue }
          const revision = latest.text === original.text ? latest.revision : translation.revision
          this.translated.set(translation.segmentId, revision)
          if (translation.sourceLanguage === targetLanguage || !translation.text.trim()) continue
          this.state.translations ??= {}
          this.state.translations[translation.segmentId] = { revision, sourceLanguage: translation.sourceLanguage, targetLanguage, text: translation.text, sourceText: original.text }
        }
        this.state.translationStatus = 'idle'
      } catch (error) {
        diagnostic('error', { sessionId: this.state.sessionId, workType: 'translation', requestId, ...providerMetadata(error) })
        if (this.disposed || epoch !== this.translationEpoch) return
        failed = true; this.translationFailed = true; this.state.translationStatus = 'error'; this.state.translationMessage = 'Translation failed. Retry translation to catch up on untranslated messages.'
      } finally {
        if (!this.disposed && epoch === this.translationEpoch) this.emit('translation')
      }
    })().finally(() => { this.translationFlight = null; if (!failed) this.scheduleTranslations(true) })
    return this.translationFlight
  }

  private request(mode: AnalysisRequest['mode'], rows: Material[], observations: Observation[], pending = rows): AnalysisRequest {
    const now = this.now()
    const request: AnalysisRequest = { id: crypto.randomUUID(), sessionId: this.state.sessionId, runId: this.state.runId, mode,
      briefVersion: mode === 'BRIEF' ? this.state.brief.version : briefAnalysisVersion(this.state.brief), inputs: rows.map(({ segment }) => ({ segmentId: segment.id, revision: segment.revision })),
      observationVersions: Object.fromEntries(observations.map(o => [o.id, o.version])), attributionVersions: Object.fromEntries(rows.map(row => [row.segment.id, this.state.attributions[row.segment.id]?.revision ?? 0])),
      availableAt: pending.length ? Math.min(...pending.map(row => row.availableAt)) : now, scheduledAt: this.scheduledAt ?? now,
      startedAt: now, completedAt: null, appliedAt: null, effectiveMs: rows.length ? Math.max(...rows.map(row => row.atMs)) : 0,
      outcome: 'running', schedulingDelayMs: null, inferenceMs: null, totalDelayMs: null, provisionalBeforeFinal: false }
    return request
  }
  private context(request: AnalysisRequest, rows: Material[], observations: Observation[], pending: Material[]): InterpretationInput {
    const brief = structuredClone(this.state.brief)
    brief.objectives.forEach(objective => { objective.history = []; objective.reason = '' })
    if (request.mode === 'TRACK') { brief.preparation = ''; brief.answers = '' }
    const input: InterpretationInput = { request, brief, observations: structuredClone(observations), transcript: rows.map(row => ({ ...row.segment, attribution: this.state.attributions[row.segment.id] ?? unknownSpeaker() })), pending: pending.map(row => row.segment.id), selection: this.options.selection?.() ?? null, ambiguousEvidence: unsupportedFragments(rows.map(row => ({ segmentId: row.segment.id, revision: row.segment.revision })), rows.map(r => r.segment)) }
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 100_000) throw new Error('Analysis context exceeds 100 KB. Shorten the brief or split an oversized transcript segment.')
    input.languages = languageSettings(brief, this.state.detectedLanguage)
    return structuredClone(input)
  }

  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.flight) return this.flight
    if (this.disposed || this.options.enabled === false) return Promise.resolve()
    const pending = this.pending().slice(0, 16)
    if (!pending.length) return Promise.resolve()
    this.lastStartedAt = this.now()
    const pendingIds = new Set(pending.map(row => row.segment.id))
    const relevant = this.state.observations.filter(o => o.evidence.some(e => pendingIds.has(e.segmentId)) || o.correctedByUser || o.attention !== 'normal')
    const observations = [...new Map([...relevant.slice(-24), ...this.state.observations.slice(-16)].map(o => [o.id, o])).values()]
    // Include cross-segment continuations plus evidence of relevant observations,
    // capped at 48 segments. Pending material always wins over old context.
    const wanted = new Set([...observations.flatMap(o => o.evidence.map(e => e.segmentId)), ...[...this.material.values()].sort((a, b) => a.segment.order - b.segment.order).filter(row => row.segment.text.trim() && row.segment.order <= pending.at(-1)!.segment.order).slice(-16).map(row => row.segment.id)])
    const rows = [...new Map([...this.material.values()].filter(row => wanted.has(row.segment.id)).slice(-32).concat(pending).map(row => [row.segment.id, row])).values()].sort((a, b) => a.segment.order - b.segment.order)
    const request = this.request('TRACK', rows, observations, pending)
    this.scheduledAt = null
    this.state.request = request; this.state.status = 'analyzing'; this.state.message = null
    this.emit('request', request.effectiveMs)
    let failed = false
    this.flight = (async () => {
      try {
        const input = this.context(request, rows, observations, pending)
        const proposal = validate(trackProposalSchema, await deadline('tracking', this.state.sessionId, request.id, this.options.requestTimeoutMs ?? 45_000, this.controller.signal, signal => this.infer('TRACK', input, signal), { sourceId: new Set(rows.map(r => r.segment.sourceId)).size === 1 ? rows[0]!.segment.sourceId : 'multiple', queueDepth: this.pending().length, oldestPendingMs: this.now() - request.availableAt }))
        request.completedAt = this.now()
        if (this.disposed) return
        if (!this.compatible(request, rows) || !this.identity(proposal, request)) {
          request.outcome = 'stale'; diagnostic('stale-result', { sessionId: this.state.sessionId, workType: request.mode, requestId: request.id })
        } else {
          this.applyTrack(proposal, request, rows)
          if (proposal.selectionAssessment) {
            const assessment = proposal.selectionAssessment
            if (assessment.evidence.length && assessment.evidence.every(e => request.inputs.some(i => i.segmentId === e.segmentId && i.revision === e.revision))) isolate('assessment', this.state.sessionId, () => this.options.assess?.(assessment))
          }
          for (const row of pending) this.processed.set(row.segment.id, row.segment.revision)
          request.outcome = 'applied'; request.appliedAt = this.now()
          request.provisionalBeforeFinal = this.state.observations.some(o => o.status === 'provisional' && o.evidence.some(e => pendingIds.has(e.segmentId) && this.latest(e.segmentId)?.status === 'partial'))
          this.state.analyzedThroughMs = Math.max(this.state.analyzedThroughMs, ...pending.map(row => row.atMs))
        }
        this.state.status = 'idle'
      } catch (error) {
        if (this.disposed) return
        diagnostic('error', { sessionId: this.state.sessionId, workType: 'tracking', requestId: request.id, ...providerMetadata(error) })
        failed = true; this.trackingFailed = true; request.completedAt = this.now(); request.outcome = 'error'
        this.state.status = 'error'
        // Do not surface provider errors containing prompts or credentials.
        const safeErrors = ['Observation lacks quoted speech.', 'Observation quote does not match its transcript.', 'Unsupported evidence.', 'Invalid objective reference.', 'Invalid observation reference.', 'Duplicate observation changes.', 'Invalid objective change.', 'Objective status does not match kind.', 'Objective change lacks supporting observation.', 'Invalid structured analysis data. No changes applied.']
        this.state.message = error instanceof Error && (/context exceeds/.test(error.message) || safeErrors.includes(error.message)) ? `${error.message} Transcript delivery continues; retry analysis.` : `${modelRequestError(error, 'analysis').message} Transcript delivery continues.`
      } finally {
        if (!this.disposed) {
          request.schedulingDelayMs = request.startedAt - request.availableAt
          request.inferenceMs = (request.completedAt ?? this.now()) - request.startedAt
          request.totalDelayMs = (request.appliedAt ?? request.completedAt ?? this.now()) - request.availableAt
          this.state.request = request
          this.emit(request.outcome === 'applied' ? 'track' : 'request', request.effectiveMs)
        }
      }
    })().finally(() => { this.flight = null; if (!failed) this.schedule() })
    return this.flight
  }
  private identity(value: { sessionId: string; runId: string; requestId: string }, request: AnalysisRequest) {
    return value.sessionId === request.sessionId && value.runId === request.runId && value.requestId === request.id && request.runId === this.state.runId && request.sessionId === this.state.sessionId
  }
  private compatible(request: AnalysisRequest, rows: Material[]) {
    if (request.briefVersion !== briefAnalysisVersion(this.state.brief)) return false
    if (Object.entries(request.observationVersions).some(([id, version]) => this.state.observations.find(o => o.id === id)?.version !== version)) return false
    return rows.every(row => {
      const current = this.latest(row.segment.id)
      // An append-only extension can yield useful provisional understanding.
      // Replacement, negation, numbers and attribution edits invalidate inputs.
      return current && (current.revision === row.segment.revision || current.text.startsWith(row.segment.text)) &&
        (this.state.attributions[row.segment.id]?.revision ?? 0) === request.attributionVersions[row.segment.id]
    })
  }
  private evidence(evidence: Evidence[], request: AnalysisRequest) {
    if (!evidence.length || evidence.some(e => !request.inputs.some(input => input.segmentId === e.segmentId && input.revision === e.revision))) throw new Error('Unsupported evidence.')
  }
  private speaker(evidence: Evidence[]): Attribution {
    const speakers = evidence.map(e => this.state.attributions[e.segmentId] ?? unknownSpeaker())
    const first = speakers[0] ?? unknownSpeaker()
    return speakers.every(s => s.participantId === first.participantId && s.sideId === first.sideId && s.sourceLabel === first.sourceLabel) ? structuredClone(first) : unknownSpeaker()
  }
  private applyTrack(proposal: TrackProposal, request: AnalysisRequest, rows: Material[]) {
    const next = structuredClone(this.state)
    const languages = languageSettings(next.brief, next.detectedLanguage)
    if (proposal.detectedLanguage) next.detectedLanguage = proposal.detectedLanguage
    for (const translation of proposal.translations ?? []) {
      this.evidence([translation], request)
      if (this.latest(translation.segmentId)?.revision !== translation.revision) continue
      if (translation.targetLanguage !== languages.user || translation.sourceLanguage === languages.user || languageCode(next.brief.languages.call) === languages.user) continue
      next.translations ??= {}
      next.translations[translation.segmentId] = { revision: translation.revision, sourceLanguage: translation.sourceLanguage, targetLanguage: translation.targetLanguage, text: translation.text, sourceText: rows.find(row => row.segment.id === translation.segmentId)!.segment.text }
    }
    const objectiveIds = new Set(next.brief.objectives.map(o => o.id))
    const updated = new Set<string>()
    for (const proposed of proposal.observations) {
      // A verified quote is an explicit evidence reference. Normalize the two
      // redundant lists before validation, rather than rejecting real speech
      // when the model includes a quote but omits its reference from evidence.
      const evidence = [...proposed.evidence]
      const grounding = proposed.grounding ? structuredClone(proposed.grounding) : undefined
      if (proposed.status !== 'retracted' && grounding) {
        // Supply the actual nearby spoken question for quoted short answers.
        // Never infer a question from the user's goal or an earlier finding.
        for (const question of contextualQuestions(grounding.quotes, rows.map(r => r.segment))) {
          if (!evidence.some(e => e.segmentId === question.id && e.revision === question.revision)) evidence.push({ segmentId: question.id, revision: question.revision })
          if (grounding.quotes.length < 8 && !grounding.quotes.some(q => q.segmentId === question.id && q.revision === question.revision)) grounding.quotes.push({ segmentId: question.id, revision: question.revision, text: question.text.slice(-1200) })
          grounding.kind = grounding.kind === 'uncertain' ? 'uncertain' : 'contextual'
        }
      }
      if (proposed.status !== 'retracted') for (const quote of grounding?.quotes ?? []) {
        if (!evidence.some(e => e.segmentId === quote.segmentId && e.revision === quote.revision)) evidence.push({ segmentId: quote.segmentId, revision: quote.revision })
      }
      if (evidence.length > 32) throw new Error('Unsupported evidence.')
      const change = { ...proposed, evidence, ...(grounding ? { grounding } : {}) }
      this.evidence(change.evidence, request)
      if (change.relations.some(r => !objectiveIds.has(r.objectiveId))) throw new Error('Invalid objective reference.')
      let old = change.id ? next.observations.find(o => o.id === change.id) : next.observations.find(o => o.type === change.type && canonical(o.meaning) === canonical(change.meaning) && overlaps(o.evidence, change.evidence))
      if (change.id && (!old || request.observationVersions[change.id] === undefined)) throw new Error('Invalid observation reference.')
      if (!old) {
        const retracted = next.observations.filter(o => o.type === change.type && o.status === 'retracted' && !updated.has(o.id) && !o.correctedByUser && overlaps(o.evidence, change.evidence))
        if (retracted.length === 1) old = retracted[0]
      }
      if (old?.correctedByUser || next.observations.some(o => o.discardedByUser && canonical(o.meaning) === canonical(change.meaning) || o.correctedByUser && !o.discardedByUser && o.type === change.type && overlaps(o.evidence, change.evidence))) continue
      validateGrounding(change, rows.map(r => r.segment))
      const unsupported = change.status !== 'retracted' && unsupportedFragments(change.evidence, rows.map(r => r.segment)).length > 0
      const id = old?.id ?? crypto.randomUUID()
      if (updated.has(id)) throw new Error('Duplicate observation changes.')
      updated.add(id)
      const incomplete = change.evidence.some(e => rows.find(row => row.segment.id === e.segmentId)?.segment.status === 'partial' || this.latest(e.segmentId)?.revision !== e.revision)
      const observation: Observation = { ...change, id, version: (old?.version ?? 0) + 1, speaker: this.speaker(change.evidence),
        status: unsupported ? 'retracted' : change.status === 'established' && (incomplete || change.grounding?.kind === 'uncertain') ? 'provisional' : change.status,
        relations: unsupported ? [] : change.relations, reason: unsupported ? 'Isolated transcript fragment does not establish this claim or its subject. Await substantive speech.' : change.reason, correctedByUser: false, effectiveMs: request.effectiveMs }
      if (old) next.observations[next.observations.indexOf(old)] = observation
      else next.observations.push(observation)
    }
    const changedObjectives = new Set<string>()
    for (const change of proposal.objectives) {
      const objective = next.brief.objectives.find(o => o.id === change.id)
      if (!objective || changedObjectives.has(change.id) || change.status === 'dropped') throw new Error('Invalid objective change.')
      changedObjectives.add(change.id)
      if (objective.status === 'dropped' || objective.confirmedByUser) continue
      if (objective.status === change.status && !change.evidence.length) continue
      if ((change.status === 'expressed' && objective.kind !== 'say') || (change.status === 'answered' && objective.kind !== 'question') || (change.status === 'achieved' && objective.kind !== 'outcome')) throw new Error('Objective status does not match kind.')
      this.evidence(change.evidence, request)
      const supporting = next.observations.filter(o => o.status !== 'retracted' && o.relations.some(r => r.objectiveId === objective.id) && overlaps(o.evidence, change.evidence))
      if (!supporting.length) {
        if (unsupportedFragments(change.evidence, rows.map(r => r.segment)).length) { this.setStatus(objective, 'unexplored', [], 'Ambiguous transcript fragments do not establish progress.', request.effectiveMs); continue }
        if (next.observations.some(o => o.discardedByUser && overlaps(o.evidence, change.evidence))) continue
        // Reject this unsupported status change without throwing away other
        // grounded findings from the same response. The current goal remains
        // unchanged until the model supplies an actual supporting relation.
        continue
      }
      let status = change.status
      const gaps = [...new Set(supporting.flatMap(o => o.grounding?.unresolved ?? []))]
      if (['answered', 'expressed', 'achieved', 'blocked'].includes(status)) {
        const relationship = status === 'expressed' ? 'expresses' : status === 'answered' ? 'answers' : status === 'blocked' ? 'blocks' : 'supports'
        const established = supporting.filter(o => o.status === 'established' && !o.hypothetical && !o.quoted && o.relations.some(r => r.objectiveId === objective.id && r.relationship === relationship))
        if (gaps.length || !established.length || change.evidence.some(e => this.latest(e.segmentId)?.revision !== e.revision)) status = 'partial'
        if (status === 'expressed' && !established.some(o => this.userExpression(o))) status = 'partial'
        if (status === 'achieved' && !established.some(o => ['agreement', 'commitment'].includes(o.type) && !o.conditions.length)) status = 'partial'
      }
      this.setStatus(objective, status, change.evidence, status === change.status ? change.reason : gaps.length ? 'Still unresolved: ' + gaps.join('; ') : `Provisional; completion is not yet established. ${change.reason}`, request.effectiveMs)
    }
    const previous = this.state
    this.state = next
    this.invalidateObjectives('Supporting interpretation was retracted.', request.effectiveMs, evidence => {
      const input = rows.find(row => row.segment.id === evidence.segmentId && row.segment.revision === evidence.revision)?.segment
      return !!input && !!this.material.get(input.id)?.segment.text.startsWith(input.text)
    })
    this.state.openQuestions = proposal.openQuestions
    const materialChanges = [
      ...next.observations.filter(o => updated.has(o.id) && (o.addressedToUser || o.attention !== 'normal' || o.type === 'contradiction' || o.conditions.length)).map(o => o.meaning),
      ...next.brief.objectives.filter(o => previous.brief.objectives.find(p => p.id === o.id)?.status !== o.status).map(o => `${o.description}: ${o.status}`),
      ...(!same(proposal.openQuestions, previous.openQuestions) ? ['Open questions changed'] : []),
    ]
    this.signal([...materialChanges, ...proposal.replanReasons])
  }

  editBrief(value: unknown, expectedVersion: number, atMs = 0, schedule = true) {
    if (expectedVersion !== this.state.brief.version) throw new Error('The brief changed. Reload its current version before saving.')
    const proposed = validate(briefSchema, value)
    for (const key of ['user', 'call'] as const) if (proposed.languages[key] && proposed.languages[key] !== this.state.brief.languages[key] && !languageCode(proposed.languages[key])) throw new Error(`Choose a supported language: ${supportedLanguages.map(language => language.name).join(', ')}.`)
    const previous = this.state.brief
    proposed.userParticipantId ??= previous.userParticipantId
    proposed.conversationSideId ??= previous.conversationSideId
    const knownIds = new Set([...this.state.brief.items, ...this.state.brief.objectives, ...this.state.brief.sides, ...this.state.brief.participants].map(item => item.id))
    const newIds = new Map<string, string>()
    for (const item of [...proposed.items, ...proposed.objectives, ...proposed.sides, ...proposed.participants]) if (!knownIds.has(item.id)) {
      if (newIds.has(item.id)) throw new Error('Brief IDs must be unique.')
      newIds.set(item.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(item.id) ? item.id : crypto.randomUUID())
    }
    const remap = (id: string) => newIds.get(id) ?? id
    proposed.items.forEach(item => { item.id = remap(item.id) })
    proposed.sides.forEach(side => { side.id = remap(side.id) })
    proposed.participants.forEach(p => { p.id = remap(p.id); p.sideId = p.sideId ? remap(p.sideId) : null })
    if (proposed.userParticipantId) proposed.userParticipantId = remap(proposed.userParticipantId)
    if (proposed.conversationSideId) proposed.conversationSideId = remap(proposed.conversationSideId)
    proposed.objectives.forEach(o => { o.id = remap(o.id) })
    this.validateBrief(proposed)
    const speakers = [...Object.values(this.state.attributions), ...this.state.observations.map(o => o.speaker)]
    if (speakers.some(s => s.participantId && !proposed.participants.some(p => p.id === s.participantId) || s.sideId && !proposed.sides.some(side => side.id === s.sideId))) throw new Error('Correct existing attribution before removing a referenced participant or side.')
    const protectedIds = new Set(this.state.brief.protectedIds.filter(id => !previous.items.some(item => item.id === id)))
    if (proposed.userParticipantId) protectedIds.add(proposed.userParticipantId)
    const mySideId = proposed.participants.find(p => p.id === proposed.userParticipantId)?.sideId
    if (mySideId) protectedIds.add(mySideId)
    if (proposed.conversationSideId) protectedIds.add(proposed.conversationSideId)
    for (const [items, previous] of [[proposed.objectives, this.state.brief.objectives], [proposed.sides, this.state.brief.sides], [proposed.participants, this.state.brief.participants]] as const) {
      for (const item of items) {
        const old = previous.find(p => p.id === item.id)
        const comparable = (value: typeof item) => 'completion' in value ? definition(value) : value
        if (!old || !same(comparable(item), comparable(old))) protectedIds.add(item.id)
      }
    }
    for (const language of ['call', 'user'] as const) if (proposed.languages[language] !== this.state.brief.languages[language]) protectedIds.add(`language:${language}`)
    proposed.protectedIds = [...protectedIds].filter(id => id.startsWith('language:') || [...proposed.items, ...proposed.objectives, ...proposed.sides, ...proposed.participants].some(item => item.id === id))
    // Status/evidence/history remain coordinator-owned; removal uses Delete.
    proposed.objectives = proposed.objectives.map(objective => {
      const old = this.state.brief.objectives.find(o => o.id === objective.id)
      if (!old) return { ...objective, status: 'unexplored', evidence: [], reason: 'User added objective.', history: [] }
      const result = { ...structuredClone(old), ...definition(objective) }
      if (!same(definition(old), definition(objective))) this.setStatus(result, 'unexplored', [], 'User changed the objective; reassessment required.', atMs)
      return result
    })
    // Goal/instruction text is a draft for the next explicit Build objectives.
    // Saving it must not invalidate live findings, replies or in-flight tracking.
    const analysisInputs = (brief: Brief) => ({ objectives: brief.objectives.map(definition), items: brief.items, sides: brief.sides, participants: brief.participants, languages: brief.languages, userParticipantId: brief.userParticipantId, conversationSideId: brief.conversationSideId })
    const analysisChanged = !schedule || !same(analysisInputs(previous), analysisInputs(proposed))
    const version = previous.version + 1
    this.state.brief = { ...proposed, version, analysisVersion: analysisChanged ? version : briefAnalysisVersion(previous) }
    const languagesChanged = this.translationLanguagesChanged(previous)
    this.reconcileBriefObjectives(previous)
    this.manualBrief = structuredClone(this.state.brief)
    if (analysisChanged) { this.signal(['User updated the call brief']); this.processed.clear() }
    this.emit('brief_user', atMs)
    if (analysisChanged) { if (schedule) this.schedule(); this.scheduleTranslations(languagesChanged) }
  }
  private reconcileBriefObjectives(previous: Brief) {
    const ids = new Set(this.state.brief.objectives.map(o => o.id))
    this.state.observations = this.state.observations.map(o => {
      const relations = o.relations.filter(r => ids.has(r.objectiveId))
      return relations.length === o.relations.length ? o : { ...o, relations, version: o.version + 1 }
    })
    // Keep manual corrections coherent when saved playback restores a snapshot.
    for (const [id, observation] of this.manualObservations) this.manualObservations.set(id, { ...observation, relations: observation.relations.filter(r => ids.has(r.objectiveId)) })
    if (!same(previous.objectives.map(definition), this.state.brief.objectives.map(definition))) this.state.openQuestions = []
  }
  private validateBrief(brief: Brief) {
    const ids = [...brief.items, ...brief.objectives, ...brief.sides, ...brief.participants].map(item => item.id)
    if (new Set(ids).size !== ids.length) throw new Error('Brief IDs must be unique.')
    if (brief.participants.some(p => p.sideId && !brief.sides.some(s => s.id === p.sideId))) throw new Error('Invalid side reference.')
    if (brief.userParticipantId && !brief.participants.some(p => p.id === brief.userParticipantId)) throw new Error('The brief must include your participant.')
    if (brief.conversationSideId && !brief.sides.some(s => s.id === brief.conversationSideId)) throw new Error('Invalid conversation side.')
  }
  async extractBrief(atMs = 0, edit?: { brief: unknown; version: number }) {
    if (edit) this.editBrief(edit.brief, edit.version, atMs, false)
    if (this.disposed) return
    if (this.briefFlight) { this.briefQueued = { atMs }; return this.briefFlight }
    diagnostic('enqueue', { sessionId: this.state.sessionId, workType: 'brief', queueDepth: 1 })
    const request = this.request('BRIEF', [], [])
    request.effectiveMs = atMs
    this.state.briefRequest = request; this.state.briefStatus = 'analyzing'; this.state.briefMessage = null; this.emit('request')
    this.briefFlight = (async () => {
      try {
        const result = validate(briefProposalSchema, await deadline('brief', this.state.sessionId, request.id, this.options.requestTimeoutMs ?? 45_000, this.controller.signal, signal => this.infer('BRIEF', this.context(request, [], [], []), signal), { queueDepth: 1, oldestPendingMs: 0 }))
        request.completedAt = this.now()
        if (this.disposed) return
        if (!this.identity(result, request) || request.briefVersion !== this.state.brief.version) { diagnostic('stale-result', { sessionId: this.state.sessionId, workType: 'brief', requestId: request.id }); request.outcome = 'stale'; this.state.briefStatus = 'idle'; return }
        const brief = this.proposedBrief(result, atMs)
        this.validateBrief(brief)
        const previous = this.state.brief
        this.state.brief = brief
        this.reconcileBriefObjectives(previous)
        this.manualBrief = structuredClone(brief)
        request.outcome = 'applied'; request.appliedAt = this.now(); this.state.briefStatus = 'idle'; this.state.briefMessage = null
        this.processed.clear()
      } catch (error) {
        if (this.disposed) return
        diagnostic('error', { sessionId: this.state.sessionId, workType: 'brief', requestId: request.id, ...providerMetadata(error) })
        request.completedAt = this.now(); request.outcome = 'error'; this.state.briefStatus = 'error'
        this.state.briefMessage = modelRequestError(error).message
      } finally {
        request.completedAt ??= this.now(); request.schedulingDelayMs = request.startedAt - request.availableAt
        request.inferenceMs = request.completedAt - request.startedAt; request.totalDelayMs = (request.appliedAt ?? request.completedAt) - request.availableAt
        this.emit(request.outcome === 'applied' ? 'brief_model' : 'request', atMs)
      }
    })().finally(() => {
      this.briefFlight = null
      const queued = this.briefQueued; this.briefQueued = null
      this.schedule()
      if (queued && !this.disposed) return this.extractBrief(queued.atMs)
    })
    return this.briefFlight
  }
  private proposedBrief(proposal: BriefProposal, atMs: number): Brief {
    const previous = this.state.brief
    // Temporary IDs belong to their collection. A model may use "q1" for
    // both a context item and an objective; allocate distinct application IDs
    // and resolve references through the appropriate collection's map.
    const mapIds = (items: { id: string }[], existing: { id: string }[]) => {
      const mapping = new Map<string, string>()
      for (const item of items) {
        if (mapping.has(item.id)) throw new Error('Duplicate proposed IDs.')
        mapping.set(item.id, existing.some(e => e.id === item.id) ? item.id : crypto.randomUUID())
      }
      return (id: string) => mapping.get(id) ?? id
    }
    const itemId = mapIds(proposal.items, previous.items)
    const objectiveId = mapIds(proposal.objectives, previous.objectives)
    const sideId = mapIds(proposal.sides, previous.sides)
    const participantId = mapIds(proposal.participants, previous.participants)
    // User-requested rebuilding replaces extracted definitions. Retain manual
    // corrections, and retain identities still needed by speaker attribution.
    const merge = <T extends { id: string }>(existing: T[], proposed: T[], retainOmitted = false) => [
      ...existing.flatMap(old => {
        if (previous.protectedIds.includes(old.id)) return [old]
        const replacement = proposed.find(p => p.id === old.id)
        return replacement ? [replacement] : retainOmitted ? [old] : []
      }),
      ...proposed.filter(p => !existing.some(e => e.id === p.id)),
    ]
    const objectives = proposal.objectives.map(o => {
      const fields = { ...o, id: objectiveId(o.id) }
      const old = previous.objectives.find(p => p.id === fields.id)
      const result: Objective = old ? { ...structuredClone(old), ...fields } : { ...fields, status: 'unexplored', evidence: [], reason: '', history: [] }
      if (old && old.status !== 'dropped' && !same(definition(old), definition(result))) this.setStatus(result, 'unexplored', [], 'User-requested brief refinement; reassessment required.', atMs)
      return result
    })
    return { ...previous, version: previous.version + 1, analysisVersion: previous.version + 1,
      items: merge(previous.items, proposal.items.map(i => ({ ...i, id: itemId(i.id), origin: i.category === 'interpretation' ? 'inferred' : i.origin }))),
      objectives: merge(previous.objectives, objectives),
      sides: merge(previous.sides, proposal.sides.map(s => ({ ...s, id: sideId(s.id) })), true),
      participants: merge(previous.participants, proposal.participants.map(p => ({ ...p, id: participantId(p.id), sideId: p.sideId ? sideId(p.sideId) : null })), true),
      languages: { call: previous.languages.call, ...(previous.languages.user ? { user: previous.languages.user } : {}) },
      clarifications: proposal.clarifications,
    }
  }
  resumeTracking() { this.options.enabled = true; this.processed.clear(); this.schedule() }
  discardObservation(id: string, version: number, atMs: number, manual = true) {
    const finding = this.state.observations.find(o => o.id === id)
    if (!finding || finding.version !== version) throw new Error('Observation changed. Review its current version before discarding it.')
    const affected = this.state.observations.filter(o => o.id === id || o.status !== 'retracted' && overlaps(o.evidence, finding.evidence))
    const objectiveIds = new Set(affected.flatMap(o => o.relations.map(r => r.objectiveId)))
    for (const observation of affected) {
      const corrected: Observation = { ...observation, status: 'retracted', correctedByUser: observation.id === id || observation.correctedByUser, discardedByUser: observation.id === id || observation.discardedByUser === true, version: observation.version + 1, reason: observation.id === id ? 'User marked this finding wrong. Reassess from actual speech.' : 'Retracted because it shares evidence with a finding the user marked wrong; reassessment required.' }
      this.state.observations[this.state.observations.indexOf(observation)] = corrected
      if (manual && observation.id === id) this.manualObservations.set(observation.id, structuredClone(corrected))
    }
    for (const objective of this.state.brief.objectives) if (objective.status !== 'dropped' && (objectiveIds.has(objective.id) || overlaps(objective.evidence, finding.evidence))) this.setStatus(objective, 'unexplored', [], 'User discarded supporting finding; reassessing the objective from speech.', atMs)
    this.state.openQuestions = []
    this.signal(['User discarded a finding; previous conclusions need reassessment'])
    this.processed.clear(); this.emit('observation_user', atMs); this.schedule()
  }
  correctObservation(id: string, version: number, meaning: string, status: Observation['status'], atMs: number, manual = true) {
    const old = this.state.observations.find(o => o.id === id)
    if (!old || old.version !== version) throw new Error('Observation changed. Select its current version before correcting it.')
    if (status !== 'retracted' && old.evidence.some(e => this.material.get(e.segmentId)?.segment.revision !== e.revision)) throw new Error('Supporting transcript changed. Wait for reassessment before establishing this interpretation, or retract it.')
    const corrected = validate(observationSchema, { ...old, meaning, status, correctedByUser: true, discardedByUser: status === 'retracted' && old.discardedByUser === true, version: old.version + 1, reason: 'User corrected this interpretation.' })
    this.state.observations[this.state.observations.indexOf(old)] = corrected
    if (manual) this.manualObservations.set(id, structuredClone(corrected))
    for (const objective of this.state.brief.objectives.filter(o => old.relations.some(r => r.objectiveId === o.id) && o.status !== 'dropped')) this.setStatus(objective, 'unexplored', [], 'User corrected supporting interpretation; reassessment required.', atMs)
    this.signal(['User corrected an interpretation']); this.processed.clear(); this.emit('observation_user', atMs); this.schedule()
  }
  confirmObjective(id: string, version: number, evidence: Evidence[], atMs: number, manual = true) {
    const objective = this.state.brief.objectives.find(o => o.id === id)
    if (!objective || version !== this.state.brief.version || objective.status === 'dropped' || !same(evidence, objective.evidence) || evidence.some(e => this.latest(e.segmentId)?.revision !== e.revision)) throw new Error('Objective or supporting transcript changed. Review the current objective before confirming it.')
    if (objective.confirmedByUser) return
    this.setStatus(objective, objective.kind === 'say' ? 'expressed' : objective.kind === 'question' ? 'answered' : 'achieved', evidence, 'Confirmed by you; no additional spoken confirmation needed.', atMs)
    objective.confirmedByUser = true
    if (manual) this.manualObjectives.set(id, structuredClone(objective))
    this.signal(['User confirmed an objective; move to the remaining goals'])
    this.emit('objective_user', atMs)
  }
  attribute(segmentIds: string[], participantId: string | null, sideId: string | null, sourceLabel: string, atMs: number, manual = true) {
    const participant = this.state.brief.participants.find(p => p.id === participantId)
    if (participantId && !participant || sideId && !this.state.brief.sides.some(s => s.id === sideId) || !segmentIds.length || segmentIds.some(id => !this.material.has(id))) throw new Error('Invalid attribution references.')
    for (const id of segmentIds) {
      this.state.attributions[id] = { participantId, sideId: participant?.sideId ?? sideId, sourceLabel: sourceLabel.slice(0, 4000) || (participant?.name ?? 'Unidentified participant'), revision: (this.state.attributions[id]?.revision ?? 0) + 1 }
      if (manual) this.manualAttributions.set(id, structuredClone(this.state.attributions[id]!))
      this.processed.delete(id)
    }
    this.state.observations = this.state.observations.map(o => o.evidence.some(e => segmentIds.includes(e.segmentId)) ? { ...o, speaker: this.speaker(o.evidence), version: o.version + 1 } : o)
    const affected = new Set(this.state.observations.filter(o => o.evidence.some(e => segmentIds.includes(e.segmentId))).flatMap(o => o.relations.map(r => r.objectiveId)))
    this.state.brief.objectives.filter(o => affected.has(o.id) && ['answered', 'expressed', 'achieved', 'blocked'].includes(o.status)).forEach(o => this.setStatus(o, 'partial', o.evidence, 'Speaker attribution changed; reassessment required.', atMs))
    this.signal(['Speaker attribution corrected']); this.emit('attribution', atMs); this.schedule()
  }
  restore(saved: AnalysisState) {
    const previous = this.state.brief
    const epoch = this.translationEpoch
    const identity = { sessionId: this.state.sessionId, runId: this.state.runId, journalId: this.state.journalId }
    const translations = this.state.translations
    this.state = { ...structuredClone(saved), ...identity, version: this.state.version + 1, status: 'saved' }
    if (this.manualBrief) this.state.brief = structuredClone(this.manualBrief)
    this.translationLanguagesChanged(previous)
    this.state.translationStatus = this.translationFlight && epoch === this.translationEpoch ? 'translating' : 'idle'; this.state.translationMessage = null
    this.state.translations = Object.fromEntries(Object.entries({ ...saved.translations, ...translations }).filter(([id, t]) => translationMatches(t, this.latest(id)) && t.targetLanguage === languageSettings(this.state.brief).user))
    for (const [id, attribution] of this.manualAttributions) this.state.attributions[id] = attribution
    for (const [id, observation] of this.manualObservations) {
      this.state.observations = this.state.observations.filter(o => o.id !== id && !(o.type === observation.type && overlaps(o.evidence, observation.evidence)))
      const corrected = structuredClone(observation)
      if (corrected.evidence.some(e => this.material.get(e.segmentId)?.segment.revision !== e.revision)) { corrected.status = 'retracted'; corrected.reason = 'Supporting transcript was revised; user interpretation retained in history.' }
      this.state.observations.push(corrected)
      this.state.brief.objectives.filter(o => o.status !== 'dropped' && observation.relations.some(r => r.objectiveId === o.id)).forEach(o => this.setStatus(o, 'unexplored', [], 'User corrected the supporting interpretation; recompute to reassess.', observation.effectiveMs))
    }
    this.state.observations.forEach(o => { o.speaker = this.speaker(o.evidence) })
    this.reconcileBriefObjectives(saved.brief)
    for (const [id, confirmed] of this.manualObjectives) {
      const objective = this.state.brief.objectives.find(o => o.id === id)
      if (objective && same(definition(objective), definition(confirmed)) && confirmed.evidence.every(e => this.latest(e.segmentId)?.revision === e.revision)) Object.assign(objective, structuredClone(confirmed))
    }
    isolate('publication', this.state.sessionId, () => this.options.publish(structuredClone(this.state), 'initial', saved.analyzedThroughMs))
    this.scheduleTranslations()
  }
  replayUserEdit(saved: AnalysisState, reason: AnalysisReason, atMs: number) {
    if (['initial', 'brief_user', 'brief_model'].includes(reason)) {
      if (this.manualBrief) return
      const previous = this.state.brief
      this.state.brief = structuredClone(saved.brief)
      this.translationLanguagesChanged(previous)
      this.state.brief.objectives.forEach(o => {
        const current = previous.objectives.find(p => p.id === o.id)
        if (o.status === 'dropped') { o.evidence = []; o.history = []; o.reason = 'Explicit user instruction in recorded brief.'; delete o.confirmedByUser }
        else if (current && current.status !== 'dropped' && same(definition(o), definition(current))) { o.status = current.status; o.evidence = current.evidence; o.history = current.history; o.reason = current.reason; o.confirmedByUser = current.confirmedByUser }
        else { o.status = 'unexplored'; o.evidence = []; o.history = []; o.reason = current?.status === 'dropped' ? 'Reopened by user.' : ''; delete o.confirmedByUser }
      })
      this.reconcileBriefObjectives(previous)
      const analysisChanged = briefAnalysisVersion(previous) !== briefAnalysisVersion(this.state.brief)
      if (analysisChanged) this.processed.clear()
      this.emit(reason, atMs)
      if (analysisChanged) { this.schedule(); this.scheduleTranslations() }
    } else if (reason === 'objective_user') {
      for (const confirmed of saved.brief.objectives.filter(o => o.confirmedByUser && !this.manualObjectives.has(o.id))) {
        const objective = this.state.brief.objectives.find(o => o.id === confirmed.id)
        if (objective && same(definition(objective), definition(confirmed)) && confirmed.evidence.every(e => this.latest(e.segmentId)?.revision === e.revision)) {
          objective.evidence = structuredClone(confirmed.evidence)
          this.confirmObjective(objective.id, this.state.brief.version, objective.evidence, atMs, false)
        }
      }
    } else if (reason === 'attribution') {
      for (const [id, attribution] of Object.entries(saved.attributions)) if (!this.manualAttributions.has(id) && this.material.has(id) && !same(attribution, this.state.attributions[id])) this.attribute([id], attribution.participantId, attribution.sideId, attribution.sourceLabel, atMs, false)
    } else if (reason === 'observation_user') {
      // Preserve only explicit user corrections, never saved model conclusions.
      for (const observation of saved.observations.filter(o => o.correctedByUser && o.evidence.every(e => this.material.get(e.segmentId)?.segment.revision === e.revision))) {
        const old = this.state.observations.find(o => o.id === observation.id || (observation.discardedByUser ? canonical(o.meaning) === canonical(observation.meaning) : o.type === observation.type && overlaps(o.evidence, observation.evidence)))
        if ([...this.manualObservations.values()].some(o => o.type === observation.type && overlaps(o.evidence, observation.evidence))) continue
        if (old) { old.evidence = structuredClone(observation.evidence); if (observation.discardedByUser) this.discardObservation(old.id, old.version, atMs, false); else this.correctObservation(old.id, old.version, observation.meaning, observation.status, atMs, false) }
        else { this.state.observations.push(structuredClone(observation)); this.emit(reason, atMs) }
      }
    }
  }
  dispose() { this.disposed = true; this.controller.abort(); this.translationController.abort(); this.briefQueued = null; if (this.timer) clearTimeout(this.timer); this.timer = null; if (this.translationTimer) clearTimeout(this.translationTimer); this.translationTimer = null }
}
