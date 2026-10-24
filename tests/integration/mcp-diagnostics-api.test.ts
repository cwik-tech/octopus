import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import { hashMcpApprovalArguments } from '../../domains/mcp/mcp-approval.js'
import { McpEvidenceStore } from '../../domains/mcp/mcp-evidence-store.js'
import { logSessionStart } from '../../domains/runtime/logger.js'
import {
  buildSessionRunAssignmentLocation,
  writeRunAssignmentLocator,
} from '../../domains/run/run-location.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'

test('run diagnostics exposes sanitized MCP audit and evidence metadata without content or paths', async () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-diagnostics-api-'),
  )
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-diagnostics',
    runId: 'run-diagnostics',
    assignmentId: 'assignment-diagnostics',
  })
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })
  logSessionStart(
    location.assignmentPath,
    location.assignmentId,
    'diagnostics-team',
    ['diagnostics-agent'],
    location.runId,
  )
  await writeRunAssignmentLocator(workspacePath, location)

  const secretArgument = 'secret-query-that-must-not-be-returned'
  const secretResult = 'secret-tool-result-that-must-not-be-returned'
  const argumentSummary = hashMcpApprovalArguments({ query: secretArgument })
  const evidenceStore = new McpEvidenceStore({
    workspacePath,
    sessionId: location.sessionId,
    runId: location.runId,
    assignmentId: location.assignmentId,
  })
  await evidenceStore.appendAuditEvent({
    type: 'mcp.tool.completed',
    timestamp: '2026-07-12T22:00:00.000Z',
    sessionId: location.sessionId,
    runId: location.runId,
    assignmentId: location.assignmentId,
    agentPath: 'agents/diagnostics-agent',
    serverId: 'diagnostics-server',
    requestId: 'parent-request-secret-id',
    toolCallId: 'tool-call-1',
    namespacedToolName: 'mcp__diagnostics-server__query',
    toolRisk: 'read-only',
    argumentNames: argumentSummary.argumentNames,
    argumentsHash: argumentSummary.argumentsHash,
    durationMs: 42,
    resultByteCount: Buffer.byteLength(secretResult, 'utf8'),
    resultHash: {
      algorithm: 'sha256',
      value: createHash('sha256').update(secretResult).digest('hex'),
    },
  })
  await evidenceStore.importToolResultEvidence({
    sessionId: location.sessionId,
    runId: location.runId,
    assignmentId: location.assignmentId,
    agentPath: 'agents/diagnostics-agent',
    serverId: 'diagnostics-server',
    requestId: 'parent-request-secret-id',
    toolCallId: 'tool-call-1',
    namespacedToolName: 'mcp__diagnostics-server__query',
    content: [{ type: 'text', text: secretResult }],
  })

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: process.pid, cwd: workspacePath }
      },
    },
    workspacePath,
  })

  try {
    const response = await fetch(
      `${server.url}/runs/${location.assignmentId}/diagnostics`,
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')

    const payload = await response.json() as {
      mcp: {
        audit: Array<Record<string, unknown>>
        toolResults: Array<Record<string, unknown> & {
          contents: Array<{ storedPath: string }>
        }>
      }
    }
    assert.equal(payload.mcp.audit.length, 1)
    assert.equal(payload.mcp.audit[0]?.type, 'mcp.tool.completed')
    assert.equal(payload.mcp.audit[0]?.durationMs, 42)
    assert.ok(!('requestId' in payload.mcp.audit[0]!))
    assert.equal(payload.mcp.toolResults.length, 1)
    assert.ok(!('evidencePath' in payload.mcp.toolResults[0]!))
    assert.equal(
      payload.mcp.toolResults[0]?.contents[0]?.storedPath,
      'contents/00.txt',
    )

    const encoded = JSON.stringify(payload)
    assert.doesNotMatch(encoded, /secret-query-that-must-not-be-returned/)
    assert.doesNotMatch(encoded, /secret-tool-result-that-must-not-be-returned/)
    assert.doesNotMatch(encoded, /parent-request-secret-id/)
    assert.ok(!encoded.includes(workspacePath))
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
