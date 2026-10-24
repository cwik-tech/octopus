import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import { hashCanonicalJson } from '../../core/canonical-json-hash.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { createJournalBackedDurableDispatch } from '../../core/durable-dispatch-journal.js'
import { buildSessionRunAssignmentLocation, writeRunAssignmentLocator } from '../../domains/run/run-location.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { createAssignmentCapabilityResultStore, capabilityResultsDirectoryPath } from '../../services/capability-result-content-store.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import { createFileTool } from '../../services/create-file-tool-service.js'
import { toBuiltinCapabilityExecutionContext } from '../../services/builtin-capability-context.js'
import { accessCanvasDocument } from '../../services/canvas-document-service.js'

const content = '\uFEFF# Tulips\r\n\r\nExact original: żółty 🌷\r\n'
const filename = 'Tulips.md'

async function fixture(t: TestContext) {
  const workspacePath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-file-origin-')))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'File tool origin' })
  const scope = { sessionId: session.id, runId: 'origin-run', assignmentId: 'origin-assignment' }
  const location = buildSessionRunAssignmentLocation(workspacePath, scope)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  await writeRunAssignmentLocator(workspacePath, location)
  const target = { runId: scope.assignmentId, artifactPath: `files/${filename}` }
  const input = { workspacePath, sessionId: session.id, sessionStore, target, signal: new AbortController().signal }
  return { ...input, scope, location,
    file: path.join(location.assignmentPath, target.artifactPath),
    create: () => accessCanvasDocument({ ...input, action: { kind: 'create', target } }),
    async deliver(digest?: string, taskId = scope.assignmentId) {
      await sessionStore.appendChatMessage(session.id, { id: 'delivery', role: 'assistant', text: 'Ready', createdAt: '2026-10-18T00:00:00.000Z', delivery: { taskId, artifacts: [{ runId: target.runId, path: target.artifactPath, role: 'final', ...(digest ? { digest } : {}) }] } })
    },
  }
}

async function legacyReceipt(f: Awaited<ReturnType<typeof fixture>>, options: { content?: string; resultPath?: string; owner?: string; source?: string; dispatchId?: string; incomplete?: boolean; authority?: string; preparedRequest?: string; futureStage?: boolean; startedVersion?: number } = {}) {
  const journal = await initializeExecutionJournal({ scopeRoot: f.location.assignmentPath, identity: { scopeKind: 'assignment', scopeId: f.scope.assignmentId, tenantId: 'local', ...f.scope, ...(options.owner ? { sessionId: options.owner } : {}) } })
  try {
    const port = createJournalBackedDurableDispatch(journal, { resultContentStore: createAssignmentCapabilityResultStore({ assignmentPath: f.location.assignmentPath }) })
    const dispatchId = options.dispatchId ?? 'legacy-create'
    const argumentDigest = hashCanonicalJson({ filename, content: options.content ?? content }).value
    const identity = { ...f.scope, contractVersion: 1, dispatchId, attemptId: 'attempt', requestId: 'request', agentPath: 'agents/general-agent', authorityKind: options.authority ?? 'mcp-lease', capabilityId: 'file.create', sourceKind: 'builtin', sourceId: options.source ?? 'pipeline-files', sourceVersion: '1', argumentNames: ['content', 'filename'], argumentDigest, effect: { ...serialCapabilityEffect('mutating') } }
    await port.recordRequested({ dispatchId, attemptId: 'attempt', identity })
    await port.recordPrepared({ dispatchId, attemptId: 'attempt', identity: { ...identity, requestId: options.preparedRequest ?? identity.requestId }, argumentDigest, capabilityId: 'file.create', effect: serialCapabilityEffect('mutating'), recoveryPolicy: 'non_retryable' })
    if (options.startedVersion) {
      await journal.append({ eventId: `${dispatchId}:future-started`, streamKind: 'capability.dispatch', streamId: dispatchId, expectedStreamRevision: 2, type: 'capability.dispatch.started', payloadSchemaVersion: options.startedVersion, payload: { attemptId: 'attempt', identity }, correlationId: dispatchId })
    } else {
      await port.recordStarted({ dispatchId, attemptId: 'attempt', identity })
    }
    if (options.futureStage) await journal.append({ eventId: `${dispatchId}:future`, streamKind: 'capability.dispatch', streamId: dispatchId, expectedStreamRevision: 3, type: 'capability.dispatch.future', payloadSchemaVersion: 1, payload: { attemptId: 'attempt', identity }, correlationId: dispatchId })
    if (!options.incomplete) await port.recordAccepted({ dispatchId, attemptId: 'attempt', identity, result: { status: 'completed', dispatchId, costTracked: false, budgetOverrun: false, value: { ok: true, artifact: { path: options.resultPath ?? f.target.artifactPath, title: filename, mediaType: 'text/markdown', role: 'final' }, sizeBytes: Buffer.byteLength(options.content ?? content) } } })
  } finally { await journal.close() }
}

async function historical(t: TestContext, options: Parameters<typeof legacyReceipt>[1] = {}) {
  const f = await fixture(t)
  await fs.mkdir(path.dirname(f.file), { recursive: true })
  await fs.writeFile(f.file, content)
  await legacyReceipt(f, options)
  await f.deliver()
  return f
}

test('a real file-tool delivery opens an editable copy using its produced digest', async (t) => {
  const f = await fixture(t)
  const leases = new McpRunLeaseStore()
  const lease = leases.issue({ ...f.scope, allowedAgentPaths: ['agents/general-agent'] })
  const runtime = new CapabilityDispatchRuntime({ workspacePath: f.workspacePath, executionJournal: { mode: 'authoritative', tenantId: 'local' }, leaseResolver: (context) => leases.resolve(context), runtimeAuthority: { authorize: async () => { throw new Error('This fixture requires the real file-tool lease.') } } })
  try {
    const result = await createFileTool({ workspacePath: f.workspacePath, dispatcher: runtime.dispatcher }).execute({ context: { contractVersion: 1, ...f.scope, leaseId: lease.leaseId, requestId: 'request', agentPath: 'agents/general-agent' }, toolCallId: 'create', input: { filename, content } })
    assert.equal(result.isError, false, result.content)
    const artifact = result.artifacts?.[0]
    assert.ok(artifact)
    assert.ok('digest' in artifact && typeof artifact.digest === 'string', 'The actual file-tool output must publish a trusted byte digest')
    await f.deliver(artifact.digest)
    assert.equal((await f.create()).content, content)
    assert.equal(await fs.readFile(f.file, 'utf8'), content)
  } finally { await runtime.close() }
})

test('the file tool can replay an accepted historical result without a digest', async (t) => {
  const f = await fixture(t)
  const leases = new McpRunLeaseStore()
  const lease = leases.issue({ ...f.scope, allowedAgentPaths: ['agents/general-agent'] })
  const context = { contractVersion: 1 as const, ...f.scope, leaseId: lease.leaseId, requestId: 'historical-request', agentPath: 'agents/general-agent' }
  const runtime = new CapabilityDispatchRuntime({ workspacePath: f.workspacePath, executionJournal: { mode: 'authoritative', tenantId: 'local' }, leaseResolver: (candidate) => leases.resolve(candidate), runtimeAuthority: { authorize: async () => { throw new Error('This fixture requires the real file-tool lease.') } } })
  try {
    // Public dispatch records the historical producer result through the real
    // authority, journal and retained-result store. No provider is called.
    const created = await runtime.dispatcher.dispatch({
      context: toBuiltinCapabilityExecutionContext(context, { kind: 'mcp-lease', leaseId: lease.leaseId }),
      invocation: { capabilityId: 'file.create', source: { kind: 'builtin', id: 'pipeline-files', version: '1' }, toolCallId: 'historical-call', input: { filename, content } },
      adapter: { capabilityId: 'file.create', async prepare() { return { effect: serialCapabilityEffect('mutating'), risk: 'mutating', argumentNames: ['content', 'filename'], policyDecision: { kind: 'allow' }, authorize: async () => ({ kind: 'allow' }), execute: async () => {
        await fs.mkdir(path.dirname(f.file), { recursive: true })
        await fs.writeFile(f.file, content)
        return { ok: true, artifact: { path: f.target.artifactPath, title: filename, mediaType: 'text/markdown', role: 'final' }, sizeBytes: Buffer.byteLength(content) }
      }, acceptResult: async ({ value }) => ({ value }) } } },
    })
    assert.equal(created.status, 'completed')
    const replayed = await createFileTool({ workspacePath: f.workspacePath, dispatcher: runtime.dispatcher }).execute({ context, toolCallId: 'historical-call', input: { filename, content } })
    assert.equal(replayed.isError, false, replayed.content)
    await f.deliver()
    assert.equal((await f.create()).content, content)
  } finally { await runtime.close() }
})

test('historical digestless deliveries recover exact bytes from the accepted creation arguments', async (t) => {
  const f = await historical(t)
  const document = await f.create()
  assert.equal(document.content, content)
  const snapshot = path.join(f.workspacePath, 'sessions', f.sessionId, 'canvas-documents', 'snapshots', document.snapshotDigest)
  assert.deepEqual(await fs.readFile(snapshot), Buffer.from(content))
  assert.equal(await fs.readFile(f.file, 'utf8'), content)
})

test('legacy proof rejects changed bytes even when the current file has the original length', async (t) => {
  const f = await historical(t)
  await fs.writeFile(f.file, content.replace('Tulips', 'Lilies'))
  await assert.rejects(f.create(), { code: 'origin_changed' })
})

for (const [name, options] of [
  ['another owner', { owner: 'foreign-session' }],
  ['another result path', { resultPath: 'other/Tulips.md' }],
  ['another source', { source: 'untrusted-source' }],
  ['an unaccepted dispatch', { incomplete: true }],
  ['unsupported creation authority', { authority: 'runtime-assignment' }],
  ['contradictory prepared identity', { preparedRequest: 'different-request' }],
  ['an unknown durable stage', { futureStage: true }],
  ['an unsupported durable payload version', { startedVersion: 999 }],
] as const) {
  test(`legacy admission refuses ${name}`, async (t) => {
    const f = await historical(t, options)
    await assert.rejects(f.create(), { code: 'origin_unverifiable' })
  })
}

test('legacy admission refuses a second contradictory accepted creation for the same path', async (t) => {
  const f = await historical(t)
  await legacyReceipt(f, { dispatchId: 'recreated', content: 'Replacement after delete' })
  await assert.rejects(f.create(), { code: 'origin_unverifiable' })
})

test('legacy admission refuses a second accepted creation even when its bytes are identical', async (t) => {
  const f = await historical(t)
  await legacyReceipt(f, { dispatchId: 'recreated-with-same-bytes' })
  await assert.rejects(f.create(), { code: 'origin_unverifiable' })
})

test('a delivery from another task cannot borrow an accepted creation receipt', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(path.dirname(f.file), { recursive: true })
  await fs.writeFile(f.file, content)
  await legacyReceipt(f)
  await f.deliver(undefined, 'other-task')
  await assert.rejects(f.create(), { code: 'origin_unverifiable' })
})

test('legacy admission refuses a tampered retained result', async (t) => {
  const f = await historical(t)
  const directory = capabilityResultsDirectoryPath(f.location.assignmentPath)
  const names = await fs.readdir(directory)
  assert.equal(names.length, 1)
  const name = names[0]
  assert.ok(name)
  await fs.writeFile(path.join(directory, name), '{"ok":true}')
  await assert.rejects(f.create(), { code: 'origin_unverifiable' })
})

test('legacy admission refuses a changed or truncated journal and does not repair it', async (t) => {
  const f = await historical(t)
  const journal = path.join(f.location.assignmentPath, '.runtime', 'execution-journal', 'journal.jsonl')
  await fs.appendFile(journal, '{"incomplete":')
  const before = await fs.readFile(journal)
  await assert.rejects(f.create(), { code: 'origin_unverifiable' })
  assert.deepEqual(await fs.readFile(journal), before)
})
