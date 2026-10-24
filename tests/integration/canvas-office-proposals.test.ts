import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { generateWordBuffer } from '../../domains/word-generation/generate-word.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createOfficeDocument, readOfficeRevision } from '../../services/canvas-office-document-store.js'
import { proposeOfficeEdit, disposeOfficeEdit, readOfficeCandidate, getOfficeDocumentState } from '../../services/canvas-office-document-service.js'
import { registerProvider } from '../../providers/registry.js'
import { getRuntimeDefaultModelState, setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'

const unavailable = process.platform !== 'darwin' || !existsSync(path.join(process.cwd(), 'build', 'office-tools', `${process.platform}-${process.arch}`, 'manifest.json'))
async function fixture(t: TestContext) {
  const workspacePath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'office-proposal-')))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Office edit' })
  const target = { runId: 'office-run', artifactPath: 'files/report.docx' }
  const bytes = (await generateWordBuffer('# Quarterly report\n\nKeep the other paragraph.', { renderMermaid: false })).buffer
  const file = path.join(workspacePath, 'assignments', target.runId, target.artifactPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, bytes)
  await sessionStore.appendChatMessage(session.id, { id: 'delivery', role: 'assistant', text: 'Ready', createdAt: '2026-10-19T00:00:00.000Z', delivery: { taskId: target.runId, artifacts: [{ runId: target.runId, path: target.artifactPath, role: 'final', digest: createHash('sha256').update(bytes).digest('hex') }] } })
  return { workspacePath, sessionStore, session, target, bytes, file }
}

test('a real native candidate leaves current and original bytes unchanged until explicit acceptance', { skip: unavailable }, async (t) => {
  const { workspacePath, sessionStore, session, target, bytes, file } = await fixture(t)
  let requests = 0
  // Only the paid/nondeterministic provider HTTP endpoint is substituted.
  // Admission, snapshots, scoped targets, CLI editing and publication are real.
  const remote = createServer((req, res) => { req.resume(); req.on('end', () => { requests += 1; res.end(JSON.stringify({ operations: [{ kind: 'text', target: 'target-0', text: 'Revised report' }], summary: 'Changed the report heading.' })) }) })
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
  t.after(async () => { remote.closeAllConnections(); await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve())) })
  const address = remote.address()
  assert.ok(address && typeof address !== 'string')
  registerProvider({ name: 'office-proposal-fixture', async execute(options) {
    const response = await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', body: options.userMessage, signal: options.signal ?? AbortSignal.timeout(2000) })
    return { text: await response.text(), cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0, model: options.model }
  } })
  const previous = getRuntimeDefaultModelState()
  t.after(() => setRuntimeDefaultModelState(previous))
  setRuntimeDefaultModelState({ status: 'available', provider: 'office-proposal-fixture', model: 'fixture' })
  const scope = { workspacePath, sessionId: session.id, sessionStore, signal: AbortSignal.timeout(20000), repoRoot: process.cwd() }
  const created = await createOfficeDocument({ ...scope, target })
  assert.equal(created.ok, true)
  const input = { ...scope, documentId: created.document.id, request: { baseRevision: 0, instruction: 'Change the heading to Revised report.', requestId: 'request-one', requestSequence: 1 } }

  const proposed = await proposeOfficeEdit(input)

  assert.equal(proposed.ok, true)
  assert.equal(proposed.document.proposal?.status, 'ready')
  assert.equal(proposed.document.revision, 0)
  assert.deepEqual(await fs.readFile(file), bytes)
  const current = await readOfficeRevision({ ...scope, documentId: created.document.id, revision: 0 })
  assert.equal(current.ok, true)
  assert.deepEqual(current.bytes, bytes)
  const proposalId = proposed.document.proposal?.id ?? ''
  const candidate = await readOfficeCandidate({ ...scope, documentId: created.document.id, proposalId })
  assert.equal(candidate.ok, true)
  assert.match(await (await JSZip.loadAsync(candidate.bytes)).file('word/document.xml')?.async('string') ?? '', /Revised report/)
  const accepted = await disposeOfficeEdit({ ...scope, documentId: created.document.id, disposition: { kind: 'accept', proposalId, expectedRevision: 0 } })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.document.revision, 1)
  assert.deepEqual(await proposeOfficeEdit(input), accepted)
  assert.equal(requests, 1, 'A terminal replay must not make another provider request')
  assert.deepEqual(await fs.readFile(file), bytes)
})

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred value not arranged') }
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

test('a late provider response after discard cannot replace a newer proposal on the same saved revision', { skip: unavailable, timeout: 15000 }, async (t) => {
  const f = await fixture(t)
  const firstArrived = deferred<void>()
  const firstReply = deferred<void>()
  let requests = 0
  // A paid provider may finish after cancellation. Only its HTTP endpoint is
  // replaced; deliberately delay its first response across the discard race.
  const remote = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests += 1
      const first = requests === 1
      const send = () => res.end(JSON.stringify({ operations: [{ kind: 'text', target: 'target-0', text: first ? 'Obsolete heading' : 'Current heading' }], summary: first ? 'Obsolete proposal' : 'Current proposal' }))
      if (first) { firstArrived.resolve(); void firstReply.promise.then(send) }
      else send()
    })
  })
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
  t.after(async () => { firstReply.resolve(); remote.closeAllConnections(); await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve())) })
  const address = remote.address()
  assert.ok(address && typeof address !== 'string')
  registerProvider({ name: 'office-late-fixture', async execute(options) {
    // This boundary intentionally ignores caller abort to reproduce late output,
    // but retains a deadline so the regression cannot leave a network request.
    const response = await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', body: options.userMessage, signal: AbortSignal.timeout(10000) })
    return { text: await response.text(), cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0, model: options.model }
  } })
  const previous = getRuntimeDefaultModelState()
  t.after(() => setRuntimeDefaultModelState(previous))
  setRuntimeDefaultModelState({ status: 'available', provider: 'office-late-fixture', model: 'fixture' })
  const scope = { workspacePath: f.workspacePath, sessionId: f.session.id, sessionStore: f.sessionStore, signal: AbortSignal.timeout(14000), repoRoot: process.cwd() }
  const created = await createOfficeDocument({ ...scope, target: f.target })
  assert.equal(created.ok, true)
  const input = { ...scope, documentId: created.document.id }
  const obsolete = proposeOfficeEdit({ ...input, request: { baseRevision: 0, instruction: 'First instruction', requestId: 'old', requestSequence: 1 } })
  await firstArrived.promise
  const generating = await getOfficeDocumentState(input)
  assert.equal(generating.ok, true)
  const discarded = await disposeOfficeEdit({ ...input, disposition: { kind: 'discard', proposalId: generating.document.proposal?.id ?? '', expectedRevision: 0 } })
  assert.equal(discarded.ok, true)

  const current = await proposeOfficeEdit({ ...input, request: { baseRevision: 0, instruction: 'Second instruction', requestId: 'new', requestSequence: 2 } })
  assert.equal(current.ok, true)
  assert.equal(current.document.proposal?.status, 'ready')
  firstReply.resolve()
  await obsolete

  assert.deepEqual(await getOfficeDocumentState(input), current)
  assert.equal(current.document.revision, 0)
  assert.equal(current.document.proposal?.summary, 'Current proposal')
})
