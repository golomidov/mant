import { briefAnalysisVersion, type AnalysisReason, type AnalysisState, type Evidence } from '../shared/analysis'
import type { Segment } from '../shared/protocol'
import { directionKey, emptySuggestions, type Direction, type DirectionSelection, type Expression, type SuggestionInput, type SuggestionMode, type SuggestionReason, type SuggestionState } from '../shared/suggestions'
import { generateSuggestions, recordSchema, type SuggestGenerator, type SuggestRecord } from './suggestion-model'
import { unsupportedFragments } from './grounding'
import { validate } from './analysis-schema'
import { deadline, diagnostic, isolate, providerMetadata } from './diagnostics'
import { languageCode, languageSettings } from '../shared/languages'
import { defaultLanguageModel } from '../shared/models'

interface Options {
  sessionId: string; mode?: SuggestionMode; generator?: SuggestGenerator; windowMs?: number; minIntervalMs?: number
  analysis(): AnalysisState; media(): number; now?(): number
  requestTimeoutMs?: number
  latest?(id: string): Segment | undefined
  publish(state: SuggestionState, reason: SuggestionReason): void
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const ref = (s: Segment): Evidence => ({ segmentId: s.id, revision: s.revision })
const unknown = () => ({ participantId: null, sideId: null, sourceLabel: 'Unidentified participant', revision: 0 })
// Conservative application guard; semantic reconciliation still runs in SUGGEST.
// All non-append corrections invalidate, irrespective of language. Added clauses
// are held for reassessment too; this vocabulary only detects obsolete flights.
const qualification = (s: string) => s.includes('?') || s.includes('？') || s.toLowerCase().split(/[^a-zà-ž0-9]+/u).some(word => ['not', 'no', 'never', 'except', 'unless', 'but', 'however', 'instead', 'actually', 'only', 'onboarding', 'non', 'mai', 'tranne', 'salvo', 'però', 'invece', 'solo', 'ne', 'pas', 'sauf', 'mais', 'nicht', 'aber', 'außer', 'pero', 'excepto'].includes(word) || /[0-9]/.test(word))
const meaningful = (text: string) => text.trim().length >= 12 || qualification(text)
const canonicalReply = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export class SuggestionCoordinator {
  state: SuggestionState
  private material = new Map<string, { segment: Segment; atMs: number }>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private flight: Promise<void> | null = null
  private controller: AbortController | null = null
  private disposed = false
  private dirty = false
  private failed = false
  private revision = 0
  private pendingAt: number | null = null
  private triggeredText = new Map<string, string>()
  private now: () => number
  private generate: SuggestGenerator
  private windowMs: number
  private minIntervalMs: number
  private lastStartedAt = -Infinity
  private analysisSignature = ''
  private baselineThrough = -1
  private manualSelection = false
  private manualConfiguration = false
  private rephrasePending: SuggestionInput['rephrase']
  private anotherPending = false
  private generationEpoch = 0
  private declined: SuggestionInput['recent'] = []
  constructor(private options: Options) {
    this.state = emptySuggestions(options.sessionId, options.mode)
    this.state.userParticipantId = options.analysis().brief.userParticipantId ?? null
    this.now = options.now ?? (() => performance.now())
    this.generate = options.generator ?? generateSuggestions
    this.windowMs = options.windowMs ?? Math.max(20, Math.min(2000, Number(process.env.SUGGEST_COALESCE_MS) || 180))
    this.minIntervalMs = options.minIntervalMs ?? (options.windowMs === undefined ? Math.max(0, Math.min(30_000, Number(process.env.SUGGEST_MIN_INTERVAL_MS ?? 4000) || 0)) : 0)
    this.state.configuration.model = process.env.SUGGEST_MODEL ?? process.env.ANALYSIS_MODEL ?? defaultLanguageModel
    this.state.configuration.coalesceMs = this.windowMs
  }
  private emit(reason: SuggestionReason) {
    if (this.disposed) return
    while (bytes(this.state) > 850_000 && this.state.history.length > 3) this.state.history.shift()
    this.state.version++
    isolate('suggestion-publication', this.state.sessionId, () => this.options.publish(structuredClone(this.state), reason), () => { this.state.message = 'Suggestion publication failed. Transcript continues.' })
  }
  publishInitial() { this.emit('initial') }
  private latest(id: string) { return this.options.latest?.(id) ?? this.material.get(id)?.segment }
  private affectedByDiscard(direction: Direction) {
    return this.options.analysis().observations.some(o => o.discardedByUser && !direction.provenance.knownDiscardIds?.includes(o.id) && (direction.observationIds.includes(o.id) || o.relations.some(r => direction.objectiveIds.includes(r.objectiveId)) || o.evidence.some(e => direction.evidence.some(ref => ref.segmentId === e.segmentId && ref.revision === e.revision))))
  }
  private isUser(id: string) { return !!this.state.userParticipantId && this.options.analysis().attributions[id]?.participantId === this.state.userParticipantId }
  private enabled() { return this.state.mode === 'predictive' || this.state.mode === 'baseline' }
  ingest(segment: Segment, atMs: number) {
    if (this.disposed || segment.sessionId !== this.state.sessionId) return
    const previous = this.material.get(segment.id)?.segment
    if (previous && previous.revision >= segment.revision) return
    this.material.set(segment.id, { segment: structuredClone(segment), atMs }); this.revision++
    if (!this.enabled()) {
      if (this.state.selected && (!previous || previous.text !== segment.text) && !this.isUser(segment.id)) this.invalidate('Replay speech changed; selected wording requires reassessment.', d => directionKey(d) === directionKey(this.state.selected!.direction))
      return
    }
    const changed = !previous || previous.text !== segment.text
    const correction = !!previous && !segment.text.startsWith(previous.text)
    if (correction) this.invalidate('Transcript corrected; reassessment required.', d => d.provenance.inputs.some(e => e.segmentId === segment.id))
    if (previous && !changed && previous.status !== segment.status && this.state.mode === 'predictive') this.schedule()
    const triggerText = this.triggeredText.get(segment.id) ?? ''
    const delta = segment.text.startsWith(triggerText) ? segment.text.slice(triggerText.length) : segment.text
    const developed = correction || !previous || delta.trim().length >= 18 || qualification(delta)
    if (changed && meaningful(segment.text)) {
      if (!this.isUser(segment.id)) {
        // Any meaningful new clause may contain an unforeseen condition. Never
        // leave old wording actionable while waiting for semantic reassessment.
        this.invalidate('Incoming speech changed; reassessing this direction.')
        if (this.state.mode === 'predictive' && developed) { this.triggeredText.set(segment.id, segment.text); this.schedule() }
      } else {
        // No continuous reply generation during reliably attributed user speech.
        this.state.status = 'waiting'; this.state.message = 'Listening to your response.'
      }
    }
    if (this.state.selected?.evidence.some(e => e.segmentId === segment.id && e.revision !== segment.revision)) {
      this.state.selected.expression = 'uncertain'; this.state.selected.evidence = []
      this.state.selected.reason = 'Spoken evidence was corrected; awaiting tracking.'; this.emit('expression')
    }
  }
  analysisChanged(reason: AnalysisReason) {
    if (this.disposed || this.state.mode === 'off' || reason === 'progress' || reason === 'request' || reason === 'translation') return
    const analysis = this.options.analysis()
    if (analysis.brief.userParticipantId && this.state.userParticipantId !== analysis.brief.userParticipantId) {
      this.state.userParticipantId = analysis.brief.userParticipantId
      if (this.state.selected) this.release(this.state.selected.id)
    }
    const languages = languageSettings(analysis.brief, analysis.detectedLanguage)
    const signature = JSON.stringify({ brief: briefAnalysisVersion(analysis.brief), languages, objectives: analysis.brief.objectives.map(o => [o.id, o.status]), observations: analysis.observations.map(o => [o.id, o.version, o.status]), attributions: analysis.attributions })
    if (signature === this.analysisSignature) return
    this.analysisSignature = signature; this.revision++
    this.invalidate(reason === 'attribution' ? 'Speaker attribution changed; reassessment required.' : 'Brief or supporting evidence changed; reassessment required.', d =>
      d.provenance.briefVersion !== briefAnalysisVersion(analysis.brief) ||
      !!(languages.conversation && d.language && languageCode(d.language) !== languages.conversation) ||
      this.affectedByDiscard(d) ||
      d.objectiveIds.some(id => !analysis.brief.objectives.some(o => o.id === id && !['answered', 'expressed', 'achieved', 'dropped'].includes(o.status))) ||
      Object.entries(d.provenance.observationVersions).some(([id, v]) => analysis.observations.find(o => o.id === id)?.version !== v) ||
      Object.entries(d.provenance.attributionVersions).some(([id, v]) => (analysis.attributions[id]?.revision ?? 0) !== v))
    if (reason === 'attribution' && this.state.selected) {
      this.state.selected.expression = 'uncertain'; this.state.selected.evidence = []; this.state.selected.reason = 'Attribution changed; awaiting reassessment.'; this.emit('expression')
    }
    if (reason === 'objective_user') {
      const confirmed = (d: Direction) => d.objectiveIds.some(id => analysis.brief.objectives.find(o => o.id === id)?.confirmedByUser)
      if (this.state.selected && confirmed(this.state.selected.direction)) this.release(this.state.selected.id)
      const recommended = this.state.directions.find(d => d.id === this.state.recommendedId)
      if (recommended && confirmed(recommended)) { this.state.recommendedId = this.state.directions.find(d => d.lifecycle === 'active' && !confirmed(d))?.id ?? null; this.state.message = 'Confirmed. Moving to the remaining objectives.'; this.emit('recommendation') }
    }
    if (this.state.mode === 'predictive') this.schedule(reason === 'track' && analysis.brief.objectives.some(o => o.status === 'expressed'))
  }
  private invalidate(message: string, affected: (d: Direction) => boolean = () => true) {
    let changed = false
    const keys = new Set([...this.state.directions, ...(this.state.selected ? [this.state.selected.direction] : [])].map(directionKey))
    for (const direction of [...this.state.directions, ...this.state.history.filter(d => keys.has(directionKey(d)))]) if (direction.lifecycle === 'active' && affected(direction)) {
      direction.lifecycle = 'reassess'; direction.warning = message; direction.invalidatedMediaMs ??= this.options.media(); changed = true
    }
    if (this.state.selected && affected(this.state.selected.direction)) {
      this.state.selected.warning = message; changed = true
    }
    if (changed) { this.state.message = message; this.emit('invalidated') }
  }
  configure(mode: 'off' | 'predictive' | 'baseline', style: string, userParticipantId: string | null) {
    if (style.length > 500 || userParticipantId && !this.options.analysis().brief.participants.some(p => p.id === userParticipantId)) throw new Error('Invalid suggestion configuration.')
    this.controller?.abort(); this.dirty = false
    if (this.timer) clearTimeout(this.timer); this.timer = null
    this.invalidate('Suggestion settings changed; request a fresh direction.')
    this.manualConfiguration = true
    this.state.mode = mode; this.state.style = style; this.state.userParticipantId = userParticipantId; this.revision++
    this.state.status = mode === 'off' ? 'idle' : 'waiting'; this.state.message = null
    this.emit('config')
    if (mode === 'predictive' && this.material.size) this.schedule()
  }
  rephrase(id: string, version: number, transformation: 'simpler' | 'shorter' | 'alternative') {
    if (!this.enabled()) throw new Error('Suggestions are read-only.')
    const direction = this.state.directions.find(d => d.id === id && d.version === version && d.lifecycle === 'active')
    if (!direction || !this.compatibleDirection(direction)) throw new Error('Direction changed; choose a current suggestion.')
    this.rephrasePending = { id, version, transformation, direction: structuredClone(direction) }
    this.anotherPending = false; this.failed = false; this.generationEpoch++; this.controller?.abort()
    this.schedule(true)
  }
  another() {
    this.rephrasePending = undefined
    this.failed = false
    if (this.state.mode === 'baseline' && (this.baselineThrough < 0 || [...this.material.values()].some(r => r.atMs > this.baselineThrough))) { this.state.message = 'Mark the incoming turn end to generate a baseline reply.'; this.emit('waiting'); return }
    if (!this.enabled()) return
    const current = this.state.selected?.direction ?? this.state.directions.find(d => d.id === this.state.recommendedId)
    if (current) { const { id, label, meaning, opening } = current; this.declined = [...this.declined.filter(d => d.id !== id), { id, label, meaning, opening }].slice(-6) }
    this.anotherPending = true; this.generationEpoch++
    this.controller?.abort()
    if (this.state.selected) this.release(this.state.selected.id)
    this.state.message = null
    this.schedule(true)
  }
  private schedule(explicit = false) {
    if (!this.enabled() || this.disposed || (!this.material.size && !this.options.analysis().brief.objectives.length && !this.options.analysis().brief.items.length)) return
    const last = [...this.material.values()].at(-1)?.segment
    if (last && this.isUser(last.id) && !explicit) return
    if (!this.dirty) this.pendingAt = this.now()
    this.dirty = true
    diagnostic('enqueue', { sessionId: this.state.sessionId, workType: 'suggestions', queueDepth: 1, oldestPendingMs: this.now() - (this.pendingAt ?? this.now()) })
    if (explicit && this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.failed || this.flight || this.timer) return
    this.state.status = 'scheduled'; this.emit('request')
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, explicit ? this.windowMs : Math.max(this.windowMs, this.minIntervalMs - (this.now() - this.lastStartedAt)))
  }
  private snapshot(): SuggestionInput {
    const analysis = this.options.analysis()
    const available = [...this.material.values()].filter(r => this.state.mode !== 'baseline' || r.atMs <= this.baselineThrough).sort((a, b) => a.segment.order - b.segment.order)
    const unresolved = new Set(analysis.brief.objectives.filter(o => !['answered', 'expressed', 'achieved', 'dropped'].includes(o.status)).map(o => o.id))
    const relevant = analysis.observations.filter(o => o.status !== 'retracted' && (o.attention !== 'normal' || o.relations.some(r => unresolved.has(r.objectiveId)))).slice(-8)
    const wanted = new Set(relevant.flatMap(o => o.evidence.map(e => e.segmentId)))
    const rows = [...new Map([...available.filter(r => wanted.has(r.segment.id)).slice(-6), ...available.slice(-12)].map(r => [r.segment.id, r])).values()].sort((a, b) => a.segment.order - b.segment.order)
    const ids = new Set(rows.map(r => r.segment.id))
    const observations = analysis.observations.filter(o => o.status !== 'retracted' && o.evidence.every(e => ids.has(e.segmentId) && this.latest(e.segmentId)?.revision === e.revision)).slice(-16)
    const brief = structuredClone(analysis.brief)
    brief.preparation = ''; brief.answers = ''
    brief.objectives = brief.objectives.filter(o => !['answered', 'expressed', 'achieved', 'dropped'].includes(o.status)).map(o => ({ ...o, history: [] }))
    const transcript = rows.map(r => ({ ...r.segment, attribution: analysis.attributions[r.segment.id] ?? unknown() }))
    const input: SuggestionInput = {
      ...(this.rephrasePending ? { rephrase: structuredClone(this.rephrasePending) } : {}),
      ...(this.anotherPending ? { generation: 'another' as const } : {}),
      sessionId: this.state.sessionId, runId: this.state.runId, requestId: crypto.randomUUID(), revision: this.revision,
      languages: languageSettings(analysis.brief, analysis.detectedLanguage),
      briefVersion: briefAnalysisVersion(analysis.brief), brief, observations, transcript, rejectedFindings: analysis.observations.filter(o => o.discardedByUser).slice(-8).map(({ id, meaning, evidence }) => ({ id, meaning, evidence })),
      tail: transcript.filter(s => s.status === 'partial').map(s => s.text).join(' '), floor: transcript.at(-1)?.attribution ?? null,
      selected: this.state.selected ? { selectionId: this.state.selected.id, directionId: this.state.selected.direction.id, version: this.state.selected.direction.version, move: this.state.selected.direction.move, meaning: this.state.selected.direction.meaning, opening: this.state.selected.direction.opening, objectiveIds: this.state.selected.direction.objectiveIds, assumptions: this.state.selected.direction.assumptions, historicalEvidence: this.state.selected.direction.evidence, warning: this.state.selected.warning } : null, recent: [...new Map(this.state.history.toReversed().map(d => [d.opening, d])).values()].slice(0, 6).map(({ id, label, meaning, opening }) => ({ id, label, meaning, opening })),
      mediaMs: this.options.media(), availableAt: this.pendingAt ?? this.now(), style: this.state.style,
    }
    if (input.generation === 'another') input.recent = structuredClone(this.declined)
    if (bytes(input) > 70_000) throw new Error('Suggestion context exceeds 70 KB. Shorten the brief or transcript.')
    return structuredClone(input)
  }
  private compatible(input: SuggestionInput, draft?: SuggestRecord) {
    if (this.disposed || input.sessionId !== this.state.sessionId || input.runId !== this.state.runId || input.briefVersion !== briefAnalysisVersion(this.options.analysis().brief) || !this.enabled()) return false
    if (input.rephrase && !this.state.directions.some(d => d.id === input.rephrase!.id && d.version === input.rephrase!.version && d.lifecycle === 'active')) return false
    if (input.languages && JSON.stringify(input.languages) !== JSON.stringify(languageSettings(this.options.analysis().brief, this.options.analysis().detectedLanguage))) return false
    if (draft && (draft.sessionId !== input.sessionId || draft.runId !== input.runId || draft.requestId !== input.requestId)) return false
    for (const old of input.transcript) {
      const current = this.latest(old.id)
      if (!current || !current.text.startsWith(old.text) || qualification(current.text.slice(old.text.length)) ||
        (this.options.analysis().attributions[old.id]?.revision ?? 0) !== old.attribution.revision) return false
    }
    const lastOrder = input.transcript.at(-1)?.order ?? -1
    if ([...this.material.values()].some(r => r.segment.order > lastOrder && (this.isUser(r.segment.id) || qualification(r.segment.text) || r.segment.text.length > 120))) return false
    if (draft?.type === 'direction' && draft.direction.objectiveIds.some(id => !this.options.analysis().brief.objectives.some(o => o.id === id && !['answered', 'expressed', 'achieved', 'dropped'].includes(o.status)))) return false
    if (draft?.type === 'direction' && draft.direction.observationIds.some(id => this.options.analysis().observations.find(o => o.id === id)?.version !== input.observations.find(o => o.id === id)?.version)) return false
    return true
  }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer); this.timer = null
    if (this.flight) return this.flight
    if (!this.dirty || !this.enabled() || this.disposed) return Promise.resolve()
    this.dirty = false
    this.lastStartedAt = this.now()
    let input: SuggestionInput
    try { input = this.snapshot() } catch { this.state.status = 'error'; this.state.message = 'Suggestion context is too large. Shorten the brief.'; this.emit('request'); return Promise.resolve() }
    this.anotherPending = false; this.rephrasePending = undefined
    const epoch = this.generationEpoch
    const controller = new AbortController(); this.controller = controller
    const request = { id: input.requestId, input, startedAt: this.now(), completedAt: null as number | null, firstPublishedAt: null as number | null, outcome: 'running' as 'running' | 'complete' | 'obsolete' | 'error' }
    this.state.request = request; this.state.status = 'generating'; this.state.message = null; this.emit('request')
    let records = 0
    let waiting = false
    let repeated = false
    const published: string[] = []
    this.flight = (async () => {
      try {
        await deadline('suggestions', this.state.sessionId, input.requestId, this.options.requestTimeoutMs ?? 20_000, controller.signal, async signal => this.generate(input, signal, raw => {
          if (signal.aborted || controller.signal.aborted || epoch !== this.generationEpoch || !this.compatible(input)) { request.outcome = 'obsolete'; return }
          if (repeated) return
          const record = validate(recordSchema, raw) as SuggestRecord
          if (!this.compatible(input, record)) { request.outcome = 'obsolete'; return }
          if (++records > 3 || waiting) throw new Error('Invalid suggestion sequence.')
          if (record.type === 'wait') {
            if (records !== 1) throw new Error('Wait cannot follow directions.')
            if (input.rephrase) { waiting = true; this.state.message = record.message; this.emit('waiting'); return }
            waiting = true; this.invalidate(record.message)
            this.state.directions = []; this.state.recommendedId = null; this.state.message = record.message; this.state.status = 'waiting'; this.emit('waiting'); return
          }
          if (records === 1 && !record.recommended || records > 1 && record.recommended) throw new Error('Recommended opening must be first.')
          const draft = record.direction
          if (input.rephrase) {
            const original = input.rephrase.direction
            if (records > 1 || draft.move !== original.move || canonicalReply(draft.meaning) !== canonicalReply(original.meaning) || JSON.stringify(draft.objectiveIds.toSorted()) !== JSON.stringify(original.objectiveIds.toSorted()) || JSON.stringify(draft.evidence) !== JSON.stringify(original.evidence) || JSON.stringify(draft.observationIds) !== JSON.stringify(original.observationIds) || JSON.stringify(draft.assumptions) !== JSON.stringify(original.assumptions) || JSON.stringify(draft.briefReferences ?? []) !== JSON.stringify(original.briefReferences ?? []) || (draft.basis ?? 'transcript') !== (original.basis ?? 'transcript')) throw new Error('Rephrasing changed intent or factual constraints.')
            draft.directionId = original.id
          }
          const basis = draft.basis ?? 'transcript'
          const briefReferences = draft.briefReferences ?? []
          if (briefReferences.some(id => !input.brief.objectives.some(o => o.id === id) && !input.brief.items.some(i => i.id === id)) || basis === 'transcript' && !draft.evidence.length || basis === 'brief' && !briefReferences.length || basis !== 'transcript' && (draft.evidence.length > 0 || draft.observationIds.length > 0) || basis === 'neutral' && (briefReferences.length > 0 || draft.objectiveIds.length > 0)) throw new Error('Invalid suggestion basis.')
          if (input.generation === 'another' && input.recent.some(d => canonicalReply(d.opening) === canonicalReply(draft.opening) || canonicalReply(d.meaning) === canonicalReply(draft.meaning))) {
            if (records === 1) { repeated = true; waiting = true; this.state.status = 'waiting'; this.state.message = 'No different reply is supported yet. Keep listening or try again.'; this.emit('waiting') }
            return
          }
          const languages = input.languages ?? languageSettings(input.brief)
          const spokenLanguage = languageCode(draft.language) || languages.conversation
          if (languages.conversation && languageCode(draft.language) !== languages.conversation) throw new Error('Reply language does not match the conversation setting.')
          if (spokenLanguage && spokenLanguage !== languages.user) {
            if (!draft.translation || languageCode(draft.translation.language) !== languages.user || draft.continuation && !draft.translation.continuation) throw new Error('A reply in another language requires a matching translation.')
          } else draft.translation = null
          if (unsupportedFragments(draft.evidence, input.transcript).length) {
            waiting = true; this.state.directions = []; this.state.recommendedId = null; this.state.status = 'waiting'; this.state.message = 'The transcript fragment does not establish a subject or material yet. Keep listening.'; this.emit('waiting'); return
          }
          if (draft.objectiveIds.some(id => !input.brief.objectives.some(o => o.id === id)) ||
            draft.evidence.some(e => !input.transcript.some(s => s.id === e.segmentId && s.revision === e.revision)) ||
            draft.observationIds.some(id => !input.observations.some(o => o.id === id))) throw new Error('Invalid suggestion references.')
          const prior = input.rephrase ? input.rephrase.direction : draft.directionId ? this.state.history.findLast(d => d.id === draft.directionId) : this.state.history.findLast(d => !published.includes(d.id) && d.move === draft.move && d.label.toLocaleLowerCase() === draft.label.toLocaleLowerCase() && JSON.stringify(d.objectiveIds.toSorted()) === JSON.stringify(draft.objectiveIds.toSorted()))
          if (draft.directionId && (!prior || prior.move !== draft.move || !input.rephrase && !input.recent.some(d => d.id === draft.directionId))) throw new Error('Invalid direction identity.')
          const id = prior?.id ?? crypto.randomUUID()
          if (published.includes(id)) throw new Error('Duplicate direction.')
          published.push(id)
          const { directionId: _directionId, ...content } = draft
          const direction: Direction = { ...content, id, version: (prior?.version ?? 0) + 1, requestId: input.requestId,
            status: input.transcript.some(s => s.status === 'partial' || this.latest(s.id)?.revision !== s.revision) ? 'provisional' : draft.status,
            provenance: { sessionId: input.sessionId, runId: input.runId, requestId: input.requestId, briefVersion: input.briefVersion, basis, briefReferences,
              inputs: input.transcript.map(ref), observationVersions: Object.fromEntries(input.observations.filter(o => draft.observationIds.includes(o.id)).map(o => [o.id, o.version])),
              attributionVersions: Object.fromEntries(input.transcript.map(s => [s.id, s.attribution.revision])), tail: input.tail.slice(-1600), knownDiscardIds: input.rejectedFindings?.map(o => o.id) ?? [] },
            publishedAt: this.now(), publishedMediaMs: this.options.media(), lifecycle: 'active', warning: null, invalidatedMediaMs: null }
          // Canonicalize only text-identical finalization revisions, never unseen content.
          direction.evidence = direction.evidence.map(e => {
            const original = input.transcript.find(s => s.id === e.segmentId)
            const latest = this.latest(e.segmentId)
            return original && latest?.text === original.text ? ref(latest) : e
          })
          if (direction.evidence.some(e => this.latest(e.segmentId)?.revision !== e.revision)) {
            direction.lifecycle = 'reassess'; direction.warning = 'Speech continued; awaiting the updated direction.'; direction.invalidatedMediaMs = this.options.media()
          }
          if (input.rephrase) {
            this.state.directions = this.state.directions.map(d => d.id === input.rephrase!.id ? direction : d)
            if (this.state.selected?.direction.id === direction.id) this.state.selected.direction = structuredClone(direction)
          } else {
            if (records === 1) this.state.directions = []
            this.state.directions.push(direction)
          }
          this.state.history.push(structuredClone(direction))
          this.state.history = this.state.history.slice(-80)
          while (bytes(this.state.history) > 300_000 && this.state.history.length > 3) this.state.history.shift()
          if (record.recommended && !input.rephrase) this.state.recommendedId = id
          request.firstPublishedAt ??= this.now()
          this.state.message = null; this.emit('published')
        }))
        if (controller.signal.aborted) request.outcome = 'obsolete'
        if (request.outcome !== 'obsolete') {
          if (!records) throw new Error('Empty suggestion response.')
          request.outcome = 'complete'; this.state.status = waiting ? 'waiting' : 'idle'
        }
      } catch (error) {
        diagnostic('error', { sessionId: this.state.sessionId, workType: 'suggestions', requestId: input.requestId, ...providerMetadata(error) })
        if (controller.signal.aborted) request.outcome = 'obsolete'
        else { this.failed = true; this.dirty = true; request.outcome = 'error'; this.state.status = 'error'; const safe = error instanceof Error && ['Invalid direction identity.', 'Duplicate direction.', 'Invalid suggestion references.', 'Invalid suggestion sequence.', 'Recommended opening must be first.', 'Wait cannot follow directions.', 'Empty suggestion response.', 'Suggestion stream failed or exceeded limit.', 'Invalid structured analysis data. No changes applied.', 'Too many suggestion records.'].includes(error.message) ? error.message : 'Model unavailable or invalid output.'; this.state.message = 'Suggestion request failed: ' + safe + ' Transcript and tracking continue; try another direction.' }
      } finally {
        request.completedAt = this.now()
        if (request.outcome === 'obsolete' && !this.enabled()) { this.state.status = 'idle'; this.state.message = null }
        else if (request.outcome === 'obsolete') { this.state.status = 'waiting'; this.state.message = 'New context arrived; preparing an updated direction.' }
        this.emit('request')
      }
    })().finally(() => { this.flight = null; this.controller = null; if (this.dirty && !this.disposed) this.schedule(this.anotherPending || !!this.rephrasePending) })
    return this.flight
  }
  select(id: string, version: number) {
    const direction = this.state.directions.find(d => d.id === id && d.version === version && d.lifecycle === 'active')
    if (!direction || !this.compatibleDirection(direction)) throw new Error('Direction changed; choose a current suggestion.')
    this.manualSelection = true
    this.state.selected = { id: crypto.randomUUID(), direction: structuredClone(direction), selectedAt: this.now(), mediaMs: this.options.media(), speechAfter: [...this.material.values()].map(r => ref(r.segment)), userParticipantId: this.state.userParticipantId, warning: null, expression: 'uncertain', reason: 'Selected intent; no spoken evidence yet.', evidence: [] }
    this.emit('selected')
  }
  private compatibleDirection(direction: Direction) {
    return !unsupportedFragments(direction.evidence, [...this.material.values()].map(r => r.segment)).length && !this.affectedByDiscard(direction) && direction.provenance.briefVersion === briefAnalysisVersion(this.options.analysis().brief) && direction.evidence.every(e => this.latest(e.segmentId)?.revision === e.revision)
  }
  release(selectionId: string) { if (this.state.selected?.id !== selectionId) throw new Error('Selection changed.'); this.manualSelection = true; this.state.selected = null; this.emit('released') }
  selection(): DirectionSelection | null { return this.state.selected ? structuredClone(this.state.selected) : null }
  assess(value: { selectionId: string; status: Expression; evidence: Evidence[]; reason: string }) {
    const selection = this.state.selected
    if (!selection || selection.id !== value.selectionId || selection.userParticipantId !== this.state.userParticipantId) return
    const userEvidence = value.evidence.filter(e => this.isUser(e.segmentId))
    if (value.status !== 'uncertain' && (!userEvidence.length || !selection.userParticipantId)) return
    if (value.evidence.some(e => this.latest(e.segmentId)?.revision !== e.revision || selection.speechAfter.some(old => old.segmentId === e.segmentId))) return
    if (value.status === 'interrupted' && !value.evidence.some(e => { const speaker = this.options.analysis().attributions[e.segmentId]?.participantId; return !!speaker && speaker !== selection.userParticipantId && userEvidence.some(u => (this.latest(u.segmentId)?.order ?? Infinity) < (this.latest(e.segmentId)?.order ?? -1)) })) return
    if (value.status === 'expressed' && (userEvidence.some(e => this.latest(e.segmentId)?.status !== 'final'))) return
    if (value.status !== 'interrupted' && value.evidence.some(e => !this.isUser(e.segmentId))) return
    selection.expression = value.status; selection.evidence = value.evidence; selection.reason = value.reason; this.emit('expression')
  }
  turnEnd(mediaMs: number, id: string = crypto.randomUUID()) {
    if (!Number.isFinite(mediaMs) || mediaMs < 0 || mediaMs > this.options.media() + 500) throw new Error('Invalid turn boundary.')
    if (this.state.turns.some(o => o.id === id)) return
    this.state.turns.push({ id, endMs: mediaMs })
    this.state.turns = this.state.turns.slice(-80)
    this.emit('turn_end')
    if (this.state.mode === 'baseline') { this.baselineThrough = mediaMs; this.schedule(true) }
  }
  restore(saved: SuggestionState) {
    const { sessionId, runId, version, selected } = this.state
    this.state = { ...structuredClone(saved), sessionId, runId, version: version + 1, mode: 'saved', status: 'saved', ...(this.manualSelection ? { selected } : {}) }
    this.invalidate('Supporting finding was marked wrong; use a new direction.', d => this.affectedByDiscard(d))
    isolate('suggestion-publication', this.state.sessionId, () => this.options.publish(structuredClone(this.state), 'initial'))
  }
  replayMark(saved: SuggestionState, reason: SuggestionReason) {
    if (reason === 'config' && !this.manualConfiguration) {
      this.state.style = saved.style
      this.state.userParticipantId = saved.userParticipantId
      this.emit('config')
    }
    if (reason === 'turn_end') { const turn = saved.turns.at(-1); if (turn) this.turnEnd(turn.endMs, turn.id) }
    // Selection and wording from another generation run must never leak into recomputation.
  }
  dispose() { this.disposed = true; this.controller?.abort(); if (this.timer) clearTimeout(this.timer); this.timer = null; this.dirty = false }
}
