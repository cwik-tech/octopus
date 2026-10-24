import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { McpResourceReadResult } from '../../domains/mcp/mcp-resource-client-service.js'
import { McpResourceImportStore } from '../../domains/mcp/mcp-resource-import-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function readResult(marker: string, text: string): McpResourceReadResult {
  const uri = `mcp-run-evidence://resources/${marker}`
  const bytes = Buffer.byteLength(text)
  return {
    resource: {
      id: `mcp_resource_${sha256(uri)}`,
      serverId: 'run-evidence-server',
      serverName: 'Run evidence MCP',
      uri,
      name: `Evidence ${marker}`,
      mimeType: 'text/plain',
      disposition: 'text',
    },
    contents: [{
      id: `mcp_content_${sha256(`${uri}:content`)}`,
      uri,
      mimeType: 'text/plain',
      kind: 'text',
      byteLength: bytes,
      text,
    }],
    totalBytes: bytes,
  }
}

function mode(filePath: string): number {
  return fs.lstatSync(filePath).mode & 0o777
}

test('task creation snapshots selected MCP provenance and immutable assignment evidence', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-run-provenance-'))
  const importStore = new McpResourceImportStore({ workspacePath })
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    mcpResourceImportStore: importStore,
  })

  try {
    const session = await sessionStore.createSession({ title: 'MCP evidence run' })
    const imported = await importStore.importResource({
      sessionId: session.id,
      result: readResult('original', 'immutable MCP evidence'),
    })
    const input = imported.materializedInputs[0]!
    assert.ok(await sessionStore.saveUploadedFile(session.id, {
      filename: input.filename,
      contents: input.buffer,
    }))
    await sessionStore.saveUploadedFile(session.id, {
      filename: 'ordinary-input.txt',
      contents: Buffer.from('ordinary input'),
    })

    const task = await sessionStore.createTaskRecord(session.id, {
      workflowId: 'mcp-provenance-workflow',
      brief: '# MCP provenance test',
      workflowYaml: 'workflow:\n  id: mcp-provenance-workflow\n  steps: []\n',
    })
    assert.ok(task?.runPath)
    assert.ok(task.assignmentPath)
    assert.ok(task.inputSnapshotPath)

    const provenancePath = path.join(task.inputSnapshotPath, 'mcp-provenance.json')
    const provenanceBytes = fs.readFileSync(provenancePath)
    const provenance = JSON.parse(provenanceBytes.toString('utf8')) as {
      sessionId: string
      runId: string
      assignmentId: string
      snapshots: Array<{ snapshotId: string; contents: Array<{ sha256: string }> }>
    }
    assert.equal(provenance.sessionId, session.id)
    assert.equal(provenance.runId, task.runId)
    assert.equal(provenance.assignmentId, task.assignmentId)
    assert.deepEqual(
      provenance.snapshots.map((snapshot) => snapshot.snapshotId),
      [imported.manifest.snapshotId],
    )

    const snapshotManifest = JSON.parse(
      fs.readFileSync(path.join(task.inputSnapshotPath, 'manifest.json'), 'utf8'),
    ) as {
      mcpProvenance: {
        path: string
        bytes: number
        sha256: string
        snapshotCount: number
      }
    }
    assert.deepEqual(snapshotManifest.mcpProvenance, {
      path: 'mcp-provenance.json',
      bytes: provenanceBytes.byteLength,
      sha256: sha256(provenanceBytes),
      snapshotCount: 1,
    })

    const evidenceRoot = path.join(
      task.assignmentPath,
      'evidence',
      'mcp',
      'resources',
      imported.manifest.snapshotId,
    )
    const evidenceManifestPath = path.join(evidenceRoot, 'manifest.json')
    const evidenceContentPath = path.join(
      evidenceRoot,
      ...imported.manifest.contents[0]!.storedPath.split('/'),
    )
    assert.deepEqual(
      JSON.parse(fs.readFileSync(evidenceManifestPath, 'utf8')),
      imported.manifest,
    )
    assert.equal(fs.readFileSync(evidenceContentPath, 'utf8'), 'immutable MCP evidence')
    assert.equal(mode(evidenceManifestPath), 0o400)
    assert.equal(mode(evidenceContentPath), 0o400)
    assert.equal(mode(provenancePath), 0o400)

    const runManifest = JSON.parse(
      fs.readFileSync(path.join(task.runPath, 'run.json'), 'utf8'),
    ) as { paths: { mcpProvenance: string; mcpResourceEvidence: string } }
    assert.equal(runManifest.paths.mcpProvenance, 'input-snapshot/mcp-provenance.json')
    assert.equal(
      runManifest.paths.mcpResourceEvidence,
      `assignments/${task.assignmentId}/evidence/mcp/resources`,
    )

    const refreshed = await importStore.importResource({
      sessionId: session.id,
      result: readResult('original', 'new MCP evidence after launch'),
    })
    const refreshedInput = refreshed.materializedInputs[0]!
    await sessionStore.saveUploadedFile(session.id, {
      filename: refreshedInput.filename,
      contents: refreshedInput.buffer,
    })
    assert.equal(fs.readFileSync(evidenceContentPath, 'utf8'), 'immutable MCP evidence')
    assert.equal(
      provenance.snapshots.some((snapshot) =>
        snapshot.snapshotId === refreshed.manifest.snapshotId,
      ),
      false,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('task creation writes empty provenance and no MCP evidence for ordinary inputs', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-run-no-provenance-'))
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'Ordinary run' })
    await store.saveUploadedFile(session.id, {
      filename: 'ordinary.txt',
      contents: Buffer.from('ordinary'),
    })
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'ordinary-workflow',
      brief: 'ordinary',
    })
    assert.ok(task?.runPath)
    assert.ok(task.assignmentPath)
    assert.ok(task.inputSnapshotPath)
    const provenance = JSON.parse(
      fs.readFileSync(path.join(task.inputSnapshotPath, 'mcp-provenance.json'), 'utf8'),
    ) as { snapshots: unknown[] }
    assert.deepEqual(provenance.snapshots, [])
    assert.equal(fs.existsSync(path.join(task.assignmentPath, 'evidence', 'mcp')), false)
    const runManifest = JSON.parse(
      fs.readFileSync(path.join(task.runPath, 'run.json'), 'utf8'),
    ) as { paths: { mcpResourceEvidence: null } }
    assert.equal(runManifest.paths.mcpResourceEvidence, null)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('task creation fails closed before publication when selected MCP evidence was tampered', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-run-tamper-'))
  const importStore = new McpResourceImportStore({ workspacePath })
  const store = new FileSystemSessionStore(workspacePath, {
    mcpResourceImportStore: importStore,
  })
  try {
    const session = await store.createSession({ title: 'Tampered MCP evidence' })
    const imported = await importStore.importResource({
      sessionId: session.id,
      result: readResult('tampered', 'trusted before tamper'),
    })
    const input = imported.materializedInputs[0]!
    await store.saveUploadedFile(session.id, {
      filename: input.filename,
      contents: input.buffer,
    })
    const contentPath = path.join(
      imported.snapshotPath,
      ...imported.manifest.contents[0]!.storedPath.split('/'),
    )
    fs.chmodSync(contentPath, 0o600)
    fs.writeFileSync(contentPath, 'tampered evidence bytes')
    fs.chmodSync(contentPath, 0o400)

    await assert.rejects(
      store.createTaskRecord(session.id, {
        workflowId: 'must-not-launch',
        brief: 'do not launch from tampered evidence',
      }),
      /unsafe or corrupt/i,
    )
    assert.deepEqual(await store.listTaskRecords(session.id), [])
    const runsPath = path.join(workspacePath, 'sessions', session.id, 'runs')
    assert.deepEqual(fs.existsSync(runsPath) ? fs.readdirSync(runsPath) : [], [])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
