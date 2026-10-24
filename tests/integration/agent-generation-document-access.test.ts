import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { createResourceBuildSnapshot, runResourceBuild } from '../../services/resource-architect-service.js'
import { ResourceArchitectStore } from '../../server/resource-architect-store.js'
import type { ResourceStandaloneAgentsPlan } from '../../contracts/resource-architect.js'
import { createDocumentSource } from '../../domains/document-access/document-source.js'
import { startFakeChatCompletionsServer, type FakeChatCompletionsRequest } from '../support/fake-chat-completions-server.js'

test('Create builds a persisted Agent package with cited final-section evidence from its captured reference documents', { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-document-'))
  // Replace only the paid model's HTTP boundary.
  const model = await startFakeChatCompletionsServer({ script: [
    { match: (request) => Boolean(request.systemPrompt?.includes('Review this fragment') && request.userMessage?.includes('FINAL_GENERATION_FACT=6629')), content: '{"evidence":["FINAL_GENERATION_FACT=6629"]}' },
    ...Array.from({ length: 30 }, () => ({ match: (request: FakeChatCompletionsRequest) => Boolean(request.systemPrompt?.includes('Review this fragment')), content: '{"evidence":[]}' })),
    { content: JSON.stringify({ message: 'Created evidence-reader.', suggestedName: 'evidence-reader', personaMarkdown: '---\nname: evidence-reader\ndescription: Reads evidence.\nprovider: openai\nmodel: fixture\ntools: none\n---\n\nUse FINAL_GENERATION_FACT=6629.\n', generatedSkills: [{ name: 'evidence-method', body: '---\nname: evidence-method\ndescription: Read source evidence. Use when a document needs analysis.\n---\n\n# Evidence\n\nUse cited source facts.\n' }] }) },
  ] })
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  process.env.OPENAI_API_KEY = 'fixture'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `${model.url}/v1/chat/completions`
  try {
    await fs.mkdir(path.join(root, 'teams', 'workflow-architect'), { recursive: true })
    await fs.writeFile(path.join(root, 'teams', 'workflow-architect', 'team.yaml'), 'agents:\n  - agent_file: architect.md\n')
    await fs.writeFile(path.join(root, 'teams', 'workflow-architect', 'architect.md'), '---\nprovider: openai\nmodel: fixture\n---\nAuthor an Agent.')
    const document = createDocumentSource({ owner: 'create-draft', name: 'source.md', text: 'background '.repeat(8_000) + '\nFINAL_GENERATION_FACT=6629' })
    const plan: ResourceStandaloneAgentsPlan = { id: 'document-plan', kind: 'standalone_agents', agents: [{ name: 'evidence-reader', role: 'Reader', description: 'Read the admitted source and use FINAL_GENERATION_FACT.', rationale: 'Consumes document evidence.' }] };
    const store = new ResourceArchitectStore(path.join(root, 'workspace'));
    const job = createResourceBuildSnapshot({ plan, jobId: 'document-build' });
    await runResourceBuild({ repoRoot: root, plan, job, store, provider: 'openai', model: 'fixture', uploadedDocuments: [{ name: document.name, content: document.text?.slice(0, 1_000) ?? '', documentSource: document }], documentReviewCacheDir: path.join(root, 'review') });
    assert.match(await fs.readFile(path.join(root, 'agents', 'evidence-reader', 'evidence-reader.md'), 'utf8'), /FINAL_GENERATION_FACT=6629/);
    assert.match(JSON.stringify(model.requests.at(-1)?.body.messages), /FINAL_GENERATION_FACT=6629/)
    assert.ok(model.requests.some((request) => request.systemPrompt?.includes('Review this fragment')))
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL; else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl
    await model.close(); await fs.rm(root, { recursive: true, force: true })
  }
})
