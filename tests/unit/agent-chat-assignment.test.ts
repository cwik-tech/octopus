import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

test('selected-agent MCP chat creates isolated canonical assignment scopes', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-chat-scope-'))
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'MCP chat scope' })
    const runId = randomUUID()
    const firstAssignmentId = randomUUID()
    const secondAssignmentId = randomUUID()
    const first = await store.ensureAgentChatAssignment(
      session.id,
      runId,
      firstAssignmentId,
    )
    const second = await store.ensureAgentChatAssignment(
      session.id,
      runId,
      secondAssignmentId,
    )
    assert.ok(first)
    assert.ok(second)
    assert.equal(
      first.assignmentPath,
      path.join(
        workspacePath,
        'sessions',
        session.id,
        'runs',
        runId,
        'assignments',
        firstAssignmentId,
      ),
    )
    assert.notEqual(first.assignmentPath, second.assignmentPath)
    assert.equal(fs.lstatSync(first.assignmentPath).isSymbolicLink(), false)
    assert.equal(fs.statSync(first.assignmentPath).mode & 0o777, 0o700)
    fs.writeFileSync(path.join(first.assignmentPath, 'chat-output.md'), '# Output')
    const published = await new FileSystemRunStore(workspacePath).readArtifact(
      first.assignmentId,
      'chat-output.md',
    )
    assert.equal(published?.content, '# Output')
    assert.deepEqual(
      await store.ensureAgentChatAssignment(session.id, runId, firstAssignmentId),
      first,
    )
    assert.equal(
      await store.ensureAgentChatAssignment(session.id, 'not-a-uuid', randomUUID()),
      null,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('MCP chat scope creation rejects a symlinked run boundary', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-chat-symlink-'))
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-chat-outside-'))
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'Unsafe MCP chat scope' })
    const runsPath = path.join(workspacePath, 'sessions', session.id, 'runs')
    fs.symlinkSync(outsidePath, runsPath, 'dir')
    assert.equal(
      await store.ensureAgentChatAssignment(
        session.id,
        randomUUID(),
        randomUUID(),
      ),
      null,
    )
    assert.deepEqual(fs.readdirSync(outsidePath), [])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(outsidePath, { recursive: true, force: true })
  }
})
