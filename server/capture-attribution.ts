import type { Attribution, Brief } from '../shared/analysis'
import type { Recording, Segment } from '../shared/protocol'
export function captureAttribution(segment: Segment, recording: Recording, brief: Brief): Attribution | undefined {
  const capture = recording.capture
  if (!segment.capture || !capture) return undefined
  const local = segment.sourceId === 'local-microphone'
  const id = local ? brief.userParticipantId ?? capture.selection.localParticipantId : null
  const participant = brief.participants.find(p => p.id === id)
  return { participantId: participant?.id ?? null, sideId: participant?.sideId ?? null,
    sourceLabel: local ? 'Local microphone · transmission unknown' : 'Playback source · participants unknown', revision: 1 }
}
