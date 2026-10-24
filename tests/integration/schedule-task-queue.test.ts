import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunStartRequest } from '../../domains/run/run-store.js'
import { ScheduleService, ScheduleServiceError } from '../../services/schedule-service.js'
import { createScheduledAgentTargetResolver } from '../../services/scheduled-agent-target.js'
import { TaskQueue } from '../../services/task-queue.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { WorkspaceProjectContextStore } from '../../domains/projects/project-context-store.js'
import { WorkspaceProjectMembershipStore } from '../../domains/projects/project-membership-store.js'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'
import { WorkspaceProjectService } from '../../domains/projects/workspace-project-service.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'

class BlockingLauncher implements RunLauncher {
  readonly starts: string[] = []

  async startRun(request: RunStartRequest): Promise<never> {
    const taskId = request.env?.TEAM_RUNTIME_TASK_ID
    if (!taskId) throw new Error('Missing task id')
    this.starts.push(taskId)
    return await new Promise<never>(() => undefined)
  }
}

test('scheduled agent fires use the durable queue and enforce every overlap policy', async () => {
  const fixture = createSchedulerFixture('schedule-queue-repo-')
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-queue-workspace-'))
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: 'schedule-queue-integration',
  })
  const projectContextStore = new WorkspaceProjectContextStore({ workspacePath })
  const workspaceProjectService = new WorkspaceProjectService({
    projectStore: new WorkspaceProjectStore({ workspacePath }),
    membershipStore: new WorkspaceProjectMembershipStore({ workspacePath }),
    projectContextStore,
    sessionStore,
  })
  const project = await workspaceProjectService.createProject({
    name: 'Scheduled project',
  })
  await projectContextStore.saveBrief(project.id, '# Stable scheduled context')
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const launcher = new BlockingLauncher()
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    taskLauncher: launcher,
    tickIntervalMs: 60_000,
  })
  let now = new Date('2026-07-19T14:00:00.000Z')
  const scheduleService = new ScheduleService({
    storagePath: path.join(workspacePath, 'task-queue', 'schedules.json'),
    sessionStore,
    taskQueue,
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    workspaceProjectService,
    workspaceProjectContextStore: projectContextStore,
    resolveAgentTarget: createScheduledAgentTargetResolver({
      repoRootPath: fixture.repoRootPath,
      workflowsRegistryPath: fixture.workflowsRegistryPath,
    }),
    tickIntervalMs: 25,
    now: () => now,
  })
  const previousApiKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY

  try {
    await taskQueue.initialize()
    await scheduleService.initialize()
    const schedule = await scheduleService.create({
      name: 'Agent overlap contract',
      kind: 'agent',
      target: fixture.agentName,
      prompt: 'Produce a concise scheduler overlap integration report.',
      cron: '0 9 * * *',
      timezone: 'America/Detroit',
      scheduleLabel: 'Every day at 09:00',
      overlap: 'skip',
      notifyOnFailure: false,
      enabled: true,
      projectId: project.id,
      projectContext: {
        version: 1,
        includeBrief: true,
        fileNames: [],
      },
    })

    const first = await scheduleService.runNow(schedule.id)
    const firstTask = await sessionStore.getTaskRecord(first.sessionId, first.taskId)
    assert.ok(firstTask)
    assert.deepEqual(
      (await workspaceProjectService.getSession(first.sessionId))?.origin,
      { kind: 'scheduled', scheduleId: schedule.id },
    )
    assert.equal(
      (await workspaceProjectService.getSession(first.sessionId))?.projectId,
      project.id,
    )
    assert.ok(firstTask.inputSnapshotPath)
    assert.equal(
      fs.readFileSync(
        path.join(firstTask.inputSnapshotPath, 'project-context', 'brief.md'),
        'utf8',
      ),
      '# Stable scheduled context',
    )
    const clearedProject = await scheduleService.update(schedule.id, {
      projectId: null,
      projectContext: null,
    })
    assert.equal(clearedProject.projectId, undefined)
    assert.equal(clearedProject.projectContext, undefined)
    await scheduleService.update(schedule.id, {
      projectId: project.id,
      projectContext: {
        version: 1,
        includeBrief: true,
        fileNames: [],
      },
    })
    assert.equal(firstTask.admission?.source, 'scheduled')
    // One wrapper per agent: a schedule no longer varies the model, so there
    // is nothing left for a per-profile suffix to distinguish.
    assert.equal(firstTask.workflowId, 'scheduled-agent-test-agent')
    assert.match(
      (await sessionStore.getSession(first.sessionId))?.title ?? '',
      /^⏰ Agent overlap contract — /,
    )
    assert.ok(firstTask.workflowSnapshotPath)
    assert.match(
      fs.readFileSync(firstTask.workflowSnapshotPath, 'utf8'),
      /result_artifact: produce-a-concise-scheduler-overlap-integration-report\.md/,
    )
    assert.equal((await scheduleService.list())[0]?.runtime.activeFires?.length, 1)

    await assert.rejects(
      scheduleService.runNow(schedule.id),
      (error) => error instanceof ScheduleServiceError && error.code === 'conflict',
    )

    await scheduleService.update(schedule.id, { overlap: 'queue' })
    const second = await scheduleService.runNow(schedule.id)
    assert.notEqual(second.taskId, first.taskId)
    assert.equal((await scheduleService.list())[0]?.runtime.activeFires?.length, 2)
    const secondTask = await sessionStore.getTaskRecord(second.sessionId, second.taskId)
    assert.equal(secondTask?.admission?.source, 'scheduled')

    await scheduleService.update(schedule.id, { overlap: 'cancel_previous' })
    const third = await scheduleService.runNow(schedule.id)
    const afterCancellation = await scheduleService.list()
    assert.equal(afterCancellation[0]?.runtime.activeFires?.length, 1)
    assert.equal(afterCancellation[0]?.runtime.activeFires?.[0]?.taskId, third.taskId)
    assert.equal(
      (await sessionStore.getTaskRecord(first.sessionId, first.taskId))?.status,
      'cancelled',
    )
    assert.equal(
      (await sessionStore.getTaskRecord(second.sessionId, second.taskId))?.status,
      'cancelled',
    )

    await scheduleService.delete(schedule.id)
    assert.deepEqual(await scheduleService.list(), [])
    assert.equal(
      (await sessionStore.getTaskRecord(third.sessionId, third.taskId))?.status,
      'cancelled',
    )

    const clockSchedule = await scheduleService.create({
      name: 'Clock fire contract',
      kind: 'workflow',
      target: fixture.workflowId,
      prompt: 'Verify the automatic wall-clock scheduler path.',
      cron: '0 9 * * *',
      timezone: 'America/Detroit',
      scheduleLabel: 'Every day at 09:00',
      overlap: 'skip',
      notifyOnFailure: false,
      enabled: true,
    })
    now = new Date('2026-07-20T13:00:01.000Z')
    const clockFire = await waitForActiveFire(scheduleService, clockSchedule.id)
    assert.equal(clockFire.firedAt, now.toISOString())
    assert.deepEqual(
      (await sessionStore.getSession(clockFire.sessionId))?.origin,
      { kind: 'scheduled', scheduleId: clockSchedule.id },
    )
    assert.equal(
      (await sessionStore.getTaskRecord(clockFire.sessionId, clockFire.taskId))
        ?.admission?.source,
      'scheduled',
    )
    await scheduleService.delete(clockSchedule.id)
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousApiKey
    await scheduleService.close()
    await taskQueue.close(1)
    await owner.release()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

async function waitForActiveFire(
  service: ScheduleService,
  scheduleId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const schedule = (await service.list()).find((entry) => entry.id === scheduleId)
    const fire = schedule?.runtime.activeFires?.[0]
    if (fire) return fire
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Schedule '${scheduleId}' did not fire within ${timeoutMs}ms`)
}
