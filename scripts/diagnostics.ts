import { resolve } from 'node:path'

// bun run diagnostics [session ID] [diagnostics directory]
const sessionId = process.argv[2]
const directory = resolve(process.argv[3] ?? `${process.env.TRANSCRIPT_DIR ?? 'data/transcripts'}/diagnostics`)
const counts = new Map<string, number>()
const incidents: unknown[] = []
let health = 0
let dropped = 0
for (const name of ['events.jsonl.4', 'events.jsonl.3', 'events.jsonl.2', 'events.jsonl.1', 'events.jsonl']) {
  const file = Bun.file(`${directory}/${name}`)
  if (!await file.exists()) continue
  let pending = ''
  for await (const chunk of file.stream()) {
    pending += new TextDecoder().decode(chunk)
    const lines = pending.split('\n'); pending = lines.pop()!
    for (const line of lines) {
      try {
        const row = JSON.parse(line)
        if (sessionId && row.sessionId !== sessionId) continue
        const key = `${row.workType ?? 'session'}:${row.event}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
        dropped = Math.max(dropped, Number(row.dropped) || 0)
        if (row.event === 'health') health++
        if (['error', 'timeout', 'cancel', 'stale-result', 'disconnect', 'playback-pause'].includes(row.event) || row.event === 'health' && (row.audioBacklogMs > 500 || row.lastTranscriptMs > 10_000 || row.eventLoopDelayMs > 250 || row.persistenceBacklog > 100)) {
          incidents.push(row)
          if (incidents.length > 200) incidents.shift()
        }
      } catch { /* Ignore interrupted trailing records. */ }
    }
  }
}
console.log(JSON.stringify({ sessionId: sessionId ?? 'all', directory, counts: Object.fromEntries(counts), healthSamples: health, droppedRecords: dropped, incidents }, null, 2))
