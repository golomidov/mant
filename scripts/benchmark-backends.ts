import { FileAudioSource, SpeechBoundary } from '../server/audio'
import { createTranscription } from '../server/backend-registry'
import { connectionFor } from '../server/backend-settings'
import type { Segment } from '../shared/protocol'
import { safeMessage } from '../server/errors'
interface RecordingCase { name: string; streams: { path: string; language: string; reference?: string; switches?: { atMs: number; language: string }[] }[] }
export function wordErrorRate(reference: string, actual: string) {
  const words = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, '').trim().split(/\s+/).filter(Boolean)
  const a = words(reference), b = words(actual)
  if (!a.length) return null
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + Number(a[i - 1] !== b[j - 1]))
    row = next
  }
  return row[b.length]! / a.length
}
async function benchmark(test: RecordingCase) {
  const sessionId = crypto.randomUUID(), connection = connectionFor('transcription')
  const results = await Promise.all(test.streams.map(async (stream, index) => {
    const segments = new Map<string, Segment>(), source = new FileAudioSource(stream.path), controller = new AbortController()
    let firstResultMs: number | null = null, peakBacklogBytes = 0, peakRssBytes = process.memoryUsage().rss, audioMs = 0, began = 0, failure: Error | null = null
    const transport = createTranscription(sessionId, String(index), 'low', { update: segment => { firstResultMs ??= performance.now() - began; segments.set(segment.id, segment) }, error: error => { failure = error; controller.abort() } }, [stream.language])
    const backlogSamples: { atMs: number; bytes: number }[] = []
    let switchIndex = 0
    const boundary = new SpeechBoundary()
    try {
      await transport.ready(controller.signal)
      began = performance.now()
      for await (const pcm of source.packets(controller.signal)) {
        if (failure) throw failure
        while (stream.switches?.[switchIndex] && audioMs >= stream.switches[switchIndex]!.atMs) transport.setLanguages?.([stream.switches[switchIndex++]!.language])
        const endMs = audioMs + pcm.length / 48
        await transport.append(pcm, { startMs: audioMs, endMs }); audioMs = endMs
        if (boundary.add(pcm)) transport.commit()
        const health = transport.health?.()
        peakBacklogBytes = Math.max(peakBacklogBytes, health?.bufferedBytes ?? 0)
        backlogSamples.push({ atMs: audioMs, bytes: health?.bufferedBytes ?? 0 })
        while (backlogSamples[0] && audioMs - backlogSamples[0].atMs > 10000) backlogSamples.shift()
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
        const delay = began + audioMs - performance.now()
        if (delay > 0) await Bun.sleep(delay)
      }
      const ended = performance.now(), drained = await transport.finish(45_000), finalizationMs = performance.now() - ended
      if (failure) throw failure
      const text = [...segments.values()].sort((a, b) => a.order - b.order).map(s => s.text).join(' ')
      return { stream: index, language: stream.language, audioMs, firstResultMs, finalizationMs, drained, peakBacklogBytes, sustainedBacklogBytes: backlogSamples.length ? backlogSamples.reduce((sum, s) => sum + s.bytes, 0) / backlogSamples.length : null, finalBacklogBytes: transport.health?.().bufferedBytes ?? null, peakRssBytes, inferenceProcessMemory: 'not measured; RSS covers Mant/Bun, not external servers or native helper', wordErrorRate: stream.reference ? wordErrorRate(stream.reference, text) : null, accuracyStatus: stream.reference ? 'reference supplied' : 'unknown: no reference supplied', text }
    } catch (error) { return { stream: index, language: stream.language, error: safeMessage(error instanceof Error ? error.message : String(error)) } }
    finally { controller.abort(); transport.close(); await source.close() }
  }))
  return { name: test.name, provider: connection.provider, model: connection.model, streams: results }
}
if (import.meta.main) {
  const path = process.argv[2]
  if (!path) throw new Error('Usage: bun run benchmark:backends manifest.json [report.json]. See docs/backends.md for the recording manifest.')
  const manifest = await Bun.file(path).json() as { cases: RecordingCase[] }
  const report = { at: new Date().toISOString(), cases: [] as Awaited<ReturnType<typeof benchmark>>[] }
  for (const test of manifest.cases) { console.error(`Benchmarking ${test.name}`); report.cases.push(await benchmark(test)) }
  const json = JSON.stringify(report, null, 2) + '\n'
  if (process.argv[3]) await Bun.write(process.argv[3]!, json); else console.log(json)
  if (report.cases.some(c => c.streams.some(s => 'error' in s || !s.drained))) process.exitCode = 1
}
