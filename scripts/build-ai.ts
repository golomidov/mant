import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
if (process.platform !== 'darwin') throw new Error('Apple AI requires macOS and Xcode Command Line Tools.')
const root = resolve(import.meta.dir, '..'), output = resolve(root, 'native/build/MantAI')
await mkdir(resolve(root, 'native/build'), { recursive: true })
const result = Bun.spawn(['xcrun', 'swiftc', '-swift-version', '5', '-O', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`, '-module-cache-path', '/tmp/mant-ai-module-cache', resolve(root, 'native/MantAI/main.swift'), '-o', output], { stdout: 'inherit', stderr: 'inherit' })
if (await result.exited !== 0) throw new Error('Apple AI helper compilation failed.')
console.log(`Built ${output}`)
