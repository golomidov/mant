import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { legacySettings, parseSettings, saveSettings, loadSettings, checkSettings, credential } from '../server/backend-settings'
import { resolveText, structuredResult } from '../server/text-backends'
import { Type } from '@earendil-works/pi-ai'
import { safeMessage } from '../server/errors'

test('legacy settings preserve all existing task model choices', () => {
  const settings = parseSettings(legacySettings())
  expect(settings.tasks).toMatchObject({ transcription: 'speech', translation: 'text', brief: 'text', analysis: 'text', suggestions: 'suggestions' })
  expect(settings.connections.text!.model).toBe(process.env.ANALYSIS_MODEL ?? 'gpt-6-luna')
})
test('fully local configuration supports independent task assignments without an OpenAI credential', () => {
  const settings = legacySettings()
  settings.connections = { whisper: { provider: 'whisper', model: 'multilingual', endpoint: 'http://127.0.0.1:8080/inference' }, gemma: { provider: 'local', model: 'gemma', endpoint: 'http://127.0.0.1:1234/v1', capabilities: { structured: 'json', contextWindow: 8192 } } }
  settings.tasks = { transcription: 'whisper', translation: 'gemma', brief: 'gemma', analysis: 'gemma', suggestions: 'gemma' }
  expect(checkSettings(parseSettings(settings)).every(c => c.available)).toBe(true)
  expect(credential(settings.connections.gemma!)).toBe('mant-local')
  const resolved = resolveText('translation', { id: 'gemma', ...settings.connections.gemma! })
  expect(resolved.model.provider).toBe('mant-gemma'); expect(resolved.model.contextWindow).toBe(8192)
  expect(resolved.model.cost.input).toBe(0)
})
test('settings reject secrets, unknown fields, unsupported schemas and incompatible task bindings', () => {
  const invalid: ((s: ReturnType<typeof legacySettings>) => void)[] = [
    s => { s.version = 2 as 1 }, s => { s.tasks.analysis = 'missing' },
    s => { s.connections.text!.credentialEnv = 'sk-secret-value' },
    s => { Object.assign(s.connections.text!, { apiKey: 'secret' }) },
    s => { s.connections.text!.endpoint = 'https://user:password@example.com/v1' },
    s => { s.connections.text!.endpoint = 'https://example.com/v1?api_key=secret' },
    s => { s.connections.text!.capabilities = { structured: 'none' } },
    s => { s.connections.text!.capabilities = { contextWindow: -1 } },
    s => { s.connections.text!.capabilities = { languages: ['xx'] } },
    s => { s.tasks.suggestions = 'speech' },
    s => { s.connections.text!.provider = 'apple-translation' },
  ]
  for (const mutate of invalid) { const s = legacySettings(); mutate(s); expect(() => parseSettings(s)).toThrow() }
})
test('settings atomically round-trip environment references and leave existing files intact after invalid saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mant-settings-')), path = join(dir, 'settings.json')
  try {
    const s = legacySettings(); await saveSettings(s, path)
    expect(loadSettings(path)).toEqual(s)
    const before = await Bun.file(path).text()
    s.connections.text!.credentialEnv = 'not-a-secret-name'
    await expect(saveSettings(s, path)).rejects.toThrow()
    expect(await Bun.file(path).text()).toBe(before)
    expect(loadSettings(join(dir, 'missing.json'))).toBeNull()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('structured adapters reject multiple tools, wrong tools, malformed JSON and truncated output', () => {
  const tool = { name: 'required', description: '', parameters: Type.Object({}) }
  for (const content of [[], [{ type: 'toolCall', name: 'other' }], [{ type: 'toolCall', name: 'required' }, { type: 'toolCall', name: 'required' }]]) expect(() => structuredResult({ stopReason: 'toolUse', content }, tool)).toThrow()
  expect(() => structuredResult({ stopReason: 'length', content: [] }, tool)).toThrow()
  expect(() => structuredResult({ stopReason: 'stop', content: [{ type: 'text', text: '{bad' }] }, tool, true)).toThrow()
})
test('provider credentials are redacted from errors', () => {
  process.env.MANT_TEST_PROVIDER_TOKEN = 'test-private-provider-value'
  try { expect(safeMessage('failed test-private-provider-value')).not.toContain('test-private-provider-value') } finally { delete process.env.MANT_TEST_PROVIDER_TOKEN }
})

test('backend capability overrides reject unsupported languages and nonstreaming Pi servers', async () => {
  const { assertLanguages } = await import('../server/text-backends')
  expect(() => assertLanguages({ provider: 'local', capabilities: { languages: ['en', 'it'] } }, ['ru'])).toThrow('unsupported task language')
  expect(() => resolveText('analysis', { id: 'no-stream', provider: 'local', model: 'test', endpoint: 'http://localhost:1234/v1', capabilities: { streaming: false } })).toThrow('streaming support')
})
