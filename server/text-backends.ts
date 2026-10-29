import { createModels, createProvider, type Api, type Context, type Model, type Tool } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { googleProvider } from '@earendil-works/pi-ai/providers/google'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { languageCode } from '../shared/languages'
import { connectionFor, credential, type BackendConnection, type BackendTask } from './backend-settings'
import { measurePi } from './usage'
import { usageLedger } from './usage'
import { appleRequest } from './apple-ai'

export const provider = openaiProvider()
export const models = createModels()
for (const p of [provider, anthropicProvider(), googleProvider(), openrouterProvider()]) models.setProvider(p)
const registered = new Map<string, string>()
export function resolveText(task: Exclude<BackendTask, 'transcription'>, connection = connectionFor(task)) {
  if (['apple-foundation', 'apple-translation'].includes(connection.provider)) throw new Error(`${task}: use the Apple task adapter.`)
  const apiKey = credential(connection)
  let model: Model<Api> | undefined
  if (connection.provider === 'local') {
    const id = `mant-${connection.id}`
    model = { id: connection.model!, name: connection.model!, api: 'openai-completions', provider: id, baseUrl: connection.endpoint!, input: ['text'], reasoning: false,
      contextWindow: connection.capabilities?.contextWindow ?? 8192, maxTokens: connection.capabilities?.maxTokens ?? 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: false, maxTokensField: 'max_tokens' } }
    const signature = JSON.stringify(connection)
    if (registered.get(id) !== signature) {
      models.setProvider(createProvider({ id, baseUrl: connection.endpoint, models: [model], auth: { apiKey: { name: 'Backend environment credential', resolve: async () => ({ auth: { apiKey }, source: connection.credentialEnv ?? 'keyless local' }) } }, api: openAICompletionsApi() }))
      registered.set(id, signature)
    }
  } else {
    model = models.getModel(connection.provider, connection.model!)
    if (model && connection.endpoint) model = { ...model, baseUrl: connection.endpoint }
  }
  if (!model) throw new Error(`${task}: model ${connection.model} is not in the ${connection.provider} Pi catalog. Choose a listed model and restart.`)
  const capabilities = { structured: 'tools' as const, streaming: true, incremental: connection.provider === 'openai', ...connection.capabilities }
  if (!capabilities.streaming) throw new Error(`${task}: Pi text backends require server streaming support. Enable streaming or select another backend.`)
  if (capabilities.structured === 'none') throw new Error(`${task}: this model does not support structured output.`)
  if (capabilities.structured === 'json' && !['openai-completions', 'openai-responses'].includes(model.api)) throw new Error(`${task}: JSON-schema response mode is supported only on OpenAI-compatible endpoints. Select tools mode.`)
  model = { ...model, contextWindow: capabilities.contextWindow ?? model.contextWindow, maxTokens: capabilities.maxTokens ?? model.maxTokens }
  return { connection, apiKey, model, capabilities }
}
export function assertLanguages(connection: BackendConnection, languages: string[]) {
  const supported = connection.capabilities?.languages
  if (supported && languages.some(l => l && !supported.includes(l))) throw new Error(`${connection.provider}: unsupported task language. Update task settings; no automatic fallback is used.`)
}
// Native OpenAI payload details stay here; all other providers use Pi's
// normalized tool/context interfaces and retain application-side validation.
export function openaiPayload(payload: unknown, model: Model<Api>, tool: Tool, cache?: (payload: unknown, explicit: boolean) => unknown, native = false) {
  const explicit = 'supportsExplicitPromptCacheMode' in (model.compat ?? {}) && (model.compat as { supportsExplicitPromptCacheMode?: boolean }).supportsExplicitPromptCacheMode === true
  return { ...(cache ? cache(payload, explicit) : payload) as object,
    ...(native ? { tools: [{ type: 'function', name: tool.name, description: tool.description, parameters: strictJsonSchema(tool.parameters), strict: true }] } : {}),
    tool_choice: { type: 'function', name: tool.name }, parallel_tool_calls: false,
    ...(model.reasoning ? { reasoning: { effort: 'none' } } : {}),
    ...(!cache && explicit ? { prompt_cache_options: { mode: 'explicit', ttl: '30m' } } : {}),
  }
}
export function structuredResult(result: { stopReason: string; errorMessage?: string; content: ({ type: string; name?: string; arguments?: unknown; text?: string })[] }, tool: Tool, json = false): unknown {
  if (['error', 'aborted', 'length'].includes(result.stopReason)) throw new Error(result.errorMessage ?? `Structured output failed (${result.stopReason}).`)
  if (json) return JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join(''))
  const calls = result.content.filter(c => c.type === 'toolCall')
  if (calls.length !== 1 || calls[0]?.name !== tool.name) throw new Error(`Incompatible model response: expected one ${tool.name} tool call. Run settings -- check --probe.`)
  return calls[0].arguments
}
export function strictJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictJsonSchema)
  if (!schema || typeof schema !== 'object') return schema
  const node = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, strictJsonSchema(v)]))
  if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
    const properties = node.properties as Record<string, unknown>, required = node.required as string[] ?? []
    for (const key of Object.keys(properties)) if (!required.includes(key)) properties[key] = { anyOf: [properties[key], { type: 'null' }] }
    node.required = Object.keys(properties); node.additionalProperties = false
  }
  return node
}
function contextLanguages(context: Context) {
  const languages = new Set<string>()
  for (const message of context.messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue
    try {
      const data = JSON.parse(message.content), settings = data.languages ?? data.brief?.languages ?? {}
      for (const value of [settings.user, settings.call, settings.conversation, data.targetLanguage]) { const code = languageCode(value); if (code) languages.add(code) }
    } catch { /* Unstructured message, language unknown. */ }
  }
  return [...languages]
}
export async function completeStructured(task: Exclude<BackendTask, 'transcription'>, sessionId: string, context: Context, tool: Tool, signal: AbortSignal, maxTokens = 6500) {
  const connection = connectionFor(task)
  assertLanguages(connection, contextLanguages(context))
  if (signal.aborted) throw new Error(`${task}: cancelled.`)
  if (connection.provider === 'apple-foundation') {
    const finish = usageLedger.local(sessionId, task === 'analysis' ? 'TRACK' : task === 'brief' ? 'BRIEF' : task === 'translation' ? 'TRANSLATE' : 'SUGGEST')
    try { const result = await appleRequest({ action: 'generate', prompt: JSON.stringify(context), schema: tool.parameters, languages: contextLanguages(context) }, signal); finish(true); return result } finally { finish(false) }
  }
  const { model, apiKey, capabilities } = resolveText(task)
  const json = capabilities.structured === 'json'
  if (signal.aborted) throw new Error(`${task}: cancelled.`)
  const result = await measurePi(sessionId, task === 'analysis' ? 'TRACK' : task === 'brief' ? 'BRIEF' : task === 'translation' ? 'TRANSLATE' : 'SUGGEST', () => models.complete(model, {
    ...context, tools: json ? undefined : [{ ...tool, constrainedSampling: undefined }],
  }, { apiKey, signal, maxTokens: Math.min(maxTokens, model.maxTokens), maxRetries: 0, timeoutMs: 45_000,
    ...(json ? { onPayload: (payload: unknown) => {
      const response_format = { type: 'json_schema', json_schema: { name: tool.name, strict: true, schema: strictJsonSchema(tool.parameters) } }
      return model.api === 'openai-responses' ? { ...payload as object, text: { format: { type: 'json_schema', name: tool.name, strict: true, schema: strictJsonSchema(tool.parameters) } } } : { ...payload as object, response_format }
    } } : {}),
  }))
  if (signal.aborted) throw new Error(`${task}: cancelled.`)
  return structuredResult(result, tool, json)
}
