import { whenDefined } from '../../core/optional-properties.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  BrowserManager,
  BrowserRuntimeError,
  type BrowserExecutionScope,
} from '../../domains/browser/browser-manager.js'
import { BrowserNetworkPolicy } from '../../domains/browser/browser-network-policy.js'
import { McpApprovalCoordinator } from '../../domains/mcp/mcp-approval-coordinator.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { BrowserToolService } from '../../services/browser-tool-service.js'
import { CapabilityApprovalCoordinatorPort } from '../../services/capability-dispatch-runtime.js'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import {
  browserCapabilityTestInvocation,
  createBrowserCapabilityTestInvoker,
} from '../support/browser-capability-fixture.js'

test('managed Chrome preserves authentication while isolating assignment pages and artifacts', { timeout: 90_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-manager-live-')))
  const server = createBrowserFixtureServer()
  const baseUrl = await listen(server)
  const manager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    mode: 'headless',
    allowHttpLocalhost: true,
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
    networkPolicy: new BrowserNetworkPolicy({
      allowHttpLocalhost: true,
      lookup: (async () => [{ address: '10.0.0.8', family: 4 }]) as never,
    }),
  })
  const scopeA = makeScope(root, 'assignment-a')
  const scopeB = makeScope(root, 'assignment-b')
  fs.mkdirSync(scopeA.assignmentPath, { recursive: true })
  fs.mkdirSync(scopeB.assignmentPath, { recursive: true })

  try {
    if ((await manager.status()).status === 'unavailable') {
      t.skip('A supported local Chrome installation is required for this integration test.')
      return
    }

    for (const [fixturePath, expectedCode, expectedChallengeType] of [
      ['/captcha', 'access_challenge', 'captcha'],
      ['/verify-device', 'access_challenge', 'browser-verification'],
      ['/forbidden', 'access_denied', undefined],
      ['/rate-limited', 'rate_limited', undefined],
      ['/missing', 'not_found', undefined],
      ['/empty', 'empty_content', undefined],
    ] as const) {
      await assert.rejects(
        manager.execute(scopeA, { action: 'open', url: `${baseUrl}${fixturePath}` }),
        (error: unknown) =>
          error instanceof BrowserRuntimeError &&
          error.code === expectedCode &&
          error.challengeType === expectedChallengeType,
        `${fixturePath} should fail as ${expectedCode}`,
      )
    }

    const trackerBlocked = await manager.execute(scopeA, {
      action: 'open',
      url: `${baseUrl}/blocked-subresource`,
    })
    assert.match(trackerBlocked.text ?? '', /Usable page despite a blocked tracker/)

    const openedA = await manager.execute(scopeA, { action: 'open', url: `${baseUrl}/home?access_token=url-secret#private` })
    const openedB = await manager.execute(scopeB, { action: 'open', url: `${baseUrl}/home` })
    assert.ok(openedA.pageId)
    assert.ok(openedB.pageId)
    assert.notEqual(openedA.pageId, openedB.pageId)
    await assert.rejects(
      manager.execute(scopeB, { action: 'observe', pageId: openedA.pageId }),
      (error: unknown) => error instanceof BrowserRuntimeError && error.code === 'page_not_found',
    )

    const laneA = makeScope(root, 'assignment-lanes', 'lane-a')
    const laneB = makeScope(root, 'assignment-lanes', 'lane-b')
    fs.mkdirSync(laneA.assignmentPath, { recursive: true })
    const [openedLaneA, openedLaneB] = await Promise.all([
      manager.execute(laneA, { action: 'open', url: `${baseUrl}/home` }),
      manager.execute(laneB, { action: 'open', url: `${baseUrl}/details` }),
    ])
    assert.ok(openedLaneA.pageId)
    assert.ok(openedLaneB.pageId)
    await manager.closeAssignment(laneA)
    await assert.rejects(
      manager.execute(laneA, { action: 'observe', pageId: openedLaneA.pageId }),
      (error: unknown) =>
        error instanceof BrowserRuntimeError && error.code === 'page_not_found',
    )
    const retainedLane = await manager.execute(laneB, {
      action: 'observe',
      pageId: openedLaneB.pageId,
    })
    assert.match(retainedLane.text ?? '', /Deep research details/)
    await manager.closeAssignment(laneB)

    let observed = await manager.execute(scopeA, { action: 'observe', pageId: openedA.pageId })
    assert.match(observed.text ?? '', /Browser fixture/)
    assert.ok(observed.snapshotId)
    assert.ok(observed.content)
    assert.ok(observed.blocks?.some((block) => block.type === 'heading'))
    assert.ok(observed.frames?.some((frame) => frame.frameId !== 'f0' && frame.allowed))
    assert.equal(observed.visual?.recommended, true)
    assert.doesNotMatch(JSON.stringify(observed), /profile-password-secret/)
    assert.doesNotMatch(JSON.stringify(observed), /url-secret|url-link-secret/)
    const username = observed.elements?.find((element) => element.name === 'Research topic')
    const shadowAction = observed.elements?.find((element) => element.name === 'Shadow action')
    const frameAction = observed.elements?.find((element) => element.name === 'Frame action')
    assert.ok(username?.ref)
    assert.ok(shadowAction?.ref)
    assert.ok(frameAction?.ref)

    const contentSearch = await manager.execute(scopeA, {
      action: 'search_content',
      contentId: observed.content.id,
      query: 'Browser fixture',
    })
    assert.ok(contentSearch.matches?.length)
    const contentRead = await manager.execute(scopeA, {
      action: 'read_content',
      contentId: observed.content.id,
      chunkIndex: contentSearch.matches?.[0]?.chunkIndex ?? 0,
    })
    assert.match(contentRead.text ?? '', /Browser fixture/)
    const scrolled = await manager.execute(scopeA, {
      action: 'scroll',
      pageId: openedA.pageId,
      direction: 'bottom',
    })
    assert.ok(scrolled.snapshotId)
    const scrolledUsername = scrolled.elements?.find((element) => element.name === 'Research topic')
    assert.ok(scrolledUsername?.ref)

    const reactPage = await manager.execute(scopeA, { action: 'open', url: `${baseUrl}/react` })
    assert.ok(reactPage.pageId)
    assert.ok(reactPage.snapshotId)
    const reactReady = await manager.execute(scopeA, {
      action: 'wait',
      pageId: reactPage.pageId,
      waitFor: 'change',
      snapshotId: reactPage.snapshotId,
      timeoutMs: 3_000,
    })
    assert.match(reactReady.text ?? '', /React research result: orbital market evidence/)
    const virtualPage = await manager.execute(scopeA, { action: 'open', url: `${baseUrl}/virtual` })
    assert.ok(virtualPage.pageId)
    const virtualScrolled = await manager.execute(scopeA, {
      action: 'scroll',
      pageId: virtualPage.pageId,
      direction: 'bottom',
    })
    assert.match(virtualScrolled.text ?? '', /Virtual item 2 loaded/)

    const typed = await manager.execute(scopeA, {
      action: 'type',
      pageId: openedA.pageId,
      ref: scrolledUsername.ref,
      text: 'market structure',
    })
    await assert.rejects(
      manager.execute(scopeA, {
        action: 'type',
        pageId: openedA.pageId,
        ref: username.ref,
        text: 'stale reference',
      }),
      (error: unknown) => error instanceof BrowserRuntimeError && error.code === 'element_not_found',
    )
    const password = typed.elements?.find((element) => element.name === 'Account password')
    const details = typed.elements?.find((element) => element.name === 'Details')
    const download = typed.elements?.find((element) => element.name === 'Download report')
    assert.ok(password?.ref)
    assert.ok(details?.ref)
    assert.ok(download?.ref)
    await assert.rejects(
      manager.execute(scopeA, {
        action: 'type',
        pageId: openedA.pageId,
        ref: password.ref,
        text: 'do-not-type-this',
      }),
      (error: unknown) => error instanceof BrowserRuntimeError && error.code === 'sensitive_input_blocked',
    )
    const screenshot = await manager.execute(scopeA, { action: 'screenshot', pageId: openedA.pageId })
    assert.ok(screenshot.attachment)
    assert.equal(screenshot.attachment.kind, 'screenshot')
    assert.equal(fs.existsSync(path.join(scopeA.assignmentPath, screenshot.attachment.relativePath)), true)

    const downloaded = await manager.execute(scopeA, {
      action: 'download',
      pageId: openedA.pageId,
      ref: download.ref,
      timeoutMs: 10_000,
    })
    assert.ok(downloaded.attachment)
    assert.equal(downloaded.attachment.kind, 'download')
    assert.equal(
      fs.readFileSync(path.join(scopeA.assignmentPath, downloaded.attachment.relativePath), 'utf8'),
      'real browser download\n',
    )
    assert.ok(downloaded.content)
    const parsedDownload = await manager.execute(scopeA, {
      action: 'read_content',
      contentId: downloaded.content.id,
      chunkIndex: 0,
    })
    assert.match(parsedDownload.text ?? '', /real browser download/)

    observed = await manager.execute(scopeA, { action: 'click', pageId: openedA.pageId, ref: details.ref })
    assert.equal(observed.url, `${baseUrl}/details`)
    assert.match(observed.text ?? '', /Deep research details/)

    await assert.rejects(
      manager.execute(scopeA, { action: 'navigate', pageId: openedA.pageId, url: 'https://example.com/' }),
      (error: unknown) => error instanceof BrowserRuntimeError && error.code === 'domain_denied',
    )
    await manager.execute(scopeA, { action: 'go_back', pageId: openedA.pageId })
    const homeAgain = await manager.execute(scopeA, { action: 'observe', pageId: openedA.pageId })
    const blockedAgain = homeAgain.elements?.find((element) => element.name === 'Blocked redirect')
    assert.ok(blockedAgain?.ref)
    await assert.rejects(
      manager.execute(scopeA, {
        action: 'click',
        pageId: openedA.pageId,
        ref: blockedAgain.ref,
      }),
      (error: unknown) => error instanceof BrowserRuntimeError && error.code === 'domain_denied',
    )

    const publicA = makePublicScope(root, 'assignment-public-a')
    const publicB = makePublicScope(root, 'assignment-public-b')
    fs.mkdirSync(publicA.assignmentPath, { recursive: true })
    fs.mkdirSync(publicB.assignmentPath, { recursive: true })
    await manager.execute(publicA, { action: 'open', url: `${baseUrl}/login` })
    const publicAuthenticated = await manager.execute(publicA, { action: 'open', url: `${baseUrl}/private` })
    assert.match(publicAuthenticated.text ?? '', /Authenticated research workspace/)
    const otherPublic = await manager.execute(publicB, { action: 'open', url: `${baseUrl}/private` })
    assert.match(otherPublic.text ?? '', /Authentication required/)
    await manager.closeAssignment(publicA)

    await manager.execute(scopeA, { action: 'open', url: `${baseUrl}/login` })
    await manager.stop()
    const authenticated = await manager.execute(scopeA, { action: 'open', url: `${baseUrl}/private` })
    const authenticatedView = await manager.execute(scopeA, {
      action: 'observe',
      ...whenDefined(authenticated.pageId, (pageId) => ({ pageId: pageId })),
    })
    assert.match(authenticatedView.text ?? '', /Authenticated research workspace/)

    const workspacePath = path.join(root, 'workspace')
    const repoRootPath = path.join(root, 'repo')
    const context: McpBrokerRequestContext & {
      readonly activityScopeId: string
    } = {
      contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
      requestId: 'request-browser-approval',
      leaseId: 'lease-browser-approval',
      sessionId: 'session-service',
      runId: 'run-service',
      assignmentId: 'assignment-service',
      activityScopeId: 'lane-service',
      agentPath: 'agents/researcher',
    }
    const location = buildSessionRunAssignmentLocation(workspacePath, context)
    assert.ok(location)
    fs.mkdirSync(location.assignmentPath, { recursive: true })
    fs.mkdirSync(path.join(repoRootPath, 'agents', 'researcher'), { recursive: true })
    fs.writeFileSync(path.join(repoRootPath, 'agents', 'researcher', 'researcher.md'), [
      '---',
      'name: researcher',
      'tools: browser',
      'browser_restrict_domains: true',
      'browser_domains: 127.0.0.1, localhost',
      '---',
      '',
      '# Researcher',
    ].join('\n'))
    fs.mkdirSync(path.join(repoRootPath, 'agents', 'web-researcher'), { recursive: true })
    fs.writeFileSync(path.join(repoRootPath, 'agents', 'web-researcher', 'web-researcher.md'), [
      '---',
      'name: web-researcher',
      'tools: browser',
      'browser_restrict_domains: true',
      'browser_domains: 127.0.0.1, localhost',
      '---',
      '',
      '# Web Researcher',
    ].join('\n'))
    const coordinator = new McpApprovalCoordinator({
      workspacePath,
      pollIntervalMs: 5,
      waitTimeoutMs: 5_000,
    })
    const browserService = new BrowserToolService({
      workspacePath,
      repoRootPath,
      manager,
    })
    const browserInvoker = createBrowserCapabilityTestInvoker(browserService, {
      approval: new CapabilityApprovalCoordinatorPort(coordinator),
    })
    const unattendedContext = {
      ...context,
      requestId: 'request-browser-unattended',
      leaseId: 'lease-browser-unattended',
      activityScopeId: 'lane-unattended',
      agentPath: 'agents/web-researcher',
    }
    const unattendedOpen = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        unattendedContext,
        'call-unattended-open',
        { action: 'open', url: `${baseUrl}/home` },
      ),
    )
    assert.equal(unattendedOpen.ok, true, JSON.stringify(unattendedOpen))
    assert.ok(unattendedOpen.pageId)
    const unattendedDownload = unattendedOpen.elements
      ?.find((element) => element.name === 'Download report')
    assert.ok(unattendedDownload?.ref)
    const approvalsBeforeUnattendedDownload = (await coordinator.list(context)).length
    const deniedDownload = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        unattendedContext,
        'call-unattended-download',
        {
          action: 'download',
          pageId: unattendedOpen.pageId,
          ref: unattendedDownload.ref,
          timeoutMs: 10_000,
        },
      ),
    )
    assert.equal(deniedDownload.ok, false)
    assert.equal(deniedDownload.error?.code, 'approval_denied')
    assert.match(deniedDownload.error?.message ?? '', /Unattended Deep Research lanes/)
    assert.equal((await coordinator.list(context)).length, approvalsBeforeUnattendedDownload)
    assert.equal(
      (await browserService.listSession(context.sessionId))
        .find((activity) => activity.toolCallId === 'call-unattended-download')
        ?.state,
      'denied',
    )
    const serviceOpen = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        context,
        'call-open',
        { action: 'open', url: `${baseUrl}/home?source=primary#evidence` },
      ),
    )
    assert.equal(serviceOpen.ok, true, JSON.stringify(serviceOpen))
    assert.ok(serviceOpen.pageId)
    assert.ok(serviceOpen.observationReceipt)
    const receiptPath = path.join(
      location.assignmentPath,
      serviceOpen.observationReceipt.relativePath,
    )
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
      receiptId: string
      activityId: string
      sessionId: string
      runId: string
      assignmentId: string
      activityScopeId: string
      agentPath: string
      method: string
      requestedUrl: string
      finalUrl: string
      canonicalUrl: string
      mediaType: string
      observedAt: string
      contentRelativePath: string
      contentSha256: string
      contentBytes: number
    }
    const receiptContent = fs.readFileSync(
      path.join(location.assignmentPath, receipt.contentRelativePath),
    )
    assert.equal(receipt.receiptId, serviceOpen.observationReceipt.receiptId)
    assert.equal(receipt.receiptId, receipt.activityId)
    assert.equal(receipt.sessionId, context.sessionId)
    assert.equal(receipt.runId, context.runId)
    assert.equal(receipt.assignmentId, context.assignmentId)
    assert.equal(receipt.activityScopeId, context.activityScopeId)
    assert.equal(receipt.agentPath, context.agentPath)
    assert.equal(receipt.method, 'managed-browser')
    assert.equal(receipt.requestedUrl, `${baseUrl}/home?source=primary`)
    assert.equal(receipt.finalUrl, `${baseUrl}/home`)
    assert.equal(receipt.canonicalUrl, `${baseUrl}/home`)
    assert.equal(receipt.mediaType, 'text/html')
    assert.equal(
      serviceOpen.observationReceipt.canonicalUrl,
      `${baseUrl}/home`,
    )
    assert.equal(serviceOpen.url, `${baseUrl}/home`)
    assert.equal(Number.isNaN(Date.parse(receipt.observedAt)), false)
    assert.equal(receipt.contentBytes, receiptContent.byteLength)
    assert.equal(
      receipt.contentSha256,
      createHash('sha256').update(receiptContent).digest('hex'),
    )
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600)
    }
    const receiptArtifactEvent = fs.readFileSync(
      path.join(location.assignmentPath, 'logs', 'engine-events.jsonl'),
      'utf8',
    ).trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => (
        event.type === 'artifact.written' &&
        (event.payload as Record<string, unknown>).path === serviceOpen.observationReceipt?.relativePath
      ))
    assert.ok(receiptArtifactEvent)
    assert.equal(receiptArtifactEvent.run_id, context.assignmentId)
    assert.equal(receiptArtifactEvent.root_run_id, context.runId)
    assert.equal(
      (receiptArtifactEvent.payload as Record<string, unknown>).artifact_type,
      'observation-receipt',
    )
    const servicePageId = serviceOpen.pageId
    const serviceView = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        context,
        'call-observe-before-submit',
        { action: 'observe', pageId: servicePageId },
      ),
    )
    const beforeWaitSnapshot = serviceView.snapshotId
    assert.ok(beforeWaitSnapshot)
    const waited = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        context,
        'call-wait',
        {
          action: 'wait',
          pageId: servicePageId,
          waitFor: 'element',
          query: 'Submit research',
          timeoutMs: 2_000,
        },
      ),
    )
    assert.equal(waited.ok, true)
    const submit = waited.elements?.find((element) => element.name === 'Submit research')
    assert.ok(submit?.ref)
    assert.deepEqual(
      await manager.describeTarget(
        {
          sessionId: context.sessionId,
          runId: context.runId,
          assignmentId: context.assignmentId,
          activityScopeId: context.activityScopeId,
          assignmentPath: location.assignmentPath,
          policy: { enabled: true, restrictDomains: true, domains: ['127.0.0.1'] },
        },
        { action: 'click', pageId: servicePageId, ref: submit.ref },
      ),
      {
        tag: 'button',
        name: 'Submit research',
      },
    )

    const submitting = browserInvoker.execute(
      browserCapabilityTestInvocation(
        context,
        'call-submit',
        { action: 'click', pageId: servicePageId, ref: submit.ref },
      ),
    )
    const pending = await waitForApproval(coordinator, context, 'call-submit')
    assert.equal(pending.serverId, 'builtin.browser')
    assert.equal(pending.namespacedToolName, 'mcp__builtin-browser__click')
    assert.deepEqual(pending.argumentNames, ['action', 'pageId', 'ref'])
    assert.doesNotMatch(JSON.stringify(pending), /Submit research/)
    assert.equal(
      (await browserService.listSession(context.sessionId)).find((activity) => activity.toolCallId === 'call-submit')?.state,
      'awaiting-approval',
    )
    await coordinator.respond(context, {
      interactionId: pending.interactionId,
      responseId: 'response-submit-once',
      decision: 'approve',
      scope: 'once',
    })
    const submitted = await submitting
    assert.equal(submitted.ok, true)
    assert.ok(submitted.snapshotId)
    const submittedView = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        context,
        'call-wait-after-submit',
        {
          action: 'wait',
          pageId: servicePageId,
          waitFor: 'text',
          query: 'Research submitted',
          timeoutMs: 3_000,
        },
      ),
    )
    assert.match(submittedView.text ?? '', /Research submitted/)
    assert.equal(
      (await browserService.listSession(context.sessionId)).find((activity) => activity.toolCallId === 'call-submit')?.state,
      'completed',
    )
    assert.equal(
      (await browserService.listSession(context.sessionId))
        .find((activity) => activity.toolCallId === 'call-open')
        ?.observationReceipt?.receiptId,
      receipt.receiptId,
    )

    const challenged = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        context,
        'call-challenge',
        { action: 'open', url: `${baseUrl}/captcha` },
      ),
    )
    assert.equal(challenged.error?.code, 'access_challenge')
    // A challenge is not the source refusing this caller, so the host stays
    // open to an explicit later call. Only the page itself was unusable.
    const afterChallenge = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        context,
        'call-challenge-repeat',
        { action: 'open', url: `${baseUrl}/home` },
      ),
    )
    assert.equal(afterChallenge.ok, true, JSON.stringify(afterChallenge))

    // A 403 still closes the host for the rest of the lane.
    const denied = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        context,
        'call-forbidden',
        { action: 'open', url: `${baseUrl}/forbidden` },
      ),
    )
    assert.equal(denied.error?.code, 'access_denied')
    const suppressed = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        context,
        'call-forbidden-repeat',
        { action: 'open', url: `${baseUrl}/home` },
      ),
    )
    assert.equal(suppressed.error?.code, 'source_blocked')
    const alternateSource = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        context,
        'call-alternate-source',
        { action: 'open', url: `${baseUrl.replace('127.0.0.1', 'localhost')}/home` },
      ),
    )
    assert.equal(alternateSource.ok, true, JSON.stringify(alternateSource))
    const siblingContext = {
      ...context,
      requestId: 'request-browser-sibling',
      activityScopeId: 'lane-service-sibling',
    }
    const siblingOpen = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        siblingContext,
        'call-sibling-open',
        { action: 'open', url: `${baseUrl}/home` },
      ),
    )
    assert.equal(siblingOpen.ok, true, JSON.stringify(siblingOpen))
    assert.ok(siblingOpen.pageId)
    await browserService.releaseAssignment(context)
    const siblingRetained = await browserInvoker.execute(
      browserCapabilityTestInvocation(
        siblingContext,
        'call-sibling-observe',
        { action: 'observe', pageId: siblingOpen.pageId },
      ),
    )
    assert.equal(siblingRetained.ok, true, JSON.stringify(siblingRetained))
    await browserService.releaseAssignment(siblingContext)

    const restartedBrowserService = new BrowserToolService({
      workspacePath,
      repoRootPath,
      manager,
    })
    const persistedActivities = await restartedBrowserService.listSession(context.sessionId)
    assert.equal(
      persistedActivities.find((activity) => activity.toolCallId === 'call-challenge')?.error?.code,
      'access_challenge',
    )
    assert.equal(
      persistedActivities.find((activity) => activity.toolCallId === 'call-challenge-repeat')?.state,
      'completed',
    )
    assert.equal(
      persistedActivities.find((activity) => activity.toolCallId === 'call-forbidden-repeat')?.error?.code,
      'source_blocked',
    )
    assert.deepEqual(
      persistedActivities.map((activity) => activity.createdAt),
      [...persistedActivities].map((activity) => activity.createdAt).sort(),
    )
  } finally {
    await manager.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('managed Chrome recognizes site-neutral human verification without changing plain 403 handling', { timeout: 30_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-manager-challenge-')))
  const server = createBrowserFixtureServer()
  const baseUrl = await listen(server)
  const manager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    mode: 'headless',
    allowHttpLocalhost: true,
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
    networkPolicy: new BrowserNetworkPolicy({
      allowHttpLocalhost: true,
      lookup: (async () => [{ address: '10.0.0.8', family: 4 }]) as never,
    }),
  })
  const scope = makeScope(root, 'assignment-challenge-recognition')
  fs.mkdirSync(scope.assignmentPath, { recursive: true })

  try {
    if ((await manager.status()).status === 'unavailable') {
      t.skip('A supported local Chrome installation is required for this integration test.')
      return
    }

    for (const [fixturePath, expectedCode, expectedChallengeType] of [
      ['/interactive-verification', 'access_challenge', 'captcha'],
      ['/forbidden', 'access_denied', undefined],
    ] as const) {
      await assert.rejects(
        manager.execute(scope, { action: 'open', url: `${baseUrl}${fixturePath}` }),
        (error: unknown) =>
          error instanceof BrowserRuntimeError &&
          error.code === expectedCode &&
          error.challengeType === expectedChallengeType,
        `${fixturePath} should fail as ${expectedCode}`,
      )
    }
  } finally {
    await manager.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent evidence acquisitions in one assignment scope share a single browser context', { timeout: 90_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-manager-live-concurrent-')))
  const server = createBrowserFixtureServer()
  const baseUrl = await listen(server)
  const manager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    mode: 'headless',
    allowHttpLocalhost: true,
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
    networkPolicy: new BrowserNetworkPolicy({
      allowHttpLocalhost: true,
      lookup: (async () => [{ address: '10.0.0.8', family: 4 }]) as never,
    }),
  })
  const scope = makePublicScope(root, 'assignment-concurrent')
  fs.mkdirSync(scope.assignmentPath, { recursive: true })

  try {
    if ((await manager.status()).status === 'unavailable') {
      t.skip('A supported local Chrome installation is required for this integration test.')
      return
    }

    const [first, second] = await Promise.all([
      manager.acquireEvidence(scope, `${baseUrl}/home`),
      manager.acquireEvidence(scope, `${baseUrl}/details`),
    ])
    assert.match(first.text ?? '', /Browser fixture/)
    assert.match(second.text ?? '', /Deep research details/)

    const browser = (manager as unknown as {
      browser?: { browserContexts(): readonly unknown[] } | null
    }).browser
    assert.ok(browser, 'the manager must hold a live browser after acquisitions')
    // The default context plus exactly one isolated context for this
    // assignment scope. Before the in-flight-creation join, the concurrent
    // opens both created a context (default + 2) and the loser leaked
    // untracked until browser disconnect.
    assert.equal(
      browser.browserContexts().length,
      2,
      'expected one shared isolated context for the assignment scope',
    )

    const otherScope = makePublicScope(root, 'assignment-concurrent-other')
    fs.mkdirSync(otherScope.assignmentPath, { recursive: true })
    await manager.acquireEvidence(otherScope, `${baseUrl}/home`)
    assert.equal(
      browser.browserContexts().length,
      3,
      'a distinct assignment scope must still receive its own isolated context',
    )
  } finally {
    await manager.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function makeScope(
  root: string,
  assignmentId: string,
  activityScopeId?: string,
): BrowserExecutionScope {
  return {
    sessionId: 'session-browser',
    runId: 'run-browser',
    assignmentId,
    ...(activityScopeId ? { activityScopeId } : {}),
    assignmentPath: path.join(root, assignmentId),
    policy: { enabled: true, restrictDomains: true, domains: ['127.0.0.1'] },
  }
}

function makePublicScope(root: string, assignmentId: string): BrowserExecutionScope {
  return {
    sessionId: 'session-browser',
    runId: 'run-browser',
    assignmentId,
    assignmentPath: path.join(root, assignmentId),
    policy: { enabled: true, restrictDomains: false, domains: [] },
  }
}

function createBrowserFixtureServer(): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/captcha') {
      html(response, '<h1>Our systems have detected unusual traffic from your computer network</h1><p>Complete the CAPTCHA to continue.</p>')
      return
    }
    if (url.pathname === '/interactive-verification') {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end([
        '<!doctype html><html><head><title>Verification Required</title></head><body>',
        '<main><h1>Verification Required</h1>',
        '<p>The visual verification might not be accessible to you.</p>',
        '<p>Use the audio verification to hear six digits.</p>',
        '<p>We detected unusual activity from your device or network.</p>',
        '<button aria-label="Play audio verification">Play</button>',
        '<div role="slider" aria-label="Slide right to secure your access" tabindex="0"></div>',
        '</main></body></html>',
      ].join(''))
      return
    }
    if (url.pathname === '/verify-device') {
      html(response, '<h1>Verify your device</h1><p>Performing security verification before continuing.</p>')
      return
    }
    if (url.pathname === '/forbidden') {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><body><h1>Forbidden</h1></body></html>')
      return
    }
    if (url.pathname === '/rate-limited') {
      response.writeHead(429, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><body><h1>Too many requests</h1></body></html>')
      return
    }
    if (url.pathname === '/missing') {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><body><h1>Not found</h1></body></html>')
      return
    }
    if (url.pathname === '/empty') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><head></head><body></body></html>')
      return
    }
    if (url.pathname === '/download') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="research-report.txt"',
      })
      response.end('real browser download\n')
      return
    }
    if (url.pathname === '/login') {
      response.setHeader('set-cookie', 'research_session=active; Max-Age=3600; Path=/; SameSite=Lax')
      html(response, '<h1>Signed in</h1>')
      return
    }
    if (url.pathname === '/private') {
      const authenticated = request.headers.cookie?.includes('research_session=active')
      html(response, authenticated
        ? '<h1>Authenticated research workspace</h1>'
        : '<h1>Authentication required</h1>')
      return
    }
    if (url.pathname === '/details') {
      html(response, '<h1>Deep research details</h1><a href="/home">Home</a>')
      return
    }
    if (url.pathname === '/blocked-subresource') {
      html(response, [
        '<main><h1>Usable page despite a blocked tracker</h1></main>',
        '<script src="https://tracker.example/analytics.js"></script>',
      ].join(''))
      return
    }
    if (url.pathname === '/frame') {
      html(response, '<h2>Embedded evidence</h2><button>Frame action</button>')
      return
    }
    if (url.pathname === '/react') {
      html(response, [
        '<main id="root"><h1>Loading research</h1></main>',
        '<script>',
        'setTimeout(() => {',
        '  document.querySelector("#root").innerHTML = "<article><h1>Research complete</h1><p>React research result: orbital market evidence</p></article>";',
        '}, 350);',
        '</script>',
      ].join(''))
      return
    }
    if (url.pathname === '/virtual') {
      html(response, [
        '<main><h1>Virtualized evidence</h1><p>Virtual item 1</p><div style="height: 1800px"></div><div id="more"></div></main>',
        '<script>',
        'let loaded = false;',
        'addEventListener("scroll", () => {',
        '  if (!loaded && innerHeight + scrollY >= document.documentElement.scrollHeight - 10) {',
        '    loaded = true;',
        '    document.querySelector("#more").textContent = "Virtual item 2 loaded";',
        '  }',
        '});',
        '</script>',
      ].join(''))
      return
    }
    if (url.pathname === '/redirect-denied') {
      response.writeHead(302, { location: 'https://example.com/blocked' })
      response.end()
      return
    }
    html(response, [
      '<h1>Browser fixture</h1>',
      '<label>Research topic <input aria-label="Research topic"></label>',
      '<label>Password <input type="password" aria-label="Account password" value="profile-password-secret"></label>',
      '<a href="/details">Details</a>',
      '<a href="/details?signed=url-link-secret">Signed details</a>',
      '<a href="/download" download>Download report</a>',
      '<a href="/redirect-denied">Blocked redirect</a>',
      '<button onclick="setTimeout(() => document.body.insertAdjacentHTML(\'beforeend\', \'<p>Research submitted</p>\'), 250)">Submit research</button>',
      '<table><tr><th>Metric</th><th>Value</th></tr><tr><td>Coverage</td><td>97%</td></tr></table>',
      '<iframe src="/frame" title="Evidence frame"></iframe>',
      '<div id="shadow-host"></div>',
      '<canvas width="40" height="20" aria-label="Visual chart"></canvas>',
      '<div style="height: 1600px">Scrollable evidence</div>',
      '<script>',
      'const shadow = document.querySelector("#shadow-host").attachShadow({ mode: "open" });',
      'shadow.innerHTML = "<section><h2>Shadow evidence</h2><button>Shadow action</button></section>";',
      '</script>',
    ].join(''))
  })
}

function html(response: http.ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><html><head><title>Browser fixture</title></head><body>${body}</body></html>`)
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function waitForApproval(
  coordinator: McpApprovalCoordinator,
  context: McpBrokerRequestContext,
  toolCallId: string,
) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const interaction = (await coordinator.list(context)).find(
      (candidate) => candidate.toolCallId === toolCallId && candidate.status === 'pending',
    )
    if (interaction) return interaction
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for browser approval ${toolCallId}`)
}
