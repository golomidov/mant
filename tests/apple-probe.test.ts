import { expect, test } from 'bun:test'
import { probeAppleGeneration, type AppleRequester } from '../server/apple-probe'
const extraction = (request: Record<string, unknown>) => {
  const data = JSON.parse(String(request.prompt).split('\n').at(-1)!)
  const text = data.speech as string
  return { requestId: data.requestId, revision: data.revision, speaker: text.split(' ')[0], quantity: Number((/Correction: the quantity was (\d+)/.exec(text) ?? / (\d+) units/.exec(text))![1]), accepted: !text.includes('did not accept'), evidence: text }
}
test('Apple generation probe checks fresh identities, contrasting negation and corrected numeric facts', async () => {
  const requests: Record<string, unknown>[] = []
  const result = await probeAppleGeneration((async request => { requests.push(request); return extraction(request) }) as AppleRequester)
  expect(result).toHaveLength(3)
  expect(new Set(result.map(r => r.result.requestId)).size).toBe(3)
  expect(result.map(r => r.result.accepted)).toEqual([false, true, false])
  expect(result.map(r => r.result.revision)).toEqual([3, 4, 5])
  expect(result[2]!.result.quantity).toBe(result[0]!.result.quantity + 2)
  expect(requests.every(r => JSON.stringify(r.schema).includes('accepted'))).toBe(true)
})
test('Apple generation probe rejects Hello, a stale cached response and wrong negation even with valid JSON', async () => {
  await expect(probeAppleGeneration(async () => ({ text: 'Hello' }))).rejects.toThrow()
  let cached: unknown
  await expect(probeAppleGeneration(async request => { cached ??= extraction(request); return cached })).rejects.toThrow('grounding/revision/negation')
  await expect(probeAppleGeneration(async request => ({ ...extraction(request), accepted: true }))).rejects.toThrow('grounding/revision/negation')
})
