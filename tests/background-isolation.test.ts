import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConversationTracker } from '../server/tracking'
import { SuggestionCoordinator } from '../server/suggestions'
import { ConversationSession } from '../server/session'
import { Archives } from '../server/archive'
import { CaptureRecorder } from '../server/capture-recording'
import { Persistence } from '../server/persistence'
import { configureDiagnostics, deadline, DiagnosticLog, isolate } from '../server/diagnostics'
import { emptyBrief } from '../shared/analysis'
import type { InterpretationInput } from '../server/interpretation'
import type { Segment } from '../shared/protocol'

const temporary = () => mkdtempSync(join(tmpdir(), 'mant-isolation-'))
const segment = (sessionId: string, revision = 1): Segment => ({ sessionId, sourceId: 'a'.repeat(64), id: 'speech', revision, order: 0, status: 'partial', text: `Содержательный разговор ${revision}` })
const trackResult = (input: InterpretationInput) => ({ sessionId: input.request.sessionId, runId: input.request.runId, requestId: input.request.id, observations: [], objectives: [], openQuestions: [], replanReasons: [] })
const briefResult = (input: InterpretationInput) => ({ sessionId: input.request.sessionId, runId: input.request.runId, requestId: input.request.id, objectives: [], items: [], sides: [], participants: [], languages: { call: '' }, clarifications: [] })
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

test('unresolved background requests and throwing publications cannot stop synthetic audio or transcript revisions', async () => {
  const directory = temporary(), archives = new Archives(directory)
  const calls = { tracking: 0, brief: 0, translation: 0, suggestions: 0 }
  const signals: AbortSignal[] = []
  let tracking!: ConversationTracker, suggestions!: SuggestionCoordinator
  const brief = emptyBrief(); brief.languages.call = 'ru'; brief.languages.user = 'en'
  let revision = 0, sent = 0
  const session = new ConversationSession({ source: { id: 'a'.repeat(64), name: 'synthetic.wav', size: 9600, replayId: null }, mode: 'live', delay: 'minimal', archives,
    audio: { async *packets() { for (let n = 0; n < 10; n++) yield new Uint8Array(960) }, async close() {} },
    transport: (_id, _source, _delay, callbacks) => ({ async ready() {}, async append() { sent++; callbacks.update(segment(session.view.id, ++revision)) }, commit() {}, async finish() { return true }, close() {} }),
    emit: event => {
      if (event.type !== 'transcript') return
      isolate('tracking', session.view.id, () => tracking.ingest(event.segment, sent * 20))
      isolate('suggestions', session.view.id, () => suggestions.ingest(event.segment, sent * 20))
    },
  })
  tracking = new ConversationTracker({ sessionId: session.view.id, brief, windowMs: 1, latest: id => session.segments.get(id),
    interpreter: async (mode, _input, signal) => { calls[mode === 'BRIEF' ? 'brief' : 'tracking']++; signals.push(signal); return new Promise(() => {}) },
    translator: async (_input, signal) => { calls.translation++; signals.push(signal); return new Promise(() => {}) },
    publish() { throw new Error('publication failure') },
  })
  suggestions = new SuggestionCoordinator({ sessionId: session.view.id, mode: 'predictive', windowMs: 1, analysis: () => tracking.state, media: () => sent * 20,
    generator: async (_input, signal) => { calls.suggestions++; signals.push(signal); return new Promise(() => {}) }, publish() { throw new Error('publication failure') },
  })
  try {
    const work = session.start()
    await Bun.sleep(2)
    session.clock(0)
    void tracking.extractBrief()
    for (let n = 1; n <= 10; n++) { await Bun.sleep(20); session.clock(n * 20) }
    await work
    expect(sent).toBe(10)
    expect(session.view.phase).toBe('ended')
    expect(session.segments.get('speech')?.revision).toBe(10)
    expect(calls).toEqual({ tracking: 1, brief: 1, translation: 1, suggestions: 1 })
    expect(tracking.state.pendingSegments).toBe(1)
    tracking.dispose(); suggestions.dispose()
    expect(signals.every(signal => signal.aborted)).toBe(true)
    await Bun.sleep(1)
  } finally { tracking.dispose(); suggestions.dispose(); await session.shutdown(); await archives.shutdown(); rmSync(directory, { recursive: true, force: true }) }
})

test('deadline cancels uncooperative requests, preserves provider metadata and quarantines late results', async () => {
  const directory = temporary(), log = new DiagnosticLog(directory)
  configureDiagnostics(log)
  const held = gate<number>(); let signal!: AbortSignal
  try {
    let timedOut = false
    try { await deadline('tracking', 'session', 'request', 10, new AbortController().signal, s => { signal = s; return held.promise }) } catch { timedOut = true }
    expect(timedOut).toBe(true); expect(signal.aborted).toBe(true)
    held.resolve(42); await Bun.sleep(2)
    try { await deadline('translation', 'session', 'provider', 100, new AbortController().signal, async () => { throw Object.assign(new Error('private speech and sk-secret'), { code: 'rate_limit', status: 429, request_id: 'req-123' }) }) } catch { /* Expected. */ }
    await log.flush()
    const text = await Bun.file(log.path).text()
    expect(text).toContain('"event":"timeout"'); expect(text).toContain('"event":"stale-result"')
    expect(text).toContain('"providerRequestId":"req-123"'); expect(text).toContain('"status":429')
    expect(text).not.toContain('private speech'); expect(text).not.toContain('sk-secret')
    const rows = text.trim().split('\n').map(line => JSON.parse(line))
    expect(rows.every(row => row.runId === log.runId && row.sessionId === 'session' && row.requestId)).toBe(true)
  } finally { await log.shutdown(); rmSync(directory, { recursive: true, force: true }) }
})

test('all background deadlines retain work and stop automatic retry until an explicit retry', async () => {
  const brief = emptyBrief(); brief.languages.call = 'ru'; brief.languages.user = 'en'
  let trackingCalls = 0, translationCalls = 0, briefCalls = 0, suggestionCalls = 0
  let hang = true
  const tracker = new ConversationTracker({ sessionId: 'session', brief, windowMs: 1, requestTimeoutMs: 10, translationTimeoutMs: 10,
    interpreter: async (mode, input) => { if (mode === 'BRIEF') briefCalls++; else trackingCalls++; return hang ? new Promise(() => {}) : mode === 'BRIEF' ? briefResult(input) : trackResult(input) },
    translator: async input => { translationCalls++; return hang ? new Promise(() => {}) : input.segments.map(s => ({ segmentId: s.id, revision: s.revision, sourceLanguage: 'ru', text: 'Translated' })) }, publish() {},
  })
  const suggestions = new SuggestionCoordinator({ sessionId: 'session', mode: 'predictive', windowMs: 1, requestTimeoutMs: 10, analysis: () => tracker.state, media: () => 0,
    generator: async (input, _signal, publish) => { suggestionCalls++; if (hang) return new Promise(() => {}); publish({ sessionId: 'session', runId: input.runId, requestId: input.requestId, type: 'wait', message: 'Waiting for speech.' }) }, publish() {},
  })
  try {
    tracker.ingest(segment('session'), 20); suggestions.ingest(segment('session'), 20)
    await Promise.all([tracker.flush(), tracker.flushTranslations(), tracker.extractBrief(), suggestions.flush()])
    expect(tracker.state.status).toBe('error'); expect(tracker.state.briefStatus).toBe('error'); expect(tracker.state.translationStatus).toBe('error'); expect(suggestions.state.status).toBe('error')
    tracker.ingest(segment('session', 2), 40); suggestions.ingest(segment('session', 2), 40)
    await Bun.sleep(20)
    expect([trackingCalls, translationCalls, briefCalls, suggestionCalls]).toEqual([1, 1, 1, 1])
    expect(tracker.state.pendingSegments).toBe(1)
    hang = false
    suggestions.another()
    await Promise.all([tracker.retry(), tracker.retryTranslations(), tracker.extractBrief(), suggestions.flush()])
    await tracker.flush()
    expect(tracker.state.status).toBe('idle'); expect(tracker.state.briefStatus).toBe('idle'); expect(tracker.state.translationStatus).toBe('idle'); expect(suggestions.state.status).toBe('waiting')
    expect(tracker.state.translations?.speech?.revision).toBe(2)
  } finally { tracker.dispose(); suggestions.dispose() }
})

test('delayed persistence preserves row order and WAV timestamps while leaving the caller responsive', async () => {
  const directory = temporary(), disk = new Persistence({ delayMs: 8 }), archives = new Archives(directory, disk)
  const id = crypto.randomUUID()
  try {
    archives.create(id, { id: 'a'.repeat(64), name: 'test.wav', size: 0, replayId: null })
    const recorder = new CaptureRecorder(archives, id)
    for (let n = 1; n <= 3; n++) archives.append(id, { kind: 'transcript', atMs: n * 20, segment: segment(id, n) })
    const pcm = new Uint8Array(960); pcm[0] = 99
    recorder.add('local-microphone', 100, pcm); recorder.close(200)
    expect(disk.backlog).toBeGreaterThan(0)
    let ticked = false; setTimeout(() => { ticked = true }, 0)
    await archives.flush()
    expect(ticked).toBe(true); expect(disk.backlog).toBe(0)
    const rows = await Array.fromAsync(archives.updates(id))
    expect(rows.map(row => row.segment.revision)).toEqual([1, 2, 3])
    const wav = Buffer.from(await Bun.file(join(directory, `${id}.local-microphone.wav`)).arrayBuffer())
    expect(wav.readUInt32LE(40)).toBe(9600)
    expect(wav.subarray(44, 44 + 4800).every(b => b === 0)).toBe(true)
    expect(wav[44 + 4800]).toBe(99)
  } finally { await archives.shutdown(); rmSync(directory, { recursive: true, force: true }) }
})

test('diagnostics rotate five bounded files, redact content, drop overload and isolate disk failures', async () => {
  const directory = temporary(), log = new DiagnosticLog(directory, { limit: 600 })
  try {
    for (let n = 0; n < 40; n++) { log.record('enqueue', { sessionId: 'session', workType: 'tracking', requestId: `req-${n}`, queueDepth: n, prompt: 'PRIVATE', response: 'PRIVATE', reason: 'sk-secret' }); await log.flush() }
    const names = readdirSync(join(directory, 'diagnostics'))
    expect(names).toHaveLength(5)
    for (const name of names) { const file = Bun.file(join(directory, 'diagnostics', name)); expect(file.size).toBeLessThanOrEqual(600); expect(await file.text()).not.toContain('PRIVATE'); expect(await file.text()).not.toContain('sk-secret') }
    const bounded = new DiagnosticLog(directory, { maxBytes: 1 })
    bounded.record('error', { sessionId: 'session' }); expect(bounded.dropped).toBe(1); await bounded.shutdown()
    const badPath = join(directory, 'blocked'); await Bun.write(badPath, 'file')
    const broken = new DiagnosticLog(badPath); broken.record('error'); await broken.flush(); expect(broken.dropped).toBeGreaterThan(0); await broken.shutdown()
  } finally { await log.shutdown(); rmSync(directory, { recursive: true, force: true }) }
})

test('background congestion coalesces independently, isolates socket errors and restores the latest state', async () => {
  const { BackgroundDelivery } = await import('../server/background-delivery')
  const { emptyAnalysis } = await import('../shared/analysis')
  const delivery = new BackgroundDelivery<{ getBufferedAmount(): number; send(data: string): number }>()
  let congested = true, seq = 0
  const received: { analysis: { version: number } }[] = []
  const slow = { getBufferedAmount: () => congested ? 1_000_000 : 0, send: (data: string) => { received.push(JSON.parse(data)); return 1 } }
  const broken = { getBufferedAmount: () => 0, send() { throw new Error('Disconnected') } }
  for (let version = 0; version < 1000; version++) {
    const analysis = { ...emptyAnalysis('session'), version }
    delivery.enqueue(slow, { type: 'analysis', analysis }, 'session')
    delivery.enqueue(broken, { type: 'analysis', analysis }, 'session')
    delivery.drain(() => ++seq)
  }
  expect(delivery.depth(slow)).toBe(1); expect(received).toHaveLength(0)
  congested = false; delivery.drain(() => ++seq)
  expect(received).toHaveLength(1); expect(received[0]?.analysis.version).toBe(999)
  delivery.remove(slow)
  delivery.enqueue(slow, { type: 'background', analysis: { ...emptyAnalysis('session'), version: 1000 } }, 'session')
  delivery.drain(() => ++seq)
  expect(received.at(-1)?.analysis.version).toBe(1000)
})

test('pending writes keep Bun alive through a flush barrier, then idle workers allow exit', async () => {
  const directory = temporary()
  try {
    const module = new URL('../server/persistence.ts', import.meta.url).href
    const path = join(directory, 'exit.jsonl')
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', `import { Persistence } from ${JSON.stringify(module)}; const disk = new Persistence(); for (let n = 0; n < 100; n++) void disk.enqueue({ kind: 'append', path: ${JSON.stringify(path)}, data: n + '\\n' }); await disk.flush(); console.log('flushed');`], { stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0); expect(output).toContain('flushed')
    const rows = (await Bun.file(path).text()).trim().split('\n')
    expect(rows).toHaveLength(100); expect(rows.at(-1)).toBe('99')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
