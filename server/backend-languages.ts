import { connectionFor } from './backend-settings'
import { backendHealth } from './backend-health'
import { languageOptions, type TaskLanguageSupport } from '../shared/backend-languages'
import { languageCode, languageName, supportedLanguageCodes } from '../shared/languages'
import type { Brief } from '../shared/analysis'

export async function backendLanguageOptions(user?: string, conversation?: string) {
  const health = await backendHealth()
  const supports: TaskLanguageSupport[] = health.map(h => {
    const detail = 'detail' in h ? h.detail as { readyLanguages?: string[]; pairs?: Record<string, string[]> } | undefined : undefined
    return { task: h.task, provider: h.provider, languages: h.provider.startsWith('apple-') && !detail ? [] : h.capabilities?.languages,
      readyLanguages: detail?.readyLanguages, pairs: detail?.pairs, automatic: h.provider !== 'apple-speech', issue: h.issue }
  })
  return languageOptions(supports, user, conversation)
}
export async function requireBackendLanguages(brief: Brief, mode: 'edit' | 'start' = 'edit', previous?: Brief) {
  const user = languageCode(brief.languages.user) || 'en', conversation = languageCode(brief.languages.call)
  const options = await backendLanguageOptions(user, brief.languages.call)
  // Old saved choices remain visible and editable. Unrelated name/goal edits
  // must not be blocked by a backend change; new choices and live starts are checked.
  if ((mode === 'start' || user !== (languageCode(previous?.languages.user) || 'en')) && !options.user.includes(user)) throw new Error(`Choose another reading language. ${languageName(user)}: ${options.excluded.find(e => e.role === 'user' && e.language === user)?.reason ?? 'Unavailable with this setup.'}`)
  if ((mode === 'start' || brief.languages.call !== previous?.languages.call) && (conversation ? !options.conversation.includes(conversation) : !options.automatic)) throw new Error(conversation ? `Choose another conversation language. ${languageName(conversation)}: ${options.excluded.find(e => e.role === 'conversation' && e.language === conversation)?.reason ?? 'Unavailable with this setup.'}` : 'Automatic recognition is unavailable with this setup. Choose a conversation language.')
}
/** Apply configured ASR language restrictions to Auto instead of requesting all six. */
export function transcriptionLanguages(languages: string[]) {
  const connection = connectionFor('transcription'), allowed = connection.capabilities?.languages ?? supportedLanguageCodes
  if (languages.length === 1) {
    if (!allowed.includes(languages[0]!)) throw new Error(`Transcription does not support ${languageName(languages[0])}. Choose another conversation language.`)
    return languages
  }
  const selected = languages.filter(l => allowed.includes(l))
  if (!selected.length) throw new Error('No transcription languages are available. Check backend settings.')
  return selected
}

export async function resolveRecognitionLanguages(brief: Brief) {
  const conversation = languageCode(brief.languages.call)
  if (conversation) return transcriptionLanguages([conversation])
  const options = await backendLanguageOptions(languageCode(brief.languages.user) || 'en')
  if (!options.automatic) throw new Error('Choose a conversation language; this setup does not support automatic recognition.')
  return transcriptionLanguages(options.conversation)
}
