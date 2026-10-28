import type { ServerEvent } from '../shared/protocol'

export type ConnectionState = 'Connecting' | 'Reconnecting' | 'Connected'
type Schedule = (callback: () => void, delayMs: number) => () => void
const scheduleTimeout: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}
export const connectionTimeoutMs = 2000
export const reconnectDelayMs = 250

/** A TCP/proxy handshake can remain pending long after the local server restarts. */
export function connectToServer(options: {
  url: string
  background?: boolean
  socket?(url: string): WebSocket
  schedule?: Schedule
  onSocket(socket: WebSocket | null): void
  onState(state: ConnectionState): void
  onMessage(event: ServerEvent): void
  onDisconnect(): void
  onInvalidMessage(): void
}) {
  const schedule = options.schedule ?? scheduleTimeout
  let current: WebSocket | null = null
  let disposed = false
  let cancelDeadline: (() => void) | undefined
  let cancelRetry: (() => void) | undefined

  function retire() {
    cancelDeadline?.(); cancelDeadline = undefined
    const old = current; current = null
    options.onSocket(null)
    if (!old) return
    old.onopen = old.onmessage = old.onerror = old.onclose = null
    try { old.close() } catch { /* A failed handshake may already be closed. */ }
  }
  function retry() {
    if (disposed) return
    retire()
    options.onDisconnect(); options.onState('Reconnecting')
    cancelRetry?.()
    cancelRetry = schedule(connect, reconnectDelayMs)
  }
  function connect() {
    if (disposed) return
    cancelRetry = undefined
    let ws: WebSocket
    try { ws = options.socket?.(options.url) ?? new WebSocket(options.url) }
    catch { retry(); return }
    current = ws; options.onSocket(ws)
    // The handshake confirms connection. State events still wait for a snapshot.
    let ready = false
    cancelDeadline = schedule(() => { if (current === ws) retry() }, connectionTimeoutMs)
    ws.onopen = () => { if (!disposed && current === ws) options.onState('Connected') }
    ws.onmessage = event => {
      if (disposed || current !== ws) return
      let message: ServerEvent
      try { message = JSON.parse(String(event.data)) as ServerEvent }
      catch { options.onInvalidMessage(); return }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') { options.onInvalidMessage(); return }
      if (message.type === 'snapshot' || options.background && message.type === 'background') {
        ready = true; cancelDeadline?.(); cancelDeadline = undefined
        options.onState('Connected')
      }
      if (ready) options.onMessage(message)
    }
    ws.onerror = ws.onclose = () => { if (current === ws) retry() }
  }
  options.onState('Connecting')
  connect()
  return () => {
    disposed = true
    cancelRetry?.(); cancelRetry = undefined
    retire()
  }
}
