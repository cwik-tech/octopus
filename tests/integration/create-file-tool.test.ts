import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { buildToolRegistry, providerAgentTools } from '../../server/tools/tool-registry.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

async function makeTool(context: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'create-file-')))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const identity = { sessionId: 'session-files', runId: 'turn-files', assignmentId: 'assignment-files' }
  const location = buildSessionRunAssignmentLocation(workspacePath, identity)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  const tools = providerAgentTools(buildToolRegistry({
    workspacePath,
    capabilityDispatcher: createCapabilityTestDispatcher(),
  }))
  const tool = tools.find((candidate) => candidate.name === 'create_file')
  assert.ok(tool, 'Every agent needs a shared tool to create text artifacts')
  const scope = {
    contractVersion: 1 as const, ...identity,
    leaseId: 'lease-files', requestId: 'request-files', agentPath: 'agents/general-agent',
  }
  return { root, workspacePath, assignmentPath: location.assignmentPath, tool, scope }
}

for (const agentPath of ['agents/general-agent', 'agents/writer', 'agents/analyst']) {
  test(`${agentPath} creates an exact Markdown artifact through the shared tool`, async (context) => {
    const { tool, scope, assignmentPath } = await makeTool(context)
    assert.equal(tool.isEnabledForAgent(agentPath), true)
    const result = await tool.execute({
      context: { ...scope, agentPath }, toolCallId: 'create-sources',
      input: { filename: 'sources.md', content: '# Sources\n\n- https://example.com\n' },
    })
    assert.equal(result.isError, false, result.content)
    assert.deepEqual(result.artifacts, [{ path: 'files/sources.md', title: 'sources.md', mediaType: 'text/markdown', role: 'final', digest: '7fe9941fb8fb359e54f6e082f3cb87e40451aa164cdd3aa951c384b80f571cbb' }])
    assert.equal(await fs.readFile(path.join(assignmentPath, 'files/sources.md'), 'utf8'), '# Sources\n\n- https://example.com\n')
  })
}

test('creates an empty text file without inventing content', async (context) => {
  const { tool, scope, assignmentPath } = await makeTool(context)
  const result = await tool.execute({ context: scope, toolCallId: 'empty', input: { filename: 'empty.txt', content: '' } })
  assert.equal(result.isError, false, result.content)
  assert.equal((await fs.stat(path.join(assignmentPath, 'files/empty.txt'))).size, 0)
})

for (const filename of ['../outside.md', '/tmp/outside.md', '..%2foutside.md', 'folder/file.md', '.runtime', 'fake.docx', 'fake.xlsx']) {
  test(`rejects the unsupported or unsafe filename ${filename}`, async (context) => {
    const { tool, scope, assignmentPath } = await makeTool(context)
    const result = await tool.execute({ context: scope, toolCallId: 'invalid', input: { filename, content: 'should not be written' } })
    assert.equal(result.isError, true)
    assert.deepEqual(result.artifacts ?? [], [])
    await assert.rejects(fs.stat(path.join(assignmentPath, 'files')), { code: 'ENOENT' })
  })
}

test('never follows a symlink out of the assignment', async (context) => {
  const { root, tool, scope, assignmentPath } = await makeTool(context)
  const outside = path.join(root, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(assignmentPath, 'files'))
  const result = await tool.execute({ context: scope, toolCallId: 'escape', input: { filename: 'stolen.md', content: 'escape' } })
  assert.equal(result.isError, true)
  assert.deepEqual(await fs.readdir(outside), [])
})

test('keeps an existing file when a later call tries to replace its contents', async (context) => {
  const { tool, scope, assignmentPath } = await makeTool(context)
  const first = await tool.execute({ context: scope, toolCallId: 'first', input: { filename: 'notes.md', content: 'Original' } })
  assert.equal(first.isError, false, first.content)
  const second = await tool.execute({ context: scope, toolCallId: 'second', input: { filename: 'notes.md', content: 'Replacement' } })
  assert.equal(second.isError, true)
  assert.equal(await fs.readFile(path.join(assignmentPath, 'files/notes.md'), 'utf8'), 'Original')
})

test('does not create a file after cancellation', async (context) => {
  const { tool, scope, assignmentPath } = await makeTool(context)
  const result = await tool.execute({ context: scope, toolCallId: 'cancelled', input: { filename: 'cancelled.md', content: 'stop' }, signal: AbortSignal.abort() })
  assert.equal(result.isError, true)
  await assert.rejects(fs.stat(path.join(assignmentPath, 'files/cancelled.md')), { code: 'ENOENT' })
})
