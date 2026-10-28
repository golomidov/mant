import type { CaptureInventory } from '../shared/capture'

export const sourceRefreshMs = 5000
export const sourceRequestTimeoutMs = 35_000
type Schedule = (callback: () => void, delay: number) => () => void

/** One discovery generation. Disposing it prevents even late, unabortable results from publishing. */
export function discoverCaptureSources(options: {
  load(signal: AbortSignal): Promise<CaptureInventory>
  visible(): boolean
  page: EventTarget
  window: EventTarget
  onStart(): void
  onInventory(inventory: CaptureInventory): void
  onError(message: string): void
  onFinish(): void
  schedule?: Schedule
}) {
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  })
  let disposed = false
  let active: AbortController | null = null
  let cancelPoll: (() => void) | undefined
  let cancelDeadline: (() => void) | undefined

  function refresh() {
    if (disposed || active || !options.visible()) return
    cancelPoll?.(); cancelPoll = undefined
    const controller = new AbortController()
    active = controller
    options.onStart()
    function finish(inventory?: CaptureInventory, error?: string) {
      if (disposed || active !== controller) return
      cancelDeadline?.(); cancelDeadline = undefined
      active = null
      if (inventory) options.onInventory(inventory)
      else options.onError(error ?? 'Unable to check audio sources. Retrying automatically.')
      options.onFinish()
      if (options.visible()) cancelPoll = schedule(refresh, sourceRefreshMs)
    }
    cancelDeadline = schedule(() => {
      controller.abort()
      finish(undefined, 'Checking audio sources timed out. Check macOS capture permissions; retrying automatically.')
    }, sourceRequestTimeoutMs)
    void Promise.resolve().then(() => {
      if (!disposed && active === controller) return options.load(controller.signal)
    }).then(
      inventory => { if (inventory) finish(inventory) },
      error => finish(undefined, `${error instanceof Error ? error.message : 'Unable to check audio sources.'} Retrying automatically.`),
    )
  }
  function visibilityChanged() {
    if (options.visible()) refresh()
    else { cancelPoll?.(); cancelPoll = undefined }
  }
  options.page.addEventListener('visibilitychange', visibilityChanged)
  options.window.addEventListener('focus', refresh)
  refresh()
  return {
    refresh,
    dispose() {
      disposed = true
      cancelPoll?.(); cancelDeadline?.()
      active?.abort(); active = null
      options.page.removeEventListener('visibilitychange', visibilityChanged)
      options.window.removeEventListener('focus', refresh)
    },
  }
}
