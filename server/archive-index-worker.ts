import { readArchiveIndex } from './archive'

declare const self: { onmessage: (event: MessageEvent<{ taskId: number; id: string; path: string }>) => void }
let serial = Promise.resolve()
self.onmessage = event => {
  serial = serial.then(async () => {
    const { taskId, id, path } = event.data
    try { postMessage({ id: taskId, value: await readArchiveIndex(id, path) }) }
    catch { postMessage({ id: taskId, error: 'Saved transcript is missing or invalid. Import the JSONL file again.' }) }
  })
}
