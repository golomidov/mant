import { ConversationTracker } from '../server/tracking'
import { SuggestionCoordinator } from '../server/suggestions'
import { briefWithPeople, emptyBrief } from '../shared/analysis'

// Explicit real-model semantic regression. Run with Bun and configured model credentials.
if (!process.argv.includes('--live')) throw new Error('Pass --live to run the configured models.')
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.')
const brief = briefWithPeople(emptyBrief())
brief.languages.user = 'en'; brief.languages.call = 'it'
brief.preparation = 'Before we start, tell them this is my first interview in Italian and my company experience has been in English.'
const tracker = new ConversationTracker({ sessionId: 'communication-smoke', brief, autoTranslate: false, windowMs: 60_000, publish() {} })
const suggestions = new SuggestionCoordinator({ sessionId: 'communication-smoke', analysis: () => tracker.state, media: () => 0, windowMs: 60_000, publish() {} })
try {
  await tracker.extractBrief()
  if (tracker.state.briefRequest?.outcome !== 'applied' || tracker.state.brief.objectives.length !== 2 || tracker.state.brief.objectives.some(o => o.kind !== 'say' || o.timing !== 'opening')) throw new Error('Expected two opening communication objectives: ' + JSON.stringify({ objectives: tracker.state.brief.objectives, error: tracker.state.briefMessage }))
  console.log('PASS: exact brief extracts two opening Things to say.')
  suggestions.analysisChanged('brief_model'); await suggestions.flush()
  if (suggestions.state.request?.outcome !== 'complete' || !suggestions.state.directions.some(d => d.language === 'it' && d.objectiveIds.length === 2 && d.basis === 'brief' && !d.evidence.length && d.translation?.language === 'en')) throw new Error('Italian brief-only opening failed: ' + JSON.stringify({ message: suggestions.state.message, directions: suggestions.state.directions }))
  console.log('PASS: Italian opening with English translation and separate brief references.')
  const opening = suggestions.state.directions[0]!
  suggestions.rephrase(opening.id, opening.version, 'shorter'); await suggestions.flush()
  if (suggestions.state.request?.outcome !== 'complete' || suggestions.state.directions[0]?.version !== opening.version + 1) throw new Error('Live rephrase failed: ' + suggestions.state.message)
  console.log('PASS: live rephrase preserves intent and references.')
  const user = tracker.state.brief.userParticipantId!
  for (const [index, text] of ['È la prima volta che faccio un colloquio in italiano.', 'Nelle aziende in cui ho lavorato ho sempre usato l’inglese.'].entries()) {
    const id = 'speech-' + index
    tracker.state.attributions[id] = { participantId: user, sideId: null, sourceLabel: 'My microphone', revision: 1 }
    tracker.ingest({ sessionId: 'communication-smoke', sourceId: 'local', id, order: index, revision: 1, status: 'final', text }, 100 * (index + 1))
    await tracker.flush()
    if (tracker.state.request?.outcome !== 'applied' || tracker.state.brief.objectives.filter(o => o.status === 'expressed').length !== index + 1) throw new Error('Semantic expression failed: ' + JSON.stringify({ message: tracker.state.message, objectives: tracker.state.brief.objectives, observations: tracker.state.observations }))
  }
  console.log('PASS: separate Italian paraphrases independently complete the English goals without pinning.')
} finally { tracker.dispose(); suggestions.dispose() }

const mixed = briefWithPeople(emptyBrief())
mixed.preparation = 'I live in Milan. Ask whether travel is required. Tell them I prefer working in English. Aim to agree on a follow-up interview.'
const mixedTracker = new ConversationTracker({ sessionId: 'mixed-smoke', brief: mixed, autoTranslate: false, enabled: false, publish() {} })
try {
  await mixedTracker.extractBrief()
  const kinds = mixedTracker.state.brief.objectives.map(o => o.kind).sort()
  if (mixedTracker.state.briefRequest?.outcome !== 'applied' || JSON.stringify(kinds) !== JSON.stringify(['outcome', 'question', 'say'])) throw new Error('Mixed brief did not distinguish communication, discovery, outcome, and background: ' + JSON.stringify(mixedTracker.state.brief.objectives))
  console.log('PASS: mixed brief separates question, communication, outcome, and background.')
} finally { mixedTracker.dispose() }
for (const [index, text] of ['Non è il mio primo colloquio in italiano e non ho mai lavorato in inglese.', 'Potrei dire «È il mio primo colloquio in italiano», ma è soltanto un esempio ipotetico.'].entries()) {
  const callBrief = structuredClone(tracker.state.brief)
  for (const o of callBrief.objectives) { o.status = 'unexplored'; o.evidence = []; o.history = [] }
  const negative = new ConversationTracker({ sessionId: 'negative-smoke', brief: callBrief, autoTranslate: false, windowMs: 60_000, publish() {} })
  negative.state.attributions.negative = { participantId: callBrief.userParticipantId!, sideId: null, sourceLabel: 'My microphone', revision: 1 }
  try {
    negative.ingest({ sessionId: 'negative-smoke', sourceId: 'local', id: 'negative', order: 0, revision: 1, text, status: 'final' }, 100)
    await negative.flush()
    if (negative.state.request?.outcome !== 'applied' || negative.state.brief.objectives.some(o => o.status === 'expressed')) throw new Error('Negation or quoted hypothetical falsely completed communication: ' + JSON.stringify(negative.state.brief.objectives))
    console.log('PASS: ' + (index === 0 ? 'negated' : 'quoted hypothetical') + ' speech does not mark the disclosure Said.')
  } finally { negative.dispose() }
}
