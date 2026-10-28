import { expect, test } from 'bun:test'
import type { Segment, ServerEvent, Session } from '../shared/protocol'
import { initialState, reduceEvent } from '../src/state'

const session: Session = {
  id: 'new', source: { id: 'source', name: 'Recording', size: 20, replayId: null }, phase: 'running', mode: 'live', delay: 'minimal', message: null,
  diagnostics: { mediaMs: 0, sentMs: 0, queuedMs: 0 },
}
const segment: Segment = { sessionId: 'new', sourceId: 'source', id: 'a', order: 0, revision: 1, text: 'Hello', status: 'partial' }

test('rejects stale-session, stale-sequence and stale-revision events', () => {
  const state = reduceEvent(initialState, { type: 'snapshot', sessionId: 'new', seq: 10, session, segments: [] })
  const event: ServerEvent = { type: 'transcript', sessionId: 'new', seq: 11, segment }
  const updated = reduceEvent(state, event)
  expect(updated.segments.get('a')?.text).toBe('Hello')
  expect(reduceEvent(updated, { ...event, seq: 12, sessionId: 'old' })).toBe(updated)
  expect(reduceEvent(updated, { ...event, seq: 9 })).toBe(updated)
  expect(reduceEvent(updated, { ...event, seq: 13 })).toBe(updated)
  expect(reduceEvent(updated, { type: 'ended', sessionId: 'new', seq: 14, session: { ...session, id: 'old', phase: 'ended' } })).toBe(updated)
})

test('reconnect snapshot restores current state and accepts a restarted server sequence', () => {
  const state = reduceEvent({ ...initialState, seq: 800 }, { type: 'snapshot', sessionId: 'new', seq: 1, session, segments: [segment] })
  expect(state.seq).toBe(1)
  expect(state.order).toEqual(['a'])
  const updated = reduceEvent(state, { type: 'transcript', sessionId: 'new', seq: 2, segment: { ...segment, revision: 2, text: 'Hello there' } })
  expect(updated.order).toBe(state.order)
})

test('background sequence numbers never suppress transcript updates and reconnect snapshots retain newer state', async () => {
  const { emptyAnalysis } = await import('../shared/analysis')
  const analysis = { ...emptyAnalysis('new'), version: 3 }
  let state = reduceEvent(initialState, { type: 'snapshot', sessionId: 'new', seq: 1, session, segments: [] })
  state = reduceEvent(state, { type: 'background', sessionId: 'new', seq: 1000, analysis })
  expect(state.seq).toBe(1)
  state = reduceEvent(state, { type: 'transcript', sessionId: 'new', seq: 2, segment })
  expect(state.segments.get('a')?.text).toBe('Hello')
  state = reduceEvent(state, { type: 'background', sessionId: 'new', seq: 1001, analysis: { ...analysis, version: 1 } })
  expect(state.analysis?.version).toBe(3)
  state = reduceEvent(state, { type: 'snapshot', sessionId: 'new', seq: 4, session, segments: [segment] })
  expect(state.analysis?.version).toBe(3)
  expect(reduceEvent(state, { type: 'background', sessionId: 'old', seq: 1002, analysis })).toBe(state)
})
