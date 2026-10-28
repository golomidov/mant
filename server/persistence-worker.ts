declare const self: { onmessage: (event: MessageEvent<{ id: number; operation: PersistenceOperation; delayMs: number }>) => void }
import { appendFileSync, closeSync, ftruncateSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PersistenceOperation } from './persistence'

const files = new Map<string, number>()
let serial = Promise.resolve()
self.onmessage = (event: MessageEvent<{ id: number; operation: PersistenceOperation; delayMs: number }>) => {
  serial = serial.then(async () => {
    const { id, operation: op, delayMs } = event.data
    try {
      if (delayMs) await Bun.sleep(delayMs)
      if (op.kind === 'append') {
        mkdirSync(dirname(op.path), { recursive: true, mode: 0o700 })
        appendFileSync(op.path, op.data, { mode: 0o600, flag: op.exclusive ? 'wx' : 'a' })
      } else if (op.kind === 'open') {
        const fd = openSync(op.path, 'wx', 0o600)
        files.set(op.path, fd); writeSync(fd, op.data)
      } else if (op.kind === 'write') {
        const fd = files.get(op.path)
        if (fd === undefined) throw new Error('Recording file unavailable')
        let offset = 0
        while (offset < op.data.length) offset += writeSync(fd, op.data, offset, op.data.length - offset, op.position + offset)
      } else if (op.kind === 'close') {
        const fd = files.get(op.path)
        if (fd !== undefined) {
          try { ftruncateSync(fd, op.length); writeSync(fd, op.data, 0, op.data.length, 0) }
          finally { closeSync(fd); files.delete(op.path) }
        }
      } else if (op.kind === 'diagnostic') {
        mkdirSync(dirname(op.path), { recursive: true, mode: 0o700 })
        let size = 0
        try { size = statSync(op.path).size } catch { /* First record. */ }
        if (size + Buffer.byteLength(op.data) > op.limit) {
          for (let n = 4; n >= 1; n--) {
            try { renameSync(n === 1 ? op.path : `${op.path}.${n - 1}`, `${op.path}.${n}`) } catch { /* No older file. */ }
          }
        }
        appendFileSync(op.path, op.data, { mode: 0o600 })
      }
      postMessage({ id })
    } catch (error) { postMessage({ id, error: error instanceof Error ? error.name : 'PersistenceError' }) }
  })
}
