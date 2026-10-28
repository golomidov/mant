import { normalizePreparation } from '../shared/brief-templates'
import type { Brief } from '../shared/analysis'

export interface BriefCache { base: Brief; draft: Brief; pending: boolean }
interface Storage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const key = 'mant-call-brief-v1'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
function brief(value: unknown): value is Brief {
  if (!object(value) || !Number.isInteger(value.version) || Number(value.version) < 0 || typeof value.preparation !== 'string' || typeof value.answers !== 'string' || !object(value.languages)) return false
  if (!['call'].every(key => typeof (value.languages as Record<string, unknown>)[key] === 'string')) return false
  if (value.languages.user !== undefined && typeof value.languages.user !== 'string') return false
  if (['userParticipantId', 'conversationSideId'].some(key => value[key] !== undefined && typeof value[key] !== 'string')) return false
  if (!Array.isArray(value.protectedIds) || !value.protectedIds.every(id => typeof id === 'string') || !Array.isArray(value.clarifications) || !value.clarifications.every(q => typeof q === 'string')) return false
  const rows = (key: string, valid: (row: Record<string, unknown>) => boolean) => Array.isArray(value[key]) && (value[key] as unknown[]).every(row => object(row) && typeof row.id === 'string' && valid(row))
  return rows('participants', p => typeof p.name === 'string' && (p.sideId === null || typeof p.sideId === 'string')) &&
    rows('sides', s => typeof s.name === 'string') && rows('items', i => typeof i.text === 'string' && typeof i.category === 'string' && typeof i.origin === 'string') &&
    rows('objectives', o => ['question', 'say', 'outcome'].includes(String(o.kind)) && ['description', 'completion', 'reason', 'status', 'origin'].every(key => typeof o[key] === 'string') && (o.timing === undefined || ['opening', 'anytime'].includes(String(o.timing))) && Array.isArray(o.evidence) && Array.isArray(o.history))
}
export function loadBriefCache(storage?: Storage): BriefCache | null {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem(key) ?? 'null')
    if (!object(value) || !brief(value.base) || !brief(value.draft) || typeof value.pending !== 'boolean') return null
    const draft = normalizePreparation(value.draft)
    return { base: value.base, draft, pending: value.pending || JSON.stringify(draft) !== JSON.stringify(value.draft) }
  } catch { return null }
}
export function saveBriefCache(value: BriefCache, storage?: Storage): boolean {
  try { (storage ?? localStorage).setItem(key, JSON.stringify(value)); return true } catch { return false }
}
