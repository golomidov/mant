import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { captureSelectionKey, defaultCaptureGains, parseCaptureGains, parseCaptureSelection, type CaptureGains, type CaptureInventory, type CaptureSelection } from '../shared/capture'

/** Durable setup is independent of whichever recording or replay is current. */
export class CaptureSetupStore {
  private db: Database
  constructor(directory: string) {
    this.db = new Database(join(directory, 'capture-setup.sqlite'), { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('CREATE TABLE IF NOT EXISTS setup (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }
  private read<T>(key: string): T | null {
    const row = this.db.query<{ value: string }, [string]>('SELECT value FROM setup WHERE key = ?').get(key)
    return row ? JSON.parse(row.value) as T : null
  }
  private write(key: string, value: unknown) { this.db.query('INSERT OR REPLACE INTO setup VALUES (?, ?)').run(key, JSON.stringify(value)) }
  get selection() { return this.read<CaptureSelection>('selection') }
  get route() { return this.read<string>('route') }
  rememberDevices(inventory: CaptureInventory) {
    this.db.transaction(() => {
      for (const device of inventory.microphones) this.write(`microphone-name:${device.id}`, device.name)
      for (const target of inventory.targets) this.write(`app-name:${target.bundleId}`, target.name)
    })()
  }
  get labels() {
    const selection = this.selection
    return { microphone: selection ? this.read<string>(`microphone-name:${selection.microphoneId}`) : null,
      playback: !selection ? null : selection.remote.kind === 'application' ? this.read<string>(`app-name:${selection.remote.bundleId}`) : this.read<string>(`microphone-name:${selection.remote.deviceId}`) }
  }
  private key(selection: CaptureSelection) { return `config:${captureSelectionKey(selection)}:${this.route ?? 'unknown'}` }
  observeRoute(route: string) {
    this.write('route', route)
  }
  configure(selection: CaptureSelection, gains?: CaptureGains) {
    this.write('selection', parseCaptureSelection(selection))
    if (gains) this.write(this.key(selection), { gains: parseCaptureGains(gains) })
  }
  gains(selection = this.selection): CaptureGains {
    return selection ? this.read<{ gains: CaptureGains }>(this.key(selection))?.gains ?? defaultCaptureGains() : defaultCaptureGains()
  }
  close() { this.db.close() }
}
