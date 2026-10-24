import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { browserToolModule } from '../../server/tools/browser.js'
import { BrowserManager } from '../../domains/browser/browser-manager.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { BrowserToolService } from '../../services/browser-tool-service.js'
import { McpSettingsService, type McpSecretCodec } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { INSUFFICIENT_WEB_RESEARCH_RESPONSE } from '../../domains/browser/web-research-evidence.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'
import { createBrowserCapabilityTestInvoker } from '../support/browser-capability-fixture.js'

const codec: McpSecretCodec = {
  encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
}

test('real provider and Chrome recover from CAPTCHA into a grounded researcher answer', { timeout: 60_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-e2e-')))
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const website = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    const pages: Record<string, string> = {
      '/challenge': '<!doctype html><html><body><h1>Unusual traffic from your computer network</h1><p>Complete the CAPTCHA to continue.</p></body></html>',
      '/wrong-city': '<!doctype html><html><body><main><h1>Baltimore Beer Guide</h1><p>Popular breweries in Baltimore, Maryland.</p></main></body></html>',
      '/generic-beer': '<!doctype html><html><body><main><h1>Independent Beer Magazine</h1><p>General brewing news and culture.</p></main></body></html>',
    }
    response.end(pages[url.pathname]
      ?? '<!doctype html><html><body><main><h1>Research result</h1><p>E2E_REPORT_CODE_ORBITAL_742</p></main></body></html>')
  })
  const targetUrl = await listen(website)
  const providerFixture = await startOpenAiToolLoopFixture(process.cwd())
  const browserManager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    mode: 'headless',
    allowHttpLocalhost: true,
  })
  const clientManager = new McpClientManager({
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    closeTimeoutMs: 1_000,
  })
  const mcpSettings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: codec,
    clientManager,
  })
  const providerSettings = new ProviderSettingsService({
    storagePath: path.join(root, 'providers.json'),
    secretCodec: codec,
  })

  try {
    if ((await browserManager.status()).status === 'unavailable') {
      t.skip('A supported local Chrome installation is required for this integration test.')
      return
    }
    fs.mkdirSync(path.join(repoRootPath, 'agents', 'web-researcher'), { recursive: true })
    fs.writeFileSync(
      path.join(repoRootPath, 'agents', 'web-researcher', 'web-researcher.md'),
      '---\nname: web-researcher\ntools: read, browser\n---\n\n# Web researcher\n',
    )
    const identity = {
      sessionId: 'session-browser-agent',
      runId: 'run-browser-agent',
      assignmentId: 'assignment-browser-agent',
    }
    const location = buildSessionRunAssignmentLocation(workspacePath, identity)
    assert.ok(location)
    fs.mkdirSync(location.assignmentPath, { recursive: true })

    const connection = await providerSettings.saveConnection({
      kind: 'openai-compatible',
      name: 'Browser agent provider fixture',
      baseUrl: `${providerFixture.url}/v1`,
      apiKey: 'browser-agent-key',
      enabled: true,
    })
    await providerSettings.validateConnection(connection.id)
    await providerSettings.setModelEnabled(connection.id, 'fixture/browser-agent', true)
    await providerSettings.setModelEnabled(connection.id, 'fixture/browser-research', true)
    await providerSettings.setModelEnabled(connection.id, 'fixture/browser-research-unsupported', true)
    const provider = configuredProviderName(connection.id)
    const leases = new McpRunLeaseStore()
    const broker = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: mcpSettings,
      clientManager: mcpSettings.getBrokerClientManager(),
      grantResolver: () => false,
      leaseResolver: (context) => leases.resolve(context),
    })
    const browserToolService = new BrowserToolService({
      workspacePath,
      repoRootPath,
      manager: browserManager,
    })
    const browserAgentTool = browserToolModule.build({
      moduleOptions: {
        browser: {
          toolService: browserToolService,
          dispatchInvoker: createBrowserCapabilityTestInvoker(
            browserToolService,
          ),
        },
      },
    }).agentTool
    assert.ok(browserAgentTool)
    const service = new McpAgentToolService({
      broker,
      leaseStore: leases,
      providerSettingsService: providerSettings,
      builtinAgentTools: [browserAgentTool],
    })

    const turn = await service.runTurn({
      ...identity,
      taskId: 'task-browser-agent',
      agentPath: 'agents/web-researcher',
      provider,
      model: 'fixture/browser-agent',
      thinking: 'medium',
      systemPrompt: 'Use the browser tool and report only information actually observed on the page.',
      userMessage: `Open ${targetUrl} and return its research report code.`,
      allowedServerIds: [],
    })

    assert.equal(turn.kind, 'completed')
    if (turn.kind !== 'completed') return
    assert.equal(turn.result.toolCallCount, 3)
    assert.equal(turn.result.executedToolCallCount, 3)
    assert.equal(turn.result.text, 'agent-received:E2E_REPORT_CODE_ORBITAL_742')
    assert.equal((await browserManager.status()).pageCount, 0)

    const researchIdentity = {
      sessionId: 'session-browser-research',
      runId: 'run-browser-research',
      assignmentId: 'assignment-browser-research',
    }
    const researchLocation = buildSessionRunAssignmentLocation(workspacePath, researchIdentity)
    assert.ok(researchLocation)
    fs.mkdirSync(researchLocation.assignmentPath, { recursive: true })
    const fallbackUrl = targetUrl.replace('127.0.0.1', 'localhost')
    const researchTurn = await service.runTurn({
      ...researchIdentity,
      activityScopeId: 'lane-browser-research',
      agentDisplayName: 'Browser Evidence Analyst',
      taskId: 'task-browser-research',
      agentPath: 'agents/web-researcher',
      provider,
      model: 'fixture/browser-research',
      thinking: 'medium',
      cwd: fs.realpathSync(researchLocation.assignmentPath),
      systemPrompt: 'Answer directly from usable browser evidence. Pivot away from challenged sources.',
      researchQuestion: `What research report code is on the requested source ${fallbackUrl}/good?`,
      userMessage: [
        `Challenge URL: ${targetUrl}/challenge`,
        `Good URL: ${fallbackUrl}/good`,
      ].join('\n'),
      allowedServerIds: [],
    })

    assert.equal(researchTurn.kind, 'completed')
    if (researchTurn.kind !== 'completed') return
    assert.equal(researchTurn.result.toolCallCount, 3)
    assert.equal(researchTurn.result.executedToolCallCount, 3)
    assert.equal(
      researchTurn.result.text,
      `Verified answer: E2E_REPORT_CODE_ORBITAL_742\nSource: ${fallbackUrl}/good`,
    )
    assert.doesNotMatch(researchTurn.result.text, /Question:|Open Questions:|Next Step:/)
    const activity = await browserToolService.listSession(researchIdentity.sessionId)
    // The repeated challenged URL reaches Chrome and meets the same wall, which
    // is what proves the challenge did not close the host for the lane.
    assert.deepEqual(
      activity.map((entry) => entry.error?.code ?? 'completed'),
      ['access_challenge', 'access_challenge', 'completed'],
    )
    assert.ok(activity[2]?.observationReceipt)
    assert.equal(
      activity[2]?.observationReceipt?.activityScopeId,
      'lane-browser-research',
    )
    assert.equal(
      fs.existsSync(path.join(
        researchLocation.assignmentPath,
        activity[2]!.observationReceipt!.relativePath,
      )),
      true,
    )
    const engineEvents = fs.readFileSync(
      path.join(
        researchLocation.assignmentPath,
        'logs',
        'engine-events.jsonl',
      ),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const observationEvent = engineEvents.find(
      (event) => event.type === 'artifact.written',
    )
    assert.ok(observationEvent)
    const observationPayload = observationEvent.payload as Record<string, unknown>
    assert.equal(observationPayload.agent_id, 'lane-browser-research')
    assert.equal(observationPayload.agent_name, 'Browser Evidence Analyst')
    assert.equal(observationPayload.agent_base_name, 'web-researcher')
    const restartedBrowserToolService = new BrowserToolService({
      workspacePath,
      repoRootPath,
      manager: browserManager,
    })
    assert.deepEqual(
      (await restartedBrowserToolService.listSession(researchIdentity.sessionId))
        .map((entry) => entry.error?.code ?? 'completed'),
      ['access_challenge', 'access_challenge', 'completed'],
    )

    const unsupportedIdentity = {
      sessionId: 'session-browser-research-unsupported',
      runId: 'run-browser-research-unsupported',
      assignmentId: 'assignment-browser-research-unsupported',
    }
    const unsupportedLocation = buildSessionRunAssignmentLocation(workspacePath, unsupportedIdentity)
    assert.ok(unsupportedLocation)
    fs.mkdirSync(unsupportedLocation.assignmentPath, { recursive: true })
    const unsupportedTurn = await service.runTurn({
      ...unsupportedIdentity,
      taskId: 'task-browser-research-unsupported',
      agentPath: 'agents/web-researcher',
      provider,
      model: 'fixture/browser-research-unsupported',
      thinking: 'medium',
      cwd: fs.realpathSync(unsupportedLocation.assignmentPath),
      systemPrompt: 'Recommend only from relevant, independently observed browser evidence.',
      researchQuestion: 'What is the best beer in Ann Arbor?',
      userMessage: [
        `First URL: ${fallbackUrl}/wrong-city`,
        `Second URL: ${fallbackUrl}/generic-beer`,
      ].join('\n'),
      allowedServerIds: [],
    })

    assert.equal(unsupportedTurn.kind, 'completed')
    if (unsupportedTurn.kind !== 'completed') return
    assert.equal(unsupportedTurn.result.toolCallCount, 2)
    assert.equal(unsupportedTurn.result.executedToolCallCount, 2)
    assert.equal(unsupportedTurn.result.text, INSUFFICIENT_WEB_RESEARCH_RESPONSE)
    assert.doesNotMatch(unsupportedTurn.result.text, /HOMES|If you want/i)
    assert.deepEqual(
      (await browserToolService.listSession(unsupportedIdentity.sessionId))
        .map((entry) => entry.error?.code ?? 'completed'),
      ['completed', 'completed'],
    )
  } finally {
    await Promise.allSettled([
      browserManager.close(),
      mcpSettings.closeAll(),
      providerFixture.close(),
      new Promise<void>((resolve) => website.close(() => resolve())),
    ])
    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}
