import { expect, test } from 'bun:test'
import { connectToServer, connectionTimeoutMs, reconnectDelayMs } from '../src/connection'
import type { ConnectionState } from '../src/connection'
import type { ServerEvent } from '../shared/protocol'

class TestSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  close() { this.closed = true }
  snapshot(seq = 1) { this.onmessage?.({ data: JSON.stringify({ type: 'snapshot', session: null, segments: [], sessionId: null, seq }) }) }
}
function fixture() {
  let now = 0
  const scheduled = new Set<{ at: number; callback(): void }>()
  const sockets: TestSocket[] = [], states: ConnectionState[] = [], messages: ServerEvent[] = []
  let invalid = 0, disconnected = 0
  const dispose = connectToServer({ url: 'ws://localhost/ws',
    socket: () => { const socket = new TestSocket(); sockets.push(socket); return socket as unknown as WebSocket },
    schedule: (callback, delay) => { const task = { at: now + delay, callback }; scheduled.add(task); return () => { scheduled.delete(task) } },
    onSocket() {}, onState: state => states.push(state), onMessage: message => messages.push(message),
    onInvalidMessage: () => { invalid++ }, onDisconnect: () => { disconnected++ },
  })
  function advance(ms: number) {
    const through = now + ms
    while (true) {
      const task = [...scheduled].filter(task => task.at <= through).sort((a, b) => a.at - b.at)[0]
      if (!task) break
      scheduled.delete(task); now = task.at; task.callback()
    }
    now = through
  }
  return { sockets, states, messages, advance, dispose, invalid: () => invalid, disconnected: () => disconnected }
}

test('a stalled handshake is replaced after two seconds rather than waiting for the browser timeout', () => {
  const f = fixture()
  expect(connectionTimeoutMs).toBe(2000)
  f.advance(connectionTimeoutMs - 1); expect(f.sockets).toHaveLength(1)
  f.advance(1); expect(f.sockets[0]!.closed).toBe(true)
  expect(f.states.at(-1)).toBe('Reconnecting')
  f.advance(reconnectDelayMs); expect(f.sockets).toHaveLength(2)
  f.sockets[1]!.snapshot()
  expect(f.states.at(-1)).toBe('Connected')
  f.advance(60_000); expect(f.sockets).toHaveLength(2)
  f.dispose()
})

test('a handshake reports Connected immediately; a missing snapshot still retries and rejects stale sockets', () => {
  const f = fixture(), old = f.sockets[0]!
  const late = old.onmessage!
  old.onopen?.()
  expect(f.states.at(-1)).toBe('Connected')
  expect(f.messages).toEqual([])
  f.advance(connectionTimeoutMs + reconnectDelayMs)
  f.sockets[1]!.snapshot(2)
  late({ data: JSON.stringify({ type: 'snapshot', session: null, segments: [], seq: 999, sessionId: null }) })
  expect(f.messages.map(message => message.seq)).toEqual([2])
  f.dispose()
})

test('restart and connection errors retry promptly without waiting for a close event; disposal cancels all retries', () => {
  const f = fixture()
  f.sockets[0]!.snapshot()
  f.sockets[0]!.onerror?.()
  expect(f.disconnected()).toBe(1)
  expect(f.sockets[0]!.onclose).toBeNull()
  f.advance(reconnectDelayMs)
  expect(f.sockets).toHaveLength(2)
  f.sockets[1]!.snapshot(1) // server sequence restarts
  expect(f.messages.map(message => message.seq)).toEqual([1, 1])
  f.sockets[1]!.onclose?.()
  f.dispose(); f.advance(60_000)
  expect(f.sockets).toHaveLength(2)
})

test('malformed messages never mark an unready connection as connected', () => {
  const f = fixture()
  f.sockets[0]!.onmessage?.({ data: 'null' })
  f.sockets[0]!.onmessage?.({ data: 'not json' })
  expect(f.invalid()).toBe(2)
  expect(f.states.at(-1)).toBe('Connecting')
  f.dispose(); f.advance(60_000)
  expect(f.sockets).toHaveLength(1)
})
