import type { InterpretationInput } from './interpretation'
import type { SuggestionInput } from '../shared/suggestions'

// ASR IDs contain nested escaped JSON. Keep those stable in application state,
// but give the model short, unambiguous references for this request only.
function references(value: unknown, mapping: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map(item => references(item, mapping))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'segmentId' && typeof item === 'string' ? mapping.get(item) ?? item
      : key === 'attributionVersions' && item && typeof item === 'object'
        ? Object.fromEntries(Object.entries(item).map(([id, revision]) => [mapping.get(id) ?? id, revision]))
        : references(item, mapping),
  ]))
}

function referenceMap(original: { transcript: { id: string }[] }) {
  const reserved = new Set(original.transcript.map(s => s.id))
  JSON.stringify(original, (key, value) => { if (key === 'segmentId' && typeof value === 'string') reserved.add(value); return value })
  const aliases = new Map<string, string>()
  const used = new Set<string>()
  for (const segment of original.transcript) {
    const digest = new Bun.CryptoHasher('sha256').update(segment.id).digest('hex')
    const base = `s${digest.slice(0, 12)}`
    let suffix = 0, alias = base
    while (reserved.has(alias) || used.has(alias)) alias = `${base}_${++suffix}`
    aliases.set(segment.id, alias)
    used.add(alias)
  }
  return aliases
}

export function interpretationReferences(original: InterpretationInput) {
  const aliases = referenceMap(original)
  const input = references(original, aliases) as InterpretationInput
  input.transcript.forEach(segment => { segment.id = aliases.get(segment.id)! })
  input.pending = original.pending.map(id => aliases.get(id) ?? id)
  const canonical = new Map([...aliases].map(([id, alias]) => [alias, id]))
  return { input, restore: (proposal: unknown) => references(proposal, canonical) }
}

export function suggestionReferences(original: SuggestionInput) {
  const aliases = referenceMap(original)
  const input = references(original, aliases) as SuggestionInput
  input.transcript.forEach(segment => { segment.id = aliases.get(segment.id)! })
  const canonical = new Map([...aliases].map(([id, alias]) => [alias, id]))
  return { input, restore: (record: unknown) => references(record, canonical) }
}
