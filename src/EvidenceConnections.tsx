import { useLayoutEffect, useState, type RefObject } from 'react'
import type { Evidence } from '../shared/analysis'
import type { Selection } from './Assistant'

type Point = { x: number; y: number; clipped: boolean }
type Connection = { id: string; start: Point; end: Point; revised: boolean }

// Measurements are rebuilt after list scroll, disclosure, text revisions and resize.
// Clamped endpoints terminate at the list edge instead of pointing through hidden content.
export function EvidenceConnections({ workspace, selection, evidence }: { workspace: RefObject<HTMLElement | null>; selection: Selection; evidence: Evidence[] }) {
  const [lines, setLines] = useState<Connection[]>([])
  useLayoutEffect(() => {
    const root = workspace.current
    if (!root || !selection) return
    let frame = 0
    const measure = () => {
      frame = 0
      const origin = root.getBoundingClientRect()
      const source = document.getElementById(`${selection.type}-${selection.id}`)
      const sourceSummary = source?.querySelector('summary')
      const transcript = root.querySelector<HTMLElement>('.transcript')
      const sourceList = source?.closest('.column-list')
      const sourceColumn = source?.closest('.workspace-column')
      const lines: Connection[] = []
      const bounds = transcript?.getBoundingClientRect()
      const from = sourceSummary?.getBoundingClientRect()
      const list = sourceList?.getBoundingClientRect()
      const sourceHidden = !sourceColumn || !from || !list || from.bottom < list.top || from.top > list.bottom
      for (const item of [...new Map(evidence.map(e => [e.segmentId, e])).values()]) {
        const target = document.getElementById(`segment-${item.segmentId}`)
        const box = target?.getBoundingClientRect()
        const revised = !!target && Number(target.dataset.revision) !== item.revision
        const position = !box || !bounds ? 'unavailable' : box.top >= bounds.bottom ? 'below' : box.bottom <= bounds.top ? 'above' : 'visible'
        if (!box || !bounds || !from || !list || !sourceColumn) continue
        const left = from.left < bounds.left
        const startY = Math.max(list.top + 8, Math.min(list.bottom - 8, from.top + from.height / 2))
        const endY = Math.max(bounds.top + 8, Math.min(bounds.bottom - 8, box.top + Math.min(box.height / 2, 36)))
        lines.push({ id: item.segmentId, start: { x: (left ? from.right : from.left) - origin.left, y: startY - origin.top, clipped: sourceHidden }, end: { x: (left ? bounds.left + 9 : bounds.right - 9) - origin.left, y: endY - origin.top, clipped: position !== 'visible' }, revised })
      }
      setLines(lines)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const resize = new ResizeObserver(schedule)
    resize.observe(root)
    root.querySelectorAll('.column-list, .transcript, .insight-card').forEach(el => resize.observe(el))
    const mutation = new MutationObserver(schedule)
    root.querySelectorAll('.column-list, .transcript').forEach(el => mutation.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open', 'data-revision'] }))
    root.addEventListener('scroll', schedule, true)
    root.addEventListener('toggle', schedule, true)
    window.addEventListener('resize', schedule)
    measure()
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); root.removeEventListener('scroll', schedule, true); root.removeEventListener('toggle', schedule, true); window.removeEventListener('resize', schedule) }
  }, [workspace, selection, evidence])
  if (!selection || !evidence.length) return null
  return <svg className={`evidence-connections ${selection.type}`} aria-hidden="true">
      {lines.map(line => { const bend = (line.start.x + line.end.x) / 2; return <g key={line.id} className={line.revised || line.start.clipped || line.end.clipped ? 'connection-clipped' : ''}><path d={`M ${line.start.x} ${line.start.y} C ${bend} ${line.start.y}, ${bend} ${line.end.y}, ${line.end.x} ${line.end.y}`} /><circle cx={line.start.x} cy={line.start.y} r={3} /><circle cx={line.end.x} cy={line.end.y} r={line.end.clipped ? 5 : 3} /></g> })}
    </svg>
}
