import { whenDefined } from '../../core/optional-properties.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { hashMcpApprovalArguments } from '../../domains/mcp/mcp-approval.js'
import {
  McpEvidenceStore,
  McpEvidenceStoreError,
  type McpAuditEventInput,
  type McpAuditToolBindingInput,
  type McpToolResultEvidenceImportInput,
} from '../../domains/mcp/mcp-evidence-store.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'

const START_TIME = new Date('2026-07-12T20:00:00.000Z')

interface Harness {
  readonly workspacePath: string
  readonly assignmentPath: string
  readonly now: { value: Date }
  readonly store: McpEvidenceStore
  cleanup(): void
}

function createHarness(
  overrides: Partial<ConstructorParameters<typeof McpEvidenceStore>[0]> = {},
): Harness {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-evidence-unit-'),
  )
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })
  const now = { value: new Date(START_TIME) }
  return {
    workspacePath,
    assignmentPath: location.assignmentPath,
    now,
    store: new McpEvidenceStore({
      workspacePath,
      sessionId: location.sessionId,
      runId: location.runId,
      assignmentId: location.assignmentId,
      now: () => new Date(now.value),
      ...overrides,
    }),
    cleanup() {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    },
  }
}

function toolAuditBase(
  overrides: Partial<McpAuditToolBindingInput> = {},
): McpAuditToolBindingInput {
  const summary = hashMcpApprovalArguments({
    query: 'sensitive query must not enter audit',
  })
  return {
    timestamp: START_TIME.toISOString(),
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    workflowId: 'workflow-1',
    workflowStepId: 'step-1',
    agentPath: 'agents/researcher',
    serverId: 'database-server',
    requestId: 'request-1',
    toolCallId: 'call-1',
    namespacedToolName: 'mcp__database-server__query',
    toolRisk: 'mutating',
    argumentNames: summary.argumentNames,
    argumentsHash: summary.argumentsHash,
    ...overrides,
  }
}

function evidenceInput(
  overrides: Partial<McpToolResultEvidenceImportInput> = {},
): McpToolResultEvidenceImportInput {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    workflowId: 'workflow-1',
    workflowStepId: 'step-1',
    agentPath: 'agents/researcher',
    serverId: 'database-server',
    requestId: 'request-1',
    toolCallId: 'call-1',
    namespacedToolName: 'mcp__database-server__query',
    content: [
      { type: 'text', text: 'sensitive result text' },
      { type: 'json', value: { z: 2, a: { y: true, x: 1 } } },
    ],
    ...overrides,
  }
}

function contentHash(value: string) {
  return {
    algorithm: 'sha256' as const,
    value: createHash('sha256').update(value, 'utf8').digest('hex'),
  }
}

function hasCode(code: McpEvidenceStoreError['code']) {
  return (error: unknown): boolean =>
    error instanceof McpEvidenceStoreError && error.code === code
}

test('audit store accepts every sanitized lifecycle event and persists no values or messages', async () => {
  const harness = createHarness()
  const base = toolAuditBase()
  const resultHash = contentHash('canonical-result')
  const events: McpAuditEventInput[] = [
    { ...base, type: 'mcp.tool.requested' },
    {
      ...base,
      type: 'mcp.approval.requested',
      interactionId: 'approval-1',
    },
    {
      ...base,
      type: 'mcp.approval.resolved',
      interactionId: 'approval-1',
      approvalStatus: 'approved-once',
    },
    {
      type: 'mcp.elicitation.requested',
      timestamp: base.timestamp,
      sessionId: base.sessionId,
      runId: base.runId,
      assignmentId: base.assignmentId,
      ...whenDefined(base.workflowId, (workflowId) => ({ workflowId: workflowId })),
      ...whenDefined(base.workflowStepId, (workflowStepId) => ({ workflowStepId: workflowStepId })),
      agentPath: base.agentPath,
      serverId: base.serverId,
      requestId: base.requestId,
      toolCallId: base.toolCallId,
      namespacedToolName: base.namespacedToolName,
      interactionId: 'elicitation-1',
      elicitationMode: 'form',
    },
    {
      type: 'mcp.elicitation.resolved',
      timestamp: base.timestamp,
      sessionId: base.sessionId,
      runId: base.runId,
      assignmentId: base.assignmentId,
      ...whenDefined(base.workflowId, (workflowId) => ({ workflowId: workflowId })),
      ...whenDefined(base.workflowStepId, (workflowStepId) => ({ workflowStepId: workflowStepId })),
      agentPath: base.agentPath,
      serverId: base.serverId,
      requestId: base.requestId,
      toolCallId: base.toolCallId,
      namespacedToolName: base.namespacedToolName,
      interactionId: 'elicitation-1',
      elicitationMode: 'form',
      elicitationStatus: 'accepted',
      elicitationAction: 'accept',
    },
    { ...base, type: 'mcp.tool.started' },
    {
      ...base,
      type: 'mcp.tool.completed',
      durationMs: 125,
      resultByteCount: 16,
      resultHash,
    },
    {
      ...base,
      type: 'mcp.tool.failed',
      durationMs: 80,
      errorCode: 'tool_failed',
    },
    { ...base, type: 'mcp.tool.cancelled', durationMs: 50 },
    {
      type: 'mcp.resource.imported',
      timestamp: base.timestamp,
      sessionId: base.sessionId,
      runId: base.runId,
      assignmentId: base.assignmentId,
      agentPath: base.agentPath,
      serverId: base.serverId,
      snapshotId: 'resource-snapshot-1',
      resultByteCount: 100,
      resultHash,
    },
  ]

  try {
    for (const event of events) await harness.store.appendAuditEvent(event)
    const listed = await harness.store.listAuditEvents()
    assert.deepEqual(
      listed.map((event) => event.status),
      [
        'requested',
        'pending',
        'approved-once',
        'pending',
        'accepted',
        'started',
        'completed',
        'failed',
        'cancelled',
        'imported',
      ],
    )
    assert.ok(listed.every((event) => !('requestId' in event)))
    assert.equal(listed[3]?.elicitationMode, 'form')
    assert.equal(listed[4]?.elicitationStatus, 'accepted')
    assert.equal(listed[4]?.elicitationAction, 'accept')
    assert.equal(listed[6]?.resultHash?.value, resultHash.value)
    assert.equal(listed[7]?.errorCode, 'tool_failed')
    assert.equal(listed[8]?.errorCode, 'cancelled')

    const auditPath = path.join(
      harness.assignmentPath,
      'mcp',
      'audit',
      'events.jsonl',
    )
    const persisted = fs.readFileSync(auditPath, 'utf8')
    assert.match(persisted, /"requestId":"request-1"/)
    assert.doesNotMatch(persisted, /sensitive query must not enter audit/)
    assert.doesNotMatch(persisted, /sensitive result text/)
    assert.doesNotMatch(persisted, /https?:\/\//)
    assert.doesNotMatch(persisted, /upstream message/i)

    for (const forbidden of [
      { arguments: { password: 'secret-value' } },
      { result: 'secret-result' },
      { transportUrl: 'https://secret.example.test' },
      { message: 'upstream message secret' },
    ]) {
      await assert.rejects(
        harness.store.appendAuditEvent({
          ...base,
          type: 'mcp.tool.requested',
          ...forbidden,
        } as unknown as McpAuditEventInput),
        hasCode('invalid_request'),
      )
    }
  } finally {
    harness.cleanup()
  }
})

test('audit IDs are deterministic by logical binding and changed retries conflict', async () => {
  const harness = createHarness()
  const first = { ...toolAuditBase(), type: 'mcp.tool.started' } as const
  try {
    const appended = await harness.store.appendAuditEvent(first)
    assert.match(appended.eventId, /^mcp_audit_[a-f0-9]{64}$/)
    assert.deepEqual(await harness.store.appendAuditEvent(first), appended)
    assert.equal((await harness.store.listAuditEvents()).length, 1)

    await assert.rejects(
      harness.store.appendAuditEvent({
        ...first,
        timestamp: '2026-07-12T20:00:01.000Z',
      }),
      hasCode('conflict'),
    )

    const reusedProviderCall = await harness.store.appendAuditEvent({
      ...first,
      requestId: 'request-2',
    })
    assert.equal(reusedProviderCall.toolCallId, first.toolCallId)
    assert.notEqual(reusedProviderCall.eventId, appended.eventId)
    assert.equal((await harness.store.listAuditEvents()).length, 2)

    const restarted = new McpEvidenceStore({
      workspacePath: harness.workspacePath,
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
    })
    assert.deepEqual(await restarted.listAuditEvents(), await harness.store.listAuditEvents())
  } finally {
    harness.cleanup()
  }
})

test('tool-result evidence is canonical, immutable in shape, redacted, and restart-idempotent', async () => {
  const harness = createHarness()
  const input = evidenceInput()
  try {
    const imported = await harness.store.importToolResultEvidence(input)
    assert.match(imported.record.evidenceId, /^mcp_tool_result_[a-f0-9]{64}$/)
    assert.equal(imported.record.kind, 'tool-result')
    assert.equal('requestId' in imported.record, false)
    assert.equal(JSON.stringify(imported).includes('sensitive result text'), false)
    assert.deepEqual(
      imported.contents.map((content) => [content.type, content.mimeType]),
      [
        ['text', 'text/plain'],
        ['json', 'application/json'],
      ],
    )
    assert.equal(
      fs.readFileSync(path.join(imported.evidencePath, 'contents', '00.txt'), 'utf8'),
      'sensitive result text',
    )
    assert.equal(
      fs.readFileSync(path.join(imported.evidencePath, 'contents', '01.json'), 'utf8'),
      '{"a":{"x":1,"y":true},"z":2}',
    )
    const manifest = fs.readFileSync(
      path.join(imported.evidencePath, 'manifest.json'),
      'utf8',
    )
    assert.match(manifest, /"requestId": "request-1"/)
    assert.doesNotMatch(manifest, /sensitive result text/)

    harness.now.value = new Date('2026-07-12T21:00:00.000Z')
    const restarted = new McpEvidenceStore({
      workspacePath: harness.workspacePath,
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
      now: () => new Date(harness.now.value),
    })
    const replay = await restarted.importToolResultEvidence(input)
    assert.deepEqual(replay, imported)
    assert.equal((await restarted.listToolResultEvidence()).length, 1)

    const distinctRequest = await restarted.importToolResultEvidence(
      evidenceInput({ requestId: 'request-2' }),
    )
    assert.equal(distinctRequest.record.toolCallId, input.toolCallId)
    assert.notEqual(distinctRequest.record.evidenceId, imported.record.evidenceId)
  } finally {
    harness.cleanup()
  }
})

test('tool-result evidence rejects malformed content and configured size overflows', async () => {
  const harness = createHarness({
    maxContentBytes: 8,
    maxAggregateBytes: 12,
  })
  try {
    await assert.rejects(
      harness.store.importToolResultEvidence(
        evidenceInput({ content: [{ type: 'text', text: '123456789' }] }),
      ),
      hasCode('result_too_large'),
    )
    await assert.rejects(
      harness.store.importToolResultEvidence(
        evidenceInput({
          content: [
            { type: 'text', text: '12345678' },
            { type: 'text', text: '12345' },
          ],
        }),
      ),
      hasCode('result_too_large'),
    )
    await assert.rejects(
      harness.store.importToolResultEvidence(
        evidenceInput({
          content: [
            { type: 'json', value: { invalid: Number.NaN } },
          ],
        }),
      ),
      hasCode('invalid_request'),
    )
    await assert.rejects(
      harness.store.importToolResultEvidence(
        evidenceInput({
          content: [
            { type: 'text', text: 'safe', message: 'upstream secret' },
          ] as unknown as McpToolResultEvidenceImportInput['content'],
        }),
      ),
      hasCode('invalid_request'),
    )
  } finally {
    harness.cleanup()
  }
})
