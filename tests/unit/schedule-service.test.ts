import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { parseSchedulesFile, type ScheduleInput } from '../../domains/scheduling/schedule-types.js'
import {
  computeNextScheduleFireAt,
  ScheduleService,
  ScheduleServiceError,
} from '../../services/schedule-service.js'
import { createScheduledAgentTargetResolver } from '../../services/scheduled-agent-target.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'

test('schedule service serializes concurrent CRUD and persists a restart-safe snapshot', async () => {
  const fixture = createSchedulerFixture('schedule-service-repo-')
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-service-workspace-'))
  const storagePath = path.join(workspacePath, 'task-queue', 'schedules.json')
  let now = new Date('2026-07-19T14:00:00.000Z')
  const options = {
    storagePath,
    sessionStore: new FileSystemSessionStore(workspacePath),
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    resolveAgentTarget: createScheduledAgentTargetResolver({
      repoRootPath: fixture.repoRootPath,
      workflowsRegistryPath: fixture.workflowsRegistryPath,
    }),
    tickIntervalMs: 60_000,
    now: () => now,
  }
  const service = new ScheduleService(options)
  try {
    await service.initialize()
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service.create(workflowSchedule({ name: `Schedule ${index + 1}` })),
      ),
    )
    assert.equal(new Set(created.map((schedule) => schedule.id)).size, 8)
    assert.equal((await service.list()).length, 8)
    assert.ok(created.every(
      (schedule) => schedule.runtime.nextFireAt === '2026-07-20T13:00:00.000Z',
    ))

    const parsed = parseSchedulesFile(
      JSON.parse(fs.readFileSync(storagePath, 'utf8')),
    )
    assert.equal(parsed.schedules.length, 8)
    assert.ok(parsed.schedules.every(
      (schedule) => schedule.execution?.workflowId === fixture.workflowId,
    ))
    assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)

    const updated = await service.update(created[0]!.id, {
      enabled: false,
      name: 'Paused schedule',
    })
    assert.equal(updated.enabled, false)
    assert.equal(updated.runtime.nextFireAt, undefined)
    await service.delete(created[1]!.id)
    assert.equal((await service.list()).length, 7)
  } finally {
    await service.close()
  }

  now = new Date('2026-07-22T14:00:00.000Z')
  const restarted = new ScheduleService({
    ...options,
    sessionStore: new FileSystemSessionStore(workspacePath),
  })
  try {
    await restarted.initialize()
    const schedules = await restarted.list()
    assert.equal(schedules.length, 7)
    assert.equal(
      schedules.find((schedule) => schedule.name === 'Paused schedule')?.runtime.nextFireAt,
      undefined,
    )
    assert.ok(
      schedules
        .filter((schedule) => schedule.enabled)
        .every((schedule) => schedule.runtime.nextFireAt === '2026-07-23T13:00:00.000Z'),
    )
  } finally {
    await restarted.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('schedule service validates timezone, cron, model semantics, and target existence', async () => {
  const fixture = createSchedulerFixture('schedule-validation-repo-')
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-validation-workspace-'))
  const service = new ScheduleService({
    storagePath: path.join(workspacePath, 'task-queue', 'schedules.json'),
    sessionStore: new FileSystemSessionStore(workspacePath),
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    resolveAgentTarget: createScheduledAgentTargetResolver({
      repoRootPath: fixture.repoRootPath,
      workflowsRegistryPath: fixture.workflowsRegistryPath,
    }),
    tickIntervalMs: 60_000,
    now: () => new Date('2026-07-19T14:00:00.000Z'),
  })
  try {
    await service.initialize()
    await assert.rejects(
      service.create(workflowSchedule({ timezone: 'Mars/Olympus' })),
      (error) => error instanceof ScheduleServiceError && error.code === 'invalid_request',
    )
    await assert.rejects(
      service.create(workflowSchedule({ cron: '0 9 * * * *' })),
      /exactly five fields/,
    )
    await assert.rejects(
      service.create(workflowSchedule({ target: 'missing-workflow' })),
      /not available for scheduling/,
    )
    await assert.rejects(
      service.create({
        ...workflowSchedule(),
        modelOverride: { provider: 'openai', model: 'gpt-5-mini' },
      }),
      /only for agent schedules/,
    )
    fs.writeFileSync(
      path.join(
        fixture.repoRootPath,
        'workflows',
        'user-generated',
        `${fixture.workflowId}.yaml`,
      ),
      [
        'workflow:',
        `  id: ${fixture.workflowId}`,
        '  steps:',
        '    - id: draft',
        '      type: agent',
        '      team: test-team',
        '      agent: test-agent',
        '      input_artifact: incoming-brief.md',
        '      result_artifact: round-one.md',
        '    - id: human-feedback',
        '      type: human-in-the-loop',
        '      input_artifact: review/round-one.md',
        '      result_artifact: feedback/round-one.json',
        '  output:',
        '    from_step: draft',
        '    artifact: round-one.md',
        '',
      ].join('\n'),
    )
    await assert.rejects(
      service.create(workflowSchedule()),
      (error) =>
        error instanceof ScheduleServiceError &&
        error.code === 'workflow_requires_input',
    )
  } finally {
    await service.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('schedule project validation reads only the project record', async () => {
  const fixture = createSchedulerFixture('schedule-project-record-repo-')
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'schedule-project-record-workspace-'),
  )
  const projectId = '11111111-1111-4111-8111-111111111111'
  const workspaceProjectService = {
    createSession: async () => {
      throw new Error('not used by schedule creation')
    },
    getSession: async () => {
      throw new Error('not used by schedule creation')
    },
    getProject: async () => {
      throw new Error('project session hydration was invoked')
    },
    getProjectRecord: async () => ({
      version: 1 as const,
      id: projectId,
      name: 'Acme',
      status: 'active' as const,
      createdAt: '2026-08-05T12:00:00.000Z',
      updatedAt: '2026-08-05T12:00:00.000Z',
    }),
    withProjectReferenceMutation: async <T>(
      _selectedProjectId: string,
      operation: () => Promise<T>,
    ) => operation(),
  }
  const service = new ScheduleService({
    storagePath: path.join(workspacePath, 'task-queue', 'schedules.json'),
    sessionStore: new FileSystemSessionStore(workspacePath),
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    workspaceProjectService,
    tickIntervalMs: 60_000,
    now: () => new Date('2026-08-05T12:00:00.000Z'),
  })
  try {
    await service.initialize()

    const schedule = await service.create(workflowSchedule({ projectId }))

    assert.equal(schedule.projectId, projectId)
  } finally {
    await service.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('schedule service lists only schedules owned by one project', async () => {
  const fixture = createSchedulerFixture('schedule-project-list-repo-')
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'schedule-project-list-workspace-'),
  )
  const storagePath = path.join(workspacePath, 'task-queue', 'schedules.json')
  const firstProjectId = '11111111-1111-4111-8111-111111111111'
  const secondProjectId = '22222222-2222-4222-8222-222222222222'
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  fs.writeFileSync(storagePath, `${JSON.stringify({
    version: 1,
    schedules: [
      persistedWorkflowSchedule('schedule-first', firstProjectId, fixture.workflowId),
      persistedWorkflowSchedule('schedule-second', secondProjectId, fixture.workflowId),
    ],
  }, null, 2)}\n`)
  const service = new ScheduleService({
    storagePath,
    sessionStore: new FileSystemSessionStore(workspacePath),
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    tickIntervalMs: 60_000,
    now: () => new Date('2026-08-05T12:00:00.000Z'),
  })
  try {
    await service.initialize()

    const schedules = await (
      service as unknown as {
        listByProject(projectId: string): ReturnType<ScheduleService['list']>
      }
    ).listByProject(firstProjectId)

    assert.deepEqual(schedules.map((schedule) => schedule.id), ['schedule-first'])
  } finally {
    await service.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('schedule service recovers a persisted fire intent without duplicate admission', async () => {
  const fixture = createSchedulerFixture('schedule-intent-recovery-repo-')
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'schedule-intent-recovery-workspace-'),
  )
  const storagePath = path.join(workspacePath, 'task-queue', 'schedules.json')
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const options = {
    storagePath,
    sessionStore,
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    tickIntervalMs: 60_000,
    now: () => new Date('2026-07-19T14:00:00.000Z'),
  }
  const service = new ScheduleService(options)
  try {
    await service.initialize()
    await service.create(workflowSchedule({ name: 'Admitted before crash' }))
    await service.create(workflowSchedule({ name: 'Interrupted before admission' }))
  } finally {
    await service.close()
  }

  const admittedSession = await sessionStore.createSession({ title: 'Admitted fire' })
  const admittedTask = await sessionStore.createTaskRecord(admittedSession.id, {
    workflowId: fixture.workflowId,
    brief: 'Recover this admitted scheduled fire.',
  })
  assert.ok(admittedTask)
  const interruptedSession = await sessionStore.createSession({
    title: 'Interrupted fire',
  })
  const persisted = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as {
    schedules: Array<{
      name: string
      runtime?: Record<string, unknown>
    }>
  }
  const firedAt = '2026-07-19T14:01:00.000Z'
  for (const schedule of persisted.schedules) {
    schedule.runtime = {
      ...(schedule.runtime ?? {}),
      pendingFire: {
        sessionId:
          schedule.name === 'Admitted before crash'
            ? admittedSession.id
            : interruptedSession.id,
        firedAt,
      },
    }
  }
  fs.writeFileSync(storagePath, `${JSON.stringify(persisted, null, 2)}\n`)

  const restarted = new ScheduleService(options)
  try {
    await restarted.initialize()
    const schedules = await restarted.list()
    const admitted = schedules.find((entry) => entry.name === 'Admitted before crash')
    assert.equal(admitted?.runtime.pendingFire, undefined)
    assert.deepEqual(admitted?.runtime.activeFires, [{
      sessionId: admittedSession.id,
      taskId: admittedTask.id,
      firedAt,
    }])
    const interrupted = schedules.find(
      (entry) => entry.name === 'Interrupted before admission',
    )
    assert.equal(interrupted?.runtime.pendingFire, undefined)
    assert.equal(interrupted?.runtime.lastStatus, 'error')
    assert.match(interrupted?.runtime.lastError ?? '', /before task admission/)
  } finally {
    await restarted.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('unavailable task admission is recorded durably without disabling the schedule', async () => {
  const fixture = createSchedulerFixture('schedule-unavailable-repo-')
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-unavailable-workspace-'))
  const service = new ScheduleService({
    storagePath: path.join(workspacePath, 'task-queue', 'schedules.json'),
    sessionStore: new FileSystemSessionStore(workspacePath),
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    tickIntervalMs: 60_000,
  })
  try {
    await service.initialize()
    const schedule = await service.create(workflowSchedule())
    await assert.rejects(
      service.runNow(schedule.id),
      (error) =>
        error instanceof ScheduleServiceError &&
        error.code === 'schedule_unavailable',
    )
    const recorded = (await service.list())[0]!
    assert.equal(recorded.enabled, true)
    assert.equal(recorded.runtime.lastStatus, 'error')
    assert.match(recorded.runtime.lastError ?? '', /Task queue is not available/)
    const persisted = parseSchedulesFile(
      JSON.parse(
        fs.readFileSync(
          path.join(workspacePath, 'task-queue', 'schedules.json'),
          'utf8',
        ),
      ),
    )
    assert.equal(persisted.schedules[0]?.runtime?.lastStatus, 'error')
  } finally {
    await service.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('next-fire calculation honors IANA timezone daylight-saving transitions', () => {
  assert.equal(
    computeNextScheduleFireAt(
      '30 9 * * *',
      'America/Detroit',
      new Date('2026-03-07T15:00:00.000Z'),
    ),
    '2026-03-08T13:30:00.000Z',
  )
})

function workflowSchedule(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    name: 'Daily test workflow',
    kind: 'workflow',
    target: 'test-workflow',
    prompt: 'Produce a concise scheduler integration test report.',
    cron: '0 9 * * *',
    timezone: 'America/Detroit',
    scheduleLabel: 'Every day at 09:00',
    overlap: 'skip',
    notifyOnFailure: false,
    enabled: true,
    ...overrides,
  }
}

function persistedWorkflowSchedule(
  id: string,
  projectId: string,
  workflowId: string,
) {
  return {
    id,
    ...workflowSchedule({ projectId }),
    createdAt: '2026-08-05T11:00:00.000Z',
    updatedAt: '2026-08-05T11:00:00.000Z',
    execution: { workflowId },
    runtime: {},
  }
}
