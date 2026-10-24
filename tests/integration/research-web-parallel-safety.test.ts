import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { AcquisitionSettingsUpdate } from '../../domains/acquisition/acquisition-settings.js'
import type { CloudAcquisitionResult } from '../../domains/browser/cloud-browser-acquirer.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'

const CLOUD_RESULTS_HTML = [
  '<a href="https://example.com/scoop-shops">Detroit scoop shops</a>',
  '<a href="https://second.example.org/guide">A Detroit ice cream guide</a>',
].join('')

/**
 * How long the paid rung takes to answer.
 *
 * It is the fixture provider's latency, not a synchronisation device: the
 * assertions below read the returned codes and the acquire count, never the
 * clock. A rung that answered inside its caller's synchronous step would hide
 * the admission window this test exists to close.
 */
const PAID_RUNG_LATENCY_MS = 60

test('a search budget of one admits exactly one concurrent public tool call', async (context) => {
  const provider = await startProviderServer()
  context.after(() => provider.close())
  const fixture = await createFixture(context, provider, settingsUpdate({
    exaEnabled: true,
    maximumSearchCalls: 1,
  }), { coldReload: true })

  const outcomes = await Promise.all([
    fixture.service.execute(fixture.requestContext, 'call-search-1', {
      action: 'search',
      query: 'first concurrent query',
    }),
    fixture.service.execute(fixture.requestContext, 'call-search-2', {
      action: 'search',
      query: 'second concurrent query',
    }),
  ])

  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1)
  assert.equal(
    outcomes.filter(
      (outcome) => !outcome.ok && outcome.error?.code === 'budget_exhausted',
    ).length,
    1,
  )
  assert.equal(provider.searchCalls, 1)
})

test('an unconfigured search does not consume its later configured budget', async (context) => {
  const provider = await startProviderServer()
  context.after(() => provider.close())
  const fixture = await createFixture(context, provider, settingsUpdate({
    exaEnabled: false,
    maximumSearchCalls: 1,
  }))

  const unconfigured = await fixture.service.execute(
    fixture.requestContext,
    'call-unconfigured',
    { action: 'search', query: 'provider unavailable' },
  )
  await fixture.settings.update(settingsUpdate({
    exaEnabled: true,
    maximumSearchCalls: 1,
  }))
  const configured = await fixture.service.execute(
    fixture.requestContext,
    'call-configured',
    { action: 'search', query: 'provider available' },
  )

  assert.equal(unconfigured.ok, false)
  assert.equal(unconfigured.error?.code, 'not_configured')
  assert.equal(configured.ok, true, JSON.stringify(configured))
  assert.equal(provider.searchCalls, 1)
})

test('an unconfigured search journals the provider priority for capability diagnostics', async (context) => {
  const provider = await startProviderServer()
  context.after(() => provider.close())
  const fixture = await createFixture(context, provider, settingsUpdate({
    exaEnabled: false,
  }))

  const unconfigured = await fixture.service.execute(
    fixture.requestContext,
    'call-unconfigured-priority',
    { action: 'search', query: 'provider unavailable' },
  )

  assert.equal(unconfigured.error?.code, 'not_configured')
  const activities = await fixture.service.listSession(
    fixture.requestContext.sessionId,
  )
  const searchActivity = activities.find(
    (activity) => activity.action === 'search',
  )
  assert.ok(searchActivity, 'the failed search is journalled')
  assert.deepEqual(searchActivity.searchProviderPriority, ['exa', 'brave'])
})

test('a search budget of one admits exactly one concurrent paid discovery call', async (context) => {
  const provider = await startProviderServer()
  context.after(() => provider.close())
  const cloudCalls: string[] = []
  const fixture = await createFixture(context, provider, settingsUpdate({
    exaEnabled: false,
    browserUseEnabled: true,
    maximumSearchCalls: 1,
    maximumCloudBrowserCalls: 4,
  }), {
    cloud: {
      async acquire(url): Promise<CloudAcquisitionResult> {
        cloudCalls.push(url)
        await new Promise((resolve) => {
          setTimeout(resolve, PAID_RUNG_LATENCY_MS)
        })
        return {
          evidence: {
            requestedUrl: url,
            finalUrl: url,
            text: 'Rendered search results',
            renderedHtml: CLOUD_RESULTS_HTML,
            renderedHtmlTruncated: false,
          },
          runtime: {
            provider: 'browser-use',
            proxyCountry: 'none',
            browserCostMicros: 334,
            proxyCostMicros: 0,
            proxyUsedMilliMb: 0,
            sessionStatus: 'stopped',
            meterSource: 'stop-confirmed',
          },
          cleanup: { stopped: true },
        }
      },
    },
  })

  const outcomes = await Promise.all([
    fixture.service.execute(fixture.requestContext, 'call-cloud-search-1', {
      action: 'search',
      query: 'first concurrent query',
    }),
    fixture.service.execute(fixture.requestContext, 'call-cloud-search-2', {
      action: 'search',
      query: 'second concurrent query',
    }),
  ])

  assert.equal(
    outcomes.filter((outcome) => outcome.ok).length,
    1,
    JSON.stringify(outcomes),
  )
  assert.equal(
    outcomes.filter(
      (outcome) => !outcome.ok && outcome.error?.code === 'budget_exhausted',
    ).length,
    1,
  )
  assert.equal(
    cloudCalls.length,
    1,
    'a second search admitted against a budget of one spends a second paid session',
  )
})

test('a managed-reader budget of one admits exactly one concurrent fallback', async (context) => {
  const provider = await startProviderServer()
  context.after(() => provider.close())
  const fixture = await createFixture(context, provider, settingsUpdate({
    firecrawlEnabled: true,
    maximumManagedReaderCalls: 1,
  }))

  const outcomes = await Promise.all([
    fixture.service.execute(fixture.requestContext, 'call-reader-1', {
      action: 'acquire',
      url: `${provider.url}/source/a`,
      allowBrowserFallback: false,
      allowManagedReaderFallback: true,
    }),
    fixture.service.execute(fixture.requestContext, 'call-reader-2', {
      action: 'acquire',
      url: `${provider.url}/source/b`,
      allowBrowserFallback: false,
      allowManagedReaderFallback: true,
    }),
  ])

  assert.equal(provider.readerCalls, 1)
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1)
  assert.equal(
    outcomes.filter(
      (outcome) => !outcome.ok && outcome.error?.code === 'empty_content',
    ).length,
    1,
  )
})

interface ProviderServer {
  readonly url: string
  readonly searchCalls: number
  readonly readerCalls: number
  close(): Promise<void>
}

interface ResearchFixture {
  readonly service: ResearchWebToolService
  readonly settings: AcquisitionSettingsService
  readonly requestContext: {
    readonly contractVersion: typeof MCP_RUNTIME_CONTRACT_VERSION
    readonly requestId: string
    readonly leaseId: string
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
    readonly activityScopeId: string
    readonly agentPath: string
  }
}

async function createFixture(
  context: { after(callback: () => Promise<unknown> | unknown): unknown },
  provider: ProviderServer,
  update: AcquisitionSettingsUpdate,
  options: {
    readonly coldReload?: boolean
    readonly cloud?: {
      acquire(
        url: string,
        policy: unknown,
        signal?: AbortSignal,
      ): Promise<CloudAcquisitionResult>
    }
  } = {},
): Promise<ResearchFixture> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'research-parallel-safety-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const agentPath = 'agents/researcher'
  await fs.mkdir(path.join(repoRootPath, agentPath), { recursive: true })
  await fs.writeFile(
    path.join(repoRootPath, agentPath, 'researcher.md'),
    ['---', 'name: researcher', 'tools: read, research_web', '---', '', '# Researcher', ''].join('\n'),
  )
  const requestContext = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-parallel-safety',
    leaseId: 'lease-parallel-safety',
    sessionId: 'session-parallel-safety',
    runId: 'run-parallel-safety',
    assignmentId: 'assignment-parallel-safety',
    activityScopeId: 'lane-parallel-safety',
    agentPath,
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, requestContext)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  const settingsOptions = {
    storagePath: path.join(root, 'settings.json'),
    environment: {
      EXA_API_KEY: 'test-exa-key',
      FIRECRAWL_API_KEY: 'test-firecrawl-key',
    },
    secretCodec: {
      encrypt: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
    },
    providerEndpoints: {
      exa: `${provider.url}/search`,
      firecrawl: `${provider.url}/reader`,
    },
  }
  const writer = new AcquisitionSettingsService(settingsOptions)
  await writer.update(update)
  const settings = options.coldReload
    ? new AcquisitionSettingsService(settingsOptions)
    : writer
  return {
    settings,
    requestContext,
    service: new ResearchWebToolService({
      workspacePath,
      repoRootPath,
      settings,
      allowHttpLocalhost: true,
      ...(options.cloud ? { cloudAcquirer: options.cloud } : {}),
    }),
  }
}

function settingsUpdate(options: {
  readonly exaEnabled?: boolean
  readonly firecrawlEnabled?: boolean
  readonly browserUseEnabled?: boolean
  readonly maximumSearchCalls?: number
  readonly maximumManagedReaderCalls?: number
  readonly maximumCloudBrowserCalls?: number
}): AcquisitionSettingsUpdate {
  return {
    providerPriority: ['exa', 'brave'],
    providers: {
      exa: { enabled: options.exaEnabled ?? false },
      brave: { enabled: false },
      firecrawl: { enabled: options.firecrawlEnabled ?? false },
      'browser-use': {
        enabled: options.browserUseEnabled ?? false,
        ...(options.browserUseEnabled ? { apiKey: 'bu_key' } : {}),
      },
    },
    budgets: {
      maximumSearchCalls: options.maximumSearchCalls ?? 1,
      maximumBrowserFallbacks: 1,
      maximumManagedReaderCalls: options.maximumManagedReaderCalls ?? 1,
      maximumModelExtractions: 1,
      maximumCloudBrowserCalls: options.maximumCloudBrowserCalls ?? 0,
      maximumCloudBrowserCostMicros:
        (options.maximumCloudBrowserCalls ?? 0) > 0 ? 10_000 : 0,
    },
    extractionModel: null,
  }
}

async function startProviderServer(): Promise<ProviderServer> {
  let searchCalls = 0
  let readerCalls = 0
  const server = http.createServer((request, response) => {
    if (request.url === '/search') {
      searchCalls += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        results: [{
          title: 'Deterministic result',
          url: `https://example.com/result-${searchCalls}`,
          text: 'Deterministic local search result.',
          score: 0.9,
        }],
      }))
      return
    }
    if (request.url === '/reader') {
      readerCalls += 1
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const requestedUrl = /"url":"([^"]+)"/u.exec(
          Buffer.concat(chunks).toString('utf8'),
        )?.[1] ?? 'https://example.com/fallback'
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          success: true,
          data: {
            markdown: [
              '# Managed reader evidence',
              '',
              'This deterministic managed reader response contains enough independent prose ',
              'to pass the acquisition quality gate and prove that only one concurrent fallback ',
              'can claim a budget of one through the public research web tool interface.',
            ].join(''),
            metadata: { sourceURL: requestedUrl, title: 'Managed reader evidence' },
          },
        }))
      })
      return
    }
    if (request.url?.startsWith('/source/')) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Source temporarily unavailable.')
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    get searchCalls() {
      return searchCalls
    },
    get readerCalls() {
      return readerCalls
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
