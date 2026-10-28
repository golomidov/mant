import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BriefTemplates } from '../server/brief-templates'
import { briefWithPeople, emptyBrief } from '../shared/analysis'
import { normalizePreparation, preparationDefinitions, preparationFingerprint, recallPreparation } from '../shared/brief-templates'
import { briefSchema, validate } from '../server/analysis-schema'
import { BriefDraftController } from '../src/brief-draft'
import { loadBriefCache } from '../src/brief-cache'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mant-briefs-test-'))
  let store = new BriefTemplates(directory)
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { get store() { return store }, restart() { store.close(); store = new BriefTemplates(directory) } }
}
function prepared() {
  const brief = briefWithPeople(emptyBrief())
  brief.preparation = 'Negotiate delivery. Clarification answer: next Friday.'
  brief.languages = { user: 'ru', call: 'en' }
  brief.objectives = [{ id: crypto.randomUUID(), kind: 'say', timing: 'opening', description: 'Explain the deadline.', completion: 'Deadline stated.', origin: 'explicit', status: 'expressed', evidence: [{ segmentId: 'speech', revision: 1 }], reason: 'Already said.', history: [{ status: 'expressed', reason: 'Said.', evidence: [], atMs: 20 }], confirmedByUser: true }]
  brief.items = [{ id: crypto.randomUUID(), category: 'boundary', text: 'No weekends.', origin: 'explicit' }]
  brief.participants.push({ id: crypto.randomUUID(), name: 'Supplier', sideId: brief.conversationSideId! })
  brief.protectedIds.push(brief.objectives[0]!.id, brief.items[0]!.id, 'language:user')
  return brief
}

test('explicit create, duplicate, update, rename and delete persist separately from the draft', () => {
  const f = fixture(), draft = prepared(), original = structuredClone(draft)
  expect(f.store.library()).toEqual({ templates: [], loaded: null })
  const first = f.store.create('  Delivery  ', draft)
  expect(first).toMatchObject({ name: 'Delivery', revision: 1 })
  expect(draft).toEqual(original)
  expect(first.preparation.objectives[0]).toMatchObject({ status: 'unexplored', evidence: [], history: [], reason: '', timing: 'opening' })
  expect(first.preparation.objectives[0]?.confirmedByUser).toBeUndefined()
  expect(first.preparation.items).toEqual(draft.items)
  expect(first.preparation.protectedIds).toEqual(draft.protectedIds)
  draft.preparation = 'A separate draft edit'
  expect(f.store.get(first.id, 1).preparation.preparation).toBe(original.preparation)
  const copy = f.store.create('Delivery copy', draft)
  expect(copy.id).not.toBe(first.id)
  const updated = f.store.update(first.id, 1, { preparation: draft })
  expect(updated.revision).toBe(2)
  const renamed = f.store.update(first.id, 2, { name: 'Renewal' })
  expect(renamed.revision).toBe(3)
  expect(f.store.library().loaded?.name).toBe('Renewal')
  f.restart()
  expect(f.store.get(first.id, 3)).toEqual(renamed)
  expect(f.store.library().loaded).toEqual(renamed)
  f.store.delete(first.id, 3)
  expect(f.store.library().loaded).toBeNull()
  expect(f.store.library().templates.map(t => t.id)).toEqual([copy.id])
  expect(draft.preparation).toBe('A separate draft edit')
})

test('names, revisions, schema and references are validated without partial changes', () => {
  const f = fixture(), brief = prepared(), saved = f.store.create('DELIVERY', brief)
  for (const name of ['', '   ', 'x'.repeat(161), 5]) expect(() => f.store.create(name, brief)).toThrow()
  expect(() => f.store.create('delivery', brief)).toThrow('already has that name')
  const another = f.store.create('Second', brief)
  expect(() => f.store.update(another.id, 1, { name: ' delivery ' })).toThrow('already has that name')
  expect(() => f.store.update(saved.id, 0, { name: 'No' })).toThrow('changed')
  expect(() => f.store.delete(saved.id, '1')).toThrow('changed')
  expect(() => f.store.get(saved.id, 9)).toThrow('changed')
  expect(() => f.store.create('Bad', { ...brief, participants: [{ id: 'bad', name: 'Bad', sideId: 'missing' }] })).toThrow('references')
  expect(() => f.store.create('Unknown protection', { ...brief, protectedIds: [...brief.protectedIds, 'language:unknown'] })).toThrow('references')
  expect(() => f.store.create('Too long', { ...brief, preparation: 'x'.repeat(40001) })).toThrow()
  expect(f.store.get(saved.id, 1)).toEqual(saved)
  expect(f.store.library().templates).toHaveLength(2)
})

test('legacy language protections allow named brief create, update, restart and recall', () => {
  const f = fixture(), brief = prepared()
  brief.protectedIds.push('language:reply', 'language:interface', 'language:call')
  const original = structuredClone(brief)
  const migrated = normalizePreparation(brief)
  expect(migrated.protectedIds).toEqual([...new Set(original.protectedIds.filter(id => !['language:reply', 'language:interface'].includes(id)))])
  expect(normalizePreparation(migrated)).toEqual(migrated)
  const saved = f.store.create('Migrated preparation', brief)
  expect(saved.preparation.protectedIds).toEqual(migrated.protectedIds)
  const updated = f.store.update(saved.id, saved.revision, { preparation: brief })
  f.restart()
  expect(f.store.get(updated.id, updated.revision)).toEqual(updated)
  const recalled = recallPreparation(updated.preparation, briefWithPeople(emptyBrief()))
  expect(recalled.languages).toEqual(brief.languages)
  expect(recalled.preparation).toBe(brief.preparation)
  expect(recalled.protectedIds).toContain('language:user')
  expect(recalled.protectedIds).toContain('language:call')
  expect(recalled.protectedIds).not.toContain('language:reply')
  expect(recalled.protectedIds).not.toContain('language:interface')
  expect(brief).toEqual(original)
})

test('recall resets all conclusions and consistently maps identities and protections', () => {
  const template = prepared(), current = briefWithPeople(emptyBrief())
  const restored = recallPreparation(template, current)
  expect(restored.userParticipantId).toBe(current.userParticipantId)
  expect(restored.participants.find(p => p.id === current.userParticipantId)?.name).toBe(template.participants[0]!.name)
  expect(restored.participants.find(p => p.id === current.userParticipantId)?.sideId).toBe(current.participants[0]!.sideId)
  expect(restored.languages).toEqual(template.languages)
  const objective = restored.objectives[0]!
  expect(objective.id).not.toBe(template.objectives[0]!.id)
  expect(objective).toMatchObject({ status: 'unexplored', evidence: [], reason: '', history: [], timing: 'opening' })
  expect(restored.protectedIds).toContain(objective.id)
  expect(restored.protectedIds).toContain(restored.items[0]!.id)
  expect(restored.protectedIds).toContain(current.userParticipantId!)
  expect(restored.participants[1]!.sideId).toBe(restored.conversationSideId!)
  expect(preparationFingerprint(restored)).toBe(preparationFingerprint(template))
  restored.preparation += ' Different'
  expect(preparationFingerprint(restored)).not.toBe(preparationFingerprint(template))
  expect(template.objectives[0]!.status).toBe('expressed')
})

test('legacy migration is idempotent, lossless at legacy limits, and leaves its input unchanged', () => {
  const brief = prepared(); brief.preparation = 'a'.repeat(24000); brief.answers = 'b'.repeat(12000)
  const migrated = normalizePreparation(brief)
  expect(migrated.preparation).toBe(brief.preparation + '\n\nAdditional context\n' + brief.answers)
  expect(migrated.answers).toBe('')
  expect(normalizePreparation(migrated)).toEqual(migrated)
  expect(brief.answers).toHaveLength(12000)
  expect(validate(briefSchema, migrated)).toEqual(migrated)
  expect(validate(briefSchema, { ...migrated, preparation: 'x'.repeat(40000) }).preparation).toHaveLength(40000)
  expect(preparationDefinitions(brief).preparation).toBe(migrated.preparation)
})

test('offline legacy drafts migrate once and saved archives remain unchanged on opening', () => {
  const base = prepared(); base.answers = 'Ask for dates.'
  const cache = loadBriefCache({ getItem: () => JSON.stringify({ base, draft: base, pending: false }), setItem() {} })!
  expect(cache.pending).toBe(true)
  const offline = new BriefDraftController(base, async () => { throw new Error('offline') }, { connected: false, snapshot: cache })
  cleanup.push(() => offline.dispose())
  expect(offline.state.draft.preparation.match(/Additional context/g)).toHaveLength(1)
  expect(offline.state.draft.answers).toBe('')
  const archive = new BriefDraftController(base, async () => { throw new Error('Must not autosave') }, { preparation: false })
  cleanup.push(() => archive.dispose())
  expect(archive.state.dirty).toBe(false)
  expect(archive.state.draft).toEqual(base)
})
