/**
 * Deep Research worker attempt records (P1).
 *
 * Contract: every concrete primary dispatch attempt for a research worker
 * persists its exact prompt, raw response, and classified outcome under
 * `.runtime/worker-logs/<laneId>/<taskId>-attempt-<n>/` with private-tier
 * permissions, and those paths stay unreachable from the public artifact tree.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { mock } from 'node:test'

import type { DispatchOptions } from '../../domains/agent-execution/agent-runner.js'
import { resolveOwnedRunRelativePath } from '../../domains/runtime/runtime-paths.js'

// Mutable implementation that tests can swap
let dispatchImpl: (options: DispatchOptions) => Promise<{ text: string; cost: number }> =
  async () => ({ text: '', cost: 0 })

mock.module('../../domains/agent-execution/agent-runner.js', {
  namedExports: {
    dispatchToAgentOrTeam: mock.fn(async (options: DispatchOptions) => dispatchImpl(options)),
  },
})

mock.module('../../domains/runtime/circuit-breaker.js', {
  namedExports: {
    globalCircuitBreaker: {
      check: () => ({ allowed: true }),
      recordSuccess: () => {},
      recordFailure: () => {},
    },
  },
})

const {
  dispatchWithFailurePolicy,
  HaltError,
  DispatchResultValidationError,
} = await import('../../domains/agent-execution/failure-policy.js')
const {
  persistDeepResearchWorkerAttemptRecord,
  appendDeepResearchWorkerFailure,
} = await import('../../domains/deep-research/deep-research-worker-logging.js')
const {
  createDeepResearchWorkerAttemptObservers,
} = await import('../../domains/deep-research/deep-research-attempt-observers.js')

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAssignment(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-attempt-log-'))
}

function makeAgent() {
  return {
    name: 'web-researcher',
    model: 'model-x',
    thinking: 'medium' as const,
    systemPrompt: 'base prompt',
    experienceContent: '',
    experienceEnabled: false,
    skillsContent: '',
    knowledgeContent: '',
    agentDir: '/tmp',
    color: 36,
    provider: 'test-provider',
    providerConfig: {},
  }
}

function makeDispatchOptions(dir: string, extra: Record<string, unknown> = {}) {
  return {
    agent: makeAgent(),
    rosterEntry: undefined,
    finalPrompt: 'SYSTEM PROMPT BASE',
    userMessage: 'BASE USER MESSAGE',
    state: {
      sessionId: 'sess-1',
      currentLevelIndex: 0,
      levelStates: new Map(),
      totalCost: 0,
      startTime: 0,
      timerStarted: false,
      endTime: null,
      spawnDepth: 0,
    },
    workspacePath: dir,
    outputPath: dir,
    inputFilesContent: '',
    metrics: undefined,
    policy: { policy: 'retry' as const, maxRetries: 2 },
    levelId: 'execution',
    stageType: 'pipeline',
    sessionId: 'sess-1',
    errorLogPath: dir,
    ...extra,
  }
}

function attemptDir(assignmentPath: string, laneId: string, taskId: string, attempt: number): string {
  return path.join(
    assignmentPath,
    '.runtime',
    'worker-logs',
    laneId,
    `${taskId}-attempt-${attempt}`,
  )
}

function readOutcome(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'outcome.json'), 'utf8')) as Record<string, unknown>
}

// ─── Writer contract ─────────────────────────────────────────────────────────

test('rejected attempt record persists prompt, raw response, and classified outcome privately', () => {
  const assignmentPath = makeAssignment()
  try {
    persistDeepResearchWorkerAttemptRecord({
      assignmentPath,
      laneId: 'lane-market',
      taskId: 'T1',
      attempt: 2,
      systemPrompt: 'SYSTEM POLICY TEXT',
      userMessage: 'TASK MESSAGE\n\n# Runtime Validation Feedback\n\nretry hint',
      responseText: '{"raw":"provider output"}',
      outcome: 'rejected',
      validator: {
        name: 'DeepResearchValidationError',
        field: 'source.contentSha256',
        message: 'source.contentSha256 must be a lowercase SHA-256 digest',
        category: 'response_schema_invalid',
      },
      attemptStartedAtMs: Date.now() - 5_000,
      elapsedMs: 5_000,
    })

    const dir = attemptDir(assignmentPath, 'lane-market', 'T1', 2)
    assert.ok(fs.statSync(dir).isDirectory())
    const prompt = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8')
    assert.match(prompt, /SYSTEM POLICY TEXT/)
    assert.match(prompt, /TASK MESSAGE/)
    assert.match(prompt, /Runtime Validation Feedback/)
    assert.equal(fs.readFileSync(path.join(dir, 'response.txt'), 'utf8'), '{"raw":"provider output"}')

    const outcome = readOutcome(dir)
    assert.equal(outcome.outcome, 'rejected')
    assert.equal(outcome.task_id, 'T1')
    assert.equal(outcome.lane_id, 'lane-market')
    assert.equal(outcome.attempt, 2)
    assert.equal(outcome.elapsed_ms, 5_000)
    assert.equal(typeof outcome.started_at, 'string')
    assert.deepEqual(outcome.validator, {
      name: 'DeepResearchValidationError',
      field: 'source.contentSha256',
      message: 'source.contentSha256 must be a lowercase SHA-256 digest',
      category: 'response_schema_invalid',
    })

    // Private-tier permissions: 0600 files, 0700 directories.
    assert.equal(fs.statSync(path.join(dir, 'prompt.md')).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(dir, 'response.txt')).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(dir, 'outcome.json')).mode & 0o777, 0o600)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.equal(
      fs.statSync(path.join(assignmentPath, '.runtime', 'worker-logs', 'lane-market')).mode & 0o777,
      0o700,
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('no-response attempt writes outcome without response.txt', () => {
  const assignmentPath = makeAssignment()
  try {
    persistDeepResearchWorkerAttemptRecord({
      assignmentPath,
      laneId: 'lane-market',
      taskId: 'T3',
      attempt: 2,
      systemPrompt: 'SYSTEM POLICY TEXT',
      userMessage: 'TASK MESSAGE',
      outcome: 'no_response',
      validator: {
        name: 'ProviderError',
        message: 'Agent "web-researcher" timed out after 679372ms',
        category: 'provider_timeout',
      },
      attemptStartedAtMs: Date.now(),
      elapsedMs: 679_372,
    })

    const dir = attemptDir(assignmentPath, 'lane-market', 'T3', 2)
    assert.ok(fs.existsSync(path.join(dir, 'prompt.md')))
    assert.equal(fs.existsSync(path.join(dir, 'response.txt')), false)
    assert.equal(readOutcome(dir).outcome, 'no_response')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('attempt without task id or attempt number routes to attempt-unknown, never an undefined path segment', () => {
  const assignmentPath = makeAssignment()
  try {
    persistDeepResearchWorkerAttemptRecord({
      assignmentPath,
      laneId: 'lane-market',
      systemPrompt: 'SYSTEM POLICY TEXT',
      userMessage: 'TASK MESSAGE',
      outcome: 'rejected',
      validator: {
        name: 'McpAgentToolServiceError',
        message: 'Deep Research worker did not return receipt-backed managed-browser evidence.',
        category: 'no_browser_observation',
      },
      attemptStartedAtMs: Date.now(),
      elapsedMs: 1_000,
    })

    const unknownDir = path.join(
      assignmentPath,
      '.runtime',
      'worker-logs',
      'lane-market',
      'attempt-unknown',
    )
    assert.ok(fs.statSync(unknownDir).isDirectory())
    assert.ok(fs.existsSync(path.join(unknownDir, 'outcome.json')))
    assert.equal(fs.existsSync(path.join(unknownDir, 'response.txt')), false)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('resume collision suffixes a new attempt directory instead of overwriting', () => {
  const assignmentPath = makeAssignment()
  try {
    const base = { assignmentPath, laneId: 'lane-market', taskId: 'T1', attempt: 1 }
    persistDeepResearchWorkerAttemptRecord({
      ...base,
      systemPrompt: 'SYSTEM',
      userMessage: 'FIRST PASS',
      responseText: 'first response',
      outcome: 'rejected',
      attemptStartedAtMs: Date.now(),
      elapsedMs: 1,
    })
    persistDeepResearchWorkerAttemptRecord({
      ...base,
      systemPrompt: 'SYSTEM',
      userMessage: 'SECOND PASS',
      responseText: 'second response',
      outcome: 'rejected',
      attemptStartedAtMs: Date.now(),
      elapsedMs: 1,
    })

    const first = attemptDir(assignmentPath, 'lane-market', 'T1', 1)
    assert.equal(fs.readFileSync(path.join(first, 'response.txt'), 'utf8'), 'first response')
    const second = `${first}-r2`
    assert.ok(fs.statSync(second).isDirectory())
    assert.equal(fs.readFileSync(path.join(second, 'response.txt'), 'utf8'), 'second response')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('observation timing statistics are derived from receipts created during the attempt', () => {
  const assignmentPath = makeAssignment()
  try {
    const observationsDir = path.join(
      assignmentPath,
      'research',
      'observations',
      'lane-market',
    )
    fs.mkdirSync(observationsDir, { recursive: true })
    const receiptPath = path.join(observationsDir, 'receipt-one.json')
    fs.writeFileSync(receiptPath, '{}')
    const startedAt = Date.now() - 60_000
    const hourAgo = new Date(Date.now() - 3_600_000).getTime()
    fs.utimesSync(receiptPath, new Date(hourAgo), new Date(hourAgo))
    fs.writeFileSync(path.join(observationsDir, 'receipt-two.json'), '{}')

    persistDeepResearchWorkerAttemptRecord({
      assignmentPath,
      laneId: 'lane-market',
      taskId: 'T1',
      attempt: 1,
      systemPrompt: 'SYSTEM',
      userMessage: 'TASK',
      responseText: '{}',
      outcome: 'accepted',
      attemptStartedAtMs: startedAt,
      elapsedMs: 60_000,
    })

    const outcome = readOutcome(attemptDir(assignmentPath, 'lane-market', 'T1', 1))
    const observations = outcome.observations as Record<string, unknown>
    assert.equal(observations.count, 1)
    assert.equal(typeof observations.time_to_first_observation_ms, 'number')
    assert.equal(observations.observations_per_minute, 1)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('retention prunes the oldest attempt directories beyond the configured budget', () => {
  const assignmentPath = makeAssignment()
  try {
    for (let attempt = 1; attempt <= 14; attempt += 1) {
      persistDeepResearchWorkerAttemptRecord({
        assignmentPath,
        laneId: 'lane-market',
        taskId: 'T1',
        attempt,
        systemPrompt: 'SYSTEM',
        userMessage: `ATTEMPT ${attempt}`,
        responseText: `response ${attempt}`,
        outcome: 'rejected',
        attemptStartedAtMs: Date.now(),
        elapsedMs: 1,
      })
      const stamp = new Date(Date.now() - (20 - attempt) * 1_000)
      fs.utimesSync(attemptDir(assignmentPath, 'lane-market', 'T1', attempt), stamp, stamp)
    }
    const laneDir = path.join(assignmentPath, '.runtime', 'worker-logs', 'lane-market')
    const attemptDirs = fs.readdirSync(laneDir).filter((name) => name.includes('attempt'))
    assert.equal(attemptDirs.length, 12)
    assert.ok(attemptDirs.includes('T1-attempt-14'))
    assert.ok(attemptDirs.includes('T1-attempt-3'))
    assert.equal(attemptDirs.includes('T1-attempt-1'), false)
    assert.equal(attemptDirs.includes('T1-attempt-2'), false)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('validation.jsonl failure entries index the attempt directory', () => {
  const assignmentPath = makeAssignment()
  try {
    appendDeepResearchWorkerFailure({
      assignmentPath,
      laneId: 'lane-market',
      taskId: 'T1',
      attempt: 1,
      category: 'binding_invalid',
      attemptDirName: 'T1-attempt-1',
    })
    const line = fs.readFileSync(
      path.join(assignmentPath, '.runtime', 'worker-logs', 'lane-market', 'validation.jsonl'),
      'utf8',
    ).trim()
    const parsed = JSON.parse(line) as Record<string, unknown>
    assert.equal(parsed.attempt_dir, 'T1-attempt-1')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('private runtime attempt paths are rejected by the public artifact resolver', () => {
  const assignmentPath = makeAssignment()
  try {
    assert.throws(
      () => resolveOwnedRunRelativePath({
        assignmentPath,
        relativePath: '.runtime/worker-logs/lane-market/T1-attempt-1/prompt.md',
        label: 'Attempt record',
      }),
      /private runtime/,
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

// ─── Failure-policy capture point ────────────────────────────────────────────

test('dispatchWithFailurePolicy reports every primary attempt with prompt, response, and error', async () => {
  const assignmentPath = makeAssignment()
  try {
    const recorded: Array<Record<string, unknown>> = []
    let attempt = 0
    dispatchImpl = async () => {
      attempt += 1
      if (attempt === 1) return { text: 'RAW PACKET ATTEMPT 1', cost: 0 }
      throw new Error('provider crashed')
    }

    await assert.rejects(
      dispatchWithFailurePolicy(makeDispatchOptions(assignmentPath, {
        policy: { policy: 'retry', maxRetries: 1 },
        onAttemptRecord: (record: Record<string, unknown>) => recorded.push(record),
        validateResult: (text: string) => {
          if (text === 'RAW PACKET ATTEMPT 1') {
            throw new DispatchResultValidationError('invalid packet', 'response_schema_invalid', 'fix it')
          }
          return text
        },
      }) as never) as Promise<never>,
      (error: unknown) => error instanceof HaltError,
    )

    assert.equal(recorded.length, 2)
    const rejected = recorded[0] as Record<string, unknown>
    assert.equal(rejected.attempt, 1)
    assert.equal(rejected.agentName, 'web-researcher')
    assert.equal(rejected.prompt, 'SYSTEM PROMPT BASE')
    assert.equal(rejected.userMessage, 'BASE USER MESSAGE')
    assert.equal(rejected.responseText, 'RAW PACKET ATTEMPT 1')
    assert.equal((rejected.error as Error).name, 'DispatchResultValidationError')
    assert.equal(typeof rejected.elapsedMs, 'number')
    assert.equal(typeof rejected.attemptStartedAtMs, 'number')

    const noResponse = recorded[1] as Record<string, unknown>
    assert.equal(noResponse.attempt, 2)
    assert.equal(noResponse.responseText, undefined)
    assert.equal((noResponse.error as Error).message, 'provider crashed')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('accepted attempts report through the record hook without an error', async () => {
  const assignmentPath = makeAssignment()
  try {
    const recorded: Array<Record<string, unknown>> = []
    dispatchImpl = async () => ({ text: 'VALID PACKET', cost: 0 })
    await dispatchWithFailurePolicy(makeDispatchOptions(assignmentPath, {
      onAttemptRecord: (record: Record<string, unknown>) => recorded.push(record),
    }) as never)
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]?.error, undefined)
    assert.equal(recorded[0]?.responseText, 'VALID PACKET')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('retry instructions are recorded in the second attempt user message', async () => {
  const assignmentPath = makeAssignment()
  try {
    const recorded: Array<Record<string, unknown>> = []
    let attempt = 0
    dispatchImpl = async () => {
      attempt += 1
      return { text: `PACKET ${attempt}`, cost: 0 }
    }
    await assert.rejects(
      dispatchWithFailurePolicy(makeDispatchOptions(assignmentPath, {
        onAttemptRecord: (record: Record<string, unknown>) => recorded.push(record),
        validateResult: () => {
          throw new DispatchResultValidationError('invalid', 'binding_invalid', 'Correct field "x": wrong')
        },
      }) as never) as Promise<never>,
      (error: unknown) => error instanceof HaltError,
    )
    const second = recorded[1] as Record<string, unknown>
    assert.match(String(second.userMessage), /Runtime Validation Feedback/)
    assert.match(String(second.userMessage), /Correct field "x": wrong/)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

// ─── Pipeline observers wiring ───────────────────────────────────────────────

test('research observers persist the rejected attempt and index validation.jsonl', async () => {
  const assignmentPath = makeAssignment()
  try {
    const observers = createDeepResearchWorkerAttemptObservers({
      assignmentPath,
      laneId: 'lane-market',
      taskId: 'T1',
      sectionId: 'section-market',
      workerSpecHash: 'a'.repeat(64),
    })
    let attempt = 0
    dispatchImpl = async () => {
      attempt += 1
      return { text: attempt === 1 ? 'NOT JSON AT ALL' : 'ALSO NOT JSON', cost: 0 }
    }

    await assert.rejects(
      dispatchWithFailurePolicy(makeDispatchOptions(assignmentPath, {
        policy: { policy: 'retry', maxRetries: 1 },
        validateResult: observers.validateResult,
        onAttemptRecord: observers.onAttemptRecord,
        onAttemptFailure: observers.onAttemptFailure,
      }) as never) as Promise<never>,
      (error: unknown) => error instanceof HaltError,
    )

    const dir = attemptDir(assignmentPath, 'lane-market', 'T1', 1)
    assert.ok(fs.existsSync(path.join(dir, 'prompt.md')))
    assert.equal(
      fs.readFileSync(path.join(dir, 'response.txt'), 'utf8'),
      'NOT JSON AT ALL',
    )
    const outcome = readOutcome(dir)
    assert.equal(outcome.outcome, 'rejected')
    const validator = outcome.validator as Record<string, unknown>
    assert.equal(validator.category, 'response_schema_invalid')

    const validationLines = fs.readFileSync(
      path.join(assignmentPath, '.runtime', 'worker-logs', 'lane-market', 'validation.jsonl'),
      'utf8',
    ).trim().split('\n')
    assert.equal(validationLines.length, 2)
    const firstEntry = JSON.parse(validationLines[0]!) as Record<string, unknown>
    assert.equal(firstEntry.attempt_dir, 'T1-attempt-1')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

// ─── P5a: provider-symmetric tool traffic ────────────────────────────────────

test('tool-loop messages are persisted for providers without a protocol transcript', async () => {
  const { persistDeepResearchWorkerToolLoopMessages } = await import(
    '../../domains/deep-research/deep-research-worker-logging.js'
  )
  const assignmentPath = makeAssignment()
  try {
    fs.mkdirSync(path.join(assignmentPath, '.runtime'), { recursive: true })
    const laneLogDirectory = path.join(
      assignmentPath,
      '.runtime',
      'worker-logs',
      'lane-one',
    )
    fs.mkdirSync(laneLogDirectory, { recursive: true, mode: 0o700 })

    persistDeepResearchWorkerToolLoopMessages({
      laneLogDirectory,
      turnStartedAt: '2026-08-17T09:00:00.000Z',
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'runtime policy' },
        { role: 'user', content: 'approved assignment' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'call-1', name: 'research_web', arguments: { action: 'search' } }],
        },
        { role: 'tool', toolCallId: 'call-1', name: 'research_web', content: '{"ok":true}', isError: false },
      ],
    })

    const logPath = path.join(laneLogDirectory, 'logs', 'tool-loop-messages.jsonl')
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 4)
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.deepEqual(records.map((record) => record.sequence), [0, 1, 2, 3])
    assert.equal(records[0]?.model, 'deepseek-chat')
    // The tool call and its result — the traffic a lifecycle preview loses.
    assert.match(lines[2] ?? '', /research_web/)
    assert.match(lines[3] ?? '', /\\"ok\\":true/)
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('an oversized tool result is truncated rather than written whole', async () => {
  const { persistDeepResearchWorkerToolLoopMessages } = await import(
    '../../domains/deep-research/deep-research-worker-logging.js'
  )
  const assignmentPath = makeAssignment()
  try {
    fs.mkdirSync(path.join(assignmentPath, '.runtime'), { recursive: true })
    const laneLogDirectory = path.join(
      assignmentPath,
      '.runtime',
      'worker-logs',
      'lane-one',
    )
    fs.mkdirSync(laneLogDirectory, { recursive: true, mode: 0o700 })

    persistDeepResearchWorkerToolLoopMessages({
      laneLogDirectory,
      turnStartedAt: '2026-08-17T09:00:00.000Z',
      messages: [{ role: 'tool', content: 'x'.repeat(400_000) }],
    })

    const record = JSON.parse(
      fs.readFileSync(
        path.join(laneLogDirectory, 'logs', 'tool-loop-messages.jsonl'),
        'utf8',
      ).trim(),
    ) as Record<string, unknown>
    assert.equal(record.truncated, true)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

/**
 * D10: a lane whose provider stalled, timed out, or crashed writes an attempt
 * directory that nothing indexes, so the per-lane validation index reads as
 * "this lane produced no failures" when it produced nothing at all. The stall
 * aborts introduced alongside this are invisible without it.
 */
test('a non-validation attempt failure is still indexed for the lane', () => {
  const assignmentPath = makeAssignment()
  try {
    const observers = createDeepResearchWorkerAttemptObservers({
      assignmentPath,
      taskId: 'T1',
      sectionId: 'section-market',
      laneId: 'lane-market',
      workerSpecHash: 'a'.repeat(64),
    })
    observers.onAttemptFailure(
      'web-researcher',
      new Error(
        "Provider 'codex' emitted no protocol event for 130s and the silent turn was aborted.",
      ),
      1,
    )

    const indexPath = path.join(
      assignmentPath,
      '.runtime',
      'worker-logs',
      'lane-market',
      'validation.jsonl',
    )
    assert.equal(
      fs.existsSync(indexPath),
      true,
      'a provider failure that never reached validation is still a lane failure',
    )
    const parsed = JSON.parse(
      fs.readFileSync(indexPath, 'utf8').trim(),
    ) as Record<string, unknown>
    assert.equal(parsed.category, 'dispatch_failed')
    assert.equal(parsed.attempt, 1)
    assert.equal(parsed.lane_id, 'lane-market')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

test('a validation rejection keeps its specific category', () => {
  const assignmentPath = makeAssignment()
  try {
    const observers = createDeepResearchWorkerAttemptObservers({
      assignmentPath,
      taskId: 'T1',
      sectionId: 'section-market',
      laneId: 'lane-market',
      workerSpecHash: 'a'.repeat(64),
    })
    observers.onAttemptFailure(
      'web-researcher',
      new DispatchResultValidationError(
        'EvidencePacket did not match the schema.',
        'response_schema_invalid',
      ),
      1,
    )
    const parsed = JSON.parse(
      fs.readFileSync(
        path.join(
          assignmentPath,
          '.runtime',
          'worker-logs',
          'lane-market',
          'validation.jsonl',
        ),
        'utf8',
      ).trim(),
    ) as Record<string, unknown>
    assert.equal(parsed.category, 'response_schema_invalid')
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

/**
 * D12: the byte caps that keep a runaway prompt or response from filling the
 * private log had no coverage at all.
 */
test('an oversized prompt and response are truncated at the byte cap', () => {
  const assignmentPath = makeAssignment()
  try {
    const oversized = 'x'.repeat(2 * 1024 * 1024)
    persistDeepResearchWorkerAttemptRecord({
      assignmentPath,
      taskId: 'T1',
      laneId: 'lane-market',
      attempt: 1,
      systemPrompt: oversized,
      userMessage: 'brief',
      responseText: oversized,
      outcome: 'rejected',
      attemptStartedAtMs: Date.now(),
      elapsedMs: 10,
    })
    const attemptPath = path.join(
      assignmentPath,
      '.runtime',
      'worker-logs',
      'lane-market',
      'T1-attempt-1',
    )
    const promptBytes = fs.statSync(path.join(attemptPath, 'prompt.md')).size
    const responseBytes = fs.statSync(path.join(attemptPath, 'response.txt')).size
    assert.ok(
      promptBytes <= 1_048_576,
      `prompt.md is ${promptBytes} bytes, above the 1 MiB cap`,
    )
    assert.ok(
      responseBytes <= 1_048_576,
      `response.txt is ${responseBytes} bytes, above the 1 MiB cap`,
    )
    assert.ok(promptBytes > 0 && responseBytes > 0)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})
