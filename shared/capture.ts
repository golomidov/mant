export const captureSources = ['local-microphone', 'remote-playback'] as const
export type CaptureSourceId = typeof captureSources[number]
export interface CaptureDevice { id: string; name: string }
export interface PlaybackTarget extends CaptureDevice { bundleId: string; pids: number[] }
export interface CaptureInventory {
  os: string; architecture: string; minimumMacOS: string; supported: boolean
  microphonePermission: string; playbackPermission: string
  microphones: CaptureDevice[]; targets: PlaybackTarget[]; problem?: string
  routeSignature?: string
}
export interface CaptureSelection {
  microphoneId: string
  remote: { kind: 'application'; bundleId: string } | { kind: 'input'; deviceId: string }
  localParticipantId: string | null
}
export interface CaptureTrack { sourceId: CaptureSourceId; audioId: string; name: string; durationMs: number }
export interface CaptureRecording {
  selection: CaptureSelection; separation?: 'unverified' | 'user-verified'; diagnostic?: boolean
  tracks: CaptureTrack[]; clock: 'host-monotonic'; callTransmission: 'unknown'
  routeSignature?: string
  gains?: CaptureGains
}
export type CaptureGains = Record<CaptureSourceId, number>
export const defaultCaptureGains = (): CaptureGains => ({ 'local-microphone': 0, 'remote-playback': 0 })
export function parseCaptureGains(value: unknown): CaptureGains {
  if (value === undefined) return defaultCaptureGains()
  if (!value || typeof value !== 'object') throw new Error('Invalid capture levels.')
  const gains = value as CaptureGains
  if (!captureSources.every(id => Number.isInteger(gains[id]) && gains[id] >= -12 && gains[id] <= 24)) throw new Error('Capture levels must be whole dB from −12 to +24.')
  return { 'local-microphone': gains['local-microphone'], 'remote-playback': gains['remote-playback'] }
}
export interface CaptureSetupState {
  selection: CaptureSelection | null; gains: CaptureGains; routeSignature: string | null
  labels?: { microphone: string | null; playback: string | null }
}
export type CaptureAvailability = 'available' | 'unavailable' | 'checking' | 'unknown'
export interface CaptureSourceSummary {
  microphone: { name: string; availability: CaptureAvailability }
  playback: { name: string; availability: CaptureAvailability }
}
export function captureSourceSummary(selection: CaptureSelection, inventory: CaptureInventory | null, labels?: CaptureSetupState['labels'], pending: 'checking' | 'unknown' = 'checking'): CaptureSourceSummary {
  const microphone = inventory?.microphones.find(device => device.id === selection.microphoneId)
  const remote = selection.remote
  const playback = remote.kind === 'application' ? inventory?.targets.find(target => target.bundleId === remote.bundleId) : inventory?.microphones.find(device => device.id === remote.deviceId)
  return {
    microphone: { name: microphone?.name ?? labels?.microphone ?? 'Selected microphone', availability: !inventory ? pending : microphone ? 'available' : 'unavailable' },
    playback: { name: playback?.name ?? labels?.playback ?? (remote.kind === 'application' ? 'Selected browser / app' : 'Selected audio input'), availability: !inventory ? pending : remote.kind === 'application' && inventory.supported && inventory.problem ? 'unknown' : playback ? 'available' : 'unavailable' },
  }
}
// Participants and process IDs are deliberately excluded from device identity.
export const captureSelectionKey = (selection: CaptureSelection) => JSON.stringify([selection.microphoneId, selection.remote])
export const familiarApplications = [
  'com.apple.FaceTime', 'us.zoom.xos', 'com.microsoft.teams', 'com.microsoft.teams2',
  'com.tinyspeck.slackmacgap', 'com.hnc.Discord', 'net.whatsapp.WhatsApp', 'ru.keepcoder.Telegram',
  'org.telegram.desktop', 'com.apple.Safari', 'com.google.Chrome', 'org.mozilla.firefox',
  'com.microsoft.edgemac', 'com.brave.Browser',
] as const
export interface CaptureStatus {
  sources: Record<CaptureSourceId, { level: number; receivedMs: number; sentMs: number; lagMs: number; lastAudioMs: number | null; started: boolean; audible: boolean; clipping: boolean; gainDb: number }>
  recovery: { state: 'idle' | 'retrying' | 'failed'; attempt: number; message: string | null }
  problems: string[]
}
export interface CaptureFrame {
  type: 'audio'; sourceId: CaptureSourceId; sequence: number; captureMs: number
  sampleRate: 24000; channels: 1; format: 'pcm_s16le'; frames: number
}
export interface NativeEvent { type: 'ready' | 'error' | 'discontinuity'; message?: string; clockMs?: number; readyMs?: number; routeSignature?: string }
export function parseCaptureSelection(value: unknown): CaptureSelection {
  if (!value || typeof value !== 'object') throw new Error('Choose capture devices.')
  const v = value as Record<string, unknown>
  const r = v.remote as Record<string, unknown> | undefined
  const valid = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 500
  if (!valid(v.microphoneId) || !r || !(v.localParticipantId === null || valid(v.localParticipantId))) throw new Error('Invalid capture selection.')
  if (r.kind === 'application' && valid(r.bundleId)) return { microphoneId: v.microphoneId, localParticipantId: v.localParticipantId, remote: { kind: r.kind, bundleId: r.bundleId } }
  if (r.kind === 'input' && valid(r.deviceId) && r.deviceId !== v.microphoneId) return { microphoneId: v.microphoneId, localParticipantId: v.localParticipantId, remote: { kind: r.kind, deviceId: r.deviceId } }
  throw new Error('Choose a separate application or audio input for playback.')
}
