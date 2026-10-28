import { parseCaptureGains, parseCaptureSelection, type CaptureSetupState } from '../shared/capture'

const key = 'mant-audio-sources-v1'
export function loadCaptureSetupCache(): CaptureSetupState | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as CaptureSetupState | null
    if (!value) return null
    return { selection: value.selection ? parseCaptureSelection(value.selection) : null, gains: parseCaptureGains(value.gains), routeSignature: null,
      labels: { microphone: typeof value.labels?.microphone === 'string' ? value.labels.microphone : null, playback: typeof value.labels?.playback === 'string' ? value.labels.playback : null } }
  } catch { return null }
}
export function saveCaptureSetupCache(value: CaptureSetupState) {
  try { if (value.selection) parseCaptureSelection(value.selection); localStorage.setItem(key, JSON.stringify(value)) } catch { /* Device confirmation is always fetched separately. */ }
}
