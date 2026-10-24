import assert from 'node:assert/strict'
import test from 'node:test'
import { runYoutubeProcess } from '../../domains/youtube/youtube-process.js'

test('a media process returns its complete piped metadata after its parent exits', async () => {
  const expected = JSON.stringify({ title: 'Complete metadata', duration: 1354 })
  const child = `process.stdout.write(${JSON.stringify(expected)})`
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore',process.stdout,process.stderr]});process.exit(0)`

  const result = await runYoutubeProcess(process.execPath, ['-e', parent], { timeoutMs: 5_000 })

  assert.equal(result.stdout, expected)
})

test('media subprocesses can launch the embedded Electron executable as Node', async () => {
  const result = await runYoutubeProcess(process.execPath, ['-e', 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "missing")'], { timeoutMs: 5_000 })
  assert.equal(result.stdout, '1')
})
