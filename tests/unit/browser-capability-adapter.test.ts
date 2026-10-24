import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type {
  CapabilityApprovalOutcome,
  CapabilityDispatchEvent,
  CapabilityDispatcherPorts,
} from '../../contracts/capability-dispatch.js'
import { toMcpJsonObject } from '../../contracts/mcp.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import {
  BrowserManager,
  BrowserRuntimeError,
  type BrowserExecutionScope,
} from '../../domains/browser/browser-manager.js'
import type { BrowserTargetDescription } from '../../domains/browser/browser-policy.js'
import {
  BROWSER_TOOL_CONTRACT_VERSION,
  type BrowserToolInput,
  type BrowserToolOutput,
} from '../../domains/browser/browser-types.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import {
  BrowserCapabilityDispatchGateway,
  type BrowserCapabilityDispatchInput,
} from '../../services/browser-capability-adapter.js'
import { BrowserToolService } from '../../services/browser-tool-service.js'

test('an unattended browser mutation is rejected through dispatch without approval or execution', async (context) => {
  const fixture = await makeFixture(context, {
    agentPath: 'agents/web-researcher',
    activityScopeId: 'research-lane',
    target: { tag: 'button', role: 'button', name: 'Submit' },
  })

  const output = await fixture.gateway.execute(
    invocation(fixture.context, 'call-unattended', {
      action: 'click',
      pageId: 'page-1',
      ref: 'ref-1',
    }),
  )

  assert.equal(output.ok, false)
  assert.equal(output.error?.code, 'approval_denied')
  assert.equal(fixture.manager.executeCount, 0)
  assert.equal(fixture.approvalCount(), 0)
  assert.deepEqual(
    (await fixture.service.listSession(fixture.context.sessionId)).map(
      (activity) => activity.state,
    ),
    ['denied'],
  )
  assert.deepEqual(fixture.events.map((event) => event.type), [
    'capability.dispatch.requested',
    'capability.dispatch.rejected',
  ])
})

test('a challenge lets an explicit second call to the same host reach the browser', async (context) => {
  const fixture = await makeFixture(context, {
    agentPath: 'agents/researcher',
    activityScopeId: 'lane-a',
    execute: async (scope, input, call) => {
      if (call === 1) {
        throw new BrowserRuntimeError(
          'access_challenge',
          'The source presented a verification challenge.',
          false,
          ...(input.url ? [{ url: input.url }] : []),
        )
      }
      return success(input.action, input.url)
    },
  })

  const first = await fixture.gateway.execute(
    invocation(fixture.context, 'call-first', {
      action: 'open',
      url: 'https://challenged.example/source',
    }),
  )
  const second = await fixture.gateway.execute(
    invocation(
      { ...fixture.context, requestId: 'request-retry' },
      'call-retry',
      { action: 'open', url: 'https://challenged.example/again' },
    ),
  )

  assert.equal(first.error?.code, 'access_challenge')
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(
    fixture.manager.executeCount,
    2,
    'the second call must reach managed Chrome rather than a stored host ban',
  )
  assert.deepEqual(
    (await fixture.service.listSession(fixture.context.sessionId)).map(
      (activity) => activity.state,
    ),
    ['failed', 'completed'],
  )
})

for (const denial of [
  { code: 'access_denied' as const, message: 'The source denied browser access with HTTP 403.' },
  { code: 'rate_limited' as const, message: 'The source rate-limited browser access.' },
]) {
  test(`a ${denial.code} browser failure still blocks the host for the rest of the lane`, async (context) => {
    const fixture = await makeFixture(context, {
      agentPath: 'agents/researcher',
      activityScopeId: 'lane-a',
      execute: async (scope, input, call) => {
        if (call === 1) {
          throw new BrowserRuntimeError(
            denial.code,
            denial.message,
            false,
            ...(input.url ? [{ url: input.url }] : []),
          )
        }
        return success(input.action, input.url)
      },
    })

    const first = await fixture.gateway.execute(
      invocation(fixture.context, 'call-first', {
        action: 'open',
        url: 'https://blocked.example/source',
      }),
    )
    const blockedRetry = await fixture.gateway.execute(
      invocation(
        { ...fixture.context, requestId: 'request-retry' },
        'call-retry',
        {
          action: 'open',
          url: 'https://blocked.example/again?secret=must-not-persist',
        },
      ),
    )
    const siblingLane = await fixture.gateway.execute(
      invocation(
        {
          ...fixture.context,
          requestId: 'request-sibling',
          activityScopeId: 'lane-b',
        },
        'call-sibling',
        { action: 'open', url: 'https://blocked.example/sibling' },
      ),
    )

    assert.equal(first.error?.code, denial.code)
    assert.equal(blockedRetry.error?.code, 'source_blocked')
    assert.equal(siblingLane.ok, true)
    assert.equal(
      fixture.manager.executeCount,
      2,
      'the blocked retry must not reach managed Chrome',
    )
    const activities = await fixture.service.listSession(fixture.context.sessionId)
    assert.deepEqual(
      activities.map((activity) => activity.state),
      ['failed', 'failed', 'completed'],
    )
    assert.equal(activities[1]?.url, 'https://blocked.example/again')
  })
}

test('browser approval denial preserves the external error and denied activity state', async (context) => {
  const fixture = await makeFixture(context, {
    agentPath: 'agents/researcher',
    target: { tag: 'button', role: 'button', name: 'Submit' },
    approvalOutcome: 'denied',
  })

  const output = await fixture.gateway.execute(
    invocation(fixture.context, 'call-denied', {
      action: 'click',
      pageId: 'page-1',
      ref: 'ref-1',
    }),
  )

  assert.equal(output.error?.code, 'approval_denied')
  assert.equal(output.error?.message, 'Browser action was denied.')
  assert.equal(fixture.approvalCount(), 1)
  assert.equal(fixture.manager.executeCount, 0)
  assert.deepEqual(
    (await fixture.service.listSession(fixture.context.sessionId)).map(
      (activity) => activity.state,
    ),
    ['denied'],
  )
})

for (const approval of [
  {
    outcome: 'expired' as const,
    errorCode: 'approval_expired' as const,
    state: 'denied' as const,
    message: 'Browser action approval expired.',
  },
  {
    outcome: 'cancelled' as const,
    errorCode: 'approval_denied' as const,
    state: 'cancelled' as const,
    message: 'Browser action approval was cancelled.',
  },
  {
    outcome: 'interrupted' as const,
    errorCode: 'approval_denied' as const,
    state: 'cancelled' as const,
    message: 'Browser action approval was cancelled.',
  },
]) {
  test(`browser approval ${approval.outcome} preserves its external mapping`, async (context) => {
    const fixture = await makeFixture(context, {
      agentPath: 'agents/researcher',
      target: { tag: 'button', role: 'button', name: 'Submit' },
      approvalOutcome: approval.outcome,
    })

    const output = await fixture.gateway.execute(
      invocation(fixture.context, `call-${approval.outcome}`, {
        action: 'click',
        pageId: 'page-1',
        ref: 'ref-1',
      }),
    )

    assert.equal(output.error?.code, approval.errorCode)
    assert.equal(output.error?.message, approval.message)
    assert.equal(fixture.manager.executeCount, 0)
    assert.deepEqual(
      (await fixture.service.listSession(fixture.context.sessionId)).map(
        (activity) => activity.state,
      ),
      [approval.state],
    )
  })
}

test('an invalid browser activity scope is rejected before activity or execution', async (context) => {
  const fixture = await makeFixture(context, {
    agentPath: 'agents/researcher',
  })

  const output = await fixture.gateway.execute(
    invocation(
      { ...fixture.context, activityScopeId: '../outside' },
      'call-invalid-scope',
      { action: 'observe' },
    ),
  )

  assert.equal(output.error?.code, 'invalid_request')
  assert.equal(fixture.manager.executeCount, 0)
  assert.deepEqual(
    await fixture.service.listSession(fixture.context.sessionId),
    [],
  )
})

test('a browser target that becomes more severe after approval is not executed', async (context) => {
  const fixture = await makeFixture(context, {
    agentPath: 'agents/researcher',
    targets: [
      { tag: 'button', role: 'button', name: 'Submit' },
      { tag: 'button', role: 'button', name: 'Delete account' },
    ],
    approvalOutcome: 'approved',
  })

  const output = await fixture.gateway.execute(
    invocation(fixture.context, 'call-risk-change', {
      action: 'click',
      pageId: 'page-1',
      ref: 'ref-1',
    }),
  )

  assert.equal(output.error?.code, 'approval_denied')
  assert.match(output.error?.message ?? '', /changed after approval/i)
  assert.equal(fixture.approvalCount(), 1)
  assert.equal(fixture.manager.executeCount, 0)
  assert.deepEqual(
    (await fixture.service.listSession(fixture.context.sessionId)).map(
      (activity) => activity.state,
    ),
    ['denied'],
  )
})

test('a successful browser observation keeps its receipt and completed activity through dispatch', async (context) => {
  const fixture = await makeFixture(context, {
    agentPath: 'agents/researcher',
    activityScopeId: 'receipt-lane',
    execute: async (scope, input) => {
      const content = 'Receipt-backed browser evidence.'
      const contentId = 'receipt-content'
      const directory = path.join(scope.assignmentPath, 'browser-content')
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, `${contentId}.txt`), content, {
        mode: 0o600,
      })
      return {
        ok: true,
        action: input.action,
        url: 'https://example.com/evidence',
        title: 'Evidence',
        text: content,
        content: {
          id: contentId,
          sizeBytes: Buffer.byteLength(content),
          chunkCount: 1,
        },
      }
    },
  })

  const output = await fixture.gateway.execute(
    invocation(fixture.context, 'call-receipt', {
      action: 'open',
      url: 'https://example.com/evidence',
    }),
  )

  assert.equal(output.ok, true)
  assert.ok(output.observationReceipt)
  assert.equal(output.observationReceipt.activityScopeId, 'receipt-lane')
  const activity = (await fixture.service.listSession(fixture.context.sessionId))[0]
  assert.equal(activity?.state, 'completed')
  assert.deepEqual(activity?.observationReceipt, output.observationReceipt)
})

interface FixtureOptions {
  readonly agentPath: string
  readonly activityScopeId?: string
  readonly target?: BrowserTargetDescription
  readonly targets?: readonly (BrowserTargetDescription | undefined)[]
  readonly approvalOutcome?: CapabilityApprovalOutcome
  readonly execute?: (
    scope: BrowserExecutionScope,
    input: BrowserToolInput,
    call: number,
  ) => Promise<BrowserToolOutput>
}

async function makeFixture(
  testContext: test.TestContext,
  options: FixtureOptions,
): Promise<{
  readonly context: McpBrokerRequestContext & { readonly activityScopeId?: string }
  readonly service: BrowserToolService
  readonly manager: FixtureBrowserManager
  readonly gateway: BrowserCapabilityDispatchGateway
  readonly events: CapabilityDispatchEvent[]
  readonly approvalCount: () => number
}> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'browser-capability-adapter-')),
  )
  testContext.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const manager = new FixtureBrowserManager(path.join(root, 'profile'), options)
  testContext.after(() => manager.close())
  const service = new BrowserToolService({ workspacePath, repoRootPath, manager })
  const context: McpBrokerRequestContext & { readonly activityScopeId?: string } = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-1',
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: options.agentPath,
    ...(options.activityScopeId
      ? { activityScopeId: options.activityScopeId }
      : {}),
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, context)
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  await writeBrowserPolicy(repoRootPath, options.agentPath)
  const events: CapabilityDispatchEvent[] = []
  let approvalCount = 0
  const ports: CapabilityDispatcherPorts = {
    bindings: new CapabilityInvocationBindings({
      maxActivePerScope: 8,
      maxRetainedPerScope: 32,
    }),
    authority: { authorize: async () => ({ kind: 'allow' }) },
    policy: { evaluate: async () => ({ kind: 'allow' }) },
    budget: {
      preflight: async () => ({ kind: 'not-metered' }),
      reserve: async () => ({ reservationId: 'unexpected' }),
      settle: async () => ({ costTracked: false, budgetOverrun: false }),
      release: async () => undefined,
    },
    approval: {
      request: async (input) => {
        approvalCount += 1
        const interaction = {
          interactionId: `interaction-${approvalCount}`,
          reused: false,
        }
        await input.onInteraction(interaction)
        return {
          outcome: options.approvalOutcome ?? 'approved',
          interaction,
        }
      },
    },
    evidence: {
      append: async (event) => {
        events.push(event)
      },
    },
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    clock: { now: Date.now },
    ids: { nextAttemptId: () => `attempt-${events.length + 1}` },
  }
  return {
    context,
    service,
    manager,
    gateway: new BrowserCapabilityDispatchGateway({
      dispatcher: new CapabilityDispatcher(ports),
      service,
    }),
    events,
    approvalCount: () => approvalCount,
  }
}

class FixtureBrowserManager extends BrowserManager {
  executeCount = 0
  private describeCount = 0

  constructor(
    profilePath: string,
    private readonly fixture: FixtureOptions,
  ) {
    super({ profilePath })
  }

  override async describeTarget(): Promise<BrowserTargetDescription | undefined> {
    const target = this.fixture.targets?.[
      Math.min(this.describeCount, this.fixture.targets.length - 1)
    ] ?? this.fixture.target
    this.describeCount += 1
    return target
  }

  override async execute(
    scope: BrowserExecutionScope,
    input: BrowserToolInput,
  ): Promise<BrowserToolOutput> {
    this.executeCount += 1
    return this.fixture.execute
      ? this.fixture.execute(scope, input, this.executeCount)
      : success(input.action, input.url)
  }
}

function invocation(
  context: McpBrokerRequestContext & { readonly activityScopeId?: string },
  toolCallId: string,
  input: BrowserToolInput,
): BrowserCapabilityDispatchInput {
  return {
    context,
    authority: { kind: 'mcp-lease', leaseId: context.leaseId },
    source: {
      kind: 'builtin',
      id: 'builtin.browser',
      version: String(BROWSER_TOOL_CONTRACT_VERSION),
    },
    toolCallId,
    input: toMcpJsonObject(input),
  }
}

function success(action: BrowserToolInput['action'], url?: string): BrowserToolOutput {
  return {
    ok: true,
    action,
    ...(url ? { url } : {}),
    text: 'Observed browser result.',
  }
}

async function writeBrowserPolicy(
  repoRootPath: string,
  agentPath: string,
): Promise<void> {
  const agentName = agentPath.replace(/^agents\//, '')
  const directory = path.join(repoRootPath, 'agents', agentName)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, `${agentName}.md`),
    [
      '---',
      `name: ${agentName}`,
      'tools: browser',
      'browser_restrict_domains: false',
      '---',
      '',
      `# ${agentName}`,
    ].join('\n'),
  )
}
