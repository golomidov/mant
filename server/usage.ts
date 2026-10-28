import type { Usage } from '@earendil-works/pi-ai'

export type UsageTask = 'BRIEF' | 'TRACK' | 'TRANSLATE' | 'SUGGEST' | 'ASR'
interface Sample { input: number; output: number; cache: number; cacheRead: number; cacheWrite: number; tokens: number; usd: number; audioSeconds: number }
interface TaskTotals extends Sample { requests: number; pending: number; unreported: number }
interface Totals extends TaskTotals { tasks: Record<UsageTask, number>; byTask: Record<UsageTask, TaskTotals> }
const emptyTask = (): TaskTotals => ({ requests: 0, pending: 0, unreported: 0, input: 0, output: 0, cache: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, usd: 0, audioSeconds: 0 })
const empty = (): Totals => ({ ...emptyTask(), tasks: { BRIEF: 0, TRACK: 0, TRANSLATE: 0, SUGGEST: 0, ASR: 0 }, byTask: { BRIEF: emptyTask(), TRACK: emptyTask(), TRANSLATE: emptyTask(), SUGGEST: emptyTask(), ASR: emptyTask() } })
const finite = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0
// Public duration price checked 2026-10-22. Catalog/standard-rate estimates,
// not account invoices or negotiated rates. No token estimate is invented for ASR.
// https://developers.openai.com/api/docs/models/gpt-live-transcribe
export const liveTranscribeUsdPerMinute = 0.017
export class UsageLedger {
  private total = empty()
  private sessions = new Map<string, Totals>()
  begin(sessionId: string, task: UsageTask) {
    let session = this.sessions.get(sessionId)
    if (!session) { session = empty(); this.sessions.set(sessionId, session) }
    for (const target of [this.total, session]) target.tasks[task]++
    const targets = [this.total, session, this.total.byTask[task], session.byTask[task]]
    for (const target of targets) { target.requests++; target.pending++ }
    let finished = false
    return (sample?: Sample) => {
      if (finished) return
      finished = true
      for (const target of targets) {
        target.pending--
        if (!sample) { target.unreported++; continue }
        for (const key of ['input', 'output', 'cache', 'cacheRead', 'cacheWrite', 'tokens', 'usd', 'audioSeconds'] as const) target[key] += finite(sample[key])
      }
    }
  }
  snapshot(sessionId?: string) { return structuredClone(sessionId === undefined ? this.total : this.sessions.get(sessionId) ?? empty()) }
  pi(sessionId: string, task: Exclude<UsageTask, 'ASR'>) {
    const finish = this.begin(sessionId, task)
    return (usage?: Usage) => finish(usage ? { input: usage.input, output: usage.output, cache: usage.cacheRead + usage.cacheWrite, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, tokens: usage.totalTokens, usd: usage.cost.total, audioSeconds: 0 } : undefined)
  }
  audio(sessionId: string, seconds: number) {
    this.begin(sessionId, 'ASR')({ input: 0, output: 0, cache: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, usd: seconds / 60 * liveTranscribeUsdPerMinute, audioSeconds: seconds })
  }
}
export const usageLedger = new UsageLedger()
export async function measurePi<T extends { usage: Usage; stopReason?: string }>(sessionId: string, task: 'TRACK' | 'TRANSLATE', request: () => Promise<T>): Promise<T> {
  const finish = usageLedger.pi(sessionId, task)
  try { const result = await request(); finish((result.stopReason === 'error' || result.stopReason === 'aborted') && result.usage.totalTokens === 0 ? undefined : result.usage); return result } finally { finish() }
}
export function measurePiStream<T extends { result(): Promise<{ usage: Usage; stopReason: string }> }>(sessionId: string, task: 'BRIEF' | 'SUGGEST', request: () => T): T {
  const finish = usageLedger.pi(sessionId, task)
  try {
    const stream = request()
    void stream.result().then(result => finish((result.stopReason === 'error' || result.stopReason === 'aborted') && result.usage.totalTokens === 0 ? undefined : result.usage), () => finish())
    return stream
  } catch (error) { finish(); throw error }
}
function line(label: string, value: Totals) {
  return label + ' cumulative-requests=' + value.requests + ' (BRIEF=' + value.tasks.BRIEF + ' TRACK=' + value.tasks.TRACK + ' TRANSLATE=' + value.tasks.TRANSLATE + ' SUGGEST=' + value.tasks.SUGGEST + ' ASR=' + value.tasks.ASR + ')' +
    ' tokens=' + value.tokens + ' (in=' + value.input + ' out=' + value.output + ' cache=' + value.cache + ' cache-read=' + value.cacheRead + ' cache-write=' + value.cacheWrite + ')' +
    ' estimatedUSD=$' + value.usd.toFixed(6) + ' audio=' + value.audioSeconds.toFixed(1) + 's pending=' + value.pending + ' usage-unreported=' + value.unreported +
    ' by-task=[' + Object.entries(value.byTask).map(([task, v]) => task + ':$' + v.usd.toFixed(6) + '/in=' + v.input + '/out=' + v.output + '/cache-read=' + v.cacheRead + '/cache-write=' + v.cacheWrite + '/pending=' + v.pending + '/unreported=' + v.unreported).join(' ') + ']'
}
export function startUsageLog(currentSession: () => string | null, options: { ledger?: UsageLedger; write?: (line: string) => void; schedule?: (tick: () => void, ms: number) => () => void } = {}) {
  const ledger = options.ledger ?? usageLedger
  const write = options.write ?? console.log
  let previous = ''
  const tick = () => {
    const sessionId = currentSession()
    const total = ledger.snapshot(), session = sessionId ? ledger.snapshot(sessionId) : null
    const snapshot = JSON.stringify({ total, sessionId, session })
    if (snapshot === previous) return
    previous = snapshot
    write('[usage totals] ' + line('server-total', total) + (sessionId && session ? ' | ' + line('session=' + sessionId, session) : ' | preparation / no active conversation'))
  }
  const schedule = options.schedule ?? ((tick, ms) => { const timer = setInterval(tick, ms); return () => clearInterval(timer) })
  const stop = schedule(tick, 5000)
  return () => { stop(); tick() }
}
