import { languageCode, supportedLanguages, type LanguageCode } from './languages'
export interface TaskLanguageSupport {
  task: string
  provider: string
  languages?: string[]
  readyLanguages?: string[]
  pairs?: Record<string, string[]>
  automatic?: boolean
  issue?: string
}
export interface LanguageOptions {
  user: LanguageCode[]
  conversation: LanguageCode[]
  automatic: boolean
  excluded: { role: 'user' | 'conversation'; language: LanguageCode; reason: string }[]
  issues: string[]
}
// Reading language is independent of ASR: an English call can still be read in
// Russian when speech supports English and the text tasks support Russian.
export function languageOptions(tasks: TaskLanguageSupport[], selectedUser = 'en', selectedConversation = ''): LanguageOptions {
  const excluded: LanguageOptions['excluded'] = []
  const reason = (task: TaskLanguageSupport, code: string) => {
    if (task.languages && !task.languages.includes(code)) return `${task.task} (${task.provider}) does not support this language.`
    if (task.readyLanguages && !task.readyLanguages.includes(code)) return `${task.task} (${task.provider}) needs installed language assets.`
    return null
  }
  const user = supportedLanguages.filter(l => {
    let blocker = tasks.filter(t => t.task !== 'transcription').map(t => reason(t, l.code)).find(Boolean)
    const call = languageCode(selectedConversation), translation = tasks.find(t => t.task === 'translation')
    if (!blocker && call && call !== l.code && translation?.pairs && !translation.pairs[call]?.includes(l.code)) blocker = `translation (${translation.provider}) needs installed assets for ${supportedLanguages.find(l => l.code === call)?.name} → ${l.name}.`
    if (blocker) excluded.push({ role: 'user', language: l.code, reason: blocker })
    return !blocker
  }).map(l => l.code)
  const reading = languageCode(selectedUser) || 'en'
  const conversation = supportedLanguages.filter(l => {
    let blocker = tasks.filter(t => t.task !== 'brief').map(t => reason(t, l.code)).find(Boolean)
    const translation = tasks.find(t => t.task === 'translation')
    if (!blocker && translation?.pairs && l.code !== reading && !translation.pairs[l.code]?.includes(reading)) blocker = `translation (${translation.provider}) needs installed assets for ${l.name} → ${supportedLanguages.find(l => l.code === reading)?.name ?? reading}.`
    if (blocker) excluded.push({ role: 'conversation', language: l.code, reason: blocker })
    return !blocker
  }).map(l => l.code)
  return { user, conversation, automatic: conversation.length > 0 && tasks.find(t => t.task === 'transcription')?.automatic !== false, excluded, issues: tasks.flatMap(t => t.issue ? [`${t.task}: ${t.issue}`] : []) }
}
