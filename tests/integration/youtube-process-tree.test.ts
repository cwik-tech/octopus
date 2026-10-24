import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { runYoutubeProcess } from '../../domains/youtube/youtube-process.js'

const execFileAsync = promisify(execFile)

test('aborting a YouTube subprocess terminates its spawned process tree', async (context) => {
  if (process.platform === 'win32') return context.skip('POSIX process-group fixture.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-process-tree-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const marker = path.join(directory, 'grandchild-survived')
  const controller = new AbortController()
  const running = runYoutubeProcess('/bin/sh', [
    '-c',
    `(sleep 0.4; touch ${JSON.stringify(marker)}) & wait`,
  ], { signal: controller.signal })
  setTimeout(() => controller.abort(), 50)

  await assert.rejects(running)
  await new Promise((resolve) => setTimeout(resolve, 600))
  await assert.rejects(fs.access(marker))
})

test('a YouTube subprocess wall-clock deadline terminates active work', async (context) => {
  if (process.platform === 'win32') return context.skip('POSIX process-group fixture.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-process-deadline-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const marker = path.join(directory, 'deadline-missed')

  await assert.rejects(runYoutubeProcess('/bin/sh', [
    '-c',
    `(sleep 0.2; touch ${JSON.stringify(marker)}) & wait`,
  ], { timeoutMs: 30 }), /timed out/i)
  await new Promise((resolve) => setTimeout(resolve, 300))
  await assert.rejects(fs.access(marker))
})

test('YouTube subprocess failures redact URLs and embedded credentials', async () => {
  await assert.rejects(
    runYoutubeProcess('/bin/sh', [
      '-c',
      "printf '%s' 'download failed https://www.youtube.com/watch?v=dQw4w9WgXcQ&token=secret-value proxy https://user:password@example.test/file' >&2; exit 1",
    ]),
    (error: unknown) => {
      assert(error instanceof Error)
      assert.match(error.message, /download failed/i)
      for (const secret of ['dQw4w9WgXcQ', 'secret-value', 'user', 'password', 'example.test']) {
        assert.equal(error.message.includes(secret), false)
      }
      return true
    },
  )
})

test('shutdown waits for forced process-group cleanup after the direct child exits', async (context) => {
  if (process.platform === 'win32') return context.skip('POSIX process-group fixture.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-process-shutdown-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const marker = path.join(directory, 'orphan-survived')
  const helperPath = path.join(directory, 'abort-helper.mjs')
  const moduleUrl = pathToFileURL(path.resolve('domains/youtube/youtube-process.ts')).href
  await fs.writeFile(helperPath, `
import { runYoutubeProcess } from ${JSON.stringify(moduleUrl)};
const controller = new AbortController();
const running = runYoutubeProcess('/bin/sh', ['-c', ${JSON.stringify(
    `(trap '' TERM; sleep 1.5; touch ${JSON.stringify(marker)}) </dev/null >/dev/null 2>&1 & wait`,
  )}], { signal: controller.signal });
setTimeout(() => controller.abort(), 30);
try { await running; } catch {}
`)

  await execFileAsync(process.execPath, ['--import', 'tsx', helperPath], { cwd: process.cwd() })
  await new Promise((resolve) => setTimeout(resolve, 1_700))
  await assert.rejects(fs.access(marker))
})
