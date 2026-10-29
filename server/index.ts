import { BriefTemplates, BriefTemplateError } from './brief-templates'
import { normalizePreparation, recallPreparation } from '../shared/brief-templates'
import { BackgroundDelivery } from './background-delivery'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { Type } from '@earendil-works/pi-ai'
import type { Recording, ServerEvent, ServerPayload } from '../shared/protocol'
import { active, parseCommand } from '../shared/protocol'
import { DiagnosticLog, configureDiagnostics, diagnostic, isolate } from './diagnostics'
import { Archives } from './archive'
import { FileAudioSource } from './audio'
import { ConversationSession } from './session'
import { TranscriptReplay } from './replay'
import { createTranscription } from './backend-registry'
import { backendLanguageOptions, requireBackendLanguages, resolveRecognitionLanguages } from './backend-languages'
import { backendHealth } from './backend-health'
import { safeMessage } from './errors'
import { ConversationTracker } from './tracking'
import { briefWithPeople, emptyBrief, type AnalysisMode, type Brief } from '../shared/analysis'
import { SuggestionCoordinator } from './suggestions'
import type { SuggestionMode } from '../shared/suggestions'
import { startUsageLog } from './usage'
import { briefSchema, evidenceSchema, validate } from './analysis-schema'
import { NativeCaptureSession, captureInventory } from './native-capture'
import { parseCaptureSelection, parseCaptureGains, type CaptureSetupState, type CaptureInventory } from '../shared/capture'
import { captureAttribution } from './capture-attribution'
import { CaptureSetupStore } from './capture-setup'

const directory = mkdtempSync(join(tmpdir(), 'mant-'))
// Resolve from this project, not the launching shell's working directory.
const archives = new Archives(resolve(import.meta.dir, '..', process.env.TRANSCRIPT_DIR ?? 'data/transcripts'))
const briefTemplates = new BriefTemplates(archives.directory)
let loadingPreparation = false
const diagnostics = new DiagnosticLog(archives.directory)
configureDiagnostics(diagnostics)
console.log(`Mant diagnostics: ${diagnostics.path}`)
archives.onError = () => {
  if (current) { current.view.persistenceMessage = 'Recording or transcript persistence failed. Live transcription continues.'; broadcast({ type: 'status', session: structuredClone(current.view) }, current.view.id) }
}
const backgrounds = new Set<ServerWebSocket<unknown>>()
const backgroundDelivery = new BackgroundDelivery<ServerWebSocket<unknown>>()
const backgroundSockets = new WeakSet<ServerWebSocket<unknown>>()
let lastTranscriptAt = performance.now()
const sources = new Map<string, { recording: Recording; path: string; contentType: string }>()
const clients = new Set<ServerWebSocket<unknown>>()
let current: ConversationSession | TranscriptReplay | NativeCaptureSession | null = null
const captureSetup = new CaptureSetupStore(archives.directory)
function captureSetupState(): CaptureSetupState {
  return { selection: captureSetup.selection, gains: captureSetup.gains(), routeSignature: captureSetup.route, labels: captureSetup.labels }
}
let captureInventoryWork: Promise<CaptureInventory> | null = null
let sequence = 0
let uploading = false
let shuttingDown = false
let starting = false
let reviewGeneration = 0
let tracker: ConversationTracker | null = null
let suggestions: SuggestionCoordinator | null = null
let analysisTailStart: number | null = null
function createPreparation(brief: Brief) { return new ConversationTracker({ sessionId: 'preparation', enabled: false, autoTranslate: false,
  brief,
  publish: (state, reason) => {
    if (!current) suggestions?.analysisChanged(reason)
    archives.savePreparation(state)
    if (!current) for (const socket of [...clients, ...backgrounds]) send(socket, { type: 'analysis', analysis: state })
  },
}) }
let preparation = createPreparation(briefWithPeople(normalizePreparation((await archives.preparation())?.brief ?? emptyBrief()), captureSetup.selection?.localParticipantId))
archives.savePreparation(preparation.state)

function attachTracker(sessionId: string, brief: Brief, enabled: boolean, journalId: string | null, options: { autoTranslate?: boolean } = {}) {
  tracker?.dispose()
  suggestions?.dispose(); suggestions = null
  analysisTailStart = null
  const attached = new ConversationTracker({ sessionId, brief, enabled, autoTranslate: options.autoTranslate,
    selection: () => suggestions?.selection() ?? null,
    assess: value => suggestions?.assess(value),
    latest: id => current?.view.id === sessionId ? current.segments.get(id) : undefined,
    attribution: segment => current ? captureAttribution(segment, current.view.source, tracker?.state.brief ?? brief) : undefined,
    publish: (state, reason, effectiveMs) => {
      if (current?.view.id !== sessionId) return
      if (state.journalId && reason !== 'progress') {
        const mediaMs = current.view.diagnostics.mediaMs
        const tailMs = Math.max(0, effectiveMs - mediaMs,
          current instanceof TranscriptReplay ? current.availablePositionMs - mediaMs : 0,
          analysisTailStart === null ? 0 : (performance.now() - analysisTailStart) * (current.view.replay?.speed ?? 1))
        try {
          archives.append(state.journalId, { kind: 'analysis', atMs: current.view.diagnostics.mediaMs,
            tailMs, effectiveMs, reason, state })
        } catch {
          attached.state.status = state.status = 'error'
          attached.state.message = state.message = 'Analysis could not be persisted. Transcript delivery continues.'
        }
      }
      if (reason === 'brief_user' || reason === 'brief_model') {
        if (current instanceof ConversationSession || current instanceof NativeCaptureSession) {
          const session = current, version = state.brief.version
          void resolveRecognitionLanguages(state.brief).then(languages => { if (current === session && attached.state.brief.version === version) session.setLanguages(languages) }).catch(error => {
            attached.state.message = safeMessage(error instanceof Error ? error.message : 'Unable to apply conversation language.')
            for (const socket of [...clients, ...backgrounds]) send(socket, { type: 'error', message: attached.state.message }, sessionId)
          })
        }
        // Keep pre-call edits as well as their session-positioned history.
        preparation.state.brief = normalizePreparation(state.brief)
        isolate('preparation-persistence', sessionId, () => archives.savePreparation(preparation.state))
      }
      for (const socket of [...clients, ...backgrounds]) send(socket, { type: 'analysis', analysis: state }, sessionId)
      isolate('suggestion-analysis', sessionId, () => suggestions?.analysisChanged(reason))
    },
  })
  attached.state.journalId = journalId
  tracker = attached
  return attached
}

function attachSuggestions(sessionId: string, mode: SuggestionMode) {
  const attached = new SuggestionCoordinator({ sessionId, mode,
    analysis: () => sessionId === 'preparation' ? preparation.state : tracker!.state,
    latest: id => current?.view.id === sessionId ? current.segments.get(id) : undefined,
    media: () => current?.view.diagnostics.mediaMs ?? 0,
    publish: (state, reason) => {
      if (sessionId === 'preparation' ? !!current : current?.view.id !== sessionId) return
      if (tracker?.state.journalId && current) {
        const mediaMs = current.view.diagnostics.mediaMs
        const tailMs = Math.max(0, current instanceof TranscriptReplay ? current.availablePositionMs - mediaMs : 0,
          analysisTailStart === null ? 0 : (performance.now() - analysisTailStart) * (current.view.replay?.speed ?? 1))
        try { archives.append(tracker.state.journalId, { kind: 'suggestion', atMs: mediaMs, tailMs, reason, state }) }
        catch { attached.state.status = state.status = 'error'; attached.state.message = state.message = 'Suggestion persistence failed; transcript continues.' }
      }
      for (const socket of [...clients, ...backgrounds]) send(socket, { type: 'suggestions', suggestions: state }, sessionId === 'preparation' ? undefined : sessionId)
    },
  })
  suggestions = attached
  if (mode === 'predictive') attached.analysisChanged('initial')
  return attached
}

attachSuggestions('preparation', 'predictive')

async function startReplay(archiveId: string, speed: import('../shared/protocol').ReplaySpeed, analysisMode: AnalysisMode, startMs = 0, suggestionMode: SuggestionMode = 'saved') {
  const saved = await archives.get(archiveId)
  if (!saved.audioAvailable) throw new Error('Attach the original recording before replaying this transcript.')
  if (startMs > saved.durationMs) throw new Error('Seek position is outside the saved timeline.')
  tracker?.dispose(); suggestions?.dispose()
  if (current instanceof TranscriptReplay) await current.shutdown(true)
  const initialBrief = await archives.initialBrief(archiveId) ?? preparation.state.brief
  const session = new TranscriptReplay(saved, archives, speed, payload => broadcast(payload, session.view.id), {
    startMs, analysisMode, suggestionMode,
    suggestion: row => {
      if (current?.view.id !== session.view.id || !suggestions) return
      if (suggestions.state.mode === 'saved') suggestions.restore(row.state)
      else suggestions.replayMark(row.state, row.reason)
    },
    analysis: row => {
      if (current?.view.id !== session.view.id || !tracker) return
      if (session.view.replay?.analysisMode === 'saved') tracker.restore(row.state)
      else tracker.replayUserEdit(row.state, row.reason, row.atMs + (row.tailMs ?? 0))
    },
    transcript: row => {
      if (tracker?.state.journalId) isolate('replay-persistence', session.view.id, () => { if (tracker?.state.journalId) archives.append(tracker.state.journalId, {
        ...row, atMs: Math.max(startMs, row.atMs + (row.tailMs ?? 0)), tailMs: 0,
      }) })
    },
  })
  current = session
  // A recompute starts without saved observations, summaries or objective
  // conclusions. Only user/brief events released by the replay clock enter it.
  const attached = attachTracker(session.view.id, initialBrief, analysisMode === 'recompute', null)
  if (analysisMode === 'saved') attached.state.status = 'saved'
  if (analysisMode === 'recompute' || suggestionMode === 'predictive' || suggestionMode === 'baseline') {
    archives.create(session.view.id, { ...saved.source, replayId: session.view.id })
    attached.state.journalId = session.view.id
  }
  attachSuggestions(session.view.id, suggestionMode)
  void session.start()
  attached.publishInitial()
  suggestions?.publishInitial()
}

function send(socket: ServerWebSocket<unknown>, payload: ServerPayload, sessionId: string | null = current?.view.id ?? null) {
  if (payload.type === 'analysis' || payload.type === 'suggestions' || payload.type === 'background') {
    if (!backgrounds.has(socket)) return
    backgroundDelivery.enqueue(socket, payload, sessionId); return
  }
  if (backgrounds.has(socket)) return
  if (payload.type === 'snapshot') { const { analysis: _analysis, suggestions: _suggestions, ...control } = payload; payload = control }
  const event: ServerEvent = { ...payload, sessionId, seq: ++sequence }
  try { if (socket.getBufferedAmount() > 256_000 || socket.send(JSON.stringify(event)) === 0) { diagnostic('disconnect', { sessionId, workType: 'control-socket', reason: 'control-congestion', socketBufferedBytes: socket.getBufferedAmount() }); socket.close(1013, 'Client is too slow. Reconnect for a snapshot.') } }
  catch { diagnostic('error', { sessionId, workType: 'control-socket', reason: 'send-failed' }) }
}
function restoreBackground(socket: ServerWebSocket<unknown>) {
  backgroundDelivery.remove(socket)
  send(socket, { type: 'background', analysis: (tracker ?? preparation).state, suggestions: suggestions?.state })
}
const deliveryTimer = setInterval(() => backgroundDelivery.drain(() => ++sequence), 50)

function broadcast(payload: ServerPayload, sessionId: string) {
  if ((payload.type === 'status' || payload.type === 'ended') && payload.session.mode === 'live') {
    const source = sources.get(payload.session.source.id)
    if (source && payload.session.source.replayId) source.recording.replayId = payload.session.source.replayId
  }
  for (const socket of [...clients, ...backgrounds]) send(socket, payload, sessionId)
  if (current?.view.id !== sessionId) return
  if (!tracker) return
  if (payload.type === 'status' || payload.type === 'ended') {
    if (payload.session.phase === 'configuring') lastTranscriptAt = performance.now()
    if (['draining', 'ended'].includes(payload.session.phase)) analysisTailStart ??= performance.now()
    else analysisTailStart = null
    if (payload.session.mode === 'live' && payload.session.phase === 'ready' && !tracker.state.journalId) {
      tracker.state.journalId = sessionId
      tracker.publishInitial()
      suggestions?.publishInitial()
    }
  }
  if (payload.type === 'ended' && current instanceof NativeCaptureSession) {
    tracker.pauseTracking(); suggestions?.dispose()
  }
  if (payload.type === 'transcript') {
    const attached = tracker
    const atMs = payload.mediaMs ?? current.view.diagnostics.mediaMs
    const availableAt = performance.now()
    // Forward first. No model work or analysis persistence is on the live text path.
    lastTranscriptAt = performance.now()
    setTimeout(() => {
      isolate('tracking-ingest', sessionId, () => attached.ingest(payload.segment, atMs, availableAt), () => { attached.state.status = 'error'; attached.state.message = 'Tracking ingest failed. Transcript continues.' })
      if (current?.view.id === sessionId) isolate('suggestion-ingest', sessionId, () => suggestions?.ingest(payload.segment, atMs), () => { if (suggestions) { suggestions.state.status = 'error'; suggestions.state.message = 'Suggestion ingest failed. Transcript continues.' } })
    }, 0)
  }
}

const server = Bun.serve<unknown>({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 3001),
  maxRequestBodySize: 512 * 1024 * 1024,
  idleTimeout: 60,
  async fetch(request, instance) {
    const url = new URL(request.url)
    // Local-only service: reject cross-origin mutation and WebSocket requests.
    const origin = request.headers.get('origin')
    if (origin && origin !== url.origin && origin !== 'http://127.0.0.1:5173') {
      return Response.json({ error: 'Cross-origin access denied. Open the SPA on http://127.0.0.1:5173 or the server origin.' }, { status: 403 })
    }
    if (shuttingDown) return new Response('Server is shutting down.', { status: 503 })
    try {
      if (url.pathname === '/api/briefs' || url.pathname.startsWith('/api/briefs/')) {
        if (request.method === 'GET' && url.pathname === '/api/briefs') return Response.json(briefTemplates.library())
        if (current) throw new BriefTemplateError('Return to preparation before using saved briefs.', 409)
        if (loadingPreparation) throw new BriefTemplateError('Preparation is being loaded. Try again.', 409)
        const raw = await request.text()
        if (raw.length > 200_000) throw new BriefTemplateError('Saved brief request is too large.')
        const body = JSON.parse(raw) as Record<string, unknown>
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BriefTemplateError('Invalid saved brief request.')
        if (current || loadingPreparation || starting || uploading) throw new BriefTemplateError('Wait for the current operation and return to preparation.', 409)
        const match = /^\/api\/briefs\/([\da-f-]{36})(\/load)?$/.exec(url.pathname)
        const assertDraft = () => {
          if (current || loadingPreparation || starting || uploading || preparation.state.briefStatus === 'analyzing' || body.version !== preparation.state.brief.version) throw new BriefTemplateError('Preparation changed. Wait for saving to finish and try again.', 409)
        }
        if (request.method === 'POST' && url.pathname === '/api/briefs') {
          await archives.persistence.flush(join(archives.directory, 'preparation.jsonl'))
          assertDraft()
          briefTemplates.create(body.name, preparation.state.brief)
        } else if (match && match[2] && request.method === 'POST') {
          await archives.persistence.flush(join(archives.directory, 'preparation.jsonl'))
          assertDraft()
          const template = briefTemplates.get(match[1]!, body.revision)
          loadingPreparation = true
          let replacement: ConversationTracker | null = null
          try {
            replacement = createPreparation(recallPreparation(template.preparation, preparation.state.brief))
            await archives.savePreparation(replacement.state)
            await archives.persistence.flush(join(archives.directory, 'preparation.jsonl'))
            briefTemplates.remember(template)
            preparation.dispose(); preparation = replacement; replacement = null
            suggestions?.dispose(); attachSuggestions('preparation', 'predictive')
            for (const socket of [...clients, ...backgrounds]) send(socket, { type: 'analysis', analysis: preparation.state })
          } catch (error) {
            // A failed recall must leave the previous draft as the latest durable preparation.
            await archives.savePreparation(preparation.state)
            throw error
          } finally { replacement?.dispose(); loadingPreparation = false }
        } else if (match && !match[2] && request.method === 'PUT') {
          await archives.persistence.flush(join(archives.directory, 'preparation.jsonl'))
          assertDraft()
          briefTemplates.update(match[1]!, body.revision, { preparation: preparation.state.brief })
        } else if (match && !match[2] && request.method === 'PATCH') {
          if (typeof body.name !== 'string') throw new BriefTemplateError('Enter a brief name.')
          briefTemplates.update(match[1]!, body.revision, { name: body.name })
        } else if (match && !match[2] && request.method === 'DELETE') briefTemplates.delete(match[1]!, body.revision)
        else return new Response('Method not allowed.', { status: 405 })
        return Response.json({ ...briefTemplates.library(), analysis: preparation.state })
      }
      if (url.pathname === '/api/capture/guide' && request.method === 'GET') return new Response(Bun.file(resolve(import.meta.dir, '../docs/macos-capture.md')), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      if (url.pathname === '/api/capture/setup') {
        if (request.method === 'POST') {
          if (current && active(current.view.phase)) throw new Error('Stop the current session before changing devices.')
          const body = await request.json() as Record<string, unknown>
          captureSetup.configure(parseCaptureSelection(body.selection))
        }
        return Response.json(await captureSetupState())
      }
      if (url.pathname === '/api/capture/back' && request.method === 'POST') {
        if (current && active(current.view.phase)) throw new Error('Stop the recording before returning to setup.')
        if (current instanceof TranscriptReplay) await current.shutdown(true)
        tracker?.dispose(); tracker = null
        suggestions?.dispose(); suggestions = null
        current = null
        const prepared = attachSuggestions('preparation', 'predictive')
        for (const socket of [...clients, ...backgrounds]) send(socket, { type: 'snapshot', session: null, segments: [], analysis: preparation.state, suggestions: prepared.state })
        return Response.json(await captureSetupState())
      }
      if (url.pathname === '/api/capture/gains' && request.method === 'POST') {
        const body = await request.json() as Record<string, unknown>
        const selection = parseCaptureSelection(body.selection), gains = parseCaptureGains(body.gains)
        if (current && active(current.view.phase)) {
          if (!(current instanceof NativeCaptureSession) || body.sessionId !== current.view.id) throw new Error('Capture session changed. Reload the setup.')
          if (JSON.stringify(selection) !== JSON.stringify(current.view.source.capture!.selection)) throw new Error('Use the active capture devices when adjusting levels.')
          current.setGains(gains)
        }
        captureSetup.configure(selection, gains)
        return Response.json(await captureSetupState())
      }
      if (url.pathname === '/api/capture/devices' && request.method === 'POST') {
        if (!captureInventoryWork) {
          captureInventoryWork = captureInventory().then(inventory => {
            captureSetup.rememberDevices(inventory)
            if (inventory.routeSignature) captureSetup.observeRoute(inventory.routeSignature)
            return inventory
          }).finally(() => { captureInventoryWork = null })
        }
        return Response.json(await captureInventoryWork)
      }
      if (url.pathname === '/api/capture/start' && request.method === 'POST') {
        if (loadingPreparation) throw new Error('Wait for preparation to finish loading.')
        if (starting || uploading || (current && active(current.view.phase))) throw new Error('Stop the current session and wait for pending operations first.')
        starting = true
        try {
          const body = await request.json() as Record<string, unknown>
          if (body.diagnostic === true) throw new Error('Audio checks are no longer supported. Start a normal capture.')
          await requireBackendLanguages(preparation.state.brief, 'start')
          const recognition = await resolveRecognitionLanguages(preparation.state.brief)
          const selection = { ...parseCaptureSelection(body.selection), localParticipantId: preparation.state.brief.userParticipantId ?? null }
          if (selection.localParticipantId && !preparation.state.brief.participants.some(p => p.id === selection.localParticipantId)) throw new Error('Select your participant from the saved brief.')
          captureSetup.configure(selection)
          if (current instanceof TranscriptReplay) await current.shutdown(true)
          const session = new NativeCaptureSession({ selection, delay: body.delay === 'low' ? 'low' : 'minimal', archives,
            expectedRoute: captureSetup.route ?? undefined, gains: captureSetup.gains(selection),
            routeChanged: route => captureSetup.observeRoute(route),
            transport: (session, source, delay, callbacks) => createTranscription(session, source, delay, callbacks, recognition),
            emit: payload => broadcast(payload, session.view.id),
            boundary: (source, atMs) => {
              if (source === 'remote-playback') suggestions?.turnEnd(Math.max(0, atMs))
            },
          })
          current = session
          const style = suggestions?.state.style ?? 'Short, natural, conversational.'
          attachTracker(session.view.id, preparation.state.brief, true, null)
          attachSuggestions(session.view.id, 'predictive').configure('predictive', style, selection.localParticipantId)

          void session.start()
          return Response.json({ sessionId: session.view.id })
        } finally { starting = false }
      }
      if (url.pathname === '/api/diagnostics' && request.method === 'POST') {
        const value = await request.json() as Record<string, unknown>
        const event = ['background-reconnect', 'playback-pause'].includes(String(value.event)) ? String(value.event) : 'browser-event'
        diagnostic(event, { sessionId: current?.view.id, workType: 'browser', reason: ['control-disconnect', 'control-congestion', 'background-disconnect', 'background-connected', 'media-pause', 'media-waiting'].includes(String(value.reason)) ? String(value.reason) : 'unspecified' })
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/ws' || url.pathname === '/ws/background') {
        return instance.upgrade(request, { data: { background: url.pathname === '/ws/background' } }) ? undefined : new Response('WebSocket upgrade required.', { status: 426 })
      }
      if (url.pathname === '/api/assistant') {
        const target = tracker ?? preparation
        if (request.method === 'GET') return Response.json(target.state)
        if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405 })
        if (loadingPreparation) throw new Error('Wait for preparation to finish loading.')
        const raw = await request.text()
        if (raw.length > 200_000) throw new Error('Brief edit exceeds the 200 KB limit.')
        const body: unknown = JSON.parse(raw)
        if (!body || typeof body !== 'object') throw new Error('Invalid assistant command.')
        if (loadingPreparation || target !== (tracker ?? preparation)) throw new Error('Preparation or session changed. Try saving again.')
        const command = body as Record<string, unknown>
        if (command.sessionId !== target.state.sessionId) throw new Error('The session changed. Reload the current state.')
        if (current instanceof TranscriptReplay && target === tracker && !target.state.journalId && command.action !== 'retry') {
          // Editing saved playback creates an independent journal, retaining all
          // transcript revisions released so far. Never mutate the source run.
          await archives.forkAt(current.view.replay!.archiveId, current.view.id, Math.max(current.view.diagnostics.mediaMs, current.availablePositionMs))
          target.state.journalId = current.view.id
        }
        const atMs = current?.view.diagnostics.mediaMs ?? 0
        if (typeof command.action === 'string' && command.action.startsWith('suggest_')) {
          if (!suggestions || command.runId !== suggestions.state.runId) throw new Error('Suggestion run changed. Use the current session.')
          const number = (key: string) => { const value = command[key]; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid suggestion timestamp or revision.'); return value }
          const string = (key: string) => { const value = command[key]; if (typeof value !== 'string' || value.length > 500) throw new Error('Invalid suggestion command.'); return value }
          if (command.action === 'suggest_config' && ['off', 'predictive', 'baseline'].includes(String(command.mode)) && (command.userParticipantId === null || typeof command.userParticipantId === 'string')) { suggestions.configure(command.mode as 'off' | 'predictive' | 'baseline', string('style'), command.userParticipantId as string | null); if (current?.view.replay) current.view.replay.suggestionMode = command.mode as SuggestionMode }
          else if (command.action === 'suggest_another') suggestions.another()
          else if (command.action === 'suggest_rephrase' && ['simpler', 'shorter', 'alternative'].includes(String(command.transformation))) suggestions.rephrase(string('id'), number('version'), command.transformation as 'simpler' | 'shorter' | 'alternative')
          else if (command.action === 'suggest_select') suggestions.select(string('id'), number('version'))
          else if (command.action === 'suggest_release') suggestions.release(string('selectionId'))
          else throw new Error('Invalid suggestion command.')
          return Response.json(suggestions.state)
        }
        if ((command.action === 'brief' || command.action === 'extract') && command.brief !== undefined) {
          await requireBackendLanguages(validate(briefSchema, command.brief), 'edit', target.state.brief)
          if (loadingPreparation || target !== (tracker ?? preparation)) throw new Error('Preparation or session changed. Try saving again.')
        }
        if (command.action === 'brief' && Number.isInteger(command.version)) target.editBrief(target === preparation ? normalizePreparation(validate(briefSchema, command.brief)) : command.brief, command.version as number, atMs)
        else if (command.action === 'extract') {
          if (command.brief !== undefined || command.version !== undefined) {
            if (!Number.isInteger(command.version)) throw new Error('Invalid brief version.')
            await target.extractBrief(atMs, { brief: target === preparation ? normalizePreparation(validate(briefSchema, command.brief)) : command.brief, version: command.version as number })
          } else await target.extractBrief(atMs)
        }
        else if (command.action === 'retry') await target.retry()
        else if (command.action === 'retry_translation') await target.retryTranslations()
        else if (command.action === 'confirm_objective' && typeof command.id === 'string' && Number.isInteger(command.version) && Array.isArray(command.evidence)) target.confirmObjective(command.id, command.version as number, validate(Type.Array(evidenceSchema, { maxItems: 32 }), command.evidence), atMs)
        else if (command.action === 'discard' && typeof command.id === 'string' && Number.isInteger(command.version)) {
          target.discardObservation(command.id, command.version as number, atMs)
          if (current instanceof TranscriptReplay && current.view.replay) { current.view.replay.analysisMode = 'recompute'; target.resumeTracking() }
        }
        else if (command.action === 'correct' && typeof command.id === 'string' && Number.isInteger(command.version) && typeof command.meaning === 'string' && ['provisional', 'established', 'retracted'].includes(String(command.status))) target.correctObservation(command.id, command.version as number, command.meaning, command.status as 'provisional' | 'established' | 'retracted', atMs)
        else if (command.action === 'attribute' && Array.isArray(command.segmentIds) && command.segmentIds.length <= 64 && command.segmentIds.every(id => typeof id === 'string') && (command.participantId === null || typeof command.participantId === 'string') && (command.sideId === null || typeof command.sideId === 'string') && typeof command.sourceLabel === 'string') target.attribute(command.segmentIds, command.participantId, command.sideId, command.sourceLabel, atMs)
        else throw new Error('Invalid assistant command.')
        if (target === preparation) await archives.persistence.flush(join(archives.directory, 'preparation.jsonl'))
        return Response.json(target.state)
      }
      if (url.pathname === '/api/library' && request.method === 'GET') {
        const sessions = await archives.list()
        return Response.json({ media: await archives.recordings(sessions), sessions })
      }
      if (url.pathname === '/api/archives' && request.method === 'GET') return Response.json(await archives.list())
      if (url.pathname === '/api/archives' && request.method === 'POST') {
        if (!request.body) throw new Error('Choose a Mant JSONL transcript file to import.')
        return Response.json(await archives.import(request.body))
      }
      const review = /^\/api\/archives\/([\da-f-]{36})\/review$/.exec(url.pathname)
      if (review && request.method === 'POST') {
        if (loadingPreparation || starting || current && active(current.view.phase)) return Response.json({ error: 'Stop playback or capture before loading a saved call.' }, { status: 409 })
        const generation = ++reviewGeneration
        const saved = await archives.get(review[1]!)
        const session = new TranscriptReplay(saved, archives, 1, payload => broadcast(payload, session.view.id))
        const snapshot = await session.inspect()
        if (request.signal.aborted || generation !== reviewGeneration) return new Response(null, { status: 204 })
        if (starting || current && active(current.view.phase)) return Response.json({ error: 'The active session changed. Select the saved call again after stopping.' }, { status: 409 })
        starting = true
        try {
          if (current instanceof TranscriptReplay) await current.shutdown(true)
          current = session
          const attached = attachTracker(session.view.id, snapshot.analysis?.brief ?? emptyBrief(), false, null, { autoTranslate: false })
          for (const segment of session.segments.values()) attached.ingest(segment, saved.durationMs)
          if (snapshot.analysis) attached.restore(snapshot.analysis)
          else { attached.state.status = 'saved'; attached.publishInitial() }
          const reply = attachSuggestions(session.view.id, 'saved')
          for (const segment of session.segments.values()) reply.ingest(segment, saved.durationMs)
          if (snapshot.suggestions) reply.restore(snapshot.suggestions)
          for (const socket of [...clients, ...backgrounds]) send(socket, { type: 'snapshot', session: structuredClone(session.view), segments: [...session.segments.values()], analysis: attached.state, suggestions: reply.state })
          return Response.json({ sessionId: session.view.id })
        } finally { starting = false }
      }
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        if (uploading || starting || (current && active(current.view.phase))) return Response.json({ error: 'Stop the current session before uploading another recording.' }, { status: 409 })
        if (!request.body) return Response.json({ error: 'Choose a nonempty audio recording.' }, { status: 400 })
        uploading = true
        const path = join(directory, crypto.randomUUID())
        const writer = Bun.file(path).writer()
        try {
          const hasher = new Bun.CryptoHasher('sha256')
          let size = 0
          for await (const chunk of request.body) {
            size += chunk.byteLength
            if (size > 512 * 1024 * 1024) throw new Error('Recording exceeds the 512 MB upload limit.')
            hasher.update(chunk)
            writer.write(chunk)
            await writer.flush()
          }
          await writer.end()
          if (!size) throw new Error('The recording is empty.')
          const id = hasher.digest('hex')
          const recording: Recording = {
            id, name: decodeURIComponent(request.headers.get('x-file-name') ?? 'Recording').slice(0, 240),
            size, replayId: await archives.latest(id),
          }
          const stored = await archives.keepAudio(recording, path, request.headers.get('content-type') ?? 'application/octet-stream')
          for (const entry of sources.values()) rmSync(entry.path, { force: true })
          sources.clear()
          sources.set(id, { recording, path, contentType: stored.contentType })
          return Response.json(recording)
        } catch (error) {
          await Promise.resolve(writer.end()).catch(() => {})
          rmSync(path, { force: true })
          throw error
        } finally { uploading = false }
      }
      const media = /^\/api\/sources\/([a-f0-9]{64})\/audio$/.exec(url.pathname)
      if (media) {
        const source = sources.get(media[1]!) ?? await archives.audio(media[1]!)
        if (!source) return new Response('Original recording is missing. Attach its original audio file to replay.', { status: 404 })
        const file = Bun.file(source.path)
        const range = request.headers.get('range')
        const headers = { 'Content-Type': source.contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range)
          if (!match) return new Response(null, { status: 416 })
          const start = Number(match[1])
          const end = Math.min(Number(match[2] || file.size - 1), file.size - 1)
          if (start > end || start >= file.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } })
          return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${file.size}` } })
        }
        return new Response(file, { headers })
      }
      const archive = /^\/api\/archives\/([\da-f-]{36})$/.exec(url.pathname)
      if (archive) {
        await archives.flush(archive[1]!)
        const file = Bun.file(archives.path(archive[1]!))
        if (!await file.exists()) return new Response('Archive not found.', { status: 404 })
        return new Response(file, { headers: { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${archive[1]}.jsonl"` } })
      }
      if (url.pathname === '/api/languages') return Response.json(await backendLanguageOptions(url.searchParams.get('user') ?? 'en', url.searchParams.get('conversation') ?? ''))
      if (url.pathname === '/api/health') { const backends = await backendHealth(); return Response.json({ ok: true, ffmpeg: !!Bun.which('ffmpeg'), configured: backends.every(t => t.available), backends }) }
      if (url.pathname.startsWith('/api/')) return new Response('Not found.', { status: 404 })
      const asset = resolve('dist', `.${decodeURIComponent(url.pathname)}`)
      if (asset !== resolve('dist') && !asset.startsWith(`${resolve('dist')}/`)) return new Response('Not found.', { status: 404 })
      const file = Bun.file(asset)
      if (await file.exists() && url.pathname !== '/') return new Response(file)
      const index = Bun.file('dist/index.html')
      if (await index.exists()) return new Response(index)
      return new Response('Run bun run dev for the Vite SPA, or bun run build first.', { status: 404 })
    } catch (error) {
      if (error instanceof BriefTemplateError) return Response.json({ error: error.message }, { status: error.status })
      return Response.json({ error: error instanceof Error ? safeMessage(error.message) : 'Request failed.' }, { status: 400 })
    }
  },
  websocket: {
    maxPayloadLength: 8192,
    backpressureLimit: 256_000,
    closeOnBackpressureLimit: true,
    open(socket) {
      if ((socket.data as { background?: boolean })?.background) {
        backgrounds.add(socket); backgroundSockets.add(socket); restoreBackground(socket)
        diagnostic('reconnect', { sessionId: current?.view.id, workType: 'background-socket', reason: 'opened' }); return
      }
      clients.add(socket)
      send(socket, { type: 'snapshot', session: current ? structuredClone(current.view) : null, segments: current ? [...current.segments.values()] : [], analysis: (tracker ?? preparation).state, suggestions: suggestions?.state })
    },
    async message(socket, message) {
      if (backgroundSockets.has(socket)) { restoreBackground(socket); return }
      try {
        if (loadingPreparation) throw new Error('Wait for preparation to finish loading.')
        const command = parseCommand(JSON.parse(String(message)))
        if ('sessionId' in command) {
          if (!current || command.sessionId !== current.view.id) return
          try {
            if (command.type === 'seek') {
              if (!(current instanceof TranscriptReplay) || !current.view.replay) throw new Error('Seeking is available for saved replay only.')
              if (starting) return
              starting = true
              try { await startReplay(current.view.replay.archiveId, current.view.replay.speed, current.view.replay.analysisMode ?? 'saved', command.playbackMs, current.view.replay.suggestionMode ?? 'saved') }
              finally { starting = false }
            } else if (command.type === 'speed') {
              if (!(current instanceof TranscriptReplay)) throw new Error('Playback speed can only change during saved transcript replay.')
              current.setSpeed(command.speed, command.playbackMs)
            } else if (command.type === 'stop') {
              if (current instanceof TranscriptReplay) {
                if (command.reason === 'eof') current.endPlayback(command.playbackMs)
                else current.stop(command.playbackMs)
              } else current.stop(command.playbackMs)
            } else current.clock(command.playbackMs)
          } catch (error) { void current.fail(error instanceof Error ? error : new Error('Invalid playback clock.')) }
        } else {
          if ('archiveId' in command && current instanceof TranscriptReplay && current.view.phase === 'paused' &&
              current.view.replay?.archiveId === command.archiveId && current.view.replay.analysisMode === (command.analysisMode ?? 'saved') && current.view.replay.suggestionMode === (command.suggestionMode ?? 'saved') && !command.restart) {
            current.resume(command.speed)
            return
          }
          if (current && active(current.view.phase)) {
            send(socket, { type: 'status', session: structuredClone(current.view) })
            return
          }
          if (starting) return
          starting = true
          try {
            if (current instanceof TranscriptReplay && current.view.phase === 'paused') await current.shutdown(true)
            if ('archiveId' in command) {
              await startReplay(command.archiveId, command.speed, command.analysisMode ?? 'saved', 0, command.suggestionMode ?? 'saved')
              return
            }
            if (uploading) throw new Error('Wait for the recording upload to finish.')
            if (!Bun.which('ffmpeg')) throw new Error('FFmpeg is missing. Install ffmpeg and restart the server.')
            let source = sources.get(command.sourceId)
            if (!source) {
              const stored = await archives.audio(command.sourceId)
              const recording = stored && (await archives.recordings()).find(media => media.id === command.sourceId)
              if (stored && recording) source = { recording, ...stored }
            }
            if (!source) throw new Error('Recording is unavailable. Upload it again.')
            await requireBackendLanguages(preparation.state.brief, 'start')
            const recognition = await resolveRecognitionLanguages(preparation.state.brief)
            const session = new ConversationSession({
              source: source.recording, mode: command.mode, delay: command.delay,
              audio: new FileAudioSource(source.path), archives,
              transport: (session, source, delay, callbacks) => createTranscription(session, source, delay, callbacks, recognition),
              emit: payload => broadcast(payload, session.view.id),
            })
            current = session
            attachTracker(session.view.id, preparation.state.brief, true, null)
            attachSuggestions(session.view.id, 'predictive')
            void current.start()
          } finally { starting = false }
        }
      } catch (error) { send(socket, { type: 'error', message: error instanceof Error ? safeMessage(error.message) : 'Invalid command.' }) }
    },
    close(socket, code, reason) { clients.delete(socket); backgrounds.delete(socket); backgroundDelivery.remove(socket); diagnostic('disconnect', { sessionId: current?.view.id, workType: backgroundSockets.has(socket) ? 'background-socket' : 'control-socket', status: code, reason: reason ? 'socket-closed-with-reason' : 'socket-closed' }) },
  },
})

let healthAt = performance.now()
let maxEventLoopDelay = 0
const healthTimer = setInterval(() => {
  const now = performance.now(); maxEventLoopDelay = Math.max(maxEventLoopDelay, now - healthAt - 1000); healthAt = now
  if (!current || current.view.mode !== 'live' || !active(current.view.phase)) return
  if (now - lastHealth < 5000) return
  lastHealth = now
  const view = current.view
  diagnostic('health', { sessionId: view.id, sourceId: view.source.id, audioReceivedMs: view.capture ? Object.values(view.capture.sources).reduce((n, s) => n + s.receivedMs, 0) : view.diagnostics.mediaMs, audioSentMs: view.diagnostics.sentMs, audioBacklogMs: view.diagnostics.queuedMs, unfinishedTurns: ('transcriptionHealth' in current ? current.transcriptionHealth?.unfinishedTurns : 0) ?? 0, lastTranscriptMs: now - lastTranscriptAt, eventLoopDelayMs: maxEventLoopDelay, persistenceBacklog: archives.persistence.backlog, persistenceBytes: archives.persistence.backlogBytes, socketBufferedBytes: [...clients, ...backgrounds].reduce((n, socket) => n + socket.getBufferedAmount(), 0) })
  maxEventLoopDelay = 0
}, 1000)
let lastHealth = 0
const stopUsageLog = startUsageLog(() => current?.view.id ?? null)

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  tracker?.dispose()
  suggestions?.dispose()
  preparation.dispose()
  briefTemplates.close()
  await current?.shutdown()
  clearInterval(deliveryTimer); clearInterval(healthTimer)
  try { await archives.shutdown() } catch { diagnostic('error', { workType: 'persistence', reason: 'shutdown-flush-failed' }) }
  await diagnostics.shutdown()
  captureSetup.close()
  for (const socket of [...clients, ...backgrounds]) socket.close(1001, 'Server shutting down.')
  stopUsageLog()
  await server.stop(true)
  rmSync(directory, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
console.log(`Mant server listening at http://127.0.0.1:${server.port}`)
