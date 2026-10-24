import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { RunPlan } from '../../contracts/run-plan.js'
import {
  RUN_ASSIGNMENT_AUTHORITY_GRANT_VERSION,
  readRunAssignmentAuthorityGrant,
  writeRunAssignmentAuthorityGrant,
  type RunAssignmentAuthorityGrant,
} from '../../domains/run/run-assignment-authority-store.js'
import {
  buildSessionRunAssignmentLocation,
  resolveRunAssignmentLocation,
  writeRunAssignmentLocator,
} from '../../domains/run/run-location.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { WorkspaceProjectContextStore } from '../../domains/projects/project-context-store.js'
import { WorkspaceProjectMembershipStore } from '../../domains/projects/project-membership-store.js'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-run-storage-'))
}

function readyPlan(workflowId = 'snapshot-workflow'): RunPlan {
  return {
    id: `plan-${crypto.randomUUID()}`,
    goal: 'Exercise immutable run storage.',
    summary: 'Ready.',
    status: 'ready',
    selectedWorkflow: {
      id: workflowId,
      rationale: 'Selected for snapshot testing.',
      confidence: 'high',
    },
    requiredInputs: [],
    actions: [{
      id: 'launch-workflow',
      type: 'launch_workflow',
      status: 'ready',
      title: 'Launch snapshot workflow',
      rationale: 'Ready.',
      workflowId,
    }],
    warnings: [],
    createdAt: new Date().toISOString(),
  }
}

function sha256(contents: Buffer | string): string {
  return crypto.createHash('sha256').update(contents).digest('hex')
}

function temporaryEntries(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) return []
  const found: string[] = []
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name)
    if (entry.name.endsWith('.tmp') || entry.name.includes('.tmp.')) {
      found.push(entryPath)
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      found.push(...temporaryEntries(entryPath))
    }
  }
  return found
}

function assertReadOnly(filePath: string): void {
  if (process.platform === 'win32') return
  assert.equal(fs.statSync(filePath).mode & 0o222, 0, `${filePath} must be read-only`)
}

type SessionDeletionMode = 'direct' | 'guarded' | 'batch'

async function deleteSessionUsing(
  store: FileSystemSessionStore,
  sessionId: string,
  mode: SessionDeletionMode,
): Promise<void> {
  if (mode === 'direct') {
    assert.equal(await store.deleteSession(sessionId), true)
    return
  }
  if (mode === 'guarded') {
    assert.deepEqual(
      await store.deleteSessionIfNoActiveTasks(sessionId),
      { deleted: true },
    )
    return
  }
  assert.deepEqual(
    await store.deleteSessionsIfNoActiveTasks([sessionId]),
    { deleted: true, deletedSessionIds: [sessionId] },
  )
}

interface AuthorityFixture {
  readonly sessionId: string
  readonly rootGrant: RunAssignmentAuthorityGrant
  readonly childGrant: RunAssignmentAuthorityGrant
}

async function createAuthorityFixture(
  workspacePath: string,
  store: FileSystemSessionStore,
  title: string,
): Promise<AuthorityFixture> {
  const session = await store.createSession({ title })
  const task = await store.createTaskRecord(session.id, {
    workflowId: 'authority-cleanup-workflow',
    brief: 'Exercise assignment authority cleanup.',
    workflowYaml: 'workflow:\n  id: authority-cleanup-workflow\n',
  })
  assert.ok(task?.runPath)
  assert.ok(task.assignmentPath)
  assert.ok(task.assignmentId)
  const rootAssignmentId = task.assignmentId
  const completed = await store.updateTaskRecord(session.id, task.id, {
    status: 'done',
  })
  assert.equal(completed?.status, 'done')

  const childAssignmentId = `${rootAssignmentId}-child`
  const childLocation = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: session.id,
    runId: task.runId,
    assignmentId: childAssignmentId,
  })
  assert.ok(childLocation)
  fs.mkdirSync(childLocation.assignmentPath, { recursive: true })
  await writeRunAssignmentLocator(workspacePath, childLocation)

  const rootGrant: RunAssignmentAuthorityGrant = {
    version: RUN_ASSIGNMENT_AUTHORITY_GRANT_VERSION,
    sessionId: session.id,
    runId: task.runId,
    taskId: task.id,
    assignmentId: rootAssignmentId,
    parentAssignmentId: null,
    depth: 0,
  }
  const childGrant: RunAssignmentAuthorityGrant = {
    ...rootGrant,
    assignmentId: childAssignmentId,
    parentAssignmentId: rootAssignmentId,
    depth: 1,
  }
  await writeRunAssignmentAuthorityGrant(workspacePath, rootGrant)
  await writeRunAssignmentAuthorityGrant(workspacePath, childGrant)
  return { sessionId: session.id, rootGrant, childGrant }
}

test('task creation seals uploaded, parsed, workflow, and RunPlan inputs in a nested run', async () => {
  const workspacePath = makeWorkspace()
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'Immutable run' })
    const uploadedContents = Buffer.from('original upload')
    await store.saveUploadedFile(session.id, {
      filename: 'source.txt',
      contents: uploadedContents,
    })
    const inputsPath = store.inputsDir(session.id)
    const parsedPath = path.join(inputsPath, 'parsed')
    const parsedSourceContents = 'original parsed'
    const parsedFactsContents = '{"fact":1}\n'
    const parsedManifestContents = '{"files":[]}\n'
    fs.mkdirSync(path.join(parsedPath, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(parsedPath, 'source.txt.txt'), parsedSourceContents)
    fs.writeFileSync(path.join(parsedPath, 'nested', 'facts.json'), parsedFactsContents)
    fs.writeFileSync(path.join(parsedPath, '_manifest.json'), parsedManifestContents)
    fs.mkdirSync(path.join(inputsPath, 'unsupported-directory'))
    let symlinkCreated = false
    try {
      fs.symlinkSync(
        path.join(inputsPath, 'source.txt'),
        path.join(inputsPath, 'linked-source.txt'),
        'file',
      )
      symlinkCreated = true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EACCES', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(code ?? '')) {
        throw error
      }
    }

    const plan = readyPlan()
    assert.equal(await store.saveRunPlan(session.id, plan), true)
    const persistedPlan = await store.getRunPlan(session.id)
    assert.ok(persistedPlan)
    const workflowYaml = [
      'workflow:',
      '  id: snapshot-workflow',
      '  steps: []',
      '',
    ].join('\n')
    const task = await store.createTaskRecord(session.id, {
      workflowId: 'snapshot-workflow',
      brief: '# Task Brief\n\nUse the sealed inputs.\n',
      workflowYaml,
    })
    assert.ok(task?.runPath)
    assert.ok(task.assignmentPath)
    assert.ok(task.inputSnapshotPath)
    assert.ok(task.workflowSnapshotPath)
    assert.equal(task.assignmentId, task.runId)
    assert.equal(
      task.runPath,
      path.join(workspacePath, 'sessions', session.id, 'runs', task.runId),
    )
    assert.equal(
      task.assignmentPath,
      path.join(task.runPath, 'assignments', task.runId),
    )

    const runManifest = JSON.parse(
      fs.readFileSync(path.join(task.runPath, 'run.json'), 'utf8'),
    ) as {
      id: string
      rootAssignmentId: string
      paths: { workflow: string; runPlan: string }
    }
    assert.equal(runManifest.id, task.runId)
    assert.equal(runManifest.rootAssignmentId, task.runId)
    assert.equal(runManifest.paths.workflow, 'workflow.yaml')
    assert.equal(runManifest.paths.runPlan, 'run-plan.json')

    const snapshotManifest = JSON.parse(
      fs.readFileSync(path.join(task.inputSnapshotPath, 'manifest.json'), 'utf8'),
    ) as {
      files: Array<{ path: string; kind: string; bytes: number; sha256: string }>
      skipped: Array<{ path: string; reason: string }>
      workflow: { path: string; sha256: string }
      runPlan: { path: string; sha256: string }
    }
    assert.deepEqual(
      snapshotManifest.files,
      [{
        path: 'files/source.txt',
        kind: 'input',
        uploadedAt: fs.statSync(path.join(store.inputsDir(session.id), 'source.txt')).mtime.toISOString(),
        bytes: uploadedContents.byteLength,
        sha256: sha256(uploadedContents),
      }, {
        path: 'parsed/_manifest.json',
        kind: 'parsed',
        bytes: Buffer.byteLength(parsedManifestContents),
        sha256: sha256(parsedManifestContents),
      }, {
        path: 'parsed/nested/facts.json',
        kind: 'parsed',
        bytes: Buffer.byteLength(parsedFactsContents),
        sha256: sha256(parsedFactsContents),
      }, {
        path: 'parsed/source.txt.txt',
        kind: 'parsed',
        bytes: Buffer.byteLength(parsedSourceContents),
        sha256: sha256(parsedSourceContents),
      }],
    )
    assert.deepEqual(snapshotManifest.skipped, [
      ...(symlinkCreated
        ? [{ path: 'files/linked-source.txt', reason: 'symbolic_link' }]
        : []),
      {
        path: 'files/unsupported-directory',
        reason: 'unsupported_file_type',
      },
    ])
    assert.equal(snapshotManifest.workflow.path, '../workflow.yaml')
    assert.equal(snapshotManifest.workflow.sha256, sha256(workflowYaml))

    const sealedPlanText = fs.readFileSync(path.join(task.runPath, 'run-plan.json'), 'utf8')
    assert.deepEqual(JSON.parse(sealedPlanText), persistedPlan)
    assert.equal(snapshotManifest.runPlan.path, '../run-plan.json')
    assert.equal(snapshotManifest.runPlan.sha256, sha256(sealedPlanText))
    assert.equal(fs.readFileSync(task.workflowSnapshotPath, 'utf8'), workflowYaml)
    assert.equal(
      fs.readFileSync(path.join(task.inputSnapshotPath, 'files', 'source.txt'), 'utf8'),
      'original upload',
    )
    assert.equal(
      fs.readFileSync(path.join(task.inputSnapshotPath, 'parsed', 'source.txt.txt'), 'utf8'),
      'original parsed',
    )

    if (process.platform !== 'win32') {
      assert.notEqual(
        fs.statSync(path.join(inputsPath, 'source.txt')).ino,
        fs.statSync(path.join(task.inputSnapshotPath, 'files', 'source.txt')).ino,
      )
    }
    assertReadOnly(path.join(task.inputSnapshotPath, 'manifest.json'))
    assertReadOnly(path.join(task.inputSnapshotPath, 'files', 'source.txt'))
    assertReadOnly(task.workflowSnapshotPath)
    assertReadOnly(path.join(task.runPath, 'run-plan.json'))
    const writableRestorationWitness = path.join(
      workspacePath,
      'snapshot-writable-restoration-witness.txt',
    )
    if (process.platform !== 'win32') {
      fs.linkSync(
        path.join(task.inputSnapshotPath, 'files', 'source.txt'),
        writableRestorationWitness,
      )
      assertReadOnly(writableRestorationWitness)
    }

    fs.writeFileSync(path.join(inputsPath, 'source.txt'), 'mutated upload')
    fs.writeFileSync(path.join(parsedPath, 'source.txt.txt'), 'mutated parsed')
    fs.unlinkSync(path.join(inputsPath, 'source.txt'))
    assert.equal(
      fs.readFileSync(path.join(task.inputSnapshotPath, 'files', 'source.txt'), 'utf8'),
      'original upload',
    )
    assert.equal(
      fs.readFileSync(path.join(task.inputSnapshotPath, 'parsed', 'source.txt.txt'), 'utf8'),
      'original parsed',
    )

    const indexed = resolveRunAssignmentLocation(workspacePath, task.runId)
    assert.equal(indexed?.layout, 'session')
    assert.equal(indexed?.assignmentPath, task.assignmentPath)
    assert.deepEqual(temporaryEntries(path.join(workspacePath, 'sessions')), [])
    assert.equal(await store.deleteSession(session.id), true)
    if (process.platform !== 'win32') {
      assert.notEqual(
        fs.statSync(writableRestorationWitness).mode & 0o200,
        0,
        'session deletion must restore owner-write permission before removing sealed snapshots',
      )
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('task creation seals only explicitly selected project context and survives later edits', async () => {
  const workspacePath = makeWorkspace()
  const store = new FileSystemSessionStore(workspacePath)
  const projectStore = new WorkspaceProjectStore({ workspacePath })
  const membershipStore = new WorkspaceProjectMembershipStore({ workspacePath })
  const contextStore = new WorkspaceProjectContextStore({ workspacePath })
  try {
    const session = await store.createSession({ title: 'Project context run' })
    const project = await projectStore.create({ name: 'Acme evidence' })
    await membershipStore.assign(session.id, project.id)
    await contextStore.saveBrief(project.id, '# Stable facts\n\nLaunch region: EU')
    await contextStore.saveFile(project.id, {
      filename: 'selected.md',
      contents: Buffer.from('selected evidence'),
    })
    await contextStore.saveFile(project.id, {
      filename: 'not-selected.md',
      contents: Buffer.from('private from this run'),
    })

    const task = await store.createTaskRecord(session.id, {
      workflowId: 'project-snapshot-workflow',
      brief: 'Use explicitly selected project context.',
      workflowYaml: 'workflow:\n  id: project-snapshot-workflow\n',
      projectContext: {
        projectId: project.id,
        includeBrief: true,
        fileNames: ['selected.md'],
      },
    })

    assert.ok(task?.inputSnapshotPath)
    assert.match(task.brief, /Launch region: EU/)
    assert.match(task.brief, /selected evidence/)
    assert.doesNotMatch(task.brief, /private from this run/)
    const projectContextPath = path.join(task.inputSnapshotPath, 'project-context')
    assert.equal(
      fs.readFileSync(path.join(projectContextPath, 'brief.md'), 'utf8'),
      '# Stable facts\n\nLaunch region: EU',
    )
    assert.equal(
      fs.readFileSync(path.join(projectContextPath, 'files', 'selected.md'), 'utf8'),
      'selected evidence',
    )
    assert.equal(
      fs.existsSync(path.join(projectContextPath, 'files', 'not-selected.md')),
      false,
    )
    const manifest = JSON.parse(
      fs.readFileSync(path.join(projectContextPath, 'manifest.json'), 'utf8'),
    ) as {
      projectId: string
      projectUpdatedAt: string
      brief: { relativePath: string; sha256: string; byteLength: number }
      files: Array<{
        name: string
        relativePath: string
        sha256: string
        byteLength: number
      }>
    }
    assert.equal(manifest.projectId, project.id)
    assert.equal(manifest.brief.relativePath, 'brief.md')
    assert.equal(manifest.brief.sha256, sha256('# Stable facts\n\nLaunch region: EU'))
    assert.deepEqual(manifest.files, [
      {
        name: 'selected.md',
        relativePath: 'files/selected.md',
        mimeType: 'text/markdown',
        sha256: sha256('selected evidence'),
        byteLength: Buffer.byteLength('selected evidence'),
      },
    ])

    await contextStore.saveBrief(project.id, '# Changed after admission')
    await contextStore.deleteFile(project.id, 'selected.md')
    assert.equal(
      fs.readFileSync(path.join(projectContextPath, 'brief.md'), 'utf8'),
      '# Stable facts\n\nLaunch region: EU',
    )
    assert.equal(
      fs.readFileSync(path.join(projectContextPath, 'files', 'selected.md'), 'utf8'),
      'selected evidence',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('parallel task creation isolates runs and session deletion removes only nested locators', async () => {
  const workspacePath = makeWorkspace()
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const session = await store.createSession({ title: 'Parallel runs' })
    await store.saveUploadedFile(session.id, {
      filename: 'shared.txt',
      contents: Buffer.from('shared source'),
    })

    const created = await Promise.all([
      store.createTaskRecord(session.id, {
        workflowId: 'wf-a',
        brief: 'First.',
        workflowYaml: 'workflow:\n  id: wf-a\n',
      }),
      store.createTaskRecord(session.id, {
        workflowId: 'wf-b',
        brief: 'Second.',
        workflowYaml: 'workflow:\n  id: wf-b\n',
      }),
    ])
    assert.ok(created[0] && created[1])
    assert.notEqual(created[0].runId, created[1].runId)
    for (const task of created) {
      assert.ok(task?.runPath && task.assignmentPath && task.inputSnapshotPath)
      assert.equal(
        fs.readFileSync(path.join(task.inputSnapshotPath, 'files', 'shared.txt'), 'utf8'),
        'shared source',
      )
      assert.equal(resolveRunAssignmentLocation(workspacePath, task.runId)?.layout, 'session')
    }

    const runsPath = path.join(workspacePath, 'sessions', session.id, 'runs')
    assert.equal(
      fs.readdirSync(runsPath, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length,
      2,
    )
    assert.deepEqual(temporaryEntries(runsPath), [])

    const collidingLegacyPath = path.join(workspacePath, 'assignments', created[0].runId)
    fs.mkdirSync(collidingLegacyPath, { recursive: true })
    fs.writeFileSync(path.join(collidingLegacyPath, 'legacy.txt'), 'keep me')
    assert.equal(resolveRunAssignmentLocation(workspacePath, created[0].runId)?.layout, 'session')

    assert.equal(await store.deleteSession(session.id), true)
    assert.equal(fs.existsSync(path.join(workspacePath, 'sessions', session.id)), false)
    assert.equal(
      fs.existsSync(path.join(workspacePath, 'run-index', `${created[0].runId}.json`)),
      false,
    )
    assert.equal(
      fs.existsSync(path.join(workspacePath, 'run-index', `${created[1].runId}.json`)),
      false,
    )
    assert.equal(fs.readFileSync(path.join(collidingLegacyPath, 'legacy.txt'), 'utf8'), 'keep me')
    assert.equal(resolveRunAssignmentLocation(workspacePath, created[0].runId)?.layout, 'legacy')
    assert.equal(resolveRunAssignmentLocation(workspacePath, created[1].runId), null)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('every session deletion path removes only owned assignment authority grants', async (t) => {
  const modes: readonly SessionDeletionMode[] = ['direct', 'guarded', 'batch']

  for (const mode of modes) {
    await t.test(mode, async () => {
      const workspacePath = fs.realpathSync(makeWorkspace())
      const store = new FileSystemSessionStore(workspacePath)
      try {
        const owned = await createAuthorityFixture(
          workspacePath,
          store,
          `Owned ${mode} session`,
        )
        const unrelated = await createAuthorityFixture(
          workspacePath,
          store,
          `Unrelated ${mode} session`,
        )
        const indexWitnessPath = path.join(
          workspacePath,
          'run-index',
          'unrelated-index-metadata.json',
        )
        fs.writeFileSync(indexWitnessPath, '{"keep":true}\n')

        await deleteSessionUsing(store, owned.sessionId, mode)

        assert.equal(
          await readRunAssignmentAuthorityGrant(
            workspacePath,
            owned.rootGrant.assignmentId,
          ),
          null,
        )
        assert.equal(
          await readRunAssignmentAuthorityGrant(
            workspacePath,
            owned.childGrant.assignmentId,
          ),
          null,
        )
        assert.deepEqual(
          await readRunAssignmentAuthorityGrant(
            workspacePath,
            unrelated.rootGrant.assignmentId,
          ),
          unrelated.rootGrant,
        )
        const unrelatedLocation = resolveRunAssignmentLocation(
          workspacePath,
          unrelated.childGrant.assignmentId,
        )
        assert.ok(unrelatedLocation?.layout === 'session')
        assert.equal(unrelatedLocation.sessionId, unrelated.sessionId)
        assert.equal(fs.existsSync(indexWitnessPath), true)
        assert.equal(
          fs.existsSync(path.join(workspacePath, 'run-index', 'authority')),
          true,
        )

        await deleteSessionUsing(store, unrelated.sessionId, mode)

        assert.equal(
          await readRunAssignmentAuthorityGrant(
            workspacePath,
            unrelated.rootGrant.assignmentId,
          ),
          null,
        )
        assert.equal(
          await readRunAssignmentAuthorityGrant(
            workspacePath,
            unrelated.childGrant.assignmentId,
          ),
          null,
        )
        assert.equal(
          fs.existsSync(path.join(workspacePath, 'run-index', 'authority')),
          false,
        )
        assert.equal(fs.existsSync(indexWitnessPath), true)
      } finally {
        fs.rmSync(workspacePath, { recursive: true, force: true })
      }
    })
  }
})

test('a rejected RunPlan claim leaves no run, task, locator, or temporary storage', async () => {
  const workspacePath = makeWorkspace()
  const store = new FileSystemSessionStore(workspacePath, { instanceId: 'claim-owner' })
  try {
    const session = await store.createSession({ title: 'Rejected claim' })
    const plan = readyPlan('wf-claim')
    await store.saveRunPlan(session.id, plan)
    const claim = await store.claimRunPlanForApply(session.id, plan.id)
    assert.equal(claim?.claimed, true)

    const rejected = await store.createTaskRecord(session.id, {
      workflowId: 'wf-claim',
      brief: 'This must not publish a run.',
      workflowYaml: 'workflow:\n  id: wf-claim\n',
      runPlanId: plan.id,
      runPlanApplyClaimId: 'wrong-claim',
    })
    assert.equal(rejected, null)
    assert.deepEqual(await store.listTaskRecords(session.id), [])
    assert.deepEqual(temporaryEntries(path.join(workspacePath, 'sessions')), [])
    assert.deepEqual(
      fs.readdirSync(path.join(workspacePath, 'sessions', session.id, 'tasks')),
      [],
    )
    assert.equal(fs.existsSync(path.join(workspacePath, 'sessions', session.id, 'runs')), false)
    assert.equal(fs.existsSync(path.join(workspacePath, 'run-index')), false)
    assert.equal(await store.deleteSession(session.id), true)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('batch session deletion preserves every session when one session has active work', async () => {
  const workspacePath = makeWorkspace()
  const store = new FileSystemSessionStore(workspacePath)
  try {
    const sessions = [
      await store.createSession({ title: 'First project chat' }),
      await store.createSession({ title: 'Second project chat' }),
    ].sort((left, right) => left.id.localeCompare(right.id))
    const activeTask = await store.createTaskRecord(sessions[1]!.id, {
      workflowId: 'active-project-work',
      brief: 'Keep the whole project until cancellation',
      workflowYaml: 'workflow:\n  id: active-project-work\n',
    })
    assert.ok(activeTask)

    const result = await store.deleteSessionsIfNoActiveTasks(
      sessions.map((session) => session.id),
    )

    assert.deepEqual(result, {
      deleted: false,
      deletedSessionIds: [],
      reason: 'active_tasks',
    })
    assert.ok(await store.getSession(sessions[0]!.id))
    assert.ok(await store.getSession(sessions[1]!.id))
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
