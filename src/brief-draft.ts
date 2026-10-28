import { briefWithPeople, type AnalysisState, type AssistantAction, type Brief } from '../shared/analysis'
import { normalizePreparation } from '../shared/brief-templates'
import type { BriefCache } from './brief-cache'

type Send = (action: AssistantAction) => Promise<AnalysisState>
export interface BriefDraftState { draft: Brief; dirty: boolean; saving: boolean; building: boolean; error: string; connected: boolean; storedLocally: boolean }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// Preserve edits made while a save was in flight, including additions/removals.
function rebase(sent: Brief, latest: Brief, saved: Brief): Brief {
  // A first offline visit may create local Me/side IDs before the server replies.
  const mapping = new Map<string, string>()
  for (const [oldId, newId] of [[sent.userParticipantId, saved.userParticipantId], [sent.conversationSideId, saved.conversationSideId], [sent.participants.find(p => p.id === sent.userParticipantId)?.sideId, saved.participants.find(p => p.id === saved.userParticipantId)?.sideId]]) {
    if (oldId && newId && oldId !== newId) mapping.set(oldId, newId)
  }
  if (mapping.size) {
    const remap = (brief: Brief) => {
      const result = structuredClone(brief), id = (value: string) => mapping.get(value) ?? value
      result.participants = result.participants.map(p => ({ ...p, id: id(p.id), sideId: p.sideId ? id(p.sideId) : null }))
      result.sides = result.sides.map(s => ({ ...s, id: id(s.id) }))
      if (result.userParticipantId) result.userParticipantId = id(result.userParticipantId)
      if (result.conversationSideId) result.conversationSideId = id(result.conversationSideId)
      return result
    }
    sent = remap(sent); latest = remap(latest)
  }
  const result = structuredClone(saved)
  for (const key of ['preparation', 'answers', 'userParticipantId', 'conversationSideId'] as const) {
    if (!same(latest[key], sent[key])) Object.assign(result, { [key]: latest[key] })
  }
  for (const key of ['user', 'call'] as const) {
    if (latest.languages[key] !== sent.languages[key]) Object.assign(result.languages, { [key]: latest.languages[key] })
  }
  for (const key of ['objectives', 'participants', 'sides', 'items'] as const) {
    const rows = latest[key].flatMap(item => {
      const before = sent[key].find(row => row.id === item.id)
      const after = saved[key].find(row => row.id === item.id)
      if (!before) return [item]
      if (same(item, before)) return after ? [after] : []
      const merged = { ...(after ?? item) }
      for (const field of Object.keys(item)) {
        if (!same(Reflect.get(item, field), Reflect.get(before, field))) Reflect.set(merged, field, Reflect.get(item, field))
      }
      return [merged]
    })
    const addedRemotely = saved[key].filter(item => !sent[key].some(before => before.id === item.id) && !latest[key].some(local => local.id === item.id))
    Object.assign(result, { [key]: [...rows, ...addedRemotely] })
  }
  return result
}

export class BriefDraftController {
  state: BriefDraftState
  private authoritative: Brief
  private revision = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private flight: Promise<void> | null = null
  private listeners = new Set<(state: BriefDraftState) => void>()
  private disposed = false
  private send: Send
  private delay: number
  private knownUserId: string | null
  private cache?: (value: BriefCache) => boolean
  private epoch: number | null = null
  private buildRevision = 0
  private editable: (brief: Brief, knownUserId?: string | null) => Brief
  constructor(brief: Brief, send: Send, options: { preparation?: boolean; delay?: number; knownUserId?: string | null; connected?: boolean; snapshot?: BriefCache | null; cache?(value: BriefCache): boolean } = {}) {
    this.editable = (value, userId) => briefWithPeople(options.preparation === false ? value : normalizePreparation(value), userId)
    this.send = send; this.delay = options.delay ?? 500; this.knownUserId = options.knownUserId ?? null
    this.cache = options.cache
    const connected = options.connected ?? true
    this.authoritative = structuredClone(connected ? brief : options.snapshot?.base ?? brief)
    const current = this.editable(brief, this.knownUserId)
    const draft = !connected && options.snapshot ? this.editable(options.snapshot.draft, this.knownUserId) : options.snapshot?.pending ? rebase(options.snapshot.base, options.snapshot.draft, current) : current
    this.state = { draft, dirty: !!options.snapshot?.pending || !same(draft, this.authoritative), saving: false, building: false, error: '', connected, storedLocally: false }
  }
  subscribe(listener: (state: BriefDraftState) => void) {
    this.disposed = false; this.listeners.add(listener); this.publish({}); this.schedule()
    return () => { this.listeners.delete(listener) }
  }
  private publish(change: Partial<BriefDraftState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...change }
    if (this.cache) this.state = { ...this.state, storedLocally: this.cache({ base: this.authoritative, draft: this.state.draft, pending: this.state.dirty }) }
    for (const listener of this.listeners) listener(this.state)
  }
  receive(brief: Brief, force = false) {
    if (!force && brief.version <= this.authoritative.version) return
    const previous = this.authoritative
    this.authoritative = structuredClone(brief)
    if (!this.state.saving && !this.state.building) {
      const draft = this.state.dirty ? rebase(previous, this.state.draft, this.editable(brief, this.knownUserId)) : this.editable(brief, this.knownUserId)
      this.publish({ draft, dirty: this.state.dirty || !same(draft, brief), error: '' }); this.schedule()
    }
  }
  setConnected(connected: boolean) {
    if (connected === this.state.connected) return
    if (!connected) { this.epoch = null; this.buildRevision++ }
    this.publish({ connected, building: connected ? this.state.building : false, error: '' }); this.schedule()
  }
  sync(brief: Brief, connected: boolean, epoch: number) {
    if (connected) { this.receive(brief, this.epoch !== epoch); this.epoch = epoch }
    else this.epoch = null
    this.setConnected(connected)
  }
  setSend(send: Send) { this.send = send }
  update(change: Partial<Brief>) {
    this.revision++
    this.publish({ draft: { ...this.state.draft, ...change }, dirty: true, error: '' })
    this.schedule()
  }
  private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null }
  private schedule() {
    this.clearTimer()
    if (this.disposed || !this.state.connected || !this.state.dirty || this.state.saving || this.state.building || this.state.error) return
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, this.delay)
  }
  async flush(): Promise<void> {
    this.clearTimer()
    if (this.flight) { await this.flight; if (this.state.dirty && !this.state.error && !this.state.building) return this.flush(); return }
    if (!this.state.dirty || this.disposed || this.state.building || !this.state.connected) return
    await this.persist(false)
  }
  async retry() { this.publish({ error: '' }); await this.flush() }
  async build() {
    if (this.state.building || this.disposed || !this.state.connected) return
    const buildRevision = ++this.buildRevision
    this.clearTimer(); this.publish({ building: true, error: '' })
    if (this.flight) await this.flight
    if (!this.disposed && this.state.connected && buildRevision === this.buildRevision) await this.persist(true)
    if (buildRevision === this.buildRevision) this.publish({ building: false })
    this.schedule()
  }
  private persist(extract: boolean): Promise<void> {
    const sent = structuredClone(this.state.draft), revision = this.revision, epoch = this.epoch, base = structuredClone(this.authoritative)
    sent.version = this.authoritative.version
    this.publish({ saving: true, error: '' })
    this.flight = (async () => {
      try {
        const saved = await this.send({ action: extract ? 'extract' : 'brief', version: sent.version, brief: sent })
        if (this.disposed) return
        if (!this.state.connected || epoch !== this.epoch) {
          this.publish({ draft: rebase(base, this.state.draft, this.editable(this.authoritative, this.knownUserId)), dirty: true, error: '' }); return
        }
        if (saved.brief.version >= this.authoritative.version) this.authoritative = structuredClone(saved.brief)
        const changed = revision !== this.revision
        const draft = changed ? rebase(sent, this.state.draft, this.editable(this.authoritative, this.knownUserId)) : this.editable(this.authoritative, this.knownUserId)
        this.publish({ draft, dirty: changed, error: extract && (saved.briefStatus ?? saved.status) === 'error' ? saved.briefMessage ?? saved.message ?? 'Could not build objectives. Try again.' : '' })
      } catch (error) {
        if (!this.state.connected || epoch !== this.epoch) this.publish({ draft: rebase(base, this.state.draft, this.editable(this.authoritative, this.knownUserId)), dirty: true, error: '' })
        else this.publish({ error: (error as Error).message })
      } finally {
        this.publish({ saving: false }); this.flight = null; this.schedule()
      }
    })()
    return this.flight
  }
  dispose() { this.disposed = true; this.clearTimer(); this.listeners.clear() }
}
