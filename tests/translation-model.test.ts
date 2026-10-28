import { afterEach, expect, test } from 'bun:test'
import { models } from '../server/interpretation'
import { translateSegments } from '../server/translation'
import type { Segment } from '../shared/protocol'

const original = models.complete, key = process.env.OPENAI_API_KEY, model = process.env.ANALYSIS_MODEL
afterEach(() => {
  models.complete = original
  if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key
  if (model === undefined) delete process.env.ANALYSIS_MODEL; else process.env.ANALYSIS_MODEL = model
})
const segment: Segment = { id: 'original', sessionId: 'session', sourceId: 'audio', order: 1, revision: 5, text: 'Привет.', status: 'final' }

test('translation schema stays strict and identical across batch sizes and skips transient cache writes on Luna', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-only-not-a-credential'; process.env.ANALYSIS_MODEL = 'gpt-6-luna'
  const payloads: Record<string, any>[] = []
  models.complete = ((model, context, options) => Reflect.apply(original, models, [model, context, { ...options, onPayload: async (payload: unknown) => {
    payloads.push(await options?.onPayload?.(payload, model) as Record<string, any>)
    throw new Error('Stopped before network')
  } }])) as typeof models.complete
  for (const segments of [[segment], [segment, { ...segment, id: 'second', order: 2 }]]) await expect(translateSegments({ sessionId: 'session', targetLanguage: 'en', segments }, new AbortController().signal)).rejects.toThrow()
  const tools = (payload: Record<string, any>) => payload.tools ?? payload.input.find((item: Record<string, unknown>) => item.type === 'additional_tools')?.tools
  expect(tools(payloads[0]!)).toEqual(tools(payloads[1]!))
  expect(tools(payloads[0]!)[0].strict).toBe(true)
  expect(tools(payloads[0]!)[0].parameters.additionalProperties).toBe(false)
  expect(payloads[0]!.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' })
  expect(payloads[0]!.reasoning).toEqual({ effort: 'none' })
})

test('translation rejects valid JSON carrying the wrong segment revision', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-only-not-a-credential'
  models.complete = (async () => ({ content: [{ type: 'toolCall', name: 'translate_segments', arguments: { translations: [{ segmentId: 's0', revision: 4, sourceLanguage: 'ru', text: 'Hello.' }] } }], stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })) as unknown as typeof models.complete
  await expect(translateSegments({ sessionId: 'session', targetLanguage: 'en', segments: [segment] }, new AbortController().signal)).rejects.toThrow('incomplete')
})
