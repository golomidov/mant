import type { TranscriptTranslation } from './analysis'
import type { Segment } from './protocol'

/** An older result is usable only for the unchanged prefix it actually translated. */
export function translationMatches(translation: TranscriptTranslation | undefined, segment: Segment | undefined): translation is TranscriptTranslation {
  if (!translation || !segment || translation.revision > segment.revision) return false
  if (translation.sourceText !== undefined) return !!translation.sourceText.trim() && segment.text.startsWith(translation.sourceText)
  return translation.revision === segment.revision
}
