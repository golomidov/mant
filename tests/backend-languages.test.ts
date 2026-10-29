import { expect, test } from 'bun:test'
import { languageOptions, type TaskLanguageSupport } from '../shared/backend-languages'
import { supportedLanguageCodes } from '../shared/languages'
import { transcriptionLanguages } from '../server/backend-languages'

test('speech restrictions filter conversation languages without removing supported reading languages', () => {
  const options = languageOptions([{ task: 'transcription', provider: 'apple-speech', languages: ['en', 'it'], readyLanguages: ['en', 'it'], automatic: false }], 'ru')
  expect(options.user).toContain('ru')
  expect(options.conversation).toEqual(['en', 'it'])
  expect(options.automatic).toBe(false)
  expect(options.excluded.find(e => e.role === 'conversation' && e.language === 'ru')?.reason).toContain('does not support')
})
test('text tasks intersect their language support and configured overrides, independent of provider identity', () => {
  const options = languageOptions([
    { task: 'transcription', provider: 'openai', languages: supportedLanguageCodes },
    { task: 'analysis', provider: 'apple-foundation', languages: ['en', 'it', 'de'] },
    { task: 'suggestions', provider: 'local', languages: ['en', 'it'] },
  ])
  expect(options.user).toEqual(['en', 'it']); expect(options.conversation).toEqual(['en', 'it'])
  expect(options.automatic).toBe(true)
  expect(options.excluded.some(e => e.language === 'ru' && e.reason.includes('analysis'))).toBe(true)
})
test('supported-but-missing assets and direction-specific translation pairs are excluded with reasons', () => {
  const tasks: TaskLanguageSupport[] = [
    { task: 'transcription', provider: 'apple-speech', languages: ['en', 'it', 'de'], readyLanguages: ['en', 'it'], automatic: false },
    { task: 'translation', provider: 'apple-translation', languages: ['en', 'it', 'ru'], pairs: { en: ['it'], it: ['en'], ru: [] } },
  ]
  const options = languageOptions(tasks, 'en', 'it')
  expect(options.user).toEqual(['en', 'it'])
  expect(options.conversation).toEqual(['en', 'it'])
  expect(options.excluded.find(e => e.role === 'conversation' && e.language === 'de')?.reason).toContain('assets')
  expect(options.excluded.find(e => e.role === 'user' && e.language === 'ru')?.reason).toContain('Italian → Russian')
})
test('unknown text language capabilities preserve legacy languages; empty inventory stays empty and disables Auto', () => {
  expect(languageOptions([]).user).toEqual(supportedLanguageCodes)
  const options = languageOptions([{ task: 'transcription', provider: 'apple-speech', languages: [], issue: 'Helper unavailable.' }])
  expect(options.conversation).toEqual([]); expect(options.automatic).toBe(false)
  expect(options.issues).toEqual(['transcription: Helper unavailable.'])
})
test('single explicit recognition languages remain explicit', () => {
  expect(transcriptionLanguages(['it'])).toEqual(['it'])
})
