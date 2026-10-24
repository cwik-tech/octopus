import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runTeam } from '../../domains/agent-execution/agent-runner.js'
import {
  describeErrors,
  stopProcessesCarrying,
  stopProcessesWithEnvironment,
  withinBound,
} from '../support/fixture-process-markers.js'

// Requirement (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// verification item 5): cancelling one step's Team child stops every
// descendant of that child, including nested Teams that live in their own
// process groups and a nested spawner that keeps starting more, and none
// starts afterwards; a sibling child of the same attempt keeps running.
//
// Real processes throughout. The test process is the root worker: it holds
// the attempt's ownership scope, published in the ADR's format, and runs two
// Team children through the product's own runTeam. The fake Pi nests further
// Teams through the same compiled runTeam, so every spawn below takes the
// product's delegated spawn path.

const repoRoot = process.cwd()
const TEAM_PATH = path.join(repoRoot, 'teams', 'writing-team')
const NESTED_LIMIT = 12

const HARNESS_ENV_KEYS = [
  'NODE_ENV',
  'PATH',
  'TEAM_RUNTIME_PI_CLI_PATH',
  'TEAM_RUNTIME_PI_NODE_PATH',
  'TEAM_RUNTIME_TEST_CONTROL_DIR',
  'TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE',
  'TEAM_RUNTIME_TEST_NESTED_LIMIT',
  'TEAM_RUNTIME_OWNED_PROCESS_SCOPE',
  'PIPELINE_TEST_FIXTURE_ID',
] as const

/** Names this harness's fixture identity; not read by any product code. */
const FIXTURE_ID_ENV = 'PIPELINE_TEST_FIXTURE_ID'
const SETTLE_BOUND_MS = 10_000
const ARRANGEMENT_BOUND_MS = 60_000

interface NestedInvocation {
  readonly pid: number
  readonly depth: number
  readonly childRunId: string
}

interface NestedHarness {
  readonly fixtureId: string
  readonly rootPath: string
  readonly workspacePath: string
  readonly controlPath: string
  readonly fakePiPath: string
  readonly scopePath: string
}

function isNestedInvocation(value: unknown): value is NestedInvocation {
  return typeof value === 'object' && value !== null &&
    typeof Reflect.get(value, 'pid') === 'number' &&
    typeof Reflect.get(value, 'depth') === 'number' &&
    typeof Reflect.get(value, 'childRunId') === 'string'
}

function readNestedInvocations(controlPath: string): NestedInvocation[] {
  const filePath = path.join(controlPath, 'invocations.jsonl')
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      assert.ok(isNestedInvocation(parsed), `unreadable invocation line: ${line}`)
      return parsed
    })
}

type ProcessProbe =
  | { readonly running: false }
  | { readonly running: true, readonly groupId: number, readonly command: string }

/**
 * What runs at `pid`, read with `ps`. `ps` exits 1 with no output and no error
 * text when no process has this pid, the only result read as absence; any
 * other failure throws.
 */
function probeProcess(pid: number): ProcessProbe {
  let output: string
  try {
    output = execFileSync('ps', ['-o', 'pgid=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000,
    })
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error && error.status === 1 &&
      'stdout' in error && typeof error.stdout === 'string' && error.stdout.trim() === '' &&
      'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim() === ''
    ) {
      return { running: false }
    }
    throw error
  }
  const match = /^(\d+)\s+(.+)$/su.exec(output.trim())
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Unreadable process listing for ${pid}: ${JSON.stringify(output)}`)
  }
  return { running: true, groupId: Number(match[1]), command: match[2] }
}

/** Whether `pid` still runs this harness's fake Pi, and so is still ours. */
function runsFakePi(harness: NestedHarness, pid: number): boolean {
  const probe = probeProcess(pid)
  return probe.running && probe.command.includes(harness.fakePiPath)
}

/**
 * Resolves with `read()` once it matches, reading again on every change in
 * `folder`: here, each fake Pi appending its invocation. The bound only stops
 * a broken arrangement from outliving the test.
 */
async function waitForChange<T>(params: {
  description: string
  folder: string
  read: () => T
  matches: (value: T) => boolean
}): Promise<T> {
  let watcher: fs.FSWatcher | undefined
  const reached = new Promise<T>((resolve, reject) => {
    const check = (): void => {
      try {
        const latest = params.read()
        if (params.matches(latest)) resolve(latest)
      } catch (error) {
        reject(error)
      }
    }
    // Watched before the first read, so a change between the two is not missed.
    watcher = fs.watch(params.folder, check)
    watcher.on('error', reject)
    check()
  })
  try {
    return await withinBound(reached, ARRANGEMENT_BOUND_MS, params.description)
  } finally {
    watcher?.close()
  }
}

function writeNestedFakePi(filePath: string): void {
  fs.writeFileSync(
    filePath,
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const controlPath = process.env.TEAM_RUNTIME_TEST_CONTROL_DIR
  if (!controlPath) throw new Error('TEAM_RUNTIME_TEST_CONTROL_DIR is required')
  const depth = Number(process.env.TEAM_SPAWN_DEPTH || '0')
  const childRunId = process.env.TEAM_SESSION_ID || path.basename(process.cwd())
  const invocations = path.join(controlPath, 'invocations.jsonl')
  fs.appendFileSync(invocations, JSON.stringify({ pid: process.pid, depth, childRunId }) + '\\n')
  const hold = () => setInterval(() => {}, 1 << 30)
  if (childRunId.startsWith('sibling-') || depth >= 3) {
    hold()
    return
  }
  const { runTeam } = await import(pathToFileURL(process.env.TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE).href)
  const teamPath = path.dirname(process.env.TEAM_CONFIG_PATH)
  const workspacePath = process.env.TEAM_WORKSPACE_PATH
  const start = (childSessionId) => {
    runTeam({ teamPath, workspacePath, brief: 'Nested Team ' + childSessionId, spawnDepth: depth, childSessionId })
      .catch((error) => console.error(error && error.stack ? error.stack : String(error)))
  }
  if (depth === 1) {
    // The step's Team child starts one nested Team.
    start('nested-y-' + process.pid)
    hold()
    return
  }
  // The nested Team keeps starting further nested Teams, each once the one
  // before it has recorded itself, up to a bound.
  const limit = Number(process.env.TEAM_RUNTIME_TEST_NESTED_LIMIT || '12')
  let started = 0
  const startNext = () => {
    if (started >= limit) return
    start('nested-z-' + started + '-' + process.pid)
    started += 1
  }
  const recordedChildren = () => fs.readFileSync(invocations, 'utf8')
    .split('\\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.depth === depth + 1 && entry.childRunId.endsWith('-' + process.pid))
    .length
  fs.watch(invocations, () => {
    if (recordedChildren() >= started) startNext()
  })
  startNext()
  hold()
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
})
`,
    { mode: 0o755 },
  )
}

async function withNestedHarness(fn: (harness: NestedHarness) => Promise<void>): Promise<void> {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-subtree-'))
  const workspacePath = path.join(rootPath, 'workspace')
  const controlPath = path.join(rootPath, 'control')
  const binPath = path.join(rootPath, 'bin')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(controlPath, { recursive: true })
  fs.mkdirSync(binPath, { recursive: true })
  const fakePiPath = path.join(binPath, 'pi')
  writeNestedFakePi(fakePiPath)

  // The attempt's scope, published as the launcher publishes it: the folder
  // derived from the session, task and attempt, and its scope.json.
  const sessionId = randomUUID()
  const taskId = randomUUID()
  const scopePath = path.join(
    workspacePath, 'sessions', sessionId, 'tasks', taskId, 'owned-processes', 'attempt-1',
  )
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

  const previous = new Map<string, string | undefined>(
    HARNESS_ENV_KEYS.map((key) => [key, process.env[key]]),
  )
  process.env.NODE_ENV = 'test'
  process.env.PATH = `${binPath}${path.delimiter}${previous.get('PATH') ?? ''}`
  process.env.TEAM_RUNTIME_PI_CLI_PATH = fakePiPath
  process.env.TEAM_RUNTIME_PI_NODE_PATH = process.execPath
  process.env.TEAM_RUNTIME_TEST_CONTROL_DIR = controlPath
  process.env.TEAM_RUNTIME_TEST_AGENT_RUNNER_MODULE = fileURLToPath(
    new URL('../../domains/agent-execution/agent-runner.js', import.meta.url),
  )
  process.env.TEAM_RUNTIME_TEST_NESTED_LIMIT = String(NESTED_LIMIT)
  process.env.TEAM_RUNTIME_OWNED_PROCESS_SCOPE = scopePath
  // Inherited by every process this harness starts, and by their children.
  const fixtureId = randomUUID()
  process.env[FIXTURE_ID_ENV] = fixtureId

  const harness: NestedHarness = { fixtureId, rootPath, workspacePath, controlPath, fakePiPath, scopePath }
  let bodyFailure: { readonly error: unknown } | undefined
  try {
    await fn(harness)
  } catch (error) {
    bodyFailure = { error }
  }
  // Every step is attempted whatever failed before: everything that inherited
  // this harness's fixture identity, including nested hosts and children no
  // record names, then anything still running this harness's own fake Pi.
  const cleanupErrors: unknown[] = []
  for (const step of [
    () => stopProcessesWithEnvironment(FIXTURE_ID_ENV, fixtureId),
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

/** The intents a scope records, by owned process id. */
function readIntents(scopePath: string): Map<string, { readonly parent: unknown; readonly childRunId: unknown }> {
  const intentsPath = path.join(scopePath, 'intents')
  const intents = new Map<string, { readonly parent: unknown; readonly childRunId: unknown }>()
  if (!fs.existsSync(intentsPath)) return intents
  for (const name of fs.readdirSync(intentsPath).filter((entry) => entry.endsWith('.json'))) {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(intentsPath, name), 'utf8'))
    assert.ok(typeof parsed === 'object' && parsed !== null, `intent ${name} is an object`)
    const ownedProcessId: unknown = Reflect.get(parsed, 'ownedProcessId')
    assert.equal(typeof ownedProcessId, 'string', `intent ${name} names its owned process`)
    intents.set(String(ownedProcessId), {
      parent: Reflect.get(parsed, 'parentOwnedProcessId'),
      childRunId: Reflect.get(parsed, 'childRunId'),
    })
  }
  return intents
}

test('cancelling a step stops every descendant of its Team child, none starts afterwards, and a sibling child keeps running', { timeout: 90_000 }, async () => {
  await withNestedHarness(async (harness) => {
    const cancelledRunId = `child-cancelled-${randomUUID()}`
    const siblingRunId = `sibling-${randomUUID()}`
    const cancelledStep = new AbortController()
    const siblingStep = new AbortController()
    const cancelled = runTeam({
      teamPath: TEAM_PATH,
      workspacePath: harness.workspacePath,
      brief: 'The step that is cancelled.',
      spawnDepth: 0,
      childSessionId: cancelledRunId,
      signal: cancelledStep.signal,
    })
    const sibling = runTeam({
      teamPath: TEAM_PATH,
      workspacePath: harness.workspacePath,
      brief: 'A sibling step of the same attempt.',
      spawnDepth: 0,
      childSessionId: siblingRunId,
      signal: siblingStep.signal,
    })
    try {
      // The arrangement: the sibling, the step's Team child, its nested Team,
      // and at least two of that nested Team's own nested Teams all run.
      const arranged = await waitForChange({
        description: 'the sibling, the cancelled child, its nested Team and two of its nested Teams to start',
        folder: harness.controlPath,
        read: () => readNestedInvocations(harness.controlPath),
        matches: (entries) =>
          entries.some((entry) => entry.childRunId === siblingRunId) &&
          entries.some((entry) => entry.childRunId === cancelledRunId) &&
          entries.some((entry) => entry.depth === 2) &&
          entries.filter((entry) => entry.depth === 3).length >= 2,
      })
      const siblingPid = arranged.find((entry) => entry.childRunId === siblingRunId)?.pid
      assert.ok(siblingPid !== undefined)
      for (const entry of arranged) {
        assert.equal(runsFakePi(harness, entry.pid), true, `${entry.childRunId} runs before the cancellation`)
      }

      cancelledStep.abort()
      await withinBound(cancelled.catch(() => undefined), SETTLE_BOUND_MS, 'the cancelled step to settle')

      // Once the cancellation has settled, nothing below the cancelled child
      // runs: not the child, not its nested Team, and not any nested Team that
      // one started, including those it started while being stopped.
      const descendants = readNestedInvocations(harness.controlPath)
        .filter((entry) => entry.childRunId !== siblingRunId)
      const stillRunning = descendants.filter((entry) => runsFakePi(harness, entry.pid))
      assert.deepEqual(
        stillRunning.map((entry) => `${entry.childRunId} (pid ${entry.pid}, depth ${entry.depth})`),
        [],
        'descendants of the cancelled Team child still run after its cancellation settled',
      )

      // None can start afterwards: the subtree has its fence, and every intent
      // in it is claimed, so a host that has not claimed yet can never start
      // its target.
      const intents = readIntents(harness.scopePath)
      const cancelledId = [...intents].find(([, intent]) => intent.childRunId === cancelledRunId)?.[0]
      assert.ok(cancelledId, `the scope records the cancelled Team child ${cancelledRunId}`)
      assert.equal(
        fs.existsSync(path.join(harness.scopePath, 'fences', `subtree-${cancelledId}.json`)),
        true,
        'the cancelled child\'s subtree is fenced',
      )
      const inSubtree = (id: string): boolean => {
        const seen = new Set<string>()
        let current: string | undefined = id
        while (current !== undefined && !seen.has(current)) {
          if (current === cancelledId) return true
          seen.add(current)
          const parent: unknown = intents.get(current)?.parent
          current = typeof parent === 'string' ? parent : undefined
        }
        return false
      }
      const unclaimed = [...intents.keys()]
        .filter((id) => inSubtree(id))
        .filter((id) => !fs.existsSync(path.join(harness.scopePath, 'claims', `${id}.json`)))
      assert.deepEqual(unclaimed, [], 'every intent in the cancelled subtree is claimed')

      assert.equal(runsFakePi(harness, siblingPid), true, 'the sibling child of the same attempt keeps running')
    } finally {
      siblingStep.abort()
      cancelledStep.abort()
      await withinBound(Promise.allSettled([cancelled, sibling]), SETTLE_BOUND_MS, 'both steps to settle')
    }
  })
})
