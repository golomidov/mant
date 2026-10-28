export function safeMessage(message: string): string {
  const key = process.env.OPENAI_API_KEY
  const redacted = key ? message.replaceAll(key, '[redacted]') : message
  return redacted.replace(/\bsk-[\w.*-]+/g, '[redacted]')
}

const modelMessages = {
  missing_key: 'OPENAI_API_KEY is missing from the server environment. Set it and restart the server.',
  unknown_model: 'ANALYSIS_MODEL is not available in the installed model catalog. Check that setting and restart the server.',
  authentication: 'The model provider rejected the server credentials. Check the API key and retry.',
  quota: 'The model provider’s quota or rate limit was reached. Check API usage and retry.',
  schema: 'The model provider rejected the objective-building schema. This is an application error.',
  timeout: 'Objective building timed out. Please try again.',
  connection: 'The server could not reach the model provider. Check the connection and retry.',
  output_limit: 'The model response exceeded its size limit. Try a shorter call goal.',
  invalid_proposal: 'The model returned an invalid brief. Please build objectives again.',
  request: 'The objective-building request failed. Please try again.',
} as const
const analysisMessages: Record<keyof typeof modelMessages, string> = {
  ...modelMessages,
  schema: 'The analysis schema is not supported by the model SDK or provider. This is an application error.',
  timeout: 'Analysis timed out. Retry analysis.',
  output_limit: 'The analysis response exceeded its size limit. Retry analysis.',
  invalid_proposal: 'The model returned invalid analysis. Retry analysis.',
  request: 'The analysis request failed. Retry analysis.',
}
export class ModelRequestError extends Error {
  readonly code: keyof typeof modelMessages
  constructor(code: keyof typeof modelMessages, readonly task: 'brief' | 'analysis' = 'brief') { super((task === 'analysis' ? analysisMessages : modelMessages)[code]); this.name = 'ModelRequestError'; this.code = code }
}
export function modelRequestError(error: unknown, task: 'brief' | 'analysis' = 'brief'): ModelRequestError {
  if (error instanceof ModelRequestError) return error.task === task ? error : new ModelRequestError(error.code, task)
  const message = error instanceof Error ? error.message : String(error)
  const code = /invalid.*schema|invalid_function_parameters|requires JSON-schema|constrained sampling|object and array unions are unsupported/i.test(message) ? 'schema'
    : /401|403|incorrect.*key|invalid.*key|authentication|permission/i.test(message) ? 'authentication'
    : /429|quota|rate.?limit/i.test(message) ? 'quota'
    : /timeout|timed out|deadline exceeded/i.test(message) ? 'timeout'
    : /connection|network|fetch failed|ECONN|ENOTFOUND/i.test(message) ? 'connection'
    : /structured|proposal|Invalid .*reference|Brief IDs/i.test(message) ? 'invalid_proposal' : 'request'
  return new ModelRequestError(code)
}
