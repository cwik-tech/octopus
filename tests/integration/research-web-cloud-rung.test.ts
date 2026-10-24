import { startBrowserUseApiFixture, stoppedSession } from '../support/browser-use-api-fixture.js'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { Agent } from 'undici'

import { DEFAULT_ACQUISITION_BUDGETS } from '../../domains/acquisition/acquisition-settings.js'
import type { AcquisitionSettingsUpdate } from '../../domains/acquisition/acquisition-settings.js'
import type { BrowserAcquiredEvidence } from '../../domains/browser/browser-manager.js'
import type { CloudAcquisitionResult } from '../../domains/browser/cloud-browser-acquirer.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'

/**
 * When the cloud rung runs, and — more importantly — when it does not.
 *
 * The ladder has four early exits and three of them return before any tail, so
 * a rung wired to one site would look correct and be invisible in the
 * configuration a blocked source is usually met in. Each test below drives one
 * of those routes, and every one of them asserts the exact number of paid calls.
 */

const CONTRACT = MCP_RUNTIME_CONTRACT_VERSION

interface FakeCloud {
  readonly calls: readonly string[]
  acquire(url: string): Promise<CloudAcquisitionResult>
}

function cloudRuntime(): CloudAcquisitionResult['runtime'] {
  return {
    provider: 'browser-use',
    proxyCountry: 'none',
    browserCostMicros: 1_000,
    proxyCostMicros: 0,
    proxyUsedMilliMb: 0,
    sessionStatus: 'stopped',
    meterSource: 'stop-confirmed',
  }
}

interface GatedCloud extends FakeCloud {
  /** Resolves once the first call has entered and is holding. */
  readonly firstEntered: Promise<void>
  /** Resolves once a second call has entered. */
  readonly secondEntered: Promise<void>
  releaseFirst(): void
}

/**
 * A cloud rung whose first call holds until released.
 *
 * Only the first call blocks. A later one records itself and returns, so a test
 * can observe whether it was allowed to start without having to unblock
 * anything to avoid a deadlock.
 */
function gatedCloud(): GatedCloud {
  const calls: string[] = []
  const inner = fakeCloud()
  let announceFirst = (): void => undefined
  let announceSecond = (): void => undefined
  let releaseFirst = (): void => undefined
  const firstEntered = new Promise<void>((resolve) => {
    announceFirst = resolve
  })
  const secondEntered = new Promise<void>((resolve) => {
    announceSecond = resolve
  })
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  return {
    calls,
    firstEntered,
    secondEntered,
    releaseFirst: () => releaseFirst(),
    async acquire(url) {
      calls.push(url)
      if (calls.length === 1) {
        announceFirst()
        await gate
      } else {
        announceSecond()
      }
      return inner.acquire(url)
    },
  }
}

/** Resolves true if `work` settles first, false at the deadline. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
    timer.unref()
  })
  try {
    return await Promise.race([work.then(() => true), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function fakeCloud(options: { readonly usable?: boolean } = {}): FakeCloud {
  const calls: string[] = []
  return {
    calls,
    async acquire(url) {
      calls.push(url)
      if (options.usable === false) {
        return {
          failure: { code: 'provider_session_failed', message: 'nothing recovered' },
          runtime: cloudRuntime(),
          cleanup: { stopped: true },
        }
      }
      return {
        evidence: {
          requestedUrl: url,
          finalUrl: url,
          title: 'Recovered report',
          httpStatus: 200,
          text: 'Independent evidence recovered through the cloud browser rung.',
          renderedHtml:
            '<!doctype html><html><head><title>Recovered report</title></head>' +
            '<body><main><h1>Recovered report</h1><p>Independent evidence recovered ' +
            'through the cloud browser rung, with enough prose for the quality ' +
            'classifier to treat it as a genuine page rather than a stub.</p>' +
            '</main></body></html>',
          renderedHtmlTruncated: false,
        },
        runtime: cloudRuntime(),
        cleanup: { stopped: true },
      }
    },
  }
}

/** A managed browser that refuses, without launching one. */
function refusingBrowser(status: number): {
  acquireEvidence(scope: unknown, url: string): Promise<BrowserAcquiredEvidence>
} {
  return {
    async acquireEvidence(_scope: unknown, url: string) {
      return {
        requestedUrl: url,
        finalUrl: url,
        httpStatus: status,
        text: 'Forbidden',
        renderedHtml: '<!doctype html><html><body>Forbidden</body></html>',
        renderedHtmlTruncated: false,
      }
    },
  }
}

interface Harness {
  readonly service: ResearchWebToolService
  readonly origin: string
  readonly context: {
    readonly contractVersion: typeof CONTRACT
    readonly requestId: string
    readonly leaseId: string
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
    readonly activityScopeId: string
    readonly agentPath: string
  }
  close(): Promise<void>
}

function budgets(
  cloudCalls: number,
  cloudCostMicros: number | undefined,
  reader: boolean,
  cloudProvider = false,
): AcquisitionSettingsUpdate {
  return {
    providerPriority: ['exa', 'brave'],
    providers: {
      exa: { enabled: false },
      brave: { enabled: false },
      firecrawl: { enabled: reader },
      'browser-use': {
        enabled: cloudProvider,
        ...(cloudProvider ? { apiKey: 'bu_key' } : {}),
      },
    },
    budgets: {
      ...DEFAULT_ACQUISITION_BUDGETS,
      maximumCloudBrowserCalls: cloudCalls,
      maximumCloudBrowserCostMicros:
        cloudCostMicros ?? (cloudCalls === 0 ? 0 : 10_000_000),
    },
    extractionModel: null,
  }
}

interface FakeWebshare {
  open(): Promise<{ dispatcher: Agent; close(): Promise<void> } | undefined>
}

/**
 * A Webshare port that opens, using an ordinary agent as its transport.
 *
 * Enough to take the proxied ladder, which is the path whose reader owns the
 * lane ban. The "proxied" read reaches the same loopback origin and is refused
 * the same way, which is what the ladder is being driven to do.
 */
function openingWebshare(): FakeWebshare {
  return {
    async open() {
      const dispatcher = new Agent()
      return {
        dispatcher,
        async close() {
          await dispatcher.close()
        },
      }
    },
  }
}

/** A Webshare port that is configured on but cannot open a session. */
function failingWebshare(): FakeWebshare {
  return {
    async open(): Promise<undefined> {
      throw new Error('the proxy would not connect')
    },
  }
}

async function makeHarness(options: {
  readonly name: string
  readonly cloud?: FakeCloud
  /** Zero leaves calls unlimited; provider enablement is independent. */
  readonly cloudCalls?: number
  readonly cloudCostMicros?: number
  readonly cloudProviderEnabled?: boolean
  readonly browser?: ReturnType<typeof refusingBrowser>
  /** Enables a managed reader pointed at the loopback origin. */
  readonly reader?: boolean
  /** Makes the managed reader return a source refusal rather than nothing. */
  readonly readerDenies?: boolean
  readonly webshare?: FakeWebshare
  /**
   * Enables the real settings-resolved provider with these runtime inputs,
   * instead of injecting a stand-in. The provider key is saved through the
   * settings update, as it is in the application.
   */
  readonly cloudEndpoint?: string
  readonly providerEnvironment?: NodeJS.ProcessEnv
}): Promise<Harness> {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `cloud-rung-${options.name}-`)),
  )
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  writeResearchAgent(repoRootPath)

  const server = createServer((request, response) => {
    if (request.url?.startsWith('/firecrawl-denied')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      // The reader reached the source and the source refused it. That is a
      // denial the reader owns, not a transport failure.
      response.end(
        JSON.stringify({
          success: true,
          data: {
            markdown:
              'Access Denied. You do not have permission to access this resource on this server.',
          },
        }),
      )
      return
    }
    if (request.url?.startsWith('/firecrawl')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      // The reader answers, but with nothing to cite. Anything it *can* cite
      // ends the call there, which is correct — so the ordering this test is
      // about only becomes visible when the free rung genuinely comes up empty.
      response.end(JSON.stringify({ success: true, data: { markdown: '' } }))
      return
    }
    if (request.url?.startsWith('/denied')) {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><body>Forbidden</body></html>')
      return
    }
    if (request.url?.startsWith('/missing')) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><body>Not found</body></html>')
      return
    }
    if (request.url?.startsWith('/thin')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><body><p>.</p></body></html>')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><body><p>ok</p></body></html>')
  })
  const origin = await listen(server)

  const settings = new AcquisitionSettingsService({
    environment: {
      ...(options.reader ? { FIRECRAWL_API_KEY: 'test-key' } : {}),
      ...(options.providerEnvironment ?? {}),
    },
    storagePath: path.join(root, 'acquisition-settings.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    ...((options.reader || options.cloudEndpoint) ? {
      providerEndpoints: {
        ...(options.reader ? { firecrawl: `${origin}/${options.readerDenies ? 'firecrawl-denied' : 'firecrawl'}` } : {}),
        ...(options.cloudEndpoint ? { 'browser-use': options.cloudEndpoint } : {}),
      },
    } : {}),
    allowHttpLocalhost: true,
  })
  await settings.update(
    budgets(
      options.cloudCalls ?? 0,
      options.cloudCostMicros,
      options.reader === true,
      options.cloudProviderEnabled ?? options.providerEnvironment !== undefined,
    ),
  )

  const service = new ResearchWebToolService({
    workspacePath,
    repoRootPath,
    settings,
    allowHttpLocalhost: true,
    ...(options.cloud ? { cloudAcquirer: options.cloud } : {}),
    ...(options.browser ? { browserManager: options.browser } : {}),
    ...(options.webshare ? { webshareProxy: options.webshare } : {}),
  })
  const context = {
    contractVersion: CONTRACT,
    requestId: `request-${options.name}`,
    leaseId: `lease-${options.name}`,
    sessionId: `session-${options.name}`,
    runId: `run-${options.name}`,
    assignmentId: 'runtime-assignment',
    activityScopeId: `lane-${options.name}`,
    agentPath: 'agents/web-researcher',
  } as const
  const location = buildSessionRunAssignmentLocation(workspacePath, context)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })

  return {
    service,
    origin,
    context,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

test('a direct refusal with no proxy configured still reaches the cloud rung', async () => {
  const cloud = fakeCloud()
  const harness = await makeHarness({ name: 'no-webshare', cloud, cloudCalls: 3 })
  try {
    // Exit 3: this returned before either ladder tail, so a rung wired only to
    // the tails would never run in the configuration most installations use.
    const output = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/denied`,
      allowBrowserFallback: false,
    })

    assert.deepEqual(cloud.calls, [`${harness.origin}/denied`])
    assert.equal(output.ok, true)
    assert.equal(output.attempts?.at(-1)?.method, 'cloud-browser')
  } finally {
    await harness.close()
  }
})

test('a terminal managed-browser refusal reaches the cloud rung', async () => {
  const cloud = fakeCloud()
  const harness = await makeHarness({
    name: 'browser-refusal',
    cloud,
    cloudCalls: 3,
    browser: refusingBrowser(403),
  })
  try {
    // Exit 4: the browser rung returned before the reader and before any tail.
    const output = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/thin`,
    })

    assert.equal(cloud.calls.length, 1)
    assert.equal(output.ok, true)
  } finally {
    await harness.close()
  }
})

test('a direct refusal escalates without first spending a managed reader call', async () => {
  const cloud = fakeCloud()
  const harness = await makeHarness({
    name: 'refusal-then-thin',
    cloud,
    cloudCalls: 3,
    reader: true,
  })
  try {
    // A managed reader is configured and enabled, and is deliberately *not*
    // reached: a terminal direct refusal exits before the reader rung, so the
    // escalation happens on the refusal itself.
    //
    // The rung's own test is `attempts.some(refusal)` rather than "the last
    // attempt was a refusal". Those two are equivalent on every path the ladder
    // can currently take, because every refusal exits immediately — so no test
    // here distinguishes them, and none is claimed to. The `some` form is the
    // contract in §1 of the plan written out literally, and it stays correct if
    // a later rung is ever allowed to run after a refusal.
    const output = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/denied`,
      allowBrowserFallback: false,
      allowManagedReaderFallback: true,
    })

    const outcomes = output.attempts?.map((attempt) => attempt.outcome) ?? []
    assert.ok(outcomes.includes('access-denied'), 'the refusal must be on the trail')
    assert.equal(outcomes.at(-1), 'usable', 'the cloud rung recovered the source')
    assert.equal(
      output.attempts?.some((attempt) => attempt.method === 'managed-reader'),
      false,
      'a paid reader call must not be spent on a source the direct rung was refused',
    )
    assert.equal(cloud.calls.length, 1, 'the refusal earns the escalation, not the last outcome')
    assert.equal(output.ok, true)
  } finally {
    await harness.close()
  }
})

test('a cost threshold already reached stops a concurrent call', async () => {
  const cloud = fakeCloud()
  const harness = await makeHarness({
    name: 'cost-threshold',
    cloud,
    cloudCalls: 5,
    // One call costs exactly the threshold, so the second must see the first
    // one's spend. Without a serialized decision both read the same stale zero.
    cloudCostMicros: 1_000,
  })
  try {
    await Promise.all(
      Array.from({ length: 4 }, (_value, index) =>
        harness.service.execute(harness.context, `call-${index}`, {
          action: 'acquire',
          url: `${harness.origin}/denied?page=${index}`,
          allowBrowserFallback: false,
        }),
      ),
    )

    assert.equal(cloud.calls.length, 1, 'the spend threshold must hold under concurrency')
  } finally {
    await harness.close()
  }
})

test('a proxy that will not open still reaches the cloud rung', async () => {
  const cloud = fakeCloud()
  const harness = await makeHarness({
    name: 'webshare-open-failure',
    cloud,
    cloudCalls: 3,
    webshare: failingWebshare(),
  })
  try {
    // Configured-on-but-unusable takes the proxied ladder, whose own tail
    // returned before the rung existed — so this path could never escalate.
    const output = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/denied`,
      allowBrowserFallback: false,
    })

    assert.equal(cloud.calls.length, 1)
    assert.equal(output.ok, true)
  } finally {
    await harness.close()
  }
})

test('a free managed reader runs before the paid rung, not after it', async () => {
  const cloud = fakeCloud()
  const harness = await makeHarness({
    name: 'reader-before-cloud',
    cloud,
    cloudCalls: 3,
    reader: true,
    browser: refusingBrowser(403),
  })
  try {
    // direct insufficient -> managed browser refused -> reader empty -> exactly
    // one cloud call. Cloud is the *last* rung; reaching it by jumping a free
    // rung spends money the ladder had not earned the right to spend.
    const output = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/thin`,
      allowManagedReaderFallback: true,
    })

    const trail = output.attempts?.map((attempt) => attempt.method) ?? []
    const readerAt = trail.indexOf('managed-reader')
    const cloudAt = trail.indexOf('cloud-browser')
    assert.ok(readerAt >= 0, `the managed reader must run: ${trail.join(' -> ')}`)
    assert.ok(cloudAt > readerAt, 'the paid rung comes after the free one')
    assert.equal(cloud.calls.length, 1)
  } finally {
    await harness.close()
  }
})

test('a source that was never refused does not reach the cloud rung', async () => {
  const cloud = fakeCloud()
  const harness = await makeHarness({ name: 'not-found', cloud, cloudCalls: 3 })
  try {
    // A missing page is not made present by a different browser.
    const output = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/missing`,
      allowBrowserFallback: false,
    })

    assert.deepEqual(cloud.calls, [])
    assert.equal(output.ok, false)
  } finally {
    await harness.close()
  }
})

test('a withdrawn caller does not reach the cloud rung', async () => {
  const cloud = fakeCloud()
  const harness = await makeHarness({ name: 'cancelled', cloud, cloudCalls: 3 })
  try {
    const controller = new AbortController()
    controller.abort()

    await harness.service.execute(
      harness.context,
      'call-1',
      { action: 'acquire', url: `${harness.origin}/denied`, allowBrowserFallback: false },
      controller.signal,
    )

    assert.deepEqual(cloud.calls, [])
  } finally {
    await harness.close()
  }
})

test('a zero call budget allows an available cloud provider to recover a refusal', async () => {
  const cloud = fakeCloud()
  // No cloudCalls override: the shipped default is zero.
  const harness = await makeHarness({ name: 'default-off', cloud })
  try {
    const output = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/denied`,
      allowBrowserFallback: false,
    })

    assert.deepEqual(cloud.calls, [`${harness.origin}/denied`])
    assert.equal(output.ok, true)
  } finally {
    await harness.close()
  }
})

test('a disabled cloud provider preserves the refusal with unlimited or positive budgets', async () => {
  const withCloud = await makeHarness({ name: 'baseline-cloud', cloudCalls: 2, cloudCostMicros: 1000 })
  const withoutCloud = await makeHarness({ name: 'baseline-plain' })
  try {
    const configured = await withCloud.service.execute(withCloud.context, 'call-1', {
      action: 'acquire',
      url: `${withCloud.origin}/denied`,
      allowBrowserFallback: false,
    })
    const plain = await withoutCloud.service.execute(withoutCloud.context, 'call-1', {
      action: 'acquire',
      url: `${withoutCloud.origin}/denied`,
      allowBrowserFallback: false,
    })

    // Same error, same retryability, and the same attempt trail shape.
    assert.deepEqual(configured.error, plain.error)
    assert.deepEqual(
      configured.attempts?.map((attempt) => [attempt.method, attempt.outcome]),
      plain.attempts?.map((attempt) => [attempt.method, attempt.outcome]),
    )
  } finally {
    await withCloud.close()
    await withoutCloud.close()
  }
})

test('a recovered source is not left banned for the lane', async () => {
  const cloud = fakeCloud()
  const harness = await makeHarness({ name: 'ban-ownership', cloud, cloudCalls: 3 })
  try {
    const first = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/denied?page=1`,
      allowBrowserFallback: false,
    })
    // A host the cloud rung recovered must stay reachable: banning it on the
    // way out would make the recovery useless for every later page on it.
    const second = await harness.service.execute(harness.context, 'call-2', {
      action: 'acquire',
      url: `${harness.origin}/denied?page=2`,
      allowBrowserFallback: false,
    })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(cloud.calls.length, 2)
  } finally {
    await harness.close()
  }
})

test('concurrent acquisitions cannot spend past the call budget', async () => {
  // A recovering rung on purpose: a failing one bans the host after the first
  // attempt, so every later caller returns before the budget is ever consulted
  // and the test would pass without proving anything.
  const cloud = fakeCloud()
  const harness = await makeHarness({ name: 'concurrent', cloud, cloudCalls: 2 })
  try {
    // A plain check-then-call lets every in-flight caller read the same stale
    // total, so this drives six at once against a budget of two.
    await Promise.all(
      Array.from({ length: 6 }, (_value, index) =>
        harness.service.execute(harness.context, `call-${index}`, {
          action: 'acquire',
          url: `${harness.origin}/denied?page=${index}`,
          allowBrowserFallback: false,
        }),
      ),
    )

    assert.equal(cloud.calls.length, 2, 'the budget must hold under concurrency')
  } finally {
    await harness.close()
  }
})

test('an unconfirmed bill stops the lane from creating more sessions', async () => {
  const calls: string[] = []
  const recovering = fakeCloud()
  const unmeteredCloud = {
    calls,
    async acquire(url: string): Promise<CloudAcquisitionResult> {
      calls.push(url)
      // Recovers the page, so no host ban hides the budget rule behind it, but
      // comes back without a confirmed bill.
      const result = await recovering.acquire(url)
      return {
        ...result,
        runtime: { ...result.runtime, meterSource: 'create-last-known' },
        cleanup: { stopped: false },
      }
    },
  }
  const harness = await makeHarness({
    name: 'unknown-bill',
    cloud: unmeteredCloud,
    cloudCalls: 5,
  })
  try {
    for (let index = 0; index < 3; index += 1) {
      await harness.service.execute(harness.context, `call-${index}`, {
        action: 'acquire',
        url: `${harness.origin}/denied?page=${index}`,
        allowBrowserFallback: false,
      })
    }

    // An unknown bill is not a zero bill. Continuing to create sessions on a
    // lane whose spend we cannot account for is how a budget quietly stops
    // meaning anything.
    assert.equal(calls.length, 1)
  } finally {
    await harness.close()
  }
})

test('a path that cannot escalate never resolves the paid provider', async () => {
  // The provider is enabled but its runtime environment is malformed, so
  // resolving it throws. A 404 was never eligible for escalation, so an
  // acquisition that resolves the provider before checking eligibility breaks a
  // perfectly ordinary free path — and pays the cost of loading a browser
  // driver on every call besides.
  const harness = await makeHarness({
    name: 'no-resolve-when-ineligible',
    cloudCalls: 3,
    providerEnvironment: {
      BROWSER_USE_PROXY_COUNTRY: 'not-a-country',
    },
  })
  try {
    const output = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/missing`,
      allowBrowserFallback: false,
    })

    assert.equal(output.ok, false)
    assert.equal(output.error?.code, 'not_found', 'the free path must be unaffected')
  } finally {
    await harness.close()
  }
})

test('a disabled provider does not resolve runtime options even with unlimited budgets', async () => {
  const harness = await makeHarness({
    name: 'no-resolve-when-disabled',
    cloudProviderEnabled: false,
    providerEnvironment: {
      BROWSER_USE_PROXY_COUNTRY: 'not-a-country',
    },
  })
  try {
    // Refusal is eligible and both limits are unlimited, but the provider
    // switch is off: malformed runtime options must not be resolved.
    const output = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/denied`,
      allowBrowserFallback: false,
    })

    assert.equal(output.ok, false)
    assert.equal(output.error?.code, 'access_denied')
  } finally {
    await harness.close()
  }
})

test('a reader-owned lane ban survives a cloud attempt that recovered nothing', async () => {
  const cloud = fakeCloud({ usable: false })
  const harness = await makeHarness({
    name: 'ban-survives-cloud',
    cloud,
    cloudCalls: 3,
    reader: true,
    readerDenies: true,
    // The proxied ladder is the path whose reader owns the lane ban.
    webshare: openingWebshare(),
  })
  try {
    const first = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/denied?page=1`,
      allowBrowserFallback: false,
      allowManagedReaderFallback: true,
    })
    const outcomes = first.attempts?.map((attempt) => attempt.outcome) ?? []
    assert.ok(outcomes.includes('access-denied'), `reader denial expected: ${outcomes.join()}`)
    assert.equal(cloud.calls.length, 1)

    // The cloud rung appends its own attempt, so a ban that consults "the last
    // outcome" would read the provider's failure and drop the denial the reader
    // had already earned.
    // A page the origin serves happily. If the lane ban survived, this is
    // refused before acquisition; if it did not, the page is simply read. A
    // second refusing URL could not tell those apart.
    const second = await harness.service.execute(harness.context, 'call-2', {
      action: 'acquire',
      url: `${harness.origin}/plain?page=2`,
      allowBrowserFallback: false,
    })

    assert.equal(second.ok, false)
    assert.equal(second.error?.code, 'access_denied', 'the reader-owned ban must survive')
  } finally {
    await harness.close()
  }
})

test('a source the cloud rung recovered is not banned by the rung before it', async () => {
  const cloud = fakeCloud()
  const harness = await makeHarness({
    name: 'ban-skipped-on-recovery',
    cloud,
    cloudCalls: 3,
    reader: true,
    readerDenies: true,
    webshare: openingWebshare(),
  })
  try {
    const first = await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/denied?page=1`,
      allowBrowserFallback: false,
      allowManagedReaderFallback: true,
    })
    const second = await harness.service.execute(harness.context, 'call-2', {
      action: 'acquire',
      url: `${harness.origin}/plain?page=2`,
      allowBrowserFallback: false,
      allowManagedReaderFallback: true,
    })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true, 'a recovered host must stay reachable')
  } finally {
    await harness.close()
  }
})

test('a released lane does not queue behind the call it left in flight', async () => {
  // The per-lane spend chain is what serializes cloud decisions. If it survives
  // the lane, a reused scope waits on a promise belonging to work nobody is
  // waiting for any more — which is both a leak and a stall.
  const cloud = gatedCloud()
  const harness = await makeHarness({ name: 'release-in-flight', cloud, cloudCalls: 5 })
  try {
    const first = harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/denied?page=1`,
      allowBrowserFallback: false,
    })
    await cloud.firstEntered

    await harness.service.releaseAssignment(harness.context)

    const second = harness.service.execute(harness.context, 'call-2', {
      action: 'acquire',
      url: `${harness.origin}/denied?page=2`,
      allowBrowserFallback: false,
    })

    // Bounded on purpose: a retained chain makes the second call wait for the
    // first, and the failure has to be a quick assertion rather than a hang.
    const started = await settlesWithin(cloud.secondEntered, 750)
    assert.equal(started, true, 'the reused scope must not wait on the old lane')

    cloud.releaseFirst()
    await Promise.all([first, second])
  } finally {
    await harness.close()
  }
})

test('releasing an assignment clears its cloud spend counters', async () => {
  const cloud = fakeCloud()
  const harness = await makeHarness({ name: 'release', cloud, cloudCalls: 1 })
  try {
    await harness.service.execute(harness.context, 'call-1', {
      action: 'acquire',
      url: `${harness.origin}/denied?page=1`,
      allowBrowserFallback: false,
    })
    // Budget of one, so a second call in the same lane must be refused.
    await harness.service.execute(harness.context, 'call-2', {
      action: 'acquire',
      url: `${harness.origin}/denied?page=2`,
      allowBrowserFallback: false,
    })
    assert.equal(cloud.calls.length, 1)

    // The lane is finished. Its counters, its lane bans and its serialized
    // spend chain all belong to it and go with it.
    await harness.service.releaseAssignment(harness.context)

    await harness.service.execute(harness.context, 'call-3', {
      action: 'acquire',
      url: `${harness.origin}/denied?page=3`,
      allowBrowserFallback: false,
    })

    assert.equal(cloud.calls.length, 2, 'a reused scope starts from a fresh budget')
  } finally {
    await harness.close()
  }
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('The origin fixture did not bind a port.')
  }
  return `http://127.0.0.1:${address.port}`
}

function writeResearchAgent(repoRootPath: string): void {
  const agentPath = path.join(repoRootPath, 'agents', 'web-researcher')
  fs.mkdirSync(agentPath, { recursive: true })
  fs.writeFileSync(
    path.join(agentPath, 'web-researcher.md'),
    [
      '---',
      'name: web-researcher',
      'tools: read, research_web, browser',
      '---',
      '',
      '# Web Researcher',
      '',
    ].join('\n'),
    'utf8',
  )
}


// Browser Use is paid and nondeterministic; replace its HTTP endpoint only.
// The budget, settings, lane counters, provider client and cleanup are real.
for (const scenario of [
  { name: 'both-unlimited', calls: 0, cost: 0, expected: 3 },
  { name: 'unlimited-calls-positive-cost', calls: 0, cost: 1000, expected: 1 },
  { name: 'positive-calls-unlimited-cost', calls: 1, cost: 0, expected: 1 },
  { name: 'unlimited-calls-cost-remaining', calls: 0, cost: 50000, expected: 3 },
]) {
  test(`${scenario.name}: zero removes only its cloud browser limit`, async () => {
    const provider = await startBrowserUseApiFixture()
    provider.respondToStop({ body: stoppedSession({ browserCost: '0.01' }) })
    const harness = await makeHarness({
      name: scenario.name, cloudCalls: scenario.calls, cloudCostMicros: scenario.cost,
      cloudEndpoint: provider.url, providerEnvironment: {},
    })
    try {
      await harness.service.execute(harness.context, 'first', {
        action: 'acquire', url: `${harness.origin}/denied?first`, allowBrowserFallback: false,
      })
      await harness.service.execute(harness.context, 'second', {
        // Use search after acquisition: failed acquisition bans its host,
        // while both paths must share the same cloud budget. Search tries
        // two engines, so an unlimited lane creates three sessions in total.
        action: 'search', query: 'second request',
      })
      assert.equal(provider.requests.filter((request) => request.method === 'POST').length, scenario.expected)
      assert.equal(provider.requests.filter((request) => request.method === 'PATCH').length, scenario.expected, 'every admitted session is closed')
    } finally {
      await harness.close()
      await provider.close()
    }
  })
}
