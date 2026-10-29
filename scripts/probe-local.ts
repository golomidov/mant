// Explicit local-server discovery; never starts servers or installs models.
for (const [server, url] of [
  ['LM Studio', 'http://127.0.0.1:1234/v1/models'],
  ['llama.cpp', 'http://127.0.0.1:8080/v1/models'],
  ['Ollama', 'http://127.0.0.1:11434/v1/models'],
  ['whisper.cpp', 'http://127.0.0.1:8080/health'],
]) {
  try {
    const response = await fetch(url!, { signal: AbortSignal.timeout(2000) })
    console.log(JSON.stringify({ server, url, reachable: response.ok, status: response.status }))
  } catch { console.log(JSON.stringify({ server, url, reachable: false, issue: 'No reachable server at the default endpoint. Start/install externally, then configure its URL and run settings -- check --probe.' })) }
}
