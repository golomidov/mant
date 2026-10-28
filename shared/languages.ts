import type { Brief } from './analysis'

export const supportedLanguages = [
  { code: 'en', name: 'English' }, { code: 'it', name: 'Italian' },
  { code: 'es', name: 'Spanish' }, { code: 'fr', name: 'French' }, { code: 'de', name: 'German' },
  { code: 'ru', name: 'Russian' },
] as const
export type LanguageCode = typeof supportedLanguages[number]['code']
export const supportedLanguageCodes = supportedLanguages.map(language => language.code)
const aliases: Record<string, LanguageCode> = { english: 'en', italian: 'it', italiano: 'it', spanish: 'es', español: 'es', french: 'fr', français: 'fr', german: 'de', deutsch: 'de', russian: 'ru', русский: 'ru' }
export function languageCode(value: string | undefined): LanguageCode | '' {
  const normalized = value?.trim().toLowerCase() ?? ''
  const code = normalized.split(/[-_]/)[0]
  return supportedLanguages.some(l => l.code === code) ? code as LanguageCode : aliases[normalized] ?? ''
}
export const languageName = (value: string | undefined) => supportedLanguages.find(l => l.code === languageCode(value))?.name ?? 'Unknown'
export function languageSettings(brief: Brief, detectedLanguage?: string) {
  return { user: languageCode(brief.languages.user) || 'en', conversation: languageCode(brief.languages.call) || languageCode(detectedLanguage), automatic: !languageCode(brief.languages.call) }
}
export const recognitionLanguages = (value: string) => languageCode(value) ? [languageCode(value)] : supportedLanguages.map(l => l.code)
