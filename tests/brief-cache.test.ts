import { expect, test } from 'bun:test'
import { loadBriefCache, saveBriefCache } from '../src/brief-cache'
import { briefWithPeople, emptyBrief } from '../shared/analysis'

test('local brief cache restores pending edits and ignores malformed or unavailable storage', () => {
  let value: string | null = null
  const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next } }
  const base = briefWithPeople(emptyBrief()), draft = { ...base, preparation: 'My pending goal.' }
  expect(saveBriefCache({ base, draft, pending: true }, storage)).toBe(true)
  expect(loadBriefCache(storage)).toEqual({ base, draft, pending: true })
  value = 'not JSON'; expect(loadBriefCache(storage)).toBeNull()
  value = JSON.stringify({ base, draft: { ...draft, participants: [null] }, pending: true }); expect(loadBriefCache(storage)).toBeNull()
  const denied = { getItem: () => { throw new Error('Disabled') }, setItem: () => { throw new Error('Disabled') } }
  expect(loadBriefCache(denied)).toBeNull()
  expect(saveBriefCache({ base, draft, pending: true }, denied)).toBe(false)
})
