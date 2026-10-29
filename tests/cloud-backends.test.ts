import { expect, test } from 'bun:test'
import { models, resolveText } from '../server/text-backends'
import { Type } from '@earendil-works/pi-ai'
for (const provider of ['anthropic', 'google', 'openrouter'] as const) test(`${provider} uses Pi's native tool formatting without OpenAI response overrides`, async () => {
  const catalog = models.getModels(provider), modelId = catalog.find(m => !m.reasoning)?.id ?? catalog[0]!.id
  process.env.MANT_TEST_TEXT_KEY = 'test-only-provider-key'
  try {
    const { model, apiKey } = resolveText('brief', { id: 'test', provider, model: modelId, credentialEnv: 'MANT_TEST_TEXT_KEY' })
    let payload: Record<string, unknown> | undefined
    await models.complete(model, { messages: [{ role: 'user', content: 'Return a result.', timestamp: 0 }], tools: [{ name: 'propose_state', description: 'Result', parameters: Type.Object({ text: Type.String() }) }] }, { apiKey, maxRetries: 0, onPayload: value => { payload = value as Record<string, unknown>; throw new Error('Stop before network') } })
    expect(payload).toBeDefined()
    expect(payload!.parallel_tool_calls).toBeUndefined(); expect(payload!.reasoning).toBeUndefined(); expect(payload!.prompt_cache_options).toBeUndefined()
    expect(JSON.stringify(payload)).toContain('propose_state')
  } finally { delete process.env.MANT_TEST_TEXT_KEY }
})
