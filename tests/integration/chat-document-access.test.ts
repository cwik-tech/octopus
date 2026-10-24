import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer } from '../../server/api-server.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { WorkspaceProjectContextStore } from '../../domains/projects/project-context-store.js'
import { WorkspaceProjectMembershipStore } from '../../domains/projects/project-membership-store.js'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'

for (const sourceKind of ['upload', 'project', 'delivery']) test(`an Agent can read a final-section fact from its scoped ${sourceKind} documents`, { timeout: 30_000 }, async () => {
  const fixture = createSchedulerFixture('chat-document-access-')
  // Only the paid, nondeterministic model is replaced, at its HTTP boundary.
  const model = await startFakeChatCompletionsServer({ script: [
    {
      match: (request) => request.toolCount > 0 && Boolean(request.userMessage?.includes('FINAL_APPROVAL')),
      toolCalls: [{ id: 'find-final-approval', name: 'document_search', arguments: { query: 'FINAL_APPROVAL' } }],
    },
    { content: 'The final approval code is 90217.' },
  ] })
  const agentDir = path.join(fixture.repoRootPath, 'agents', 'document-reader')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'document-reader.md'), [
    '---', 'name: document-reader', 'description: Reads selected documents.',
    'provider: lm-studio', 'model: local-7b', 'thinking: low',
    `provider_options: ${JSON.stringify({ base_url: model.url })}`, '---', '',
    'Answer using the uploaded document tools.',
  ].join('\n'))
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const parser = new SourceFileParserLauncher(process.cwd())
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath), sessionStore: store,
    workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath,
    workflowsRegistryPath: fixture.workflowsRegistryPath, fileParserLauncher: parser,
    launcher: { async startRun() { return { launched: true, pid: 0, cwd: '' } } },
  })
  try {
    const session = await store.createSession({ title: 'Long document' })
    const contents = Buffer.from('Introductory evidence\n' + 'ordinary background '.repeat(8_000) + '\nFINAL_APPROVAL=90217\n')
    let projectContext: { projectId: string; includeBrief: boolean; fileNames: string[] } | undefined
    if (sourceKind === 'upload') await store.saveUploadedFile(session.id, {
      filename: 'approval.md',
      contents,
    })
    if (sourceKind === 'upload') await parser.parseDirectory(store.inputsDir(session.id))
    if (sourceKind === 'project') {
      const project = await new WorkspaceProjectStore({ workspacePath: fixture.workspacePath }).create({ name: 'Selected reference' })
      await new WorkspaceProjectMembershipStore({ workspacePath: fixture.workspacePath }).assign(session.id, project.id)
      await new WorkspaceProjectContextStore({ workspacePath: fixture.workspacePath }).saveFile(project.id, { filename: 'approval.md', contents })
      projectContext = { projectId: project.id, includeBrief: false, fileNames: ['approval.md'] }
    }
    if (sourceKind === 'delivery') {
      const task = await store.createTaskRecord(session.id, { workflowId: fixture.workflowId, brief: 'Produce approval evidence.' })
      assert.ok(task?.assignmentPath)
      fs.writeFileSync(path.join(task.assignmentPath, 'approval.md'), contents)
      await store.appendChatMessage(session.id, { id: randomUUID(), createdAt: '2026-10-09T00:00:00.000Z', role: 'assistant', text: 'Delivered approval evidence.', delivery: { taskId: task.id, artifacts: [{ runId: task.runId, path: 'approval.md', role: 'final' }] } })
    }

    const response = await fetch(`${server.url}/sessions/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Find FINAL_APPROVAL in my document.', projectContext, target: { kind: 'agents', agentNames: ['document-reader'] }, turnId: randomUUID() }),
      signal: AbortSignal.timeout(25_000),
    })
    const responseText = await response.text()

    assert.ok(response.status < 400, responseText)
    const first = model.requests[0]
    assert.ok(first, 'The model must receive the admitted turn')
    assert.doesNotMatch(first.userMessage ?? '', /90217/, 'The final fact must require document access, not fit in the initial excerpt')
    assert.match(JSON.stringify(first.body.tools), /document_search/, 'The admitted Agent must receive document tools')
    assert.match(JSON.stringify(model.requests.slice(1).map((request) => request.body.messages)), /FINAL_APPROVAL=90217/, 'The tool result must contain the actual final-section evidence')
    assert.match(responseText, /90217/)
  } finally {
    await server.close()
    await model.close()
    fixture.cleanup()
  }
})
