import { expect, test } from 'bun:test'
import { UsageLedger, liveTranscribeUsdPerMinute, startUsageLog } from '../server/usage'
const pi = { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150, cost: { input: .01, output: .002, cacheRead: .003, cacheWrite: 0, total: .015 } }
test('usage counts real requests per task, includes cache exactly once, and accumulates estimated USD across sessions', () => {
  const ledger = new UsageLedger(); const first = ledger.pi('one', 'TRACK'); const second = ledger.pi('two', 'SUGGEST')
  expect(ledger.snapshot()).toMatchObject({ requests: 2, pending: 2, tokens: 0 })
  first(pi); first(pi); second(pi)
  ledger.audio('one', 60)
  expect(ledger.snapshot()).toMatchObject({ requests: 3, pending: 0, tokens: 300, cache: 60, audioSeconds: 60, tasks: { TRACK: 1, SUGGEST: 1, ASR: 1 } })
  expect(ledger.snapshot().usd).toBeCloseTo(.03 + liveTranscribeUsdPerMinute)
  expect(ledger.snapshot('one').usd).toBeCloseTo(.015 + liveTranscribeUsdPerMinute)
  expect(ledger.snapshot('two').requests).toBe(1)
  expect(ledger.snapshot('one').byTask.TRACK).toMatchObject({ requests: 1, pending: 0, input: 100, output: 20, cacheRead: 30, cacheWrite: 0, usd: .015 })
  expect(ledger.snapshot('one').byTask.SUGGEST.requests).toBe(0)
  expect(ledger.snapshot('one').byTask.ASR.usd).toBeCloseTo(liveTranscribeUsdPerMinute)
  expect(Object.values(ledger.snapshot().byTask).reduce((sum, task) => sum + task.usd, 0)).toBeCloseTo(ledger.snapshot().usd)
})
test('failed or aborted unreported calls remain visible instead of being silently priced as free', () => {
  const ledger = new UsageLedger(); ledger.pi('session', 'BRIEF')()
  expect(ledger.snapshot('session')).toMatchObject({ requests: 1, pending: 0, unreported: 1, tokens: 0, usd: 0 })
  expect(ledger.snapshot('session').byTask.BRIEF).toMatchObject({ requests: 1, pending: 0, unreported: 1 })
})
test('server reporter prints changed cumulative totals without repeating idle snapshots or creating requests', () => {
  const ledger = new UsageLedger(); const lines: string[] = []; let tick!: () => void; let period = 0; let stopped = false
  const stop = startUsageLog(() => 'session', { ledger, write: line => lines.push(line), schedule: (callback, ms) => { tick = callback; period = ms; return () => { stopped = true } } })
  expect(period).toBe(5000); expect(lines).toEqual([])
  ledger.pi('session', 'TRACK')(pi); tick()
  expect(lines[0]).toContain('[usage totals]'); expect(lines[0]).toContain('server-total cumulative-requests=1'); expect(lines[0]).toContain('session=session cumulative-requests=1'); expect(lines[0]).toContain('tokens=150'); expect(lines[0]).toContain('estimatedUSD=$0.015000')
  expect(lines[0]).toContain('TRACK:$0.015000/in=100/out=20/cache-read=30/cache-write=0')
  const before = ledger.snapshot()
  tick(); tick(); tick()
  expect(lines).toHaveLength(1)
  expect(ledger.snapshot()).toEqual(before)
  ledger.pi('session', 'SUGGEST')(pi); tick(); expect(lines[1]).toContain('cumulative-requests=2')
  stop(); expect(stopped).toBe(true); expect(lines).toHaveLength(2)
})
