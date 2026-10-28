import type { ServerPayload } from '../shared/protocol'

interface Socket { getBufferedAmount(): number; send(data: string): number }
export type BackgroundPayload = Extract<ServerPayload, { type: 'analysis' | 'suggestions' | 'background' }>
/** Only replaceable state enters this queue. Each socket retains at most three updates. */
export class BackgroundDelivery<S extends Socket> {
  private pending = new Map<S, Map<string, { payload: BackgroundPayload; sessionId: string | null }>>()
  enqueue(socket: S, payload: BackgroundPayload, sessionId: string | null) {
    let rows = this.pending.get(socket)
    if (!rows) { rows = new Map(); this.pending.set(socket, rows) }
    rows.set(payload.type, { payload, sessionId })
  }
  remove(socket: S) { this.pending.delete(socket) }
  depth(socket: S) { return this.pending.get(socket)?.size ?? 0 }
  drain(sequence: () => number) {
    for (const [socket, rows] of this.pending) {
      try {
        if (socket.getBufferedAmount() > 128_000) continue
        for (const [key, row] of rows) {
          if (socket.send(JSON.stringify({ ...row.payload, sessionId: row.sessionId, seq: sequence() })) === 0) break
          rows.delete(key)
        }
      } catch { /* A failed background client cannot affect other clients. */ }
      if (!rows.size) this.pending.delete(socket)
    }
  }
}
