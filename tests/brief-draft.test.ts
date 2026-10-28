import { afterEach, expect, test } from 'bun:test'
import { BriefDraftController } from '../src/brief-draft'
import { ConversationTracker } from '../server/tracking'
import { briefWithPeople, emptyBrief, type AssistantAction, type Brief } from '../shared/analysis'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(dispose => dispose()))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(options: { holdFirst?: Promise<void>; fail?: () => boolean; delay?: number } = {}) {
  const brief = briefWithPeople(emptyBrief())
  brief.preparation = 'Discuss remote work.'
  brief.objectives = [{ id: crypto.randomUUID(), kind: 'question', description: 'What is required?', completion: 'The requirements are known.', origin: 'explicit', status: 'unexplored', evidence: [], reason: '', history: [] }]
  const requests: AssistantAction[] = []
  let built = 0
  const tracker = new ConversationTracker({ sessionId: 'preparation', brief, enabled: false, publish() {},
    interpreter: async (_mode, input) => {
      built++
      return { sessionId: input.request.sessionId, runId: input.request.runId, requestId: input.request.id,
        items: [], objectives: [{ id: 'generated', kind: 'question', description: input.brief.preparation, completion: 'Answered.', origin: 'explicit' }],
        participants: [], sides: [], languages: input.brief.languages, clarifications: [] }
    },
  })
  const controller = new BriefDraftController(tracker.state.brief, async action => {
    requests.push(structuredClone(action))
    if (options.fail?.()) throw new Error('Connection unavailable')
    if (action.action === 'brief') tracker.editBrief(action.brief, action.version)
    else if (action.action === 'extract' && 'brief' in action) await tracker.extractBrief(0, { brief: action.brief, version: action.version })
    else throw new Error('Unexpected command')
    controller.receive(tracker.state.brief) // WebSocket state can precede the HTTP response.
    const saved = structuredClone(tracker.state)
    if (requests.length === 1) await options.holdFirst
    return saved
  }, { delay: options.delay ?? 100_000 })
  cleanups.push(() => { controller.dispose(); tracker.dispose() })
  return { controller, tracker, requests, built: () => built }
}

test('leaving a saved brief idle across snapshots and reconnects sends no saves or model requests', async () => {
  const f = fixture({ delay: 5 })
  f.controller.subscribe(() => {})
  f.controller.sync(f.tracker.state.brief, true, 1)
  await Bun.sleep(20)
  f.controller.setConnected(false)
  f.controller.sync(f.tracker.state.brief, true, 2)
  f.controller.receive({ ...f.tracker.state.brief, version: f.tracker.state.brief.version + 1 })
  await Bun.sleep(20)
  expect(f.requests).toEqual([])
  expect(f.built()).toBe(0)
  expect(f.controller.state).toMatchObject({ dirty: false, saving: false, building: false })
})

test('participant, side and language edits save automatically in one coalesced request', async () => {
  const f = fixture({ delay: 5 })
  f.controller.subscribe(() => {})
  const draft = f.controller.state.draft
  f.controller.update({ languages: { ...draft.languages, user: 'ru', call: 'de' } })
  f.controller.update({ participants: draft.participants.map(p => p.id === draft.userParticipantId ? { ...p, name: 'Roman' } : p) })
  f.controller.update({ sides: draft.sides.map(s => s.id === draft.conversationSideId ? { ...s, name: 'Supplier' } : s) })
  await Bun.sleep(20)
  expect(f.requests).toHaveLength(1)
  expect(f.controller.state).toMatchObject({ dirty: false, saving: false, error: '' })
  expect(f.tracker.state.brief.languages).toMatchObject({ user: 'ru', call: 'de' })
  expect(f.tracker.state.brief.participants[0]?.name).toBe('Roman')
  expect(f.tracker.state.brief.sides.find(s => s.id === draft.conversationSideId)?.name).toBe('Supplier')
})

test('typing and changing a new participant while a save is in flight preserves the latest fields and identity', async () => {
  const gate = deferred(), f = fixture({ holdFirst: gate.promise })
  const id = crypto.randomUUID(), draft = f.controller.state.draft
  f.controller.update({ participants: [...draft.participants, { id, name: '', sideId: draft.conversationSideId! }] })
  const first = f.controller.flush()
  expect(f.controller.state.saving).toBe(true)
  f.controller.update({ participants: f.controller.state.draft.participants.map(p => p.id === id ? { ...p, name: 'Alice' } : p), answers: 'Ask for concrete dates.' })
  gate.resolve(); await first
  expect(f.controller.state.dirty).toBe(true)
  await f.controller.flush()
  expect(f.requests).toHaveLength(2)
  expect(f.tracker.state.brief.participants.find(p => p.id === id)?.name).toBe('Alice')
  expect(f.tracker.state.brief.answers).toBe('Ask for concrete dates.')
  expect(new Set(f.tracker.state.brief.participants.map(p => p.id)).size).toBe(f.tracker.state.brief.participants.length)
  expect(f.controller.state.dirty).toBe(false)
})

test('a goal edit preserves objectives across a later in-flight language edit without building', async () => {
  const gate = deferred(), f = fixture({ holdFirst: gate.promise })
  const objectives = structuredClone(f.tracker.state.brief.objectives)
  f.controller.update({ preparation: 'Discuss a different project.' })
  const first = f.controller.flush()
  f.controller.update({ languages: { ...f.controller.state.draft.languages, user: 'it' } })
  gate.resolve(); await first; await f.controller.flush()
  expect(f.tracker.state.brief.preparation).toBe('Discuss a different project.')
  expect(f.tracker.state.brief.languages.user).toBe('it')
  expect(f.tracker.state.brief.objectives).toEqual(objectives)
  expect(f.controller.state.draft.objectives).toEqual(objectives)
  expect(f.requests.map(r => r.action)).toEqual(['brief', 'brief'])
  expect(f.built()).toBe(0)
})

test('opening, saving and reconnecting a legacy brief never copies generated context into the goal', async () => {
  const brief = briefWithPeople(emptyBrief())
  brief.preparation = 'Understand:\n- Favorite singer\n- Current city'
  brief.items = [{ id: crypto.randomUUID(), category: 'purpose', text: 'Identify the favorite singer.', origin: 'explicit' }]
  const requests: AssistantAction[] = []
  const c = new BriefDraftController(brief, async action => {
    requests.push(action)
    if (action.action !== 'brief') throw new Error('Unexpected build')
    return emptyState({ ...action.brief, version: action.version + 1 })
  }, { delay: 5 })
  cleanups.push(() => c.dispose())
  c.subscribe(() => {})
  await Bun.sleep(20)
  expect(requests).toHaveLength(0)
  expect(c.state.draft.preparation).toBe(brief.preparation)
  c.update({ preparation: 'Only the city.\n  Keep my exact spacing.  ' })
  await c.flush()
  c.setConnected(false)
  c.sync({ ...c.state.draft, version: c.state.draft.version + 1 }, true, 2)
  expect(c.state.draft.preparation).toBe('Only the city.\n  Keep my exact spacing.  ')
  expect(c.state.dirty).toBe(false)
  expect(requests.map(r => r.action)).toEqual(['brief'])
})

test('Build objectives waits for a pending save and includes the newest unsent edits', async () => {
  const gate = deferred(), f = fixture({ holdFirst: gate.promise })
  f.controller.update({ preparation: 'Clarify the delivery date.' })
  const first = f.controller.flush()
  f.controller.update({ answers: 'The deadline is Friday.' })
  const build = f.controller.build()
  expect(f.built()).toBe(0)
  expect(f.controller.state.building).toBe(true)
  gate.resolve(); await Promise.all([first, build])
  expect(f.requests.map(r => r.action)).toEqual(['brief', 'extract'])
  expect(f.built()).toBe(1)
  expect(f.tracker.state.brief.answers).toBe('The deadline is Friday.')
  expect(f.tracker.state.brief.objectives[0]?.description).toBe('Clarify the delivery date.')
  expect(f.tracker.state.brief.participants.some(p => p.id === f.tracker.state.brief.userParticipantId)).toBe(true)
  expect(f.controller.state).toMatchObject({ dirty: false, saving: false, building: false })
})

test('failed automatic saves retain the draft, stop retrying, and support an explicit retry', async () => {
  let offline = true
  const f = fixture({ fail: () => offline, delay: 5 })
  f.controller.subscribe(() => {})
  f.controller.update({ answers: 'Do not lose this instruction.' })
  await f.controller.flush(); await Bun.sleep(15)
  expect(f.requests).toHaveLength(1)
  expect(f.controller.state).toMatchObject({ dirty: true, saving: false, error: 'Connection unavailable' })
  expect(f.controller.state.draft.answers).toBe('Do not lose this instruction.')
  offline = false; await f.controller.retry()
  expect(f.tracker.state.brief.answers).toBe('Do not lose this instruction.')
  expect(f.controller.state).toMatchObject({ dirty: false, error: '' })
})

test('external brief changes merge with unsaved changes rather than being overwritten', async () => {
  const f = fixture(), before = structuredClone(f.tracker.state.brief)
  f.controller.update({ answers: 'My pending instruction.', languages: { ...before.languages, call: 'de' } })
  const addedId = crypto.randomUUID()
  const external: Brief = { ...before, languages: { ...before.languages, user: 'es' }, participants: [...before.participants, { id: addedId, name: 'Alice', sideId: before.conversationSideId! }] }
  f.tracker.editBrief(external, external.version)
  f.controller.receive(f.tracker.state.brief)
  await f.controller.flush()
  expect(f.tracker.state.brief.answers).toBe('My pending instruction.')
  expect(f.tracker.state.brief.languages.user).toBe('es')
  expect(f.tracker.state.brief.languages.call).toBe('de')
  expect(f.tracker.state.brief.participants.find(p => p.id === addedId)?.name).toBe('Alice')
})

test('every editable brief has Me and an independent conversation side without guessing a named identity', () => {
  const old = emptyBrief()
  old.participants = [{ id: 'alice', name: 'Alice', sideId: null }]
  const prepared = briefWithPeople(old)
  expect(prepared.participants.find(p => p.id === prepared.userParticipantId)?.name).toBe('Me')
  expect(prepared.userParticipantId).not.toBe('alice')
  expect(briefWithPeople(prepared)).toEqual(prepared)
  const mapped = briefWithPeople(old, 'alice')
  expect(mapped.userParticipantId).toBe('alice')
  expect(mapped.participants).toHaveLength(1)
  expect(mapped.conversationSideId).not.toBe(mapped.participants[0]?.sideId)
})

test('brief identity references cannot be removed through an edit', () => {
  const f = fixture(), draft = structuredClone(f.tracker.state.brief)
  draft.participants = []
  expect(() => f.tracker.editBrief(draft, draft.version)).toThrow('your participant')
})

test('cached brief edits remain editable and durable while disconnected, then merge with the server on reconnect', async () => {
  const base = briefWithPeople(emptyBrief()), serverBrief = briefWithPeople(emptyBrief())
  serverBrief.version = 9
  serverBrief.languages.call = 'de'
  let cached: import('../src/brief-cache').BriefCache | undefined
  const requests: AssistantAction[] = []
  const c = new BriefDraftController(base, async action => {
    requests.push(action)
    if (action.action !== 'brief') throw new Error('Unexpected action')
    return { ...emptyState(action.brief), brief: { ...action.brief, version: action.version + 1 } }
  }, { connected: false, delay: 5, cache: value => { cached = structuredClone(value); return true } })
  cleanups.push(() => c.dispose())
  c.subscribe(() => {})
  c.update({ preparation: 'Prepared before the connection.', participants: c.state.draft.participants.map(p => p.id === c.state.draft.userParticipantId ? { ...p, name: 'Roman' } : p) })
  await Bun.sleep(15); await c.flush(); await c.build()
  expect(requests).toHaveLength(0)
  expect(c.state).toMatchObject({ connected: false, dirty: true, storedLocally: true })
  expect(cached?.draft.preparation).toBe('Prepared before the connection.')
  const reloaded = new BriefDraftController(base, async action => {
    requests.push(action)
    if (action.action !== 'brief') throw new Error('Unexpected action')
    return { ...emptyState(action.brief), brief: { ...action.brief, version: action.version + 1 } }
  }, { connected: false, snapshot: cached, delay: 100_000 })
  cleanups.push(() => reloaded.dispose())
  expect(reloaded.state.draft.preparation).toBe('Prepared before the connection.')
  reloaded.sync(serverBrief, true, 1)
  await reloaded.flush()
  const draft = reloaded.state.draft
  expect(requests).toHaveLength(1)
  expect(draft.participants).toHaveLength(1)
  expect(draft.participants.find(p => p.id === draft.userParticipantId)?.name).toBe('Roman')
  expect(draft.userParticipantId).toBe(serverBrief.userParticipantId)
  expect(draft.languages.call).toBe('de')
  expect(reloaded.state.dirty).toBe(false)
})

function emptyState(brief: Brief) {
  return { sessionId: 'preparation', runId: 'server', version: 0, brief, observations: [], attributions: {}, openQuestions: [], replan: { needed: false, reasons: [], version: 0 }, status: 'idle' as const, message: null, analyzedThroughMs: 0, availableThroughMs: 0, pendingSegments: 0, request: null, journalId: null }
}

test('a late save from a previous connection cannot replace edits or the restarted server version', async () => {
  const base = briefWithPeople(emptyBrief()); base.version = 40
  const gate = deferred(), requests: AssistantAction[] = []
  const c = new BriefDraftController(base, async action => {
    requests.push(action)
    if (action.action !== 'brief') throw new Error('Unexpected action')
    if (requests.length === 1) { await gate.promise; return emptyState({ ...action.brief, version: 99 }) }
    return emptyState({ ...action.brief, version: action.version + 1 })
  }, { delay: 100_000 })
  cleanups.push(() => c.dispose())
  c.sync(base, true, 1)
  c.update({ answers: 'Keep this instruction.' })
  const flight = c.flush()
  c.setConnected(false)
  c.update({ preparation: 'Edited during the restart.' })
  const restarted = { ...base, version: 0 }
  c.sync(restarted, true, 2)
  gate.resolve(); await flight; await c.flush()
  expect(c.state.draft.preparation).toBe('Edited during the restart.\n\nAdditional context\nKeep this instruction.')
  expect(c.state.draft.answers).toBe('')
  expect(requests[1]).toMatchObject({ action: 'brief', version: 0 })
  expect(c.state.draft.version).toBe(1)
  expect(c.state.dirty).toBe(false)
})

test('a newer authoritative brief clears a previous build failure after successful recovery', async () => {
  const f = fixture({ fail: () => true })
  await f.controller.build()
  expect(f.controller.state.error).toBe('Connection unavailable')
  const recovered = { ...f.tracker.state.brief, version: f.tracker.state.brief.version + 1 }
  f.controller.receive(recovered)
  expect(f.controller.state.error).toBe('')
  expect(f.controller.state.draft.version).toBe(recovered.version)
})
