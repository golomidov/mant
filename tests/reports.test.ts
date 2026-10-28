import { expect, test } from 'bun:test'
import { ReportStore, type Report } from '../src/report-store'
const report = (id: string, severity: Report['severity'] = 'error', summary = id): Report => ({ id, severity, source: 'Test', summary })
test('priority and most recently changed report decide the summary', () => {
  const store = new ReportStore(), owner = Symbol()
  for (const severity of ['error', 'warning', 'progress', 'success'] as const) store.set(owner, report(severity, severity))
  expect(store.getSnapshot().map(r => r.id)).toEqual(['error', 'warning', 'progress', 'success'])
  store.set(owner, report('another')); expect(store.getSnapshot()[0]?.id).toBe('another')
  store.set(owner, report('error', 'error', 'Changed')); expect(store.getSnapshot()[0]?.id).toBe('error')
})
test('simultaneous failures stay independent during successful recovery', () => {
  const store = new ReportStore(), owner = Symbol()
  store.set(owner, report('save')); store.set(owner, report('translation'))
  store.set(owner, report('save', 'success', 'Saved'))
  expect(store.getSnapshot().map(r => r.id)).toEqual(['translation', 'save'])
  store.remove(owner, 'translation'); expect(store.getSnapshot()[0]?.summary).toBe('Saved')
})
test('identical polling preserves snapshot, recency, and announcement notifications', () => {
  const store = new ReportStore(), owner = Symbol(); let notifications = 0
  store.subscribe(() => notifications++)
  store.set(owner, report('discovery')); const snapshot = store.getSnapshot()
  store.set(owner, report('discovery'))
  expect(store.getSnapshot()).toBe(snapshot); expect(notifications).toBe(1)
})
test('pending actions publish once and retain the latest callback', () => {
  const store = new ReportStore(), owner = Symbol(); let called = ''
  const entry = { ...report('analysis'), action: { label: 'Retry analysis', pending: false, run() { called = 'old' } } }
  store.set(owner, entry)
  store.set(owner, { ...entry, action: { ...entry.action, run() { called = 'new' } } })
  store.getSnapshot()[0]?.action?.run(); expect(called).toBe('new')
  store.set(owner, { ...entry, action: { ...entry.action, pending: true } })
  expect(store.getSnapshot()[0]?.action?.pending).toBe(true)
})
test('session and component cleanup removes only reports owned by that component', () => {
  const store = new ReportStore(), session = Symbol(), connection = Symbol()
  store.set(session, report('analysis')); store.set(session, report('translation'))
  store.set(connection, report('connection', 'success'))
  store.remove(session)
  expect(store.getSnapshot().map(r => r.id)).toEqual(['connection'])
})
test('replacement owner keeps the latest brief save result after old component cleanup', () => {
  const store = new ReportStore(), old = Symbol(), replacement = Symbol()
  store.set(old, report('brief-save', 'success', 'Saved'))
  store.set(replacement, report('brief-save', 'success', 'Saved'))
  store.remove(old)
  expect(store.getSnapshot()[0]?.summary).toBe('Saved')
  store.remove(replacement); expect(store.getSnapshot()).toHaveLength(0)
})

test('successful session recovery clears an obsolete server error', async () => {
  const { initialState, reduceEvent } = await import('../src/state')
  const session = { id: 'recovered', source: { id: 'source', name: 'Audio', size: 0, replayId: null }, phase: 'error' as const, mode: 'live' as const, delay: 'minimal' as const, message: 'Unavailable', diagnostics: { mediaMs: 0, sentMs: 0, queuedMs: 0 } }
  const failed = reduceEvent(initialState, { type: 'snapshot', sessionId: session.id, seq: 1, session, segments: [] })
  const recovered = reduceEvent(failed, { type: 'status', sessionId: session.id, seq: 2, session: { ...session, phase: 'running', message: null } })
  expect(recovered.error).toBeNull()
})
