import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { SOURCE_OBSERVATION_RECEIPT_VERSION } from '../../domains/acquisition/acquisition-types.js'
import { BrowserManager } from '../../domains/browser/browser-manager.js'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'

test('research acquisition uses direct HTTP, escalates rendering to Chrome, and stops on challenge', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'research-web-acquisition-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const manager = new BrowserManager({
    profilePath: path.join(root, 'browser-profile'),
    allowHttpLocalhost: true,
    mode: 'headless',
  })
  const settings = new AcquisitionSettingsService({ environment: {} })
  const service = new ResearchWebToolService({
    workspacePath,
    repoRootPath,
    settings,
    browserManager: manager,
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
    allowHttpLocalhost: true,
  })
  const context = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-acquisition',
    leaseId: 'lease-acquisition',
    sessionId: 'session-acquisition',
    runId: 'run-acquisition',
    assignmentId: 'runtime-assignment',
    activityScopeId: 'lane-acquisition',
    agentPath: 'agents/web-researcher',
  } as const
  const location = buildSessionRunAssignmentLocation(workspacePath, context)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })
  writeResearchAgent(repoRootPath)
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/static?report=redirected' })
      response.end()
      return
    }
    if (request.url === '/oversized') {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(10 * 1_024 * 1_024 + 1),
      })
      response.end()
      return
    }
    if (request.url === '/document.pdf') {
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="primary-report.pdf"',
      })
      response.end(
        fs.readFileSync(path.join(process.cwd(), 'file-parser', 'tests', 'fixtures', 'malformed-trailer.pdf')),
      )
      return
    }
    if (request.url?.startsWith('/static')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>Static primary report</title>
        <script type="application/ld+json">
          {"headline":"Static primary report","year":"2026","growth":12.5,"extra":"retained"}
        </script></head>
        <body><main><h1>Static primary report</h1><p>
        This primary report contains independently verified evidence for the current research
        question. The observation is deliberately long enough to pass the readable-content
        quality threshold without launching a browser. Query identity must remain preserved.
        </p><ul><li><a href="/details">Detailed evidence</a></li></ul>
        <table><tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Growth</td><td>12.5%</td></tr></table></main></body></html>`)
      return
    }
    if (request.url?.startsWith('/dynamic')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>Dynamic report</title></head><body>
        <div id="root"></div><script>
        document.getElementById('root').innerHTML =
          '<main><h1>Rendered primary evidence</h1><p>' +
          'This evidence exists only after JavaScript rendering and proves that managed Chrome ' +
          'is an acquisition fallback rather than the default transport. '.repeat(4) +
          '</p></main>';
        </script></body></html>`)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<html><title>Verify you are human</title><body>CAPTCHA complete the security check.</body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    const direct = await service.execute(
      context,
      'call-static',
      {
        action: 'acquire',
        url: `${baseUrl}/static?report=2026&utm_source=test#finding`,
      },
    )
    assert.equal(direct.ok, true, JSON.stringify(direct))
    assert.equal(direct.method, 'direct-http')
    assert.equal(direct.canonicalUrl, `${baseUrl}/static?report=2026`)
    assert.equal(direct.attempts?.length, 1)
    assert.equal((await manager.status()).status, 'stopped')
    assert.ok(direct.observationReceipt)
    const directReceipt = JSON.parse(
      fs.readFileSync(
        path.join(location.assignmentPath, direct.observationReceipt.relativePath),
        'utf8',
      ),
    ) as {
      method: string
      quality: string
      normalizedMediaType: string
      contentRelativePath: string
      qualityReport: { status: string }
      rawSource: { relativePath: string }
      representations: { relativePath: string }
    }
    assert.equal(directReceipt.method, 'direct-http')
    assert.equal(directReceipt.quality, 'usable')
    assert.equal(directReceipt.normalizedMediaType, 'text/markdown')
    assert.match(String(directReceipt.contentRelativePath), /^research\/acquisitions\//u)
    assert.equal(directReceipt.qualityReport.status, 'usable')
    assert.ok(directReceipt.rawSource)
    assert.ok(fs.existsSync(
      path.join(location.assignmentPath, directReceipt.rawSource.relativePath),
    ))
    const directMarkdown = fs.readFileSync(
      path.join(location.assignmentPath, String(directReceipt.contentRelativePath)),
      'utf8',
    )
    assert.match(directMarkdown, /- \[Detailed evidence\]\(http:\/\/127\.0\.0\.1:\d+\/details\)/u)
    assert.match(directMarkdown, /\| Metric \| Value \|/u)
    const representationManifest = JSON.parse(fs.readFileSync(
      path.join(
        location.assignmentPath,
        directReceipt.representations.relativePath,
      ),
      'utf8',
    )) as { representations: Array<{ kind: string }> }
    assert.ok(representationManifest.representations.some(
      (representation) => representation.kind === 'json-ld',
    ))

    const redirected = await service.execute(
      context,
      'call-redirect',
      { action: 'acquire', url: `${baseUrl}/redirect` },
    )
    assert.equal(redirected.ok, true, JSON.stringify(redirected))
    assert.equal(redirected.method, 'direct-http')
    assert.equal(redirected.finalUrl, `${baseUrl}/static?report=redirected`)

    const dynamic = await service.execute(
      context,
      'call-dynamic',
      { action: 'acquire', url: `${baseUrl}/dynamic` },
    )
    assert.equal(dynamic.ok, true, JSON.stringify(dynamic))
    assert.equal(dynamic.method, 'managed-browser')
    assert.deepEqual(
      dynamic.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'managed-browser'],
    )
    assert.match(dynamic.text ?? '', /Rendered primary evidence/)

    // The browser rung says which build produced the evidence, so a later
    // bake-off can compare like with like instead of guessing.
    const installedDriverVersion = (JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'node_modules', 'puppeteer-core', 'package.json'),
      'utf8',
    )) as { version: string }).version
    const browserAttempt = dynamic.attempts?.at(-1)
    assert.equal(browserAttempt?.method, 'managed-browser')
    assert.equal(browserAttempt?.browserRuntime?.driver, 'puppeteer-core')
    assert.equal(
      browserAttempt?.browserRuntime?.driverVersion,
      installedDriverVersion,
    )
    assert.match(
      String(browserAttempt?.browserRuntime?.browserVersion),
      /^(?:Headless)?Chrom(?:e|ium)\/\d+\./u,
    )
    assert.equal(browserAttempt?.browserRuntime?.mode, 'headless')
    assert.equal(
      browserAttempt?.browserRuntime?.launchProfile,
      'stock',
      'production keeps the stock launch profile',
    )
    assert.equal(
      browserAttempt?.proxyRuntime,
      undefined,
      'an unproxied read must not claim a proxy',
    )

    assert.ok(dynamic.observationReceipt)
    const dynamicReceipt = JSON.parse(fs.readFileSync(
      path.join(location.assignmentPath, dynamic.observationReceipt.relativePath),
      'utf8',
    )) as { schemaVersion: number; attempts: readonly Record<string, unknown>[] }
    assert.equal(dynamicReceipt.schemaVersion, SOURCE_OBSERVATION_RECEIPT_VERSION)
    assert.deepEqual(
      dynamicReceipt.attempts.at(-1)?.browserRuntime,
      browserAttempt?.browserRuntime,
    )

    const replaceable = await service.execute(
      context,
      'call-dynamic-replaceable',
      {
        action: 'acquire',
        url: `${baseUrl}/dynamic?candidate=replaceable`,
        sourceValue: 'replaceable',
      },
    )
    assert.equal(replaceable.ok, false)
    assert.deepEqual(
      replaceable.attempts?.map((attempt) => attempt.method),
      ['direct-http'],
    )

    const document = await service.execute(
      context,
      'call-document',
      { action: 'acquire', url: `${baseUrl}/document.pdf` },
    )
    assert.equal(document.ok, true, JSON.stringify(document))
    assert.equal(document.method, 'document-parser')
    assert.deepEqual(
      document.attempts?.map((attempt) => attempt.method),
      ['direct-http', 'document-parser'],
    )
    assert.match(document.text ?? '', /text-heavy|quarterly|report/iu)

    const oversized = await service.execute(
      context,
      'call-oversized',
      { action: 'acquire', url: `${baseUrl}/oversized` },
    )
    assert.equal(oversized.ok, false)
    assert.equal(oversized.error?.code, 'unsupported_content')
    assert.deepEqual(
      oversized.attempts?.map((attempt) => attempt.method),
      ['direct-http'],
    )

    const [parallelA, parallelB] = await Promise.all([
      service.execute(
        context,
        'call-parallel-a',
        { action: 'acquire', url: `${baseUrl}/static?parallel=a` },
      ),
      service.execute(
        context,
        'call-parallel-b',
        { action: 'acquire', url: `${baseUrl}/static?parallel=b` },
      ),
    ])
    assert.equal(parallelA.ok, true)
    assert.equal(parallelB.ok, true)
    const activity = await service.listSession(context.sessionId)
    assert.equal(activity.length, 8)
    assert.deepEqual(
      activity.slice(-2).map((entry) => entry.toolCallId).sort(),
      ['call-parallel-a', 'call-parallel-b'],
    )

    const extraction = await service.execute(
      context,
      'call-extract',
      {
        action: 'extract',
        contentId: direct.observationReceipt.receiptId,
        schema: {
          type: 'object',
          properties: {
            headline: { type: 'string' },
            year: { type: 'integer' },
            growth: { type: 'number' },
            unavailable: { type: 'string' },
          },
        },
        requiredFields: ['headline', 'year', 'unavailable'],
      },
    )
    assert.equal(extraction.ok, true, JSON.stringify(extraction))
    assert.deepEqual(extraction.extraction?.data, {
      headline: 'Static primary report',
      year: 2026,
      growth: 12.5,
    })
    assert.equal(extraction.extraction?.complete, false)
    assert.equal(extraction.extraction?.requirementsMet, false)
    assert.equal(
      extraction.extraction?.fields.find(
        (field) => field.path === 'unavailable',
      )?.status,
      'unsupported',
    )
    assert.deepEqual(extraction.extraction?.methodsAttempted, ['deterministic'])
    assert.ok(fs.existsSync(path.join(
      location.assignmentPath,
      extraction.extraction!.resultRelativePath,
    )))

    const secondExtraction = await service.execute(
      context,
      'call-extract-second-schema',
      {
        action: 'extract',
        contentId: direct.observationReceipt.receiptId,
        schema: {
          type: 'object',
          properties: { headline: { type: 'string' } },
        },
      },
    )
    assert.equal(secondExtraction.ok, true)
    assert.deepEqual(secondExtraction.extraction?.data, {
      headline: 'Static primary report',
    })
    assert.notEqual(
      secondExtraction.extraction?.extractionId,
      extraction.extraction?.extractionId,
    )
    const extractionActivity = (await service.listSession(context.sessionId))
      .find((entry) => entry.toolCallId === 'call-extract')
    assert.equal(extractionActivity?.extraction?.fieldCount, 4)
    assert.equal(extractionActivity?.extraction?.statusCounts.present, 3)
    assert.equal(extractionActivity?.extraction?.statusCounts.unsupported, 1)
    assert.equal(
      'data' in (extractionActivity?.extraction ?? {}),
      false,
    )

    fs.appendFileSync(
      path.join(location.assignmentPath, directReceipt.rawSource.relativePath),
      '<!-- tampered -->',
    )
    const tamperedExtraction = await service.execute(
      context,
      'call-extract-tampered',
      {
        action: 'extract',
        contentId: direct.observationReceipt.receiptId,
        schema: {
          type: 'object',
          properties: { headline: { type: 'string' } },
        },
      },
    )
    assert.equal(tamperedExtraction.ok, false)
    assert.equal(tamperedExtraction.error?.code, 'source_integrity')

    const challenge = await service.execute(
      context,
      'call-challenge',
      { action: 'acquire', url: `${baseUrl}/challenge` },
    )
    assert.equal(challenge.ok, false)
    assert.equal(challenge.error?.code, 'access_challenge')
    assert.deepEqual(
      challenge.attempts?.map((attempt) => attempt.method),
      ['direct-http'],
    )

    const acquisitionEvents = fs.readFileSync(
      path.join(location.assignmentPath, 'logs', 'engine-events.jsonl'),
      'utf8',
    ).trim().split('\n')
      .map((line) => JSON.parse(line) as {
        type: string
        root_run_id?: string
        payload: Record<string, unknown>
      })
      .filter((event) => event.type === 'research.acquisition.completed')
    const eventFor = (toolCallId: string) =>
      acquisitionEvents.find(
        (event) => event.payload.tool_call_id === toolCallId,
      )

    assert.equal(eventFor('call-dynamic')?.payload.issue_kind, 'recovered')
    assert.equal(eventFor('call-dynamic')?.payload.usable, true)
    assert.equal(eventFor('call-document')?.payload.issue_kind, 'none')
    assert.equal(eventFor('call-oversized')?.payload.issue_kind, 'limited')
    assert.equal(eventFor('call-challenge')?.payload.issue_kind, 'blocked')
    assert.equal(eventFor('call-challenge')?.root_run_id, context.runId)
    assert.match(
      String(eventFor('call-challenge')?.payload.source_key),
      /^[a-f0-9]{64}$/u,
    )
    assert.doesNotMatch(JSON.stringify(acquisitionEvents), /127\.0\.0\.1/u)
  } finally {
    await manager.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function writeResearchAgent(repoRootPath: string): void {
  const agentDirectory = path.join(repoRootPath, 'agents', 'web-researcher')
  fs.mkdirSync(agentDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(agentDirectory, 'web-researcher.md'),
    [
      '---',
      'name: web-researcher',
      'tools: read, research_web, browser',
      '---',
      '',
      '# Web Researcher',
      '',
    ].join('\n'),
  )
}

/**
 * The research lane's half of the challenge-retry policy.
 *
 * It lives beside the acquisition journey rather than in the Webshare suites
 * because the rule under test is lane suppression, which no proxy takes part
 * in: with no proxy port configured the ladder ends at the direct rung, so the
 * journey stays deterministic and never launches Chrome.
 */
test('a research-lane challenge leaves the host reachable while a denial still suppresses it', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'research-web-challenge-policy-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const settings = new AcquisitionSettingsService({ environment: {} })
  const service = new ResearchWebToolService({
    workspacePath,
    repoRootPath,
    settings,
    allowHttpLocalhost: true,
  })
  const context = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-challenge-policy',
    leaseId: 'lease-challenge-policy',
    sessionId: 'session-challenge-policy',
    runId: 'run-challenge-policy',
    assignmentId: 'runtime-assignment',
    activityScopeId: 'lane-challenge-policy',
    agentPath: 'agents/web-researcher',
  } as const
  const location = buildSessionRunAssignmentLocation(workspacePath, context)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })
  writeResearchAgent(repoRootPath)

  const requested: string[] = []
  const server = createServer((request, response) => {
    requested.push(String(request.url))
    if (request.url === '/challenge') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><title>Checking your browser</title><body>Attention required! Cloudflare. Checking your browser before accessing the site.</body></html>')
      return
    }
    if (request.url === '/denied') {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><title>Denied</title><body>Access denied.</body></html>')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>Reachable report</title></head><body><main>
      <h1>Reachable report</h1><p>
      This later page on the same host carries enough independently readable evidence to
      pass the acquisition quality threshold, which is what proves the lane still let the
      request through instead of answering from a stored host ban. ${'Evidence sentence for the reachable page. '.repeat(6)}
      </p></main></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    const challenged = await service.execute(context, 'call-challenged', {
      action: 'acquire',
      url: `${baseUrl}/challenge`,
    })
    assert.equal(challenged.ok, false)
    assert.equal(challenged.error?.code, 'access_challenge')

    const afterChallenge = await service.execute(context, 'call-after-challenge', {
      action: 'acquire',
      url: `${baseUrl}/reachable`,
    })
    assert.equal(
      afterChallenge.ok,
      true,
      `a challenge must not suppress the host: ${JSON.stringify(afterChallenge)}`,
    )
    assert.ok(
      requested.includes('/reachable'),
      'the second call must reach acquisition rather than a stored lane ban',
    )

    const denied = await service.execute(context, 'call-denied', {
      action: 'acquire',
      url: `${baseUrl}/denied`,
    })
    assert.equal(denied.ok, false)
    assert.equal(denied.error?.code, 'access_denied')

    const afterDenial = await service.execute(context, 'call-after-denial', {
      action: 'acquire',
      url: `${baseUrl}/reachable-after-denial`,
    })
    assert.equal(afterDenial.ok, false, JSON.stringify(afterDenial))
    assert.equal(
      afterDenial.error?.code,
      'access_denied',
      'the lane ban names the denial that caused it, not a challenge',
    )
    assert.equal(
      requested.includes('/reachable-after-denial'),
      false,
      'a denial keeps suppressing the host for the rest of the lane',
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The wall each recorded challenge actually met.
 *
 * Every page is served over loopback and read by the direct rung alone, so the
 * subtype the attempt carries is the one the classifier produced for that exact
 * page. Each page is also checked for the thing that matters more than the
 * label: none of them becomes an observation receipt.
 */
const CHALLENGE_SUBTYPE_ROUTES = [
  {
    path: '/wall-captcha',
    subtype: 'captcha',
    title: 'Verification required',
    body: 'Please complete the reCAPTCHA below to confirm you are human before we can show this page.',
  },
  {
    path: '/wall-browser',
    subtype: 'browser-verification',
    title: 'Just a moment...',
    body: 'Checking your browser before accessing the site. This process is automatic and will finish shortly.',
  },
  {
    path: '/wall-consent',
    subtype: 'consent-wall',
    title: 'Before you continue to YouTube',
    body: 'We use cookies and data to deliver services. Review your cookie choices to carry on.',
  },
  {
    path: '/wall-login',
    subtype: 'login-wall',
    title: 'Members only',
    body: 'Sign in to continue reading this article. Subscribers get unlimited access to every report.',
  },
  {
    path: '/wall-unnamed',
    subtype: 'unknown',
    title: 'Sorry',
    body: 'Our systems have detected unusual traffic from your computer network and cannot serve this page.',
  },
] as const

test('each recorded challenge names its wall and none of them becomes evidence', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'research-web-challenge-subtype-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const settings = new AcquisitionSettingsService({ environment: {} })
  const service = new ResearchWebToolService({
    workspacePath,
    repoRootPath,
    settings,
    allowHttpLocalhost: true,
  })
  const context = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-challenge-subtype',
    leaseId: 'lease-challenge-subtype',
    sessionId: 'session-challenge-subtype',
    runId: 'run-challenge-subtype',
    assignmentId: 'runtime-assignment',
    activityScopeId: 'lane-challenge-subtype',
    agentPath: 'agents/web-researcher',
  } as const
  const location = buildSessionRunAssignmentLocation(workspacePath, context)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })
  writeResearchAgent(repoRootPath)

  const server = createServer((request, response) => {
    const route = CHALLENGE_SUBTYPE_ROUTES.find(
      (candidate) => candidate.path === request.url,
    )
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      route
        ? `<!doctype html><html><head><title>${route.title}</title></head><body><main><p>${route.body}</p></main></body></html>`
        : '<html><body>not a wall</body></html>',
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    for (const route of CHALLENGE_SUBTYPE_ROUTES) {
      const result = await service.execute(context, `call${route.path}`, {
        action: 'acquire',
        url: `${baseUrl}${route.path}`,
      })

      assert.equal(result.ok, false, JSON.stringify(result))
      assert.equal(result.error?.code, 'access_challenge', route.path)
      assert.equal(
        result.observationReceipt,
        undefined,
        `${route.path} must not produce citable evidence`,
      )
      const attempt = result.attempts?.at(-1)
      assert.equal(attempt?.method, 'direct-http', route.path)
      assert.equal(attempt?.outcome, 'challenge', route.path)
      assert.equal(attempt?.challengeType, route.subtype, route.path)
    }

    // The journal an operator reads carries the same subtype the caller saw.
    const journalled = (await service.listSession(context.sessionId)).map(
      (activity) => activity.attempts.at(-1)?.challengeType,
    )
    assert.deepEqual(
      journalled,
      CHALLENGE_SUBTYPE_ROUTES.map((route) => route.subtype),
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
