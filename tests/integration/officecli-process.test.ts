import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { runOfficeProcess } from '../../services/officecli-process.js'

test('collects complete byte output and does not inherit credentials or Office plugin configuration', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'office-process-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const script = path.join(directory, 'child.cjs')
  await fs.writeFile(script, 'process.stdout.write(JSON.stringify({home:process.env.HOME,secret:process.env.OFFICECLI_PLUGIN_RENDERER_DOCX??null}));process.stdout.write("żółty");')
  const result = await runOfficeProcess({ executable: process.execPath, args: [script], directory, signal: new AbortController().signal })
  assert.equal(result.ok, true)
  assert.equal(result.stdout.toString(), JSON.stringify({ home: directory, secret: null }) + 'żółty')
})
test('cancels an owned child and refuses overflow rather than returning truncated success', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'office-process-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const script = path.join(directory, 'child.cjs')
  await fs.writeFile(script, 'process.stdout.write(Buffer.alloc(3*1024*1024));')
  const result = await runOfficeProcess({ executable: process.execPath, args: [script], directory, signal: new AbortController().signal })
  assert.equal(result.ok, false)
  if (result.ok) assert.fail('Overflow must be a failure')
  assert.equal(result.code, 'output_limit')
})

test('an app process crash stops its owned native job and removes private staging', { timeout: 10000 }, async (t) => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const { watch } = await import('node:fs')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'octopus-office-crash-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const job = path.join(directory, 'job')
  await fs.mkdir(job)
  const marker = path.join(job, 'started')
  const child = path.join(job, 'child.cjs')
  await fs.writeFile(child, `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`)
  const runner = new URL('../../services/officecli-process.js', import.meta.url).href
  const parentScript = path.join(directory, 'parent.mjs')
  await fs.writeFile(parentScript, `import {runOfficeProcess} from ${JSON.stringify(runner)};await runOfficeProcess({executable:process.execPath,args:[${JSON.stringify(child)}],directory:${JSON.stringify(job)},signal:new AbortController().signal})`)
  const watcher = watch(job)
  const started = new Promise<void>((resolve) => watcher.on('change', (_event, name) => { if (name === 'started') resolve() }))
  const parent = spawn(process.execPath, ['--import', 'tsx', parentScript], { stdio: 'ignore' })
  t.after(() => { parent.kill('SIGKILL'); watcher.close() })
  await started
  const pid = Number(await fs.readFile(marker, 'utf8'))
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch {} })
  const parentWatcher = watch(directory)
  t.after(() => parentWatcher.close())
  const removed = once(parentWatcher, 'change', { signal: AbortSignal.timeout(3000) })
  parent.kill('SIGKILL')
  await removed
  await assert.rejects(fs.stat(job), { code: 'ENOENT' })
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('cancelling a job reaps its child and grandchild before returning', { timeout: 5000 }, async (t) => {
  const { watch } = await import('node:fs')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'office-tree-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const marker = path.join(directory, 'grandchild-ready')
  const grandchild = path.join(directory, 'grandchild.cjs')
  await fs.writeFile(grandchild, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},1000)`)
  const child = path.join(directory, 'child.cjs')
  const childPid = path.join(directory, 'child-pid')
  await fs.writeFile(child, `require('node:fs').writeFileSync(${JSON.stringify(childPid)}, String(process.pid));require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)}],{stdio:'inherit'});setInterval(()=>{},1000)`)
  const watcher = watch(directory)
  t.after(() => watcher.close())
  const ready = new Promise<void>((resolve) => watcher.on('change', (_event, name) => { if (name === 'grandchild-ready') resolve() }))
  const controller = new AbortController()
  t.after(() => controller.abort())
  const result = runOfficeProcess({ executable: process.execPath, args: [child], directory, signal: controller.signal })
  await ready
  const ownedChild = Number(await fs.readFile(childPid, 'utf8'))
  const ownedGrandchild = Number(await fs.readFile(marker, 'utf8'))

  controller.abort()

  assert.deepEqual(await result, { ok: false, code: 'cancelled' })
  assert.throws(() => process.kill(ownedChild, 0), { code: 'ESRCH' })
  assert.throws(() => process.kill(ownedGrandchild, 0), { code: 'ESRCH' })
})
