import { Type, type Tool } from '@earendil-works/pi-ai'
import { tasks, credential, type BackendSettings, type BackendTask } from './backend-settings'
import { resolveText, models, structuredResult, openaiPayload, strictJsonSchema } from './text-backends'
import { appleRequest } from './apple-ai'
import { OpenAITranscription } from './transcription'
import { DeepgramTranscription } from './deepgram-transcription'
import { WindowedTranscription } from './windowed-transcription'
import { briefExtractionSchema, trackSchemaFor, validate } from './analysis-schema'
import { suggestionOutputSchema } from './suggestion-output'
import { emptyBrief } from '../shared/analysis'
import { translationSchema } from './translation'
import { safeMessage } from './errors'
function contract(task: BackendTask) {
  const identity = { sessionId: 'probe', runId: 'probe', requestId: 'probe' }
  if (task === 'brief') return { name: 'propose_state', schema: briefExtractionSchema, expected: { ...identity, items: [], objectives: [], sides: [], participants: [], languages: { call: 'en', user: 'en' }, clarifications: [] } }
  if (task === 'analysis') return { name: 'propose_state', schema: trackSchemaFor({ brief: emptyBrief(), observations: [], request: { id: 'probe', sessionId: 'probe', runId: 'probe', inputs: [] } }, true), expected: { ...identity, observations: [], objectives: [], openQuestions: [], replanReasons: [], translations: [], detectedLanguage: 'en', selectionAssessment: null } }
  if (task === 'suggestions') return { name: 'propose_directions', schema: suggestionOutputSchema, expected: { records: [{ type: 'wait', message: 'Anna did not agree to 42 units.' }] } }
  return { name: 'translate_segments', schema: translationSchema, expected: { translations: [{ segmentId: 's0', revision: 7, sourceLanguage: 'it', text: 'Anna did not agree to 42 units.' }] } }
}
export async function probeSettings(settings: BackendSettings) {
  const results = []
  for (const task of tasks) {
    const id = settings.tasks[task], connection = { id, ...settings.connections[id]! }, started = performance.now()
    try {
      const signal = AbortSignal.timeout(20_000), fixture = contract(task)
      const tool: Tool = { name: fixture.name, description: 'Representative Mant task output contract.', parameters: fixture.schema as ReturnType<typeof Type.Object> }
      const context = { systemPrompt: 'Compatibility probe: return exactly the supplied expected object using the requested tool/schema. Preserve names, numbers, negation and revisions.', messages: [{ role: 'user' as const, content: JSON.stringify({ source: 'Anna non ha accettato 42 unità.', expected: fixture.expected }), timestamp: Date.now() }] }
      if (connection.provider.startsWith('apple-')) {
        const result = await appleRequest({ action: 'check', engine: connection.provider.slice(6), languages: connection.capabilities?.languages ?? [] }, signal) as { available: boolean; issue?: string }
        if (!result.available) throw new Error(result.issue ?? 'Apple engine unavailable.')
        if (connection.provider === 'apple-foundation') validate(tool.parameters, await appleRequest({ action: 'generate', prompt: JSON.stringify(context), schema: tool.parameters, languages: ['en'] }, signal))
        else if (connection.provider === 'apple-translation') await appleRequest({ action: 'translate', text: 'Anna non ha accettato 42 unità.', targetLanguage: 'en' }, signal)
        else {
          const t = new WindowedTranscription('probe', 'probe', { update() {}, error() {} }, connection, ['en'])
          try { await t.ready(signal); await t.append(new Uint8Array(9600)); if (!await t.finish(10_000)) throw new Error('Apple Speech final draining failed.') } finally { t.close() }
        }
        results.push({ task, connection: id, ok: true, durationMs: performance.now() - started, detail: result }); continue
      }
      if (task === 'transcription') {
        credential(connection)
        let failure: Error | undefined
        const callbacks = { update: () => {}, error: (e: Error) => { failure = e } }
        const transport = connection.provider === 'openai' ? new OpenAITranscription('probe', 'probe', 'low', callbacks, undefined, ['en'], connection)
          : connection.provider === 'deepgram' ? new DeepgramTranscription('probe', 'probe', callbacks, connection, ['en'])
          : new WindowedTranscription('probe', 'probe', callbacks, connection, ['en'])
        try { await transport.ready(signal); await transport.append(new Uint8Array(9600)); if (!await transport.finish(10_000)) throw new Error('Final draining did not complete.'); if (failure) throw failure } finally { transport.close() }
      } else {
        const { model, apiKey, capabilities } = resolveText(task, connection)
        const json = capabilities.structured === 'json'
        const result = await models.complete(model, { ...context, tools: json ? undefined : [tool] }, {
          apiKey, signal, maxTokens: 1500, maxRetries: 0, timeoutMs: 15_000,
          ...(json ? { onPayload: (p: unknown) => model.api === 'openai-responses' ? { ...p as object, text: { format: { type: 'json_schema', name: tool.name, strict: true, schema: strictJsonSchema(tool.parameters) } } } : { ...p as object, response_format: { type: 'json_schema', json_schema: { name: tool.name, strict: true, schema: strictJsonSchema(tool.parameters) } } } } : connection.provider === 'openai' ? { onPayload: (p: unknown) => openaiPayload(p, model, tool, undefined, true) } : {}),
        })
        const output = validate(tool.parameters, structuredResult(result, tool, json))
        // The real task schemas exercise nested arrays/unions; exact fixtures
        // additionally check IDs, revisions, names, numbers and negation.
        if (JSON.stringify(output) !== JSON.stringify(fixture.expected) && task === 'translation') {
          const translations = (output as { translations?: { revision: number; text: string; segmentId: string }[] }).translations
          if (translations?.length !== 1 || translations[0]?.revision !== 7 || translations[0].segmentId !== 's0' || translations[0].text !== 'Anna did not agree to 42 units.') throw new Error('Translation probe failed revision, names, numbers or negation compatibility.')
        }
      }
      results.push({ task, connection: id, ok: true, durationMs: performance.now() - started })
    } catch (error) { results.push({ task, connection: id, ok: false, durationMs: performance.now() - started, issue: safeMessage(error instanceof Error ? error.message : 'Probe failed.') }) }
  }
  return results
}
