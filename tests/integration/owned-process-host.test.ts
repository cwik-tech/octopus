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
  claimRecordSchema,
  OWNED_PROCESS_SCOPE_ENV,
  ownedProcessScopeFolders,
  readScopeRecord,
} from '../../core/owned-processes/owned-process-records.js'
import { OWNED_PROCESS_HOST_NOT_STARTED } from '../../core/owned-processes/owned-process-host.js'
import { ownedProcessHostInvocation } from '../../core/owned-processes/owned-process-spawn.js'
import {
  describeErrors,
  stopProcessesCarrying,
  withinBound,
} from '../support/fixture-process-markers.js'

// Requirements (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// section 4, verification items 8, 9 and 12): a host claims its intent with
// its own pid and group before anything else, starts its target only after
// the claim and the fence check, gives the target its owned process id, and
// passes output, exit code and signal through; SIGTERM to its group ends the
// target and then the host, and the spawner sees `close` only after the target
// exits. A host whose intent is already claimed, that is fenced, or whose
// lineage cannot be walked never starts its target.

const BOUND_MS = 15_000

interface Scene {
  readonly root: string
  readonly scopePath: string
  /** Carried as a whole argument by every host and target this test starts. */
  readonly marker: string
  readonly startedPath: string
}

async function withScene(fn: (scene: Scene) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-host-'))
  const scene: Scene = {
    root,
    scopePath: path.join(root, 'attempt-1'),
    marker: `--owned-host-fixture=${randomUUID()}`,
    startedPath: path.join(root, 'target-started'),
  }
  for (const folder of Object.values(ownedProcessScopeFolders(scene.scopePath))) fs.mkdirSync(folder, { recursive: true })
  const failures: unknown[] = []
  try {
    await fn(scene)
  } catch (error) {
    failures.push(error)
  }
  try {
    await stopProcessesCarrying(scene.marker)
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 0) fs.rmSync(root, { recursive: true, force: true })
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `host test and its cleanup failed; ${root} is kept: ${describeErrors(failures)}`)
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

/** A target script that records that it started, then runs `body`. */
function targetScript(scene: Scene, body: string): string[] {
  return [
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(scene.startedPath)}, String(process.pid)); ${body}`,
    '--',
    scene.marker,
  ]
}

interface HostRun {
  readonly child: ChildProcess
  readonly output: () => string
  readonly closed: Promise<readonly [number | null, string | null]>
}

/** Starts a host the way a spawner does: detached, stdout piped. */
function startHost(scene: Scene, ownedProcessId: string, target: { command: string; args: readonly string[] }): HostRun {
  const invocation = ownedProcessHostInvocation({ ownedProcessId, command: target.command, args: target.args })
  const child = spawn(invocation.command, [...invocation.args], {
    cwd: scene.root,
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, [OWNED_PROCESS_SCOPE_ENV]: scene.scopePath },
  })
  let output = ''
  requiredValue(child.stdout, 'host stdout').on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  const closed = withinBound(
    once(child, 'close').then(([code, signal]: unknown[]): readonly [number | null, string | null] => [
      typeof code === 'number' ? code : null,
      typeof signal === 'string' ? signal : null,
    ]),
    BOUND_MS,
    'the host to close',
  )
  return { child, output: () => output, closed }
}

/**
 * The target's very first action: its host's claim must already be published,
 * whole, naming the host (the target's parent) as its pid and group. If not,
 * it fails loudly with 42 before any other effect.
 */
const CLAIM_BEFORE_START_CHECK = [
  "const fs = require('node:fs'), path = require('node:path')",
  'let claim',
  'try {',
  "  const claimPath = path.join(process.env.TEAM_RUNTIME_OWNED_PROCESS_SCOPE, 'claims', process.env.TEAM_RUNTIME_OWNED_PROCESS_ID + '.json')",
  "  claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'))",
  '} catch (error) {',
  "  process.stderr.write('claim was not published before the target started: ' + error.message + '\\n'); process.exit(42)",
  '}',
  "if (claim.claimant !== 'host' || claim.ownedProcessId !== process.env.TEAM_RUNTIME_OWNED_PROCESS_ID || claim.pid !== process.ppid || claim.processGroupId !== process.ppid) {",
  "  process.stderr.write('the claim at start does not name this target\\'s host\\n'); process.exit(42)",
  '}',
].join('\n')

test('a host claims its intent with its own pid and group before its target starts, then runs its target with its owned process id, passing output and exit code through', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    writeIntent(scene, id, null)
    const host = startHost(scene, id, {
      command: process.execPath,
      args: [
        '-e',
        `${CLAIM_BEFORE_START_CHECK}\nprocess.stdout.write('owned:' + process.env.TEAM_RUNTIME_OWNED_PROCESS_ID); process.exit(7)`,
        '--',
        scene.marker,
      ],
    })

    assert.deepEqual(await host.closed, [7, null], 'exit 42 means the claim was not published before the target started')
    assert.equal(host.output(), `owned:${id}`)
    const hostPid = requiredValue(host.child.pid, 'host pid')
    const claim = await readScopeRecord({
      target: path.join(ownedProcessScopeFolders(scene.scopePath).claims, `${id}.json`),
      schema: claimRecordSchema,
      expectedOwnedProcessId: id,
    })
    assert.equal(claim.kind, 'present')
    assert.deepEqual(
      claim.kind === 'present' && claim.record.claimant === 'host'
        ? { pid: claim.record.pid, processGroupId: claim.record.processGroupId }
        : undefined,
      { pid: hostPid, processGroupId: hostPid },
    )
  })
})

test('a host whose intent a closer already claimed never starts its target', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    writeIntent(scene, id, null)
    fs.writeFileSync(path.join(ownedProcessScopeFolders(scene.scopePath).claims, `${id}.json`), JSON.stringify({
      version: 1, ownedProcessId: id, claimant: 'closer', closedBy: 'recovery', claimedAt: 'then',
    }))
    const host = startHost(scene, id, { command: process.execPath, args: targetScript(scene, '') })

    const [code] = await host.closed
    assert.notEqual(code, 0)
    assert.equal(fs.existsSync(scene.startedPath), false, 'the target started although its intent was closed')
  })
})

for (const fence of ['attempt', 'subtree of itself', 'subtree of its parent'] as const) {
  test(`a host under the ${fence} fence claims its intent but never starts its target`, async () => {
    await withScene(async (scene) => {
      const parent = randomUUID()
      const id = randomUUID()
      writeIntent(scene, parent, null)
      writeIntent(scene, id, parent)
      const fencePath = path.join(
        ownedProcessScopeFolders(scene.scopePath).fences,
        fence === 'attempt' ? 'attempt.json' : `subtree-${fence === 'subtree of itself' ? id : parent}.json`,
      )
      fs.writeFileSync(fencePath, JSON.stringify({ version: 1, closedBy: 'recovery', createdAt: 'then' }))
      const host = startHost(scene, id, { command: process.execPath, args: targetScript(scene, '') })

      const [code] = await host.closed
      assert.notEqual(code, 0)
      assert.equal(fs.existsSync(scene.startedPath), false, `the target started under the ${fence} fence`)
      assert.equal(
        fs.existsSync(path.join(ownedProcessScopeFolders(scene.scopePath).claims, `${id}.json`)),
        true,
        'the host claimed before it checked the fence',
      )
    })
  })
}

test('a host whose lineage cannot be walked never starts its target', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    writeIntent(scene, id, randomUUID())
    const host = startHost(scene, id, { command: process.execPath, args: targetScript(scene, '') })

    const [code] = await host.closed
    assert.notEqual(code, 0)
    assert.equal(fs.existsSync(scene.startedPath), false)
  })
})

// ADR verification item 9: an invalid parent intent, or a chain that repeats,
// makes the host exit without starting its target, and without hanging (the
// close is awaited within a bound).
for (const lineage of ['invalid parent intent', 'cycle'] as const) {
  test(`a host whose lineage has an ${lineage === 'cycle' ? 'ancestor cycle' : lineage} exits without starting its target`, async () => {
    await withScene(async (scene) => {
      const id = randomUUID()
      const parentId = randomUUID()
      writeIntent(scene, id, parentId)
      if (lineage === 'cycle') {
        writeIntent(scene, parentId, id)
      } else {
        fs.writeFileSync(path.join(ownedProcessScopeFolders(scene.scopePath).intents, `${parentId}.json`), '{"version":1,"ownedProcessId"')
      }
      const host = startHost(scene, id, { command: process.execPath, args: targetScript(scene, '') })

      assert.deepEqual(await host.closed, [OWNED_PROCESS_HOST_NOT_STARTED, null])
      assert.equal(fs.existsSync(scene.startedPath), false, `the target started although its lineage has an ${lineage}`)
    })
  })
}

test('SIGTERM to the host\'s group ends the target, then the host, and the spawner sees close only after the target\'s last output', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    writeIntent(scene, id, null)
    const host = startHost(scene, id, {
      command: process.execPath,
      args: targetScript(scene, [
        "process.on('SIGTERM', () => setImmediate(() => { process.stdout.write('target finished after SIGTERM'); process.exit(0) }))",
        "process.stdout.write('ready;')",
        'setInterval(() => {}, 1 << 30)',
      ].join('; ')),
    })
    const hostPid = requiredValue(host.child.pid, 'host pid')
    await withinBound(new Promise<void>((resolve) => {
      const check = (): void => { if (host.output().includes('ready;')) resolve() }
      requiredValue(host.child.stdout, 'host stdout').on('data', check)
      check()
    }), BOUND_MS, 'the target to be ready')

    // Our own unreaped child leads this group, so the group cannot be someone else's.
    process.kill(-hostPid, 'SIGTERM')

    assert.deepEqual(await host.closed, [0, null], 'the host outlived SIGTERM and exited with its target\'s code')
    assert.equal(host.output(), 'ready;target finished after SIGTERM')
  })
})

test('a target ended by a signal ends its host by the same signal', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    writeIntent(scene, id, null)
    const host = startHost(scene, id, {
      command: process.execPath,
      args: targetScript(scene, "process.kill(process.pid, 'SIGINT'); setInterval(() => {}, 1 << 30)"),
    })

    assert.deepEqual(await host.closed, [null, 'SIGINT'])
  })
})

test('a target that cannot be started exits its host with 127', async () => {
  await withScene(async (scene) => {
    const id = randomUUID()
    writeIntent(scene, id, null)
    const host = startHost(scene, id, {
      command: path.join(scene.root, 'no-such-program'),
      args: [scene.marker],
    })

    assert.deepEqual(await host.closed, [127, null])
  })
})
