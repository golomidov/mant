import type { Segment } from '../shared/protocol'

interface Item { id: string; previous: string | null | undefined; seen: number }

export class TranscriptState {
  readonly segments = new Map<string, Segment>()
  private items = new Map<string, Item>()
  private ranks = new Map<string, number>()

  constructor(private sessionId: string, private sourceId: string) {}

  private item(id: string) {
    if (!this.items.has(id)) {
      const seen = this.items.size
      this.items.set(id, { id, previous: undefined, seen })
      this.ranks.set(id, seen)
    }
    return this.items.get(id)!
  }

  committed(id: string, previous: string | null): Segment[] {
    this.item(id).previous = previous
    return this.reorder()
  }

  private reorder(): Segment[] {
    const items = [...this.items.values()].sort((a, b) => a.seen - b.seen)
    const ordered: Item[] = []
    const visited = new Set<string>()
    const visit = (item: Item) => {
      if (visited.has(item.id)) return
      visited.add(item.id)
      const previous = item.previous ? this.items.get(item.previous) : undefined
      if (previous) visit(previous)
      // A null predecessor explicitly identifies the first audio item.
      if (item.previous === null) ordered.unshift(item)
      else ordered.push(item)
    }
    items.forEach(visit)
    this.ranks = new Map(ordered.map((item, index) => [item.id, index]))
    const changes: Segment[] = []
    for (const [id, segment] of this.segments) {
      const [itemId, content] = JSON.parse(id) as [string, number]
      const order = this.ranks.get(itemId)! * 1000 + content
      if (order !== segment.order) {
        const updated = { ...segment, order, revision: segment.revision + 1 }
        this.segments.set(id, updated)
        changes.push(updated)
      }
    }
    return changes
  }

  update(itemId: string, content: number, text: string, final: boolean): Segment[] {
    this.item(itemId)
    const id = JSON.stringify([itemId, content])
    const old = this.segments.get(id)
    if (old?.status === 'final' && !final) return []
    const current: Segment = {
      sessionId: this.sessionId, sourceId: this.sourceId, id,
      order: this.ranks.get(itemId)! * 1000 + content,
      revision: (old?.revision ?? 0) + 1,
      text: final ? text : (old?.text ?? '') + text,
      status: final ? 'final' : 'partial',
    }
    this.segments.set(id, current)
    return [current]
  }
}
