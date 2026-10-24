import test from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { handleCanvasDocumentRoutes } from '../../server/routes/canvas-documents.js'
import { canvasDocumentSchema } from '../../contracts/canvas-documents.js'
import { registerProvider } from '../../providers/registry.js'
import { getRuntimeDefaultModelState, setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'

async function fixture() {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-document-api-'))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Editing owner' })
  const other = await sessionStore.createSession({ title: 'Other owner' })
  const target = { runId: 'document-run', artifactPath: 'files/report.md' }
  const origin = path.join(workspacePath, 'assignments', target.runId, target.artifactPath)
  await fs.mkdir(path.dirname(origin), { recursive: true })
  await fs.writeFile(origin, '# Original')
  await sessionStore.appendChatMessage(session.id, { id: 'delivery', role: 'assistant', text: 'Ready', createdAt: '2026-10-18T00:00:00.000Z', delivery: { taskId: 'task', artifacts: [{ runId: target.runId, path: target.artifactPath, role: 'final', digest: crypto.createHash('sha256').update('# Original').digest('hex') }] } })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    void handleCanvasDocumentRoutes({ req, res, url, sessionId: url.pathname.split('/')[2] ?? '', options: { workspacePath, sessionStore } }).catch((error: unknown) => { res.statusCode = 500; res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unexpected error' })) })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const request = (owner: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}/sessions/${owner}/canvas/document?${new URLSearchParams(target)}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(4000) })
  return { workspacePath, sessionStore, session, other, target, origin, request, async close() {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await fs.rm(workspacePath, { recursive: true, force: true })
  } }
}

test('real HTTP creates and saves a verified Markdown working document while refusing stale and foreign writes', async () => {
  const { session, other, target, origin, request, close } = await fixture()
  try {
    assert.equal((await request(session.id)).status, 404)
    assert.equal((await request(other.id, { kind: 'create', target })).status, 404)
    const created = await request(session.id, { kind: 'create', target })
    assert.equal(created.status, 200)
    assert.equal(canvasDocumentSchema.parse(await created.json()).content, '# Original')
    const writes = await Promise.all([request(session.id, { kind: 'save', target, expectedRevision: 0, content: '# First save' }), request(session.id, { kind: 'save', target, expectedRevision: 0, content: '# Other save' })])
    assert.deepEqual(writes.map((response) => response.status).sort(), [200, 409])
    assert.equal(canvasDocumentSchema.parse(await (await request(session.id)).json()).revision, 1)
    assert.equal(await fs.readFile(origin, 'utf8'), '# Original')
    assert.equal((await request(session.id, { kind: 'create', target, extra: true })).status, 400)
  } finally { await close() }
})

test('real HTTP provider dispatch captures a selected range and requires explicit acceptance', async () => {
  const f = await fixture()
  const previous = getRuntimeDefaultModelState()
  let captured = ''
  // The remote paid model is replaced at its HTTP boundary by a local server.
  // This proves dispatch and storage, not third-party model compatibility.
  const remote = http.createServer((req, res) => {
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { captured += chunk })
    req.on('end', () => { res.end('Revised') })
  })
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
  const address = remote.address()
  assert.ok(address && typeof address !== 'string')
  registerProvider({ name: 'canvas-document-test', async execute(options) {
    const response = await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', body: JSON.stringify(options), signal: options.signal ?? AbortSignal.timeout(2000) })
    return { text: await response.text(), cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0, model: options.model }
  } })
  setRuntimeDefaultModelState({ status: 'available', provider: 'canvas-document-test', model: 'fixture' })
  try {
    await f.request(f.session.id, { kind: 'create', target: f.target })
    assert.equal((await f.request(f.session.id, { kind: 'propose', target: f.target, expectedRevision: 5, selectionStart: 2, selectionEnd: 10, selectedText: 'Original', instruction: 'Do not dispatch' })).status, 409)
    assert.equal(captured, '')
    const response = await f.request(f.session.id, { kind: 'propose', target: f.target, expectedRevision: 0, selectionStart: 2, selectionEnd: 10, selectedText: 'Original', instruction: 'Revise the selected word' })
    assert.equal(response.status, 200)
    const ready = canvasDocumentSchema.parse(await response.json())
    assert.equal(ready.proposal?.status, 'ready')
    assert.equal(ready.proposal?.replacementText, 'Revised')
    assert.equal(ready.content, '# Original')
    assert.match(captured, /Revise the selected word/)
    assert.match(captured, /Original/)
    assert.ok(ready.proposal)
    const accepted = await f.request(f.session.id, { kind: 'accept', target: f.target, proposalId: ready.proposal.id, hasUnsavedDraft: false })
    assert.equal(canvasDocumentSchema.parse(await accepted.json()).content, '# Revised')
  } finally {
    setRuntimeDefaultModelState(previous)
    remote.closeAllConnections()
    await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()))
    await f.close()
  }
})

test('discarding a generating request over real HTTP prevents its late provider response from reactivating it', async () => {
  const f = await fixture()
  const previous = getRuntimeDefaultModelState()
  let entered = () => {}
  const received = new Promise<void>((resolve) => { entered = resolve })
  let release = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  // A deterministic loopback replaces the paid provider's remote HTTP boundary.
  const remote = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      entered()
      void released.then(() => { res.end('Late replacement') })
    })
  })
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
  const address = remote.address()
  assert.ok(address && typeof address !== 'string')
  registerProvider({ name: 'canvas-discard-test', async execute(options) {
    const response = await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', body: options.userMessage, signal: options.signal ?? AbortSignal.timeout(2000) })
    return { text: await response.text(), cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0, model: options.model }
  } })
  setRuntimeDefaultModelState({ status: 'available', provider: 'canvas-discard-test', model: 'fixture' })
  try {
    await f.request(f.session.id, { kind: 'create', target: f.target })
    const pending = f.request(f.session.id, { kind: 'propose', target: f.target, expectedRevision: 0, selectionStart: 2, selectionEnd: 10, selectedText: 'Original', instruction: 'Revise' })
    await received
    const generating = canvasDocumentSchema.parse(await (await f.request(f.session.id)).json())
    assert.equal(generating.proposal?.status, 'generating')
    assert.ok(generating.proposal)
    const discarded = await f.request(f.session.id, { kind: 'discard', target: f.target, proposalId: generating.proposal.id })
    assert.equal(canvasDocumentSchema.parse(await discarded.json()).proposal?.status, 'discarded')
    release()
    const late = canvasDocumentSchema.parse(await (await pending).json())
    assert.equal(late.proposal?.status, 'discarded')
    assert.equal(late.content, '# Original')
    assert.equal(late.revision, 0)
  } finally {
    release()
    setRuntimeDefaultModelState(previous)
    remote.closeAllConnections()
    await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()))
    await f.close()
  }
})
