export type PersistenceOperation =
  | { kind: 'append'; path: string; data: string; exclusive?: boolean }
  | { kind: 'open'; path: string; data: Uint8Array }
  | { kind: 'write'; path: string; data: Uint8Array; position: number }
  | { kind: 'close'; path: string; data: Uint8Array; length: number }
  | { kind: 'diagnostic'; path: string; data: string; limit: number }
  | { kind: 'barrier'; path?: string }

/** Ordered disk operations on a Bun worker. Submission never waits for disk. */
export class Persistence {
  private worker: Worker
  private next = 0
  private pending = new Map<number, { bytes: number; resolve(): void }>()
  private errors = new Map<string, Error>()
  private dead = false
  backlogBytes = 0
  dropped = 0
  onError?: (path: string, error: Error) => void
  constructor(private options: { maxBytes?: number; delayMs?: number } = {}) {
    this.worker = new Worker(new URL('./persistence-worker.ts', import.meta.url).href, { ref: false })
    this.worker.onmessage = event => {
      const { id, error } = event.data as { id: number; error?: string }
      const entry = this.pending.get(id)
      if (!entry) return
      if (error) { this.dropped++; this.report(this.paths.get(id) ?? '', new Error(error)) }
      this.pending.delete(id); this.paths.delete(id); this.backlogBytes -= entry.bytes; entry.resolve()
      if (!this.pending.size) this.worker.unref()
    }
    this.worker.onerror = () => {
      this.dead = true
      this.report('', new Error('Persistence worker failed'))
      for (const entry of this.pending.values()) entry.resolve()
      this.pending.clear(); this.paths.clear(); this.backlogBytes = 0
    }
  }
  private paths = new Map<number, string>()
  private report(path: string, error: Error) {
    this.errors.set(path, error)
    try { this.onError?.(path, error) } catch { /* Error reporting cannot fail a session. */ }
  }
  get backlog() { return this.pending.size }
  enqueue(operation: PersistenceOperation): Promise<void> {
    const bytes = 'data' in operation ? typeof operation.data === 'string' ? Buffer.byteLength(operation.data) : operation.data.byteLength : 0
    if (this.dead || this.backlogBytes + bytes > (this.options.maxBytes ?? 64 * 1024 * 1024) || this.pending.size >= 16384 && operation.kind !== 'barrier') {
      this.dropped++; this.report(operation.path ?? '', new Error('Persistence queue unavailable')); return Promise.resolve()
    }
    const id = ++this.next
    this.backlogBytes += bytes
    return new Promise(resolve => {
      this.pending.set(id, { bytes, resolve }); this.paths.set(id, operation.path ?? ''); this.worker.ref()
      try { this.worker.postMessage({ id, operation, delayMs: this.options.delayMs ?? 0 }) }
      catch { this.report(operation.path ?? '', new Error('Persistence submission failed')); this.pending.delete(id); this.paths.delete(id); this.backlogBytes -= bytes; if (!this.pending.size) this.worker.unref(); resolve() }
    })
  }
  async flush(path?: string) {
    await this.enqueue({ kind: 'barrier', path })
    const error = this.errors.get('') ?? (path ? this.errors.get(path) : this.errors.values().next().value)
    if (error) throw error
  }
  async shutdown() { try { await this.flush() } finally { this.dead = true; this.worker.terminate() } }
}
const stores = new Map<string, Persistence>()
export function persistenceFor(directory: string) {
  let store = stores.get(directory)
  if (!store) { store = new Persistence(); stores.set(directory, store) }
  return store
}
