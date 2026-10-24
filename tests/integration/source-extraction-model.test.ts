import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  setConfiguredProviderConnections,
} from '../../providers/configured-provider.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { SourceObservationStore } from '../../domains/acquisition/source-observation-store.js'
import { SourceExtractionService } from '../../services/source-extraction-service.js'

test('model extraction uses the configured provider transport, repairs once, and verifies quotes', async (context) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'source-extraction-model-')),
  )
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const assignmentPath = path.join(root, 'assignment')
  fs.mkdirSync(assignmentPath)
  const identity = {
    sessionId: 'session-model',
    runId: 'run-model',
    assignmentId: 'assignment-model',
    activityScopeId: 'lane-model',
    agentPath: 'agents/web-researcher',
  } as const
  const observationStore = new SourceObservationStore()
  const observation = await observationStore.persist({
    assignmentPath,
    identity,
    activityId: 'observation-model',
    method: 'direct-http',
    requestedUrl: 'https://example.com/profile',
    finalUrl: 'https://example.com/profile',
    mediaType: 'text/html',
    content: [
      '# Company profile',
      '',
      'Acme was founded in 1984 and remains independently operated.',
    ].join('\n'),
    attempts: [{
      method: 'direct-http',
      outcome: 'usable',
      startedAt: new Date().toISOString(),
      durationMs: 10,
      contentBytes: 80,
    }],
    rawOmissionReason: 'Fixture source has no raw body.',
  })

  let calls = 0
  const server = createServer((request, response) => {
    calls += 1
    assert.equal(request.method, 'POST')
    const payload = calls === 1
      ? 'not-json'
      : JSON.stringify({
          fields: [{
            path: 'foundedYear',
            status: 'present',
            valueJson: '1984',
            quote: 'Acme was founded in 1984',
            confidence: 0.96,
            message: null,
          }],
        })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      model: 'fixture-extractor',
      choices: [{ message: { content: payload } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      },
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  setConfiguredProviderConnections([{
    id: 'fixture-extraction',
    kind: 'openai-compatible',
    name: 'Fixture extraction provider',
    baseUrl: `http://127.0.0.1:${address.port}`,
  }])
  context.after(() => setConfiguredProviderConnections([]))

  const service = new SourceExtractionService({ observationStore })
  const execution = await service.extract({
    assignmentPath,
    identity,
    extractionId: 'extraction-model',
    contentId: observation.receipt.receiptId,
    schema: {
      type: 'object',
      properties: {
        foundedYear: {
          type: 'integer',
          description: 'The year the company was founded',
        },
      },
    },
    requiredFields: ['foundedYear'],
    mode: 'best-effort',
    modelSelection: {
      provider: configuredProviderName('fixture-extraction'),
      model: 'fixture-extractor',
    },
    allowModel: true,
  })

  assert.equal(calls, 2)
  assert.equal(execution.usedModel, true)
  assert.equal(execution.repairCount, 1)
  assert.deepEqual(execution.view.data, { foundedYear: 1984 })
  assert.equal(execution.view.requirementsMet, true)
  assert.deepEqual(
    execution.view.methodsAttempted,
    ['deterministic', 'model', 'model-repair'],
  )
  assert.ok(fs.existsSync(path.join(
    assignmentPath,
    execution.view.receiptRelativePath,
  )))
})

test('legacy version-one observations remain available for reprocessing', async (context) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'source-extraction-legacy-')),
  )
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const assignmentPath = path.join(root, 'assignment')
  const lane = 'lane-legacy'
  const contentId = 'observation-legacy'
  const packageDirectory = path.join(
    assignmentPath,
    'research',
    'acquisitions',
    lane,
    contentId,
  )
  const receiptDirectory = path.join(
    assignmentPath,
    'research',
    'observations',
    lane,
  )
  fs.mkdirSync(packageDirectory, { recursive: true, mode: 0o700 })
  fs.mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 })
  const content = '# Legacy profile\n\nAcme was founded in 1984.'
  const contentRelativePath =
    `research/acquisitions/${lane}/${contentId}/content.md`
  fs.writeFileSync(path.join(packageDirectory, 'content.md'), content, {
    mode: 0o600,
  })
  fs.writeFileSync(
    path.join(receiptDirectory, `${contentId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      receiptId: contentId,
      sessionId: 'session-legacy',
      runId: 'run-legacy',
      assignmentId: 'assignment-legacy',
      activityScopeId: lane,
      activityId: contentId,
      agentPath: 'agents/web-researcher',
      method: 'direct-http',
      requestedUrl: 'https://example.com/legacy',
      finalUrl: 'https://example.com/legacy',
      canonicalUrl: 'https://example.com/legacy',
      mediaType: 'text/html',
      observedAt: new Date().toISOString(),
      contentRelativePath,
      contentSha256: createHash('sha256').update(content).digest('hex'),
      contentBytes: Buffer.byteLength(content, 'utf8'),
      quality: 'usable',
      attempts: [],
    }, null, 2)}\n`,
    { mode: 0o600 },
  )
  const service = new SourceExtractionService()
  const execution = await service.extract({
    assignmentPath,
    identity: {
      sessionId: 'session-legacy',
      runId: 'run-legacy',
      assignmentId: 'assignment-legacy',
      activityScopeId: lane,
      agentPath: 'agents/web-researcher',
    },
    extractionId: 'extraction-legacy',
    contentId,
    schema: {
      type: 'object',
      properties: { foundedYear: { type: 'integer' } },
    },
    requiredFields: ['foundedYear'],
    mode: 'best-effort',
    modelSelection: null,
    allowModel: true,
  })
  assert.equal(execution.view.requirementsMet, false)
  assert.equal(execution.view.fields[0]?.status, 'unsupported')
  assert.ok(execution.view.warnings.some((warning) =>
    /legacy observation/iu.test(warning)))
})
