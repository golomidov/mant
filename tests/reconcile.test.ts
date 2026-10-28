import { expect, test } from 'bun:test'
import { TranscriptState } from '../server/reconcile'

test('deltas upsert one segment, final replaces provisional text, late deltas are ignored', () => {
  const state = new TranscriptState('session', 'recording')
  state.update('a', 0, 'Buon', false)
  const [partial] = state.update('a', 0, ' giorno', false)
  expect(partial?.text).toBe('Buon giorno')
  expect(partial?.status).toBe('partial')
  const [final] = state.update('a', 0, 'Buongiorno.', true)
  expect(final?.text).toBe('Buongiorno.')
  expect(final?.revision).toBeGreaterThan(partial!.revision)
  expect(state.segments.size).toBe(1)
  expect(state.update('a', 0, ' trailing', false)).toEqual([])
})

test('audio order survives finals and commitment metadata arriving out of order', () => {
  const state = new TranscriptState('session', 'recording')
  state.update('third', 0, 'Three', true)
  state.committed('third', 'second')
  state.update('first', 0, 'One', false)
  state.committed('first', null)
  state.update('second', 1, 'Two B', true)
  state.update('second', 0, 'Two A', true)
  state.committed('second', 'first')
  state.update('first', 0, 'One.', true)
  const sorted = [...state.segments.values()].sort((a, b) => a.order - b.order)
  expect(sorted.map(segment => segment.text)).toEqual(['One.', 'Two A', 'Two B', 'Three'])
})
