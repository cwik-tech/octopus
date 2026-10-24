import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { TeamFileStore } from '../../domains/team-files/team-file-store.js'
import { readTeamFileContext } from '../../domains/team-files/team-file-context.js'
import { runResourceArchitectTurn } from '../../domains/resource-architect/resource-architect-llm.js'
import { startFakeChatCompletionsServer, type FakeChatCompletionsRequest } from '../support/fake-chat-completions-server.js'

test('Create prepares later-section evidence from the full document before its direct model call', { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'create-document-access-'))
  // The paid model alone is replaced at its HTTP boundary.
  const model = await startFakeChatCompletionsServer({ script: [
    { match: (request) => Boolean(request.systemPrompt?.includes('Review this fragment') && request.userMessage?.includes('FINAL_CREATE_FACT=9827')), content: JSON.stringify({ evidence: ['FINAL_CREATE_FACT=9827'] }) },
    ...Array.from({ length: 30 }, () => ({ match: (request: FakeChatCompletionsRequest) => Boolean(request.systemPrompt?.includes('Review this fragment')), content: JSON.stringify({ evidence: [] }) })),
    { content: 'The final document fact is 9827.' },
  ] })
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  process.env.OPENAI_API_KEY = 'fixture'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `${model.url}/v1/chat/completions`
  try {
    const agent = path.join(root, 'agents', 'resource-architect')
    await fs.mkdir(agent, { recursive: true })
    await fs.writeFile(path.join(agent, 'resource-architect.md'), '---\nname: resource-architect\ndescription: Creates resources.\nprovider: openai\nmodel: fixture\n---\nUse document evidence.')
    await fs.mkdir(path.join(root, 'teams', 'resource-architect'), { recursive: true })
    await fs.writeFile(path.join(root, 'teams', 'resource-architect', 'team.yaml'), 'agents:\n  - agent_file: ../../agents/resource-architect/resource-architect.md\n')
    await fs.writeFile(path.join(root, 'teams.yaml'), '')
    const store = new TeamFileStore(path.join(root, 'workspace'))
    const ownerId = randomUUID()
    await store.saveUploadedFile(ownerId, { filename: 'source.md', contents: Buffer.from('background '.repeat(8_000) + '\nFINAL_CREATE_FACT=9827') })
    await new SourceFileParserLauncher(process.cwd()).parseDirectory(store.inputsDir(ownerId))
    const context = await readTeamFileContext(store, ownerId)
    const result = await runResourceArchitectTurn({ repoRoot: root, operation: 'conversation', history: [{ role: 'user', text: 'Use FINAL_CREATE_FACT from the document to propose a skill.' }], currentPlan: null, provider: 'openai', model: 'fixture', reviewEnabled: false, uploadedDocuments: context.documents })
    assert.equal(result.fallback, false, JSON.stringify(result))
    const final = model.requests.at(-1)
    assert.match(JSON.stringify(final?.body.messages), /FINAL_CREATE_FACT=9827/)
    assert.ok(model.requests.some((request) => request.systemPrompt?.includes('Review this fragment')), 'A bounded preparation stage must consume the full source')
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL; else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl
    await model.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
