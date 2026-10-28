import { useEffect, useRef, useState } from 'react'
import type { AnalysisState } from '../shared/analysis'
import { preparationFingerprint, type BriefLibrary } from '../shared/brief-templates'
import type { BriefDraftController } from './brief-draft'

async function request(path = '', method = 'GET', body?: unknown) {
  const response = await fetch('/api/briefs' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  const result = await response.json() as BriefLibrary & { analysis?: AnalysisState; error?: string }
  if (!response.ok) throw new Error(result.error ?? 'Could not update saved briefs.')
  return result
}

export function SavedBriefs({ controller, preparation, connected, connectionEpoch, onWorking, focusEditor }: { controller: BriefDraftController; preparation: boolean; connected: boolean; connectionEpoch: number; onWorking(value: boolean): void; focusEditor(): void }) {
  const [library, setLibrary] = useState<BriefLibrary>({ templates: [], loaded: null })
  const [selected, setSelected] = useState('')
  const [name, setName] = useState('')
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const selector = useRef<HTMLSelectElement>(null)
  const focusAfter = useRef<'load' | 'delete' | null>(null)
  useEffect(() => {
    if (working || !focusAfter.current) return
    if (focusAfter.current === 'load') focusEditor()
    else selector.current?.focus()
    focusAfter.current = null
  }, [working, focusEditor])
  useEffect(() => {
    if (!connected) return
    let disposed = false
    void request().then(value => { if (!disposed) { setLibrary(value); setSelected(value.loaded?.id ?? ''); setError('') } }).catch(error => { if (!disposed) setError((error as Error).message) })
    return () => { disposed = true }
  }, [connected, connectionEpoch, preparation])
  const template = library.templates.find(t => t.id === selected)
  const changed = library.loaded && preparationFingerprint(controller.state.draft) !== preparationFingerprint(library.loaded.preparation)
  const blocked = !preparation || !connected || working || controller.state.building
  async function run(action: 'load' | 'create' | 'update' | 'rename' | 'delete') {
    if (blocked || action !== 'create' && !template) return
    setWorking(true); onWorking(true); setError(''); setMessage('')
    try {
      await controller.flush()
      if (!controller.state.connected || controller.state.dirty || controller.state.saving || controller.state.error) throw new Error(controller.state.error || 'Save the current preparation before using saved briefs. Your draft is retained.')
      const body = { name, revision: template?.revision, version: controller.state.draft.version }
      const value = await request(action === 'create' ? '' : '/' + template!.id + (action === 'load' ? '/load' : ''), { load: 'POST', create: 'POST', update: 'PUT', rename: 'PATCH', delete: 'DELETE' }[action], body)
      if (value.analysis) controller.receive(value.analysis.brief, true)
      setLibrary(value)
      setSelected(action === 'delete' ? '' : action === 'rename' ? selected : value.loaded?.id ?? selected)
      if (action === 'create' || action === 'rename') setName('')
      setMessage({ load: 'Brief loaded. Objectives are ready for a new conversation.', create: 'Saved as a new brief.', update: 'Saved brief updated.', rename: 'Saved brief renamed.', delete: 'Saved brief deleted. Current preparation retained.' }[action])
      if (action === 'load' || action === 'delete') focusAfter.current = action
    } catch (error) {
      setError((error as Error).message)
      // Refresh stale revisions without touching the draft or loaded baseline.
      try { const value = await request(); setLibrary(value) } catch { /* Keep the original error visible. */ }
    } finally { setWorking(false); onWorking(false) }
  }
  return <section className="saved-briefs" aria-label="Saved briefs" aria-busy={working}>
    <div className="saved-brief-controls">
      <label className="field">Saved briefs<select ref={selector} value={selected} disabled={blocked} onChange={e => { setSelected(e.target.value); setMessage('') }}><option value="">Choose a saved brief…</option>{library.templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <button disabled={blocked || !template} onClick={() => void run('load')}>Load</button>
      <button disabled={blocked || !template} onClick={() => void run('update')}>Update saved brief</button>
      <button disabled={blocked || !template} onClick={() => void run('delete')}>Delete</button>
    </div>
    <div className="saved-brief-controls">
      <label className="field">Brief name<input value={name} maxLength={160} disabled={blocked} onChange={e => setName(e.target.value)} placeholder="Name for saving or renaming" /></label>
      <button disabled={blocked || !name.trim()} onClick={() => void run('create')}>Save as new</button>
      <button disabled={blocked || !template || !name.trim()} onClick={() => void run('rename')}>Rename</button>
    </div>
    <p className="help">{!preparation ? 'Stop capture or playback, then return to preparation to use saved briefs.' : library.loaded ? `Working from “${library.loaded.name}”${changed ? ' · Differs from saved brief' : ' · Matches saved brief'}` : 'Current preparation autosaves. Named briefs change only when you explicitly save them.'}</p>
    <p role="status" className="help">{working ? 'Updating saved briefs…' : message}</p>
    {error && <p role="alert">{error}</p>}
  </section>
}
