import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { DEFAULT_MAX_SPAWN_DEPTH } from '../../core/constants.js'
import { withFileMutationLock } from '../../core/file-mutation.js'
import {
  RUN_ASSIGNMENT_AUTHORITY_GRANT_VERSION,
  RunAssignmentAuthorityStoreError,
  readRunAssignmentAuthorityGrant,
  removeRunAssignmentAuthorityGrant,
  resolveRunAssignmentAuthorityChain,
  writeRunAssignmentAuthorityGrant,
  type RunAssignmentAuthorityGrant,
  type RunAssignmentAuthorityStoreErrorCode,
} from '../../domains/run/run-assignment-authority-store.js'

function makeWorkspace(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'run-assignment-authority-')),
  )
}

function makeGrant(
  overrides: Partial<RunAssignmentAuthorityGrant> = {},
): RunAssignmentAuthorityGrant {
  return {
    version: RUN_ASSIGNMENT_AUTHORITY_GRANT_VERSION,
    sessionId: 'session-1',
    runId: 'run-1',
    taskId: 'task-1',
    assignmentId: 'root-assignment',
    parentAssignmentId: null,
    depth: 0,
    ...overrides,
  }
}

function hasStoreError(
  code: RunAssignmentAuthorityStoreErrorCode,
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof RunAssignmentAuthorityStoreError && error.code === code
}

test('writes private grants idempotently beside existing run locators and resolves root-to-leaf lineage', async () => {
  const workspacePath = makeWorkspace()
  try {
    const indexRoot = path.join(workspacePath, 'run-index')
    fs.mkdirSync(indexRoot)
    fs.writeFileSync(path.join(indexRoot, 'existing-locator.json'), '{}\n')
    const root = makeGrant()
    const child = makeGrant({
      assignmentId: 'child-assignment',
      parentAssignmentId: root.assignmentId,
      depth: 1,
    })

    await Promise.all([
      writeRunAssignmentAuthorityGrant(workspacePath, root),
      writeRunAssignmentAuthorityGrant(workspacePath, root),
    ])
    await Promise.all([
      writeRunAssignmentAuthorityGrant(workspacePath, child),
      writeRunAssignmentAuthorityGrant(workspacePath, child),
    ])

    const authorityRoot = path.join(indexRoot, 'authority')
    assert.deepEqual(
      fs.readdirSync(indexRoot).sort(),
      ['authority', 'existing-locator.json'],
    )
    assert.deepEqual(
      fs.readdirSync(authorityRoot).sort(),
      ['child-assignment.json', 'root-assignment.json'],
    )
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(authorityRoot, 'child-assignment.json'), 'utf8'),
      ),
      child,
    )
    assert.deepEqual(
      await readRunAssignmentAuthorityGrant(
        workspacePath,
        child.assignmentId,
      ),
      child,
    )
    assert.deepEqual(
      await resolveRunAssignmentAuthorityChain(
        workspacePath,
        child.assignmentId,
      ),
      [root, child],
    )
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(authorityRoot).mode & 0o777, 0o700)
      assert.equal(
        fs.statSync(path.join(authorityRoot, 'child-assignment.json')).mode &
          0o777,
        0o600,
      )
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('concurrent conflicting parents never overwrite the first published grant', async () => {
  const workspacePath = makeWorkspace()
  try {
    const firstParent = makeGrant({ assignmentId: 'parent-a' })
    const secondParent = makeGrant({ assignmentId: 'parent-b' })
    await writeRunAssignmentAuthorityGrant(workspacePath, firstParent)
    await writeRunAssignmentAuthorityGrant(workspacePath, secondParent)
    const firstCandidate = makeGrant({
      assignmentId: 'contested-child',
      parentAssignmentId: firstParent.assignmentId,
      depth: 1,
    })
    const secondCandidate = makeGrant({
      assignmentId: 'contested-child',
      parentAssignmentId: secondParent.assignmentId,
      depth: 1,
    })

    const outcomes = await Promise.allSettled([
      writeRunAssignmentAuthorityGrant(workspacePath, firstCandidate),
      writeRunAssignmentAuthorityGrant(workspacePath, secondCandidate),
    ])

    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    )
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'rejected').length,
      1,
    )
    const persisted = await readRunAssignmentAuthorityGrant(
      workspacePath,
      firstCandidate.assignmentId,
    )
    assert.ok(persisted)
    const winner = persisted.parentAssignmentId === firstParent.assignmentId
      ? firstCandidate
      : secondCandidate
    const loser = winner === firstCandidate ? secondCandidate : firstCandidate
    assert.deepEqual(persisted, winner)
    await writeRunAssignmentAuthorityGrant(workspacePath, winner)
    await assert.rejects(
      writeRunAssignmentAuthorityGrant(workspacePath, loser),
      hasStoreError('conflict'),
    )
    assert.deepEqual(
      await readRunAssignmentAuthorityGrant(
        workspacePath,
        firstCandidate.assignmentId,
      ),
      winner,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('rejects traversal and invalid parent-depth combinations before writing', async () => {
  const workspacePath = makeWorkspace()
  try {
    const invalidGrants = [
      makeGrant({ assignmentId: '../escape' }),
      makeGrant({ assignmentId: 'line\nbreak' }),
      makeGrant({ taskId: 'x'.repeat(513) }),
      makeGrant({ parentAssignmentId: 'unexpected-parent' }),
      makeGrant({
        assignmentId: 'missing-parent',
        parentAssignmentId: null,
        depth: 1,
      }),
      makeGrant({
        assignmentId: 'too-deep',
        parentAssignmentId: 'parent',
        depth: DEFAULT_MAX_SPAWN_DEPTH + 1,
      }),
    ]

    for (const grant of invalidGrants) {
      await assert.rejects(
        writeRunAssignmentAuthorityGrant(workspacePath, grant),
        hasStoreError('invalid-grant'),
      )
    }
    await assert.rejects(
      readRunAssignmentAuthorityGrant(workspacePath, '../escape'),
      hasStoreError('invalid-grant'),
    )
    assert.equal(fs.existsSync(path.join(workspacePath, 'run-index')), false)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('rejects noncanonical and symlinked workspace or index directories', async () => {
  const containerPath = makeWorkspace()
  const outsidePath = makeWorkspace()
  try {
    const workspacePath = path.join(containerPath, 'workspace')
    fs.mkdirSync(workspacePath)
    const aliasPath = path.join(containerPath, 'workspace-alias')
    fs.symlinkSync(workspacePath, aliasPath, 'dir')

    await assert.rejects(
      writeRunAssignmentAuthorityGrant(aliasPath, makeGrant()),
      hasStoreError('noncanonical-path'),
    )
    await assert.rejects(
      writeRunAssignmentAuthorityGrant(`${workspacePath}${path.sep}.`, makeGrant()),
      hasStoreError('noncanonical-path'),
    )

    fs.symlinkSync(outsidePath, path.join(workspacePath, 'run-index'), 'dir')
    await assert.rejects(
      writeRunAssignmentAuthorityGrant(workspacePath, makeGrant()),
      hasStoreError('noncanonical-path'),
    )
  } finally {
    fs.rmSync(containerPath, { recursive: true, force: true })
    fs.rmSync(outsidePath, { recursive: true, force: true })
  }
})

test('rejects symlinked authority directories and grant files', async () => {
  const workspacePath = makeWorkspace()
  const outsidePath = makeWorkspace()
  try {
    const indexRoot = path.join(workspacePath, 'run-index')
    fs.mkdirSync(indexRoot)
    fs.symlinkSync(outsidePath, path.join(indexRoot, 'authority'), 'dir')
    await assert.rejects(
      writeRunAssignmentAuthorityGrant(workspacePath, makeGrant()),
      hasStoreError('noncanonical-path'),
    )

    fs.unlinkSync(path.join(indexRoot, 'authority'))
    fs.mkdirSync(path.join(indexRoot, 'authority'), { mode: 0o700 })
    const outsideGrantPath = path.join(outsidePath, 'outside.json')
    fs.writeFileSync(outsideGrantPath, `${JSON.stringify(makeGrant())}\n`)
    fs.symlinkSync(
      outsideGrantPath,
      path.join(indexRoot, 'authority', 'root-assignment.json'),
      'file',
    )
    await assert.rejects(
      readRunAssignmentAuthorityGrant(workspacePath, 'root-assignment'),
      hasStoreError('noncanonical-path'),
    )
    await assert.rejects(
      writeRunAssignmentAuthorityGrant(workspacePath, makeGrant()),
      hasStoreError('noncanonical-path'),
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(outsidePath, { recursive: true, force: true })
  }
})

test('a queued grant write rechecks an authority directory swapped to a symlink', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = makeWorkspace()
  const outsidePath = makeWorkspace()
  try {
    const root = makeGrant()
    await writeRunAssignmentAuthorityGrant(workspacePath, root)
    const child = makeGrant({
      assignmentId: 'queued-child',
      parentAssignmentId: root.assignmentId,
      depth: 1,
    })
    const authorityRoot = path.join(workspacePath, 'run-index', 'authority')
    const childPath = path.join(authorityRoot, 'queued-child.json')
    let releaseBlocker: (() => void) | undefined
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })
    let markBlockerStarted: (() => void) | undefined
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve
    })
    const blocker = withFileMutationLock(childPath, async () => {
      markBlockerStarted?.()
      await blockerRelease
    })
    await blockerStarted

    const queuedWrite = writeRunAssignmentAuthorityGrant(workspacePath, child)
    const queueState = await Promise.race([
      queuedWrite.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      new Promise<'queued'>((resolve) => {
        setTimeout(() => resolve('queued'), 100)
      }),
    ])
    if (queueState !== 'queued') {
      releaseBlocker?.()
      await blocker
      assert.equal(queueState, 'queued')
    }
    fs.renameSync(authorityRoot, `${authorityRoot}-original`)
    fs.symlinkSync(outsidePath, authorityRoot, 'dir')
    releaseBlocker?.()

    await assert.rejects(
      queuedWrite,
      hasStoreError('noncanonical-path'),
    )
    await blocker
    assert.equal(fs.existsSync(path.join(outsidePath, 'queued-child.json')), false)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(outsidePath, { recursive: true, force: true })
  }
})

test('validates persisted JSON as an exact grant before returning it', async () => {
  const workspacePath = makeWorkspace()
  try {
    const authorityRoot = path.join(workspacePath, 'run-index', 'authority')
    fs.mkdirSync(authorityRoot, { recursive: true, mode: 0o700 })
    const grantPath = path.join(authorityRoot, 'root-assignment.json')
    const invalidValues: readonly unknown[] = [
      '{not-json',
      { ...makeGrant(), version: RUN_ASSIGNMENT_AUTHORITY_GRANT_VERSION + 1 },
      { ...makeGrant(), assignmentId: 'different-assignment' },
      { ...makeGrant(), depth: 0.5 },
      { ...makeGrant(), unexpected: true },
    ]

    for (const invalidValue of invalidValues) {
      fs.writeFileSync(
        grantPath,
        typeof invalidValue === 'string'
          ? invalidValue
          : `${JSON.stringify(invalidValue)}\n`,
        { mode: 0o600 },
      )
      await assert.rejects(
        readRunAssignmentAuthorityGrant(workspacePath, 'root-assignment'),
        hasStoreError('corrupt-grant'),
      )
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('fails closed when a persisted parent chain is missing or crosses task lineage', async () => {
  const workspacePath = makeWorkspace()
  try {
    const root = makeGrant()
    const child = makeGrant({
      assignmentId: 'child-assignment',
      parentAssignmentId: root.assignmentId,
      depth: 1,
    })
    await writeRunAssignmentAuthorityGrant(workspacePath, root)
    await writeRunAssignmentAuthorityGrant(workspacePath, child)
    const authorityRoot = path.join(workspacePath, 'run-index', 'authority')

    fs.unlinkSync(path.join(authorityRoot, 'root-assignment.json'))
    await assert.rejects(
      resolveRunAssignmentAuthorityChain(workspacePath, child.assignmentId),
      hasStoreError('invalid-lineage'),
    )

    fs.writeFileSync(
      path.join(authorityRoot, 'root-assignment.json'),
      `${JSON.stringify(root)}\n`,
      { mode: 0o600 },
    )
    fs.writeFileSync(
      path.join(authorityRoot, 'child-assignment.json'),
      `${JSON.stringify({ ...child, taskId: 'other-task' })}\n`,
      { mode: 0o600 },
    )
    await assert.rejects(
      resolveRunAssignmentAuthorityChain(workspacePath, child.assignmentId),
      hasStoreError('invalid-lineage'),
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('returns null when no authority grant has been published', async () => {
  const workspacePath = makeWorkspace()
  try {
    assert.equal(
      await readRunAssignmentAuthorityGrant(workspacePath, 'missing-assignment'),
      null,
    )
    assert.equal(
      await resolveRunAssignmentAuthorityChain(
        workspacePath,
        'missing-assignment',
      ),
      null,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('removes grants idempotently and deletes only an empty authority directory', async () => {
  const workspacePath = makeWorkspace()
  try {
    const indexRoot = path.join(workspacePath, 'run-index')
    fs.mkdirSync(indexRoot)
    fs.writeFileSync(path.join(indexRoot, 'existing-locator.json'), '{}\n')
    const root = makeGrant()
    const child = makeGrant({
      assignmentId: 'child-assignment',
      parentAssignmentId: root.assignmentId,
      depth: 1,
    })
    await writeRunAssignmentAuthorityGrant(workspacePath, root)
    await writeRunAssignmentAuthorityGrant(workspacePath, child)

    assert.equal(
      await removeRunAssignmentAuthorityGrant(workspacePath, child.assignmentId),
      true,
    )
    assert.equal(
      await removeRunAssignmentAuthorityGrant(workspacePath, child.assignmentId),
      false,
    )
    assert.deepEqual(
      await readRunAssignmentAuthorityGrant(workspacePath, root.assignmentId),
      root,
    )
    assert.equal(
      fs.existsSync(path.join(indexRoot, 'authority')),
      true,
    )

    assert.equal(
      await removeRunAssignmentAuthorityGrant(workspacePath, root.assignmentId),
      true,
    )
    assert.equal(fs.existsSync(path.join(indexRoot, 'authority')), false)
    assert.equal(fs.existsSync(path.join(indexRoot, 'existing-locator.json')), true)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('concurrent owned-grant cleanup converges after the last authority file is removed', async () => {
  const workspacePath = makeWorkspace()
  try {
    const root = makeGrant()
    const child = makeGrant({
      assignmentId: 'child-assignment',
      parentAssignmentId: root.assignmentId,
      depth: 1,
    })
    await writeRunAssignmentAuthorityGrant(workspacePath, root)
    await writeRunAssignmentAuthorityGrant(workspacePath, child)

    assert.deepEqual(
      await Promise.all([
        removeRunAssignmentAuthorityGrant(workspacePath, root.assignmentId),
        removeRunAssignmentAuthorityGrant(workspacePath, child.assignmentId),
      ]),
      [true, true],
    )
    assert.equal(
      fs.existsSync(path.join(workspacePath, 'run-index', 'authority')),
      false,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('refuses to remove a grant through a symlinked authority path', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = makeWorkspace()
  const outsidePath = makeWorkspace()
  try {
    const grant = makeGrant()
    await writeRunAssignmentAuthorityGrant(workspacePath, grant)
    const authorityRoot = path.join(workspacePath, 'run-index', 'authority')
    fs.renameSync(authorityRoot, `${authorityRoot}-original`)
    fs.writeFileSync(
      path.join(outsidePath, `${grant.assignmentId}.json`),
      `${JSON.stringify(grant)}\n`,
      { mode: 0o600 },
    )
    fs.symlinkSync(outsidePath, authorityRoot, 'dir')

    await assert.rejects(
      removeRunAssignmentAuthorityGrant(workspacePath, grant.assignmentId),
      hasStoreError('noncanonical-path'),
    )
    assert.equal(
      fs.existsSync(path.join(outsidePath, `${grant.assignmentId}.json`)),
      true,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(outsidePath, { recursive: true, force: true })
  }
})
