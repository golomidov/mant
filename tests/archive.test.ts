import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Archives } from '../server/archive'
import type { ArchiveHeader, ArchiveUpdate } from '../server/archive'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
function setup() {
  const path = mkdtempSync(join(tmpdir(), 'mant-archive-'))
  directories.push(path)
  return new Archives(path)
}
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const sourceId = 'a'.repeat(64)
const source = { id: sourceId, name: 'Original.wav', size: 12, replayId: null }
const header: ArchiveHeader = { kind: 'header', version: 1, id, source, createdAt: '2026-10-22T10:00:00Z' }
const update: ArchiveUpdate = { kind: 'transcript', atMs: 10, segment: { sessionId: id, sourceId, id: 'first', order: 0, revision: 1, text: 'Ciao, è pronto?', status: 'partial' } }

function body(text: string) {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return }
    controller.enqueue(bytes.subarray(offset, offset + 7))
    offset = Math.min(bytes.length, offset + 7)
  } })
}

test('JSONL import streams split UTF-8 rows and accepts a final line without a newline', async () => {
  const archives = setup()
  const saved = await archives.import(body(`${JSON.stringify(header)}\n${JSON.stringify(update)}`))
  expect(saved.source.name).toBe('Original.wav')
  expect(saved.audioAvailable).toBe(false)
  const rows = await Array.fromAsync(archives.updates(saved.id))
  expect(rows[0]?.segment.text).toBe('Ciao, è pronto?')
  expect(rows[0]?.segment.sessionId).toBe(saved.id)
  const second = await archives.import(body(await Bun.file(archives.path(saved.id)).text()))
  expect(second.id).not.toBe(saved.id)
  expect(await archives.list()).toHaveLength(2)
})

test('audio and transcript library survive recreation of the storage object', async () => {
  const archives = setup()
  archives.create(id, source)
  archives.append(id, update)
  const original = join(archives.directory, 'temporary.wav')
  await Bun.write(original, 'original wav bytes')
  const audio = await archives.keepAudio(source, original, 'audio/wav')
  expect(audio.path).toEndWith(`${sourceId}.wav`)
  const restarted = new Archives(archives.directory)
  expect((await restarted.get(id)).audioAvailable).toBe(true)
  expect((await restarted.list())[0]?.source.name).toBe('Original.wav')
  const restored = await restarted.audio(sourceId)
  expect(restored?.contentType).toBe('audio/wav')
  expect(await Bun.file(restored!.path).text()).toBe('original wav bytes')
  expect(await Bun.file(restarted.path(id)).exists()).toBe(true)
})

test('invalid or mixed-session imports leave existing archives intact and remove staging files', async () => {
  const archives = setup()
  archives.create(id, source)
  archives.append(id, update)
  const mixed = { ...update, segment: { ...update.segment, sessionId: 'another-session' } }
  await expect(archives.import(body(`${JSON.stringify(header)}\n${JSON.stringify(mixed)}\n`))).rejects.toThrow('different recording or session')
  await expect(archives.import(body('not a transcript'))).rejects.toThrow()
  const negative = { ...update, atMs: -1 }
  await expect(archives.import(body(`${JSON.stringify(header)}\n${JSON.stringify(negative)}\n`))).rejects.toThrow('timestamp')
  await archives.flush()
  expect(readdirSync(archives.directory)).toEqual([`${id}.jsonl`])
})

test('reattachment repairs a truncated audio file and corrupt metadata does not hide its transcript', async () => {
  const archives = setup()
  const text = 'original wav bytes'
  const recording = { ...source, size: new TextEncoder().encode(text).length }
  archives.create(id, recording)
  archives.append(id, update)
  await Bun.write(join(archives.directory, `${sourceId}.wav`), 'partial')
  const temporary = join(archives.directory, 'upload.wav')
  await Bun.write(temporary, text)
  const stored = await archives.keepAudio(recording, temporary, 'audio/wav')
  expect(await Bun.file(stored.path).text()).toBe(text)
  await Bun.write(join(archives.directory, `${sourceId}.audio.json`), 'truncated json')
  const saved = await archives.list()
  expect(saved).toHaveLength(1)
  expect(saved[0]?.audioAvailable).toBe(false)
  expect(await Bun.file(archives.path(id)).exists()).toBe(true)
})

test('a hash-named WAV beside a transcript is paired automatically without upload metadata', async () => {
  const archives = setup()
  const bytes = new TextEncoder().encode('original recording bytes for discovery')
  const contentId = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  const recording = { ...source, id: contentId, size: bytes.length }
  archives.create(id, recording)
  archives.append(id, { ...update, atMs: 120_000, segment: { ...update.segment, sourceId: contentId } })
  await Bun.write(join(archives.directory, `${contentId}.wav`), bytes)
  const saved = await new Archives(archives.directory).get(id)
  expect(saved.audioAvailable).toBe(true)
  expect(saved.durationMs).toBe(120_000)
  expect((await archives.audio(contentId))?.path).toEndWith(`${contentId}.wav`)
  expect(await Bun.file(join(archives.directory, `${contentId}.audio.json`)).exists()).toBe(true)
})

test('uploaded media stays selectable after restart without creating or inheriting a session', async () => {
  const archives = setup()
  const original = join(archives.directory, 'upload.wav')
  const bytes = 'new recording without a transcript'
  await Bun.write(original, bytes)
  await archives.keepAudio({ ...source, size: bytes.length, replayId: id }, original, 'audio/wav')
  const restarted = new Archives(archives.directory)
  expect(await restarted.list()).toEqual([])
  expect(await restarted.recordings()).toEqual([{ ...source, size: bytes.length, replayId: null }])
  expect(await Bun.file((await restarted.audio(sourceId))!.path).text()).toBe(bytes)
})

test('the media picker deduplicates session media and excludes missing audio', async () => {
  const archives = setup()
  const original = join(archives.directory, 'upload.wav')
  await Bun.write(original, 'original wav bytes')
  await archives.keepAudio(source, original, 'audio/wav')
  archives.create(id, source)
  archives.append(id, update)
  const second = crypto.randomUUID()
  archives.create(second, source)
  archives.append(second, { ...update, segment: { ...update.segment, sessionId: second } })
  archives.create(crypto.randomUUID(), { ...source, id: 'b'.repeat(64), name: 'Missing.wav' })
  expect(await archives.list()).toHaveLength(3)
  const media = await archives.recordings()
  expect(media).toHaveLength(1)
  expect(media[0]).toMatchObject({ id: sourceId, name: source.name, replayId: null })
})

test('startup preparation reads the latest complete state without scanning historical rows', async () => {
  const { emptyAnalysis } = await import('../shared/analysis')
  const archives = setup(), state = emptyAnalysis('preparation')
  state.brief.preparation = '準'.repeat(23000)
  // Old history can predate current schemas; it must not delay or block startup.
  await Bun.write(join(archives.directory, 'preparation.jsonl'), 'obsolete history\n'.repeat(10000) + JSON.stringify(state))
  expect((await archives.preparation())?.brief.preparation).toBe(state.brief.preparation)
})

test('startup restores pre-rework preparation without changing its stored history', async () => {
  const { emptyAnalysis } = await import('../shared/analysis')
  const archives = setup(), state = emptyAnalysis('preparation')
  state.brief.preparation = 'Keep my exact goal.\n  And spacing.'
  state.brief.answers = 'Keep this additional context.'
  state.brief.languages = { call: 'it', user: 'en' }
  const legacy = { ...state, brief: { ...state.brief, contextInPreparation: true,
    languages: { ...state.brief.languages, interface: 'de', reply: 'it' } } }
  const path = join(archives.directory, 'preparation.jsonl'), original = JSON.stringify(legacy) + '\n'
  await Bun.write(path, original)
  expect(await archives.preparation()).toEqual(state)
  expect(await Bun.file(path).text()).toBe(original)
  await archives.savePreparation((await archives.preparation())!)
  expect(await archives.preparation()).toEqual(state)
})

test('startup migrates the legacy interface language when no user language was saved', async () => {
  const { emptyAnalysis } = await import('../shared/analysis')
  const archives = setup(), state = emptyAnalysis('preparation')
  const legacy = { ...state, brief: { ...state.brief, contextInPreparation: false,
    languages: { call: 'it', interface: 'en', reply: 'it' } } }
  await Bun.write(join(archives.directory, 'preparation.jsonl'), JSON.stringify(legacy))
  expect((await archives.preparation())?.brief.languages).toEqual({ call: 'it', user: 'en' })
})

test('preparation migration still rejects unrelated invalid state', async () => {
  const { emptyAnalysis } = await import('../shared/analysis')
  const archives = setup(), state = emptyAnalysis('preparation')
  const invalid = { ...state, brief: { ...state.brief, contextInPreparation: true, objectives: 'invalid' } }
  const path = join(archives.directory, 'preparation.jsonl'), original = JSON.stringify(invalid)
  await Bun.write(path, original)
  await expect(archives.preparation()).rejects.toThrow('Invalid structured analysis data')
  expect(await Bun.file(path).text()).toBe(original)
})

test('library indexing stays off the audio event loop and invalidates cached files after new rows', async () => {
  const { emptyAnalysis, emptyBrief } = await import('../shared/analysis')
  const archives = setup(), brief = emptyBrief()
  brief.preparation = 'Synthetic archive history. '.repeat(100)
  brief.objectives = Array.from({ length: 12 }, (_, n) => ({ id: `goal-${n}`, kind: 'question' as const, description: 'Synthetic question. '.repeat(40), completion: 'Synthetic completion. '.repeat(20), origin: 'explicit' as const, status: 'unexplored' as const, evidence: [], reason: '', history: [] }))
  const state = emptyAnalysis(id, brief)
  const line = JSON.stringify({ kind: 'analysis', atMs: 100, effectiveMs: 100, reason: 'track', state }) + '\n'
  for (let n = 0; n < 4; n++) {
    const archiveId = crypto.randomUUID()
    await Bun.write(archives.path(archiveId), JSON.stringify({ ...header, id: archiveId }) + '\n' + line.repeat(128))
  }
  let last = performance.now(), maxGap = 0, ticks = 0
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++ }, 5)
  try {
    const [first, concurrent] = await Promise.all([archives.list(), archives.list()])
    await Bun.sleep(10)
    expect(first).toHaveLength(4); expect(concurrent).toEqual(first)
    expect(ticks).toBeGreaterThan(0); expect(maxGap).toBeLessThan(250)
    const target = first[0]!.id
    archives.append(target, { ...update, atMs: 900, segment: { ...update.segment, sessionId: target } })
    expect((await archives.get(target)).durationMs).toBe(900)
    expect((await archives.list()).find(row => row.id === target)?.durationMs).toBe(900)
  } finally { clearInterval(timer) }
})
