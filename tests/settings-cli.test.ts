import { expect, test } from 'bun:test'
import * as prompts from '@clack/prompts'
import { configure } from '../scripts/settings'
import { legacySettings, saveSettings } from '../server/backend-settings'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
test('CLI cancellation after editing a draft connection leaves the settings file byte-for-byte unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mant-cli-')), path = join(dir, 'settings.json'), previous = process.env.MANT_SETTINGS_PATH
  try {
    await saveSettings(legacySettings(), path); const before = await Bun.file(path).text()
    process.env.MANT_SETTINGS_PATH = path
    const selections: unknown[] = ['connection', 'local', 'json', prompts.CANCEL_SYMBOL]
    const texts = ['gemma', 'gemma-3', 'http://127.0.0.1:1234/v1', '', '8192', '4096']
    let cancelled = false
    const ui = { ...prompts, intro() {}, cancel() { cancelled = true }, select: async () => selections.shift(), text: async () => texts.shift() } as unknown as typeof prompts
    await configure(ui)
    expect(cancelled).toBe(true)
    expect(await Bun.file(path).text()).toBe(before)
  } finally { if (previous === undefined) delete process.env.MANT_SETTINGS_PATH; else process.env.MANT_SETTINGS_PATH = previous; await rm(dir, { recursive: true, force: true }) }
})
