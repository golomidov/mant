import { join } from 'node:path'
import { Persistence } from './persistence'

// Deliberately allowlisted: never log error messages, model content or arbitrary objects.
const fields = new Set(['sessionId', 'archiveId', 'sourceId', 'workType', 'requestId', 'queueDepth', 'oldestPendingMs', 'durationMs', 'status', 'code', 'providerRequestId', 'audioReceivedMs', 'audioSentMs', 'audioBacklogMs', 'unfinishedTurns', 'lastTranscriptMs', 'eventLoopDelayMs', 'persistenceBacklog', 'persistenceBytes', 'socketBufferedBytes', 'reason', 'dropped'])
export type Metadata = Record<string, string | number | boolean | null | undefined>
export function providerMetadata(error: unknown): Metadata {
  if (!error || typeof error !== 'object') return {}
  const e = error as Record<string, unknown>
  const result: Metadata = {}
  for (const [key, value] of Object.entries({ status: e.status ?? e.statusCode, code: e.code, providerRequestId: e.requestId ?? e.request_id })) {
    if (typeof value === 'number' || typeof value === 'string' && /^[\w.:-]{1,120}$/.test(value) && !/sk-|bearer/i.test(value)) result[key] = value
  }
  return result
}
export class DiagnosticLog {
  readonly runId = crypto.randomUUID()
  readonly path: string
  private disk: Persistence
  constructor(directory: string, options: { limit?: number; maxBytes?: number } = {}) {
    this.path = join(directory, 'diagnostics', 'events.jsonl')
    this.disk = new Persistence({ maxBytes: options.maxBytes ?? 1024 * 1024 })
    this.limit = options.limit ?? 10 * 1024 * 1024
  }
  private limit: number
  get dropped() { return this.disk.dropped }
  record(event: string, metadata: Metadata = {}) {
    try {
      const safe = Object.fromEntries(Object.entries(metadata).filter(([key, value]) => fields.has(key) && (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null || typeof value === 'string' && /^[\w .:/-]{0,180}$/.test(value) && !/sk-|bearer/i.test(value))))
      void this.disk.enqueue({ kind: 'diagnostic', path: this.path, limit: this.limit, data: JSON.stringify({ at: new Date().toISOString(), runId: this.runId, event: /^[\w-]{1,64}$/.test(event) ? event : 'invalid-event', ...safe, dropped: this.dropped }) + '\n' })
    } catch { /* Diagnostic logging is always best effort. */ }
  }
  async flush() { try { await this.disk.flush() } catch { /* Never fail the caller. */ } }
  async shutdown() { try { await this.disk.shutdown() } catch { /* Best effort. */ } }
}
let logger: DiagnosticLog | undefined
export function configureDiagnostics(log: DiagnosticLog) { logger = log }
export function diagnostic(event: string, metadata?: Metadata) { logger?.record(event, metadata) }
export function isolate(workType: string, sessionId: string, callback: () => void, failed?: () => void) {
  try { callback() } catch (error) { diagnostic('error', { sessionId, workType, ...providerMetadata(error), reason: 'callback-failed' }); try { failed?.() } catch { /* Local error only. */ } }
}

/** Deadline also settles providers which ignore abort, with late results quarantined. */
export async function deadline<T>(workType: string, sessionId: string, requestId: string, limit: number, parent: AbortSignal, run: (signal: AbortSignal) => Promise<T>, metadata: Metadata = {}): Promise<T> {
  const controller = new AbortController()
  const start = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  diagnostic('enqueue', { ...metadata, sessionId, workType, requestId })
  diagnostic('start', { ...metadata, sessionId, workType, requestId })
  try {
    return await Promise.race([
      new Promise<T>((_, reject) => {
        abort = () => { controller.abort(); diagnostic('cancel', { ...metadata, sessionId, workType, requestId }); reject(new Error('Request cancelled')) }
        if (parent.aborted) { abort(); return }
        parent.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => { controller.abort(); diagnostic('timeout', { ...metadata, sessionId, workType, requestId, durationMs: performance.now() - start }); reject(new Error('Request deadline exceeded')) }, limit)
      }),
      (async () => { if (controller.signal.aborted) throw new Error('Request cancelled'); const result = await run(controller.signal); if (controller.signal.aborted) diagnostic('stale-result', { ...metadata, sessionId, workType, requestId }); return result })(),
    ])
  } catch (error) { diagnostic('error', { ...metadata, sessionId, workType, requestId, ...providerMetadata(error) }); throw error }
  finally { clearTimeout(timer); parent.removeEventListener('abort', abort); diagnostic('finish', { ...metadata, sessionId, workType, requestId, durationMs: performance.now() - start }) }
}
