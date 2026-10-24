import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type {
  CapabilityDispatchEvent,
  CapabilityPolicyDecision,
} from '../../contracts/capability-dispatch.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import {
  RESEARCH_WEB_SERVER_ID,
  RESEARCH_WEB_TOOL_CONTRACT_VERSION,
  type ResearchWebToolOutput,
} from '../../domains/acquisition/acquisition-types.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from '../../domains/mcp/mcp-runtime.js'
import {
  RESEARCH_WEB_CAPABILITY_ID,
  ResearchWebCapabilityDispatchGateway,
  type ResearchWebCapabilityDispatchInput,
  type ResearchWebCapabilityService,
} from '../../services/research-web-capability-adapter.js'
import {
  SKILL_LOADER_CAPABILITY_ID,
  SkillLoaderCapabilityDispatchGateway,
  type SkillLoaderCapabilityService,
} from '../../services/skill-loader-capability-adapter.js'
import {
  SkillLoaderService,
  type LoadSkillOutput,
} from '../../services/skill-loader-service.js'

test('research dispatch preserves receipt-backed output and domain activity ownership', async () => {
  const events: CapabilityDispatchEvent[] = []
  const executions: Array<{
    readonly context: McpBrokerRequestContext & { readonly activityScopeId?: string }
    readonly toolCallId: string
    readonly signal?: AbortSignal
  }> = []
  const releases: unknown[] = []
  const output = researchOutput()
  const service: ResearchWebCapabilityService = {
    isEnabledForAgent: () => true,
    execute: async (context, toolCallId, _input, signal) => {
      executions.push({ context, toolCallId, ...(signal ? { signal } : {}) })
      return output
    },
    releaseAssignment: async (scope) => {
      releases.push(scope)
    },
  }
  const gateway = new ResearchWebCapabilityDispatchGateway({
    dispatcher: dispatcher(events),
    service,
  })

  const result = await gateway.execute(researchInvocation('call-receipt'))

  assert.equal(result, output)
  assert.equal(executions.length, 1)
  assert.equal(executions[0]?.context.activityScopeId, 'lane-1')
  assert.equal(executions[0]?.toolCallId, 'call-receipt')
  assert.deepEqual(events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.started',
    'capability.dispatch.completed',
  ])
  assert.equal(events[0]?.capabilityId, RESEARCH_WEB_CAPABILITY_ID)
  assert.deepEqual(events[0]?.argumentNames, ['action', 'url'])

  await gateway.releaseAssignment({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    activityScopeId: 'lane-1',
  })
  assert.equal(releases.length, 1)
})

test('research authority denial is projected as domain detail without starting acquisition', async () => {
  let executions = 0
  const service: ResearchWebCapabilityService = {
    isEnabledForAgent: () => true,
    execute: async () => {
      executions += 1
      return researchOutput()
    },
    releaseAssignment: async () => undefined,
  }
  const gateway = new ResearchWebCapabilityDispatchGateway({
    dispatcher: dispatcher([], {
      kind: 'deny',
      code: 'lease_invalid',
      reason: 'Lease is no longer active.',
    }),
    service,
  })

  const result = await gateway.execute(researchInvocation('call-denied'))

  assert.equal(result.ok, false)
  assert.equal(result.action, 'acquire')
  assert.equal(result.error?.code, 'domain_denied')
  assert.equal(result.error?.retryable, false)
  assert.equal(executions, 0)
})

test('research input is validated during prepare before the domain executor starts', async () => {
  let executions = 0
  const gateway = new ResearchWebCapabilityDispatchGateway({
    dispatcher: dispatcher([]),
    service: {
      isEnabledForAgent: () => true,
      execute: async () => {
        executions += 1
        return researchOutput()
      },
      releaseAssignment: async () => undefined,
    },
  })

  const result = await gateway.execute({
    ...researchInvocation('call-invalid-input'),
    input: { action: 'acquire' },
  })

  assert.equal(result.ok, false)
  assert.equal(result.action, 'acquire')
  assert.equal(result.error?.code, 'invalid_request')
  assert.equal(executions, 0)
})

test('research domain failure remains exact while dispatch records a failed lifecycle', async () => {
  const output: ResearchWebToolOutput = {
    ok: false,
    action: 'acquire',
    requestedUrl: 'https://challenged.example/source',
    attempts: [{
      method: 'direct-http',
      outcome: 'challenge',
      startedAt: '2026-08-14T12:00:00.000Z',
      durationMs: 20,
    }],
    error: {
      code: 'access_challenge',
      message: 'The source presented an anti-bot verification page.',
      retryable: false,
    },
  }
  const events: CapabilityDispatchEvent[] = []
  const gateway = new ResearchWebCapabilityDispatchGateway({
    dispatcher: dispatcher(events),
    service: {
      isEnabledForAgent: () => true,
      execute: async () => output,
      releaseAssignment: async () => undefined,
    },
  })

  const result = await gateway.execute({
    ...researchInvocation('call-domain-failure'),
    input: {
      action: 'acquire',
      url: 'https://challenged.example/source',
    },
  })

  assert.equal(result, output)
  assert.deepEqual(events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.started',
    'capability.dispatch.failed',
  ])
  assert.equal(events[2]?.code, 'capability_execution_failed')
})

test('research result validation rejects an escaping receipt path', async () => {
  const baseOutput = researchOutput()
  const observationReceipt = baseOutput.observationReceipt
  assert.ok(observationReceipt)
  const escapingOutput: ResearchWebToolOutput = {
    ...baseOutput,
    observationReceipt: {
      ...observationReceipt,
      relativePath: '../outside-receipt.json',
    },
  }
  const events: CapabilityDispatchEvent[] = []
  const gateway = new ResearchWebCapabilityDispatchGateway({
    dispatcher: dispatcher(events),
    service: {
      isEnabledForAgent: () => true,
      execute: async () => escapingOutput,
      releaseAssignment: async () => undefined,
    },
  })

  const result = await gateway.execute(
    researchInvocation('call-invalid-receipt-path'),
  )

  assert.deepEqual(result, {
    ok: false,
    action: 'acquire',
    error: {
      code: 'internal',
      message: 'Research web acquisition returned an invalid result.',
      retryable: true,
    },
  })
  assert.deepEqual(events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.started',
    'capability.dispatch.failed',
  ])
})

test('skill loading reads the hash-pinned file only inside governed execution', async (context) => {
  const repoRootPath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'governed-skill-load-')),
  )
  context.after(() => fs.rm(repoRootPath, { recursive: true, force: true }))
  const source = path.join(
    repoRootPath,
    'agents',
    'analyst',
    'skills',
    'evidence-review',
    'SKILL.md',
  )
  const content = '# Evidence Review\n\nUse primary evidence.\n'
  await fs.mkdir(path.dirname(source), { recursive: true })
  await fs.writeFile(source, content)
  const events: CapabilityDispatchEvent[] = []
  const gateway = new SkillLoaderCapabilityDispatchGateway({
    dispatcher: dispatcher(events),
    service: new SkillLoaderService({ repoRootPath }),
  })

  const result = await gateway.execute({
    context: brokerContext('agents/analyst'),
    authority: { kind: 'mcp-lease', leaseId: 'lease-1' },
    source: { kind: 'builtin', id: 'pipeline-skills', version: '1' },
    toolCallId: 'load-skill',
    input: {
      source,
      sha256: createHash('sha256').update(content).digest('hex'),
    },
  })

  assert.deepEqual(result, {
    ok: true,
    name: 'evidence-review',
    source,
    sha256: createHash('sha256').update(content).digest('hex'),
    content,
  })
  assert.deepEqual(events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.started',
    'capability.dispatch.completed',
  ])
  assert.equal(events[0]?.capabilityId, SKILL_LOADER_CAPABILITY_ID)
  assert.deepEqual(events[0]?.argumentNames, ['sha256', 'source'])
})

test('skill dispatch rejection is a typed loader failure, not a thrown provider error', async () => {
  const gateway = new SkillLoaderCapabilityDispatchGateway({
    dispatcher: dispatcher([], {
      kind: 'deny',
      code: 'lease_invalid',
      reason: 'Lease is no longer active.',
    }),
    service: new SkillLoaderService({ repoRootPath: process.cwd() }),
  })

  const result = await gateway.execute({
    context: brokerContext('agents/analyst'),
    authority: { kind: 'mcp-lease', leaseId: 'lease-1' },
    source: { kind: 'builtin', id: 'pipeline-skills', version: '1' },
    toolCallId: 'load-denied',
    input: { source: '/unreadable/SKILL.md', sha256: 'c'.repeat(64) },
  })

  assert.deepEqual(result, {
    ok: false,
    code: 'lease_invalid',
    message: 'Skill loading was denied by capability policy.',
  })
})

test('a disabled skill catalog is denied before the file loader starts', async () => {
  let executions = 0
  const events: CapabilityDispatchEvent[] = []
  const service: SkillLoaderCapabilityService = {
    isEnabledForAgent: () => false,
    execute: async () => {
      executions += 1
      return {
        ok: false,
        code: 'unexpected_execution',
        message: 'The file loader should not execute.',
      }
    },
  }
  const gateway = new SkillLoaderCapabilityDispatchGateway({
    dispatcher: dispatcher(events),
    service,
  })

  const result = await gateway.execute({
    context: brokerContext('agents/no-skills'),
    authority: { kind: 'mcp-lease', leaseId: 'lease-1' },
    source: { kind: 'builtin', id: 'pipeline-skills', version: '1' },
    toolCallId: 'load-disabled-skill',
    input: {
      source: '/repo/agents/no-skills/skills/a/SKILL.md',
      sha256: 'd'.repeat(64),
    },
  })

  assert.deepEqual(result, {
    ok: false,
    code: 'skill_source_not_allowed',
    message: 'This agent has no discoverable skill catalog.',
  })
  assert.equal(executions, 0)
  assert.deepEqual(events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.rejected',
  ])
})

test('skill domain failure remains exact while dispatch records a failed lifecycle', async () => {
  const output: LoadSkillOutput = {
    ok: false,
    code: 'skill_content_changed',
    message: 'Selected skill changed after discovery.',
  }
  const events: CapabilityDispatchEvent[] = []
  const gateway = new SkillLoaderCapabilityDispatchGateway({
    dispatcher: dispatcher(events),
    service: {
      isEnabledForAgent: () => true,
      execute: async () => output,
    },
  })

  const result = await gateway.execute({
    context: brokerContext('agents/analyst'),
    authority: { kind: 'mcp-lease', leaseId: 'lease-1' },
    source: { kind: 'builtin', id: 'pipeline-skills', version: '1' },
    toolCallId: 'load-changed-skill',
    input: { source: '/repo/agents/analyst/skills/a/SKILL.md', sha256: 'd'.repeat(64) },
  })

  assert.equal(result, output)
  assert.deepEqual(events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.started',
    'capability.dispatch.failed',
  ])
  assert.equal(events[2]?.code, 'capability_execution_failed')
})

test('skill result validation rejects content that does not match its claimed hash', async () => {
  const events: CapabilityDispatchEvent[] = []
  const gateway = new SkillLoaderCapabilityDispatchGateway({
    dispatcher: dispatcher(events),
    service: {
      isEnabledForAgent: () => true,
      execute: async () => ({
        ok: true,
        name: 'changed-skill',
        source: '/repo/agents/analyst/skills/changed-skill/SKILL.md',
        sha256: 'e'.repeat(64),
        content: '# Content with a different digest\n',
      }),
    },
  })

  const result = await gateway.execute({
    context: brokerContext('agents/analyst'),
    authority: { kind: 'mcp-lease', leaseId: 'lease-1' },
    source: { kind: 'builtin', id: 'pipeline-skills', version: '1' },
    toolCallId: 'load-invalid-result',
    input: {
      source: '/repo/agents/analyst/skills/changed-skill/SKILL.md',
      sha256: 'e'.repeat(64),
    },
  })

  assert.deepEqual(result, {
    ok: false,
    code: 'internal',
    message: 'Skill loader returned an invalid result.',
  })
  assert.deepEqual(events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.started',
    'capability.dispatch.failed',
  ])
})

function dispatcher(
  events: CapabilityDispatchEvent[],
  authorityDecision: CapabilityPolicyDecision = { kind: 'allow' },
): CapabilityDispatcher {
  let attempt = 0
  return new CapabilityDispatcher({
    bindings: new CapabilityInvocationBindings({
      maxActivePerScope: 8,
      maxRetainedPerScope: 64,
    }),
    authority: { authorize: async () => authorityDecision },
    policy: { evaluate: async () => ({ kind: 'allow' }) },
    budget: {
      preflight: async () => ({ kind: 'not-metered' }),
      reserve: async () => ({ reservationId: 'unexpected-reservation' }),
      settle: async () => ({ costTracked: false, budgetOverrun: false }),
      release: async () => undefined,
    },
    evidence: {
      append: async (event) => {
        events.push(event)
      },
    },
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    clock: { now: Date.now },
    ids: {
      nextAttemptId: () => {
        attempt += 1
        return `read-capability-attempt-${attempt}`
      },
    },
  })
}

function researchInvocation(toolCallId: string): ResearchWebCapabilityDispatchInput {
  return {
    context: brokerContext(),
    authority: { kind: 'mcp-lease', leaseId: 'lease-1' },
    source: {
      kind: 'builtin',
      id: RESEARCH_WEB_SERVER_ID,
      version: String(RESEARCH_WEB_TOOL_CONTRACT_VERSION),
    },
    toolCallId,
    input: {
      action: 'acquire',
      url: 'https://example.test/source?tracking=removed',
    },
  }
}

function brokerContext(
  agentPath = 'agents/researcher',
): McpBrokerRequestContext & { readonly activityScopeId: string } {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-1',
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath,
    activityScopeId: 'lane-1',
  }
}

test('a proxied managed-browser acquisition survives the research capability boundary', async () => {
  const proxied: ResearchWebToolOutput = {
    ...researchOutput(),
    method: 'managed-browser-proxied',
    observationReceipt: {
      ...researchOutput().observationReceipt!,
      schemaVersion: 4,
      method: 'managed-browser-proxied',
    },
    attempts: [
      {
        method: 'direct-http',
        outcome: 'insufficient',
        startedAt: '2026-08-29T12:00:00.000Z',
        durationMs: 12,
      },
      {
        method: 'managed-browser',
        outcome: 'access-denied',
        startedAt: '2026-08-29T12:00:01.000Z',
        durationMs: 900,
      },
      {
        method: 'managed-browser-proxied',
        outcome: 'usable',
        startedAt: '2026-08-29T12:00:02.000Z',
        durationMs: 1200,
      },
    ],
  }
  const gateway = new ResearchWebCapabilityDispatchGateway({
    dispatcher: dispatcher([]),
    service: {
      isEnabledForAgent: () => true,
      execute: async () => proxied,
      releaseAssignment: async () => undefined,
    },
  })

  const result = await gateway.execute(researchInvocation('call-browser-proxied'))

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.method, 'managed-browser-proxied')
  assert.equal(result.observationReceipt?.schemaVersion, 4)
  assert.deepEqual(
    result.attempts?.map((attempt) => attempt.method),
    ['direct-http', 'managed-browser', 'managed-browser-proxied'],
  )
})

test('a proxied acquisition survives the research capability boundary', async () => {
  const proxied: ResearchWebToolOutput = {
    ...researchOutput(),
    method: 'direct-http-proxied',
    observationReceipt: {
      ...researchOutput().observationReceipt!,
      schemaVersion: 3,
      method: 'direct-http-proxied',
    },
    attempts: [
      {
        method: 'direct-http',
        outcome: 'access-denied',
        startedAt: '2026-08-14T12:00:00.000Z',
        durationMs: 12,
      },
      {
        method: 'direct-http-proxied',
        outcome: 'usable',
        startedAt: '2026-08-14T12:00:01.000Z',
        durationMs: 30,
      },
    ],
  }
  const gateway = new ResearchWebCapabilityDispatchGateway({
    dispatcher: dispatcher([]),
    service: {
      isEnabledForAgent: () => true,
      execute: async () => proxied,
      releaseAssignment: async () => undefined,
    },
  })

  const result = await gateway.execute(researchInvocation('call-proxied'))

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.method, 'direct-http-proxied')
  assert.equal(result.observationReceipt?.schemaVersion, 3)
})

function researchOutput(): ResearchWebToolOutput {
  return {
    ok: true,
    action: 'acquire',
    requestedUrl: 'https://example.test/source?tracking=removed',
    finalUrl: 'https://example.test/source',
    canonicalUrl: 'https://example.test/source',
    title: 'Receipt-backed source',
    mediaType: 'text/markdown',
    method: 'direct-http',
    text: 'Verified observation text.',
    observationReceipt: {
      schemaVersion: 2,
      receiptId: 'receipt-1',
      activityId: 'activity-1',
      activityScopeId: 'lane-1',
      relativePath: 'research/acquisitions/receipt-1.json',
      method: 'direct-http',
      requestedUrl: 'https://example.test/source?tracking=removed',
      finalUrl: 'https://example.test/source',
      canonicalUrl: 'https://example.test/source',
      observedAt: '2026-08-14T12:00:00.000Z',
      contentRelativePath: 'research/acquisitions/receipt-1.md',
      contentSha256: 'a'.repeat(64),
      contentBytes: 26,
      quality: 'usable',
    },
    attempts: [{
      method: 'direct-http',
      outcome: 'usable',
      startedAt: '2026-08-14T12:00:00.000Z',
      durationMs: 12,
    }],
  }
}

/**
 * The three fields version 5 added, at the boundary that types a tool result.
 *
 * The payload reaching this gateway is external input, so the guard has to
 * establish the nested metadata rather than wave it through: a malformed
 * `browserRuntime` that passes as typed data is a lie the rest of the system
 * then trusts.
 */
test('version 5 attempt metadata survives the research capability boundary', async () => {
  const withMetadata: ResearchWebToolOutput = {
    ...researchOutput(),
    method: 'managed-browser-proxied',
    observationReceipt: {
      ...researchOutput().observationReceipt!,
      schemaVersion: 5,
      method: 'managed-browser-proxied',
    },
    attempts: [
      {
        method: 'direct-http',
        outcome: 'challenge',
        startedAt: '2026-08-29T12:00:00.000Z',
        durationMs: 12,
        challengeType: 'browser-verification',
      },
      {
        method: 'managed-browser-proxied',
        outcome: 'usable',
        startedAt: '2026-08-29T12:00:02.000Z',
        durationMs: 1200,
        browserRuntime: {
          driver: 'puppeteer-core',
          driverVersion: '25.3.0',
          browserVersion: 'Chrome/151.0.0.0',
          mode: 'headless',
          launchProfile: 'stock',
        },
        proxyRuntime: {
          provider: 'webshare',
          mode: 'rotating',
          tier: 'unknown',
        },
      },
    ],
  }
  const gateway = new ResearchWebCapabilityDispatchGateway({
    dispatcher: dispatcher([]),
    service: {
      isEnabledForAgent: () => true,
      execute: async () => withMetadata,
      releaseAssignment: async () => undefined,
    },
  })

  const result = await gateway.execute(researchInvocation('call-v5-metadata'))

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.observationReceipt?.schemaVersion, 5)
  assert.equal(result.attempts?.[0]?.challengeType, 'browser-verification')
  assert.deepEqual(result.attempts?.[1]?.browserRuntime, {
    driver: 'puppeteer-core',
    driverVersion: '25.3.0',
    browserVersion: 'Chrome/151.0.0.0',
    mode: 'headless',
    launchProfile: 'stock',
  })
  assert.deepEqual(result.attempts?.[1]?.proxyRuntime, {
    provider: 'webshare',
    mode: 'rotating',
    tier: 'unknown',
  })
})

test('malformed version 5 attempt metadata is refused at the research capability boundary', async () => {
  const malformedAttempts = [
    { why: 'an unknown challenge subtype', challengeType: 'definitely-not-a-wall' },
    { why: 'a non-string challenge subtype', challengeType: 7 },
    { why: 'a browser runtime that is not an object', browserRuntime: 'stock' },
    {
      why: 'a browser runtime naming another driver',
      browserRuntime: {
        driver: 'playwright',
        driverVersion: '1.0.0',
        browserVersion: 'Chrome/151.0.0.0',
        mode: 'headless',
        launchProfile: 'stock',
      },
    },
    {
      why: 'a browser runtime missing its versions',
      browserRuntime: { driver: 'puppeteer-core', mode: 'headless', launchProfile: 'stock' },
    },
    {
      why: 'a browser runtime naming an unknown launch profile',
      browserRuntime: {
        driver: 'puppeteer-core',
        driverVersion: '25.3.0',
        browserVersion: 'Chrome/151.0.0.0',
        mode: 'headless',
        launchProfile: 'stealth-mode',
      },
    },
    { why: 'a proxy runtime that is not an object', proxyRuntime: ['webshare'] },
    {
      why: 'a proxy runtime naming an unknown tier',
      proxyRuntime: { provider: 'webshare', mode: 'rotating', tier: 'mobile' },
    },
    // The metadata contract is "non-secret by construction". A guard that
    // checked only the required fields would let an extra key ride along on the
    // object that is kept, which is how a credential reaches a receipt.
    {
      why: 'a browser runtime carrying an unexpected key',
      browserRuntime: {
        driver: 'puppeteer-core',
        driverVersion: '25.3.0',
        browserVersion: 'Chrome/151.0.0.0',
        mode: 'headless',
        launchProfile: 'stock',
        unexpectedField: 'unexpected-value',
      },
    },
    {
      why: 'a browser runtime carrying page data',
      browserRuntime: {
        driver: 'puppeteer-core',
        driverVersion: '25.3.0',
        browserVersion: 'Chrome/151.0.0.0',
        mode: 'headless',
        launchProfile: 'stock',
        pageData: 'unexpected',
      },
    },
    {
      why: 'a proxy runtime carrying an endpoint',
      proxyRuntime: {
        provider: 'webshare',
        mode: 'rotating',
        tier: 'unknown',
        endpoint: 'redacted',
      },
    },
  ] as const

  for (const malformed of malformedAttempts) {
    const { why: _why, ...overrides } = malformed
    const output = {
      ...researchOutput(),
      attempts: [
        {
          method: 'managed-browser',
          outcome: 'usable',
          startedAt: '2026-08-29T12:00:02.000Z',
          durationMs: 1200,
          ...overrides,
        },
      ],
    }
    const gateway = new ResearchWebCapabilityDispatchGateway({
      dispatcher: dispatcher([]),
      service: {
        isEnabledForAgent: () => true,
        // The service contract is typed; this journey is about what arrives
        // when something upstream did not honour it.
        execute: async () => output as unknown as ResearchWebToolOutput,
        releaseAssignment: async () => undefined,
      },
    })

    const result = await gateway.execute(
      researchInvocation(`call-malformed-${malformed.why.replace(/\s+/gu, '-')}`),
    )

    // The refusal has to be observable, not merely an absent field: an
    // unrelated success shape that happens to carry no attempts would satisfy
    // `attempts === undefined` on its own.
    assert.equal(result.ok, false, `${malformed.why} must be refused`)
    assert.equal(
      result.error?.code,
      'internal',
      `${malformed.why} must be refused as an invalid domain result`,
    )
    assert.equal(
      result.error?.message,
      'Research web acquisition returned an invalid result.',
      `${malformed.why} must report the invalid-result message`,
    )
    assert.equal(
      result.attempts,
      undefined,
      `${malformed.why} must not pass as typed attempt metadata`,
    )
  }
})
