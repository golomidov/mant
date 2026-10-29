import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { saveSettings } from '../server/backend-settings'
test('all four text tasks execute through keyless local Pi endpoints with independent JSON/tool contracts', async () => {
  const requests: Record<string, any>[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, any>; requests.push(body)
    const tool = body.tools?.[0]?.function?.name
    const content = body.messages.at(-1).content
    const input = JSON.parse(content)
    let output: unknown
    if (body.response_format) output = { translations: [{ segmentId: 's0', revision: 5, sourceLanguage: 'ru', text: 'Anna did not agree to 42 units.' }] }
    else if (tool === 'propose_directions') output = { records: [{ type: 'wait', message: 'Wait for the condition.' }] }
    else if (input.mode === 'BRIEF') output = { sessionId: input.request.sessionId, runId: input.request.runId, requestId: input.request.id, items: [], objectives: [], sides: [], participants: [], languages: { call: 'en', user: 'en' }, clarifications: [] }
    else output = { sessionId: input.request.sessionId, runId: input.request.runId, requestId: input.request.id, observations: [], objectives: [], openQuestions: [], replanReasons: [], translations: [], detectedLanguage: 'en', selectionAssessment: null }
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-one', type: 'function', function: { name: tool, arguments: JSON.stringify(output) } }] } : { role: 'assistant', content: JSON.stringify(output) }
    const chunks = [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }]
    return new Response(chunks.map(c => 'data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', ...c }) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  const dir = await mkdtemp(join(tmpdir(), 'mant-local-')), path = join(dir, 'settings.json')
  try {
    const endpoint = `http://127.0.0.1:${server.port}/v1`
    await saveSettings({ version: 1, connections: { speech: { provider: 'whisper', endpoint: `http://127.0.0.1:${server.port}/inference`, model: 'multilingual' }, tools: { provider: 'local', endpoint, model: 'local-tools' }, json: { provider: 'local', endpoint, model: 'local-json', capabilities: { structured: 'json' } } }, tasks: { transcription: 'speech', translation: 'json', brief: 'tools', analysis: 'tools', suggestions: 'tools' } }, path)
    const root = resolve(import.meta.dir, '..')
    const script = `
import { translateSegments } from ${JSON.stringify(root + '/server/translation.ts')};
import { generateSuggestions } from ${JSON.stringify(root + '/server/suggestion-model.ts')};
import { interpret } from ${JSON.stringify(root + '/server/interpretation.ts')};
import { emptyBrief } from ${JSON.stringify(root + '/shared/analysis.ts')};
const signal = new AbortController().signal, brief = emptyBrief();
const translations = await translateSegments({ sessionId: 'session', targetLanguage: 'en', segments: [{ id: 'original', revision: 5, text: 'Анна не согласилась на 42 единицы.', sessionId: 'session', sourceId: 'source', order: 0, status: 'final' }] }, signal);
const suggestions = []; await generateSuggestions({ sessionId: 'session', runId: 'run', requestId: 'request', revision: 1, briefVersion: 0, brief, observations: [], transcript: [], tail: '', floor: null, selected: null, recent: [], mediaMs: 0, availableAt: 0, style: 'Brief' }, signal, r => suggestions.push(r));
const input = { request: { sessionId: 'session', runId: 'run', id: 'request', inputs: [] }, brief, observations: [], transcript: [], pending: [] };
const preparation = await interpret('BRIEF', input, signal), analysis = await interpret('TRACK', input, signal);
console.log(JSON.stringify({ translations, suggestions, preparation, analysis }));
`
    const runner = join(dir, 'run.ts'); await Bun.write(runner, script)
    const env: Record<string, string | undefined> = { ...process.env, MANT_SETTINGS_PATH: path }; delete env.OPENAI_API_KEY
    const child = Bun.spawn(['bun', '--no-env-file', runner], { env, stdout: 'pipe', stderr: 'pipe' })
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
    expect(await child.exited, await stderr).toBe(0)
    const result = JSON.parse(await stdout)
    expect(result.translations[0]).toMatchObject({ segmentId: 'original', revision: 5, text: 'Anna did not agree to 42 units.' })
    expect(result.suggestions[0].type).toBe('wait')
    expect(result.preparation.requestId).toBe('request'); expect(result.analysis.requestId).toBe('request')
    expect(requests).toHaveLength(4)
    expect(requests[0]!.response_format.type).toBe('json_schema')
    expect(requests.every(r => r.reasoning === undefined && r.prompt_cache_options === undefined)).toBe(true)
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }) }
}, 20_000)
