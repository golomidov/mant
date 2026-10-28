import { expect, test } from 'bun:test'
import { discoverCaptureSources, sourceRefreshMs, sourceRequestTimeoutMs } from '../src/capture-discovery'
import { captureSourceSummary, type CaptureInventory, type CaptureSelection } from '../shared/capture'

const selection: CaptureSelection = { microphoneId: 'mic', remote: { kind: 'application', bundleId: 'app' }, localParticipantId: null }
const inventory: CaptureInventory = { os: 'macOS', architecture: 'arm64', minimumMacOS: '13.0', supported: true,
  microphonePermission: 'granted', playbackPermission: 'granted', microphones: [{ id: 'mic', name: 'Headset' }],
  targets: [{ id: 'app', bundleId: 'app', name: 'Call app', pids: [1] }] }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function fixture(initialVisible = true) {
  let now = 0, visible = initialVisible, starts = 0, finishes = 0
  const scheduled = new Set<{ at: number; callback(): void }>()
  const calls: { signal: AbortSignal; resolve(value: CaptureInventory): void; reject(error: Error): void }[] = []
  const results: CaptureInventory[] = [], errors: string[] = []
  const page = new EventTarget(), window = new EventTarget()
  const work = discoverCaptureSources({
    load: signal => new Promise((resolve, reject) => calls.push({ signal, resolve, reject })),
    visible: () => visible, page, window,
    schedule: (callback, delay) => { const task = { at: now + delay, callback }; scheduled.add(task); return () => { scheduled.delete(task) } },
    onStart: () => { starts++ }, onFinish: () => { finishes++ },
    onInventory: value => results.push(value), onError: value => errors.push(value),
  })
  function advance(ms: number) {
    const through = now + ms
    while (true) {
      const task = [...scheduled].filter(t => t.at <= through).sort((a, b) => a.at - b.at)[0]
      if (!task) break
      scheduled.delete(task); now = task.at; task.callback()
    }
    now = through
  }
  return { work, calls, results, errors, advance, window, scheduled, starts: () => starts, finishes: () => finishes,
    visibility(value: boolean) { visible = value; page.dispatchEvent(new Event('visibilitychange')) } }
}

test('discovery starts without a panel trigger, coalesces triggers, and polls five seconds after completion', async () => {
  const f = fixture(); await flush()
  expect(f.calls).toHaveLength(1)
  f.work.refresh(); f.window.dispatchEvent(new Event('focus')); f.advance(4000); await flush()
  expect(f.calls).toHaveLength(1)
  f.calls[0]!.resolve(inventory); await flush()
  expect(f.results).toEqual([inventory]); expect(f.finishes()).toBe(1)
  f.advance(sourceRefreshMs - 1); await flush(); expect(f.calls).toHaveLength(1)
  f.advance(1); await flush(); expect(f.calls).toHaveLength(2)
  f.work.dispose()
})

test('errors automatically retry, with successful discovery clearing the failure via onInventory', async () => {
  const f = fixture(); await flush()
  f.calls[0]!.reject(new Error('Permission service unavailable')); await flush()
  expect(f.errors[0]).toContain('Permission service unavailable')
  f.advance(sourceRefreshMs); await flush(); expect(f.calls).toHaveLength(2)
  f.calls[1]!.resolve(inventory); await flush(); expect(f.results).toEqual([inventory])
  f.work.dispose()
})

test('a timeout aborts discovery, retries, and ignores a late response from the timed out request', async () => {
  const f = fixture(); await flush()
  f.advance(sourceRequestTimeoutMs); await flush()
  expect(f.calls[0]!.signal.aborted).toBe(true); expect(f.errors[0]).toContain('timed out')
  f.advance(sourceRefreshMs); await flush()
  f.calls[0]!.resolve({ ...inventory, targets: [] }); await flush()
  expect(f.results).toEqual([])
  f.calls[1]!.resolve(inventory); await flush(); expect(f.results).toEqual([inventory])
  f.work.dispose()
})

test('hidden pages pause polling and visibility/focus trigger an immediate coalesced check', async () => {
  const f = fixture(false); await flush(); expect(f.calls).toHaveLength(0)
  f.visibility(true); f.window.dispatchEvent(new Event('focus')); await flush()
  expect(f.calls).toHaveLength(1)
  f.visibility(false); f.calls[0]!.resolve(inventory); await flush()
  f.advance(60_000); await flush(); expect(f.calls).toHaveLength(1)
  f.visibility(true); await flush(); expect(f.calls).toHaveLength(2)
  f.calls[1]!.resolve(inventory); await flush()
  f.visibility(false); f.advance(sourceRefreshMs); await flush(); expect(f.calls).toHaveLength(2)
  f.visibility(true); await flush(); expect(f.calls).toHaveLength(3)
  f.work.dispose()
})

test('retiring a connection aborts its request and removes timers and event listeners', async () => {
  const old = fixture(); await flush(); old.work.dispose()
  expect(old.calls[0]!.signal.aborted).toBe(true)
  const next = fixture(); await flush()
  old.calls[0]!.resolve({ ...inventory, targets: [] }); await flush()
  old.window.dispatchEvent(new Event('focus')); old.visibility(true); old.advance(60_000); await flush()
  expect(old.results).toEqual([]); expect(old.calls).toHaveLength(1); expect(old.scheduled.size).toBe(0)
  next.calls[0]!.resolve(inventory); await flush(); expect(next.results).toEqual([inventory])
  next.work.dispose(); expect(next.scheduled.size).toBe(0)
})

test('only successful enumeration confirms absence; partial playback errors preserve microphone availability', () => {
  expect(captureSourceSummary(selection, null).microphone.availability).toBe('checking')
  const labels = { microphone: 'Headset', playback: 'Call app' }
  expect(captureSourceSummary(selection, null, labels, 'unknown').playback).toEqual({ name: 'Call app', availability: 'unknown' })
  const partial = { ...inventory, targets: [], problem: 'Playback permission or target enumeration failed' }
  expect(captureSourceSummary(selection, partial).microphone.availability).toBe('available')
  expect(captureSourceSummary(selection, partial).playback.availability).toBe('unknown')
  const routed: CaptureSelection = { ...selection, remote: { kind: 'input', deviceId: 'remote' } }
  expect(captureSourceSummary(routed, { ...partial, microphones: [...inventory.microphones, { id: 'remote', name: 'Routed input' }] }).playback.availability).toBe('available')
  expect(captureSourceSummary(selection, { ...inventory, microphones: [], targets: [] }, labels).microphone).toEqual({ name: 'Headset', availability: 'unavailable' })
  expect(captureSourceSummary(selection, { ...inventory, targets: [] }).playback.availability).toBe('unavailable')
  expect(captureSourceSummary(selection, inventory).playback.availability).toBe('available')
})

test('immediate cleanup before the initial microtask never launches a request', async () => {
  const f = fixture()
  f.work.dispose(); await flush()
  expect(f.calls).toHaveLength(0)
  expect(f.results).toEqual([])
  expect(f.scheduled.size).toBe(0)
})
