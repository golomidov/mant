import type { Evidence, Observation } from '../shared/analysis'
import type { Segment } from '../shared/protocol'
const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? []
// ASR punctuation is unstable. Match complete words while preserving numerical
// signs/operators; punctuation-only changes must not discard a spoken fact.
const normalized = (text: string) => (text.toLocaleLowerCase().match(/[+\-−]?\p{N}+(?:[.,]\p{N}+)*%?|[\p{L}\p{N}]+|[%$€£<>≤≥=]/gu) ?? []).join(' ')
export function unsupportedFragments(evidence: Evidence[], transcript: Segment[]): Evidence[] {
  const sources = evidence.map(e => transcript.find(s => s.id === e.segmentId && s.revision === e.revision)).filter((s): s is Segment => !!s && !!s.text.trim())
  if (!sources.length) return evidence
  // Empty ASR finalization packets are not conversation turns and must not
  // separate a short answer from the actual question that grounds it.
  const positions = new Map([...transcript].filter(s => s.text.trim()).sort((a, b) => a.order - b.order).map((s, index) => [s.id, index]))
  return sources.filter(s => words(s.text).length < 2 && !sources.some(q => q.order < s.order && (positions.get(s.id)! - positions.get(q.id)!) <= 2 && /[?？]/u.test(q.text) && words(q.text).length >= 3)).map(s => ({ segmentId: s.id, revision: s.revision }))
}
export function contextualQuestions(evidence: Evidence[], transcript: Segment[]): Segment[] {
  const speech = [...transcript].filter(s => s.text.trim()).sort((a, b) => a.order - b.order)
  const questions = new Map<string, Segment>()
  for (const ref of evidence) {
    const index = speech.findIndex(s => s.id === ref.segmentId && s.revision === ref.revision)
    if (index < 0 || words(speech[index]!.text).length >= 2) continue
    const question = speech.slice(Math.max(0, index - 2), index).findLast(s => /[?？]/u.test(s.text) && words(s.text).length >= 3)
    if (question) questions.set(question.id, question)
  }
  return [...questions.values()]
}
export function validateGrounding(observation: Pick<Observation, 'grounding' | 'evidence' | 'status'>, transcript: Segment[]) {
  if (!observation.grounding || observation.status === 'retracted') return
  if (!observation.grounding.quotes.length) throw new Error('Observation lacks quoted speech.')
  for (const quote of observation.grounding.quotes) {
    const segment = transcript.find(s => s.id === quote.segmentId && s.revision === quote.revision)
    if (!segment || !observation.evidence.some(e => e.segmentId === quote.segmentId && e.revision === quote.revision) || !normalized(quote.text) || !` ${normalized(segment.text)} `.includes(` ${normalized(quote.text)} `)) throw new Error('Observation quote does not match its transcript.')
  }
}
