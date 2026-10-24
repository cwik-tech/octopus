import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  RUN_ASSIGNMENT_LOCATOR_VERSION,
  buildSessionRunAssignmentLocation,
  listRunAssignmentLocations,
  removeRunAssignmentLocator,
  resolveRunAssignmentLocation,
  writeRunAssignmentLocator,
  type RunAssignmentLocator,
} from '../../domains/run/run-location.js'
import { buildSessionRunAssignmentLocation as buildCoreSessionRunAssignmentLocation } from '../../core/run-assignment-location.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-location-'))
}

test('run storage re-exports the canonical session location builder', () => {
  assert.equal(
    buildSessionRunAssignmentLocation,
    buildCoreSessionRunAssignmentLocation,
  )
})

test('session assignment locators are relative, atomic, and removable', async () => {
  const workspacePath = makeWorkspace()
  try {
    const location = buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
    })
    assert.ok(location)
    fs.mkdirSync(location.assignmentPath, { recursive: true })

    await writeRunAssignmentLocator(workspacePath, location)
    const locatorPath = path.join(workspacePath, 'run-index', 'assignment-1.json')
    const locator = JSON.parse(fs.readFileSync(locatorPath, 'utf8')) as RunAssignmentLocator
    assert.deepEqual(locator, {
      version: RUN_ASSIGNMENT_LOCATOR_VERSION,
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
      relativeRunPath: 'sessions/session-1/runs/run-1',
      relativeAssignmentPath:
        'sessions/session-1/runs/run-1/assignments/assignment-1',
    })
    assert.equal(path.isAbsolute(locator.relativeAssignmentPath), false)
    assert.deepEqual(
      fs.readdirSync(path.join(workspacePath, 'run-index')).sort(),
      ['assignment-1.json'],
    )
    assert.deepEqual(resolveRunAssignmentLocation(workspacePath, 'assignment-1'), location)

    assert.equal(await removeRunAssignmentLocator(workspacePath, 'assignment-1'), true)
    assert.equal(await removeRunAssignmentLocator(workspacePath, 'assignment-1'), false)
    assert.equal(fs.existsSync(location.assignmentPath), true)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('nested indexed assignments win over duplicate legacy ids', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentId = 'duplicate-assignment'
    const legacyPath = path.join(workspacePath, 'assignments', assignmentId)
    fs.mkdirSync(legacyPath, { recursive: true })

    const nested = buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: 'session-2',
      runId: 'run-2',
      assignmentId,
    })
    assert.ok(nested)
    fs.mkdirSync(nested.assignmentPath, { recursive: true })
    await writeRunAssignmentLocator(workspacePath, nested)

    const resolved = resolveRunAssignmentLocation(workspacePath, assignmentId)
    assert.equal(resolved?.layout, 'session')
    assert.equal(resolved?.assignmentPath, nested.assignmentPath)
    assert.deepEqual(
      listRunAssignmentLocations(workspacePath).map((location) => location.assignmentId),
      [assignmentId],
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('locators reject traversal, identity mismatch, and uncontained symlinks', {
  skip: process.platform === 'win32',
}, () => {
  const workspacePath = makeWorkspace()
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), 'run-location-outside-'))
  try {
    assert.equal(
      buildSessionRunAssignmentLocation(workspacePath, {
        sessionId: '../outside',
        runId: 'run-3',
        assignmentId: 'assignment-3',
      }),
      null,
    )
    assert.equal(resolveRunAssignmentLocation(workspacePath, '../outside'), null)

    const indexRoot = path.join(workspacePath, 'run-index')
    fs.mkdirSync(indexRoot, { recursive: true })
    writeLocator(indexRoot, 'traversal', {
      sessionId: 'session-3',
      runId: 'run-3',
      assignmentId: 'traversal',
      relativeRunPath: 'sessions/session-3/runs/run-3',
      relativeAssignmentPath: '../outside',
    })
    assert.equal(resolveRunAssignmentLocation(workspacePath, 'traversal'), null)

    const symlinked = buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: 'session-3',
      runId: 'run-3',
      assignmentId: 'symlinked',
    })
    assert.ok(symlinked)
    fs.mkdirSync(path.dirname(symlinked.assignmentPath), { recursive: true })
    fs.symlinkSync(outsidePath, symlinked.assignmentPath, 'dir')
    writeLocator(indexRoot, 'symlinked', {
      sessionId: symlinked.sessionId,
      runId: symlinked.runId,
      assignmentId: symlinked.assignmentId,
      relativeRunPath: symlinked.relativeRunPath,
      relativeAssignmentPath: symlinked.relativeAssignmentPath,
    })
    assert.equal(resolveRunAssignmentLocation(workspacePath, 'symlinked'), null)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(outsidePath, { recursive: true, force: true })
  }
})

test('discovery ignores corrupt, future, stale, and identity-mismatched locators', () => {
  const workspacePath = makeWorkspace()
  try {
    const indexRoot = path.join(workspacePath, 'run-index')
    fs.mkdirSync(indexRoot, { recursive: true })

    fs.writeFileSync(path.join(indexRoot, 'corrupt.json'), '{not-json')
    writeRawLocator(indexRoot, 'future', {
      version: RUN_ASSIGNMENT_LOCATOR_VERSION + 1,
      sessionId: 'session-4',
      runId: 'run-4',
      assignmentId: 'future',
      relativeRunPath: 'sessions/session-4/runs/run-4',
      relativeAssignmentPath: 'sessions/session-4/runs/run-4/assignments/future',
    })
    writeLocator(indexRoot, 'stale', {
      sessionId: 'session-4',
      runId: 'run-4',
      assignmentId: 'stale',
      relativeRunPath: 'sessions/session-4/runs/run-4',
      relativeAssignmentPath: 'sessions/session-4/runs/run-4/assignments/stale',
    })
    writeLocator(indexRoot, 'run-mismatch', {
      sessionId: 'session-4',
      runId: 'run-claimed',
      assignmentId: 'run-mismatch',
      relativeRunPath: 'sessions/session-4/runs/run-other',
      relativeAssignmentPath:
        'sessions/session-4/runs/run-other/assignments/run-mismatch',
    })
    writeLocator(indexRoot, 'assignment-mismatch', {
      sessionId: 'session-4',
      runId: 'run-4',
      assignmentId: 'different-assignment',
      relativeRunPath: 'sessions/session-4/runs/run-4',
      relativeAssignmentPath:
        'sessions/session-4/runs/run-4/assignments/different-assignment',
    })

    for (const assignmentId of [
      'corrupt',
      'future',
      'stale',
      'run-mismatch',
      'assignment-mismatch',
    ]) {
      assert.equal(resolveRunAssignmentLocation(workspacePath, assignmentId), null)
    }
    assert.deepEqual(listRunAssignmentLocations(workspacePath), [])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

function writeLocator(
  indexRoot: string,
  assignmentId: string,
  locator: Omit<RunAssignmentLocator, 'version'>,
): void {
  fs.writeFileSync(
    path.join(indexRoot, `${assignmentId}.json`),
    JSON.stringify({ version: RUN_ASSIGNMENT_LOCATOR_VERSION, ...locator }),
  )
}

function writeRawLocator(
  indexRoot: string,
  assignmentId: string,
  locator: Record<string, unknown>,
): void {
  fs.writeFileSync(
    path.join(indexRoot, `${assignmentId}.json`),
    JSON.stringify(locator),
  )
}
