import { appleRequest } from '../server/apple-ai'
import { probeAppleGeneration } from '../server/apple-probe'
export async function probeApple() {
  let failed = false
  for (const engine of ['speech', 'translation', 'foundation']) {
    try {
      // Inventory queries discover languages; asking every engine to support the
      // same fixed list conflates per-language support with engine availability.
      console.log(JSON.stringify({ engine, result: await appleRequest({ action: 'check', engine, languages: [] }, AbortSignal.timeout(15_000)) }))
    } catch (error) { failed = true; console.log(JSON.stringify({ engine, error: error instanceof Error ? error.message : String(error) })) }
  }
  if (process.argv.includes('--probe')) {
    try {
      const result = await appleRequest({ action: 'translate', text: 'Anna non ha accettato 42 unità.', targetLanguage: 'en' }, AbortSignal.timeout(20_000)) as { sourceLanguage?: string; text?: string }
      if (result.sourceLanguage !== 'it' || !result.text || !/Anna/.test(result.text) || !/42/.test(result.text) || !/not|didn't|hasn't|never/i.test(result.text)) throw new Error('Translation lost the source language, name, quantity or negation.')
      console.log(JSON.stringify({ action: 'translate', ok: true, result }))
    } catch (error) { failed = true; console.log(JSON.stringify({ action: 'translate', ok: false, error: error instanceof Error ? error.message : String(error) })) }
    try { console.log(JSON.stringify({ action: 'generate', ok: true, cases: await probeAppleGeneration() })) }
    catch (error) { failed = true; console.log(JSON.stringify({ action: 'generate', ok: false, error: error instanceof Error ? error.message : String(error) })) }
  }
  if (failed) process.exitCode = 1
}
if (import.meta.main) await probeApple()
