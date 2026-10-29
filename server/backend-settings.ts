import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defaultLanguageModel } from '../shared/models'
import { supportedLanguageCodes } from '../shared/languages'

export const tasks = ['transcription', 'translation', 'brief', 'analysis', 'suggestions'] as const
export type BackendTask = typeof tasks[number]
export const providers = ['openai', 'anthropic', 'google', 'openrouter', 'local', 'deepgram', 'whisper', 'apple-speech', 'apple-translation', 'apple-foundation'] as const
export type BackendProvider = typeof providers[number]
export interface Capabilities {
  languages?: string[]
  contextWindow?: number
  maxTokens?: number
  structured?: 'tools' | 'json' | 'none'
  streaming?: boolean
  incremental?: boolean
}
export interface BackendConnection {
  provider: BackendProvider
  model?: string
  endpoint?: string
  credentialEnv?: string
  capabilities?: Capabilities
}
export interface BackendSettings { version: 1; connections: Record<string, BackendConnection>; tasks: Record<BackendTask, string> }
export const settingsPath = () => resolve(process.env.MANT_SETTINGS_PATH ?? 'data/backend-settings.json')
export function legacySettings(): BackendSettings {
  return { version: 1, connections: {
    speech: { provider: 'openai', model: 'gpt-live-transcribe', credentialEnv: 'OPENAI_API_KEY' },
    text: { provider: 'openai', model: process.env.ANALYSIS_MODEL ?? defaultLanguageModel, credentialEnv: 'OPENAI_API_KEY' },
    suggestions: { provider: 'openai', model: process.env.SUGGEST_MODEL ?? process.env.ANALYSIS_MODEL ?? defaultLanguageModel, credentialEnv: 'OPENAI_API_KEY' },
  }, tasks: { transcription: 'speech', translation: 'text', brief: 'text', analysis: 'text', suggestions: 'suggestions' } }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const k of Object.keys(value)) if (!allowed.includes(k)) throw new Error(`${label}: unknown field ${k}. Store credential environment-variable names, never secrets.`)
}
export function parseSettings(value: unknown): BackendSettings {
  if (!object(value) || value.version !== 1 || !object(value.connections) || !object(value.tasks)) throw new Error('Backend settings require version:1, connections and tasks.')
  keys(value, ['version', 'connections', 'tasks'], 'Settings')
  keys(value.tasks, [...tasks], 'Tasks')
  for (const [id, c] of Object.entries(value.connections)) {
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(id) || !object(c) || !providers.includes(c.provider as BackendProvider)) throw new Error(`Invalid backend connection ${id}.`)
    keys(c, ['provider', 'model', 'endpoint', 'credentialEnv', 'capabilities'], id)
    if (c.model !== undefined && (typeof c.model !== 'string' || !c.model.trim() || c.model.length > 200)) throw new Error(`${id}: invalid model.`)
    if (c.credentialEnv !== undefined && (typeof c.credentialEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(c.credentialEnv))) throw new Error(`${id}: credentialEnv must be an environment-variable name.`)
    if (c.endpoint !== undefined) {
      if (typeof c.endpoint !== 'string') throw new Error(`${id}: invalid endpoint.`)
      const url = new URL(c.endpoint)
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${id}: endpoint must be an HTTP/WebSocket URL without credentials, query or fragment.`)
    }
    if (c.capabilities !== undefined) {
      if (!object(c.capabilities)) throw new Error(`${id}: invalid capabilities.`)
      keys(c.capabilities, ['languages', 'contextWindow', 'maxTokens', 'structured', 'streaming', 'incremental'], id)
      const cap = c.capabilities
      if (cap.languages !== undefined && (!Array.isArray(cap.languages) || !cap.languages.length || cap.languages.some(l => !supportedLanguageCodes.includes(l)))) throw new Error(`${id}: invalid languages.`)
      for (const k of ['contextWindow', 'maxTokens']) if (cap[k] !== undefined && (!Number.isSafeInteger(cap[k]) || Number(cap[k]) < 1)) throw new Error(`${id}: invalid ${k}.`)
      for (const k of ['streaming', 'incremental']) if (cap[k] !== undefined && typeof cap[k] !== 'boolean') throw new Error(`${id}: invalid ${k}.`)
      if (cap.structured !== undefined && !['tools', 'json', 'none'].includes(String(cap.structured))) throw new Error(`${id}: invalid structured output mode.`)
    }
  }
  for (const task of tasks) {
    const id = value.tasks[task]
    if (typeof id !== 'string' || !Object.hasOwn(value.connections, id)) throw new Error(`${task}: assign an existing backend connection.`)
    const c = value.connections[id] as unknown as BackendConnection
    if (!supportsTask(c, task)) throw new Error(`${task}: ${c.provider} is incompatible with this task.`)
    if (!c.provider.startsWith('apple-') && !c.model) throw new Error(`${id}: model is required.`)
    if (['local', 'whisper'].includes(c.provider) && !c.endpoint) throw new Error(`${id}: endpoint is required.`)
    if (task !== 'transcription' && c.capabilities?.structured === 'none' && c.provider !== 'apple-translation') throw new Error(`${task}: structured output is required.`)
  }
  return structuredClone(value) as unknown as BackendSettings
}
export function supportsTask(c: BackendConnection, task: BackendTask) {
  if (task === 'transcription') return ['openai', 'deepgram', 'whisper', 'apple-speech'].includes(c.provider) && (c.provider !== 'openai' || c.model === 'gpt-live-transcribe')
  if (c.provider === 'apple-translation') return task === 'translation'
  return ['openai', 'anthropic', 'google', 'openrouter', 'local', 'apple-foundation'].includes(c.provider) && c.model !== 'gpt-live-transcribe'
}
export function loadSettings(path = settingsPath()): BackendSettings | null {
  return existsSync(path) ? parseSettings(JSON.parse(readFileSync(path, 'utf8'))) : null
}
export async function saveSettings(settings: BackendSettings, path = settingsPath()) {
  const parsed = parseSettings(settings)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${crypto.randomUUID()}.tmp`
  await Bun.write(temp, JSON.stringify(parsed, null, 2) + '\n')
  await rename(temp, path)
}
// Configuration is fixed for the lifetime of this process. Legacy env model/key
// lookup remains lazy for existing embedders and tests.
const configured = loadSettings()
export function backendSettings() { return configured ?? legacySettings() }
export function connectionFor(task: BackendTask) {
  const settings = backendSettings(), id = settings.tasks[task]
  return { id, ...settings.connections[id]! }
}
const defaultCredentials: Partial<Record<BackendProvider, string>> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY', deepgram: 'DEEPGRAM_API_KEY' }
export function credentialName(c: BackendConnection) { return c.credentialEnv ?? defaultCredentials[c.provider] }
export function credential(c: BackendConnection) {
  const name = credentialName(c)
  if (name && !process.env[name]) throw new Error(`${c.provider}: ${name} is missing. Set it and restart the server.`)
  return name ? process.env[name]! : 'mant-local'
}
export function checkSettings(settings: BackendSettings) {
  return tasks.map(task => {
    const id = settings.tasks[task], c = settings.connections[id]!
    const env = credentialName(c)
    const issue = env && !process.env[env] ? `${env} is missing; set it and restart.` : c.provider.startsWith('apple-') && (process.platform !== 'darwin' || !existsSync(resolve(import.meta.dir, '../native/build/MantAI'))) ? 'Apple AI helper unavailable; run bun run ai:build on macOS 26+.' : undefined
    return { task, connection: id, provider: c.provider, model: c.model, location: ['local', 'whisper'].includes(c.provider) || c.provider.startsWith('apple-') ? 'local' : 'cloud', available: !issue, issue, capabilities: c.capabilities }
  })
}
