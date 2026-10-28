import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ReportStore } from './report-store'
import { ReportContext, useStore } from './report-hooks'
export function ReportProvider({ children }: { children: ReactNode }) {
 const [store] = useState(() => new ReportStore())
 return <ReportContext.Provider value={store}>{children}</ReportContext.Provider>
}
export function StatusArea() {
  const store = useStore()
  const reports = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const highest = reports[0]
  const count = reports.filter(r => r.severity === 'error' || r.severity === 'warning').length
  const announcement = reports.filter(r => r.severity !== 'success' || r.source !== 'Connection').map(r => `${r.source}: ${r.summary}`).join('. ')
  useLayoutEffect(() => {
    if (!open) return
    panel.current?.focus({ preventScroll: true })
    const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close() } }
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close() }
    document.addEventListener('keydown', key); document.addEventListener('click', outside)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('click', outside) }
  }, [open])
  return <div className="status-area" ref={root}>
    <button ref={trigger} className="status-trigger" data-severity={highest?.severity} aria-expanded={open} aria-controls="current-reports" onClick={() => setOpen(!open)}>
      <span className="status-summary">{highest?.summary ?? 'All clear'}</span><span className="status-count" aria-label={`${count} errors and warnings`}>{count || ''}</span><span aria-hidden="true">⌄</span>
    </button>
    <span className="visually-hidden" role="status" aria-atomic="true">{announcement}</span>
    {open && <div id="current-reports" className="status-dropdown" ref={panel} tabIndex={-1} role="region" aria-label="Current reports">
      <strong>Current reports</strong>
      {!reports.length && <p>All clear</p>}
      {reports.map(report => <article key={report.id} data-severity={report.severity}><small>{report.source} · {report.severity === 'progress' ? 'In progress' : report.severity}</small><p>{report.summary}</p>{report.details && <p>{report.details}</p>}{report.action && <button disabled={report.action.pending || report.action.disabled} onClick={() => void report.action?.run()}>{report.action.label}</button>}</article>)}
    </div>}
  </div>
}
