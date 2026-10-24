import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { requiredValue } from '../../core/required-value.js'
import { stopAllCarrying, withinBound } from '../support/fixture-process-markers.js'
import {
  commandCarriesArgument,
  probeProcessGroup,
  readProcessTableStrict,
  type ProcessGroupState,
  type ProcessRow,
} from '../../core/owned-processes/owned-process-probe.js'

// Requirements (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
// section 5): the closer reads process state with its own strict probe. A `ps`
// that fails, or prints a line that does not parse, is a probe failure and
// never an empty table. A group is gone only when kill(-pgid, 0) says ESRCH. A
// marker matches only as a whole argument.

async function withPsOnPath<T>(script: string, read: () => Promise<T>): Promise<T> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-ps-'))
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

test('the process table lists this process in its own group', async () => {
  const table = await readProcessTableStrict()
  assert.equal(table.kind, 'table')
  const own = table.kind === 'table' ? table.rows.find((row) => row.pid === process.pid) : undefined
  assert.ok(own, 'this test process is listed')
  assert.ok(own.processGroupId > 0)
  assert.ok(own.command.length > 0)
})

// The strict read refuses a table for three reasons: `ps` exited non-zero, a
// line does not parse, or the table does not list the process reading it.
// Each fixture below breaks one of them and keeps the other two, and each
// test names the reason, so a check that stopped working fails its own test.
const OWN_ROW = `  ${process.pid}  ${process.pid} S    node owned-process-probe.test.js`
const OTHER_ROW = '  12  12 S    node a.js'

test('a ps that exits non-zero is a probe failure, even when what it printed parses and lists this process', async () => {
  const table = await withPsOnPath(
    `#!/bin/sh\necho "${OTHER_ROW}"\necho "${OWN_ROW}"\necho "ps: listing incomplete" >&2\nexit 1\n`,
    () => readProcessTableStrict(),
  )
  assert.ok(table.kind === 'failure', `expected a failure, got ${JSON.stringify(table)}`)
  assert.match(table.reason, /^ps could not list processes: /u)
})

test('a ps line that does not parse is a probe failure, even when ps succeeds and lists this process', async () => {
  const table = await withPsOnPath(
    `#!/bin/sh\necho "${OTHER_ROW}"\necho "${OWN_ROW}"\necho "garbled"\n`,
    () => readProcessTableStrict(),
  )
  assert.deepEqual(table, { kind: 'failure', reason: 'ps printed a line that does not parse: "garbled"' })
})

test('a table that does not list the process reading it is a probe failure, even when ps succeeds and every line parses', async () => {
  const table = await withPsOnPath(
    `#!/bin/sh\necho "${OTHER_ROW}"\n`,
    () => readProcessTableStrict(),
  )
  assert.deepEqual(table, { kind: 'failure', reason: 'ps did not list the process reading it' })
})

interface MarkedFixture {
  readonly process: ChildProcess
  readonly groupId: number
  readonly exited: Promise<unknown>
}

const FIXTURE_BOUND_MS = 5_000

/**
 * Runs `fn` with a detached fixture leading its own group and carrying its
 * own marker. Cleanup finds it by that marker, rechecks it immediately before
 * the signal, bounds every wait, and reports its errors beside the body's.
 */
async function withMarkedFixture(fn: (fixture: MarkedFixture) => Promise<void>): Promise<void> {
  const marker = `--owned-probe-fixture=${randomUUID()}`
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', marker], {
    detached: true,
    stdio: 'ignore',
  })
  const exited = once(child, 'exit')
  let bodyFailure: { readonly error: unknown } | undefined
  try {
    await withinBound(once(child, 'spawn'), FIXTURE_BOUND_MS, 'the probe fixture to spawn')
    await fn({ process: child, groupId: requiredValue(child.pid, 'fixture pid'), exited })
  } catch (error) {
    bodyFailure = { error }
  }
  const cleanupErrors = await stopAllCarrying([marker])
  if (cleanupErrors.length === 0) {
    try {
      await withinBound(exited, FIXTURE_BOUND_MS, 'the probe fixture to exit')
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (bodyFailure && cleanupErrors.length > 0) {
    throw new AggregateError([bodyFailure.error, ...cleanupErrors], 'the probe test and its fixture cleanup failed')
  }
  if (bodyFailure) throw bodyFailure.error
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'the probe fixture cleanup failed')
}

test('a live detached group is alive, and gone once its leader has exited and been reaped', async () => {
  await withMarkedFixture(async (fixture) => {
    assert.deepEqual(probeProcessGroup(fixture.groupId), { kind: 'alive' })
    // Our own unreaped child, so its pid and group cannot have been reused.
    fixture.process.kill('SIGKILL')
    await withinBound(fixture.exited, FIXTURE_BOUND_MS, 'the fixture to exit')
    assert.deepEqual(probeProcessGroup(fixture.groupId), { kind: 'gone' })
  })
})

test('a group that started after a process table was read is alive, whatever that stale table says', async () => {
  const stale = await readProcessTableStrict()
  assert.equal(stale.kind, 'table')
  await withMarkedFixture(async (fixture) => {
    // Called through the widest signature a caller may use, so a table passed
    // in can never be what turns a live group into a gone one.
    const probe: (processGroupId: number, rows?: readonly ProcessRow[]) => ProcessGroupState = probeProcessGroup
    assert.deepEqual(
      probe(fixture.groupId, stale.kind === 'table' ? stale.rows : []),
      { kind: 'alive' },
      'kill(-pgid, 0) succeeded, so the group is alive; a table read before it existed cannot say otherwise',
    )
  })
})

test('a marker matches only as a whole argument', () => {
  const marker = '--runtime-owned-process=abc'
  assert.equal(commandCarriesArgument(`node host.js ${marker} -- node pi`, marker), true)
  assert.equal(commandCarriesArgument(`node host.js ${marker}`, marker), true)
  assert.equal(commandCarriesArgument(`node host.js ${marker}d -- node pi`, marker), false)
  assert.equal(commandCarriesArgument(`node host.js x${marker} -- node pi`, marker), false)
  assert.equal(commandCarriesArgument('node host.js -- node pi', marker), false)
})
