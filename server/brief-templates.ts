import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { briefSchema, validate } from './analysis-schema'
import { preparationDefinitions, type BriefLibrary, type BriefTemplate } from '../shared/brief-templates'

export class BriefTemplateError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
export class BriefTemplates {
  private db: Database
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true })
    this.db = new Database(join(directory, 'briefs.sqlite'), { create: true })
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS briefs (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, preparation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS brief_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  }
  private row(row: { id: string; name: string; revision: number; created_at: string; updated_at: string; preparation: string }): BriefTemplate {
    return { id: row.id, name: row.name, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, preparation: validate(briefSchema, JSON.parse(row.preparation)) }
  }
  library(): BriefLibrary {
    const rows = this.db.query('SELECT * FROM briefs ORDER BY name_key').all() as Parameters<BriefTemplates['row']>[0][]
    const meta = this.db.query("SELECT value FROM brief_meta WHERE key = 'loaded'").get() as { value: string } | null
    return { templates: rows.map(row => this.row(row)), loaded: meta ? JSON.parse(meta.value) as BriefTemplate : null }
  }
  get(id: string, revision: unknown): BriefTemplate {
    const row = this.db.query('SELECT * FROM briefs WHERE id = ?').get(id) as Parameters<BriefTemplates['row']>[0] | null
    if (!row) throw new BriefTemplateError('Saved brief no longer exists.', 404)
    if (!Number.isInteger(revision) || row.revision !== revision) throw new BriefTemplateError('Saved brief changed. Refresh the list before trying again.', 409)
    return this.row(row)
  }
  private name(value: unknown, except = '') {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) throw new BriefTemplateError('Enter a brief name from 1 to 160 characters.')
    const name = value.trim(), key = name.toLocaleLowerCase('en-US')
    if (this.db.query('SELECT id FROM briefs WHERE name_key = ? AND id != ?').get(key, except)) throw new BriefTemplateError('A saved brief already has that name.', 409)
    return { name, key }
  }
  private definitions(value: unknown) {
    const result = preparationDefinitions(validate(briefSchema, value))
    validate(briefSchema, result)
    const rows = [...result.items, ...result.objectives, ...result.sides, ...result.participants]
    const ids = new Set(rows.map(row => row.id))
    if (ids.size !== rows.length || result.participants.some(p => p.sideId && !result.sides.some(s => s.id === p.sideId)) || result.userParticipantId && !result.participants.some(p => p.id === result.userParticipantId) || result.conversationSideId && !result.sides.some(s => s.id === result.conversationSideId) || result.protectedIds.some(id => !ids.has(id) && !['language:user', 'language:call'].includes(id))) throw new BriefTemplateError('Invalid preparation references.')
    return result
  }
  remember(template: BriefTemplate | null) {
    this.db.query("INSERT INTO brief_meta VALUES ('loaded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(template))
  }
  create(value: unknown, preparation: unknown) {
    return this.db.transaction(() => {
      const { name, key } = this.name(value), id = crypto.randomUUID(), now = new Date().toISOString(), definitions = this.definitions(preparation)
      this.db.query('INSERT INTO briefs VALUES (?, ?, ?, 1, ?, ?, ?)').run(id, name, key, now, now, JSON.stringify(definitions))
      const template = this.get(id, 1); this.remember(template); return template
    })()
  }
  update(id: string, revision: unknown, change: { name?: unknown; preparation?: unknown }) {
    return this.db.transaction(() => {
      const previous = this.get(id, revision), { name, key } = this.name(change.name ?? previous.name, id)
      const definitions = change.preparation === undefined ? previous.preparation : this.definitions(change.preparation)
      this.db.query('UPDATE briefs SET name = ?, name_key = ?, revision = revision + 1, updated_at = ?, preparation = ? WHERE id = ?').run(name, key, new Date().toISOString(), JSON.stringify(definitions), id)
      const template = this.get(id, previous.revision + 1)
      if (change.preparation !== undefined) this.remember(template)
      else { const loaded = this.library().loaded; if (loaded?.id === id) this.remember({ ...loaded, name, revision: template.revision, updatedAt: template.updatedAt }) }
      return template
    })()
  }
  delete(id: string, revision: unknown) {
    this.db.transaction(() => {
      this.get(id, revision)
      this.db.query('DELETE FROM briefs WHERE id = ?').run(id)
      if (this.library().loaded?.id === id) this.remember(null)
    })()
  }
  close() { this.db.close() }
}
