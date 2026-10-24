import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import * as z from 'zod/v4'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { startApiServer } from '../../server/api-server.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'

test('Run chat sends a successfully prepared JPG to the selected model and preserves the original', { timeout: 30_000 }, async () => {
  const fixture = createSchedulerFixture('session-image-chat-')
  // Replace only the paid, nondeterministic model at its HTTP boundary.
  const model = await startFakeChatCompletionsServer({ script: [{ content: JSON.stringify({
    message: 'Use a project sidebar and a task list.', selectionAction: 'keep',
    workflowId: fixture.workflowId, launchIntent: 'none',
    deepResearchPlanAction: 'keep', deepResearchMissingInputs: [],
  }) }] })
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  process.env.OPENAI_API_KEY = 'fixture'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `${model.url}/v1/chat/completions`
  const store = new FileSystemSessionStore(fixture.workspacePath)
  const parser = new SourceFileParserLauncher(process.cwd())
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath), sessionStore: store,
    workspacePath: fixture.workspacePath, repoRootPath: fixture.repoRootPath,
    workflowsRegistryPath: fixture.workflowsRegistryPath, fileParserLauncher: parser,
    launcher: { async startRun() { return { launched: true, pid: 0, cwd: '' } } },
  })
  try {
    const session = await store.createSession({ title: 'Image chat regression' })
    const original = await fs.readFile(path.join(process.cwd(), 'file-parser/tests/fixtures/test-photo.jpg'))
    await store.saveUploadedFile(session.id, { filename: 'SCREENSHOT.JPG', contents: original })
    await parser.parseDirectory(store.inputsDir(session.id))
    const response = await fetch(`${server.url}/sessions/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Suggest project-oriented improvements to this screenshot. Do not code.',
        target: { kind: 'workflow', workflowId: fixture.workflowId, expectedPlanId: null },
        provider: 'openai', model: 'fixture', turnId: randomUUID() }),
      signal: AbortSignal.timeout(25_000),
    })
    const reply = await response.text()
    assert.ok(response.status < 400, reply)
    assert.match(reply, /project sidebar/)
    const request = model.requests.find((request) => JSON.stringify(request.body.messages).includes('project-oriented'))
    assert.ok(request, 'The selected model must receive the user request')
    const messages = z.array(z.object({ role: z.string(), content: z.unknown() })).parse(request.body.messages)
    const parts = z.array(z.object({ type: z.string(), image_url: z.object({ url: z.string() }).optional() })).parse(messages.find((message) => message.role === 'user')?.content)
    const thumbnail = await fs.readFile(path.join(store.inputsDir(session.id), 'parsed/SCREENSHOT.JPG.thumb.jpg'))
    assert.equal(parts.find((part) => part.type === 'image_url')?.image_url?.url, `data:image/jpeg;base64,${thumbnail.toString('base64')}`)
    assert.deepEqual(await fs.readFile(path.join(store.inputsDir(session.id), 'SCREENSHOT.JPG')), original)
  } finally {
    await server.close()
    await model.close()
    fixture.cleanup()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl
  }
})
