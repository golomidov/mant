import { mkdir, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
if (process.platform !== 'darwin') throw new Error('The native helper requires macOS and Xcode Command Line Tools.')
const root = resolve(import.meta.dir, '..')
const bundle = resolve(root, 'native/build/Mant Capture.app')
await mkdir(`${bundle}/Contents/MacOS`, { recursive: true })
await copyFile(`${root}/native/MantCapture/Info.plist`, `${bundle}/Contents/Info.plist`)
for (const cmd of [
  ['xcrun', 'swiftc', '-swift-version', '5', '-O', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`, '-module-cache-path', '/tmp/mant-swift-module-cache', `${root}/native/MantCapture/main.swift`, '-o', `${bundle}/Contents/MacOS/MantCapture`],
  ['codesign', '--force', '--sign', process.env.MANT_CAPTURE_SIGN_IDENTITY ?? '-', '--identifier', 'local.mant.capture', bundle],
]) {
  const result = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' })
  if (await result.exited !== 0) throw new Error(`${cmd[0]} failed.`)
}
console.log(`Built ${bundle}\nKeep this path and signing identity stable for macOS permissions.`)
