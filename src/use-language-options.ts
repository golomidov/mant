import { useEffect, useState } from 'react'
import type { LanguageOptions } from '../shared/backend-languages'
export function useLanguageOptions(user: string, conversation: string, connectionEpoch: number) {
  const [state, setState] = useState<{ key: string; options?: LanguageOptions; error?: string }>({ key: '' })
  const key = `${user}:${conversation}:${connectionEpoch}`
  useEffect(() => {
    const controller = new AbortController()
    let sequence = 0
    const refresh = async () => {
      const request = ++sequence
      try {
        const response = await fetch('/api/languages?' + new URLSearchParams({ user, conversation }), { signal: controller.signal })
        if (!response.ok) throw new Error('Unable to check available languages. Check the server connection.')
        const options = await response.json() as LanguageOptions
        if (!controller.signal.aborted && request === sequence) setState({ key, options })
      } catch (error) { if (!controller.signal.aborted && request === sequence) setState({ key, error: error instanceof Error ? error.message : 'Unable to check available languages.' }) }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 30_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [key, user, conversation])
  return state.key === key ? state : { key }
}
