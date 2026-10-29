import { useLanguageOptions } from './use-language-options'
import { useReport } from './report-hooks'
import { useEffect, useRef, useState } from 'react'
import { SavedBriefs } from './SavedBriefs'
import { BriefDraftController } from './brief-draft'
import { loadBriefCache, saveBriefCache } from './brief-cache'
import type { AnalysisState, AssistantAction, Brief, Evidence, Objective, Observation } from '../shared/analysis'
import type { Segment } from '../shared/protocol'
import { Column, Section } from './Section'
import { PillSwitch } from './PillSwitch'
import { languageCode, languageName, languageSettings, supportedLanguages } from '../shared/languages'

export type Selection = { type: 'objective' | 'observation'; id: string } | null
export type AssistantSend = (action: AssistantAction) => Promise<AnalysisState>
const freshId = () => crypto.randomUUID()

export function BriefEditor({ analysis, send, onDirtyChange, knownUserId, connected = true, connectionEpoch = 0 }: { analysis: AnalysisState; send: AssistantSend; onDirtyChange: (dirty: boolean) => void; knownUserId?: string | null; connected?: boolean; connectionEpoch?: number }) {
  const [controller] = useState(() => new BriefDraftController(analysis.brief, send, { knownUserId, connected, preparation: analysis.sessionId === 'preparation', snapshot: analysis.sessionId === 'preparation' ? loadBriefCache() : null, cache: analysis.sessionId === 'preparation' ? saveBriefCache : undefined }))
  const [editor, setEditor] = useState(controller.state)
  const [templateWorking, setTemplateWorking] = useState(false)
  const briefInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => controller.subscribe(setEditor), [controller])
  useEffect(() => { controller.setSend(send) }, [controller, send])
  useEffect(() => { controller.sync(analysis.brief, connected, connectionEpoch) }, [controller, analysis.brief, connected, connectionEpoch])
  useEffect(() => { onDirtyChange(editor.dirty || editor.saving || templateWorking) }, [editor.dirty, editor.saving, templateWorking, onDirtyChange])
  useEffect(() => () => controller.dispose(), [controller])
  const { draft, dirty, saving, building, error } = editor
  const readingLanguage = languageSettings(draft).user, conversationLanguage = languageCode(draft.languages.call)
  const { options: languages, error: languageError } = useLanguageOptions(readingLanguage, conversationLanguage, connectionEpoch)
  const readingUnavailable = !!languages && !languages.user.includes(readingLanguage as typeof languages.user[number])
  const conversationUnavailable = !!languages && (conversationLanguage ? !languages.conversation.includes(conversationLanguage) : !languages.automatic)
  const languageProblem = languageError || (readingUnavailable ? languages?.excluded.find(e => e.role === 'user' && e.language === readingLanguage)?.reason : conversationUnavailable ? conversationLanguage ? languages?.excluded.find(e => e.role === 'conversation' && e.language === conversationLanguage)?.reason : 'Choose a conversation language. This setup does not support automatic recognition.' : '')
  const update = (change: Partial<Brief>) => controller.update(change)
  const objective = (id: string, change: Partial<Objective>) => update({ objectives: draft.objectives.map(o => o.id === id ? { ...o, ...change, origin: 'explicit' } : o) })
  const me = draft.participants.find(p => p.id === draft.userParticipantId)!
  const otherSide = draft.sides.find(side => side.id === draft.conversationSideId)!
  const stateLabel = !editor.connected ? dirty && editor.storedLocally ? 'Saved on this device · waiting for server' : 'Waiting for server' : saving ? 'Saving…' : error ? dirty ? 'Couldn’t save' : 'Couldn’t update brief' : dirty ? 'Changes save automatically' : 'Saved'
  useReport('brief-save', { source: 'Call brief', severity: error ? 'error' : !editor.connected ? 'warning' : saving || dirty ? 'progress' : 'success', summary: stateLabel, details: error || undefined, action: (error && dirty) || saving ? { label: 'Retry saving', pending: saving || building, run: () => controller.retry() } : undefined }, '', true)
  useReport('brief-build', building ? { source: 'Call brief', severity: 'progress', summary: 'Building objectives…' } : null)
  return <Section className="brief-editor" title="Call brief">
    <div className="brief-content" onBlurCapture={() => { void controller.flush() }}>
      <SavedBriefs controller={controller} preparation={analysis.sessionId === 'preparation'} connected={connected} connectionEpoch={connectionEpoch} onWorking={setTemplateWorking} focusEditor={() => briefInput.current?.focus()} />
      <fieldset className="brief-layout" disabled={building || templateWorking} aria-label="Call brief settings">
        <section className="brief-preparation" aria-label="Call preparation">
          <label className="field brief-goal">Conversation brief<textarea ref={briefInput} value={draft.preparation} maxLength={40000} aria-describedby="conversation-brief-help" onChange={e => update({ preparation: e.target.value })} placeholder="What do you want to learn, say, or achieve?" rows={8} /></label>
          <p id="conversation-brief-help" className="help">Include things to learn, say, or achieve, plus context, preferences, boundaries, and answers to clarification questions.</p>
          {analysis.sessionId !== 'preparation' && draft.answers && <div className="legacy-brief-context"><strong>Additional context</strong><p>{draft.answers}</p></div>}
          {analysis.brief.clarifications.length > 0 && <div className="clarifications"><strong>Essential clarifications</strong><ul>{analysis.brief.clarifications.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
          <div className="brief-actions"><button className="primary" disabled={!editor.connected || building || analysis.briefStatus === 'analyzing' || !languages || readingUnavailable || conversationUnavailable} onClick={() => { void controller.build() }}>Build objectives</button></div>
          <p className="help brief-goal-note">Choose Build objectives to update the list from your conversation brief.</p>
          <section className="brief-people" aria-label="Participants and languages">
            <h3>Participants & languages</h3>
            <div className="brief-person">
              <strong>Me</strong>
              <div className="brief-person-fields">
                <label className="field">My name<input value={me.name} maxLength={4000} onChange={e => update({ participants: draft.participants.map(p => p.id === me.id ? { ...p, name: e.target.value } : p) })} /></label>
                <label className="field">My language<select disabled={!languages} aria-describedby="language-availability" value={readingLanguage} onChange={e => update({ languages: { ...draft.languages, user: e.target.value } })}>{(!languages || readingUnavailable) && <option disabled value={readingLanguage}>{languageName(readingLanguage)} · {languages ? 'unavailable' : 'checking availability…'}</option>}{supportedLanguages.filter(l => languages?.user.includes(l.code)).map(l => <option key={l.code} value={l.code}>{l.name}</option>)}</select></label>
              </div>
            </div>
            <div className="brief-person">
              <strong>Other side</strong>
              <div className="brief-person-fields">
                <label className="field">Side name<input value={otherSide.name} maxLength={4000} onChange={e => update({ sides: draft.sides.map(side => side.id === otherSide.id ? { ...side, name: e.target.value } : side) })} /></label>
                <label className="field">Conversation language<select disabled={!languages} aria-describedby="language-availability" value={conversationLanguage} onChange={e => update({ languages: { ...draft.languages, call: e.target.value } })}><option value="" disabled={!languages?.automatic}>{!languages?.automatic ? 'Auto · unavailable with this setup' : languageCode(analysis.detectedLanguage) ? 'Auto · ' + languageName(analysis.detectedLanguage) + ' detected' : 'Auto · detect from speech'}</option>{conversationLanguage && (!languages || conversationUnavailable) && <option disabled value={conversationLanguage}>{languageName(conversationLanguage)} · {languages ? 'unavailable' : 'checking availability…'}</option>}{supportedLanguages.filter(l => languages?.conversation.includes(l.code)).map(l => <option key={l.code} value={l.code}>{l.name}</option>)}</select></label>
              </div>
            </div>
            <div id="language-availability" className="help" aria-live="polite">{languageProblem ? <p role="alert">{languageProblem} Choose an available language or update backend settings.</p> : !languages ? 'Checking available languages…' : 'Language choices reflect this setup and installed language assets.'}
              {!!languages?.issues.length && <p>{languages.issues.join(' ')}</p>}
              {!!languages?.excluded.length && <details><summary>Why some languages are unavailable</summary><ul>{languages.excluded.map(e => <li key={e.role + e.language}>{languageName(e.language)} ({e.role === 'user' ? 'my language' : 'conversation'}): {e.reason}</li>)}</ul></details>}
            </div>
            <p className="help">Replies use the conversation language. Transcripts and replies include a translation into your language when they differ.</p>
          </section>
        </section>
        <section className="brief-targets" aria-label="Recognized objectives">
          <div className="brief-targets-heading"><h3>Recognized objectives</h3><span className="help">{draft.objectives.length}</span></div>
          {!draft.objectives.length && <p className="help">Build objectives from your conversation brief, or add one yourself.</p>}
          <div className="brief-objective-list">{draft.objectives.map(o => <details className="brief-objective" key={o.id}><summary>{o.description || 'New objective'}</summary>
            <label className="field">Timing<select value={o.timing ?? 'anytime'} onChange={e => objective(o.id, { timing: e.target.value as Objective['timing'] })}><option value="anytime">Anytime</option><option value="opening">Opening</option></select></label>
            <label className="field">Kind<select value={o.kind} onChange={e => objective(o.id, { kind: e.target.value as Objective['kind'] })}><option value="question">Question</option><option value="say">Thing to say</option><option value="outcome">Desired outcome</option></select></label>
            <label className="field">Description<textarea value={o.description} maxLength={4000} rows={2} onChange={e => objective(o.id, { description: e.target.value })} /></label>
            <label className="field">Complete when<textarea value={o.completion} maxLength={4000} rows={2} onChange={e => objective(o.id, { completion: e.target.value })} /></label>
            <button className="danger-button" onClick={() => update({ objectives: draft.objectives.filter(item => item.id !== o.id) })}>Delete objective</button>
          </details>)}</div>
          <button className="brief-add-objective" onClick={() => update({ objectives: [...draft.objectives, { id: freshId(), kind: 'question', description: '', completion: '', origin: 'explicit', status: 'unexplored', evidence: [], reason: '', history: [] }] })}>+ Add objective</button>
        </section>
      </fieldset>
    </div>
  </Section>
}

function EvidenceList({ evidence, segments, select }: { evidence: Evidence[]; segments: Map<string, Segment>; select: () => void }) {
  const revised = evidence.some(e => segments.get(e.segmentId)?.revision !== e.revision)
  return <div className="evidence"><button className="evidence-button" onClick={select}>↔ Show {evidence.length} transcript {evidence.length === 1 ? 'reference' : 'references'}</button>{revised && <small>Some references were revised or are unavailable at this position.</small>}</div>
}

const statusLabel = (value: string) => ({ unexplored: 'Not covered', partial: 'In progress', provisional: 'Tentative', established: 'Stated', retracted: 'Retracted', answered: 'Answered', expressed: 'Said', achieved: 'Achieved', blocked: 'Blocked', dropped: 'Dropped' }[value] ?? value)

export function ConfirmObjective({ objective, analysis, segments, send, compact = false }: { objective: Objective; analysis: AnalysisState; segments: Map<string, Segment>; send: AssistantSend; compact?: boolean }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  useReport('objective-' + objective.id, error || working ? { source: 'Objectives', severity: error ? 'error' : 'progress', summary: error || 'Confirming objective…' } : null, analysis.sessionId)
  if (objective.confirmedByUser) return <p className="help">✓ Confirmed by you</p>
  if (['answered', 'expressed', 'achieved', 'dropped'].includes(objective.status)) return null
  const revised = objective.evidence.some(e => segments.get(e.segmentId)?.revision !== e.revision)
  return <div className="objective-confirmation"><button disabled={working || revised} title={`Mark as covered: ${objective.description}. Move on without asking for spoken confirmation.`} onClick={() => {
    setWorking(true); setError('')
    void send({ action: 'confirm_objective', id: objective.id, version: analysis.brief.version, evidence: objective.evidence }).catch(e => setError((e as Error).message)).finally(() => setWorking(false))
  }}>Confirmed</button>{!compact && <span className="help">{revised ? 'Supporting speech changed; awaiting reassessment.' : 'Already covered? Mark it complete and move on.'}</span>}</div>
}

export function Objectives({ analysis, selection, select, segments, send }: { analysis: AnalysisState | null; selection: Selection; select: (selection: Selection) => void; segments: Map<string, Segment>; send: AssistantSend }) {
  return <Column className="objectives" title="Objectives" meta={String(analysis?.brief.objectives.length ?? 0)}>
    <div className="column-list" tabIndex={0} aria-label="Objectives list">
    {!analysis?.brief.objectives.length && <p className="list-empty">Build objectives in the call brief to track what matters.</p>}
    {analysis?.brief.objectives.map(o => <details id={`objective-${o.id}`} className={`objective insight-card ${selection?.type === 'objective' && selection.id === o.id ? 'selected' : ''}`} key={o.id} onToggle={e => { if (e.target !== e.currentTarget) return; if (e.currentTarget.open) select({ type: 'objective', id: o.id }); else if (selection?.id === o.id) select(null) }}>
      <summary><span className="card-meta"><span className={`badge ${o.status}`}>{statusLabel(o.status)}</span><small>{o.kind === 'say' ? 'Thing to say' : o.kind}{o.timing === 'opening' ? ' · Opening' : ''}</small></span><strong>{o.description}</strong><span className="card-reference">{o.evidence.length ? `↔ ${o.evidence.length} references` : 'Awaiting evidence'}</span></summary>
      <div className="card-detail"><p><strong>Complete when</strong> {o.completion || 'Add a completion condition in the brief.'}</p>{o.reason && <p>{o.reason}</p>}{o.origin === 'inferred' && <p className="help">Suggested from your brief.</p>}{o.evidence.length > 0 && <EvidenceList evidence={o.evidence} segments={segments} select={() => select({ type: 'objective', id: o.id })} />}<details><summary>History · {o.history.length}</summary>{o.history.map((entry, i) => <p key={i}>{(entry.atMs / 1000).toFixed(1)} s · {statusLabel(entry.status)}: {entry.reason}</p>)}</details></div>
      <ConfirmObjective objective={o} analysis={analysis} segments={segments} send={send} />
    </details>)}
    {!!analysis?.openQuestions.length && <details className="open-questions"><summary>Still open · {analysis.openQuestions.length}</summary><ul>{analysis.openQuestions.map((question, i) => <li key={i}>{question}</li>)}</ul></details>}
    </div>
  </Column>
}

function ObservationDetail({ observation, analysis, segments, select, send }: { observation: Observation; analysis: AnalysisState; segments: Map<string, Segment>; select: () => void; send: AssistantSend }) {
  const [meaning, setMeaning] = useState(observation.meaning)
  const [status, setStatus] = useState(observation.status)
  const [segmentId, setSegmentId] = useState(observation.evidence[0]?.segmentId ?? '')
  const [participantId, setParticipantId] = useState(analysis.attributions[segmentId]?.participantId ?? '')
  const [sideId, setSideId] = useState(analysis.attributions[segmentId]?.sideId ?? '')
  const [sourceLabel, setSourceLabel] = useState(analysis.attributions[segmentId]?.sourceLabel ?? '')
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [baseVersion, setBaseVersion] = useState(observation.version)
  const [seenVersion, setSeenVersion] = useState(observation.version)
  if (seenVersion !== observation.version) {
    setSeenVersion(observation.version)
    if (!dirty) { setMeaning(observation.meaning); setStatus(observation.status); setBaseVersion(observation.version) }
  }
  useReport('observation-' + observation.id, error || working ? { source: 'Observations', severity: error ? 'error' : 'progress', summary: error || 'Updating observation…' } : null, analysis.sessionId)
  async function run(action: AssistantAction) {
    setWorking(true); setError('')
    try { await send(action) } catch (e) { setError((e as Error).message) } finally { setWorking(false) }
  }
  return <div className="card-detail">
    <EvidenceList evidence={observation.evidence} segments={segments} select={select} />
    {observation.discardedByUser && <p className="help">Discarded. Related conclusions are being reassessed.</p>}
    {observation.conditions.length > 0 && <div className="finding-conditions"><strong>Conditions</strong><ul>{observation.conditions.map((condition, i) => <li key={i}>{condition}</li>)}</ul></div>}
    <details name={`finding-tools-${observation.id}`}><summary>Context & reasoning</summary><p>{observation.reason}</p>
    {observation.grounding && <p className="help">{observation.grounding.kind} support · {observation.grounding.entityExplanation}</p>}
    {observation.relations.map(relation => <p key={`${relation.objectiveId}:${relation.relationship}`}>{relation.relationship} · {analysis.brief.objectives.find(o => o.id === relation.objectiveId)?.description}</p>)}
    </details>
    <details name={`finding-tools-${observation.id}`}><summary>Edit interpretation</summary><label className="field">Meaning<textarea value={meaning} maxLength={4000} rows={3} onChange={e => { setMeaning(e.target.value); setDirty(true) }} /></label><label className="field">Status<select value={status} onChange={e => { setStatus(e.target.value as Observation['status']); setDirty(true) }}><option>provisional</option><option>established</option><option>retracted</option></select></label><button disabled={working} onClick={() => { void run({ action: 'correct', id: observation.id, version: baseVersion, meaning, status }) }}>Save correction</button>{dirty && baseVersion !== observation.version && <p>Your draft is retained, but the observation changed. <button onClick={() => { setMeaning(observation.meaning); setStatus(observation.status); setBaseVersion(observation.version); setDirty(false) }}>Review current interpretation</button></p>}</details>
    <details name={`finding-tools-${observation.id}`}><summary>Edit speaker or source</summary><p className="help">Choose the specific segment you can attribute. Keep mixed or uncertain speech unknown.</p><label className="field">Transcript segment<select value={segmentId} onChange={e => { const id = e.target.value; setSegmentId(id); setParticipantId(analysis.attributions[id]?.participantId ?? ''); setSideId(analysis.attributions[id]?.sideId ?? ''); setSourceLabel(analysis.attributions[id]?.sourceLabel ?? '') }}>{observation.evidence.map(e => <option key={e.segmentId} value={e.segmentId}>{segments.get(e.segmentId)?.text.slice(0, 65) ?? e.segmentId}</option>)}</select></label><label className="field">Participant<select value={participantId} onChange={e => setParticipantId(e.target.value)}><option value="">Unidentified participant</option>{analysis.brief.participants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="field">Side (if known)<select value={sideId} onChange={e => setSideId(e.target.value)}><option value="">Unknown</option>{analysis.brief.sides.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="field">Source / channel label<input value={sourceLabel} placeholder="e.g. your microphone, remote call, unknown" onChange={e => setSourceLabel(e.target.value)} /></label><button disabled={working || !segmentId} onClick={() => { void run({ action: 'attribute', segmentIds: [segmentId], participantId: participantId || null, sideId: sideId || null, sourceLabel }) }}>Save attribution</button></details>
    {observation.status !== 'retracted' && <button className="danger-button" disabled={working} onClick={() => { if (window.confirm('Discard this finding? Related conclusions will be cleared and reassessed.')) void run({ action: 'discard', id: observation.id, version: observation.version }) }}>Discard finding</button>}
  </div>
}

export function Observations({ analysis, selection, select, segments, send }: { analysis: AnalysisState | null; selection: Selection; select: (selection: Selection) => void; segments: Map<string, Segment>; send: AssistantSend }) {
  const [filter, setFilter] = useState('active')
  const observations = [...(analysis?.observations ?? [])].reverse().filter(o => filter === 'all' || (filter === 'attention' ? o.attention !== 'normal' && o.status !== 'retracted' : o.status !== 'retracted'))
  return <Column className="observations" title="Observations" meta={String(observations.length)}>
    <div className="column-list" tabIndex={0} aria-label="Observations list"><div className="list-filter"><PillSwitch label="Show observations" hideLabel value={filter} onChange={setFilter} options={[{ value: 'active', label: 'Active' }, { value: 'attention', label: 'Needs attention' }, { value: 'all', label: 'All' }]} /></div>
    {!observations.length && <p className="list-empty">{filter === 'active' ? 'Findings appear as the conversation develops.' : 'No matching findings. Choose another filter to see more.'}</p>}
    {observations.map(o => <details id={`observation-${o.id}`} className={`observation insight-card ${selection?.type === 'observation' && selection.id === o.id ? 'selected' : ''}`} key={o.id} onToggle={e => { if (e.target !== e.currentTarget) return; if (e.currentTarget.open) select({ type: 'observation', id: o.id }); else if (selection?.id === o.id) select(null) }}>
      <summary><span className="card-meta"><span className={`badge ${o.status}`}>{statusLabel(o.status)}</span><small>{o.type}{o.attention !== 'normal' ? ` · ${o.attention}` : ''}{o.addressedToUser ? ' · asks you' : ''}{o.hypothetical ? ' · hypothetical' : ''}{o.quoted ? ' · quoted' : ''}{o.correctedByUser ? ' · corrected' : ''}</small></span><strong>{o.meaning}</strong><span className="card-reference">{o.speaker.participantId ? analysis?.brief.participants.find(p => p.id === o.speaker.participantId)?.name : o.speaker.sourceLabel || 'Unknown speaker'} · ↔ {o.evidence.length} references</span></summary>
      {analysis && <ObservationDetail key={o.id} observation={o} analysis={analysis} segments={segments} select={() => select({ type: 'observation', id: o.id })} send={send} />}
    </details>)}
    </div>
  </Column>
}

export function AnalysisError({ analysis, send }: { analysis: AnalysisState | null; send: AssistantSend }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [lastStatus, setLastStatus] = useState(analysis?.status)
  if (lastStatus !== analysis?.status) { setLastStatus(analysis?.status); if (analysis?.status !== 'error') setError('') }
  useReport('analysis', analysis?.status === 'error' || error || working || (analysis?.status === 'analyzing' || analysis?.status === 'scheduled') ? {
    source: 'Analysis', severity: working || analysis?.status === 'analyzing' ? 'progress' : 'error',
    summary: working || analysis?.status === 'analyzing' ? 'Analyzing conversation…' : error || analysis?.message || 'Could not update the conversation.',
    action: { label: 'Retry analysis', pending: working || analysis?.status === 'analyzing', run: async () => {
      setWorking(true); setError('')
      try { const result = await send({ action: analysis?.request?.mode === 'BRIEF' ? 'extract' : 'retry' }); if (result.status === 'error') setError(result.message ?? 'Analysis failed. Please retry.') }
      catch (e) { setError((e as Error).message) } finally { setWorking(false) }
    } },
  } : null, analysis?.sessionId)
  return null
}
