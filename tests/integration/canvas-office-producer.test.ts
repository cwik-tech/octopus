import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { buildSessionRunAssignmentLocation, writeRunAssignmentLocator } from '../../domains/run/run-location.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import { GenerateWordToolService } from '../../services/generate-word-tool-service.js'
import { GenerateExcelToolService } from '../../services/generate-excel-tool-service.js'
import { generateWordToolModule } from '../../server/tools/generate-word.js'
import { generateExcelToolModule } from '../../server/tools/generate-excel.js'
import { createOfficeDocument, readOfficeRevision } from '../../services/canvas-office-document-store.js'

for (const format of ['docx', 'xlsx'] as const) {
  test(`a generated ${format} digest survives real journal replay, delivery and editable admission`, async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'office-producer-')))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const workspacePath = path.join(root, 'workspace')
    const repoRootPath = path.join(root, 'repo')
    const sessionStore = new FileSystemSessionStore(workspacePath)
    const session = await sessionStore.createSession({ title: 'Generated Office origin' })
    const identity = { sessionId: session.id, runId: 'origin-run', assignmentId: 'origin-assignment' }
    const location = buildSessionRunAssignmentLocation(workspacePath, identity)
    assert.ok(location)
    await fs.mkdir(location.assignmentPath, { recursive: true })
    await writeRunAssignmentLocator(workspacePath, location)
    const agent = path.join(repoRootPath, 'agents', 'writer')
    await fs.mkdir(agent, { recursive: true })
    await fs.writeFile(path.join(agent, 'writer.md'), '---\nname: writer\ntools: generate_word, generate_excel\n---\n\n# Writer\n')
    await fs.writeFile(path.join(location.assignmentPath, 'source.md'), '# Metrics\n\n| Metric | Value |\n| --- | ---: |\n| Leads | 42 |\n')
    const leases = new McpRunLeaseStore()
    const lease = leases.issue({ ...identity, allowedAgentPaths: ['agents/writer'] })
    const runtime = new CapabilityDispatchRuntime({ workspacePath, executionJournal: { mode: 'authoritative', tenantId: 'local' }, leaseResolver: (context) => leases.resolve(context), runtimeAuthority: { authorize: async () => { throw new Error('Only the real fixture lease may authorize this producer') } } })
    t.after(() => runtime.close())
    const common = { capabilityDispatcher: runtime.dispatcher }
    const tool = format === 'docx'
      ? generateWordToolModule.build({ ...common, moduleOptions: { 'generate-word': { toolService: new GenerateWordToolService({ workspacePath, repoRootPath }) } } }).agentTool
      : generateExcelToolModule.build({ ...common, moduleOptions: { 'generate-excel': { toolService: new GenerateExcelToolService({ workspacePath, repoRootPath }) } } }).agentTool
    assert.ok(tool)
    const invocation = { context: { contractVersion: 1 as const, ...identity, leaseId: lease.leaseId, requestId: 'generate', agentPath: 'agents/writer' }, toolCallId: 'generate-office', input: { action: 'generate', inputPath: 'source.md', outputPath: `exports/report.${format}`, ...(format === 'docx' ? { renderMermaid: false } : {}) } }

    const generated = await tool.execute(invocation)

    assert.equal(generated.isError, false, generated.content)
    const artifact = generated.artifacts?.[0]
    assert.ok(artifact)
    assert.ok('digest' in artifact && typeof artifact.digest === 'string')
    const file = path.join(location.assignmentPath, artifact.path)
    const bytes = await fs.readFile(file)
    assert.equal(artifact.digest, createHash('sha256').update(bytes).digest('hex'))
    await sessionStore.appendChatMessage(session.id, { id: 'delivery', role: 'assistant', text: 'Ready', createdAt: '2026-10-19T00:00:00.000Z', delivery: { taskId: identity.assignmentId, artifacts: [{ ...artifact, runId: identity.assignmentId }] } })
    const scope = { workspacePath, sessionId: session.id, sessionStore, target: { runId: identity.assignmentId, artifactPath: artifact.path }, signal: AbortSignal.timeout(5000) }
    const saved = await createOfficeDocument(scope)
    assert.equal(saved.ok, true)
    await fs.unlink(file)
    const replayed = await tool.execute(invocation)
    assert.deepEqual(replayed.artifacts, generated.artifacts)
    await assert.rejects(fs.stat(file), { code: 'ENOENT' })
    const retained = await readOfficeRevision({ ...scope, documentId: saved.document.id, revision: 'original' })
    assert.equal(retained.ok, true)
    assert.deepEqual(retained.bytes, bytes)
  })
}
