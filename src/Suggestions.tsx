import { useReport } from './report-hooks'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AnalysisState } from '../shared/analysis'
import type { Segment } from '../shared/protocol'
import { type Direction, type SuggestionAction, type SuggestionState } from '../shared/suggestions'
import { languageCode, languageName, languageSettings } from '../shared/languages'
import { ConfirmObjective, type AssistantSend } from './Assistant'
import { quickPhraseLabels, quickPhrases } from '../shared/quick-phrases'

export type SuggestSend = (action: SuggestionAction) => Promise<SuggestionState>
const sec = (n: number) => (n / 1000).toFixed(2) + ' s'
const en = {
  uncertain: 'Uncertain', expressed: 'Said', partial: 'Partially expressed', departed: 'Different direction', interrupted: 'Interrupted', revised: 'Transcript revised; see saved input provenance.',
  title: 'What you can say', recommended: 'Recommended', selected: 'Pinned reply', ready: 'Ready', provisional: 'Provisional', reassess: 'Needs reassessment',
  select: 'Pin this reply', release: 'Unpin reply', another: 'Generate another', waiting: 'Listening for enough context.', off: 'Suggestions are off.', saved: 'Saved suggestions',
  evidence: 'Why this reply', assumptions: 'Assumptions / conditions',
} as const
type Copy = { [K in keyof typeof en]: string }
function ReplyTranslation({ direction, userLanguage }: { direction: Direction; userLanguage: string }) {
  const translation = direction.translation
  if (!translation || languageCode(direction.language) === userLanguage || translation.language !== userLanguage) return null
  return <div className="reply-translation" lang={userLanguage}><small>{languageName(userLanguage)} translation</small><p>{translation.opening}</p>{translation.continuation && <p>{translation.continuation}</p>}</div>
}
function DirectionDetails({ direction, segments, copy, analysis }: { direction: Direction; segments: Map<string, Segment>; copy: Copy; analysis: AnalysisState | null }) {
  return <details className="direction-details" name="reply-details"><summary>{copy.evidence}</summary><p>{direction.meaning}</p>
    {!!direction.assumptions.length && <><strong>{copy.assumptions}</strong><ul>{direction.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></>}
    {direction.briefReferences?.length ? <p>From your brief: {direction.briefReferences.map(id => analysis?.brief.objectives.find(o => o.id === id)?.description ?? analysis?.brief.items.find(i => i.id === id)?.text ?? 'Previous brief point').join(' · ')}</p> : null}
    {direction.evidence.map(e => <p key={e.segmentId + ':' + e.revision}><a href={'#segment-' + e.segmentId}>{e.segmentId.slice(0, 12)} · r{e.revision}</a><br />{segments.get(e.segmentId)?.revision === e.revision ? segments.get(e.segmentId)?.text : copy.revised}</p>)}
    <small>{direction.objectiveIds.join(' · ')} · v{direction.version} · {sec(direction.publishedMediaMs)}</small>
  </details>
}
export function TranscriptReply({ children }: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element || !body.current) return
    const measure = () => setMore(element.scrollHeight - element.scrollTop - element.clientHeight > 4)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(body.current)
    element.addEventListener('scroll', measure)
    measure()
    return () => { observer.disconnect(); element.removeEventListener('scroll', measure) }
  }, [])
  return <div className="transcript-reply" ref={scroller} tabIndex={0} role="region" aria-label="Reply preparation"><div ref={body}>{children}</div>{more && <span className="reply-scroll-hint" aria-hidden="true">Scroll for more ↓</span>}</div>
}

export function Suggestions({ state, analysis, segments, send, assistantSend }: {
  state: SuggestionState; analysis: AnalysisState | null; segments: Map<string, Segment>; send: SuggestSend; assistantSend: AssistantSend
}) {
  const copy: Copy = en
  const userLanguage = analysis ? languageSettings(analysis.brief).user : 'en'
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [pending, setPending] = useState<Direction | null>(null)
  const phrase = useRef<HTMLParagraphElement | null>(null)
  if (pending && state.selected?.direction.id === pending.id && state.selected.direction.version === pending.version) setPending(null)
  const unacknowledged = pending && !(state.selected?.direction.id === pending.id && state.selected.direction.version === pending.version) ? pending : null
  const current = unacknowledged ?? state.selected?.direction ?? (state.mode === 'off' ? undefined : state.directions.find(d => d.id === state.recommendedId))
  const pinned = !!unacknowledged || !!state.selected
  const generating = state.status === 'generating' || state.status === 'scheduled'
  const run = async (action: SuggestionAction) => { setWorking(true); setError(''); try { return await send(action) } catch (e) { setError((e as Error).message); return null } finally { setWorking(false) } }
  useReport('reply-request', error || working ? { source: 'Replies', severity: error ? 'error' : 'progress', summary: error || 'Updating reply…' } : null, state.sessionId)
  useReport('reply-generation', state.message || state.status === 'error' || generating ? { source: 'Replies', severity: state.status === 'error' ? 'error' : 'progress', summary: state.message || 'Preparing a reply…', action: { label: 'Retry reply', pending: generating || working, run: () => run({ action: 'suggest_another' }) } } : null, state.sessionId)
  useLayoutEffect(() => {
    if (pending) phrase.current?.focus({ preventScroll: true })
  }, [pending, state.selected])
  const choose = (d: Direction) => { setPending(d); void run({ action: 'suggest_select', id: d.id, version: d.version }).then(value => { if (!value) setPending(null) }) }
  const settings = analysis ? languageSettings(analysis.brief, analysis.detectedLanguage) : { conversation: '', user: 'en' }
  const quickLanguage = languageCode(settings.conversation) || languageCode(userLanguage) || 'en'
  const visible = [...(current ? [current] : []), ...state.directions.filter(d => d.id !== current?.id)].slice(0, 3)
  const readOnly = state.mode === 'off' || state.mode === 'saved'
  return <div className="suggestions" aria-label={copy.title}>
    <div className="reply-heading"><h3>{copy.title}</h3>{!settings.conversation && <span className="section-meta">Preparation in {languageName(userLanguage)} · conversation language unknown</span>}</div>
    <div className="conversation-moves">
      {visible.map(d => {
        const isPinned = pinned && current?.id === d.id
        const said = isPinned && (state.selected?.expression === 'expressed' || !!d.objectiveIds.length && d.objectiveIds.every(id => analysis?.brief.objectives.find(o => o.id === id)?.status === 'expressed'))
        const confirmationObjectives = analysis && ['confirm', 'check', 'clarify'].includes(d.move) ? d.objectiveIds.flatMap(id => analysis.brief.objectives.find(o => o.id === id) ?? []) : []
        return <article className="conversation-move" key={d.id} aria-label={d.label}>
          <div className="reply-heading"><strong>{d.label}</strong><span className="badge">{said ? 'Said' : isPinned ? copy.selected : d.id === state.recommendedId ? copy.recommended : 'Option'}</span></div>
          <p className="opening" ref={d.id === current?.id ? phrase : undefined} tabIndex={-1} lang={d.language}>{d.opening}</p>
          {d.continuation && <p className="continuation" lang={d.language}>{d.continuation}</p>}
          <ReplyTranslation direction={d} userLanguage={userLanguage} />
          {!said && (d.warning || isPinned && state.selected?.warning) && <p className="direction-warning" role="status">{isPinned ? state.selected?.warning ?? d.warning : d.warning}</p>}
          <div className="direction-actions">
            {isPinned ? <button disabled={readOnly || !state.selected} onClick={() => { if (state.selected) { setPending(null); void run({ action: 'suggest_release', selectionId: state.selected.id }) } }}>{copy.release}</button> : <button disabled={readOnly || d.lifecycle !== 'active'} onClick={() => choose(d)}>{copy.select}</button>}
            {(['simpler', 'shorter', 'alternative'] as const).map(transformation => <button key={transformation} disabled={readOnly || generating || working || d.lifecycle !== 'active' || said} onClick={() => { void run({ action: 'suggest_rephrase', id: d.id, version: d.version, transformation }) }}>{transformation === 'simpler' ? 'Simpler' : transformation === 'shorter' ? 'Shorter' : 'Alternative wording'}</button>)}
          </div>
          {analysis && confirmationObjectives.map(o => <ConfirmObjective key={o.id} objective={o} analysis={analysis} segments={segments} send={assistantSend} compact />)}
          {isPinned && state.selected && <p className="expression"><strong>{said ? 'Said' : copy[state.selected.expression]}</strong> · {state.selected.reason}</p>}
          <DirectionDetails direction={d} segments={segments} copy={copy} analysis={analysis} />
        </article>
      })}
      {!visible.length && <p>{state.mode === 'off' ? copy.off : state.mode === 'saved' ? copy.saved : copy.waiting}</p>}
    </div>
    {!readOnly && <button disabled={generating || working} onClick={() => { setPending(null); void run({ action: 'suggest_another' }) }}>{copy.another}</button>}
    <p className="help">Pin keeps wording visible while you speak. Pinning does not mark an objective complete.</p>
    <details className="quick-phrases"><summary>Quick phrases</summary>{quickPhrases[quickLanguage].map((text, i) => <div key={i}><small>{quickPhraseLabels[i]}</small><p lang={quickLanguage}>{text}</p>{quickLanguage !== userLanguage && <p className="alternative-translation" lang={userLanguage}>{quickPhrases[languageCode(userLanguage) || 'en'][i]}</p>}</div>)}</details>
  </div>
}
