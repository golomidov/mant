import { backendSettings, checkSettings, type BackendSettings } from './backend-settings'
import { resolveText } from './text-backends'
import { appleRequest } from './apple-ai'
export async function inspectBackends(settings: BackendSettings = backendSettings()) {
  const checks = checkSettings(settings)
  return Promise.all(checks.map(async check => {
    const c = settings.connections[check.connection]!
    if (!check.available) return { ...check, connectivity: 'unchecked' }
    try {
      if (c.provider.startsWith('apple-')) {
        const detail = await appleRequest({ action: 'check', engine: c.provider.slice(6), languages: [] }, AbortSignal.timeout(10_000)) as { available: boolean; issue?: string; languages?: string[]; contextWindow?: number; readyLanguages?: string[]; pairs?: Record<string, string[]> }
        return { ...check, available: detail.available, issue: detail.available ? undefined : detail.issue, capabilities: { ...c.capabilities, languages: detail.languages ? detail.languages.filter(l => !c.capabilities?.languages || c.capabilities.languages.includes(l)) : c.capabilities?.languages, contextWindow: detail.contextWindow }, detail, connectivity: 'on-device' }
      }
      if (check.task === 'transcription') return { ...check, capabilities: { languages: ['en', 'it', 'es', 'fr', 'de', 'ru'], streaming: c.provider !== 'whisper', ...(c.provider === 'whisper' ? { windowMs: 5000, overlapMs: 1000 } : {}), ...c.capabilities }, connectivity: 'unchecked' }
      const { model, capabilities } = resolveText(check.task, { id: check.connection, ...c })
      return { ...check, capabilities: { ...capabilities, contextWindow: model.contextWindow, maxTokens: model.maxTokens }, connectivity: 'unchecked' }
    } catch (error) { return { ...check, available: false, issue: error instanceof Error ? error.message : 'Backend configuration invalid.', connectivity: 'unchecked' } }
  }))
}
// Probes are explicit; health requests use a short cached local-only inspection.
let health: ReturnType<typeof inspectBackends> | undefined
let healthAt = 0
export function backendHealth() {
  if (!health || Date.now() - healthAt > 30_000) { healthAt = Date.now(); health = inspectBackends() }
  return health
}
