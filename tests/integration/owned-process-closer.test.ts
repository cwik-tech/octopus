import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { requiredValue } from '../../core/required-value.js'
import {
  describeErrors,
  processesCarrying,
  stopAllCarrying,
  withinBound,
} from '../support/fixture-process-markers.js'
import {
  closeOwnedProcessScope,
  closeOwnedProcessSubtree,
  readScopeClosure,
} from '../../core/owned-processes/owned-process-closer.js'
import {
  OWNED_PROCESS_ARGUMENT,
  ownedProcessScopeFolders,
} from '../../core/owned-processes/owned-process-records.js'

// Requirements (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// sections 5 and 6): a closer fences first, then resolves each intent: an
// unclaimed one by claiming it; a host verified by its marker, pid and group by
// stopping its group and confirming it gone; and it signals nothing it cannot
// verify: a host that died alone while its group lives, an unreadable claim, a
// failed probe, or an ambiguous marker all hold the scope. A subtree is its root
// and every intent whose lineage reaches it, never a sibling. Only a closed
// scope is recorded as closed.

interface Fixture {
  readonly hostPid: number
  readonly targetPid: number
  /** The fixture's own marker on the host's command line, beside the product marker. */
  readonly hostMarker: string
  /** The fixture's own marker on the target's command line. */
  readonly targetMarker: string
  /** Resolves when the host and its target have both exited. */
  readonly closed: Promise<unknown>
  readonly host: ChildProcess
}

// The target's marker comes through the environment, so it appears on the
// target's command line and never on the host's.
const HOST_SCRIPT = [
  "const { spawn } = require('node:child_process')",
  "const target = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', process.env.OWNED_CLOSER_FIXTURE_TARGET], { stdio: ['ignore', 'inherit', 'inherit'] })",
  "target.on('spawn', () => process.stdout.write('ready ' + target.pid + '\\n'))",
  'setInterval(() => {}, 1 << 30)',
].join('\n')

const CLOSED_BOUND_MS = 5_000

interface Scene {
  readonly root: string
  readonly scopePath: string
  readonly fixtures: Fixture[]
  /** Fixture markers of single processes started outside `startFixture`. */
  readonly markers: string[]
}

/**
 * One scope folder and every process the test starts. Cleanup finds each
 * fixture process by its own marker, rechecks it immediately before its
 * signal, attempts every process whatever failed before, bounds every wait,
 * and reports every error beside the body's, keeping the folder.
 */
async function withScene(fn: (scene: Scene) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-closer-'))
  const scene: Scene = { root, scopePath: path.join(root, 'attempt-1'), fixtures: [], markers: [] }
  for (const folder of Object.values(ownedProcessScopeFolders(scene.scopePath))) fs.mkdirSync(folder, { recursive: true })
  const failures: unknown[] = []
  try {
    await fn(scene)
  } catch (error) {
    failures.push(error)
  }
  failures.push(...await stopAllCarrying(scene.markers))
  for (const fixture of scene.fixtures) {
    const errors = await stopAllCarrying([fixture.targetMarker, fixture.hostMarker])
    failures.push(...errors)
    // Waited for only once both are confirmed gone, and never without a bound.
    if (errors.length === 0) {
      try {
        await withinBound(fixture.closed, CLOSED_BOUND_MS, `fixture host ${fixture.hostPid} to close`)
      } catch (error) {
        failures.push(error)
      }
    }
  }
  if (failures.length === 0) fs.rmSync(root, { recursive: true, force: true })
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `closer test and its cleanup failed; ${root} is kept: ${describeErrors(failures)}`)
}

/**
 * A host leading its own group, carrying `productMarker` and its own fixture
 * marker, with a target in its group carrying the target's fixture marker.
 */
async function startFixture(scene: Scene, productMarker: string): Promise<Fixture> {
  const hostMarker = `--owned-closer-fixture-host=${randomUUID()}`
  const targetMarker = `--owned-closer-fixture-target=${randomUUID()}`
  const host = spawn(process.execPath, ['-e', HOST_SCRIPT, '--', productMarker, hostMarker], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, OWNED_CLOSER_FIXTURE_TARGET: targetMarker },
  })
  const hostPid = requiredValue(host.pid, 'fixture host pid')
  const closed = once(host, 'close')
  const stdout = requiredValue(host.stdout, 'fixture stdout')
  let targetPid = 0
  // Registered before anything can fail, so cleanup always sees it; cleanup
  // finds its processes by marker, so an unknown target pid is not a gap.
  const fixture: Fixture = {
    hostPid,
    get targetPid() { return targetPid },
    hostMarker,
    targetMarker,
    closed,
    host,
  }
  scene.fixtures.push(fixture)
  targetPid = await withinBound(new Promise<number>((resolve, reject) => {
    let buffered = ''
    stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const match = /ready (\d+)\n/u.exec(buffered)
      if (match?.[1]) resolve(Number(match[1]))
    })
    host.once('exit', () => reject(new Error('fixture host exited before its target started')))
  }), CLOSED_BOUND_MS, `fixture host ${hostPid} to start its target`)
  stdout.resume()
  return fixture
}

/** Whether the fixture's target still runs, found by its own marker. */
function targetRuns(fixture: Fixture): boolean {
  return processesCarrying(fixture.targetMarker).some((row) => row.pid === fixture.targetPid)
}

/** Whether the fixture's host still runs, found by its own marker. */
function hostRuns(fixture: Fixture): boolean {
  return processesCarrying(fixture.hostMarker).some((row) => row.pid === fixture.hostPid)
}

function writeIntent(scene: Scene, id: string, parent: string | null): void {
  fs.writeFileSync(path.join(ownedProcessScopeFolders(scene.scopePath).intents, `${id}.json`), JSON.stringify({
    version: 1,
    ownedProcessId: id,
    parentOwnedProcessId: parent,
    kind: 'team',
    childRunId: `child-${id}`,
    spawnerRunId: 'run',
    spawnerAssignmentId: 'assignment',
    createdAt: new Date().toISOString(),
  }))
}

function writeHostClaim(scene: Scene, id: string, hostPid: number): void {
  fs.writeFileSync(path.join(ownedProcessScopeFolders(scene.scopePath).claims, `${id}.json`), JSON.stringify({
    version: 1,
    ownedProcessId: id,
    claimant: 'host',
    pid: hostPid,
    processGroupId: hostPid,
    claimedAt: new Date().toISOString(),
  }))
}

/** A member whose host runs and carries its marker. */
async function verifiedMember(scene: Scene, id: string, parent: string | null): Promise<Fixture> {
  writeIntent(scene, id, parent)
  const fixture = await startFixture(scene, `${OWNED_PROCESS_ARGUMENT}${id}`)
  writeHostClaim(scene, id, fixture.hostPid)
  return fixture
}

interface SignalLogger {
  readonly pid: number
  readonly marker: string
  readonly logPath: string
}

const SIGNAL_LOGGER_SCRIPT = [
  "const fs = require('node:fs')",
  "for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, () => fs.appendFileSync(process.env.OWNED_CLOSER_SIGNAL_LOG, name + '\\n'))",
  "process.stdout.write('ready\\n')",
  'setInterval(() => {}, 1 << 30)',
].join('\n')

/**
 * A process leading its own group that carries `argument` and a fixture marker
 * of its own, and logs every catchable signal it is sent, so SIGTERM does not
 * end it and any signal the closer sends shows. SIGKILL shows as its absence.
 */
async function startSignalLogger(scene: Scene, argument: string): Promise<SignalLogger> {
  const marker = `--owned-closer-fixture-logger=${randomUUID()}`
  const logPath = path.join(scene.root, `signals-${randomUUID()}.log`)
  const child = spawn(process.execPath, ['-e', SIGNAL_LOGGER_SCRIPT, '--', argument, marker], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, OWNED_CLOSER_SIGNAL_LOG: logPath },
  })
  // Registered before anything can fail, so cleanup always sees it.
  scene.markers.push(marker)
  const pid = requiredValue(child.pid, 'signal logger pid')
  const stdout = requiredValue(child.stdout, 'signal logger stdout')
  await withinBound(new Promise<void>((resolve, reject) => {
    stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('ready\n')) resolve()
    })
    child.once('exit', () => reject(new Error('signal logger exited before it was ready')))
  }), CLOSED_BOUND_MS, `signal logger ${pid} to be ready`)
  return { pid, marker, logPath }
}

/** What a signal logger has logged, and whether it still runs. */
function loggerState(logger: SignalLogger): { readonly signals: string; readonly runs: boolean } {
  return {
    signals: fs.existsSync(logger.logPath) ? fs.readFileSync(logger.logPath, 'utf8') : '',
    runs: processesCarrying(logger.marker).some((row) => row.pid === logger.pid),
  }
}

function claimOf(scene: Scene, id: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(ownedProcessScopeFolders(scene.scopePath).claims, `${id}.json`), 'utf8'))
}

async function withPsOnPath<T>(script: string, read: () => Promise<T>): Promise<T> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-closer-ps-'))
  fs.writeFileSync(path.join(folder, 'ps'), script, { mode: 0o755 })
  const previous = process.env.PATH
  process.env.PATH = `${folder}${path.delimiter}${previous ?? ''}`
  try {
    return await read()
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
    fs.rmSync(folder, { recursive: true, force: true })
  }
}

test('closing a scope claims an unclaimed intent, stops a verified host\'s group, and records the scope closed', async () => {
  await withScene(async (scene) => {
    const unclaimed = randomUUID()
    writeIntent(scene, unclaimed, null)
    const liveId = randomUUID()
    const live = await verifiedMember(scene, liveId, null)

    const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')

    assert.deepEqual(result, { kind: 'closed' })
    const claim = claimOf(scene, unclaimed)
    assert.ok(typeof claim === 'object' && claim !== null)
    assert.equal(Reflect.get(claim, 'claimant'), 'closer')
    await withinBound(live.closed, CLOSED_BOUND_MS, 'the verified host to close')
    assert.equal(targetRuns(live), false, 'the verified host\'s target is gone')
    assert.equal(fs.existsSync(path.join(ownedProcessScopeFolders(scene.scopePath).fences, 'attempt.json')), true)
    assert.deepEqual(await readScopeClosure(scene.scopePath), { kind: 'closed' })
  })
})

test('a host that exited, with its group gone, resolves without any signal', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    writeIntent(scene, id, null)
    const gone = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' })
    const gonePid = requiredValue(gone.pid, 'exited pid')
    await once(gone, 'exit')
    writeHostClaim(scene, id, gonePid)
    assert.deepEqual(await closeOwnedProcessScope(scene.scopePath, 'recovery'), { kind: 'closed' })
  })
})

test('a host that died alone while its group lives holds the scope and is never signalled', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    const member = await verifiedMember(scene, id, null)
    const hostExited = once(member.host, 'exit')
    // Our own unreaped child, so its pid cannot have been reused.
    member.host.kill('SIGKILL')
    await withinBound(hostExited, CLOSED_BOUND_MS, 'the host to exit')

    const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')

    assert.equal(result.kind, 'held')
    assert.deepEqual(result.kind === 'held' ? result.unverifiable.map((entry) => entry.ownedProcessId) : [], [id])
    assert.equal(targetRuns(member), true, 'the target of a host that died alone is not signalled')
    assert.deepEqual(await readScopeClosure(scene.scopePath), { kind: 'open' })
  })
})

test('an unreadable claim holds the scope and signals nothing', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    const member = await verifiedMember(scene, id, null)
    fs.writeFileSync(path.join(ownedProcessScopeFolders(scene.scopePath).claims, `${id}.json`), '')

    const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')

    assert.equal(result.kind, 'held')
    assert.equal(hostRuns(member), true, 'the host behind an unreadable claim is not signalled')
    assert.equal(targetRuns(member), true)
  })
})

test('a failed process probe holds the scope and signals nothing', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    const member = await verifiedMember(scene, id, null)

    const result = await withPsOnPath(
      '#!/bin/sh\necho "ps: listing refused" >&2\nexit 1\n',
      () => closeOwnedProcessScope(scene.scopePath, 'recovery'),
    )

    assert.equal(result.kind, 'held')
    assert.equal(hostRuns(member), true, 'nothing is signalled when the process table cannot be read')
  })
})

test('a claim naming a live process that does not carry the marker holds the scope and signals nothing', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    writeIntent(scene, id, null)
    // A reused pid: the claim names a live process of someone else.
    const unrelated = await startFixture(scene, `--unrelated=${randomUUID()}`)
    writeHostClaim(scene, id, unrelated.hostPid)

    const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')

    assert.equal(result.kind, 'held')
    assert.equal(hostRuns(unrelated), true, 'an unrelated process at a claimed pid is not signalled')
  })
})

test('closing a subtree stops its root and every descendant by lineage, fences it, and leaves a sibling running', async () => {
  await withScene(async (scene) => {
    const cancelledId = randomUUID()
    const nestedId = randomUUID()
    const siblingId = randomUUID()
    const cancelled = await verifiedMember(scene, cancelledId, null)
    const nested = await verifiedMember(scene, nestedId, cancelledId)
    const sibling = await verifiedMember(scene, siblingId, null)
    const lateId = randomUUID()
    writeIntent(scene, lateId, nestedId)

    const result = await closeOwnedProcessSubtree(scene.scopePath, cancelledId, 'cancellation')

    assert.deepEqual(result, { kind: 'closed' })
    await withinBound(Promise.all([cancelled.closed, nested.closed]), CLOSED_BOUND_MS, 'the cancelled subtree to close')
    assert.equal(targetRuns(nested), false, 'the nested Team is stopped')
    const late = claimOf(scene, lateId)
    assert.ok(typeof late === 'object' && late !== null)
    assert.equal(Reflect.get(late, 'claimant'), 'closer', 'a descendant that never started is claimed so it never can')
    assert.equal(fs.existsSync(path.join(ownedProcessScopeFolders(scene.scopePath).fences, `subtree-${cancelledId}.json`)), true)
    assert.equal(targetRuns(sibling), true, 'the sibling of the cancelled child keeps running')
    assert.equal(fs.existsSync(path.join(ownedProcessScopeFolders(scene.scopePath).claims, `${siblingId}.json`)), true)
    assert.equal(Reflect.get(Object(claimOf(scene, siblingId)), 'claimant'), 'host', 'the sibling\'s claim is untouched')
    assert.deepEqual(await readScopeClosure(scene.scopePath), { kind: 'open' }, 'closing a subtree does not close the scope')
  })
})

test('a subtree member whose lineage cannot be walked holds the subtree and is not signalled', async () => {
  await withScene(async (scene) => {
    const cancelledId = randomUUID()
    await verifiedMember(scene, cancelledId, null)
    const strayId = randomUUID()
    const stray = await verifiedMember(scene, strayId, randomUUID())

    const result = await closeOwnedProcessSubtree(scene.scopePath, cancelledId, 'cancellation')

    assert.equal(result.kind, 'held')
    assert.equal(targetRuns(stray), true, 'a process whose lineage is unknown is not signalled')
  })
})

// A name another writer already published is proof only once it reads back
// valid. An empty or malformed record left at that name must never let the
// closer report closed or resolved.
for (const [label, contents] of [['empty', ''], ['malformed', '{"version":1,"closedBy"']] as const) {
  test(`a pre-existing ${label} closed.json never lets the closer report the scope closed`, async () => {
    await withScene(async (scene) => {
      writeIntent(scene, randomUUID(), null)
      fs.writeFileSync(path.join(scene.scopePath, 'closed.json'), contents)

      const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')

      assert.equal(result.kind, 'held', `a ${label} closed.json was accepted as the scope's closure`)
      assert.notEqual((await readScopeClosure(scene.scopePath)).kind, 'closed')
    })
  })
}

test('a pre-existing unreadable attempt fence holds the scope', async () => {
  await withScene(async (scene) => {
    writeIntent(scene, randomUUID(), null)
    fs.writeFileSync(path.join(ownedProcessScopeFolders(scene.scopePath).fences, 'attempt.json'), '')

    const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')

    assert.equal(result.kind, 'held')
    assert.notEqual((await readScopeClosure(scene.scopePath)).kind, 'closed')
  })
})

test('a pre-existing unreadable subtree fence holds the subtree', async () => {
  await withScene(async (scene) => {
    const rootId = randomUUID()
    writeIntent(scene, rootId, null)
    fs.writeFileSync(path.join(ownedProcessScopeFolders(scene.scopePath).fences, `subtree-${rootId}.json`), '')

    const result = await closeOwnedProcessSubtree(scene.scopePath, rootId, 'cancellation')

    assert.equal(result.kind, 'held')
  })
})

// A host is verified only when exactly one process carries its intent's
// marker, and that process is the claimed pid leading the claimed group.
// Anything else is unverifiable, and nothing is signalled.

test('a marker two processes carry holds the intent and signals neither, although the claim names one of them', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    writeIntent(scene, id, null)
    const productMarker = `${OWNED_PROCESS_ARGUMENT}${id}`
    const claimed = await startSignalLogger(scene, productMarker)
    const other = await startSignalLogger(scene, productMarker)
    writeHostClaim(scene, id, claimed.pid)

    const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')

    assert.deepEqual(
      {
        kind: result.kind,
        reasons: result.kind === 'held' ? result.unverifiable.map((member) => [member.ownedProcessId, member.reason.includes('is carried by')]) : [],
        claimed: loggerState(claimed),
        other: loggerState(other),
        closure: (await readScopeClosure(scene.scopePath)).kind,
      },
      {
        kind: 'held',
        reasons: [[id, true]],
        claimed: { signals: '', runs: true },
        other: { signals: '', runs: true },
        closure: 'open',
      },
    )
  })
})

test('a claim naming a live group leader while another process carries the marker holds the intent and signals neither', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    writeIntent(scene, id, null)
    // The claimed pid leads a live group of someone else's, as after pid reuse.
    const unrelated = await startSignalLogger(scene, `--unrelated=${randomUUID()}`)
    const carrier = await startSignalLogger(scene, `${OWNED_PROCESS_ARGUMENT}${id}`)
    writeHostClaim(scene, id, unrelated.pid)

    const result = await closeOwnedProcessScope(scene.scopePath, 'recovery')

    assert.deepEqual(
      {
        kind: result.kind,
        heldIds: result.kind === 'held' ? result.unverifiable.map((member) => member.ownedProcessId) : [],
        unrelated: loggerState(unrelated),
        carrier: loggerState(carrier),
      },
      {
        kind: 'held',
        heldIds: [id],
        unrelated: { signals: '', runs: true },
        carrier: { signals: '', runs: true },
      },
    )
  })
})

// ADR verification item 9: a lineage that cannot be walked, because a parent
// intent is invalid or the chain repeats, makes the closer report held without
// hanging, and the member is not signalled.
for (const lineage of ['invalid parent intent', 'cycle'] as const) {
  test(`a subtree member whose lineage has an ${lineage === 'cycle' ? 'ancestor cycle' : lineage} holds the subtree, without hanging, and is not signalled`, async () => {
    await withScene(async (scene) => {
      const cancelledId = randomUUID()
      await verifiedMember(scene, cancelledId, null)
      const strayId = randomUUID()
      const parentId = randomUUID()
      const stray = await verifiedMember(scene, strayId, parentId)
      if (lineage === 'cycle') {
        writeIntent(scene, parentId, strayId)
      } else {
        fs.writeFileSync(path.join(ownedProcessScopeFolders(scene.scopePath).intents, `${parentId}.json`), '{"version":1,"ownedProcessId"')
      }

      const result = await withinBound(
        closeOwnedProcessSubtree(scene.scopePath, cancelledId, 'cancellation'),
        CLOSED_BOUND_MS,
        'the subtree close to finish',
      )

      assert.equal(result.kind, 'held')
      assert.deepEqual(
        result.kind === 'held' ? result.unverifiable.map((member) => member.ownedProcessId).includes(strayId) : false,
        true,
        'the member whose lineage cannot be walked is reported',
      )
      assert.equal(targetRuns(stray), true, 'a process whose lineage is unknown is not signalled')
    })
  })
}
