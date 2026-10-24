import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import {
  McpWorkerTurnClientError,
  providerErrorFromWorkerFailure,
  runMcpWorkerTurn,
} from '../../domains/mcp/mcp-worker-turn-client.js'
import {
  ProviderError,
  usageLimitResetAt,
} from '../../domains/provider/provider-error.js'
import {
  MCP_WORKER_ACTIVITY_SCOPE_ID_ENV,
  MCP_WORKER_AGENT_DISPLAY_NAME_ENV,
  MCP_WORKER_TURN_CONTRACT_VERSION,
  MCP_WORKER_TURN_URL_ENV,
  MCP_WORKER_WORKFLOW_STEP_ID_ENV,
} from '../../domains/mcp/mcp-worker-turn.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_SESSION_ID_ENV,
} from '../../domains/runtime/runtime-paths.js'

test('MCP worker client waits for a delayed approved turn and propagates its activity scope', async () => {
  let received: Record<string, unknown> | undefined
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          version: MCP_WORKER_TURN_CONTRACT_VERSION,
          kind: 'completed',
          text: 'Scoped browser result.',
          model: 'fixture/tool-loop',
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          availableToolCount: 1,
          toolCallCount: 1,
          executedToolCallCount: 1,
        }))
      }, 125)
    })
  })
  await listen(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const environment = {
    [MCP_WORKER_TURN_URL_ENV]:
      `http://127.0.0.1:${address.port}/worker-turn`,
    [MCP_WORKER_ACTIVITY_SCOPE_ID_ENV]: 'lane-market',
    [MCP_WORKER_AGENT_DISPLAY_NAME_ENV]: 'Market Evidence Analyst',
    [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: 'research-step',
    [RUNTIME_SESSION_ID_ENV]: '11111111-1111-4111-8111-111111111111',
    [RUNTIME_RUN_ID_ENV]: 'run-research',
    [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-research',
    TEAM_RUNTIME_TASK_ID: 'task-research',
    TEAM_RUNTIME_PROCESS_IDENTITY: 'process-research',
    TEAM_RUNTIME_WORKFLOW_ID: 'research-workflow',
  }

  try {
    const result = await runMcpWorkerTurn({
      options: {
        agentName: 'web-researcher',
        model: 'fixture/tool-loop',
        thinking: 'medium',
        systemPrompt: 'Use the browser.',
        timeoutMinutes: 20,
        userMessage: 'Collect market evidence.',
      },
      provider: 'openai',
      environment,
    })
    assert.equal(result?.kind, 'completed')
    assert.equal(received?.activityScopeId, 'lane-market')
    assert.equal(received?.agentDisplayName, 'Market Evidence Analyst')
    assert.deepEqual(Object.keys(received ?? {}).sort(), [
      'activityScopeId',
      'agentDisplayName',
      'agentPath',
      'assignmentId',
      'model',
      'processIdentity',
      'provider',
      'runId',
      'sessionId',
      'systemPrompt',
      'taskId',
      'thinking',
      'userMessage',
      'version',
      'workflowId',
      'workflowStepId',
    ])
  } finally {
    await close(server)
  }
})

test('MCP worker client keeps a delayed loopback turn cancellable', async () => {
  let disconnectedBeforeReply = false
  let replyTimer: ReturnType<typeof setTimeout> | undefined
  const server = http.createServer((_request, response) => {
    response.once('close', () => {
      disconnectedBeforeReply = !response.writableEnded
    })
    replyTimer = setTimeout(() => {
      if (response.destroyed) return
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        version: MCP_WORKER_TURN_CONTRACT_VERSION,
        kind: 'completed',
        text: 'Late result.',
        model: 'fixture/slow',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        availableToolCount: 0,
        toolCallCount: 0,
        executedToolCallCount: 0,
      }))
    }, 1_000)
  })
  await listen(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), 50)

  try {
    await assert.rejects(
      runMcpWorkerTurn({
        options: {
          agentName: 'web-researcher',
          model: 'fixture/slow',
          thinking: 'medium',
          systemPrompt: 'Wait for the parent.',
          timeoutMinutes: 20,
          userMessage: 'Return later.',
        },
        provider: 'openai',
        signal: controller.signal,
        environment: {
          [MCP_WORKER_TURN_URL_ENV]:
            `http://127.0.0.1:${address.port}/worker-turn`,
          [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: 'research-step',
          [RUNTIME_SESSION_ID_ENV]: '11111111-1111-4111-8111-111111111111',
          [RUNTIME_RUN_ID_ENV]: 'run-research',
          [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-research',
          TEAM_RUNTIME_TASK_ID: 'task-research',
          TEAM_RUNTIME_PROCESS_IDENTITY: 'process-research',
          TEAM_RUNTIME_WORKFLOW_ID: 'research-workflow',
        },
      }),
      (error: unknown) =>
        error instanceof Error && error.name === 'AbortError',
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(disconnectedBeforeReply, true)
  } finally {
    clearTimeout(abortTimer)
    if (replyTimer) clearTimeout(replyTimer)
    await close(server)
  }
})

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}


test('a worker failure carrying a provider identity is rebuilt as a typed provider error', () => {
  // The attempt loop classifies on ProviderError and defaults everything else to
  // retryable, so an opaque bridge error means a truncated turn is retried
  // against the same token ceiling and a stalled turn loses its diagnosis.
  const truncated = providerErrorFromWorkerFailure(
    new McpWorkerTurnClientError(
      new Error('Worker endpoint returned HTTP 500.'),
      'execution_failed',
      'provider_truncated',
      false,
    ),
    'openai',
  )
  assert.ok(truncated instanceof ProviderError)
  assert.equal(truncated.code, 'provider_truncated')
  assert.equal(truncated.retryable, false)

  const stalled = providerErrorFromWorkerFailure(
    new McpWorkerTurnClientError(
      new Error('Worker endpoint returned HTTP 500.'),
      'execution_failed',
      'provider_stalled',
      true,
    ),
    'codex',
  )
  assert.ok(stalled instanceof ProviderError)
  assert.equal(stalled.code, 'provider_stalled')
  assert.equal(stalled.retryable, true)

  // A bridge failure with no provider identity stays a bridge failure. Dressing
  // it up as a provider error would let the attempt loop classify a transport
  // fault as a model fault.
  assert.equal(
    providerErrorFromWorkerFailure(
      new McpWorkerTurnClientError(new Error('socket closed')),
      'openai',
    ),
    undefined,
  )
})

test('worker client reports a worker-turn failure without implying configured MCP', () => {
  // Built-in Browser and Research Web calls travel through the historically
  // MCP-named worker transport. Naming MCP in the failure sends every reader
  // hunting for an external server that the run never configured.
  const error = new McpWorkerTurnClientError(
    new Error('Worker endpoint returned HTTP 502.'),
    'execution_failed',
    'provider_failed',
    true,
  )

  assert.equal(
    error.message,
    'Parent worker turn failed: execution_failed (provider_failed).',
  )
  assert.doesNotMatch(error.message, /MCP/)
  // The structured identity is what the attempt loop classifies on; neutral
  // wording must not cost it.
  assert.equal(error.code, 'execution_failed')
  assert.equal(error.providerCode, 'provider_failed')
  assert.equal(error.retryable, true)
})

test('the child sends the Agent’s behavioural settings, and only those', async () => {
  // An Agent's settings have to reach the lane that decides whether they apply,
  // or a Team or workflow turn silently answers differently from the same Agent
  // run any other way. What must *not* travel is anything naming where the
  // request goes, who it claims to be from, or what the process may do: the
  // parent signs the request with its own credentials, and the request is
  // exact-field validated so an unrecognised name is refused outright — which
  // would turn every ordinary Agent with a `base_url` into a failed turn.
  let received: Record<string, unknown> | undefined
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        version: MCP_WORKER_TURN_CONTRACT_VERSION,
        kind: 'completed',
        text: 'Answered.',
        model: 'fixture/tool-loop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        availableToolCount: 1,
        toolCallCount: 0,
        executedToolCallCount: 0,
        droppedProviderOptions: ['max_tokens'],
      }))
    })
  })
  await listen(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  try {
    const result = await runMcpWorkerTurn({
      options: {
        agentName: 'optionswriter',
        model: 'fixture/tool-loop',
        thinking: 'medium',
        systemPrompt: 'Answer.',
        timeoutMinutes: 20,
        userMessage: 'A question.',
        providerConfig: {
          max_steps_per_turn: 12,
          max_tokens: 4_096,
          base_url: 'https://elsewhere.invalid/v1',
          sandbox: 'danger-full-access',
        },
      },
      provider: 'kimi-cli',
      environment: {
        [MCP_WORKER_TURN_URL_ENV]:
          `http://127.0.0.1:${address.port}/worker-turn`,
        [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: 'options-step',
        [RUNTIME_SESSION_ID_ENV]: '11111111-1111-4111-8111-111111111111',
        [RUNTIME_RUN_ID_ENV]: 'run-options',
        [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-options',
        TEAM_RUNTIME_TASK_ID: 'task-options',
        TEAM_RUNTIME_PROCESS_IDENTITY: 'process-options',
        TEAM_RUNTIME_WORKFLOW_ID: 'options-workflow',
      },
    })

    assert.equal(result?.kind, 'completed')
    assert.deepEqual(
      received?.providerOptions,
      { max_steps_per_turn: 12, max_tokens: 4_096 },
      'the settings that describe how to answer travel, and nothing else does',
    )
    assert.deepEqual(
      result?.kind === 'completed' ? result.droppedProviderOptions : undefined,
      ['max_tokens'],
      "the lane's account of what it did not apply reaches the child",
    )
  } finally {
    await close(server)
  }
})

test('a classified provider refusal reaches the attempt loop as a non-retryable provider error', () => {
  // An exhausted quota is the case that made this necessary. The worker service
  // classifies it and answers `retryable: false`, but every code except
  // truncated and stalled used to leave the client without a ProviderError, and
  // `classifyDispatchRetryability` defaults everything else to retryable — so
  // the run spent all three attempts proving a wall was still a wall.
  const exhausted = providerErrorFromWorkerFailure(
    new McpWorkerTurnClientError(
      new Error('Worker endpoint returned HTTP 502.'),
      'execution_failed',
      'provider_failed',
      false,
      'usage_limit',
    ),
    'codex',
  )

  assert.ok(exhausted instanceof ProviderError)
  assert.equal(exhausted.kind, 'usage_limit')
  assert.equal(exhausted.retryable, false)
  // This build's sentence, not the provider's: the reset time, the account URL
  // and everything else the CLI printed stayed in the orchestrator.
  assert.match(exhausted.message, /usage limit/i)
  assert.doesNotMatch(exhausted.message, /https?:\/\//)

  // A verdict of retryable is equally the worker's to make.
  const overloaded = providerErrorFromWorkerFailure(
    new McpWorkerTurnClientError(
      new Error('Worker endpoint returned HTTP 502.'),
      'execution_failed',
      'provider_failed',
      true,
      'overloaded',
    ),
    'codex',
  )
  assert.ok(overloaded instanceof ProviderError)
  assert.equal(overloaded.retryable, true)
})

test('a classified worker failure leads with what the reader can act on', () => {
  const error = new McpWorkerTurnClientError(
    new Error('Worker endpoint returned HTTP 502.'),
    'execution_failed',
    'provider_failed',
    false,
    'usage_limit',
  )

  assert.match(
    error.message,
    /^You've hit your provider usage limit\. Try again after it resets\. Parent worker turn failed: execution_failed \(provider_failed\)\.$/,
  )
  // The codes an operator greps for survive the added sentence.
  assert.equal(error.code, 'execution_failed')
  assert.equal(error.providerCode, 'provider_failed')
  assert.equal(error.providerKind, 'usage_limit')
})

/**
 * A usage limit's reset has to survive the parent-to-child process boundary.
 *
 * A Team member's turn runs in the parent and fails there, so the moment the
 * quota comes back is known on that side and nowhere else. The child is what
 * journals the failure, so a reset that stops at this boundary is one the
 * health view can never expire on — the limit would stand until an allowance
 * reading disproved it, which exists for Codex alone.
 *
 * The sentence and the instant travel separately on purpose. The sentence is
 * what a person reads in the transcript; the instant is what a badge compares
 * against a clock, and a sentence compared against a clock is a timezone bug
 * waiting to happen.
 */
test('a reset instant crosses the worker boundary and reaches the failure record', () => {
  const resetsAt = '2026-09-20T01:00:00.000Z'
  const rebuilt = providerErrorFromWorkerFailure(
    new McpWorkerTurnClientError(
      undefined,
      'execution_failed',
      'provider_usage_limit',
      false,
      'usage_limit',
      'Sep 20, 2026 at 1:00 AM',
      resetsAt,
    ),
    'codex',
  )

  assert.ok(rebuilt instanceof ProviderError)
  assert.equal(rebuilt.kind, 'usage_limit')
  assert.equal(
    usageLimitResetAt(rebuilt, new Date('2026-09-19T20:00:00.000Z')),
    resetsAt,
    'the instant survives, without being re-read from any sentence',
  )
})

test('a worker failure that carried no instant yields none', () => {
  // Nothing is reconstructed from the display sentence: it has no zone and no
  // year, and this side of the boundary has a different clock.
  const rebuilt = providerErrorFromWorkerFailure(
    new McpWorkerTurnClientError(
      undefined,
      'execution_failed',
      'provider_usage_limit',
      false,
      'usage_limit',
      'Sep 20, 2026 at 1:00 AM',
    ),
    'codex',
  )

  assert.ok(rebuilt instanceof ProviderError)
  assert.equal(
    usageLimitResetAt(rebuilt, new Date('2026-09-19T20:00:00.000Z')),
    undefined,
  )
})

test('the reader accepts the instant under the name the worker sends it by', async () => {
  // A reader-side guard only: the response below is handwritten, so this says
  // nothing about whether the route still sends the field. What proves the
  // whole chain — origin, both senders, reader — is the real-services
  // regression in `tests/integration/mcp-worker-turn-dispatch-evidence.test.ts`.
  //
  // Kept because the two halves live in different files and neither compiler
  // nor schema would notice a name that drifted on this side alone.
  const resetsAt = '2026-09-20T01:00:00.000Z'
  const server = http.createServer((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      error: 'MCP worker turn failed',
      code: 'execution_failed',
      retryable: false,
      providerCode: 'provider_usage_limit',
      providerKind: 'usage_limit',
      resetsAt: 'Sep 20, 2026 at 1:00 AM',
      resetsAtInstant: resetsAt,
    }))
  })
  await listen(server)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  try {
    await assert.rejects(
      runMcpWorkerTurn({
        options: {
          agentName: 'web-researcher',
          model: 'fixture/tool-loop',
          thinking: 'medium',
          systemPrompt: 'Answer.',
          timeoutMinutes: 20,
          userMessage: 'A question.',
        },
        provider: 'codex',
        environment: {
          [MCP_WORKER_TURN_URL_ENV]:
            `http://127.0.0.1:${address.port}/worker-turn`,
          [MCP_WORKER_ACTIVITY_SCOPE_ID_ENV]: 'lane-limited',
          [MCP_WORKER_AGENT_DISPLAY_NAME_ENV]: 'Web Researcher',
          [MCP_WORKER_WORKFLOW_STEP_ID_ENV]: 'research-step',
          [RUNTIME_SESSION_ID_ENV]: '11111111-1111-4111-8111-111111111111',
          [RUNTIME_RUN_ID_ENV]: 'run-limited',
          [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-limited',
          TEAM_RUNTIME_TASK_ID: 'task-limited',
          TEAM_RUNTIME_PROCESS_IDENTITY: 'process-limited',
          TEAM_RUNTIME_WORKFLOW_ID: 'research-workflow',
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof McpWorkerTurnClientError)
        assert.equal(error.resetsAtInstant, resetsAt)
        const rebuilt = providerErrorFromWorkerFailure(error, 'codex')
        assert.equal(
          usageLimitResetAt(rebuilt, new Date('2026-09-19T20:00:00.000Z')),
          resetsAt,
        )
        return true
      },
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
