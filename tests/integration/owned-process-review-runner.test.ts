import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { runTeam } from '../../domains/agent-execution/agent-runner.js'
import type { TeamRegistryEntry } from '../../core/types.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import { createWorkflowModelChoiceEvaluator } from '../../services/workflow-model-choice-evaluator.js'
import { runWorkflowOutcome } from '../../workflows/runner.js'
import {
  closeOwnedProcessScope,
  closeOwnedProcessSubtree,
  readScopeClosure,
} from '../../core/owned-processes/owned-process-closer.js'
import { probeProcessGroup } from '../../core/owned-processes/owned-process-probe.js'
import {
  OWNED_PROCESS_SCOPE_ENV,
  ownedProcessResolvedFolder,
  ownedProcessScopeFolders,
} from '../../core/owned-processes/owned-process-records.js'
import {
  ownedProcessHostInvocation,
  prepareOwnedProcess,
} from '../../core/owned-processes/owned-process-spawn.js'
import { requiredValue } from '../../core/required-value.js'
import {
  describeErrors,
  processesCarrying,
  stopAllCarrying,
  stopProcessesCarrying,
  stopProcessesWithEnvironment,
  withinBound,
} from '../support/fixture-process-markers.js'

// Findings from the adversarial review of the owned-process branch that live in
// the delegated runner (domains/agent-execution/agent-runner.ts) and the closer.
// Requirement behind every case: nothing signals a process whose identity is not
// verified (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// invariant 1).
//
// Real processes throughout. The test process is the root worker: it holds the
// attempt's ownership scope, published in the ADR's format, and runs a Team step
// through the product's own runTeam. The fake Pi starts helpers and nested Teams
// through the same compiled runTeam, so every spawn takes the product's path.

const repoRoot = process.cwd()
const TEAM_PATH = path.join(repoRoot, 'teams', 'writing-team')

const HARNESS_ENV_KEYS = [
  'NODE_ENV',
  'PATH',
  'TEAM_RUNTIME_PI_CLI_PATH',
  'TEAM_RUNTIME_PI_NODE_PATH',
  'TEAM_RUNTIME_TEST_CONTROL_DIR',
  'TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE',
  'TEAM_RUNTIME_TEST_HELPER_MARKER',
  'TEAM_RUNTIME_TEST_SCENARIO',
  'TEAM_RUNTIME_OWNED_PROCESS_SCOPE',
  'PIPELINE_TEST_FIXTURE_ID',
] as const

/**
 * What the step's Team child does. `nested-then-exit`: start the helper and a
 * nested Team, then exit 0. `helper-then-hold`: start the helper, record its
 * own temporary directory, and run until it is signalled.
 */
type Scenario = 'nested-then-exit' | 'helper-then-hold'

/** Names this harness's fixture identity; not read by any product code. */
const FIXTURE_ID_ENV = 'PIPELINE_TEST_FIXTURE_ID'
const EVENT_BOUND_MS = 20_000
const SETTLE_BOUND_MS = 15_000

interface Harness {
  readonly fixtureId: string
  readonly rootPath: string
  readonly workspacePath: string
  readonly controlPath: string
  readonly fakePiPath: string
  readonly scopePath: string
  /** The same-group helper's own marker, on its command line. */
  readonly helperMarker: string
}

/**
 * The fake Pi. As the step's Team child (depth 1) it starts a helper in its
 * own process group that logs every catchable signal it is sent, so SIGTERM
 * does not stop it, and waits until the helper is ready. Then, by scenario, it
 * either starts one nested Team, waits until that Team runs, and exits 0, or
 * records its temporary directory and runs until SIGTERM ends it. As the
 * nested Team (depth 2) it ignores SIGTERM, logging it, and runs until it is
 * killed. Every log is a file in the control folder.
 */
function writeFakePi(filePath: string): void {
  fs.writeFileSync(
    filePath,
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const HELPER = [
  "const fs = require('node:fs')",
  "const log = process.env.REVIEW_HELPER_SIGNAL_LOG",
  "for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR1']) process.on(name, () => fs.appendFileSync(log, name + '\\\\n'))",
  "process.stdout.write('ready\\\\n')",
  "setInterval(() => {}, 1 << 30)",
].join('\\n')

async function main() {
  const control = process.env.TEAM_RUNTIME_TEST_CONTROL_DIR
  const depth = Number(process.env.TEAM_SPAWN_DEPTH || '0')
  if (depth >= 2) {
    process.on('SIGTERM', () => fs.appendFileSync(path.join(control, 'signals-nested.log'), 'SIGTERM\\n'))
    fs.writeFileSync(path.join(control, 'nested-running'), String(process.pid))
    setInterval(() => {}, 1 << 30)
    return
  }
  // Not detached, so it shares this process's group, and on pipes of its own,
  // so it cannot keep the host's output open.
  const helper = spawn(process.execPath, ['-e', HELPER, '--', process.env.TEAM_RUNTIME_TEST_HELPER_MARKER], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, REVIEW_HELPER_SIGNAL_LOG: path.join(control, 'signals-helper.log') },
  })
  await new Promise((resolve, reject) => {
    helper.stdout.once('data', resolve)
    helper.once('exit', () => reject(new Error('the helper exited before it was ready')))
  })
  if (process.env.TEAM_RUNTIME_TEST_SCENARIO === 'helper-then-hold') {
    fs.writeFileSync(path.join(control, 'child-tmpdir'), process.env.TMPDIR || '')
    fs.writeFileSync(path.join(control, 'child-ready'), String(process.pid))
    setInterval(() => {}, 1 << 30)
    return
  }
  const { runTeam } = await import(pathToFileURL(process.env.TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE).href)
  const running = path.join(control, 'nested-running')
  const nestedRuns = new Promise((resolve) => {
    const watcher = fs.watch(control, () => {
      if (fs.existsSync(running)) { watcher.close(); resolve() }
    })
    if (fs.existsSync(running)) { watcher.close(); resolve() }
  })
  runTeam({
    teamPath: path.dirname(process.env.TEAM_CONFIG_PATH),
    workspacePath: process.env.TEAM_WORKSPACE_PATH,
    brief: 'Nested Team',
    spawnDepth: depth,
    childSessionId: 'nested-' + process.pid,
  }).catch(() => {})
  await nestedRuns
  process.exit(0)
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
})
`,
    { mode: 0o755 },
  )
}

async function withHarness(scenario: Scenario, fn: (harness: Harness) => Promise<void>): Promise<void> {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-review-runner-'))
  const workspacePath = path.join(rootPath, 'workspace')
  const controlPath = path.join(rootPath, 'control')
  const binPath = path.join(rootPath, 'bin')
  for (const folder of [workspacePath, controlPath, binPath]) fs.mkdirSync(folder, { recursive: true })
  const fakePiPath = path.join(binPath, 'pi')
  writeFakePi(fakePiPath)

  // The attempt's scope, published as the launcher publishes it.
  const sessionId = randomUUID()
  const taskId = randomUUID()
  const scopePath = path.join(workspacePath, 'sessions', sessionId, 'tasks', taskId, 'owned-processes', 'attempt-1')
  for (const folder of ['intents', 'claims', 'fences', '.staging']) {
    fs.mkdirSync(path.join(scopePath, folder), { recursive: true })
  }
  fs.writeFileSync(path.join(scopePath, 'scope.json'), `${JSON.stringify({
    version: 1,
    taskId,
    sessionId,
    executionAttemptNumber: 1,
    createdAt: new Date().toISOString(),
  })}\n`)

  const previous = new Map<string, string | undefined>(HARNESS_ENV_KEYS.map((key) => [key, process.env[key]]))
  const fixtureId = randomUUID()
  const helperMarker = `--review-runner-fixture-helper=${randomUUID()}`
  process.env.NODE_ENV = 'test'
  process.env.PATH = `${binPath}${path.delimiter}${previous.get('PATH') ?? ''}`
  process.env.TEAM_RUNTIME_PI_CLI_PATH = fakePiPath
  process.env.TEAM_RUNTIME_PI_NODE_PATH = process.execPath
  process.env.TEAM_RUNTIME_TEST_CONTROL_DIR = controlPath
  process.env.TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE = fileURLToPath(
    new URL('../../domains/agent-execution/agent-runner.js', import.meta.url),
  )
  process.env.TEAM_RUNTIME_TEST_HELPER_MARKER = helperMarker
  process.env.TEAM_RUNTIME_TEST_SCENARIO = scenario
  process.env.TEAM_RUNTIME_OWNED_PROCESS_SCOPE = scopePath
  // Inherited by every process this harness starts, and by their children.
  process.env[FIXTURE_ID_ENV] = fixtureId

  const harness: Harness = { fixtureId, rootPath, workspacePath, controlPath, fakePiPath, scopePath, helperMarker }
  let bodyFailure: { readonly error: unknown } | undefined
  try {
    await fn(harness)
  } catch (error) {
    bodyFailure = { error }
  }
  // Every step is attempted whatever failed before, and each process is
  // rechecked by its identity immediately before its signal.
  const cleanupErrors: unknown[] = []
  for (const step of [
    () => stopProcessesWithEnvironment(FIXTURE_ID_ENV, fixtureId),
    () => stopProcessesCarrying(helperMarker),
    () => stopProcessesCarrying(fakePiPath),
  ]) {
    try {
      await step()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  for (const key of HARNESS_ENV_KEYS) {
    const value = previous.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (cleanupErrors.length === 0) fs.rmSync(rootPath, { recursive: true, force: true })
  if (bodyFailure && cleanupErrors.length > 0) {
    throw new AggregateError(
      [bodyFailure.error, ...cleanupErrors],
      `The test failed, and so did its process cleanup; ${rootPath} is kept as evidence: ${describeErrors(cleanupErrors)}`,
    )
  }
  if (bodyFailure) throw bodyFailure.error
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `Process cleanup failed; ${rootPath} is kept as evidence: ${describeErrors(cleanupErrors)}`)
  }
}

/** Resolves once the file at `filePath` holds `text`, as reported by a watch on its folder. */
async function fileHolds(filePath: string, text: string, description: string): Promise<void> {
  const holds = (): boolean => fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(text)
  let watcher: fs.FSWatcher | undefined
  try {
    await withinBound(new Promise<void>((resolve) => {
      watcher = fs.watch(path.dirname(filePath), () => {
        if (holds()) resolve()
      })
      if (holds()) resolve()
    }), EVENT_BOUND_MS, description)
  } finally {
    watcher?.close()
  }
}

function readIfPresent(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
}

test('an abort that arrives while an exited child\'s subtree is being closed signals nothing in that child\'s old group', { timeout: 90_000 }, async () => {
  await withHarness('nested-then-exit', async (harness) => {
    const step = new AbortController()
    const settled = runTeam({
      teamPath: TEAM_PATH,
      workspacePath: harness.workspacePath,
      brief: 'A step whose child exits while its nested Team still runs.',
      spawnDepth: 0,
      childSessionId: `child-${randomUUID()}`,
      signal: step.signal,
    }).then(() => 'resolved', (error: unknown) => (error instanceof Error ? error.message : String(error)))

    // The child has exited and the subtree close has verified the nested
    // Team's host and sent its group SIGTERM, which the nested Team ignores:
    // the close is now inside its grace period, after the child's close.
    await fileHolds(path.join(harness.controlPath, 'signals-nested.log'), 'SIGTERM', 'the subtree close to signal the nested Team')
    assert.equal(processesCarrying(harness.helperMarker).length, 1, 'arrangement: the child\'s same-group helper runs')

    step.abort()
    await withinBound(settled, SETTLE_BOUND_MS, 'the step to settle')

    // The child's host was reaped at its close, so its group is no longer the
    // runner's to signal: only the closer, which verifies every target, may.
    assert.deepEqual(
      {
        helperSignals: readIfPresent(path.join(harness.controlPath, 'signals-helper.log')),
        helperRuns: processesCarrying(harness.helperMarker).length === 1,
      },
      { helperSignals: '', helperRuns: true },
      'a late abort must not signal the reaped host\'s group, where the child\'s helper still runs',
    )
  })
})

test('a cancelled step whose child\'s group needs SIGKILL settles as cancelled and removes its private directory', { timeout: 90_000 }, async () => {
  await withHarness('helper-then-hold', async (harness) => {
    const step = new AbortController()
    const settled = runTeam({
      teamPath: TEAM_PATH,
      workspacePath: harness.workspacePath,
      brief: 'A step cancelled while a helper in its child\'s group ignores SIGTERM.',
      spawnDepth: 0,
      childSessionId: `child-${randomUUID()}`,
      signal: step.signal,
    }).then(
      (result) => ({ kind: 'reported' as const, exitSignal: result.exitSignal, message: '' }),
      (error: unknown) => ({ kind: 'rejected' as const, exitSignal: null, message: error instanceof Error ? error.message : String(error) }),
    )

    await fileHolds(path.join(harness.controlPath, 'child-ready'), '', 'the child and its helper to be ready')
    const temporaryPath = fs.readFileSync(path.join(harness.controlPath, 'child-tmpdir'), 'utf8')
    assert.ok(temporaryPath.length > 0 && fs.existsSync(temporaryPath), 'arrangement: the attempt\'s temporary directory exists')

    // SIGTERM ends the child and its host, so the child closes, while the
    // helper in the same group outlives it until the group is SIGKILLed.
    step.abort()
    const outcome = await withinBound(settled, SETTLE_BOUND_MS, 'the cancelled step to settle')

    assert.deepEqual(
      {
        outcome: outcome.kind,
        // SIGTERM when the host exits with its target; SIGKILL when the host
        // stays while the helper runs and the group's SIGKILL ends it too.
        endedByTermination: outcome.exitSignal === 'SIGTERM' || outcome.exitSignal === 'SIGKILL',
        heldSubtree: outcome.message.includes('could not be verified gone'),
        temporaryPathExists: fs.existsSync(temporaryPath),
        helperRuns: processesCarrying(harness.helperMarker).length > 0,
      },
      {
        outcome: 'reported',
        endedByTermination: true,
        heldSubtree: false,
        temporaryPathExists: false,
        helperRuns: false,
      },
      'once the group is confirmed gone, the subtree is closed and the step reports its cancellation, ' +
        'releasing its private directory: ' + outcome.message,
    )
  })
})

// ── The closer and the host, without a runner ────────────────────────────────

interface ClosureScene {
  readonly root: string
  readonly scopePath: string
  /** Every fixture marker this scene started a process with, for cleanup. */
  readonly markers: string[]
}

/**
 * One scope folder and the processes a closer test starts. Cleanup stops every
 * process by its own fixture marker, rechecked immediately before its signal,
 * attempts every marker whatever failed before, and keeps the folder on any
 * failure.
 */
async function withClosureScene(fn: (scene: ClosureScene) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-review-closer-'))
  const scene: ClosureScene = { root, scopePath: path.join(root, 'attempt-1'), markers: [] }
  for (const folder of Object.values(ownedProcessScopeFolders(scene.scopePath))) fs.mkdirSync(folder, { recursive: true })
  const failures: unknown[] = []
  try {
    await fn(scene)
  } catch (error) {
    failures.push(error)
  }
  failures.push(...await stopAllCarrying(scene.markers))
  if (failures.length === 0) fs.rmSync(root, { recursive: true, force: true })
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `closer test and its cleanup failed; ${root} is kept: ${describeErrors(failures)}`)
}

/** Resolves with the host's output once it holds `line`. */
async function outputLine(stream: Readable, line: string, description: string): Promise<void> {
  await withinBound(new Promise<void>((resolve) => {
    let seen = ''
    stream.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8')
      if (seen.includes(`${line}\n`)) resolve()
    })
  }), EVENT_BOUND_MS, description)
}

test('a host whose target obeyed SIGTERM stays verifiable while its group runs, so the closer SIGKILLs a straggler', async () => {
  await withClosureScene(async (scene) => {
    const targetMarker = `--review-runner-fixture-target=${randomUUID()}`
    const stragglerMarker = `--review-runner-fixture-straggler=${randomUUID()}`
    scene.markers.push(targetMarker, stragglerMarker)
    const prepared = requiredValue(
      await prepareOwnedProcess({
        environment: { [OWNED_PROCESS_SCOPE_ENV]: scene.scopePath },
        kind: 'team',
        childRunId: 'child-run',
        spawnerRunId: 'run',
        spawnerAssignmentId: 'assignment',
      }),
      'the owned process intent',
    )
    // The target stops on SIGTERM. The straggler it starts stays in the
    // host's group, ignores SIGTERM, and says when it is ready.
    const straggler = [
      "process.on('SIGTERM', () => {})",
      "process.stdout.write('straggler-ready\\n')",
      'setInterval(() => {}, 1 << 30)',
    ].join('\n')
    const targetScript = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(straggler)}, '--', ${JSON.stringify(stragglerMarker)}], { stdio: ['ignore', 'inherit', 'inherit'] })`,
      'setInterval(() => {}, 1 << 30)',
    ].join('\n')
    const invocation = ownedProcessHostInvocation({
      ownedProcessId: prepared.ownedProcessId,
      command: process.execPath,
      args: ['-e', targetScript, '--', targetMarker],
    })
    const host = spawn(invocation.command, [...invocation.args], {
      cwd: scene.root,
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, [OWNED_PROCESS_SCOPE_ENV]: scene.scopePath },
    })
    const hostPid = requiredValue(host.pid, 'host pid')
    const hostExited = once(host, 'exit')
    await outputLine(requiredValue(host.stdout, 'host stdout'), 'straggler-ready', 'the straggler to be ready')
    assert.equal(processesCarrying(stragglerMarker).length, 1, 'arrangement: the straggler runs in the host\'s group')

    const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')
    await withinBound(hostExited, EVENT_BOUND_MS, 'the host to exit')

    assert.deepEqual(
      {
        result,
        group: probeProcessGroup(hostPid).kind,
        stragglerRuns: processesCarrying(stragglerMarker).length > 0,
      },
      { result: { kind: 'closed' }, group: 'gone', stragglerRuns: false },
      'SIGTERM ended the target; the host must still be verifiable so the closer can SIGKILL the rest of its group',
    )
  })
})

test('a host whose target obeyed SIGTERM, with nothing else in its group, ends with that signal before a closer escalates', async () => {
  await withClosureScene(async (scene) => {
    const targetMarker = `--review-runner-fixture-target=${randomUUID()}`
    scene.markers.push(targetMarker)
    const prepared = requiredValue(
      await prepareOwnedProcess({
        environment: { [OWNED_PROCESS_SCOPE_ENV]: scene.scopePath },
        kind: 'team',
        childRunId: 'child-run',
        spawnerRunId: 'run',
        spawnerAssignmentId: 'assignment',
      }),
      'the owned process intent',
    )
    // The target stops on SIGTERM and starts nothing, so once it exits the
    // host is alone in its group.
    const invocation = ownedProcessHostInvocation({
      ownedProcessId: prepared.ownedProcessId,
      command: process.execPath,
      args: ['-e', "process.stdout.write('target-ready\\n'); setInterval(() => {}, 1 << 30)", '--', targetMarker],
    })
    const host = spawn(invocation.command, [...invocation.args], {
      cwd: scene.root,
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, [OWNED_PROCESS_SCOPE_ENV]: scene.scopePath },
    })
    const hostExited = once(host, 'exit')
    await outputLine(requiredValue(host.stdout, 'host stdout'), 'target-ready', 'the target to be ready')

    // The closer verifies the host, sends its group SIGTERM, and waits its
    // grace for the group to go before it checks the host again and SIGKILLs.
    const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')
    const exit = await withinBound(hostExited, EVENT_BOUND_MS, 'the host to exit')

    assert.deepEqual(
      { result, exit },
      { result: { kind: 'closed' }, exit: [null, 'SIGTERM'] },
      'with nothing else in its group, the host must exit with its target\'s signal within the closer\'s grace, ' +
        'not stay on until the closer SIGKILLs it',
    )
  })
})

/**
 * A process the test controls that stands in for a reused pid. It starts in
 * the test's own process group, so it leads none, logs every catchable signal
 * but SIGUSR1, and on SIGUSR1 makes itself the leader of a new group.
 */
const REUSED_PID_SCRIPT = [
  '$| = 1;',
  'for my $name (qw(TERM INT HUP)) {',
  '  $SIG{$name} = sub { open(my $log, ">>", $ENV{REVIEW_SIGNAL_LOG}); print $log "$name\\n"; close($log); };',
  '}',
  '$SIG{USR1} = sub { setpgrp(0, 0); print "leader\\n"; };',
  'print "ready\\n";',
  'sleep 1 while 1;',
].join('\n')

test('a host claim a closer resolved stays resolved after its pid comes to lead a live group', async () => {
  await withClosureScene(async (scene) => {
    const reusedMarker = `--review-runner-fixture-reused=${randomUUID()}`
    scene.markers.push(reusedMarker)
    const signalLog = path.join(scene.root, 'reused-signals.log')
    const prepared = requiredValue(
      await prepareOwnedProcess({
        environment: { [OWNED_PROCESS_SCOPE_ENV]: scene.scopePath },
        kind: 'team',
        childRunId: 'finished-step-child',
        spawnerRunId: 'run',
        spawnerAssignmentId: 'assignment',
      }),
      'the owned process intent',
    )
    const reused = spawn('perl', ['-e', REUSED_PID_SCRIPT, '--', reusedMarker], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, REVIEW_SIGNAL_LOG: signalLog },
    })
    const reusedPid = requiredValue(reused.pid, 'reused pid fixture')
    const reusedOutput = requiredValue(reused.stdout, 'reused pid fixture stdout')
    await outputLine(reusedOutput, 'ready', 'the reused pid fixture to be ready')
    // The claim a long-finished host left: its pid and group, which no process
    // leads any more.
    fs.writeFileSync(path.join(ownedProcessScopeFolders(scene.scopePath).claims, `${prepared.ownedProcessId}.json`), JSON.stringify({
      version: 1,
      ownedProcessId: prepared.ownedProcessId,
      claimant: 'host',
      pid: reusedPid,
      processGroupId: reusedPid,
      claimedAt: new Date().toISOString(),
    }))
    assert.equal(probeProcessGroup(reusedPid).kind, 'gone', 'arrangement: no group has the claimed id yet')
    assert.deepEqual(
      await closeOwnedProcessSubtree(scene.scopePath, prepared.ownedProcessId, 'spawner'),
      { kind: 'closed' },
      'arrangement: the step\'s subtree close resolved the finished host',
    )

    // Later, the claimed id comes to lead a live group, as a reused pid would.
    const leading = outputLine(reusedOutput, 'leader', 'the reused pid fixture to lead a group')
    reused.kill('SIGUSR1')
    await leading
    assert.equal(probeProcessGroup(reusedPid).kind, 'alive', 'arrangement: the claimed id now leads a live group')

    const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')

    assert.deepEqual(
      {
        result,
        closure: await readScopeClosure(scene.scopePath),
        signals: fs.existsSync(signalLog) ? fs.readFileSync(signalLog, 'utf8') : '',
        reusedRuns: processesCarrying(reusedMarker).length === 1,
      },
      { result: { kind: 'closed' }, closure: { kind: 'closed' }, signals: '', reusedRuns: true },
      'an intent already resolved stays resolved: a pid reused since must not hold the attempt, and is never signalled',
    )
  })
})

test('an unreadable resolved record holds the intent rather than being probed past', async () => {
  await withClosureScene(async (scene) => {
    const prepared = requiredValue(
      await prepareOwnedProcess({
        environment: { [OWNED_PROCESS_SCOPE_ENV]: scene.scopePath },
        kind: 'team',
        childRunId: 'finished-step-child',
        spawnerRunId: 'run',
        spawnerAssignmentId: 'assignment',
      }),
      'the owned process intent',
    )
    // A host that has exited, so a probe of its claim would find it gone.
    const exited = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' })
    const exitedPid = requiredValue(exited.pid, 'exited host pid')
    await withinBound(once(exited, 'exit'), EVENT_BOUND_MS, 'the exited host to exit')
    const folders = ownedProcessScopeFolders(scene.scopePath)
    fs.writeFileSync(path.join(folders.claims, `${prepared.ownedProcessId}.json`), JSON.stringify({
      version: 1,
      ownedProcessId: prepared.ownedProcessId,
      claimant: 'host',
      pid: exitedPid,
      processGroupId: exitedPid,
      claimedAt: new Date().toISOString(),
    }))
    const resolvedFolder = ownedProcessResolvedFolder(scene.scopePath)
    fs.mkdirSync(resolvedFolder, { recursive: true })
    fs.writeFileSync(path.join(resolvedFolder, `${prepared.ownedProcessId}.json`), '')

    const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')

    assert.deepEqual(
      {
        kind: result.kind,
        heldIds: result.kind === 'held' ? result.unverifiable.map((member) => member.ownedProcessId) : [],
        closure: (await readScopeClosure(scene.scopePath)).kind,
      },
      { kind: 'held', heldIds: [prepared.ownedProcessId], closure: 'open' },
      'a resolved record that cannot be read proves nothing, and is never read as absent',
    )
  })
})

// ── A held Team subtree fails its workflow step (the owner's T5 decision) ──

/** The Agent's own pinned pair. Deliberately unregistered, so it cannot run. */
const PINNED = { provider: 'connection:missing-connection', model: 'pinned-model' }
/** Also unregistered: nothing here may reach a network. */
const APP_DEFAULT = { provider: 'connection:missing-default', model: 'default-model' }
/** `.tests-dist`, so the spawned child loads the same compiled production code. */
const DIST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The step's Team child. It starts a helper in its own process group, on
 * output of its own, that ignores SIGTERM and never exits; then performs a real
 * dispatch for an Agent pinned to a connection that does not exist, so the
 * production adapter records an eligible failure; then ends without its
 * artifact.
 */
function writeHeldStepChild(root: string): string {
  const directory = path.join(root, 'fake-pi')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'pi'),
    `#!/usr/bin/env node
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const load = (relative) => import(pathToFileURL(path.join(process.env.REVIEW_HELD_DIST_ROOT, relative)).href)

async function main() {
  const straggler = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30)", '--', process.env.REVIEW_HELD_STRAGGLER_MARKER], {
    stdio: 'ignore',
  })
  await new Promise((resolve, reject) => {
    straggler.once('spawn', resolve)
    straggler.once('error', reject)
  })
  const providers = await load('providers/index.js')
  const configured = await load('providers/configured-provider.js')
  const runner = await load('domains/agent-execution/agent-runner.js')
  providers.initProviders()
  configured.setConfiguredProviderConnections([])
  await runner.dispatchToAgentOrTeam({
    agent: {
      name: 'writer',
      model: ${JSON.stringify(PINNED.model)},
      thinking: 'low',
      tools: [],
      systemPrompt: 'Write the requested draft.',
      experienceContent: '',
      experienceEnabled: false,
      skillsContent: '',
      knowledgeContent: '',
      agentDir: '',
      color: 1,
      provider: ${JSON.stringify(PINNED.provider)},
      providerConfig: {},
      selection: {
        provider: ${JSON.stringify(PINNED.provider)},
        model: ${JSON.stringify(PINNED.model)},
        source: 'agent',
        reason: 'explicit-agent-choice',
      },
    },
    rosterEntry: { type: 'agent' },
    finalPrompt: 'Write the requested draft.',
    userMessage: 'Draft a recommendation.',
    state: {
      sessionId: process.env.TEAM_SESSION_ID || 'child',
      currentLevelIndex: 0,
      levelStates: new Map(),
      totalCost: 0,
      startTime: 0,
      timerStarted: false,
      endTime: null,
      spawnDepth: Number(process.env.TEAM_SPAWN_DEPTH || '1'),
    },
    workspacePath: process.cwd(),
    outputPath: process.cwd(),
    metrics: undefined,
    logicalInvocationId: process.env.TEAM_RUNTIME_WORKFLOW_STEP_ID || 'write',
  }).catch(() => undefined)
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(String((error && error.stack) || error) + '\\n')
    process.exit(1)
  },
)
`,
    { mode: 0o755 },
  )
  return directory
}

/** A one-Team workflow whose Agent is pinned to its own pair. */
function writeHeldStepWorkflow(workspace: string): { templatePath: string; teamPath: string } {
  const teamPath = path.join(workspace, 'teams', 'lonely-writer')
  const agentDir = path.join(workspace, 'agents', 'writer')
  fs.mkdirSync(teamPath, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'writer.md'), [
    '---',
    `provider: ${PINNED.provider}`,
    `model: ${PINNED.model}`,
    'thinking: low',
    '---',
    '',
    'Write the requested draft.',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(teamPath, 'team.yaml'), [
    'team:',
    '  name: lonely-writer',
    '  description: One writer',
    '  version: 0.1.0',
    'workspace:',
    '  path: ./workspace',
    '  watch: false',
    'workflow:',
    '  entry_level: execute',
    '  invocation_modes:',
    '    - user',
    '    - team',
    '  output_contract:',
    '    completion_artifact: final-draft.md',
    'agents:',
    '  - name: writer',
    '    type: agent',
    '    role: Writer',
    '    tier: strategic',
    '    agent_file: ../../agents/writer/writer.md',
    '    produces:',
    '      - path: final-draft.md',
    'levels:',
    '  - id: execute',
    '    name: Execute',
    '    order: 0',
    '    agents:',
    '      - writer',
    '    stage:',
    '      type: pipeline',
    '      config:',
    '        output:',
    '          format: final-draft.md',
    '          user_review: false',
    '',
  ].join('\n'))
  const templatePath = path.join(workspace, 'team-step.yaml')
  fs.writeFileSync(templatePath, [
    'workflow:',
    '  id: team-step-workflow',
    '  steps:',
    '    - id: write',
    '      type: team',
    '      team: lonely-writer',
    '      input_artifact: incoming-brief.md',
    '      result_artifact: final-draft.md',
    '  output:',
    '    from_step: write',
    '    artifact: final-draft.md',
    '',
  ].join('\n'))
  return { templatePath, teamPath }
}

test('a Team step whose subtree is held fails its workflow instead of waiting for a model choice', { timeout: 90_000 }, async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-review-held-step-')))
  const rootRunId = 'root-held-step'
  fs.mkdirSync(path.join(workspace, 'assignments', rootRunId), { recursive: true })
  const scopePath = path.join(workspace, 'owned-processes', 'attempt-1')
  for (const folder of Object.values(ownedProcessScopeFolders(scopePath))) fs.mkdirSync(folder, { recursive: true })
  const { templatePath, teamPath } = writeHeldStepWorkflow(workspace)
  const fakePiDirectory = writeHeldStepChild(workspace)
  const stragglerMarker = `--review-runner-fixture-held-straggler=${randomUUID()}`
  const fixtureId = randomUUID()
  const entry: TeamRegistryEntry = { name: 'lonely-writer', type: 'team', team_path: teamPath, output_artifact: 'final-draft.md' }

  const environmentNames = [
    'PATH',
    'TEAM_RUNTIME_PI_CLI_PATH',
    'TEAM_RUNTIME_OWNED_PROCESS_SCOPE',
    'REVIEW_HELD_DIST_ROOT',
    'REVIEW_HELD_STRAGGLER_MARKER',
    FIXTURE_ID_ENV,
  ] as const
  const originalEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]))
  process.env.PATH = `${fakePiDirectory}${path.delimiter}${process.env.PATH ?? ''}`
  delete process.env.TEAM_RUNTIME_PI_CLI_PATH
  process.env.TEAM_RUNTIME_OWNED_PROCESS_SCOPE = scopePath
  process.env.REVIEW_HELD_DIST_ROOT = DIST_ROOT
  process.env.REVIEW_HELD_STRAGGLER_MARKER = stragglerMarker
  process.env[FIXTURE_ID_ENV] = fixtureId
  initProviders()
  setConfiguredProviderConnections([])
  setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })
  let bodyFailure: { readonly error: unknown } | undefined
  try {
    // A step that fails by throwing is recorded failed in the durable state,
    // with the workflow's failed terminal outcome, and the error is rethrown to
    // the runner's caller (workflows/runner.ts, the step dispatch's catch).
    const settled = await runWorkflowOutcome({
      workflowEntry: { name: 'team-step-workflow', template_path: templatePath },
      teamRegistry: new Map([['lonely-writer', entry]]),
      brief: 'Draft a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: rootRunId,
      parentSessionId: rootRunId,
      taskId: 'task-held-step',
      productSessionId: 'session-held-step',
      persistenceMode: 'required' as const,
      executionAttemptId: 'attempt-one',
      modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
    }).then(
      (outcome) => ({ kind: outcome.kind, heldSubtree: false }),
      (error: unknown) => ({ kind: 'rejected', heldSubtree: error instanceof Error && error.message.includes('could not be verified gone') }),
    )
    const statePath = path.join(workspace, 'assignments', rootRunId, '.runtime', 'workflow-state.json')
    const stored: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    const state: unknown = typeof stored === 'object' && stored !== null && 'state' in stored ? Reflect.get(stored, 'state') : stored
    const steps: unknown = typeof state === 'object' && state !== null ? Reflect.get(state, 'steps') : undefined
    const writeStep: unknown = Array.isArray(steps)
      ? steps.find((step: unknown) => typeof step === 'object' && step !== null && Reflect.get(step, 'stepId') === 'write')
      : undefined

    assert.deepEqual(
      {
        settled: settled.kind,
        heldSubtree: settled.heldSubtree,
        workflowStatus: typeof state === 'object' && state !== null ? Reflect.get(state, 'status') : undefined,
        stepStatus: typeof writeStep === 'object' && writeStep !== null ? Reflect.get(writeStep, 'status') : undefined,
        offered: typeof writeStep === 'object' && writeStep !== null && Reflect.get(writeStep, 'modelChoice') !== undefined,
      },
      { settled: 'rejected', heldSubtree: true, workflowStatus: 'failed', stepStatus: 'failed', offered: false },
      'a step whose descendants could not be verified gone fails; it is not parked for a retry over them',
    )
  } catch (error) {
    bodyFailure = { error }
  } finally {
    setRuntimeDefaultModelState(undefined)
  }
  const cleanupErrors: unknown[] = []
  for (const step of [
    () => stopProcessesWithEnvironment(FIXTURE_ID_ENV, fixtureId),
    () => stopProcessesCarrying(stragglerMarker),
  ]) {
    try {
      await step()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  for (const name of environmentNames) {
    const original = originalEnvironment.get(name)
    if (original === undefined) delete process.env[name]
    else process.env[name] = original
  }
  if (cleanupErrors.length === 0) fs.rmSync(workspace, { recursive: true, force: true })
  if (bodyFailure && cleanupErrors.length > 0) {
    throw new AggregateError([bodyFailure.error, ...cleanupErrors], `The test failed, and so did its cleanup; ${workspace} is kept: ${describeErrors(cleanupErrors)}`)
  }
  if (bodyFailure) throw bodyFailure.error
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `Cleanup failed; ${workspace} is kept: ${describeErrors(cleanupErrors)}`)
})
