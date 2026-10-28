import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ActivityGate, CaptureAudioSource, CaptureFrameParser } from '../server/capture-audio'
import { CaptureRecorder, capturePlaceholder } from '../server/capture-recording'
import { NativeCaptureSession } from '../server/native-capture'
import { Archives } from '../server/archive'
import { TranscriptReplay } from '../server/replay'
import { parseCaptureSelection, type CaptureFrame, type CaptureRecording, type CaptureSourceId } from '../shared/capture'
import type { ServerPayload, Segment } from '../shared/protocol'
import type { TransportCallbacks } from '../server/transcription'
import { initialState, reduceEvent } from '../src/state'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })
function storage() {
  const directory = mkdtempSync(join(tmpdir(), 'mant-capture-test-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  return new Archives(directory)
}
const selection = { microphoneId: 'physical', remote: { kind: 'application' as const, bundleId: 'test.call' }, localParticipantId: null }
const metadata = (diagnostic = false): CaptureRecording => ({ selection, separation: 'user-verified', diagnostic, tracks: [], clock: 'host-monotonic', callTransmission: 'unknown' })
function pcm(speech: boolean, length = 960) {
  const bytes = Buffer.alloc(length)
  if (speech) for (let n = 0; n < length; n += 2) bytes.writeInt16LE(5000, n)
  return bytes
}
function frame(sourceId: CaptureSourceId, sequence = 0, captureMs = 10_000): CaptureFrame {
  return { type: 'audio', sourceId, sequence, captureMs, sampleRate: 24000, channels: 1, format: 'pcm_s16le', frames: 480 }
}
function encode(header: object, audio = new Uint8Array()) {
  const json = Buffer.from(JSON.stringify(header)), sizes = Buffer.alloc(8)
  sizes.writeUInt32LE(json.length); sizes.writeUInt32LE(audio.length, 4)
  return Buffer.concat([sizes, json, audio])
}
async function waitFor(check: () => boolean) {
  const limit = performance.now() + 3000
  while (!check()) { if (performance.now() > limit) throw new Error('Capture fixture timed out'); await Bun.sleep(1) }
}

test('framed binary IPC handles every byte boundary and coalesced control/audio frames without mixing sources', () => {
  const bytes = Buffer.concat([encode({ type: 'ready', clockMs: 10_000 }), encode(frame('local-microphone'), pcm(true)), encode(frame('remote-playback'), pcm(false))])
  const parser = new CaptureFrameParser(), results: { type: string; audio: Uint8Array }[] = []
  for (const byte of bytes) parser.push(Uint8Array.of(byte), (header, audio) => results.push({ type: header.type, audio: new Uint8Array(audio) }))
  parser.finish()
  expect(results.map(r => r.type)).toEqual(['ready', 'audio', 'audio'])
  expect(results[1]!.audio).toEqual(pcm(true)); expect(results[2]!.audio).toEqual(pcm(false))
  expect(() => new CaptureFrameParser().push(encode({ ...frame('local-microphone'), sampleRate: 48000 }, pcm(true)), () => {})).toThrow('metadata')
  const short = new CaptureFrameParser(); short.push(bytes.subarray(0, 15), () => {})
  expect(() => short.finish()).toThrow('inside a frame')
  const bad = Buffer.alloc(8); bad.writeUInt32LE(20_000)
  expect(() => new CaptureFrameParser().push(bad, () => {})).toThrow('length')
})

test('independent activity gates send nothing during silence, preserve 200ms onset and stop after a bounded tail', () => {
  const local = new ActivityGate(), remote = new ActivityGate()
  for (let i = 0; i < 500; i++) {
    const packet = { pcm: pcm(false), startMs: i * 20, endMs: i * 20 + 20 }
    expect(local.push(packet).packets).toHaveLength(0)
    expect(remote.push(packet).packets).toHaveLength(0)
  }
  const onset = local.push({ pcm: pcm(true), startMs: 10_000, endMs: 10_020 })
  expect(onset.packets).toHaveLength(11)
  expect(onset.packets[0]!.startMs).toBe(9800)
  expect(remote.push({ pcm: pcm(false), startMs: 10_000, endMs: 10_020 }).packets).toHaveLength(0)
  let commits = 0, sent = 0
  for (let i = 0; i < 100; i++) {
    const result = local.push({ pcm: pcm(false), startMs: 10_020 + i * 20, endMs: 10_040 + i * 20 })
    sent += result.packets.length; commits += Number(result.commit)
  }
  expect(commits).toBe(1); expect(sent).toBe(30)
  expect(local.push({ pcm: pcm(true), startMs: 13_000, endMs: 13_020 }).packets).toHaveLength(11)
  expect(remote.push({ pcm: pcm(true), startMs: 13_000, endMs: 13_020 }).packets.length).toBeGreaterThan(0)
})

test('native AudioSource bounds queued and in-flight PCM and closes an idle iterator', async () => {
  const audio = new CaptureAudioSource(), controller = new AbortController()
  audio.push(new Uint8Array(48_000), 0)
  expect(() => audio.push(pcm(false), 1000)).toThrow('one second')
  const iterator = audio.packets(controller.signal)
  expect((await iterator.next()).value?.length).toBe(48_000)
  expect(audio.queuedBytes).toBe(48_000)
  const waiting = iterator.next()
  await audio.close()
  expect((await waiting).done).toBe(true); expect(audio.queuedBytes).toBe(0)
})

test('source selection rejects using one device for both logical sources', () => {
  expect(() => parseCaptureSelection({ microphoneId: 'same', localParticipantId: null, remote: { kind: 'input', deviceId: 'same' } })).toThrow('separate')
  expect(parseCaptureSelection(selection)).toEqual(selection)
})

test.skipIf(!Bun.which('ffmpeg'))('separate WAVs retain silence gaps and overlap; saved replay/import retain both source identities', async () => {
  const archives = storage(), id = crypto.randomUUID(), source = capturePlaceholder(metadata())
  archives.create(id, source)
  const recorder = new CaptureRecorder(archives, id)
  recorder.add('local-microphone', 0, pcm(true)); recorder.add('local-microphone', 100, pcm(true))
  recorder.add('remote-playback', 0, pcm(true))
  const final = await recorder.save(source, 150)
  expect(final.capture!.tracks).toHaveLength(2)
  const local = await archives.audio(final.capture!.tracks[0]!.audioId)
  const bytes = Buffer.from(await Bun.file(local!.path).arrayBuffer())
  expect(bytes.readUInt32LE(40)).toBe(7200)
  expect(bytes.subarray(44 + 960, 44 + 4800).every(b => b === 0)).toBe(true)
  expect(bytes.readInt16LE(44 + 4800)).toBe(5000)
  const segment = (sourceId: CaptureSourceId, order: number, start: number): Segment => ({ sessionId: id, sourceId, id: sourceId, order, revision: 1, text: 'Spoken audio.', status: 'final', capture: { startMs: start, endMs: start + 20, separation: 'user-verified', callTransmission: 'unknown' } })
  archives.append(id, { kind: 'transcript', atMs: 10, segment: segment('remote-playback', 200, 10) })
  archives.append(id, { kind: 'transcript', atMs: 20, segment: segment('local-microphone', 0, 0) })
  archives.append(id, { kind: 'capture', event: 'gap', atMs: 30, detail: '80ms missing', sourceId: 'local-microphone' })
  archives.append(id, { kind: 'capture', event: 'finalized', atMs: 150, detail: 'Saved', source: final })
  archives.append(id, { kind: 'end', atMs: 150, complete: true })
  const saved = await archives.get(id)
  expect(saved.audioAvailable).toBe(true); expect(saved.source.id).toBe(final.id); expect(saved.durationMs).toBe(150)
  expect((await archives.recordings()).some(recording => recording.id === final.id)).toBe(false)
  await archives.flush(id)
  const imported = await archives.import(Bun.file(archives.path(id)).stream())
  expect(imported.source.capture!.tracks).toEqual(final.capture!.tracks)
  const events: ServerPayload[] = []
  const replay = new TranscriptReplay(imported, archives, 10, payload => events.push(payload))
  const work = replay.start(); cleanup.push(() => replay.shutdown())
  await waitFor(() => replay.view.phase === 'ready'); replay.clock(0); await Bun.sleep(20); replay.clock(150); await work
  const transcript = events.filter(e => e.type === 'transcript')
  expect(transcript.map(e => e.segment.sourceId)).toEqual(['remote-playback', 'local-microphone'])
  let view = reduceEvent(initialState, { type: 'snapshot', sessionId: replay.view.id, seq: 1, session: replay.view, segments: [] })
  for (const [i, event] of transcript.entries()) view = reduceEvent(view, { ...event, sessionId: replay.view.id, seq: i + 2 })
  expect(view.order).toEqual(['local-microphone', 'remote-playback']) // capture time, not arrival
})


// A framed synthetic helper tests process lifetime and orchestration, without
// opening microphones, screen permissions, provider sockets or actual calls.
async function nativeFixture(finalDelayMs = 0) {
  const archives = storage(), callbacks = new Map<CaptureSourceId, TransportCallbacks>()
  const appended = new Map<CaptureSourceId, { startMs: number; endMs: number }[]>(), closed: string[] = []
  const events: ServerPayload[] = []
  const script = join(archives.directory, 'helper.ts')
  await Bun.write(script, `const writer=Bun.stdout.writer(); const origin=10000; function emit(h,pcm=new Uint8Array()){const j=Buffer.from(JSON.stringify(h));const p=Buffer.alloc(8);p.writeUInt32LE(j.length);p.writeUInt32LE(pcm.length,4);writer.write(Buffer.concat([p,j,pcm]));} let configured=false;for await(const c of Bun.stdin.stream()){if(!configured){configured=true;emit({type:'ready',clockMs:origin});for(let i=0;i<8;i++){for(const sourceId of ['local-microphone','remote-playback']){const pcm=Buffer.alloc(960);if(sourceId==='remote-playback')for(let n=0;n<960;n+=2)pcm.writeInt16LE(5000,n);emit({type:'audio',sourceId,sequence:i,captureMs:origin+i*20,sampleRate:24000,channels:1,format:'pcm_s16le',frames:480},pcm);}}await writer.flush();}else break;}await writer.end();`)
  const session = new NativeCaptureSession({ selection, delay: 'minimal', archives, emit: event => events.push(event),
    spawnHelper: () => Bun.spawn([process.execPath, '--no-env-file', script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {} }),
    transport: (_sessionId, source, _delay, cb) => {
      const id = source as CaptureSourceId; callbacks.set(id, cb); appended.set(id, [])
      return { ready: async () => {}, append: async (_pcm, timing) => { if (timing) appended.get(id)!.push(timing) }, commit() {},
        finish: async () => {
          if (finalDelayMs && id === 'remote-playback') {
            await Bun.sleep(finalDelayMs)
            cb.update({ sessionId: _sessionId, sourceId: id, id: 'tail', order: 0, revision: 1, text: 'Delayed final.', status: 'final', capture: { startMs: 0, endMs: 120, separation: 'unverified', callTransmission: 'unknown' } })
          }
          return true
        }, close: () => closed.push(id) }
    },
  })
  cleanup.push(() => session.shutdown())
  await session.start(); await waitFor(() => session.view.phase === 'running')
  await waitFor(() => session.view.capture!.sources['remote-playback'].receivedMs >= 160)
  return { session, archives, callbacks, appended, closed, events }
}

test.skipIf(!Bun.which('ffmpeg'))('native orchestration gates silent local audio, namespaces segments, persists capture timing and releases helpers/transports on Stop', async () => {
  const f = await nativeFixture()
  await waitFor(() => (f.appended.get('remote-playback')?.length ?? 0) >= 8)
  expect(f.appended.get('local-microphone')).toHaveLength(0)
  const base: Segment = { id: 'provider-id', sessionId: f.session.view.id, sourceId: 'remote-playback', order: 0, revision: 1, text: 'A developing remote clause', status: 'partial', capture: { startMs: 40, endMs: 100, separation: 'unverified', callTransmission: 'unknown' } }
  f.callbacks.get('remote-playback')!.update(base)
  f.callbacks.get('local-microphone')!.update({ ...base, sourceId: 'local-microphone', capture: { ...base.capture!, startMs: 0 } })
  expect(f.session.segments.size).toBe(2)
  expect([...f.session.segments.values()].sort((a,b) => a.order-b.order)[0]!.sourceId).toBe('local-microphone')
  expect([...f.session.segments.values()][0]!.capture).not.toHaveProperty('separation')
  f.session.stop(); await f.session.settled()
  expect(f.session.view.phase).toBe('ended'); expect(f.closed.sort()).toEqual(['local-microphone', 'remote-playback'])
  const saved = await f.archives.get(f.session.view.id)
  expect(saved.source.capture!.tracks).toHaveLength(2)
  expect((await Array.fromAsync(f.archives.updates(saved.id))).map(r => r.segment.sourceId)).toEqual(['remote-playback', 'local-microphone'])
  const count = f.session.segments.size
  f.callbacks.get('remote-playback')!.update({ ...base, id: 'late' })
  expect(f.session.segments.size).toBe(count)
  f.session.stop(); await f.session.shutdown()
  expect(f.events.filter(e => e.type === 'ended')).toHaveLength(1)
})


test.skipIf(!Bun.which('ffmpeg'))('transcription failure stops capture visibly, retains originals and rejects late transcript revisions', async () => {
  const f = await nativeFixture()
  f.callbacks.get('remote-playback')!.error(new Error('Provider disconnected'))
  await f.session.settled()
  expect(f.session.view.phase).toBe('error')
  expect(f.session.view.message).toContain('Provider disconnected')
  expect(f.closed).toHaveLength(2)
  const text = await Bun.file(f.archives.path(f.session.view.id)).text()
  expect(text).toContain('"event":"failure"'); expect(text).toContain('"complete":false')
  expect((await f.archives.get(f.session.view.id)).source.capture!.tracks).toHaveLength(2)
})

test.skipIf(!Bun.which('ffmpeg'))('brief → independent captured partials → suggestion → selection → local paraphrase FOLLOW preserves transmission uncertainty', async () => {
  const { emptyBrief } = await import('../shared/analysis')
  const { ConversationTracker } = await import('../server/tracking')
  const { SuggestionCoordinator } = await import('../server/suggestions')
  const { captureAttribution } = await import('../server/capture-attribution')
  const f = await nativeFixture(), brief = emptyBrief()
  brief.participants = [{ id: 'me', name: 'Local user (explicit mapping)', sideId: null }]
  brief.objectives = [{ id: 'question', kind: 'question', description: 'Clarify attendance', completion: 'Know days on site', origin: 'explicit', status: 'unexplored', evidence: [], history: [], reason: '' }]
  f.session.view.source.capture!.selection = { ...selection, localParticipantId: 'me' }
  let replies!: InstanceType<typeof SuggestionCoordinator>
  const tracker = new ConversationTracker({ sessionId: f.session.view.id, brief, windowMs: 60_000,
    latest: id => f.session.segments.get(id), attribution: segment => captureAttribution(segment, f.session.view.source, brief),
    selection: () => replies.selection(), assess: value => replies.assess(value), publish() {},
    interpreter: async (_mode, input) => {
      const local = input.transcript.find(s => s.sourceId === 'local-microphone')
      expect(local?.capture?.callTransmission).toBe('unknown')
      return { sessionId: input.request.sessionId, runId: input.request.runId, requestId: input.request.id, observations: [], objectives: [], openQuestions: [], replanReasons: [],
        selectionAssessment: { selectionId: input.selection!.id, status: 'expressed', evidence: [{ segmentId: local!.id, revision: local!.revision }], reason: 'Local paraphrase asks for the number of days; transmission remains unknown.' } }
    },
  })
  replies = new SuggestionCoordinator({ sessionId: f.session.view.id, windowMs: 60_000, analysis: () => tracker.state, media: () => f.session.view.diagnostics.mediaMs,
    latest: id => f.session.segments.get(id), publish() {}, generator: async (input, _signal, publish) => {
      expect(input.transcript[0]!.sourceId).toBe('remote-playback')
      expect(input.transcript[0]!.attribution.participantId).toBe(null)
      publish({ sessionId: input.sessionId, runId: input.runId, requestId: input.requestId, type: 'direction', recommended: true,
        direction: { directionId: null, label: 'Clarify attendance', move: 'clarify', objectiveIds: ['question'], meaning: 'Ask how many days on site.', opening: 'How often would I need to be on site?', continuation: null, evidence: input.transcript.map(s => ({ segmentId: s.id, revision: s.revision })), observationIds: [], assumptions: [], status: 'ready' } })
    },
  })
  cleanup.push(() => { tracker.dispose(); replies.dispose() })
  replies.configure('predictive', 'Short', 'me')
  function deliver(sourceId: CaptureSourceId, text: string, startMs: number, status: Segment['status']) {
    f.callbacks.get(sourceId)!.update({ id: sourceId, sessionId: f.session.view.id, sourceId, text, status, order: 0, revision: 1,
      capture: { startMs, endMs: startMs + 20, separation: 'unverified', callTransmission: 'unknown' } })
    const segment = [...f.session.segments.values()].find(s => s.sourceId === sourceId)!
    tracker.ingest(segment, startMs); replies.ingest(segment, startMs)
    return segment
  }
  deliver('remote-playback', 'We require regular attendance in the office', 0, 'partial')
  await replies.flush()
  const direction = replies.state.directions[0]!
  expect(direction).toBeDefined(); expect(direction.status).toBe('provisional')
  replies.select(direction.id, direction.version)
  expect(replies.state.selected!.expression).toBe('uncertain')
  const local = deliver('local-microphone', 'How many days each week would I come in?', 100, 'final')
  await tracker.flush()
  expect(tracker.state.attributions[local.id]!.participantId).toBe('me')
  expect(replies.state.selected!.expression).toBe('expressed')
  expect(replies.state.selected!.evidence[0]!.segmentId).toBe(local.id)
  expect(tracker.state.brief.objectives[0]!.status).toBe('unexplored')
  f.session.stop(); await f.session.settled()
})

test.skipIf(!Bun.which('ffmpeg'))('late finalization is a replay tail and never extends the captured WAV timeline', async () => {
  const f = await nativeFixture(250)
  f.session.stop(); await f.session.settled()
  const trackMs = f.session.view.source.capture!.tracks[0]!.durationMs
  const final = (await Array.fromAsync(f.archives.updates(f.session.view.id))).find(r => r.segment.text === 'Delayed final.')!
  expect(final).toBeDefined(); expect(final.tailMs).toBeGreaterThan(50)
  expect(trackMs).toBe(f.session.view.diagnostics.mediaMs)
  expect((await f.archives.get(f.session.view.id)).durationMs).toBeGreaterThan(trackMs + 50)
})


test.skipIf(!Bun.which('ffmpeg'))('Stop during native provider configuration releases both sockets without starting capture or creating a recording', async () => {
  const archives = storage(), closed: string[] = []
  const session = new NativeCaptureSession({ selection, delay: 'minimal', archives, emit() {},
    spawnHelper: () => { throw new Error('Must not open capture before provider readiness.') },
    transport: (_id, source) => ({ ready: signal => new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }) }), append: async () => {}, commit() {}, finish: async () => true, close: () => { closed.push(source) } }),
  })
  const work = session.start()
  session.stop(); await session.settled(); await work
  expect(session.view.phase).toBe('ended'); expect(closed).toHaveLength(2)
  expect(await archives.list()).toHaveLength(0)
  await session.shutdown()
})

test('remembered sources and gains survive restart and remain independent of participant identity', async () => {
  const { CaptureSetupStore } = await import('../server/capture-setup')
  const archives = storage()
  let store = new CaptureSetupStore(archives.directory)
  const gains = { 'local-microphone': -12, 'remote-playback': 24 }
  store.observeRoute('output:headset'); store.configure(selection, gains); store.close()
  store = new CaptureSetupStore(archives.directory)
  try {
    expect(store.selection).toEqual(selection)
    expect(store.gains({ ...selection, localParticipantId: 'other' })).toEqual(gains)
    store.observeRoute('output:speakers')
    expect(store.gains()).toEqual({ 'local-microphone': 0, 'remote-playback': 0 })
    store.observeRoute('output:headset')
    expect(store.gains()).toEqual(gains)
  } finally { store.close() }
})


test('gain clamps PCM safely, detects clipping before clamp and defaults old metadata to unity', async () => {
  const { applyCaptureGain } = await import('../server/capture-audio')
  const { parseCaptureGains, defaultCaptureGains } = await import('../shared/capture')
  const input = Buffer.alloc(8); [1000, -1000, 32767, -32768].forEach((value, i) => input.writeInt16LE(value, i * 2))
  expect(applyCaptureGain(input, 0).pcm).toEqual(new Uint8Array(input))
  expect(applyCaptureGain(input, 24).clipping).toBe(true)
  const amplified = Buffer.from(applyCaptureGain(input, 24).pcm)
  expect(amplified.readInt16LE(4)).toBe(32767); expect(amplified.readInt16LE(6)).toBe(-32768)
  expect(Buffer.from(applyCaptureGain(input, -12).pcm).readInt16LE(0)).toBe(251)
  expect(parseCaptureGains(undefined)).toEqual(defaultCaptureGains())
  expect(() => parseCaptureGains({ 'local-microphone': 25, 'remote-playback': 0 })).toThrow('whole dB')
  const archives = storage(), id = crypto.randomUUID()
  const capture: Record<string, unknown> = { ...metadata(true) }; delete capture.separation
  const source = { ...capturePlaceholder(metadata(true)), capture }
  await Bun.write(archives.path(id), JSON.stringify({ kind: 'header', version: 1, id, createdAt: new Date().toISOString(), source }) + '\n')
  const old = await archives.get(id)
  expect(old.source.capture!.gains).toEqual(defaultCaptureGains())
  expect(old.source.capture!.separation).toBe('unverified')
  expect(old.source.capture).not.toHaveProperty('verification')
})

// The helper emits real-time synthetic PCM. Restarting never touches hardware.
async function recoveryFixture({ routeChange = false, alwaysFail = false, silent = false, beforeReady = false, retryDelays = [0, 1, 2, 4] } = {}) {
  const archives = storage(), script = join(archives.directory, 'recovery-helper.ts')
  const events: ServerPayload[] = [], samples: number[] = [], configurations: string[] = []
  let launches = 0
  await Bun.write(script, `
const attempt=Number(Bun.argv[2]), writer=Bun.stdout.writer(), origin=performance.now();
function emit(header,pcm=new Uint8Array()){const j=Buffer.from(JSON.stringify(header)),p=Buffer.alloc(8);p.writeUInt32LE(j.length);p.writeUInt32LE(pcm.length,4);writer.write(Buffer.concat([p,j,pcm]));}
let configured=false,timer;let sequence=0;
for await(const chunk of Bun.stdin.stream()) {
 if(configured) break; configured=true;
 if(${beforeReady}) {emit({type:'audio',sourceId:'remote-playback',sequence:0,captureMs:origin,sampleRate:24000,channels:1,format:'pcm_s16le',frames:480},new Uint8Array(960));await writer.flush();await Bun.sleep(20);process.exit(1);}
 emit({type:'ready',clockMs:origin,routeSignature:${routeChange}&&attempt>0?'output:new':'output:same'});await writer.flush();
 timer=setInterval(async()=>{const time=performance.now();for(const sourceId of ['local-microphone','remote-playback']) {const pcm=Buffer.alloc(960);if(!${silent})for(let n=0;n<960;n+=2)pcm.writeInt16LE(1000,n);emit({type:'audio',sourceId,sequence,captureMs:time,sampleRate:24000,channels:1,format:'pcm_s16le',frames:480},pcm);}sequence++;await writer.flush();
 if((${alwaysFail}||attempt===0)&&sequence===3){clearInterval(timer);emit({type:'error',message:'Selected application restarted'});await writer.flush();}
 },20);
}
clearInterval(timer);await writer.end();`)
  const session = new NativeCaptureSession({ selection, expectedRoute: 'output:same', gains: { 'local-microphone': 6, 'remote-playback': 6 }, delay: 'minimal', archives, emit: event => events.push(event), retryDelays,
    spawnHelper: () => { configurations.push(JSON.stringify(selection)); return Bun.spawn([process.execPath, '--no-env-file', script, String(launches++)], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {} }) },
    transport: () => ({ ready: async () => {}, append: async pcm => { samples.push(new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength).getInt16(0, true)) }, commit() {}, finish: async () => true, close() {} }),
  })
  cleanup.push(() => session.shutdown())
  await session.start()
  return { session, archives, events, samples, configurations, launches: () => launches }
}

test.skipIf(!Bun.which('ffmpeg'))('app restart recovers the exact configuration, journals gaps and applies gain once to recording and recognition', async () => {
  const f = await recoveryFixture()
  await waitFor(() => f.launches() === 2 && f.samples.length > 8)
  expect(f.session.view.source.capture).not.toHaveProperty('separation')
  expect(f.configurations.every(value => value === JSON.stringify(selection))).toBe(true)
  expect(f.samples.every(value => value === 1995)).toBe(true)
  f.session.setGains({ 'local-microphone': 0, 'remote-playback': -12 })
  await waitFor(() => f.samples.includes(251) && f.samples.includes(1000))
  f.session.stop(); await f.session.settled()
  expect(f.session.view.phase).toBe('ended')
  const events = await Array.fromAsync(f.archives.captureEvents(f.session.view.id))
  expect(events.some(row => row.event === 'gap')).toBe(true)
  expect(events.find(row => row.event === 'gain')?.detail).toContain('-12')
  const saved = await f.archives.get(f.session.view.id)
  const original = await f.archives.audio(saved.source.capture!.tracks.find(t => t.sourceId === 'remote-playback')!.audioId)
  const bytes = Buffer.from(await Bun.file(original!.path).arrayBuffer()).subarray(44)
  const values = new Set<number>(); for (let i = 0; i < bytes.length; i += 2) values.add(bytes.readInt16LE(i))
  expect(values.has(1995)).toBe(true); expect(values.has(251)).toBe(true); expect(values.has(0)).toBe(true)
  expect(values.size).toBe(3) // no second gain stage in the WAV or replay path
})

test.skipIf(!Bun.which('ffmpeg'))('physical output changes retain recording and recognition', async () => {
  const f = await recoveryFixture({ routeChange: true })
  await waitFor(() => f.launches() === 2 && f.session.view.source.capture!.routeSignature === 'output:new' && f.session.view.capture!.sources['remote-playback'].receivedMs >= 100)
  expect(f.session.view.source.capture).not.toHaveProperty('separation')
  const count = f.samples.length
  await Bun.sleep(100)
  expect(f.samples.length).toBeGreaterThan(count)
  f.session.stop(); await f.session.settled()
  const saved = await f.archives.get(f.session.view.id)
  expect(saved.source.capture!.separation).toBe('unverified')
  expect(saved.source.capture!.tracks[0]!.durationMs).toBeGreaterThan(100)
})

test.skipIf(!Bun.which('ffmpeg'))('recovery is bounded at four retries and always leaves saved tracks and a failure state for explicit Retry', async () => {
  const { captureRetryDelays } = await import('../server/native-capture')
  expect(captureRetryDelays).toEqual([0, 1000, 2000, 4000])
  const f = await recoveryFixture({ alwaysFail: true })
  await waitFor(() => f.session.view.phase === 'error'); await f.session.settled()
  expect(f.launches()).toBe(5) // initial attempt, four retries
  expect(f.session.view.capture!.recovery.state).toBe('failed')
  expect(f.session.view.capture!.recovery.attempt).toBe(4)
  expect(f.session.view.source.capture!.tracks).toHaveLength(2)
  const recovery = (await Array.fromAsync(f.archives.captureEvents(f.session.view.id))).filter(row => row.event === 'recovery')
  expect(recovery.map(row => JSON.parse(row.detail).attempt)).toEqual([1, 2, 3, 4])
})

test.skipIf(!Bun.which('ffmpeg'))('audio before the startup handshake never reports capture started', async () => {
  const f = await recoveryFixture({ beforeReady: true })
  await waitFor(() => f.session.view.phase === 'error'); await f.session.settled()
  expect(f.events.some(event => event.type === 'status' && event.session.phase === 'running')).toBe(false)
  expect(f.session.view.capture!.sources['remote-playback'].started).toBe(false)
})

test.skipIf(!Bun.which('ffmpeg'))('silent playback keeps running past the old no-audio timeout and remains unverified', async () => {
  const f = await recoveryFixture({ silent: true })
  await waitFor(() => f.launches() === 2 && f.session.view.capture!.sources['remote-playback'].started)
  await Bun.sleep(5200)
  expect(f.session.view.phase).toBe('running')
  expect(f.session.view.capture!.sources['remote-playback'].audible).toBe(false)
  expect(f.session.view.capture!.problems).toContain('Waiting for audio from the selected source.')
  expect(f.session.view.capture!.problems.some(message => /microphone/i.test(message))).toBe(false)
  expect(f.session.view.capture!.sources['local-microphone'].sentMs).toBe(0)
  f.session.stop(); await f.session.settled()
  expect(f.session.view.source.capture).not.toHaveProperty('verification')
}, 10000)

test.skipIf(!Bun.which('ffmpeg'))('Stop cancels a pending retry promptly without opening another helper', async () => {
  const f = await recoveryFixture({ retryDelays: [4000] })
  await waitFor(() => f.session.view.capture!.recovery.state === 'retrying')
  const at = performance.now()
  f.session.stop(); await f.session.settled()
  expect(performance.now() - at).toBeLessThan(1000)
  expect(f.launches()).toBe(1)
  expect(f.session.view.phase).toBe('ended')
})


test.skipIf(!Bun.which('ffmpeg'))('startup handshake retains buffered audio timing after slow native stream startup', async () => {
  const archives = storage(), script = join(archives.directory, 'slow-start-helper.ts')
  await Bun.write(script, `const writer=Bun.stdout.writer();function emit(h,pcm=new Uint8Array()){const j=Buffer.from(JSON.stringify(h)),p=Buffer.alloc(8);p.writeUInt32LE(j.length);p.writeUInt32LE(pcm.length,4);writer.write(Buffer.concat([p,j,pcm]));}let configured=false;for await(const chunk of Bun.stdin.stream()){if(configured)break;configured=true;await Bun.sleep(400);emit({type:'ready',clockMs:10000,readyMs:10400,routeSignature:'output:test'});for(let i=0;i<20;i++)for(const sourceId of ['local-microphone','remote-playback'])emit({type:'audio',sourceId,sequence:i,captureMs:10000+i*20,sampleRate:24000,channels:1,format:'pcm_s16le',frames:480},new Uint8Array(960));await writer.flush();}await writer.end();`)
  const session = new NativeCaptureSession({ selection, archives, delay: 'minimal', emit() {}, transport: () => ({ ready: async () => {}, append: async () => {}, commit() {}, finish: async () => true, close() {} }), spawnHelper: () => Bun.spawn([process.execPath, '--no-env-file', script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {} }) })
  cleanup.push(() => session.shutdown())
  await session.start(); await waitFor(() => session.view.capture!.sources['remote-playback'].receivedMs >= 400)
  expect(session.view.phase).toBe('running')
  expect(session.view.diagnostics.mediaMs).toBeGreaterThanOrEqual(400)
  expect(session.view.capture!.recovery.attempt).toBe(0)
  session.stop(); await session.settled()
  expect(session.view.phase).toBe('ended')
})

test.skipIf(!Bun.which('ffmpeg'))('a startup backlog over one second keeps both devices running and retains all original audio', async () => {
  const archives = storage(), script = join(archives.directory, 'buffered-start-helper.ts')
  await Bun.write(script, `const writer=Bun.stdout.writer();function emit(h,pcm=new Uint8Array()){const j=Buffer.from(JSON.stringify(h)),p=Buffer.alloc(8);p.writeUInt32LE(j.length);p.writeUInt32LE(pcm.length,4);writer.write(Buffer.concat([p,j,pcm]));}const pcm=Buffer.alloc(960);for(let i=0;i<960;i+=2)pcm.writeInt16LE(1000,i);let configured=false,timer;for await(const chunk of Bun.stdin.stream()){if(configured)break;configured=true;const ready=performance.now();emit({type:'ready',clockMs:10000,readyMs:11600});let sequence=0;function audio(time){for(const sourceId of ['local-microphone','remote-playback'])emit({type:'audio',sourceId,sequence,captureMs:time,sampleRate:24000,channels:1,format:'pcm_s16le',frames:480},pcm);sequence++;}for(let i=0;i<80;i++)audio(10000+i*20);await writer.flush();timer=setInterval(async()=>{audio(11600+performance.now()-ready);await writer.flush();},20);}clearInterval(timer);await writer.end();`)
  let launches = 0, sentPackets = 0
  const session = new NativeCaptureSession({ selection, archives, delay: 'minimal', emit() {}, retryDelays: [],
    transport: () => ({ ready: async () => {}, append: async () => { sentPackets++ }, commit() {}, finish: async () => true, close() {} }),
    spawnHelper: () => { launches++; return Bun.spawn([process.execPath, '--no-env-file', script], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {} }) },
  })
  cleanup.push(() => session.shutdown())
  await session.start()
  await waitFor(() => session.view.capture!.sources['remote-playback'].receivedMs >= 1680 && sentPackets > 0)
  expect(launches).toBe(1)
  expect(session.view.phase).toBe('running')
  expect(session.view.capture!.recovery.attempt).toBe(0)
  session.stop(); await session.settled()
  expect(session.view.phase).toBe('ended')
  const journal = await Array.fromAsync(archives.captureEvents(session.view.id))
  expect(journal.some(row => row.event === 'recovery')).toBe(false)
  expect(journal.some(row => row.event === 'metrics' && row.detail.includes('retained in the recording'))).toBe(true)
  const saved = await archives.get(session.view.id)
  for (const track of saved.source.capture!.tracks) {
    const audio = await archives.audio(track.audioId)
    const bytes = Buffer.from(await Bun.file(audio!.path).arrayBuffer())
    expect(bytes.readInt16LE(44)).toBe(1000)
    expect(track.durationMs).toBeGreaterThanOrEqual(1680)
  }
})

test('source labels survive restart and missing devices turn unavailable until a refreshed inventory contains them', async () => {
  const { CaptureSetupStore } = await import('../server/capture-setup')
  const { captureSourceSummary } = await import('../shared/capture')
  const archives = storage()
  const inventory: import('../shared/capture').CaptureInventory = { os: 'macOS', architecture: 'arm64', minimumMacOS: '13.0', supported: true, microphonePermission: 'granted', playbackPermission: 'granted', microphones: [{ id: selection.microphoneId, name: 'Galaxy Buds microphone' }], targets: [{ id: selection.remote.bundleId, bundleId: selection.remote.bundleId, name: 'Firefox', pids: [42] }] }
  let store = new CaptureSetupStore(archives.directory)
  store.configure(selection); store.rememberDevices(inventory); store.close()
  store = new CaptureSetupStore(archives.directory)
  try {
    expect(store.labels).toEqual({ microphone: 'Galaxy Buds microphone', playback: 'Firefox' })
    const checking = captureSourceSummary(selection, null, store.labels)
    expect(checking.microphone.availability).toBe('checking')
    const missing = { ...inventory, microphones: [], targets: [] }
    store.rememberDevices(missing)
    const absent = captureSourceSummary(selection, missing, store.labels)
    expect(absent.microphone).toEqual({ name: 'Galaxy Buds microphone', availability: 'unavailable' })
    expect(absent.playback).toEqual({ name: 'Firefox', availability: 'unavailable' })
    const refreshed = captureSourceSummary(selection, inventory, store.labels)
    expect(refreshed.microphone.availability).toBe('available')
    expect(refreshed.playback.availability).toBe('available')
    expect(captureSourceSummary({ ...selection, remote: { kind: 'input', deviceId: selection.microphoneId } }, inventory).playback.name).toBe('Galaxy Buds microphone')
    expect(store.selection).toEqual(selection)
  } finally { store.close() }
})

test.skipIf(!Bun.which('ffmpeg'))('starting without any verification sends recognition audio and accepts transcripts without inventing confirmation', async () => {
  const f = await nativeFixture()
  await waitFor(() => (f.appended.get('remote-playback')?.length ?? 0) >= 8)
  expect(f.callbacks.size).toBe(2)
  expect(f.session.view.source.capture).not.toHaveProperty('separation')
  expect(f.session.view.source.capture).not.toHaveProperty('verification')
  const segment: Segment = { id: 'unchecked-start', sessionId: f.session.view.id, sourceId: 'remote-playback', order: 0, revision: 1, text: 'Recognition works without the setup test.', status: 'partial', capture: { startMs: 0, endMs: 100, separation: 'unverified', callTransmission: 'unknown' } }
  f.callbacks.get('remote-playback')!.update(segment)
  expect([...f.session.segments.values()][0]!.text).toBe(segment.text)
  expect([...f.session.segments.values()][0]!.capture).not.toHaveProperty('separation')
  const { captureAttribution } = await import('../server/capture-attribution')
  const { emptyBrief } = await import('../shared/analysis')
  const brief = emptyBrief(); brief.participants = [{ id: 'me', name: 'Me', sideId: null }]
  f.session.view.source.capture!.selection = { ...selection, localParticipantId: 'me' }
  expect(captureAttribution({ ...segment, sourceId: 'local-microphone' }, f.session.view.source, brief)?.participantId).toBe('me')
  f.session.stop(); await f.session.settled()
  const saved = await f.archives.get(f.session.view.id)
  expect(saved.source.capture!.separation).toBe('unverified')
  expect(saved.source.capture!.tracks).toHaveLength(2)
})
