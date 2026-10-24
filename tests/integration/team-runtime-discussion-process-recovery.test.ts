import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  readCheckpoint,
  restoreLevelStatesFromCheckpoint,
  writeCheckpoint,
} from '../../domains/runtime/checkpoint.js'
import { readTeamChatMessages } from '../../domains/runtime/team-chat-messages.js'
import { STAGE_LIFECYCLE_STATUS, STAGE_TYPE } from '../../core/constants.js'
import {
  MAX_COORDINATOR_CALL_ATTEMPTS,
  durableCoordinatorCallReceiptPath,
} from '../../team-runtime/durable-coordinator-call.js'
import { ASSIGNMENT_LOG, readAssignmentJsonl } from '../support/team-runtime-fixture-boot.js'

const repoRoot = process.cwd()

interface ProcessOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

interface RunningWorker {
  readonly child: ChildProcess
  readonly outcome: Promise<ProcessOutcome>
}

function writeAgent(filePath: string, name: string, role: string): void {
  fs.writeFileSync(
    filePath,
    `---
name: ${name}
description: ${role}
provider: claude
model: claude-haiku-4-5
thinking: low
---

You are ${name}. ${role}
`,
  )
}

function startWorker(env: NodeJS.ProcessEnv, detached: boolean): RunningWorker {
  const workerPath = path.join(
    repoRoot,
    '.tests-dist',
    'tests',
    'support',
    'team-runtime-discussion-recovery-worker.js',
  )
  assert.ok(fs.existsSync(workerPath), `Missing compiled process fixture: ${workerPath}`)
  const child = spawn(process.execPath, [workerPath], {
    cwd: repoRoot,
    detached,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { stdout += chunk })
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  const outcome = new Promise<ProcessOutcome>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { child, outcome }
}

function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  if (fs.existsSync(filePath)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const directory = path.dirname(filePath)
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      watcher.close()
      if (error) reject(error)
      else resolve()
    }
    const watcher = fs.watch(directory, () => {
      if (fs.existsSync(filePath)) finish()
    })
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${filePath}`)),
      timeoutMs,
    )
  })
}

/** `promise`, or a rejection naming `what` once `ms` has passed. */
async function withinDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(deadline)
  }
}

function countText(text: string, pattern: string): number {
  return text.split(pattern).length - 1
}

interface SingleMemberFixture {
  readonly assignmentPath: string
  readonly env: NodeJS.ProcessEnv
  readonly fixtureRoot: string
  readonly resultPath: string
}

function createSingleMemberFixture(input: {
  readonly prefix: string
  readonly fakeClaude: (paths: { markerPath: string; providerLog: string }) => string
  readonly maxTimeMinutes?: number
  /** Adds a second eligible participant, for roster-union cases. */
  readonly secondMember?: boolean
  /** Overrides `incoming-brief.md`, so a turn can carry conversation state. */
  readonly brief?: string
}): SingleMemberFixture {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), input.prefix))
  const teamRoot = path.join(fixtureRoot, 'team')
  const binRoot = path.join(fixtureRoot, 'bin')
  const workspace = path.join(fixtureRoot, 'workspace')
  const markerPath = path.join(fixtureRoot, 'participant-started')
  const providerLog = path.join(fixtureRoot, 'provider-log.txt')
  const resultPath = path.join(fixtureRoot, 'worker-result.json')
  fs.mkdirSync(path.join(teamRoot, 'agents'), { recursive: true })
  fs.mkdirSync(binRoot, { recursive: true })
  writeAgent(path.join(teamRoot, 'agents', 'lead.md'), 'lead', 'Coordinates the discussion.')
  writeAgent(path.join(teamRoot, 'agents', 'member.md'), 'member', 'Reviews the material.')
  if (input.secondMember) {
    writeAgent(
      path.join(teamRoot, 'agents', 'reviewer.md'),
      'reviewer',
      'Checks the code samples.',
    )
  }
  const secondAgentBlock = input.secondMember
    ? `  - name: reviewer
    type: agent
    role: Checks the code samples.
    tier: strategic
    tools: []
    agent_file: ./agents/reviewer.md
`
    : ''
  const secondParticipantLine = input.secondMember ? '        - reviewer\n' : ''
  const constraintLines = input.maxTimeMinutes === undefined
    ? ''
    : `        constraints:\n          max_time_minutes: ${input.maxTimeMinutes}\n`
  fs.writeFileSync(path.join(teamRoot, 'team.yaml'), `team:
  name: single-member-runtime-team
  description: Runtime terminal behavior fixture.

workspace:
  path: workspace
  watch: false

models:
  orchestration:
    provider: claude
    model: claude-haiku-4-5
    thinking: low
  strategic:
    provider: claude
    model: claude-haiku-4-5
    thinking: low

agents:
  - name: lead
    type: agent
    role: Coordinates the discussion.
    tier: orchestration
    tools: []
    agent_file: ./agents/lead.md
    produces:
      - path: result.md
  - name: member
    type: agent
    role: Reviews the material.
    tier: strategic
    tools: []
    agent_file: ./agents/member.md
${secondAgentBlock}
levels:
  - id: discuss
    name: Discuss
    order: 0
    stage:
      type: discussion
      coordinator: lead
      participants:
        - member
${secondParticipantLine}      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 1
        min_successful_participants: 1
${constraintLines}        output:
          format: result.md
          user_review: false

gates:
  - from: discuss
    to: done
    condition:
      type: artifact_exists
      artifact: result.md

workflow:
  entry_level: discuss
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
`)
  fs.writeFileSync(
    path.join(binRoot, 'claude'),
    input.fakeClaude({ markerPath, providerLog }),
    { mode: 0o700 },
  )
  const assignmentPath = path.join(
    workspace,
    'sessions',
    'session-single-member',
    'runs',
    'run-single-member',
    'assignments',
    'assignment-single-member',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  fs.writeFileSync(
    path.join(assignmentPath, 'incoming-brief.md'),
    input.brief ?? 'Evaluate this material.',
  )
  return {
    assignmentPath,
    fixtureRoot,
    resultPath,
    env: {
      ...process.env,
      PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      DISCUSSION_RECOVERY_REPO_ROOT: repoRoot,
      DISCUSSION_RECOVERY_RESULT_PATH: resultPath,
      PIPELINE_DURABLE_JOURNAL: 'authoritative',
      TEAM_CONFIG_PATH: path.join(teamRoot, 'team.yaml'),
      TEAM_WORKSPACE_PATH: workspace,
      TEAM_RUNTIME_START_SERVICES: '0',
      TEAM_RUNTIME_SESSION_ID: 'session-single-member',
      TEAM_RUNTIME_RUN_ID: 'run-single-member',
      TEAM_RUNTIME_ASSIGNMENT_ID: 'assignment-single-member',
      TEAM_RUNTIME_TASK_ID: 'task-single-member',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-single-member',
      TEAM_SESSION_ID: 'assignment-single-member',
      TEAM_ROOT_SESSION_ID: 'session-single-member',
      TEAM_INPUT_ARTIFACT: 'incoming-brief.md',
      TEAM_OUTPUT_ARTIFACT: 'unused-result.md',
      TEAM_DELEGATED_AUTOSTART: '1',
      TEAM_CHAT_MODE: '1',
      TEAM_TENANT_ID: 'local',
      TEAM_RUNTIME_FILE_PARSER_ENTRY: path.join(repoRoot, 'file-parser', 'index.ts'),
    },
  }
}

test('a replacement Team process resumes the same specialist pass without losing or repeating replies', {
  timeout: 30_000,
}, async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-process-recovery-'))
  const teamRoot = path.join(fixtureRoot, 'team')
  const binRoot = path.join(fixtureRoot, 'bin')
  const workspace = path.join(fixtureRoot, 'workspace')
  const providerLog = path.join(fixtureRoot, 'provider-completions.txt')
  const participantAttempts = path.join(fixtureRoot, 'participant-attempts.txt')
  const interruptedMarker = path.join(fixtureRoot, 'member-b-interrupted')
  const recoveredResult = path.join(fixtureRoot, 'recovered-result.json')
  fs.mkdirSync(path.join(teamRoot, 'agents'), { recursive: true })
  fs.mkdirSync(binRoot, { recursive: true })

  writeAgent(path.join(teamRoot, 'agents', 'lead.md'), 'lead', 'Coordinates the discussion.')
  writeAgent(path.join(teamRoot, 'agents', 'member-a.md'), 'member-a', 'Reviews teaching structure.')
  writeAgent(path.join(teamRoot, 'agents', 'member-b.md'), 'member-b', 'Reviews technical accuracy.')
  fs.writeFileSync(path.join(teamRoot, 'team.yaml'), `team:
  name: restart-safe-team
  description: Discussion process recovery fixture.

workspace:
  path: workspace
  watch: false

models:
  orchestration:
    provider: claude
    model: claude-haiku-4-5
    thinking: low
  strategic:
    provider: claude
    model: claude-haiku-4-5
    thinking: low

agents:
  - name: lead
    type: agent
    role: Coordinates the discussion.
    tier: orchestration
    tools: []
    agent_file: ./agents/lead.md
  - name: member-a
    type: agent
    role: Reviews teaching structure.
    tier: strategic
    tools: []
    agent_file: ./agents/member-a.md
  - name: member-b
    type: agent
    role: Reviews technical accuracy.
    tier: strategic
    tools: []
    agent_file: ./agents/member-b.md

levels:
  - id: discuss
    name: Discuss
    order: 0
    stage:
      type: discussion
      coordinator: lead
      participants:
        - member-a
        - member-b
      config:
        mode: deliberate
        min_rounds: 2
        max_rounds: 2
        min_successful_participants: 2
        output:
          format: result.md
          user_review: false

gates: []

workflow:
  entry_level: discuss
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
`)

  fs.writeFileSync(path.join(binRoot, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs')
const hasSchema = process.argv.includes('--json-schema')
const readLines = (filePath) => fs.existsSync(filePath)
  ? fs.readFileSync(filePath, 'utf8').trim().split('\\n').filter(Boolean)
  : []
if (hasSchema) {
  const coordinatorCount = readLines(${JSON.stringify(providerLog)})
    .filter((entry) => entry.startsWith('coordinator-')).length
  const structuredOutput = coordinatorCount === 0
    ? {
        agents: ['member-a', 'member-b'],
        rosterRationale: {
          'member-a': 'Teaching structure needs review.',
          'member-b': 'Technical accuracy needs review.',
        },
      }
    : coordinatorCount === 1
      ? {
          decision: 'continue',
          reason: 'The two reviews need a joint recommendation.',
          message: 'Produce the final joint recommendation.',
          targets: ['member-a', 'member-b'],
        }
      : {
          decision: 'complete',
          reason: 'Both required passes are complete.',
          finalResponse: 'Recovered lead synthesis.',
        }
  const label = coordinatorCount === 0
    ? 'coordinator-selection'
    : coordinatorCount === 1
      ? 'coordinator-continuation'
      : 'coordinator-completion'
  fs.appendFileSync(${JSON.stringify(providerLog)}, label + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: structuredOutput,
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  const promptFlag = process.argv.indexOf('--system-prompt-file')
  const systemPromptPath = promptFlag >= 0 ? process.argv[promptFlag + 1] : undefined
  const systemPrompt = systemPromptPath ? fs.readFileSync(systemPromptPath, 'utf8') : ''
  const target = systemPrompt.includes('You are member-a.')
    ? 'member-a'
    : systemPrompt.includes('You are member-b.')
      ? 'member-b'
      : undefined
  if (!target) throw new Error('Participant invocation did not identify member-a or member-b')
  fs.appendFileSync(${JSON.stringify(participantAttempts)}, target + '-attempt\\n')
  if (target === 'member-b' && !fs.existsSync(${JSON.stringify(interruptedMarker)})) {
    fs.writeFileSync(${JSON.stringify(interruptedMarker)}, 'member-b started')
    setInterval(() => {}, 60_000)
  } else {
    const passNumber = readLines(${JSON.stringify(providerLog)})
      .filter((entry) => entry.startsWith(target + '-pass-')).length + 1
    if (passNumber > 2) throw new Error('Unexpected repeated invocation for ' + target)
    const label = target + '-pass-' + passNumber
    const reply = target === 'member-a'
      ? passNumber === 1
        ? 'Member A pass one accepted.'
        : 'Member A pass two accepted.'
      : passNumber === 1
        ? 'Member B pass one recovered.'
        : 'Member B pass two accepted.'
    fs.appendFileSync(${JSON.stringify(providerLog)}, label + '\\n')
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: reply,
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 5, output_tokens: 5 },
      total_cost_usd: 0,
    }) + '\\n')
  }
}
`, { mode: 0o700 })

  const assignmentPath = path.join(
    workspace,
    'sessions',
    'session-discussion-recovery',
    'runs',
    'run-discussion-recovery',
    'assignments',
    'assignment-discussion-recovery',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  fs.writeFileSync(path.join(assignmentPath, 'incoming-brief.md'), 'Evaluate this teaching material.')

  const commonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ''}`,
    DISCUSSION_RECOVERY_REPO_ROOT: repoRoot,
    DISCUSSION_RECOVERY_RESULT_PATH: recoveredResult,
    PIPELINE_DURABLE_JOURNAL: 'authoritative',
    TEAM_CONFIG_PATH: path.join(teamRoot, 'team.yaml'),
    TEAM_WORKSPACE_PATH: workspace,
    TEAM_RUNTIME_START_SERVICES: '0',
    TEAM_RUNTIME_SESSION_ID: 'session-discussion-recovery',
    TEAM_RUNTIME_RUN_ID: 'run-discussion-recovery',
    TEAM_RUNTIME_ASSIGNMENT_ID: 'assignment-discussion-recovery',
    TEAM_RUNTIME_TASK_ID: 'task-discussion-recovery',
    TEAM_SESSION_ID: 'assignment-discussion-recovery',
    TEAM_ROOT_SESSION_ID: 'session-discussion-recovery',
    TEAM_INPUT_ARTIFACT: 'incoming-brief.md',
    TEAM_OUTPUT_ARTIFACT: 'unused-result.md',
    TEAM_DELEGATED_AUTOSTART: '1',
    TEAM_CHAT_MODE: '1',
    TEAM_TENANT_ID: 'local',
    TEAM_RUNTIME_FILE_PARSER_ENTRY: path.join(repoRoot, 'file-parser', 'index.ts'),
  }

  let interrupted: RunningWorker | undefined
  try {
    interrupted = startWorker({
      ...commonEnv,
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-discussion-first',
    }, true)
    await Promise.race([
      waitForFile(interruptedMarker, 15_000),
      interrupted.outcome.then((outcome) => {
        const runtimeEventsPath = path.join(
          assignmentPath,
          'logs',
          'runtime-events.jsonl',
        )
        throw new Error(
          `Interrupted worker exited before member B started.\n` +
            `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}\n` +
            `runtime events:\n${fs.existsSync(runtimeEventsPath)
              ? fs.readFileSync(runtimeEventsPath, 'utf8')
              : '<missing>'}`,
        )
      }),
    ])

    const checkpoint = readCheckpoint(assignmentPath)
    assert.ok(checkpoint, 'the interrupted process must persist a checkpoint')
    const state = checkpoint.levelStates.find(
      (levelState) => levelState.levelId === 'discuss',
    )?.engineState
    assert.equal(state?.type, 'discussion')
    if (state?.type !== 'discussion') return
    assert.equal(state.state.round, 1)
    assert.deepEqual(
      state.state.continuation?.phase === 'running_specialist_pass'
        ? state.state.continuation.completedTargets
        : [],
      ['member-a'],
    )

    const interruptedPid = interrupted.child.pid
    assert.ok(interruptedPid, 'the interrupted worker must have a process id')
    if (process.platform === 'win32') interrupted.child.kill('SIGKILL')
    else process.kill(-interruptedPid, 'SIGKILL')
    const interruptedOutcome = await interrupted.outcome
    assert.equal(
      interruptedOutcome.code,
      null,
      `stdout:\n${interruptedOutcome.stdout}\nstderr:\n${interruptedOutcome.stderr}\n` +
        `provider log:\n${fs.existsSync(providerLog) ? fs.readFileSync(providerLog, 'utf8') : '<missing>'}`,
    )
    assert.equal(interruptedOutcome.signal, 'SIGKILL')

    const recovered = startWorker({
      ...commonEnv,
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-discussion-recovered',
      TEAM_RUNTIME_RECOVERY: '1',
    }, false)
    const recoveredOutcome = await recovered.outcome
    assert.equal(
      recoveredOutcome.code,
      0,
      `stdout:\n${recoveredOutcome.stdout}\nstderr:\n${recoveredOutcome.stderr}`,
    )
    assert.ok(fs.existsSync(recoveredResult))

    const providerCompletions = fs.readFileSync(providerLog, 'utf8').trim().split('\n')
    assert.deepEqual(providerCompletions, [
      'coordinator-selection',
      'member-a-pass-1',
      'member-b-pass-1',
      'coordinator-continuation',
      'member-a-pass-2',
      'member-b-pass-2',
      'coordinator-completion',
    ])

    const messages = fs.readFileSync(
      path.join(assignmentPath, 'logs', 'team-chat-messages.jsonl'),
      'utf8',
    )
    for (const expected of [
      'Convening 2 of 2 Team members',
      'Member A pass one accepted.',
      'Member B pass one recovered.',
      'Produce the final joint recommendation.',
      'Member A pass two accepted.',
      'Member B pass two accepted.',
      'Recovered lead synthesis.',
    ]) {
      assert.equal(countText(messages, expected), 1, expected)
    }
    const participantMessages = readTeamChatMessages(assignmentPath).filter(
      (message) => message.message_type === 'position',
    )
    assert.deepEqual(
      participantMessages.map(({ agent_name, text }) => ({ agent_name, text })),
      [
        { agent_name: 'member-a', text: 'Member A pass one accepted.' },
        { agent_name: 'member-b', text: 'Member B pass one recovered.' },
        { agent_name: 'member-a', text: 'Member A pass two accepted.' },
        { agent_name: 'member-b', text: 'Member B pass two accepted.' },
      ],
    )
    assert.deepEqual(
      participantMessages.map(({ dispatch_id }) => dispatch_id),
      [
        'assignment-discussion-recovery:discussion:discuss:visit:0:round:1:member-a#1#member-a',
        'assignment-discussion-recovery:discussion:discuss:visit:0:round:1:member-b#1#member-b',
        'assignment-discussion-recovery:discussion:discuss:visit:0:round:2:member-a#1#member-a',
        'assignment-discussion-recovery:discussion:discuss:visit:0:round:2:member-b#1#member-b',
      ],
    )
    const runtimeEvents = fs.readFileSync(
      path.join(assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.match(runtimeEvents, /"event":"run\.resumed_from_checkpoint"/)
    assert.match(runtimeEvents, /"event":"run\.completed"/)
  } finally {
    if (interrupted && interrupted.child.exitCode === null) {
      const pid = interrupted.child.pid
      if (pid) {
        if (process.platform === 'win32') interrupted.child.kill('SIGKILL')
        else {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            // The process group already exited.
          }
        }
      }
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('a later discussion starts its own stage clock instead of inheriting the run clock', {
  timeout: 20_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-stage-clock-',
    maxTimeMinutes: 0.5,
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const prior = fs.existsSync(${JSON.stringify(providerLog)})
  ? fs.readFileSync(${JSON.stringify(providerLog)}, 'utf8')
  : ''
if (process.argv.includes('--json-schema')) {
  const selecting = !prior.includes('coordinator-selection')
  fs.appendFileSync(
    ${JSON.stringify(providerLog)},
    selecting ? 'coordinator-selection\\n' : 'coordinator-completion\\n',
  )
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: selecting
      ? {
          agents: ['member'],
          rosterRationale: { member: 'The requested review needs this specialist.' },
        }
      : {
          decision: 'complete',
          reason: 'The fresh discussion pass is sufficient.',
          finalResponse: 'Later discussion completed on its own clock.',
        },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'member-pass-1\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Later-stage member analysis.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  try {
    const activatedAtMs = Date.now()
    writeCheckpoint(fixture.assignmentPath, {
      sessionId: 'assignment-single-member',
      currentLevelIndex: 0,
      levelStates: new Map([[
        'discuss',
        {
          status: 'active',
          stageStatus: STAGE_LIFECYCLE_STATUS.READY,
          loopbackCount: 0,
          engineState: {
            type: STAGE_TYPE.DISCUSSION,
            round: 0,
            messages: [],
            outputPath: fixture.assignmentPath,
            activationStartedAtMs: activatedAtMs,
          },
        },
      ]]),
      totalCost: 0,
      startTime: activatedAtMs - 60_000,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
      rootSessionId: 'session-single-member',
    })

    const worker = startWorker({
      ...fixture.env,
      PIPELINE_DURABLE_JOURNAL: 'disabled',
      TEAM_RUNTIME_RECOVERY: '1',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-later-discussion-clock',
    }, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.fixtureRoot, 'provider-log.txt'), 'utf8')
        .trim()
        .split('\n'),
      ['coordinator-selection', 'member-pass-1', 'coordinator-completion'],
      runtimeEvents,
    )
    assert.equal(countText(runtimeEvents, '"event":"run.completed"'), 1)
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a second visit to one discussion publishes distinct roster, specialist, and lead messages', {
  timeout: 30_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-loopback-identities-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const lines = fs.existsSync(${JSON.stringify(providerLog)})
  ? fs.readFileSync(${JSON.stringify(providerLog)}, 'utf8').trim().split('\\n').filter(Boolean)
  : []
if (process.argv.includes('--json-schema')) {
  const coordinatorCount = lines.filter((line) => line.startsWith('coordinator-')).length
  const visit = Math.floor(coordinatorCount / 2) + 1
  const selecting = coordinatorCount % 2 === 0
  fs.appendFileSync(
    ${JSON.stringify(providerLog)},
    selecting
      ? 'coordinator-selection-' + visit + '\\n'
      : 'coordinator-completion-' + visit + '\\n',
  )
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: selecting
      ? {
          agents: ['member'],
          rosterRationale: {
            member: visit === 1 ? 'First visit rationale.' : 'Second visit rationale.',
          },
        }
      : {
          decision: 'complete',
          reason: 'This visit has enough evidence.',
          finalResponse: visit === 1
            ? 'First visit lead synthesis.'
            : 'Second visit lead synthesis.',
        },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  const visit = lines.filter((line) => line.startsWith('member-visit-')).length + 1
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'member-visit-' + visit + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: visit === 1
      ? 'First visit participant response.'
      : 'Second visit participant response.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  try {
    const first = startWorker({
      ...fixture.env,
      PIPELINE_DURABLE_JOURNAL: 'disabled',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-loopback-first-visit',
    }, false)
    const firstOutcome = await first.outcome
    assert.equal(
      firstOutcome.code,
      0,
      `stdout:\n${firstOutcome.stdout}\nstderr:\n${firstOutcome.stderr}`,
    )

    const secondVisitStartedAtMs = Date.now()
    writeCheckpoint(fixture.assignmentPath, {
      sessionId: 'assignment-single-member',
      currentLevelIndex: 0,
      levelStates: new Map([[
        'discuss',
        {
          status: 'active',
          stageStatus: STAGE_LIFECYCLE_STATUS.READY,
          // The gate looped back to this level, so both counters advance here.
          // `visitCount` is what the identities key on; see the sibling test
          // for a level that re-runs without being the loopback target.
          loopbackCount: 1,
          visitCount: 1,
          engineState: null,
        },
      ]]),
      totalCost: 0,
      startTime: secondVisitStartedAtMs,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
      rootSessionId: 'session-single-member',
    })

    const second = startWorker({
      ...fixture.env,
      PIPELINE_DURABLE_JOURNAL: 'disabled',
      TEAM_RUNTIME_RECOVERY: '1',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-loopback-second-visit',
    }, false)
    const secondOutcome = await second.outcome
    assert.equal(
      secondOutcome.code,
      0,
      `stdout:\n${secondOutcome.stdout}\nstderr:\n${secondOutcome.stderr}`,
    )
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.fixtureRoot, 'provider-log.txt'), 'utf8')
        .trim()
        .split('\n'),
      [
        'coordinator-selection-1',
        'member-visit-1',
        'coordinator-completion-1',
        'coordinator-selection-2',
        'member-visit-2',
        'coordinator-completion-2',
      ],
    )
    const messages = readTeamChatMessages(fixture.assignmentPath)
    for (const expected of [
      'First visit rationale.',
      'Second visit rationale.',
      'First visit participant response.',
      'Second visit participant response.',
      'First visit lead synthesis.',
      'Second visit lead synthesis.',
    ]) {
      assert.equal(
        messages.filter((message) => message.text.includes(expected)).length,
        1,
        expected,
      )
    }
    assert.equal(new Set(messages.map((message) => message.message_id)).size, 6)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a discussion the loopback passed through, not targeted, still publishes a distinct second visit', {
  timeout: 30_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-intermediate-visit-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const lines = fs.existsSync(${JSON.stringify(providerLog)})
  ? fs.readFileSync(${JSON.stringify(providerLog)}, 'utf8').trim().split('\\n').filter(Boolean)
  : []
if (process.argv.includes('--json-schema')) {
  const coordinatorCount = lines.filter((line) => line.startsWith('coordinator-')).length
  const visit = Math.floor(coordinatorCount / 2) + 1
  const selecting = coordinatorCount % 2 === 0
  fs.appendFileSync(
    ${JSON.stringify(providerLog)},
    selecting
      ? 'coordinator-selection-' + visit + '\\n'
      : 'coordinator-completion-' + visit + '\\n',
  )
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: selecting
      ? {
          agents: ['member'],
          rosterRationale: {
            member: visit === 1 ? 'First visit rationale.' : 'Second visit rationale.',
          },
        }
      : {
          decision: 'complete',
          reason: 'This visit has enough evidence.',
          finalResponse: visit === 1
            ? 'First visit lead synthesis.'
            : 'Second visit lead synthesis.',
        },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  const visit = lines.filter((line) => line.startsWith('member-visit-')).length + 1
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'member-visit-' + visit + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: visit === 1
      ? 'First visit participant response.'
      : 'Second visit participant response.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  try {
    const first = startWorker({
      ...fixture.env,
      PIPELINE_DURABLE_JOURNAL: 'disabled',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-loopback-first-visit',
    }, false)
    const firstOutcome = await first.outcome
    assert.equal(
      firstOutcome.code,
      0,
      `stdout:\n${firstOutcome.stdout}\nstderr:\n${firstOutcome.stderr}`,
    )

    const secondVisitStartedAtMs = Date.now()
    writeCheckpoint(fixture.assignmentPath, {
      sessionId: 'assignment-single-member',
      currentLevelIndex: 0,
      levelStates: new Map([[
        'discuss',
        {
          status: 'active',
          stageStatus: STAGE_LIFECYCLE_STATUS.READY,
          // The gate looped back PAST this level, not to it: `loopbackCount`
          // bounds `max_loopbacks` and so stays at 0 for a level the gate did
          // not target, while the level still re-runs. Only `visitCount`
          // advances, and the identities have to follow it — otherwise this
          // visit reproduces visit 0's identities and its roster, specialist
          // and lead messages are all dropped as duplicates.
          loopbackCount: 0,
          visitCount: 1,
          engineState: null,
        },
      ]]),
      totalCost: 0,
      startTime: secondVisitStartedAtMs,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
      rootSessionId: 'session-single-member',
    })

    const second = startWorker({
      ...fixture.env,
      PIPELINE_DURABLE_JOURNAL: 'disabled',
      TEAM_RUNTIME_RECOVERY: '1',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-loopback-second-visit',
    }, false)
    const secondOutcome = await second.outcome
    assert.equal(
      secondOutcome.code,
      0,
      `stdout:\n${secondOutcome.stdout}\nstderr:\n${secondOutcome.stderr}`,
    )
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.fixtureRoot, 'provider-log.txt'), 'utf8')
        .trim()
        .split('\n'),
      [
        'coordinator-selection-1',
        'member-visit-1',
        'coordinator-completion-1',
        'coordinator-selection-2',
        'member-visit-2',
        'coordinator-completion-2',
      ],
    )
    const messages = readTeamChatMessages(fixture.assignmentPath)
    for (const expected of [
      'First visit rationale.',
      'Second visit rationale.',
      'First visit participant response.',
      'Second visit participant response.',
      'First visit lead synthesis.',
      'Second visit lead synthesis.',
    ]) {
      assert.equal(
        messages.filter((message) => message.text.includes(expected)).length,
        1,
        expected,
      )
    }
    assert.equal(new Set(messages.map((message) => message.message_id)).size, 6)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('an expired replacement replays its paid roster receipt and wraps up instead of failing', {
  timeout: 30_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-selection-receipt-recovery-',
    maxTimeMinutes: 0.05,
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const hasSchema = process.argv.includes('--json-schema')
const providerLog = ${JSON.stringify(providerLog)}
const lines = fs.existsSync(providerLog)
  ? fs.readFileSync(providerLog, 'utf8').trim().split('\\n').filter(Boolean)
  : []
if (hasSchema) {
  const selecting = !lines.includes('coordinator-selection')
  fs.appendFileSync(providerLog, selecting ? 'coordinator-selection\\n' : 'coordinator-completion\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: selecting
      ? {
          agents: ['member'],
          rosterRationale: { member: 'The requested review needs this specialist.' },
        }
      : {
          decision: 'complete',
          reason: 'The recovered specialist result is sufficient.',
          finalResponse: 'Lead completed after receipt recovery.',
        },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: selecting ? 0.4 : 0.3,
  }) + '\\n')
} else {
  fs.appendFileSync(providerLog, 'member-pass-1\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Recovered member analysis.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0.2,
  }) + '\\n')
}
`,
  })
  const providerLog = path.join(fixture.fixtureRoot, 'provider-log.txt')
  try {
    const interrupted = startWorker({
      ...fixture.env,
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-selection-receipt-first',
      TEAM_RUNTIME_FAULT_INJECT: 'crash_after_discussion_selection_receipt',
    }, false)
    const interruptedOutcome = await interrupted.outcome
    assert.equal(
      interruptedOutcome.code,
      null,
      `stdout:\n${interruptedOutcome.stdout}\nstderr:\n${interruptedOutcome.stderr}\n` +
        `provider log:\n${fs.existsSync(providerLog) ? fs.readFileSync(providerLog, 'utf8') : '<missing>'}`,
    )
    assert.equal(
      interruptedOutcome.signal,
      'SIGKILL',
      `stdout:\n${interruptedOutcome.stdout}\nstderr:\n${interruptedOutcome.stderr}`,
    )
    assert.deepEqual(
      fs.readFileSync(providerLog, 'utf8').trim().split('\n'),
      ['coordinator-selection'],
    )
    const receiptPath = durableCoordinatorCallReceiptPath(
      fixture.assignmentPath,
      'assignment-single-member:discussion:discuss:visit:0:selection',
    )
    const receipt: unknown = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    assert.ok(receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt))
    Reflect.set(receipt, 'startedAt', new Date(Date.now() - 60_000).toISOString())
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)

    const recovered = startWorker({
      ...fixture.env,
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-selection-receipt-recovered',
      TEAM_RUNTIME_RECOVERY: '1',
    }, false)
    const recoveredOutcome = await recovered.outcome
    assert.equal(
      recoveredOutcome.code,
      0,
      `stdout:\n${recoveredOutcome.stdout}\nstderr:\n${recoveredOutcome.stderr}`,
    )
    assert.ok(fs.existsSync(fixture.resultPath))
    // The paid selection is replayed from its receipt rather than bought again,
    // and a spent budget buys exactly one more dispatch: the lead's wrap-up.
    // No new specialist pass starts on the wrap-up allowance.
    assert.deepEqual(
      fs.readFileSync(providerLog, 'utf8').trim().split('\n'),
      ['coordinator-selection', 'coordinator-completion'],
    )
    const workerResult: unknown = JSON.parse(
      fs.readFileSync(fixture.resultPath, 'utf8'),
    )
    assert.equal(
      workerResult !== null &&
        typeof workerResult === 'object' &&
        !Array.isArray(workerResult)
        ? Reflect.get(workerResult, 'totalCost')
        : undefined,
      // The replayed selection is reconciled exactly once, and the wrap-up
      // synthesis is the only charge this attempt adds.
      0.7,
    )
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    // Out of time is a reason to finish, not to throw the paid work away.
    assert.equal(countText(runtimeEvents, '"event":"run.completed"'), 1)
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a non-chat discussion resumes its accepted setup without selecting the roster again', {
  timeout: 20_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-non-chat-setup-recovery-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const prior = fs.existsSync(${JSON.stringify(providerLog)})
  ? fs.readFileSync(${JSON.stringify(providerLog)}, 'utf8')
  : ''
if (process.argv.includes('--json-schema')) {
  if (prior.includes('coordinator-selection')) {
    fs.appendFileSync(${JSON.stringify(providerLog)}, 'unexpected-reselection\\n')
    process.exitCode = 1
  } else {
    fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-selection\\n')
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: {
        agents: ['member'],
        rosterRationale: { member: 'The requested review needs this specialist.' },
      },
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 5, output_tokens: 5 },
      total_cost_usd: 0,
    }) + '\\n')
  }
} else {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'member-pass-1\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Recovered non-chat participant analysis.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  try {
    const interrupted = startWorker({
      ...fixture.env,
      PIPELINE_DURABLE_JOURNAL: 'disabled',
      TEAM_CHAT_MODE: '0',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-non-chat-setup-first',
      TEAM_RUNTIME_FAULT_INJECT: 'crash_after_discussion_setup_checkpoint',
    }, false)
    const interruptedOutcome = await interrupted.outcome
    const interruptedRuntimeEventsPath = path.join(
      fixture.assignmentPath,
      'logs',
      'runtime-events.jsonl',
    )
    assert.equal(
      interruptedOutcome.code,
      null,
      `stdout:\n${interruptedOutcome.stdout}\nstderr:\n${interruptedOutcome.stderr}\n` +
        `provider log:\n${fs.existsSync(path.join(fixture.fixtureRoot, 'provider-log.txt'))
          ? fs.readFileSync(path.join(fixture.fixtureRoot, 'provider-log.txt'), 'utf8')
          : '<missing>'}\n` +
        `runtime events:\n${fs.existsSync(interruptedRuntimeEventsPath)
          ? fs.readFileSync(interruptedRuntimeEventsPath, 'utf8')
          : '<missing>'}`,
    )
    assert.equal(interruptedOutcome.signal, 'SIGKILL')
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.fixtureRoot, 'provider-log.txt'), 'utf8')
        .trim()
        .split('\n'),
      ['coordinator-selection'],
    )

    const recovered = startWorker({
      ...fixture.env,
      PIPELINE_DURABLE_JOURNAL: 'disabled',
      TEAM_CHAT_MODE: '0',
      TEAM_RUNTIME_RECOVERY: '1',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-non-chat-setup-recovered',
    }, false)
    const recoveredOutcome = await recovered.outcome
    assert.equal(
      recoveredOutcome.code,
      0,
      `stdout:\n${recoveredOutcome.stdout}\nstderr:\n${recoveredOutcome.stderr}`,
    )
    const providerCalls = fs.readFileSync(
      path.join(fixture.fixtureRoot, 'provider-log.txt'),
      'utf8',
    ).trim().split('\n')
    assert.equal(
      providerCalls.filter((entry) => entry === 'coordinator-selection').length,
      1,
    )
    assert.equal(providerCalls.includes('unexpected-reselection'), false)
    assert.ok(providerCalls.includes('member-pass-1'))
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.equal(countText(runtimeEvents, '"event":"run.completed"'), 1)
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a non-chat discussion advances after its completed pass checkpoint without replaying work', {
  timeout: 20_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-non-chat-completion-recovery-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const prompt = fs.readFileSync(0, 'utf8')
const prior = fs.existsSync(${JSON.stringify(providerLog)})
  ? fs.readFileSync(${JSON.stringify(providerLog)}, 'utf8')
  : ''
if (process.argv.includes('--json-schema')) {
  if (prior.includes('coordinator-selection')) {
    fs.appendFileSync(${JSON.stringify(providerLog)}, 'unexpected-reselection\\n')
    process.exitCode = 1
  } else {
    fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-selection\\n')
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: {
        agents: ['member'],
        rosterRationale: { member: 'The requested review needs this specialist.' },
      },
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 5, output_tokens: 5 },
      total_cost_usd: 0,
    }) + '\\n')
  }
} else {
  fs.appendFileSync(
    ${JSON.stringify(providerLog)},
    prompt.includes('# Session Reflection')
      ? 'experience-reflection\\n'
      : 'member-pass-1\\n',
  )
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Completed non-chat participant analysis.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  const providerLog = path.join(fixture.fixtureRoot, 'provider-log.txt')
  try {
    const interrupted = startWorker({
      ...fixture.env,
      PIPELINE_DURABLE_JOURNAL: 'disabled',
      TEAM_CHAT_MODE: '0',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-non-chat-completion-first',
      TEAM_RUNTIME_FAULT_INJECT:
        'crash_after_non_chat_discussion_completion_checkpoint',
    }, false)
    const interruptedOutcome = await interrupted.outcome
    assert.equal(
      interruptedOutcome.code,
      null,
      `stdout:\n${interruptedOutcome.stdout}\nstderr:\n${interruptedOutcome.stderr}`,
    )
    assert.equal(interruptedOutcome.signal, 'SIGKILL')
    const providerCalls = fs.readFileSync(providerLog, 'utf8').trim().split('\n')
    assert.equal(
      providerCalls.filter((entry) => entry === 'coordinator-selection').length,
      1,
    )
    assert.equal(providerCalls.filter((entry) => entry === 'member-pass-1').length, 1)
    assert.equal(providerCalls.includes('unexpected-reselection'), false)
    const completedCheckpoint = readCheckpoint(fixture.assignmentPath)
    assert.ok(completedCheckpoint)
    assert.equal(
      completedCheckpoint.levelStates.find(
        (levelState) => levelState.levelId === 'discuss',
      )?.stageStatus,
      STAGE_LIFECYCLE_STATUS.COMPLETED,
    )

    const recovered = startWorker({
      ...fixture.env,
      PIPELINE_DURABLE_JOURNAL: 'disabled',
      TEAM_CHAT_MODE: '0',
      TEAM_RUNTIME_RECOVERY: '1',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-non-chat-completion-recovered',
    }, false)
    const recoveredOutcome = await recovered.outcome
    assert.equal(
      recoveredOutcome.code,
      0,
      `stdout:\n${recoveredOutcome.stdout}\nstderr:\n${recoveredOutcome.stderr}`,
    )
    const recoveredProviderCalls = fs.readFileSync(providerLog, 'utf8')
      .trim()
      .split('\n')
    assert.equal(
      recoveredProviderCalls.filter(
        (entry) => entry === 'coordinator-selection',
      ).length,
      1,
    )
    assert.equal(
      recoveredProviderCalls.filter((entry) => entry === 'member-pass-1').length,
      1,
    )
    assert.equal(recoveredProviderCalls.includes('unexpected-reselection'), false)
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.equal(countText(runtimeEvents, '"event":"run.completed"'), 1)
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a roster reply refused for the whole budget degrades to the fallback roster instead of failing the run', {
  timeout: 30_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-roster-degraded-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const schemaIndex = process.argv.indexOf('--json-schema')
const schema = schemaIndex === -1 ? '' : (process.argv[schemaIndex + 1] || '')
if (schemaIndex !== -1 && schema.includes('rosterRationale')) {
  // Exactly the production failure from session b8e6afd8: a conversational
  // reply carrying no JSON at all. Not a schema-valid empty roster, which
  // trips a different rule.
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-selection\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: "Sure — I'll pull in the reviewer to look at these files.",
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else if (schemaIndex !== -1) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-decision\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: {
      decision: 'complete',
      reason: 'The single reviewer has answered.',
      message: null,
      targets: null,
      finalResponse: 'The material needs a scope cut before it is taught.',
    },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'member-pass\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Reviewed the material and noted the scope problem.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  const providerLog = path.join(fixture.fixtureRoot, 'provider-log.txt')
  try {
    const worker = startWorker(fixture.env, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    const providerCalls = fs.readFileSync(providerLog, 'utf8').trim().split('\n')

    // The refusal is retried to the budget, not accepted on the first reply and
    // not retried without bound.
    assert.equal(
      providerCalls.filter((entry) => entry === 'coordinator-selection').length,
      MAX_COORDINATOR_CALL_ATTEMPTS,
    )
    // The discussion actually ran: the fallback roster was dispatched.
    assert.ok(providerCalls.includes('member-pass'))

    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    // The roster refusal alone no longer ends the run.
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
    // The degradation is visible in the run record rather than silent.
    assert.equal(
      countText(runtimeEvents, '"event":"runtime.discussion.roster.degraded"'),
      1,
    )
    assert.match(runtimeEvents, /invalid roster selection/i)
    assert.equal(
      countText(runtimeEvents, '"event":"runtime.coordinator_reply.rejected"'),
      MAX_COORDINATOR_CALL_ATTEMPTS,
    )

    // And the user is told, in the chat itself, that the lead did not choose.
    // Asserted on the specific notice rather than on the whole log: the
    // fallback rationale carries similar words, so a log-wide match would pass
    // even if this message were never sent.
    const chatMessages = readTeamChatMessages(fixture.assignmentPath)
    const degradedNotice = chatMessages.find((message) =>
      message.dispatch_id.endsWith('-roster-degraded'))
    assert.ok(
      degradedNotice,
      `no roster-degraded notice in ${JSON.stringify(
        chatMessages.map((message) => message.dispatch_id),
      )}`,
    )
    assert.match(degradedNotice.text, /did not choose this roster/i)
    assert.match(degradedNotice.text, /invalid roster selection/i)
    assert.equal(degradedNotice.agent_name, 'lead')
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a coordinator failure of unknown outcome fails the run instead of degrading the roster', {
  timeout: 30_000,
}, async () => {
  // Degrading is only correct when the lead answered and the answer was
  // refused. A provider failure whose outcome nobody knows must keep its own
  // meaning: the call may have been produced and charged for, so it stays
  // indeterminate and the run fails rather than quietly inventing a roster.
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-roster-indeterminate-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const schemaIndex = process.argv.indexOf('--json-schema')
const schema = schemaIndex === -1 ? '' : (process.argv[schemaIndex + 1] || '')
if (schemaIndex !== -1 && schema.includes('rosterRationale')) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-selection\\n')
  process.stderr.write('provider transport failed\\n')
  process.exit(1)
}
fs.appendFileSync(${JSON.stringify(providerLog)}, 'unexpected-dispatch\\n')
process.exit(1)
`,
  })
  const providerLog = path.join(fixture.fixtureRoot, 'provider-log.txt')
  try {
    const worker = startWorker(fixture.env, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 1)
    assert.equal(
      countText(runtimeEvents, '"event":"runtime.discussion.roster.degraded"'),
      0,
    )
    // No specialist was dispatched against a roster nobody chose.
    const providerCalls = fs.readFileSync(providerLog, 'utf8').trim().split('\n')
    assert.equal(providerCalls.includes('unexpected-dispatch'), false)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a follow-up turn keeps the standing roster and adds the specialist the lead names', {
  timeout: 30_000,
}, async () => {
  // The runtime end of Phase 4. The brief carries a roster this conversation
  // already established; the lead names only the new specialist; both must run.
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-standing-roster-',
    secondMember: true,
    brief: [
      '# Task Brief',
      '',
      'Workflow: `team-chat-single-member-runtime-team`',
      '',
      '## User Brief',
      '',
      '# Current user message',
      '',
      'can you also check the code samples?',
      '',
      '# Conversation continuity',
      '',
      'Previous responders: member',
      'Standing roster: member',
    ].join('\n'),
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const prompt = fs.readFileSync(0, 'utf8')
const schemaIndex = process.argv.indexOf('--json-schema')
const schema = schemaIndex === -1 ? '' : (process.argv[schemaIndex + 1] || '')
if (schemaIndex !== -1 && schema.includes('rosterRationale')) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-selection\\n')
  // The lead names only the addition, as the follow-up prompt asks it to.
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: {
      agents: ['reviewer'],
      rosterRationale: { reviewer: 'The code samples need this specialist.' },
    },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else if (schemaIndex !== -1) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-decision\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: {
      decision: 'complete',
      reason: 'Both specialists have answered.',
      message: null,
      targets: null,
      finalResponse: 'The samples are fine; the scope still is not.',
    },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  // The agent's identity travels in its system prompt, which the provider
  // writes to a private file and names with --system-prompt-file.
  const systemPromptIndex = process.argv.indexOf('--system-prompt-file')
  const systemPrompt = systemPromptIndex === -1
    ? ''
    : fs.readFileSync(process.argv[systemPromptIndex + 1], 'utf8')
  fs.appendFileSync(
    ${JSON.stringify(providerLog)},
    systemPrompt.includes('You are reviewer') ? 'reviewer-pass\\n' : 'member-pass\\n',
  )
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Looked at the material.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  const providerLog = path.join(fixture.fixtureRoot, 'provider-log.txt')
  try {
    const worker = startWorker(fixture.env, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    const providerCalls = fs.readFileSync(providerLog, 'utf8').trim().split('\n')

    // The standing member was kept even though the lead never named it, and the
    // named addition ran too. Replacing the roster would drop `member-pass`.
    assert.ok(
      providerCalls.includes('member-pass'),
      `standing member was dropped: ${JSON.stringify(providerCalls)}`,
    )
    assert.ok(
      providerCalls.includes('reviewer-pass'),
      `named addition never ran: ${JSON.stringify(providerCalls)}`,
    )
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
    assert.equal(
      countText(runtimeEvents, '"event":"runtime.discussion.roster.addition_refused"'),
      0,
    )
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a follow-up turn where the lead adds nobody keeps the standing roster intact', {
  timeout: 30_000,
}, async () => {
  // The follow-up prompt has always said that naming no addition is correct.
  // Until the wire schema agreed, a lead that obeyed it was refused, retried to
  // exhaustion, and the conversation was handed a roster nobody chose.
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-empty-follow-up-',
    secondMember: true,
    brief: [
      '# Task Brief',
      '',
      'Workflow: `team-chat-single-member-runtime-team`',
      '',
      '## User Brief',
      '',
      '# Current user message',
      '',
      'thanks, that is clear now',
      '',
      '# Conversation continuity',
      '',
      'Previous responders: member',
      'Standing roster: member',
    ].join('\n'),
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const schemaIndex = process.argv.indexOf('--json-schema')
const schema = schemaIndex === -1 ? '' : (process.argv[schemaIndex + 1] || '')
if (schemaIndex !== -1 && schema.includes('rosterRationale')) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-selection\\n')
  // The answer the follow-up prompt asks for when nothing new is needed.
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: { agents: [], rosterRationale: {} },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else if (schemaIndex !== -1) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-decision\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: {
      decision: 'complete',
      reason: 'The standing specialist has answered.',
      message: null,
      targets: null,
      finalResponse: 'Nothing further is needed.',
    },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  const systemPromptIndex = process.argv.indexOf('--system-prompt-file')
  const systemPrompt = systemPromptIndex === -1
    ? ''
    : fs.readFileSync(process.argv[systemPromptIndex + 1], 'utf8')
  fs.appendFileSync(
    ${JSON.stringify(providerLog)},
    systemPrompt.includes('You are reviewer') ? 'reviewer-pass\\n' : 'member-pass\\n',
  )
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Looked at the material.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  const providerLog = path.join(fixture.fixtureRoot, 'provider-log.txt')
  try {
    const worker = startWorker(fixture.env, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    const providerCalls = fs.readFileSync(providerLog, 'utf8').trim().split('\n')

    // The standing member ran, and nobody the lead did not name joined it.
    assert.ok(
      providerCalls.includes('member-pass'),
      `standing member was dropped: ${JSON.stringify(providerCalls)}`,
    )
    assert.equal(
      providerCalls.includes('reviewer-pass'),
      false,
      `an unnamed specialist ran: ${JSON.stringify(providerCalls)}`,
    )
    // The empty answer was accepted first time, so no attempt was re-bought.
    assert.equal(
      providerCalls.filter((call) => call === 'coordinator-selection').length,
      1,
      `the empty reply was re-bought: ${JSON.stringify(providerCalls)}`,
    )

    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
    assert.equal(
      countText(runtimeEvents, '"event":"runtime.discussion.roster.degraded"'),
      0,
      'an accepted empty reply must not degrade the roster',
    )
    assert.equal(
      countText(runtimeEvents, '"event":"runtime.coordinator_reply.rejected"'),
      0,
      'an empty follow-up reply must not be refused',
    )
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a refused gate decision is retried rather than failing the run permanently', {
  timeout: 30_000,
}, async () => {
  // The second coordinator call site. It shares the durable wrapper with the
  // roster selection, so it shared the permanent-failure exposure too. Here the
  // lead answers the gate in prose once and correctly on the retry.
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-gate-retry-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const schemaIndex = process.argv.indexOf('--json-schema')
const schema = schemaIndex === -1 ? '' : (process.argv[schemaIndex + 1] || '')
const prior = fs.existsSync(${JSON.stringify(providerLog)})
  ? fs.readFileSync(${JSON.stringify(providerLog)}, 'utf8')
  : ''
if (schemaIndex !== -1 && schema.includes('rosterRationale')) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-selection\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: {
      agents: ['member'],
      rosterRationale: { member: 'The requested review needs this specialist.' },
    },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else if (schemaIndex !== -1) {
  const first = !prior.includes('coordinator-decision')
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-decision\\n')
  if (first) {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'I think we are done here, the reviewer covered it.',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 5, output_tokens: 5 },
      total_cost_usd: 0,
    }) + '\\n')
  } else {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: {
        decision: 'complete',
        reason: 'The single reviewer has answered.',
        message: null,
        targets: null,
        finalResponse: 'The material needs a scope cut before it is taught.',
      },
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 5, output_tokens: 5 },
      total_cost_usd: 0,
    }) + '\\n')
  }
} else {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'member-pass\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Reviewed the material and noted the scope problem.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  const providerLog = path.join(fixture.fixtureRoot, 'provider-log.txt')
  try {
    const worker = startWorker(fixture.env, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    const providerCalls = fs.readFileSync(providerLog, 'utf8').trim().split('\n')
    // The gate was answered twice: once refused, once accepted.
    assert.equal(
      providerCalls.filter((entry) => entry === 'coordinator-decision').length,
      2,
    )
    assert.equal(
      providerCalls.filter((entry) => entry === 'coordinator-selection').length,
      1,
    )
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
    assert.equal(
      countText(runtimeEvents, '"event":"runtime.coordinator_reply.rejected"'),
      1,
    )
    // A gate refusal is not a roster degradation.
    assert.equal(
      countText(runtimeEvents, '"event":"runtime.discussion.roster.degraded"'),
      0,
    )
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a genuinely unrecoverable discussion emits one failed terminal without an incomplete terminal', {
  timeout: 30_000,
}, async () => {
  // Terminal hygiene, kept separate from roster resilience. The roster is
  // chosen cleanly here; what cannot be recovered is the specialist pass, so
  // the run has no result to give and must fail exactly once.
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-terminal-failure-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const schemaIndex = process.argv.indexOf('--json-schema')
const schema = schemaIndex === -1 ? '' : (process.argv[schemaIndex + 1] || '')
if (schemaIndex !== -1 && schema.includes('rosterRationale')) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-selection\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: {
      agents: ['member'],
      rosterRationale: { member: 'The requested review needs this specialist.' },
    },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'member-failure\\n')
  process.stderr.write('provider refused the specialist dispatch\\n')
  process.exit(1)
}
`,
  })
  try {
    const worker = startWorker(fixture.env, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 1)
    assert.equal(countText(runtimeEvents, '"event":"run.incomplete"'), 0)
    assert.equal(countText(runtimeEvents, '"event":"run.completed"'), 0)
    const checkpoint = readCheckpoint(fixture.assignmentPath)
    assert.ok(checkpoint)
    assert.equal(
      checkpoint.levelStates.find((levelState) => levelState.levelId === 'discuss')
        ?.stageStatus,
      STAGE_LIFECYCLE_STATUS.FAILED,
    )
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('stopping a direct Team run remains cancellation and never emits a failed terminal', {
  timeout: 20_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-runtime-cancellation-',
    fakeClaude: ({ markerPath }) => `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv.includes('--json-schema')) {
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: {
      agents: ['member'],
      rosterRationale: { member: 'The requested review needs this specialist.' },
    },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  fs.writeFileSync(${JSON.stringify(markerPath)}, 'participant started')
  setInterval(() => {}, 60_000)
}
`,
  })
  const markerPath = path.join(fixture.fixtureRoot, 'participant-started')
  let worker: RunningWorker | undefined
  try {
    worker = startWorker(fixture.env, false)
    await Promise.race([
      waitForFile(markerPath, 12_000),
      worker.outcome.then((outcome) => {
        throw new Error(
          `Cancellation worker exited before its participant started.\n` +
            `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
        )
      }),
    ])
    assert.equal(worker.child.kill('SIGTERM'), true)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
    assert.equal(countText(runtimeEvents, '"event":"run.incomplete"'), 1)
    assert.equal(countText(runtimeEvents, '"event":"run.completed"'), 0)
    assert.match(runtimeEvents, /"cancelled":true/)
    const checkpoint = readCheckpoint(fixture.assignmentPath)
    assert.ok(checkpoint)
    assert.notEqual(
      checkpoint.levelStates.find((levelState) => levelState.levelId === 'discuss')
        ?.stageStatus,
      STAGE_LIFECYCLE_STATUS.FAILED,
    )
  } finally {
    if (worker && worker.child.exitCode === null) worker.child.kill('SIGKILL')
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('explicit recovery reopens a failed discussion checkpoint before resuming its accepted pass', {
  timeout: 30_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-failed-checkpoint-recovery-',
    fakeClaude: ({ markerPath, providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv.includes('--json-schema')) {
  const prior = fs.existsSync(${JSON.stringify(providerLog)})
    ? fs.readFileSync(${JSON.stringify(providerLog)}, 'utf8')
    : ''
  const selecting = !prior.includes('coordinator-selection')
  fs.appendFileSync(
    ${JSON.stringify(providerLog)},
    selecting ? 'coordinator-selection\\n' : 'coordinator-completion\\n',
  )
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: selecting
      ? {
          agents: ['member'],
          rosterRationale: { member: 'The requested review needs this specialist.' },
        }
      : {
          decision: 'complete',
          reason: 'The recovered specialist pass is sufficient.',
          finalResponse: 'Recovered failed checkpoint completed.',
        },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  if (!fs.existsSync(${JSON.stringify(markerPath)})) {
    fs.writeFileSync(${JSON.stringify(markerPath)}, 'member started')
    setInterval(() => {}, 60_000)
  } else {
    fs.appendFileSync(${JSON.stringify(providerLog)}, 'member-pass-1\\n')
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Recovered member reply.',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 5, output_tokens: 5 },
      total_cost_usd: 0,
    }) + '\\n')
  }
}
`,
  })
  const markerPath = path.join(fixture.fixtureRoot, 'participant-started')
  let interrupted: RunningWorker | undefined
  try {
    interrupted = startWorker({
      ...fixture.env,
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-failed-checkpoint-first',
    }, true)
    await Promise.race([
      waitForFile(markerPath, 15_000),
      interrupted.outcome.then((outcome) => {
        throw new Error(
          `Failed-checkpoint worker exited before its participant started.\n` +
            `stdout:\n${outcome.stdout}stderr:\n${outcome.stderr}`,
        )
      }),
    ])
    const interruptedPid = interrupted.child.pid
    assert.ok(interruptedPid)
    if (process.platform === 'win32') interrupted.child.kill('SIGKILL')
    else process.kill(-interruptedPid, 'SIGKILL')
    const interruptedOutcome = await interrupted.outcome
    assert.equal(interruptedOutcome.signal, 'SIGKILL')

    const checkpoint = readCheckpoint(fixture.assignmentPath)
    assert.ok(checkpoint)
    const levelStates = restoreLevelStatesFromCheckpoint(checkpoint)
    const failedLevel = levelStates.get('discuss')
    assert.ok(failedLevel)
    failedLevel.stageStatus = STAGE_LIFECYCLE_STATUS.FAILED
    writeCheckpoint(fixture.assignmentPath, {
      sessionId: checkpoint.sessionId,
      currentLevelIndex: checkpoint.currentLevelIndex,
      levelStates,
      totalCost: checkpoint.totalCost,
      startTime: checkpoint.startTime,
      timerStarted: checkpoint.startTime > 0,
      endTime: null,
      spawnDepth: checkpoint.spawnDepth,
      ...(checkpoint.rootSessionId
        ? { rootSessionId: checkpoint.rootSessionId }
        : {}),
      ...(checkpoint.parentSessionId
        ? { parentSessionId: checkpoint.parentSessionId }
        : {}),
    })
    const worker = startWorker({
      ...fixture.env,
      TEAM_RUNTIME_RECOVERY: '1',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-failed-checkpoint-recovery',
    }, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}stderr:\n${outcome.stderr}`,
    )
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.equal(
      countText(runtimeEvents, '"event":"run.completed"'),
      1,
      runtimeEvents,
    )
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.fixtureRoot, 'provider-log.txt'), 'utf8')
        .trim()
        .split('\n'),
      ['coordinator-selection', 'member-pass-1', 'coordinator-completion'],
    )
    assert.equal(
      countText(
        fs.readFileSync(
          path.join(fixture.assignmentPath, 'logs', 'team-chat-messages.jsonl'),
          'utf8',
        ),
        'Recovered failed checkpoint completed.',
      ),
      1,
    )
  } finally {
    if (interrupted && interrupted.child.exitCode === null) {
      const pid = interrupted.child.pid
      if (pid) {
        if (process.platform === 'win32') interrupted.child.kill('SIGKILL')
        else {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            // The process group already exited.
          }
        }
      }
    }
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('explicit recovery retries a failed quorum participant and completes with the repaired reply', {
  timeout: 20_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-quorum-recovery-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv.includes('--json-schema')) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-completion\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: {
      decision: 'complete',
      reason: 'The repaired participant response satisfies quorum.',
      finalResponse: 'Recovered quorum completed.',
    },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'member-retry\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Repaired participant response.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  try {
    const startedAtMs = Date.now()
    writeCheckpoint(fixture.assignmentPath, {
      sessionId: 'assignment-single-member',
      currentLevelIndex: 0,
      levelStates: new Map([[
        'discuss',
        {
          status: 'active',
          stageStatus: STAGE_LIFECYCLE_STATUS.FAILED,
          loopbackCount: 0,
          engineState: {
            type: STAGE_TYPE.DISCUSSION,
            round: 1,
            messages: [],
            outputPath: fixture.assignmentPath,
            activationStartedAtMs: startedAtMs,
            approvedRoster: ['member'],
            rosterAnnounced: true,
            continuation: {
              phase: 'running_specialist_pass',
              startedAtMs,
              passNumber: 1,
              attemptNumber: 1,
              targets: ['member'],
              completedTargets: ['member'],
              successfulTargets: [],
            },
          },
        },
      ]]),
      totalCost: 0,
      startTime: startedAtMs,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
      rootSessionId: 'session-single-member',
    })

    const worker = startWorker({
      ...fixture.env,
      PIPELINE_DURABLE_JOURNAL: 'disabled',
      TEAM_RUNTIME_RECOVERY: '1',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-quorum-recovery',
    }, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.fixtureRoot, 'provider-log.txt'), 'utf8')
        .trim()
        .split('\n'),
      ['member-retry', 'coordinator-completion'],
    )
    const messages = readTeamChatMessages(fixture.assignmentPath)
    assert.equal(
      messages.filter((message) => message.text === 'Repaired participant response.').length,
      1,
    )
    assert.equal(
      messages.filter((message) => message.text === 'Recovered quorum completed.').length,
      1,
    )
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.equal(countText(runtimeEvents, '"event":"run.completed"'), 1)
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('recovery retries a participant that failed while the pass was still running', {
  timeout: 20_000,
}, async () => {
  // The crash lands mid-pass, so the checkpoint still says `waiting_on_worker`
  // rather than `failed`: the round never reached its quorum verdict. The
  // failed participant is already recorded as completed-but-unsuccessful, and
  // nothing else will ever ask it again.
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-running-pass-recovery-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv.includes('--json-schema')) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-completion\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: {
      decision: 'complete',
      reason: 'The repaired participant response satisfies quorum.',
      finalResponse: 'Recovered running pass completed.',
    },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
} else {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'member-retry\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Repaired participant response.',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  try {
    const startedAtMs = Date.now()
    writeCheckpoint(fixture.assignmentPath, {
      sessionId: 'assignment-single-member',
      currentLevelIndex: 0,
      levelStates: new Map([[
        'discuss',
        {
          status: 'active',
          stageStatus: STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER,
          loopbackCount: 0,
          engineState: {
            type: STAGE_TYPE.DISCUSSION,
            round: 1,
            messages: [],
            outputPath: fixture.assignmentPath,
            activationStartedAtMs: startedAtMs,
            approvedRoster: ['member'],
            rosterAnnounced: true,
            continuation: {
              phase: 'running_specialist_pass',
              startedAtMs,
              passNumber: 1,
              attemptNumber: 1,
              targets: ['member'],
              completedTargets: ['member'],
              successfulTargets: [],
            },
          },
        },
      ]]),
      totalCost: 0,
      startTime: startedAtMs,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
      rootSessionId: 'session-single-member',
    })

    const worker = startWorker({
      ...fixture.env,
      PIPELINE_DURABLE_JOURNAL: 'disabled',
      TEAM_RUNTIME_RECOVERY: '1',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-running-pass-recovery',
    }, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    const providerLogPath = path.join(fixture.fixtureRoot, 'provider-log.txt')
    assert.deepEqual(
      fs.existsSync(providerLogPath)
        ? fs.readFileSync(providerLogPath, 'utf8').trim().split('\n')
        : [],
      ['member-retry', 'coordinator-completion'],
    )
    const messages = readTeamChatMessages(fixture.assignmentPath)
    assert.equal(
      messages.filter((message) => message.text === 'Repaired participant response.').length,
      1,
    )
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.equal(countText(runtimeEvents, '"event":"run.completed"'), 1)
    assert.equal(countText(runtimeEvents, '"event":"run.failed"'), 0)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('expired recovery publishes an accepted completion before enforcing another dispatch deadline', {
  timeout: 20_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-expired-publication-',
    maxTimeMinutes: 0.0001,
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(providerLog)}, 'unexpected-provider-call\\n')
process.exitCode = 1
`,
  })
  try {
    const startedAtMs = Date.now() - 60_000
    writeCheckpoint(fixture.assignmentPath, {
      sessionId: 'assignment-single-member',
      currentLevelIndex: 0,
      levelStates: new Map([[
        'discuss',
        {
          status: 'active',
          stageStatus: STAGE_LIFECYCLE_STATUS.RUNNING,
          loopbackCount: 0,
          engineState: {
            type: STAGE_TYPE.DISCUSSION,
            round: 1,
            messages: [],
            outputPath: fixture.assignmentPath,
            approvedRoster: ['member'],
            rosterAnnounced: true,
            continuation: {
              phase: 'publishing_completion',
              startedAtMs,
              reason: 'The accepted work is complete.',
              finalResponse: 'Accepted completion survives the expired clock.',
            },
          },
        },
      ]]),
      totalCost: 0,
      startTime: startedAtMs,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
      rootSessionId: 'session-single-member',
    })
    const worker = startWorker({
      ...fixture.env,
      TEAM_RUNTIME_RECOVERY: '1',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-expired-publication',
    }, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    assert.equal(
      fs.existsSync(path.join(fixture.fixtureRoot, 'provider-log.txt')),
      false,
    )
    const messages = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'team-chat-messages.jsonl'),
      'utf8',
    )
    assert.equal(
      countText(messages, 'Accepted completion survives the expired clock.'),
      1,
    )
    const runtimeEvents = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'runtime-events.jsonl'),
      'utf8',
    )
    assert.match(runtimeEvents, /"event":"run.completed"/)
    assert.doesNotMatch(runtimeEvents, /"event":"run.failed"/)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a replacement process republishes an all-checkpointed reply before asking the lead to finish', {
  timeout: 20_000,
}, async () => {
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-checkpoint-publication-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
if (!process.argv.includes('--json-schema')) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'unexpected-specialist-call\\n')
  process.exitCode = 1
} else {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-completion\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: {
      decision: 'complete',
      reason: 'The checkpointed specialist work is sufficient.',
      finalResponse: 'Lead completed from the recovered reply.',
    },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  try {
    const startedAtMs = Date.now()
    writeCheckpoint(fixture.assignmentPath, {
      sessionId: 'assignment-single-member',
      currentLevelIndex: 0,
      levelStates: new Map([[
        'discuss',
        {
          status: 'active',
          stageStatus: STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER,
          loopbackCount: 0,
          engineState: {
            type: STAGE_TYPE.DISCUSSION,
            round: 1,
            messages: [{
              from: 'member',
              target: 'member',
              to: 'all',
              round: 1,
              timestamp: new Date(0).toISOString(),
              type: 'position',
              message: 'Checkpointed reply awaiting durable publication.',
              dispatchId: 'dispatch-checkpointed-member',
            }],
            outputPath: fixture.assignmentPath,
            approvedRoster: ['member'],
            rosterAnnounced: true,
            continuation: {
              phase: 'running_specialist_pass',
              startedAtMs,
              passNumber: 1,
              attemptNumber: 1,
              targets: ['member'],
              completedTargets: ['member'],
              successfulTargets: ['member'],
            },
          },
        },
      ]]),
      totalCost: 0,
      startTime: startedAtMs,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
      rootSessionId: 'session-single-member',
    })
    const worker = startWorker({
      ...fixture.env,
      TEAM_RUNTIME_RECOVERY: '1',
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-checkpoint-publication',
    }, false)
    const outcome = await worker.outcome
    assert.equal(
      outcome.code,
      0,
      `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
    )
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.fixtureRoot, 'provider-log.txt'), 'utf8')
        .trim()
        .split('\n'),
      ['coordinator-completion'],
    )
    const messages = fs.readFileSync(
      path.join(fixture.assignmentPath, 'logs', 'team-chat-messages.jsonl'),
      'utf8',
    )
    assert.equal(
      countText(messages, 'Checkpointed reply awaiting durable publication.'),
      1,
    )
    assert.equal(
      countText(messages, 'Lead completed from the recovered reply.'),
      1,
    )
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('the roster-receipt crash point does not fire on the lead\'s decision call', {
  timeout: 60_000,
}, async () => {
  // The crash point SIGKILLs the process it fires in. The runtime runs in the
  // worker, so a crash on the decision call fails an assertion here, and the
  // cleanup below still runs.
  const restoredAtMs = Date.parse('2026-01-01T00:00:00.000Z')
  const fixture = createSingleMemberFixture({
    prefix: 'discussion-crash-point-decision-',
    fakeClaude: ({ providerLog }) => `#!/usr/bin/env node
const fs = require('node:fs')
const schemaIndex = process.argv.indexOf('--json-schema')
const schema = schemaIndex === -1 ? null : process.argv[schemaIndex + 1]
if (schema === null) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'unexpected-specialist-call\\n')
  process.exitCode = 1
} else if (schema.includes('rosterRationale')) {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'unexpected-roster-call\\n')
  process.exitCode = 1
} else {
  fs.appendFileSync(${JSON.stringify(providerLog)}, 'coordinator-decision\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: {
      decision: 'complete',
      reason: 'The member answered.',
      finalResponse: 'Lead synthesis.',
    },
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 5, output_tokens: 5 },
    total_cost_usd: 0,
  }) + '\\n')
}
`,
  })
  let worker: RunningWorker | undefined
  try {
    // A restart after the first specialist pass: the roster is locked and
    // announced, and the next call is the lead's decision.
    writeCheckpoint(fixture.assignmentPath, {
      sessionId: 'assignment-single-member',
      currentLevelIndex: 0,
      levelStates: new Map([[
        'discuss',
        {
          status: 'active',
          stageStatus: STAGE_LIFECYCLE_STATUS.RUNNING,
          loopbackCount: 0,
          visitCount: 0,
          engineState: {
            type: STAGE_TYPE.DISCUSSION,
            round: 1,
            messages: [{
              from: 'member',
              target: 'member',
              to: 'all',
              round: 1,
              timestamp: new Date(restoredAtMs).toISOString(),
              type: 'position',
              message: 'Checkpointed member review.',
              dispatchId: 'dispatch-checkpointed-member',
            }],
            outputPath: fixture.assignmentPath,
            approvedRoster: ['member'],
            rosterAnnounced: true,
            continuation: { phase: 'awaiting_lead_decision', startedAtMs: restoredAtMs },
          },
        },
      ]]),
      totalCost: 0,
      startTime: restoredAtMs,
      timerStarted: true,
      endTime: null,
      spawnDepth: 0,
      rootSessionId: 'session-single-member',
    })
    worker = startWorker({
      ...fixture.env,
      TEAM_RUNTIME_PROCESS_IDENTITY: 'process-crash-point-decision',
      TEAM_RUNTIME_FAULT_INJECT: 'crash_after_discussion_selection_receipt',
    }, false)
    const outcome = await withinDeadline(worker.outcome, 30_000, 'the worker exiting')
    const output = `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`
    assert.equal(outcome.signal, null, `the worker was not killed; ${output}`)
    assert.equal(outcome.code, 0, output)

    assert.deepEqual(
      fs.readFileSync(path.join(fixture.fixtureRoot, 'provider-log.txt'), 'utf8').trim().split('\n'),
      ['coordinator-decision'],
    )
    const receipt: unknown = JSON.parse(fs.readFileSync(durableCoordinatorCallReceiptPath(
      fixture.assignmentPath,
      'assignment-single-member:discussion:discuss:visit:0:decision:1:wrap-up',
    ), 'utf8'))
    assert.ok(receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt))
    assert.equal(Reflect.get(receipt, 'phase'), 'completed')
    const runtimeEvents = readAssignmentJsonl(fixture.assignmentPath, ASSIGNMENT_LOG.runtimeEvents)
    assert.deepEqual(
      runtimeEvents.filter((record) => record.event === 'runtime.stage_autostart.end').map((record) => record.is_error),
      [false],
    )
    assert.deepEqual(runtimeEvents.filter((record) => record.event === 'run.failed'), [])
  } finally {
    if (worker && worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill('SIGKILL')
      await worker.outcome
    }
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

/** A fake `claude` that selects `member`, takes its one reply, and completes. */
function selectReplyCompleteClaude({ providerLog }: { providerLog: string }): string {
  return `#!/usr/bin/env node
const fs = require('node:fs')
const schemaIndex = process.argv.indexOf('--json-schema')
const schema = schemaIndex === -1 ? null : process.argv[schemaIndex + 1]
const kind = schema === null
  ? 'member-pass'
  : schema.includes('rosterRationale') ? 'coordinator-selection' : 'coordinator-completion'
fs.appendFileSync(${JSON.stringify(providerLog)}, kind + '\\n')
const payload = kind === 'member-pass'
  ? { result: 'Member review.' }
  : {
      structured_output: kind === 'coordinator-selection'
        ? { agents: ['member'], rosterRationale: { member: 'The requested review needs this specialist.' } }
        : { decision: 'complete', reason: 'The member answered.', finalResponse: 'Lead synthesis.' },
    }
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  ...payload,
  model: 'claude-haiku-4-5',
  usage: { input_tokens: 5, output_tokens: 5 },
  total_cost_usd: 0,
}) + '\\n')
`
}

/**
 * Run a Team chat discussion in the worker with `crashPoint` set, and assert
 * the worker was not killed and the discussion completed. The crash points
 * SIGKILL the process they fire in, so the runtime runs in the worker and this
 * process owns the cleanup.
 */
async function assertTeamChatPassesCrashPoint(prefix: string, crashPoint: string): Promise<void> {
  const fixture = createSingleMemberFixture({ prefix, fakeClaude: selectReplyCompleteClaude })
  let worker: RunningWorker | undefined
  try {
    worker = startWorker({
      ...fixture.env,
      TEAM_RUNTIME_PROCESS_IDENTITY: `process-${prefix}`,
      TEAM_RUNTIME_FAULT_INJECT: crashPoint,
    }, false)
    const outcome = await withinDeadline(worker.outcome, 30_000, 'the worker exiting')
    const output = `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`
    assert.equal(outcome.signal, null, `the worker was not killed; ${output}`)
    assert.equal(outcome.code, 0, output)

    assert.deepEqual(
      fs.readFileSync(path.join(fixture.fixtureRoot, 'provider-log.txt'), 'utf8').trim().split('\n'),
      ['coordinator-selection', 'member-pass', 'coordinator-completion'],
    )
    // Every provider request the run logged went to `claude`, which is the
    // fake first on the worker's PATH; the fake logged each of them above.
    assert.deepEqual(
      readAssignmentJsonl(fixture.assignmentPath, 'provider-events.jsonl')
        .filter((record) => record.event === 'request.start')
        .map((record) => record.provider),
      ['claude', 'claude', 'claude'],
    )
    const runtimeEvents = readAssignmentJsonl(fixture.assignmentPath, ASSIGNMENT_LOG.runtimeEvents)
    assert.deepEqual(
      runtimeEvents.filter((record) => record.event === 'runtime.stage_autostart.end').map((record) => record.is_error),
      [false],
    )
    assert.equal(runtimeEvents.filter((record) => record.event === 'run.completed').length, 1)
    assert.deepEqual(runtimeEvents.filter((record) => record.event === 'run.failed'), [])
  } finally {
    if (worker && worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill('SIGKILL')
      await worker.outcome
    }
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
}

test('a Team chat discussion does not fire the setup-checkpoint crash point', {
  timeout: 60_000,
}, async () => {
  await assertTeamChatPassesCrashPoint(
    'discussion-chat-setup-crash-point-',
    'crash_after_discussion_setup_checkpoint',
  )
})

test('a Team chat discussion does not fire the non-chat completion crash point', {
  timeout: 60_000,
}, async () => {
  await assertTeamChatPassesCrashPoint(
    'discussion-chat-completion-crash-point-',
    'crash_after_non_chat_discussion_completion_checkpoint',
  )
})
