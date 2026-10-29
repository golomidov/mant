import { OpenAITranscription, type TranscriptionTransport, type TransportCallbacks } from './transcription'
import { DeepgramTranscription } from './deepgram-transcription'
import { WindowedTranscription } from './windowed-transcription'
import { connectionFor } from './backend-settings'
import { transcriptionLanguages } from './backend-languages'
import { assertLanguages } from './text-backends'
import type { Delay } from '../shared/protocol'
export function createTranscription(session: string, source: string, delay: Delay, callbacks: TransportCallbacks, languages: string[]): TranscriptionTransport {
  const connection = connectionFor('transcription')
  languages = transcriptionLanguages(languages)
  assertLanguages(connection, languages)
  switch (connection.provider) {
    case 'openai': return new OpenAITranscription(session, source, delay, callbacks, undefined, languages, connection)
    case 'deepgram': return new DeepgramTranscription(session, source, callbacks, connection, languages)
    case 'whisper': case 'apple-speech': return new WindowedTranscription(session, source, callbacks, connection, languages)
    default: throw new Error('Transcription backend is incompatible. Run bun run settings.')
  }
}
