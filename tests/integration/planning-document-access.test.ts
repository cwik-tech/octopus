import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'
import { WorkspaceProjectMembershipStore } from '../../domains/projects/project-membership-store.js'
import { WorkspaceProjectContextStore } from '../../domains/projects/project-context-store.js'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { startApiServer } from '../../server/api-server.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { startFakeChatCompletionsServer, type FakeChatCompletionsRequest } from '../support/fake-chat-completions-server.js'

for (const sourceKind of ['upload', 'project']) test(`Workflow planning receives final-section ${sourceKind} evidence through its tool-free structured route`, { timeout: 30_000 }, async () => {
  const fixture = createSchedulerFixture('planning-document-access-')
  // Replace only the model's HTTP boundary.
  const model = await startFakeChatCompletionsServer({ script: [
    { match: (request) => Boolean(request.systemPrompt?.includes('Review this fragment') && request.userMessage?.includes('FINAL_PLANNING_FACT=3276')), content: JSON.stringify({ evidence: ['FINAL_PLANNING_FACT=3276'] }) },
    ...Array.from({ length: 30 }, () => ({ match: (request: FakeChatCompletionsRequest) => Boolean(request.systemPrompt?.includes('Review this fragment')), content: JSON.stringify({ evidence: [] }) })),
    { content: JSON.stringify({ message: 'The final planning fact is 3276.', selectionAction: 'keep', workflowId: fixture.workflowId, launchIntent: 'none', deepResearchPlanAction: 'keep', deepResearchMissingInputs: [] }) },
  ] })
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  process.env.OPENAI_API_KEY = 'fixture'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `${model.url}/v1/chat/completions`
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const parser = new SourceFileParserLauncher(process.cwd())
  const server = await startApiServer({ store: new FileSystemRunStore(fixture.workspacePath), sessionStore: store, workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath, workflowsRegistryPath: fixture.workflowsRegistryPath, fileParserLauncher: parser, launcher: { async startRun() { return { launched: true, pid: 0, cwd: '' } } } })
  try {
    const session = await store.createSession({ title: 'Planning document' })
    const contents = Buffer.from('background '.repeat(8_000) + '\nFINAL_PLANNING_FACT=3276')
    let projectContext
    if (sourceKind === 'upload') {
      await store.saveUploadedFile(session.id, { filename: 'planning.md', contents })
      await parser.parseDirectory(store.inputsDir(session.id))
    } else {
      const project = await new WorkspaceProjectStore({ workspacePath: fixture.workspacePath }).create({ name: 'Selected planning reference' })
      await new WorkspaceProjectMembershipStore({ workspacePath: fixture.workspacePath }).assign(session.id, project.id)
      await new WorkspaceProjectContextStore({ workspacePath: fixture.workspacePath }).saveFile(project.id, { filename: 'planning.md', contents })
      projectContext = { projectId: project.id, includeBrief: false, fileNames: ['planning.md'] }
    }
    const response = await fetch(`${server.url}/sessions/${session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Use FINAL_PLANNING_FACT to explain the plan.', projectContext, target: { kind: 'workflow', workflowId: fixture.workflowId, expectedPlanId: null }, provider: 'openai', model: 'fixture', turnId: randomUUID() }), signal: AbortSignal.timeout(25_000) })
    const text = await response.text()
    assert.ok(response.status < 400, text)
    assert.match(JSON.stringify(model.requests.at(-1)?.body.messages), /FINAL_PLANNING_FACT=3276/)
    assert.ok(model.requests.some((request) => request.systemPrompt?.includes('Review this fragment')))
  } finally {
    await server.close(); await model.close(); fixture.cleanup()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL; else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl
  }
})
