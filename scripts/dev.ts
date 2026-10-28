const api = Bun.spawn(['bun', '--no-env-file', '--watch', 'server/index.ts'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
const spa = Bun.spawn(['bun', '--no-env-file', '--bun', 'vite', '--host', '127.0.0.1'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
let ending = false
function stop() {
  if (ending) return
  ending = true
  api.kill('SIGTERM')
  spa.kill('SIGTERM')
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await Promise.race([api.exited, spa.exited])
stop()
await Promise.all([api.exited, spa.exited])
