import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { TaskQueue } from '../../services/task-queue.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { WorkspaceDispatcherOwner } from '../../core/workspace-dispatcher-owner.js'

test('committed scheduled task admission invalidates its session for already-open views', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-view-refresh-'))
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Scheduled view refresh' })
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath })
  const changed: string[] = []
  const options = { workspacePath, sessionStore: store, owner, maximumConcurrentTasks: 1, repoRootPath: process.cwd(),
    onSessionChanged: (sessionId: string) => { changed.push(sessionId) } }
  const queue = new TaskQueue(options)
  try {
    await queue.initialize()
    const planId = 'ad605beb-dadc-403a-bca4-b05df6e00009'
    await store.saveRunPlan(session.id, { id: planId, goal: 'Fixture task', summary: 'No model work', status: 'ready',
      selectedWorkflow: { id: 'empty-refresh-fixture', rationale: 'Fixture', confidence: 'high', selectionSource: 'user' },
      requiredInputs: [], actions: [], warnings: [], createdAt: '2026-10-18T00:00:00.000Z' })
    const claim = await store.claimRunPlanForApply(session.id, planId)
    assert.ok(claim?.claimed)
    assert.ok(claim.plan.applyClaimId)
    const task = await queue.enqueueInitial({ sessionId: session.id, admissionSource: 'scheduled', task: {
      runPlanId: planId, runPlanApplyClaimId: claim.plan.applyClaimId, workflowId: 'empty-refresh-fixture', brief: 'No provider is needed.', workflowYaml: 'name: empty-refresh-fixture\nsteps: []\n',
    } })
    await queue.close()
    assert.ok(await store.getTaskRecord(session.id, task.id), 'invalidation follows the durable record')
    assert.ok(changed.includes(session.id), 'the committed admission must invalidate its owning session')
  } finally {
    await queue.close()
    await owner.release()
    await fs.rm(workspacePath, { recursive: true, force: true })
  }
})
