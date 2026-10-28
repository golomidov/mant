import { Type, StringEnum } from '@earendil-works/pi-ai'
import type { DirectionDraft } from '../shared/suggestions'
import { supportedLanguageCodes } from '../shared/languages'
import { evidenceSchema, validate } from './analysis-schema'

const text = Type.String({ minLength: 1, maxLength: 500 })
const id = Type.String({ minLength: 1, maxLength: 160 })
export const draftSchema = Type.Object({
  directionId: Type.Union([id, Type.Null()]), label: Type.String({ minLength: 1, maxLength: 80 }),
  move: StringEnum(['answer', 'clarify', 'explain', 'check', 'negotiate', 'confirm', 'return'] as const),
  objectiveIds: Type.Array(id, { maxItems: 8 }), meaning: text,
  opening: Type.String({ minLength: 4, maxLength: 240 }), continuation: Type.Union([Type.String({ maxLength: 350 }), Type.Null()]),
  basis: Type.Optional(StringEnum(['brief', 'transcript', 'neutral'] as const)),
  briefReferences: Type.Optional(Type.Array(id, { maxItems: 16 })),
  evidence: Type.Array(evidenceSchema, { minItems: 0, maxItems: 16 }), observationIds: Type.Array(id, { maxItems: 12 }),
  assumptions: Type.Array(text, { maxItems: 8 }), status: StringEnum(['provisional', 'ready'] as const),
  // Optional only for reading older saved records. Native output requires both.
  language: Type.Optional(StringEnum(supportedLanguageCodes)),
  translation: Type.Optional(Type.Union([Type.Null(), Type.Object({ language: StringEnum(supportedLanguageCodes), opening: Type.String({ minLength: 1, maxLength: 600 }), continuation: Type.Union([Type.String({ minLength: 1, maxLength: 800 }), Type.Null()]) }, { additionalProperties: false })])),
}, { additionalProperties: false })
const identity = { sessionId: id, runId: id, requestId: id }
export const recordSchema = Type.Union([
  Type.Object({ ...identity, type: Type.Literal('direction'), recommended: Type.Boolean(), direction: draftSchema }, { additionalProperties: false }),
  Type.Object({ ...identity, type: Type.Literal('wait'), message: text }, { additionalProperties: false }),
])
export type SuggestRecord = { sessionId: string; runId: string; requestId: string } & (
  { type: 'direction'; recommended: boolean; direction: DirectionDraft } | { type: 'wait'; message: string })

// Application identities and recommendation order are deterministic metadata,
// not model output. One stable schema serves every call and every request.
const wireRecordSchema = Type.Union([
  Type.Object({ type: Type.Literal('direction'), direction: Type.Object({ ...Type.Required(draftSchema, { additionalProperties: false }).properties, basis: draftSchema.properties.basis, briefReferences: draftSchema.properties.briefReferences }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('wait'), message: text }, { additionalProperties: false }),
])
const strictWireRecordSchema = Type.Union([
  Type.Object({ type: Type.Literal('direction'), direction: Type.Required(draftSchema, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('wait'), message: text }, { additionalProperties: false }),
])
export const suggestionOutputSchema = Type.Object({ records: Type.Array(strictWireRecordSchema, { minItems: 1, maxItems: 3 }) }, { additionalProperties: false })

// Frame complete array elements, respecting nested objects, escaped strings and
// arbitrary token boundaries. Validate each element before early publication;
// validate the complete envelope at EOF. Never repair or publish partial JSON.
export class SuggestionDecoder {
  private buffer = ''
  private cursor = 0
  private phase: 'prefix' | 'first' | 'next' | 'record' | 'separator' | 'end' | 'done' = 'prefix'
  private start = 0
  private closers: string[] = []
  private quoted = false
  private escaped = false
  private count = 0
  private waiting = false
  private identity: Pick<SuggestRecord, 'sessionId' | 'runId' | 'requestId'>
  constructor({ sessionId, runId, requestId }: Pick<SuggestRecord, 'sessionId' | 'runId' | 'requestId'>, private publish: (record: SuggestRecord) => void) {
    this.identity = { sessionId, runId, requestId }
  }
  push(delta: string) {
    this.buffer += delta
    if (this.buffer.length > 72_000) throw new Error('Suggestion response exceeds limit.')
    if (this.phase === 'prefix') {
      const match = /^\s*\{\s*"records"\s*:\s*\[/.exec(this.buffer)
      if (!match) {
        // The schema fixes the first key; tolerate whitespace and split tokens.
        if (this.buffer.includes('[') || this.buffer.length > 100) throw new Error('Invalid suggestion envelope.')
        return
      }
      this.cursor = match[0].length; this.phase = 'first'
    }
    while (this.cursor < this.buffer.length) {
      const char = this.buffer[this.cursor++]!
      if (this.phase !== 'record' && /\s/.test(char)) continue
      if (this.phase === 'first' || this.phase === 'next') {
        if (char === ']' && this.phase === 'first') { this.phase = 'end'; continue }
        if (char !== '{') throw new Error('Invalid suggestion record.')
        if (this.count >= 3 || this.waiting) throw new Error('Invalid suggestion sequence.')
        this.start = this.cursor - 1; this.closers = ['}']; this.phase = 'record'
      } else if (this.phase === 'record') {
        if (this.cursor - this.start > 24_000) throw new Error('Suggestion record exceeds limit.')
        if (this.quoted) {
          if (this.escaped) this.escaped = false
          else if (char === '\\') this.escaped = true
          else if (char === '"') this.quoted = false
        } else if (char === '"') this.quoted = true
        else if (char === '{' || char === '[') this.closers.push(char === '{' ? '}' : ']')
        else if (char === '}' || char === ']') {
          if (char !== this.closers.pop()) throw new Error('Invalid suggestion JSON.')
          if (!this.closers.length) {
            const record = validate(wireRecordSchema, JSON.parse(this.buffer.slice(this.start, this.cursor)))
            if (record.type === 'wait' && this.count) throw new Error('Wait cannot follow directions.')
            this.waiting = record.type === 'wait'
            this.count++
            this.publish(record.type === 'wait' ? { ...this.identity, ...record } : { ...this.identity, ...record, recommended: this.count === 1 })
            this.phase = 'separator'
          }
        }
      } else if (this.phase === 'separator') {
        if (char === ',') this.phase = 'next'
        else if (char === ']') this.phase = 'end'
        else throw new Error('Invalid suggestion separator.')
      } else if (this.phase === 'end') {
        if (char !== '}') throw new Error('Invalid suggestion envelope.')
        this.phase = 'done'
      } else throw new Error('Unexpected content after suggestions.')
    }
  }
  finish() {
    if (this.phase !== 'done') throw new Error('Incomplete suggestion response.')
    validate(Type.Object({ records: Type.Array(wireRecordSchema, { minItems: 1, maxItems: 3 }) }, { additionalProperties: false }), JSON.parse(this.buffer))
  }
}
