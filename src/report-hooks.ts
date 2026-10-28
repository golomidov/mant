import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { ReportStore, type Report } from './report-store'
export const ReportContext = createContext<ReportStore | null>(null)
export function useStore() { const store = useContext(ReportContext); if (!store) throw new Error('ReportProvider is required'); return store }
export function useReports(reports: readonly Report[], scope = '', preserve = false) {
  const store = useStore()
  const [owner] = useState(() => Symbol('reports'))
  const ids = useRef<string[]>([])
  useEffect(() => () => { if (!preserve) store.remove(owner) }, [store, owner, scope, preserve])
  useEffect(() => {
    const next = reports.map(report => report.id)
    ids.current.filter(id => !next.includes(id)).forEach(id => store.remove(owner, id))
    reports.forEach(report => store.set(owner, report))
    ids.current = next
  })
}
export function useReport(id: string, report: Omit<Report, 'id'> | null, scope = '', preserve = false) {
  useReports(report ? [{ ...report, id }] : [], scope, preserve)
}
