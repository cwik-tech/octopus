import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type {
  CapabilityApprovalOutcome,
  CapabilityDispatchEvent,
  CapabilityDispatcherPorts,
  CapabilityExecutionSchedulerPort,
} from '../../contracts/capability-dispatch.js'
import type { CapabilityEffect } from '../../contracts/capability-effect.js'
import { toMcpJsonObject } from '../../contracts/mcp.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from '../../domains/mcp/mcp-runtime.js'
import {
  youtubeApprovalToolName,
  type YoutubeAction,
} from '../../domains/youtube/youtube-types.js'
import {
  YOUTUBE_BUILTIN_SOURCE,
  YoutubeCapabilityDispatchGateway,
  type YoutubeCapabilityDispatchInput,
} from '../../services/youtube-capability-adapter.js'
import { YoutubeSettingsService } from '../../services/youtube-settings-service.js'
import { YoutubeToolService } from '../../services/youtube-tool-service.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

const READ_ACTIONS: readonly YoutubeAction[] = ['inspect', 'read_transcript']
const MUTATING_ACTIONS: readonly YoutubeAction[] = [
  'capture',
  'resume',
  'capture_authenticated',
  'write_methodology',
  'write_consolidation',
  'prepare_manual',
  'write_manual_plan',
  'build_manual',
]

test('YouTube action effects are classified before execution', async (context) => {
  const fixture = await makeFixture(context)
  const observed = new Map<YoutubeAction, string>()
  const dispatcher = createCapabilityTestDispatcher([], {
    policy: {
      evaluate: async (input) => {
        const action = actionFromToolCallId(input.invocation.toolCallId)
        observed.set(action, input.effect.kind)
        return {
          kind: 'deny',
          code: 'classification_observed',
          reason: 'The classification test stops before execution.',
        }
      },
    },
  })
  const gateway = new YoutubeCapabilityDispatchGateway({
    dispatcher,
    service: fixture.service,
  })

  for (const action of [...READ_ACTIONS, ...MUTATING_ACTIONS]) {
    await gateway.execute(invocation(`classify:${action}`, { action, ...(action === 'prepare_manual' ? { documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' } } : {}) }))
  }

  assert.deepEqual(
    Object.fromEntries(observed),
    Object.fromEntries([
      ...READ_ACTIONS.map((action) => [action, 'read-only'] as const),
      ...MUTATING_ACTIONS.map((action) => [action, 'mutating'] as const),
    ]),
  )
})

for (const expected of [
  {
    outcome: 'denied' as const,
    code: 'approval_denied' as const,
    message: 'Authenticated YouTube capture was not approved.',
  },
  {
    outcome: 'expired' as const,
    code: 'approval_expired' as const,
    message: 'Authenticated YouTube capture approval expired.',
  },
  {
    outcome: 'cancelled' as const,
    code: 'approval_denied' as const,
    message: 'Authenticated YouTube capture was not approved.',
  },
  {
    outcome: 'interrupted' as const,
    code: 'approval_denied' as const,
    message: 'Authenticated YouTube capture was not approved.',
  },
]) {
  test(`authenticated YouTube approval ${expected.outcome} preserves its domain mapping`, async (context) => {
    const fixture = await makeFixture(context)
    let approvalCount = 0
    const events: CapabilityDispatchEvent[] = []
    const dispatcher = createCapabilityTestDispatcher(events, {
      approval: approvalPort(expected.outcome, () => { approvalCount += 1 }),
    })
    const gateway = new YoutubeCapabilityDispatchGateway({
      dispatcher,
      service: fixture.service,
    })

    const output = await gateway.execute(invocation(
      `approval-${expected.outcome}`,
      { action: 'capture_authenticated' },
    ))

    assert.equal(approvalCount, 1)
    assert.equal(fixture.authenticatedCaptureCount(), 0)
    assert.equal(output.ok, false)
    assert.equal(output.error?.code, expected.code)
    assert.equal(output.error?.message, expected.message)
    assert.deepEqual(
      events
        .filter((event) => event.type.includes('approval'))
        .map((event) => ({
          type: event.type,
          outcome: event.approvalOutcome,
        })),
      [
        { type: 'capability.dispatch.approval_requested', outcome: undefined },
        {
          type: 'capability.dispatch.approval_resolved',
          outcome: expected.outcome,
        },
      ],
    )
  })
}

test('approved authenticated capture executes once through the common approval owner', async (context) => {
  const fixture = await makeFixture(context, {
    withAuthenticatedManifest: true,
  })
  let commonApprovalCount = 0
  let approvalDescription: {
    readonly serverId: string
    readonly namespacedToolName: string
  } | undefined
  const dispatcher = createCapabilityTestDispatcher([], {
    approval: {
      request: async (input) => {
        commonApprovalCount += 1
        approvalDescription = input.description
        const interaction = {
          interactionId: 'youtube-approved-interaction',
          reused: false,
        }
        await input.onInteraction(interaction)
        return { outcome: 'approved', interaction }
      },
    },
  })
  const gateway = new YoutubeCapabilityDispatchGateway({
    dispatcher,
    service: fixture.service,
  })

  const output = await gateway.execute(invocation(
    'approval-approved',
    { action: 'capture_authenticated' },
  ))

  assert.equal(output.ok, true)
  assert.equal(output.completed, 1)
  assert.equal(commonApprovalCount, 1)
  assert.equal(fixture.authenticatedCaptureCount(), 1)
  assert.equal(approvalDescription?.serverId, 'builtin.youtube')
  assert.equal(
    approvalDescription?.namespacedToolName,
    youtubeApprovalToolName(),
  )
  assert.match(
    await fs.readFile(
      path.join(fixture.assignmentPath, 'output', 'transcripts', 'dQw4w9WgXcQ.md'),
      'utf8',
    ),
    /Authenticated transcript text/,
  )
})

test('YouTube domain failures cross dispatch as typed detail without raw argument evidence', async (context) => {
  const fixture = await makeFixture(context)
  const events: CapabilityDispatchEvent[] = []
  const gateway = new YoutubeCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher(events),
    service: fixture.service,
  })

  const output = await gateway.execute(invocation('typed-failure', {
    action: 'write_consolidation',
    fileName: 'private-output-content-must-not-enter-dispatch-evidence.md',
  }))

  assert.equal(output.ok, false)
  assert.equal(output.error?.code, 'invalid_request')
  assert.equal(
    JSON.stringify(events).includes('private-output-content-must-not-enter-dispatch-evidence'),
    false,
  )
})

test('a malformed completed YouTube result is rejected at the dispatch gateway', async (context) => {
  const fixture = await makeFixture(context)
  const gateway = new YoutubeCapabilityDispatchGateway({
    dispatcher: {
      dispatch: async () => ({
        status: 'completed',
        dispatchId: 'malformed-youtube-result',
        value: {
          ok: true,
          action: 'prepare_manual',
          notices: [{ code: 'gemini_key_missing', severity: 'warning', message: 42 }],
        },
        costTracked: false,
        budgetOverrun: false,
      }),
    },
    service: fixture.service,
  })

  const output = await gateway.execute(invocation(
    'malformed-completed-result',
    { action: 'prepare_manual', documentRequest: { formats: ['markdown'], purpose: 'takeaways', instructions: 'MD with screenshots.' } },
  ))

  assert.equal(output.ok, false)
  assert.equal(output.error?.code, 'internal')
})

test('transcript chunks retain their exact output across dispatch', async (context) => {
  const fixture = await makeFixture(context)
  const transcriptPath = path.join(fixture.assignmentPath, 'output', 'transcripts')
  await fs.mkdir(transcriptPath, { recursive: true })
  await fs.writeFile(
    path.join(transcriptPath, 'dQw4w9WgXcQ.md'),
    '# Transcript\n\nDispatch-preserved transcript text.\n',
    { mode: 0o600 },
  )
  const gateway = new YoutubeCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher(),
    service: fixture.service,
  })

  const output = await gateway.execute(invocation('read-transcript', {
    action: 'read_transcript',
    videoId: 'dQw4w9WgXcQ',
    chunkIndex: 0,
  }))

  assert.deepEqual(output, {
    ok: true,
    action: 'read_transcript',
    chunk: {
      videoId: 'dQw4w9WgXcQ',
      chunkIndex: 0,
      chunkCount: 1,
      text: '# Transcript\n\nDispatch-preserved transcript text.\n',
    },
  })
})

test('manual preparation keeps its output and fallback extraction event across dispatch', async (context) => {
  const fixture = await makeFixture(context, {
    inspectManualVideo: async () => ({
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Dispatch manual source',
      durationSeconds: 600,
    }),
  })
  const gateway = new YoutubeCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher(),
    service: fixture.service,
  })

  const output = await gateway.execute(invocation('prepare-manual', {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    outputLanguage: 'en',
  }))

  assert.equal(output.ok, true)
  assert.equal(output.action, 'prepare_manual')
  assert.equal(output.analysisMode, 'transcript')
  assert.equal(output.notices?.[0]?.code, 'gemini_key_missing')
  assert.match(output.manifestPath ?? '', /^output\/manuals\/dQw4w9WgXcQ\//)
  const events = (await fs.readFile(
    path.join(fixture.assignmentPath, 'logs', 'engine-events.jsonl'),
    'utf8',
  )).trim().split('\n').map(parseJsonRecord)
  assert.equal(events.at(-1)?.type, 'youtube.manual.analysis_fallback')
  assert.equal(events.at(-1)?.payload?.error_code, 'gemini_key_missing')
})

test('a replaced assignment directory is rejected immediately before YouTube execution', async (context) => {
  const fixture = await makeFixture(context)
  const outsidePath = path.join(fixture.workspacePath, 'outside')
  const originalPath = `${fixture.assignmentPath}-original`
  await fs.mkdir(outsidePath)
  const gateway = new YoutubeCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher([], {
      scheduler: assignmentSwapScheduler({
        assignmentPath: fixture.assignmentPath,
        originalPath,
        outsidePath,
      }),
    }),
    service: fixture.service,
  })

  const output = await gateway.execute(invocation('assignment-replaced', {
    action: 'write_methodology',
    videoId: 'dQw4w9WgXcQ',
    content: '# Must remain in the governed assignment',
  }))

  assert.equal(output.ok, false)
  assert.equal(output.error?.code, 'invalid_request')
  assert.equal(
    await fileExists(path.join(outsidePath, 'output', 'methods', 'dQw4w9WgXcQ.md')),
    false,
  )
})

interface FixtureOptions {
  readonly withAuthenticatedManifest?: boolean
  readonly inspectManualVideo?: ConstructorParameters<typeof YoutubeToolService>[0]['inspectManualVideo']
}

async function makeFixture(
  testContext: test.TestContext,
  options: FixtureOptions = {},
): Promise<{
  readonly service: YoutubeToolService
  readonly workspacePath: string
  readonly assignmentPath: string
  readonly authenticatedCaptureCount: () => number
}> {
  const workspacePath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-capability-adapter-')),
  )
  testContext.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    'session-1',
    'runs',
    'run-1',
    'assignments',
    'assignment-1',
  )
  await fs.mkdir(assignmentPath, { recursive: true })
  if (options.withAuthenticatedManifest) {
    await writeAuthenticatedManifest(assignmentPath)
  }
  let authenticatedCaptureCount = 0
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
    ...(options.inspectManualVideo
      ? { inspectManualVideo: options.inspectManualVideo }
      : {}),
    browserManager: {
      youtubeCookieHeader: async () => undefined,
      captureYoutubeTranscript: async () => {
        authenticatedCaptureCount += 1
        return {
          title: 'Authenticated source',
          language: 'en',
          segments: [{
            startMs: 0,
            durationMs: 1_000,
            text: 'Authenticated transcript text.',
          }],
        }
      },
      captureYoutubeFrames: async () => [],
    },
  })
  return {
    service,
    workspacePath,
    assignmentPath,
    authenticatedCaptureCount: () => authenticatedCaptureCount,
  }
}

function invocation(
  toolCallId: string,
  input: unknown,
): YoutubeCapabilityDispatchInput {
  return {
    context: youtubeContext(),
    authority: { kind: 'mcp-lease' as const, leaseId: 'lease-1' },
    source: YOUTUBE_BUILTIN_SOURCE,
    toolCallId,
    input: toMcpJsonObject(input),
  }
}

function youtubeContext(): McpBrokerRequestContext {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-1',
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/youtube-extractor',
  }
}

function approvalPort(
  outcome: CapabilityApprovalOutcome,
  onRequest: () => void,
): NonNullable<CapabilityDispatcherPorts['approval']> {
  return {
    request: async (input) => {
      onRequest()
      const interaction = {
        interactionId: `youtube-${outcome}-interaction`,
        reused: false,
      }
      await input.onInteraction(interaction)
      return { outcome, interaction }
    },
  }
}

function actionFromToolCallId(toolCallId: string): YoutubeAction {
  const action = toolCallId.slice('classify:'.length)
  if ([...READ_ACTIONS, ...MUTATING_ACTIONS].includes(action as YoutubeAction)) {
    return action as YoutubeAction
  }
  throw new Error(`Unexpected YouTube action ${action}`)
}

function parseJsonRecord(line: string): Readonly<Record<string, unknown>> & {
  readonly payload?: Readonly<Record<string, unknown>>
} {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value)) throw new Error('Expected a JSON record.')
  const payload = value.payload
  if (payload !== undefined && !isRecord(payload)) {
    throw new Error('Expected a JSON payload record.')
  }
  return payload === undefined ? value : { ...value, payload }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assignmentSwapScheduler(paths: {
  readonly assignmentPath: string
  readonly originalPath: string
  readonly outsidePath: string
}): CapabilityExecutionSchedulerPort {
  let swapped = false
  return {
    run: async <T>(input: {
      readonly scopeKey: string
      readonly effect: CapabilityEffect
      readonly signal: AbortSignal
      readonly operation: () => Promise<T>
    }): Promise<T> => {
      if (!swapped) {
        swapped = true
        await fs.rename(paths.assignmentPath, paths.originalPath)
        await fs.symlink(paths.outsidePath, paths.assignmentPath, 'dir')
      }
      return input.operation()
    },
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  return fs.access(targetPath).then(
    () => true,
    () => false,
  )
}

async function writeAuthenticatedManifest(assignmentPath: string): Promise<void> {
  const outputPath = path.join(assignmentPath, 'output')
  await fs.mkdir(outputPath, { recursive: true })
  await fs.writeFile(path.join(outputPath, 'youtube-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    source: {
      type: 'video',
      id: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Authenticated source',
    },
    options: {
      languages: ['en'],
      limit: 1,
      includeShorts: false,
      minDurationSeconds: 0,
    },
    startedAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    videos: [{
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Authenticated source',
      status: 'auth_required',
      attempts: 1,
    }],
  }, null, 2)}\n`, { mode: 0o600 })
}
