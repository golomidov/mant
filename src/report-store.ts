export type Severity = 'error' | 'warning' | 'progress' | 'success'
export interface Report {
  id: string
  source: string
  severity: Severity
  summary: string
  details?: string
  action?: { label: string; pending?: boolean; disabled?: boolean; run(): void | Promise<unknown> }
}
export interface CurrentReport extends Report { changed: number; owner: symbol }
const priority: Record<Severity, number> = { error: 0, warning: 1, progress: 2, success: 3 }
export const sortReports = (reports: readonly CurrentReport[]) => [...reports].sort((a, b) => priority[a.severity] - priority[b.severity] || b.changed - a.changed)
const signature = (r: Report) => JSON.stringify([r.source, r.severity, r.summary, r.details, r.action?.label, !!r.action?.pending, !!r.action?.disabled])
export class ReportStore {
  private reports = new Map<string, CurrentReport>()
  private sequence = 0
  private snapshot: readonly CurrentReport[] = []
  private listeners = new Set<() => void>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snapshot
  private emit() { this.snapshot = sortReports([...this.reports.values()]); this.listeners.forEach(listener => listener()) }
  set(owner: symbol, report: Report) {
    const previous = this.reports.get(report.id)
    if (previous && signature(previous) === signature(report)) {
      previous.action = report.action
      previous.owner = owner
      return
    }
    this.reports.set(report.id, { ...report, owner, changed: ++this.sequence }); this.emit()
  }
  remove(owner: symbol, id?: string) {
    let changed = false
    for (const [key, report] of this.reports) if (report.owner === owner && (!id || key === id)) { this.reports.delete(key); changed = true }
    if (changed) this.emit()
  }
}
