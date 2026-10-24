import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  BrowserManager,
  type BrowserExecutionScope,
} from '../../domains/browser/browser-manager.js'
import type {
  BrowserToolInput,
  BrowserToolOutput,
} from '../../domains/browser/browser-types.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { BrowserToolService } from '../../services/browser-tool-service.js'
import { executeBrowserDomainForTest } from '../support/browser-capability-fixture.js'

test('observation receipt rejects symlinked and byte-mismatched browser content', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'browser-receipt-safety-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const manager = new ReceiptFixtureManager(path.join(root, 'profile'))
  const service = new BrowserToolService({
    workspacePath,
    repoRootPath,
    manager,
  })
  const context: McpBrokerRequestContext & {
    readonly activityScopeId: string
  } = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-receipt-safety',
    leaseId: 'lease-receipt-safety',
    sessionId: 'session-receipt-safety',
    runId: 'run-receipt-safety',
    assignmentId: 'assignment-receipt-safety',
    activityScopeId: 'lane-symlink',
    agentPath: 'agents/researcher',
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, context)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })
  writeBrowserPolicy(repoRootPath)

  try {
    manager.fixture = 'symlink'
    const symlinked = await executeBrowserDomainForTest(
      service,
      context,
      'call-symlink',
      { action: 'open', url: 'https://example.test/evidence' },
    )
    assert.equal(symlinked.ok, false)
    assert.equal(symlinked.error?.code, 'internal')
    assert.equal(
      fs.existsSync(
        path.join(
          location.assignmentPath,
          'research',
          'observations',
          context.activityScopeId,
        ),
      ),
      false,
    )

    manager.fixture = 'mismatched-size'
    const mismatched = await executeBrowserDomainForTest(
      service,
      { ...context, activityScopeId: 'lane-mismatch' },
      'call-mismatch',
      { action: 'open', url: 'https://example.test/evidence' },
    )
    assert.equal(mismatched.ok, false)
    assert.equal(mismatched.error?.code, 'internal')
    assert.equal(
      (await service.listSession(context.sessionId))
        .filter((activity) => activity.state === 'failed')
        .length,
      2,
    )
  } finally {
    await manager.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('observation receipt publishes a run-scoped artifact event', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'browser-receipt-event-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const manager = new ReceiptFixtureManager(path.join(root, 'profile'))
  const service = new BrowserToolService({ workspacePath, repoRootPath, manager })
  const context: McpBrokerRequestContext & { readonly activityScopeId: string } = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-receipt-event',
    leaseId: 'lease-receipt-event',
    sessionId: 'session-receipt-event',
    runId: 'root-receipt-event',
    assignmentId: 'research-child-event',
    activityScopeId: 'lane-event',
    agentPath: 'agents/researcher',
    agentId: 'lane-event',
    agentDisplayName: 'Event Evidence Analyst',
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, context)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })
  writeBrowserPolicy(repoRootPath)

  try {
    manager.fixture = 'valid'
    const result = await executeBrowserDomainForTest(
      service,
      context,
      'call-event',
      { action: 'open', url: 'https://example.test/evidence' },
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.observationReceipt)

    const events = fs.readFileSync(
      path.join(location.assignmentPath, 'logs', 'engine-events.jsonl'),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const event = events.find((entry) => entry.type === 'artifact.written')
    assert.ok(event)
    assert.equal(event.run_id, context.assignmentId)
    assert.equal(event.root_run_id, context.runId)
    assert.equal(
      (event.payload as Record<string, unknown>).path,
      result.observationReceipt.relativePath,
    )
    const payload = event.payload as Record<string, unknown>
    assert.equal(payload.agent_id, 'lane-event')
    assert.equal(payload.agent_name, 'Event Evidence Analyst')
    assert.equal(payload.agent_base_name, 'researcher')
    assert.equal(payload.activity_scope_id, 'lane-event')
    assert.equal(payload.emitter_name, 'source-observation-store')
  } finally {
    await manager.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('browser scope accepts a canonical workspace reached through a symlinked ancestor', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'browser-scope-canonical-')),
  )
  const aliasHolder = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-scope-alias-'))
  const aliasRoot = path.join(aliasHolder, 'root')
  try {
    fs.symlinkSync(root, aliasRoot, 'dir')
  } catch (error) {
    fs.rmSync(aliasHolder, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return
    throw error
  }

  const workspacePath = path.join(aliasRoot, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const manager = new ReceiptFixtureManager(path.join(root, 'profile'))
  const service = new BrowserToolService({ workspacePath, repoRootPath, manager })
  const context: McpBrokerRequestContext & { readonly activityScopeId: string } = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-canonical-scope',
    leaseId: 'lease-canonical-scope',
    sessionId: 'session-canonical-scope',
    runId: 'run-canonical-scope',
    assignmentId: 'assignment-canonical-scope',
    activityScopeId: 'lane-canonical-scope',
    agentPath: 'agents/researcher',
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, context)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })
  writeBrowserPolicy(repoRootPath)

  try {
    manager.fixture = 'valid'
    const result = await executeBrowserDomainForTest(
      service,
      context,
      'call-canonical-scope',
      { action: 'open', url: 'https://example.test/evidence' },
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.observationReceipt)
    assert.equal(
      fs.existsSync(path.join(
        fs.realpathSync(location.assignmentPath),
        result.observationReceipt.relativePath,
      )),
      true,
    )

    const unsafeWorkspacePath = path.join(aliasRoot, 'unsafe-workspace')
    const unsafeSessionsPath = path.join(root, 'unsafe-sessions')
    const unsafeContext = {
      ...context,
      requestId: 'request-internal-symlink',
      sessionId: 'session-internal-symlink',
      runId: 'run-internal-symlink',
      assignmentId: 'assignment-internal-symlink',
      activityScopeId: 'lane-internal-symlink',
    }
    fs.mkdirSync(unsafeWorkspacePath, { recursive: true })
    fs.mkdirSync(path.join(
      unsafeSessionsPath,
      unsafeContext.sessionId,
      'runs',
      unsafeContext.runId,
      'assignments',
      unsafeContext.assignmentId,
    ), { recursive: true })
    fs.symlinkSync(
      unsafeSessionsPath,
      path.join(unsafeWorkspacePath, 'sessions'),
      'dir',
    )
    const unsafeService = new BrowserToolService({
      workspacePath: unsafeWorkspacePath,
      repoRootPath,
      manager,
    })
    const unsafeResult = await executeBrowserDomainForTest(
      unsafeService,
      unsafeContext,
      'call-internal-symlink',
      { action: 'open', url: 'https://example.test/evidence' },
    )
    assert.equal(unsafeResult.ok, false)
    assert.equal(unsafeResult.error?.code, 'invalid_request')
  } finally {
    await manager.close()
    fs.unlinkSync(aliasRoot)
    fs.rmSync(aliasHolder, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

class ReceiptFixtureManager extends BrowserManager {
  fixture: 'symlink' | 'mismatched-size' | 'valid' = 'symlink'

  constructor(profilePath: string) {
    super({ profilePath })
  }

  override async describeTarget(): Promise<undefined> {
    return undefined
  }

  override async execute(
    scope: BrowserExecutionScope,
    input: BrowserToolInput,
  ): Promise<BrowserToolOutput> {
    const directory = path.join(scope.assignmentPath, 'browser-content')
    const contentId = `browser-content-${this.fixture}`
    const target = path.join(directory, `${contentId}.txt`)
    fs.mkdirSync(directory, { recursive: true })
    fs.rmSync(target, { force: true })
    if (this.fixture === 'symlink') {
      const outside = path.join(path.dirname(scope.assignmentPath), 'outside.txt')
      fs.writeFileSync(outside, 'outside content', { mode: 0o600 })
      fs.symlinkSync(outside, target)
    } else {
      fs.writeFileSync(target, 'actual content bytes', { mode: 0o600 })
    }
    return {
      ok: true,
      action: input.action,
      url: 'https://example.test/evidence',
      title: 'Receipt fixture',
      content: {
        id: contentId,
        sizeBytes: this.fixture === 'symlink'
          ? 15
          : this.fixture === 'mismatched-size'
            ? 1
            : Buffer.byteLength('actual content bytes'),
        chunkCount: 1,
      },
    }
  }
}

function writeBrowserPolicy(repoRootPath: string): void {
  const agentDirectory = path.join(repoRootPath, 'agents', 'researcher')
  fs.mkdirSync(agentDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(agentDirectory, 'researcher.md'),
    [
      '---',
      'name: researcher',
      'tools: browser',
      'browser_restrict_domains: false',
      '---',
      '',
      '# Researcher',
    ].join('\n'),
  )
}
