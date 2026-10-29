import * as p from '@clack/prompts'
import { backendSettings, checkSettings, loadSettings, parseSettings, providers, saveSettings, settingsPath, supportsTask, tasks, type BackendConnection, type BackendProvider } from '../server/backend-settings'
import { models } from '../server/text-backends'
import { probeSettings } from '../server/backend-probes'
import { inspectBackends } from '../server/backend-health'
import { safeMessage } from '../server/errors'

class Cancelled extends Error {}
function answer<T>(value: T): Exclude<T, symbol> { if (p.isCancel(value)) throw new Cancelled(); return value as Exclude<T, symbol> }
export async function configure(ui: typeof p = p) {
  const draft = structuredClone(loadSettings() ?? backendSettings())
  ui.intro('Mant backend settings · changes apply after restart')
  try {
    while (true) {
      const action = answer(await ui.select({ message: 'Configure backends', options: [
        { value: 'connection', label: 'Add or replace a connection' }, { value: 'assign', label: 'Assign task backends' }, { value: 'inspect', label: 'Inspect models and configuration' }, { value: 'save', label: 'Validate and save' }, { value: 'cancel', label: 'Cancel without saving' },
      ] }))
      if (action === 'cancel') throw new Cancelled()
      if (action === 'inspect') {
        ui.note(JSON.stringify(checkSettings(draft), null, 2), 'Current draft')
        const provider = answer(await ui.select({ message: 'Inspect Pi model catalog', options: ['openai', 'anthropic', 'google', 'openrouter'].map(value => ({ value, label: value })) }))
        ui.note(models.getModels(provider).map(m => `${m.id} · context ${m.contextWindow} · output ${m.maxTokens}`).join('\n'), provider)
      }
      if (action === 'connection') {
        const id = answer(await ui.text({ message: 'Connection name', validate: value => /^[a-zA-Z][\w-]{0,63}$/.test(value ?? '') ? undefined : 'Use letters, numbers, underscores or hyphens; start with a letter.' }))
        const provider = answer(await ui.select({ message: 'Provider', options: providers.map(value => ({ value, label: value })) })) as BackendProvider
        const connection: BackendConnection = { provider }
        if (!provider.startsWith('apple-')) connection.model = answer(await ui.text({ message: 'Model ID (inspect catalog for cloud models)', defaultValue: provider === 'deepgram' ? 'nova-3' : provider === 'whisper' ? 'multilingual' : provider === 'openai' ? 'gpt-6-luna' : undefined, validate: value => value?.trim() ? undefined : 'Enter a model ID.' }))
        if (['local', 'whisper'].includes(provider)) connection.endpoint = answer(await ui.text({ message: provider === 'whisper' ? 'whisper.cpp inference URL' : 'OpenAI-compatible base URL', defaultValue: provider === 'whisper' ? 'http://127.0.0.1:8080/inference' : 'http://127.0.0.1:1234/v1' }))
        if (!provider.startsWith('apple-')) {
          const env = answer(await ui.text({ message: 'Credential environment-variable name (leave empty for keyless local servers)', defaultValue: ({ openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY', deepgram: 'DEEPGRAM_API_KEY' } as Partial<Record<BackendProvider, string>>)[provider], validate: value => !value || /^[A-Z_][A-Z0-9_]*$/.test(value) ? undefined : 'Enter an environment-variable name, never a credential.' }))
          if (env) connection.credentialEnv = env
        }
        if (provider === 'local') {
          connection.capabilities = {
            structured: answer(await ui.select({ message: 'Structured output contract (verify with --probe)', options: [{ value: 'tools', label: 'Tool calls' }, { value: 'json', label: 'JSON-schema response' }] })),
            contextWindow: Number(answer(await ui.text({ message: 'Installed model context window', defaultValue: '8192', validate: v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? undefined : 'Enter a positive integer.' }))),
            maxTokens: Number(answer(await ui.text({ message: 'Maximum output tokens', defaultValue: '4096', validate: v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? undefined : 'Enter a positive integer.' }))),
          }
        }
        draft.connections[id] = connection
      }
      if (action === 'assign') {
        for (const task of tasks) {
          const options = Object.entries(draft.connections).filter(([, c]) => supportsTask(c, task)).map(([value, c]) => ({ value, label: `${value} (${c.provider} / ${c.model ?? 'system model'})` }))
          if (!options.length) { ui.log.warn(`No compatible connection for ${task}. Add one first.`); break }
          draft.tasks[task] = answer(await ui.select({ message: `${task} backend`, initialValue: draft.tasks[task], options }))
        }
      }
      if (action === 'save') {
        try { parseSettings(draft) } catch (error) { ui.log.error(safeMessage(String(error))); continue }
        ui.note(JSON.stringify(checkSettings(draft), null, 2), 'Validation (connectivity requires --probe)')
        if (!answer(await ui.confirm({ message: `Save ${settingsPath()}?`, initialValue: true }))) continue
        await saveSettings(draft); ui.outro('Saved. Restart Mant to apply settings.'); return
      }
    }
  } catch (error) { if (error instanceof Cancelled) { ui.cancel('Cancelled. Settings file unchanged.'); return } throw error }
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2).filter(a => a !== '--')
    if (args.includes('check')) {
      const settings = loadSettings() ?? backendSettings(), checks = await inspectBackends(settings)
      const probes = args.includes('--probe') ? await probeSettings(settings) : undefined
      console.log(JSON.stringify({ path: settingsPath(), legacy: loadSettings() === null, checks, probes }, null, 2))
      if (checks.some(c => !c.available) || probes?.some(p => !p.ok)) process.exitCode = 1
    } else await configure()
  } catch (error) { console.error(safeMessage(error instanceof Error ? error.message : String(error))); process.exitCode = 1 }
}
