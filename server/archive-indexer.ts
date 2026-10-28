import { stat } from 'node:fs/promises'
import type { SavedTranscript } from '../shared/protocol'
import { diagnostic } from './diagnostics'

type Index = Omit<SavedTranscript, 'audioAvailable'>
/** Archive scanning is CPU work; never run it on the audio event loop. */
class ArchiveIndexer {
  private worker = new Worker(new URL('./archive-index-worker.ts', import.meta.url).href, { ref: false })
  private pending = new Map<number, { resolve(value: Index): void; reject(error: Error): void }>()
  private cache = new Map<string, { key: string; value: Index }>()
  private flights = new Map<string, Promise<Index>>()
  private next = 0
  constructor() {
    this.worker.onmessage = event => {
      const { id, value, error } = event.data as { id: number; value: Index; error?: string }
      const task = this.pending.get(id)
      if (!task) return
      this.pending.delete(id)
      if (error) task.reject(new Error(error)); else task.resolve(value)
      if (!this.pending.size) this.worker.unref()
    }
    this.worker.onerror = () => {
      for (const task of this.pending.values()) task.reject(new Error('Saved-call indexing failed. Refresh sources to retry.'))
      this.pending.clear(); this.flights.clear(); this.worker.terminate(); indexer = undefined
    }
  }
  async read(id: string, path: string): Promise<Index> {
    const info = await stat(path).catch(() => { throw new Error("Saved transcript not found. Import the JSONL file again.") })
    const key = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    const cached = this.cache.get(path)
    if (cached?.key === key) return structuredClone(cached.value)
    const flightKey = `${path}:${key}`
    const previous = this.flights.get(flightKey)
    if (previous) return structuredClone(await previous)
    const requestId = crypto.randomUUID(), started = performance.now()
    diagnostic('start', { archiveId: id, workType: 'archive-index', requestId })
    const flight = new Promise<Index>((resolve, reject) => {
      const taskId = ++this.next
      this.pending.set(taskId, { resolve, reject }); this.worker.ref()
      try { this.worker.postMessage({ taskId, id, path }) }
      catch { this.pending.delete(taskId); if (!this.pending.size) this.worker.unref(); reject(new Error("Saved-call indexing failed. Refresh sources to retry.")) }
    }).then(value => {
      this.cache.delete(path); this.cache.set(path, { key, value })
      while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!)
      return value
    }).finally(() => {
      this.flights.delete(flightKey)
      diagnostic('finish', { archiveId: id, workType: 'archive-index', requestId, durationMs: performance.now() - started })
    })
    this.flights.set(flightKey, flight)
    return structuredClone(await flight)
  }
}
let indexer: ArchiveIndexer | undefined
export function archiveIndex(id: string, path: string) { return (indexer ??= new ArchiveIndexer()).read(id, path) }
