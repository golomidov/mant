import { resolve, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { safeMessage } from './errors'
export const appleHelperPath = () => resolve(import.meta.dir, '../native/build/MantAI')
export async function appleRequest(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const path = appleHelperPath()
  if (process.platform !== 'darwin' || !await Bun.file(path).exists()) throw new Error('Apple AI helper is unavailable. On macOS run bun run ai:build; install required language assets and enable Apple Intelligence for Foundation Models.')
  if (signal.aborted) throw new Error('Apple AI cancelled.')
  let temp: string | undefined
  try {
    if (request.action === 'transcribe' && typeof request.wav === 'string') {
      temp = await mkdtemp(join(tmpdir(), 'mant-ai-'))
      const audioPath = join(temp, 'audio.wav')
      await Bun.write(audioPath, Buffer.from(request.wav, 'base64'))
      request = { ...request, path: audioPath }; delete request.wav
    }
    const child = Bun.spawn([path], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
    const controller = AbortSignal.any([signal, AbortSignal.timeout(45_000)])
    const abort = () => child.kill()
    controller.addEventListener('abort', abort, { once: true })
    try {
      child.stdin.write(JSON.stringify(request)); child.stdin.end()
      let output = ''
      const decoder = new TextDecoder()
      for await (const chunk of child.stdout) {
        output += decoder.decode(chunk, { stream: true })
        if (output.length > 2_000_000) throw new Error('Apple AI output exceeded 2 MB.')
      }
      output += decoder.decode()
      const code = await child.exited
      if (controller.aborted) throw new Error('Apple AI cancelled or timed out.')
      const value = JSON.parse(output) as { error?: string; result?: unknown }
      if (code !== 0 || value.error) throw new Error(safeMessage(value.error ?? 'Apple AI helper failed.'))
      return value.result
    } finally { controller.removeEventListener('abort', abort); child.kill(); await child.exited }
  } finally { if (temp) await rm(temp, { recursive: true, force: true }) }
}
