// Explicit, paid smoke test: bun run test:live /absolute/path/to/recording.wav
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileAudioSource } from '../server/audio'
import { Archives } from '../server/archive'
import { ConversationSession } from '../server/session'
import { OpenAITranscription } from '../server/transcription'

const path = process.argv[2]
if (!path || !await Bun.file(path).exists()) throw new Error('Usage: bun run test:live /path/to/short-recording.wav (makes a paid OpenAI request).')
if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY in the server process environment.')
if (!Bun.which('ffmpeg')) throw new Error('Install FFmpeg and add it to PATH.')
const directory = mkdtempSync(join(tmpdir(), 'mant-live-'))
let began: number | null = null
let timer: ReturnType<typeof setInterval> | null = null
const session = new ConversationSession({
  source: { id: crypto.randomUUID(), name: 'Smoke recording', size: Bun.file(path).size, replayId: null },
  audio: new FileAudioSource(path), mode: 'live', delay: 'minimal', archives: new Archives(directory),
  transport: (session, source, delay, callbacks) => new OpenAITranscription(session, source, delay, callbacks),
  emit(event) {
    if (event.type === 'status' && event.session.phase === 'ready' && began === null) {
      began = performance.now()
      session.clock(0)
      timer = setInterval(() => {
        const position = performance.now() - began!
        if (position >= 20_000) session.stop(20_000)
        else session.clock(position)
      }, 20)
    }
    if (event.type === 'transcript') console.log(`${event.segment.status}: ${event.segment.text}`)
    if (event.type === 'error') console.error(event.message)
  },
})
try {
  await session.start()
  console.log(JSON.stringify(session.view.diagnostics, null, 2))
  if (session.view.phase === 'error') process.exitCode = 1
} finally {
  if (timer) clearInterval(timer)
  await session.shutdown()
  rmSync(directory, { recursive: true, force: true })
}
