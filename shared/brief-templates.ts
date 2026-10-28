import { briefWithPeople, type Brief } from './analysis'

export interface BriefTemplate {
  id: string
  name: string
  revision: number
  createdAt: string
  updatedAt: string
  preparation: Brief
}
export interface BriefLibrary { templates: BriefTemplate[]; loaded: BriefTemplate | null }

/** Only working preparation is migrated; archives retain their original fields. */
export function normalizePreparation(brief: Brief): Brief {
  const result = structuredClone(brief)
  // Retired language controls can remain protected in persisted or offline drafts.
  result.protectedIds = [...new Set(result.protectedIds.map(id =>
    id === 'language:reply' || id === 'language:interface' ? 'language:user' : id))]
  if (result.answers.trim()) result.preparation += `${result.preparation.trim() ? '\n\n' : ''}Additional context\n${result.answers}`
  result.answers = ''
  return result
}

/** A template contains definitions, never conclusions from a previous call. */
export function preparationDefinitions(brief: Brief): Brief {
  const result = normalizePreparation(brief)
  result.version = 0
  delete result.analysisVersion
  result.objectives = result.objectives.map(({ id, kind, timing, description, completion, origin }) => ({ id, kind, timing: timing ?? 'anytime', description, completion, origin, status: 'unexplored', evidence: [], reason: '', history: [] }))
  return result
}

export function recallPreparation(template: Brief, current: Brief): Brief {
  const result = briefWithPeople(preparationDefinitions(template))
  const me = result.userParticipantId!, mine = current.userParticipantId
  const mySide = result.participants.find(p => p.id === me)?.sideId
  const currentSide = current.participants.find(p => p.id === mine)?.sideId
  // Allocate fresh IDs for all definitions, preserving the app's Me identity.
  const ids = new Map([...result.items, ...result.objectives, ...result.sides, ...result.participants].map(row => [row.id, crypto.randomUUID() as string]))
  if (mine) ids.set(me, mine)
  if (mySide && currentSide) ids.set(mySide, currentSide)
  const remap = (id: string) => ids.get(id) ?? id
  result.items.forEach(row => { row.id = remap(row.id) })
  result.objectives.forEach(row => { row.id = remap(row.id) })
  result.sides.forEach(row => { row.id = remap(row.id) })
  result.participants.forEach(row => { row.id = remap(row.id); if (row.sideId) row.sideId = remap(row.sideId) })
  result.userParticipantId = remap(me)
  if (result.conversationSideId) result.conversationSideId = remap(result.conversationSideId)
  result.protectedIds = result.protectedIds.map(remap)
  result.version = current.version + 1
  result.analysisVersion = result.version
  return result
}

// Compare definitions by stable structure rather than IDs allocated at recall.
export function preparationFingerprint(brief: Brief): string {
  const result = preparationDefinitions(brief)
  const ids = new Map([...result.items, ...result.objectives, ...result.sides, ...result.participants].map((row, index) => [row.id, `definition:${index}`]))
  const ref = (id: string) => ids.get(id) ?? id
  return JSON.stringify({ preparation: result.preparation, items: result.items.map(row => ({ ...row, id: ref(row.id) })), objectives: result.objectives.map(row => ({ ...row, id: ref(row.id) })), sides: result.sides.map(row => ({ ...row, id: ref(row.id) })), participants: result.participants.map(row => ({ ...row, id: ref(row.id), sideId: row.sideId ? ref(row.sideId) : null })), userParticipantId: result.userParticipantId ? ref(result.userParticipantId) : null, conversationSideId: result.conversationSideId ? ref(result.conversationSideId) : null, languages: result.languages, clarifications: result.clarifications, protectedIds: result.protectedIds.map(ref).sort() })
}
