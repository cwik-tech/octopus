/**
 * CLI model discovery stops every process the CLI started, not only the one it
 * spawned.
 *
 * The installed Qwen starts through a launcher whose own child runs the CLI on
 * the launcher's pipes and ignores a polite stop. Stopping only the launcher
 * left that child running with the discovery pipe open, so a finished
 * discovery kept two Qwen processes alive per refresh and kept the caller's
 * process from exiting. This fake reproduces that shape: a launcher that
 * starts a worker on its own pipes, and a worker that answers the SDK control
 * requests, ignores SIGTERM, and holds a socket to the test so its exit is an
 * event the test can wait on.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'

const FAKE_MODEL_ID = 'fake-qwen-model'

function fakeQwenScript(port: number): string {
  return `#!${process.execPath}
const { spawn } = require('node:child_process')
const net = require('node:net')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('0.0.0-fake')
  process.exit(0)
}
if (!args.includes('--input-format')) process.exit(0)
if (process.env.FAKE_QWEN_ROLE !== 'worker') {
  // The launcher: the CLI itself runs in a child that shares these pipes.
  const worker = spawn(process.execPath, [__filename, ...args], {
    stdio: 'inherit',
    env: { ...process.env, FAKE_QWEN_ROLE: 'worker' },
  })
  worker.on('exit', (code) => process.exit(code ?? 0))
} else {
  // Like the installed Qwen's innermost process, a polite stop is ignored.
  process.on('SIGTERM', () => {})
  const socket = net.connect(${port}, '127.0.0.1', () => socket.write(String(process.pid)))
  socket.on('error', () => {})
  const reply = (requestId, response) => process.stdout.write(JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  }) + '\\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.type !== 'control_request') return
    if (message.request.subtype === 'get_available_models') {
      reply(message.request_id, { models: [{ id: '${FAKE_MODEL_ID}', label: 'Fake Qwen', contextWindowSize: 8192 }] })
    } else {
      reply(message.request_id, {})
    }
  })
}
`
}

test('a discovered CLI and every process it started are gone once discovery returns', { timeout: 30_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-discovery-group-'))
  const binDirectory = path.join(root, 'bin')
  await fs.mkdir(binDirectory)

  let workerSocket: net.Socket | undefined
  let workerPid: number | undefined
  let workerConnected!: () => void
  const connected = new Promise<void>((resolve) => { workerConnected = resolve })
  let workerClosed!: () => void
  const workerGone = new Promise<void>((resolve) => { workerClosed = resolve })
  const server = net.createServer((socket) => {
    workerSocket = socket
    socket.once('data', (chunk) => {
      workerPid = Number(chunk.toString())
      workerConnected()
    })
    socket.on('close', () => workerClosed())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const qwenPath = path.join(binDirectory, 'qwen')
  await fs.writeFile(qwenPath, fakeQwenScript(address.port), { mode: 0o755 })

  // Only the fake is on the path: no installed CLI is started by this test.
  const savedPath = process.env.PATH
  const savedFallback = process.env.PIPELINE_CLI_PATH_FALLBACK
  process.env.PATH = binDirectory
  process.env.PIPELINE_CLI_PATH_FALLBACK = '0'

  t.after(async () => {
    process.env.PATH = savedPath
    if (savedFallback === undefined) delete process.env.PIPELINE_CLI_PATH_FALLBACK
    else process.env.PIPELINE_CLI_PATH_FALLBACK = savedFallback
    // A worker still connected is alive and is this test's own fixture.
    if (workerSocket && !workerSocket.closed && workerPid !== undefined) {
      process.kill(workerPid, 'SIGKILL')
      await workerGone
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  })

  const service = new ProviderSettingsService({ storagePath: path.join(root, 'provider-settings.json') })
  const agents = await service.listCliAgents(true)

  const qwen = agents.find((agent) => agent.id === 'qwen')
  assert.ok(qwen?.available, 'the fake qwen was found')
  assert.ok(
    qwen.models.some((model) => model.id === FAKE_MODEL_ID),
    'discovery read the model the fake reported',
  )
  await connected
  t.diagnostic(`discovery returned ${FAKE_MODEL_ID}; waiting for worker ${workerPid} to exit`)
  // The worker holds a socket to this test; it closes when the worker exits.
  await workerGone
})
