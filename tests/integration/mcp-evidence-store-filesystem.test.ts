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
  type McpToolResultEvidenceImportInput,
} from '../../domains/mcp/mcp-evidence-store.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'

const NOW = new Date('2026-07-12T21:00:00.000Z')

interface WorkspaceHarness {
  readonly workspacePath: string
  readonly assignmentPath: string
  readonly storeOptions: ConstructorParameters<typeof McpEvidenceStore>[0]
  cleanup(): void
}

function createWorkspace(prefix: string): WorkspaceHarness {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-fs',
    runId: 'run-fs',
    assignmentId: 'assignment-fs',
  })
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })
  return {
    workspacePath,
    assignmentPath: location.assignmentPath,
    storeOptions: {
      workspacePath,
      sessionId: location.sessionId,
      runId: location.runId,
      assignmentId: location.assignmentId,
      now: () => new Date(NOW),
    },
    cleanup() {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    },
  }
}

function auditEvent(index: number): McpAuditEventInput {
  const argumentsSummary = hashMcpApprovalArguments({ index })
  return {
    type: 'mcp.tool.completed',
    timestamp: NOW.toISOString(),
    sessionId: 'session-fs',
    runId: 'run-fs',
    assignmentId: 'assignment-fs',
    agentPath: 'agents/researcher',
    serverId: 'database-server',
    requestId: `request-${index}`,
    toolCallId: 'call-1',
    namespacedToolName: 'mcp__database-server__query',
    toolRisk: 'read-only',
    argumentNames: argumentsSummary.argumentNames,
    argumentsHash: argumentsSummary.argumentsHash,
    durationMs: index,
    resultByteCount: index,
    resultHash: sha256(`result-${index}`),
  }
}

function evidenceInput(index: number): McpToolResultEvidenceImportInput {
  return {
    sessionId: 'session-fs',
    runId: 'run-fs',
    assignmentId: 'assignment-fs',
    agentPath: 'agents/researcher',
    serverId: 'database-server',
    requestId: `request-evidence-${index}`,
    toolCallId: 'call-1',
    namespacedToolName: 'mcp__database-server__query',
    content: [
      { type: 'text', text: `result-${index}` },
      { type: 'json', value: { index, ok: true } },
    ],
  }
}

function sha256(value: string) {
  return {
    algorithm: 'sha256' as const,
    value: createHash('sha256').update(value, 'utf8').digest('hex'),
  }
}

function hasCode(code: McpEvidenceStoreError['code']) {
  return (error: unknown): boolean =>
    error instanceof McpEvidenceStoreError && error.code === code
}

test('concurrent parent stores preserve audit lines and immutable evidence without overwrite', async () => {
  const harness = createWorkspace('mcp-evidence-concurrency-')
  const first = new McpEvidenceStore(harness.storeOptions)
  const second = new McpEvidenceStore(harness.storeOptions)
  try {
    const auditInputs = Array.from({ length: 40 }, (_value, index) =>
      auditEvent(index),
    )
    await Promise.all(
      auditInputs.map((event, index) =>
        (index % 2 === 0 ? first : second).appendAuditEvent(event),
      ),
    )
    const exactAudit = auditEvent(100)
    const exactAuditResults = await Promise.all([
      first.appendAuditEvent(exactAudit),
      second.appendAuditEvent(exactAudit),
    ])
    assert.deepEqual(exactAuditResults[0], exactAuditResults[1])
    assert.equal((await first.listAuditEvents()).length, 41)

    const evidenceInputs = Array.from({ length: 16 }, (_value, index) =>
      evidenceInput(index),
    )
    await Promise.all(
      evidenceInputs.map((input, index) =>
        (index % 2 === 0 ? first : second).importToolResultEvidence(input),
      ),
    )
    const exactInput = evidenceInput(100)
    const exactEvidence = await Promise.all([
      first.importToolResultEvidence(exactInput),
      second.importToolResultEvidence(exactInput),
    ])
    assert.deepEqual(exactEvidence[0], exactEvidence[1])

    const manifestPath = path.join(
      exactEvidence[0]!.evidencePath,
      'manifest.json',
    )
    const manifestMtime = fs.statSync(manifestPath).mtimeMs
    assert.deepEqual(
      await first.importToolResultEvidence(exactInput),
      exactEvidence[0],
    )
    assert.equal(fs.statSync(manifestPath).mtimeMs, manifestMtime)

    const restarted = new McpEvidenceStore(harness.storeOptions)
    assert.equal((await restarted.listAuditEvents()).length, 41)
    assert.equal((await restarted.listToolResultEvidence()).length, 17)

    const auditFile = path.join(
      harness.assignmentPath,
      'mcp',
      'audit',
      'events.jsonl',
    )
    const auditLines = fs
      .readFileSync(auditFile, 'utf8')
      .trimEnd()
      .split('\n')
    assert.equal(auditLines.length, 41)
    assert.equal(new Set(auditLines.map((line) => JSON.parse(line).eventId)).size, 41)

    const toolResultsPath = path.join(
      harness.assignmentPath,
      'evidence',
      'mcp',
      'tool-results',
    )
    assert.deepEqual(
      fs
        .readdirSync(toolResultsPath)
        .filter((entry) => entry.endsWith('.tmp')),
      [],
    )
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(auditFile).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.dirname(auditFile)).mode & 0o777, 0o700)
      assert.equal(fs.statSync(toolResultsPath).mode & 0o777, 0o700)
      assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o400)
      for (const content of exactEvidence[0]!.contents) {
        assert.equal(
          fs.statSync(
            path.join(
              exactEvidence[0]!.evidencePath,
              ...content.storedPath.split('/'),
            ),
          ).mode & 0o777,
          0o400,
        )
      }
    }
  } finally {
    harness.cleanup()
  }
})

test('audit readback fails closed on mode, truncation, symlink, and size corruption', async (t) => {
  await t.test('mode and partial-line corruption', async () => {
    const harness = createWorkspace('mcp-audit-corrupt-')
    const store = new McpEvidenceStore(harness.storeOptions)
    const auditFile = path.join(
      harness.assignmentPath,
      'mcp',
      'audit',
      'events.jsonl',
    )
    try {
      await store.appendAuditEvent(auditEvent(1))
      if (process.platform !== 'win32') {
        fs.chmodSync(auditFile, 0o644)
        await assert.rejects(store.listAuditEvents(), hasCode('corrupt_store'))
        fs.chmodSync(auditFile, 0o600)
      }
      const valid = fs.readFileSync(auditFile, 'utf8')
      fs.writeFileSync(auditFile, valid.trimEnd(), { mode: 0o600 })
      await assert.rejects(store.listAuditEvents(), hasCode('corrupt_store'))
    } finally {
      harness.cleanup()
    }
  })

  await t.test('symlink and maximum-size corruption', {
    skip: process.platform === 'win32',
  }, async () => {
    const harness = createWorkspace('mcp-audit-symlink-')
    const outside = path.join(harness.workspacePath, 'outside-secret.txt')
    const store = new McpEvidenceStore({
      ...harness.storeOptions,
      maxAuditBytes: 512,
    })
    const auditFile = path.join(
      harness.assignmentPath,
      'mcp',
      'audit',
      'events.jsonl',
    )
    try {
      await assert.rejects(
        store.appendAuditEvent(auditEvent(1)),
        hasCode('capacity_exceeded'),
      )
      fs.writeFileSync(outside, 'outside-secret')
      fs.symlinkSync(outside, auditFile)
      await assert.rejects(store.listAuditEvents(), hasCode('corrupt_store'))
    } finally {
      harness.cleanup()
    }
  })
})

test('evidence listing detects content tamper, path traversal, symlinks, and oversized files', async (t) => {
  async function scenario(
    name: string,
    mutate: (params: {
      evidencePath: string
      manifestPath: string
      contentPath: string
      workspacePath: string
    }) => void,
    options: { skip?: boolean } = {},
  ): Promise<void> {
    await t.test(name, { skip: options.skip }, async () => {
      const harness = createWorkspace(`mcp-evidence-${name.replaceAll(' ', '-')}-`)
      const store = new McpEvidenceStore(harness.storeOptions)
      try {
        const imported = await store.importToolResultEvidence(evidenceInput(1))
        const manifestPath = path.join(imported.evidencePath, 'manifest.json')
        const contentPath = path.join(
          imported.evidencePath,
          'contents',
          '00.txt',
        )
        mutate({
          evidencePath: imported.evidencePath,
          manifestPath,
          contentPath,
          workspacePath: harness.workspacePath,
        })
        await assert.rejects(
          store.listToolResultEvidence(),
          hasCode('corrupt_store'),
        )
      } finally {
        harness.cleanup()
      }
    })
  }

  await scenario('hash tamper', ({ contentPath }) => {
    fs.chmodSync(contentPath, 0o600)
    fs.writeFileSync(contentPath, 'tampered')
    fs.chmodSync(contentPath, 0o400)
  })
  await scenario('oversized published file', ({ contentPath }) => {
    fs.chmodSync(contentPath, 0o600)
    fs.appendFileSync(contentPath, 'x')
    fs.chmodSync(contentPath, 0o400)
  })
  await scenario('manifest traversal', ({ manifestPath }) => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      contents: Array<{ storedPath: string }>
    }
    manifest.contents[0]!.storedPath = '../outside.txt'
    fs.chmodSync(manifestPath, 0o600)
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
    fs.chmodSync(manifestPath, 0o400)
  })
  await scenario(
    'content symlink',
    ({ contentPath, workspacePath }) => {
      const outside = path.join(workspacePath, 'outside-result.txt')
      fs.writeFileSync(outside, 'outside')
      fs.unlinkSync(contentPath)
      fs.symlinkSync(outside, contentPath)
    },
    { skip: process.platform === 'win32' },
  )
  await scenario('manifest mode', ({ manifestPath }) => {
    fs.chmodSync(manifestPath, 0o600)
  }, { skip: process.platform === 'win32' })
})

test('listing ignores only exact staging directories and rejects near-match entries', async () => {
  const harness = createWorkspace('mcp-evidence-temp-list-')
  const store = new McpEvidenceStore(harness.storeOptions)
  try {
    await store.importToolResultEvidence(evidenceInput(1))
    const root = path.join(
      harness.assignmentPath,
      'evidence',
      'mcp',
      'tool-results',
    )
    const exactTemp = `.tool-result-mcp_tool_result_${'a'.repeat(64)}-1234567890abcdef.tmp`
    fs.mkdirSync(path.join(root, exactTemp), { mode: 0o700 })
    assert.equal((await store.listToolResultEvidence()).length, 1)
    fs.rmSync(path.join(root, exactTemp), { recursive: true, force: true })

    fs.mkdirSync(path.join(root, '.tool-result-near-match.tmp'), { mode: 0o700 })
    await assert.rejects(
      store.listToolResultEvidence(),
      hasCode('corrupt_store'),
    )
  } finally {
    harness.cleanup()
  }
})

test('evidence store never falls back to legacy assignments and rejects a symlinked canonical assignment', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-evidence-canonical-'),
  )
  const outsidePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mcp-evidence-outside-'),
  )
  try {
    const legacyPath = path.join(workspacePath, 'assignments', 'assignment-fs')
    fs.mkdirSync(legacyPath, { recursive: true })
    const store = new McpEvidenceStore({
      workspacePath,
      sessionId: 'session-fs',
      runId: 'run-fs',
      assignmentId: 'assignment-fs',
    })
    await assert.rejects(store.listAuditEvents(), hasCode('not_found'))
    assert.deepEqual(fs.readdirSync(legacyPath), [])

    const location = buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: 'session-fs',
      runId: 'run-fs',
      assignmentId: 'assignment-fs',
    })
    assert.ok(location)
    fs.mkdirSync(path.dirname(location.assignmentPath), { recursive: true })
    fs.symlinkSync(outsidePath, location.assignmentPath, 'dir')
    await assert.rejects(store.listToolResultEvidence(), hasCode('not_found'))
    assert.deepEqual(fs.readdirSync(outsidePath), [])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(outsidePath, { recursive: true, force: true })
  }
})
