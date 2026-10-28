import { useReports } from './report-hooks'
import type { Report } from './report-store'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { captureSourceSummary, captureSources, defaultCaptureGains, familiarApplications, type CaptureGains, type CaptureInventory, type CaptureSelection, type CaptureSetupState, type CaptureSourceSummary } from '../shared/capture'
import type { Delay, Session } from '../shared/protocol'
import { discoverCaptureSources, sourceRefreshMs, sourceRequestTimeoutMs } from './capture-discovery'
import { loadCaptureSetupCache, saveCaptureSetupCache } from './capture-cache'

async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/capture/${path}`, body === undefined ? { signal } : { signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error((await response.json() as { error: string }).error)
  return response.status === 204 ? null : await response.json() as unknown
}

function savedNames(value: CaptureSetupState | null): [string, string][] {
  if (!value?.selection) return []
  const entries: [string, string][] = []
  if (value.labels?.microphone) entries.push(['input:' + value.selection.microphoneId, value.labels.microphone])
  const remote = value.selection.remote
  if (value.labels?.playback) entries.push([remote.kind === 'application' ? 'app:' + remote.bundleId : 'input:' + remote.deviceId, value.labels.playback])
  return entries
}

export function CaptureSetup({ onSourcesChange, sourceControls, session, busy, disabled, assistantDisabled, delay, beforeStart, stop, connectionEpoch, discover }: {
  sourceControls: ReactNode; session: Session | null; busy: boolean; connectionEpoch: number; discover: boolean; disabled: boolean; assistantDisabled: boolean; delay: Delay
  onSourcesChange(sources: CaptureSourceSummary): void
  beforeStart(): void; stop(): void
}) {
  const [cachedSetup] = useState(loadCaptureSetupCache)
  const [knownNames, setKnownNames] = useState(() => new Map(savedNames(cachedSetup)))
  function rememberLabels(value: CaptureSetupState) {
    setKnownNames(previous => new Map([...previous, ...savedNames(value)]))
  }
  const labelsFor = useCallback((value: CaptureSelection) => {
    return { microphone: knownNames.get('input:' + value.microphoneId) ?? null,
      playback: knownNames.get(value.remote.kind === 'application' ? 'app:' + value.remote.bundleId : 'input:' + value.remote.deviceId) ?? null }
  }, [knownNames])
  const [inventory, setInventory] = useState<CaptureInventory | null>(null)
  const [setup, setSetup] = useState<CaptureSetupState | null>(cachedSetup)
  const [selection, setSelection] = useState<CaptureSelection>(cachedSetup?.selection ?? { microphoneId: '', remote: { kind: 'application', bundleId: '' }, localParticipantId: null })
  const [gains, setGains] = useState<CaptureGains>(cachedSetup?.gains ?? defaultCaptureGains())
  const [problem, setProblem] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const gainQueue = useRef(Promise.resolve())
  const selectionRef = useRef(selection)
  const selectionRevision = useRef(0)
  const gainRevision = useRef(0)
  const discovery = useRef<ReturnType<typeof discoverCaptureSources> | null>(null)
  const [discoveryProblem, setDiscoveryProblem] = useState<string | null>(null)
  const [setupProblem, setSetupProblem] = useState<string | null>(null)
  const [setupEpoch, setSetupEpoch] = useState(-1)
  const [inventoryEpoch, setInventoryEpoch] = useState(-1)
  const [refreshingRequest, setRefreshing] = useState(false)
  const refreshing = !disabled && (refreshingRequest || inventoryEpoch !== connectionEpoch && !discoveryProblem)
  const capture = session?.capture
  const live = !!capture && busy
  const chosen = live ? session.source.capture!.selection : selection
  const remoteId = chosen.remote.kind === 'application' ? chosen.remote.bundleId : chosen.remote.deviceId
  const currentInventory = inventoryEpoch === connectionEpoch ? inventory : null
  const sourceSummary = captureSourceSummary(chosen, disabled || discoveryProblem ? null : currentInventory,
    labelsFor(chosen), disabled || discoveryProblem ? 'unknown' : 'checking')
  const { name: microphoneName, availability: microphoneAvailability } = sourceSummary.microphone
  const { name: playbackName, availability: playbackAvailability } = sourceSummary.playback
  useEffect(() => {
    onSourcesChange({ microphone: { name: microphoneName, availability: microphoneAvailability }, playback: { name: playbackName, availability: playbackAvailability } })
  }, [onSourcesChange, microphoneName, microphoneAvailability, playbackName, playbackAvailability])
  const commonReason = disabled ? 'Wait for the server connection or upload to finish.' : working ? 'Wait for the current setup action.' : null
  const selectionReason = busy ? 'Stop capture or replay before changing devices.' : commonReason
  const recordReason = selectionReason ?? (!chosen.microphoneId || !remoteId ? 'Choose a microphone and incoming audio.' : currentInventory?.supported === false ? currentInventory.problem ?? 'Native capture is unavailable.' : microphoneAvailability !== 'available' || playbackAvailability !== 'available' ? refreshing ? 'Checking audio sources…' : discoveryProblem || microphoneAvailability === 'unknown' || playbackAvailability === 'unknown' ? 'Unable to check audio sources. Retrying automatically.' : 'Selected source unavailable. Reconnect the device or open the app; checking again automatically.' : null)
  const startReason = recordReason ?? (assistantDisabled ? 'Wait for brief changes to finish saving before starting.' : null)


  async function action(work: () => Promise<void>) {
    setWorking(true); setProblem(null)
    try { await work() } catch (error) { setProblem((error as Error).message) } finally { setWorking(false) }
  }
  useEffect(() => {
    if (!setup) return
    const labels = captureSourceSummary(selection, inventory, labelsFor(selection))
    saveCaptureSetupCache({ ...setup, selection, gains, labels: { microphone: labels.microphone.name, playback: labels.playback.name } })
  }, [setup, selection, gains, inventory, labelsFor])

  useEffect(() => {
    if (disabled) return
    let disposed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    // Revisions are captured once per connection, not once per retry.
    const revision = selectionRevision.current, levels = gainRevision.current
    async function restore() {
      try {
        const remembered = await request('setup', undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(sourceRequestTimeoutMs)])) as CaptureSetupState
        if (disposed) return
        rememberLabels(remembered); setSetup(remembered); setSetupEpoch(connectionEpoch); setSetupProblem(null)
        if (levels === gainRevision.current) setGains(remembered.gains)
        if (remembered.selection && revision === selectionRevision.current) { selectionRef.current = remembered.selection; setSelection(remembered.selection) }
      } catch (error) {
        if (disposed) return
        setSetupProblem('Unable to restore saved audio setup: ' + (error as Error).message + ' Retrying automatically.')
        retry = setTimeout(() => void restore(), sourceRefreshMs)
      }
    }
    void restore()
    return () => { disposed = true; controller.abort(); clearTimeout(retry) }
  }, [disabled, connectionEpoch])

  useEffect(() => {
    if (disabled) return
    const work = discoverCaptureSources({
      load: signal => request('devices', {}, signal) as Promise<CaptureInventory>,
      visible: () => document.visibilityState !== 'hidden', page: document, window,
      onStart: () => setRefreshing(true),
      onInventory: devices => {
        setKnownNames(previous => new Map([...previous,
          ...devices.microphones.map(device => ['input:' + device.id, device.name] as [string, string]),
          ...devices.targets.map(target => ['app:' + target.bundleId, target.name] as [string, string]),
        ]))
        setInventory(devices); setInventoryEpoch(connectionEpoch); setDiscoveryProblem(null)
      },
      onError: setDiscoveryProblem,
      onFinish: () => setRefreshing(false),
    })
    discovery.current = work
    return () => { work.dispose(); discovery.current = null }
  }, [disabled, connectionEpoch])
  useEffect(() => { if (discover) discovery.current?.refresh() }, [discover])

  useEffect(() => {
    // Only seed a genuinely new setup, after persisted setup has been restored.
    // Polls must never fill in or replace a user's partial edit or missing device.
    if (disabled || setupEpoch !== connectionEpoch || inventoryEpoch !== connectionEpoch || !inventory || setup?.selection || selectionRevision.current || selectionRef.current.microphoneId) return
    const initial: CaptureSelection = {
      microphoneId: inventory.microphones[0]?.id ?? '',
      remote: { kind: 'application', bundleId: inventory.targets.find(target => familiarApplications.some(id => id === target.bundleId))?.bundleId ?? inventory.targets[0]?.bundleId ?? '' }, localParticipantId: null,
    }
    let disposed = false
    queueMicrotask(() => {
      if (!disposed && !selectionRevision.current && !selectionRef.current.microphoneId && initial.microphoneId && initial.remote.kind === 'application' && initial.remote.bundleId) {
        selectionRef.current = initial; setSelection(initial)
      }
    })
    return () => { disposed = true }
  }, [disabled, setupEpoch, connectionEpoch, inventoryEpoch, inventory, setup])

  async function changeSelection(next: CaptureSelection) {
    if (next.remote.kind === 'input' && next.remote.deviceId === next.microphoneId) { setProblem('Choose separate physical inputs for microphone and incoming audio.'); return }
    selectionRevision.current++; selectionRef.current = next; setSelection(next)
    if (!next.microphoneId || !(next.remote.kind === 'application' ? next.remote.bundleId : next.remote.deviceId)) return
    await action(async () => {
      const latest = await request('setup', { selection: next }) as CaptureSetupState
      rememberLabels(latest); setSetup(latest); setGains(latest.gains)
    })
  }
  function changeGain(source: typeof captureSources[number], value: number) {
    gainRevision.current++
    const next = { ...gains, [source]: value }; setGains(next)
    gainQueue.current = gainQueue.current.catch(() => {}).then(async () => {
      const latest = await request('gains', { selection: chosen, gains: next, sessionId: live ? session.id : undefined }) as CaptureSetupState
      setSetup(latest); setProblem(null)
    })
    void gainQueue.current.catch(error => setProblem((error as Error).message))
  }
  const start = useCallback(async () => {
    beforeStart()
    await action(async () => { await gainQueue.current; await request('start', { selection, delay }) })
  }, [beforeStart, selection, delay])
  const reports: Report[] = []
  const add = (id: string, summary: string | null | undefined, severity: Report['severity'] = 'warning') => { if (summary) reports.push({ id: 'capture-' + id, source: 'Audio sources', severity, summary }) }
  add('action', problem, 'error')
  add('setup', setupProblem, 'error')
  add('inventory', currentInventory?.problem)
  if (!disabled && !discoveryProblem) {
    for (const [id, device] of Object.entries(sourceSummary)) {
      if (device.availability !== 'available') add(id, device.name + ': ' + (device.availability === 'checking' ? 'Checking availability…' : device.availability === 'unknown' ? 'Unable to check availability. Retrying automatically.' : 'Unavailable. Reconnect the device or open the app.'), device.availability === 'checking' ? 'progress' : 'warning')
    }
  }
  if (working) add('working', 'Updating audio setup…', 'progress')
  if (live) {
    for (const source of captureSources) if (capture.sources[source].clipping) add('clipping-' + source, (source === 'local-microphone' ? microphoneName : playbackName) + ': Audio is clipping. Lower the gain.')
    capture.problems.forEach((message, index) => add('problem-' + index, message))
  }
  const recoveryReport: Report | null = capture?.recovery && capture.recovery.state !== 'idle' ? { id: 'capture-recovery', source: 'Capture', summary: (capture.recovery.state === 'retrying' ? 'Reconnecting to the same app and microphone · attempt ' + capture.recovery.attempt + ' of 4' : 'Automatic reconnection stopped.') + ' · ' + capture.recovery.message, severity: capture.recovery.state === 'retrying' ? 'progress' : 'error', action: { label: 'Retry', pending: working || capture.recovery.state === 'retrying', disabled: !!startReason, run: () => start() } } : null
  const discoveryReport: Report | null = discoveryProblem ? { id: 'capture-discovery', source: 'Audio sources', severity: 'error', summary: discoveryProblem, action: { label: 'Refresh sources', pending: refreshing, disabled, run: () => discovery.current?.refresh() } } : null
  useReports([...reports, ...(capture?.recovery && capture.recovery.state !== 'idle' ? [recoveryReport!] : []), ...(discoveryProblem ? [discoveryReport!] : [])], session?.id)
  return <div className="capture-panel" aria-label="Audio source setup">
    <div className="controls">{sourceControls}<div className="buttons capture-primary-controls">
      <button className="primary" disabled={!!startReason} onClick={() => void start()}>▶ Start</button>
      <button disabled={!live || !!commonReason || session.phase === 'draining'} onClick={stop}>■ Stop</button>
    </div></div>
    <div className="capture-levels">{captureSources.map(source => {
      const stats = live ? capture.sources[source] : null
      const label = source === 'local-microphone' ? 'Microphone' : 'Incoming audio'
      const deviceName = source === 'local-microphone' ? sourceSummary.microphone.name : sourceSummary.playback.name
      const gainReason = disabled ? 'Reconnect before adjusting levels.' : busy && !live ? 'Stop replay before adjusting levels.' : session?.phase === 'draining' ? 'Wait for recording to finish.' : !chosen.microphoneId || !remoteId ? 'Choose audio sources before adjusting levels.' : null
      return <div className="capture-source" key={source}>
        <div className="capture-source-heading"><label className="field">{label}{source === 'local-microphone' ? <select value={chosen.microphoneId} disabled={!!selectionReason} onChange={event => void changeSelection({ ...selection, microphoneId: event.target.value })}>
          <option value="">Choose microphone…</option>
          {chosen.microphoneId && !inventory?.microphones.some(device => device.id === chosen.microphoneId) && <option value={chosen.microphoneId}>{deviceName}</option>}
          {inventory?.microphones.map(device => <option key={device.id} value={device.id} disabled={chosen.remote.kind === 'input' && device.id === chosen.remote.deviceId}>{device.name}</option>)}
        </select> : <select value={remoteId ? (chosen.remote.kind === 'application' ? 'app:' : 'input:') + remoteId : ''} disabled={!!selectionReason} onChange={event => { const value = event.target.value; void changeSelection({ ...selection, remote: value.startsWith('input:') ? { kind: 'input', deviceId: value.slice(6) } : { kind: 'application', bundleId: value.slice(4) } }) }}>
          <option value="">Choose incoming audio…</option>
          {remoteId && !(chosen.remote.kind === 'application' ? inventory?.targets.some(target => target.bundleId === remoteId) : inventory?.microphones.some(device => device.id === remoteId)) && <option value={(chosen.remote.kind === 'application' ? 'app:' : 'input:') + remoteId}>{deviceName}</option>}
          <optgroup label="Applications">{inventory?.targets.map(target => <option key={target.id} value={'app:' + target.bundleId}>{target.name}</option>)}</optgroup>
          <optgroup label="Routed audio inputs">{inventory?.microphones.map(device => <option key={device.id} value={'input:' + device.id} disabled={device.id === chosen.microphoneId}>{device.name}</option>)}</optgroup>
        </select>}</label></div>
        <meter aria-label={`${label} level`} min="0" max="1" value={Math.min(1, (stats?.level ?? 0) * 5)} />
        <div className="capture-gain-row"><label className="capture-gain"><input aria-label={`${label} gain`} type="range" min={-12} max={24} step={1} value={stats?.gainDb ?? gains[source]} disabled={!!gainReason} onChange={event => changeGain(source, Number(event.target.value))} /></label><output>{stats?.gainDb ?? gains[source]} dB</output><button aria-label={`Reset ${label.toLowerCase()} to 0 dB`} disabled={!!gainReason} onClick={() => changeGain(source, 0)}>Reset</button></div>
      </div>
    })}</div>
    <CaptureAction label="Refresh sources" reason={disabled ? 'Reconnect before refreshing sources.' : refreshing ? 'Refreshing sources…' : null} onClick={() => discovery.current?.refresh()} />
    {chosen.remote.kind === 'input' && <p className="help">Route the call’s playback into this input in your call app or macOS Sound settings.</p>}
  </div>
}

function CaptureAction({ label, reason, onClick }: { label: string; reason: string | null; onClick(): void }) {
  return <span className="capture-action"><button disabled={!!reason} onClick={onClick}>{label}</button></span>
}
