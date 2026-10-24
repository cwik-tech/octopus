import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { logAgentRun, logRuntimeEvent } from '../../domains/runtime/logger.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { startVoiceLayerFixture, type RecordedVoiceCall } from '../helpers/voice-layer-fixture.js'
import { createAgentQuestionWait, createHumanInputWait } from '../helpers/waiting-task-fixtures.js'

const TEST_NONEXISTENT_PID = 2_147_483_647

interface Workspace {
  readonly root: string
  readonly workspacePath: string
  readonly discoveryDir: string
  readonly registryPath: string
}

function makeWorkspace(): Workspace {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-attention-')))
  const workspacePath = path.join(root, 'workspace')
  const discoveryDir = path.join(root, 'voice-control')
  const registryDir = path.join(root, 'workflows')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(registryDir, { recursive: true })
  const registryPath = path.join(registryDir, 'registry.yaml')
  fs.writeFileSync(
    registryPath,
    ['market-research:', '  description: Research a market.', '  template_path: ./market-research.yaml', ''].join('\n'),
  )
  fs.writeFileSync(
    path.join(registryDir, 'market-research.yaml'),
    [
      'workflow:',
      '  id: market-research',
      '  description: Test workflow.',
      '  input:',
      '    artifact: incoming-brief.md',
      '  steps:',
      '    - id: write',
      '      type: team',
      '      team: writing-team',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-draft.md',
      '  output:',
      '    from_step: write',
      '    artifact: final-draft.md',
      '  on_blocked: stop',
      '  on_failed: stop',
      '',
    ].join('\n'),
  )
  return { root, workspacePath, discoveryDir, registryPath }
}

/** Octopus as the desktop starts it, with voice control on and a short scan interval. */
function startOctopus(workspace: Workspace): Promise<StartedApiServer> {
  return startApiServer({
    apiToken: randomBytes(32).toString('base64url'),
    store: new FileSystemRunStore(workspace.workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: TEST_NONEXISTENT_PID, cwd: workspace.workspacePath }
      },
    },
    taskLauncher: {
      async startRun(request) {
        return { launched: true as const, pid: TEST_NONEXISTENT_PID, cwd: request.cwd }
      },
    },
    sessionStore: new FileSystemSessionStore(workspace.workspacePath),
    workspacePath: workspace.workspacePath,
    repoRootPath: process.cwd(),
    workflowsRegistryPath: workspace.registryPath,
    voiceControl: {
      mcpToken: randomBytes(32).toString('base64url'),
      discoveryDir: workspace.discoveryDir,
      attentionIntervalMs: 25,
    },
  })
}

async function startTask(server: StartedApiServer): Promise<{ sessionId: string; taskId: string }> {
  const sessionResponse = await fetch(`${server.url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Market research' }),
  })
  assert.equal(sessionResponse.status, 201)
  const session = (await sessionResponse.json()) as { id: string }
  const taskResponse = await fetch(`${server.url}/sessions/${session.id}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId: 'market-research', brief: 'Research the market for oat milk in Poland.' }),
  })
  assert.equal(taskResponse.status, 202, await taskResponse.clone().text())
  const task = (await taskResponse.json()) as { id: string }
  return { sessionId: session.id, taskId: task.id }
}

/** The worker finishing, recorded through its own store. */
async function finishTask(workspace: Workspace, sessionId: string, taskId: string): Promise<void> {
  const finished = await new FileSystemSessionStore(workspace.workspacePath).updateTaskRecord(sessionId, taskId, {
    status: 'done',
    completedAt: new Date().toISOString(),
  })
  assert.equal(finished?.status, 'done')
}

function about(taskId: string, name: string): (call: RecordedVoiceCall) => boolean {
  return (call) => {
    const subject = call.arguments.subject
    return call.name === name &&
      typeof subject === 'object' && subject !== null && 'id' in subject && subject.id === taskId
  }
}

function count(calls: readonly RecordedVoiceCall[], match: (call: RecordedVoiceCall) => boolean): number {
  return calls.filter(match).length
}

test('the voice layer hears a task start working and finish once, and not again after a restart', { timeout: 20_000 }, async (t) => {
  const workspace = makeWorkspace()
  const voice = await startVoiceLayerFixture(workspace.discoveryDir)
  let octopus = await startOctopus(workspace)
  try {
    // Act: start work and let the worker finish it.
    const first = await startTask(octopus)
    const working = await voice.waitFor(about(first.taskId, 'set_status'), t.signal)
    assert.equal(working.arguments.state, 'working')
    assert.deepEqual(working.arguments.source, { appId: 'octopus', name: 'Octopus' })
    assert.equal(working.authorization, `Bearer ${voice.token}`, 'Octopus uses the grant the voice layer issued')
    await finishTask(workspace, first.sessionId, first.taskId)

    // Assert: one review notification, with the follow-ups the voice can run.
    const done = await voice.waitFor(about(first.taskId, 'notify'), t.signal)
    assert.equal(done.arguments.kind, 'needs_review')
    assert.equal(typeof done.arguments.speech, 'string')
    const actions = done.arguments.actions as { tool: { name: string; arguments: Record<string, unknown> } }[]
    assert.deepEqual(
      actions.map((action) => action.tool.name),
      ['read_result', 'show'],
    )
    assert.deepEqual(actions[0]?.tool.arguments, { sessionId: first.sessionId, taskId: first.taskId })

    // Act: restart Octopus, then finish a second task as a marker.
    await octopus.close()
    octopus = await startOctopus(workspace)
    const second = await startTask(octopus)
    await finishTask(workspace, second.sessionId, second.taskId)
    await voice.waitFor(about(second.taskId, 'notify'), t.signal)

    // Assert: the first task was announced once in all.
    assert.equal(count(voice.calls, about(first.taskId, 'notify')), 1)
  } finally {
    await octopus.close()
    await voice.close()
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('a task that finished while the voice layer was away is announced once it is back, after a restart', { timeout: 20_000 }, async (t) => {
  const workspace = makeWorkspace()
  let octopus = await startOctopus(workspace)
  let voice: Awaited<ReturnType<typeof startVoiceLayerFixture>> | undefined
  try {
    const first = await startTask(octopus)
    await finishTask(workspace, first.sessionId, first.taskId)
    await octopus.close()

    octopus = await startOctopus(workspace)
    voice = await startVoiceLayerFixture(workspace.discoveryDir)
    const done = await voice.waitFor(about(first.taskId, 'notify'), t.signal)
    assert.equal(done.arguments.kind, 'needs_review')

    const marker = await startTask(octopus)
    await finishTask(workspace, marker.sessionId, marker.taskId)
    await voice.waitFor(about(marker.taskId, 'notify'), t.signal)
    assert.equal(count(voice.calls, about(first.taskId, 'notify')), 1)
  } finally {
    await octopus.close()
    await voice?.close()
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('a notify whose reply is lost is sent again with the same dedupeKey, and then not again', { timeout: 20_000 }, async (t) => {
  const workspace = makeWorkspace()
  const voice = await startVoiceLayerFixture(workspace.discoveryDir)
  const octopus = await startOctopus(workspace)
  try {
    const first = await startTask(octopus)
    await voice.waitFor(about(first.taskId, 'set_status'), t.signal)
    voice.dropNextNotifyReply()
    await finishTask(workspace, first.sessionId, first.taskId)

    // The voice layer recorded it, the reply never arrived, so Octopus resends.
    await voice.waitForCount(about(first.taskId, 'notify'), 2, t.signal)
    const keys = new Set(voice.calls.filter(about(first.taskId, 'notify')).map((call) => call.arguments.dedupeKey))
    assert.equal(keys.size, 1, 'both sends carry one dedupeKey, so the voice layer speaks once')

    // Once acknowledged it is delivered: a later marker arrives with no third send.
    const marker = await startTask(octopus)
    await finishTask(workspace, marker.sessionId, marker.taskId)
    await voice.waitFor(about(marker.taskId, 'notify'), t.signal)
    assert.equal(count(voice.calls, about(first.taskId, 'notify')), 2)
  } finally {
    await octopus.close()
    await voice.close()
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('a question answered in the window while the voice layer was away is not asked when it returns', { timeout: 20_000 }, async (t) => {
  const workspace = makeWorkspace()
  // A first start records the baseline, so the wait seeded next is new to Octopus.
  await (await startOctopus(workspace)).close()
  const waiting = await createHumanInputWait(new FileSystemSessionStore(workspace.workspacePath))
  const octopus = await startOctopus(workspace)
  let voice: Awaited<ReturnType<typeof startVoiceLayerFixture>> | undefined
  try {
    // Answered in the window while no voice layer is running.
    const question = await fetch(
      `${octopus.url}/sessions/${waiting.sessionId}/tasks/${waiting.taskId}/human-in-the-loop`,
    )
    const view = (await question.json()) as {
      workflowRevision: number
      interaction: { sourceArtifact: { sha256: string } }
    }
    const submitted = await fetch(
      `${octopus.url}/sessions/${waiting.sessionId}/tasks/${waiting.taskId}/human-in-the-loop/${waiting.interactionId}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          submissionId: randomUUID(),
          expectedWorkflowRevision: view.workflowRevision,
          expectedSourceArtifactSha256: view.interaction.sourceArtifact.sha256,
          mode: 'continue_without_feedback',
          messages: [],
        }),
      },
    )
    assert.equal(submitted.status, 202, await submitted.clone().text())

    voice = await startVoiceLayerFixture(workspace.discoveryDir)
    const marker = await startTask(octopus)
    await finishTask(workspace, marker.sessionId, marker.taskId)
    await voice.waitFor(about(marker.taskId, 'notify'), t.signal)

    assert.equal(count(voice.calls, about(waiting.taskId, 'notify')), 0)
  } finally {
    await octopus.close()
    await voice?.close()
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('a question that is still open when the voice layer connects is asked, urgently', { timeout: 20_000 }, async (t) => {
  const workspace = makeWorkspace()
  await (await startOctopus(workspace)).close()
  const waiting = await createHumanInputWait(new FileSystemSessionStore(workspace.workspacePath))
  const voice = await startVoiceLayerFixture(workspace.discoveryDir)
  const octopus = await startOctopus(workspace)
  try {
    const asked = await voice.waitFor(about(waiting.taskId, 'notify'), t.signal)
    assert.equal(asked.arguments.kind, 'needs_input')
    assert.equal(asked.arguments.priority, 'urgent')
    assert.match(String(asked.arguments.dedupeKey), new RegExp(waiting.interactionId))
    assert.match(String(asked.arguments.speech), /oat milk sales grew/)
  } finally {
    await octopus.close()
    await voice.close()
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

/**
 * Makes Octopus's own question route answer 500 for one task, the way a busy
 * or briefly failing route would, until `heal` is called. It intercepts at the
 * HTTP boundary only; every other request reaches the real server.
 */
function failQuestionLookups(
  taskId: string,
  failuresBeforeSignal: number,
): { failed: Promise<void>; heal(): void } {
  const originalFetch = globalThis.fetch
  let healed = false
  let failures = 0
  let markFailed: () => void = () => undefined
  const failed = new Promise<void>((resolve) => {
    markFailed = resolve
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!healed && url.includes(`/tasks/${taskId}/human-in-the-loop`)) {
      failures += 1
      if (failures >= failuresBeforeSignal) markFailed()
      return Response.json({ error: 'Temporarily unavailable' }, { status: 500 })
    }
    return originalFetch(input, init)
  }) as typeof globalThis.fetch
  return {
    failed,
    heal: () => {
      healed = true
      globalThis.fetch = originalFetch
    },
  }
}

test('a question whose lookup fails for a while is still asked once the lookup recovers', { timeout: 20_000 }, async (t) => {
  const workspace = makeWorkspace()
  await (await startOctopus(workspace)).close()
  const waiting = await createHumanInputWait(new FileSystemSessionStore(workspace.workspacePath))
  const octopus = await startOctopus(workspace)
  // Each pass looks the question up to record it, then again to recheck the
  // entry before sending (voice-attention-service.ts). Three failed lookups
  // therefore span a whole pass, so at least one recheck has failed.
  const failing = failQuestionLookups(waiting.taskId, 3)
  let voice: Awaited<ReturnType<typeof startVoiceLayerFixture>> | undefined
  try {
    await failing.failed
    failing.heal()

    voice = await startVoiceLayerFixture(workspace.discoveryDir)
    const asked = await voice.waitFor(about(waiting.taskId, 'notify'), t.signal)
    assert.equal(asked.arguments.kind, 'needs_input')
  } finally {
    failing.heal()
    await octopus.close()
    await voice?.close()
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test("an earlier attempt's ending is not announced once a later attempt has ended the same way", { timeout: 20_000 }, async (t) => {
  const workspace = makeWorkspace()
  await (await startOctopus(workspace)).close()
  const store = new FileSystemSessionStore(workspace.workspacePath)
  const session = await store.createSession({ title: 'Retried' })
  const task = await store.createTaskRecord(session.id, { workflowId: 'market-research', brief: 'Research the market.' })
  assert.ok(task)
  await store.updateTaskRecord(session.id, task.id, {
    status: 'failed',
    executionAttemptNumber: 1,
    completedAt: new Date().toISOString(),
  })
  // Octopus records the first failure while no voice layer is running.
  await (await startOctopus(workspace)).close()
  // The task is retried and fails again before the voice layer returns.
  await store.updateTaskRecord(session.id, task.id, {
    status: 'failed',
    executionAttemptNumber: 2,
    completedAt: new Date(Date.now() + 1_000).toISOString(),
  })

  const voice = await startVoiceLayerFixture(workspace.discoveryDir)
  const octopus = await startOctopus(workspace)
  try {
    const failed = await voice.waitFor(about(task.id, 'notify'), t.signal)
    assert.equal(failed.arguments.dedupeKey, `octopus:task:${task.id}:failed:2`)
    const marker = await startTask(octopus)
    await finishTask(workspace, marker.sessionId, marker.taskId)
    await voice.waitFor(about(marker.taskId, 'notify'), t.signal)
    assert.deepEqual(
      voice.calls.filter(about(task.id, 'notify')).map((call) => call.arguments.dedupeKey),
      [`octopus:task:${task.id}:failed:2`],
    )
  } finally {
    await octopus.close()
    await voice.close()
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('the longest question an agent may ask is announced, within the spoken limit', { timeout: 20_000 }, async (t) => {
  const workspace = makeWorkspace()
  await (await startOctopus(workspace)).close()
  const waiting = await createAgentQuestionWait(
    new FileSystemSessionStore(workspace.workspacePath),
    'Q'.repeat(2_000),
  )
  const voice = await startVoiceLayerFixture(workspace.discoveryDir)
  const octopus = await startOctopus(workspace)
  try {
    const asked = await voice.waitFor(about(waiting.taskId, 'notify'), t.signal)
    assert.equal(asked.arguments.kind, 'needs_input')
    assert.ok(String(asked.arguments.speech).length <= 2_000)
  } finally {
    await octopus.close()
    await voice.close()
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

function statusLabelled(taskId: string, label: string): (call: RecordedVoiceCall) => boolean {
  return (call) => about(taskId, 'set_status')(call) && call.arguments.label === label
}

test('a working task is shown with what it is doing, from its run events', { timeout: 20_000 }, async (t) => {
  const workspace = makeWorkspace()
  const voice = await startVoiceLayerFixture(workspace.discoveryDir)
  const octopus = await startOctopus(workspace)
  try {
    const started = await startTask(octopus)
    await voice.waitFor(about(started.taskId, 'set_status'), t.signal)
    const task = await new FileSystemSessionStore(workspace.workspacePath).getTaskRecord(started.sessionId, started.taskId)
    assert.ok(task?.assignmentPath)

    // The worker records its progress the way it always does.
    logRuntimeEvent(task.assignmentPath, {
      timestamp: new Date().toISOString(),
      event: 'session_task.workflow_started',
      session_id: task.runId,
      root_session_id: task.runId,
      assignment_path: task.assignmentPath,
    })
    const workflowStarted = await voice.waitFor(statusLabelled(started.taskId, 'Workflow started'), t.signal)
    assert.equal(workflowStarted.arguments.state, 'working')

    logAgentRun(task.assignmentPath, {
      timestamp: new Date().toISOString(),
      event: 'start',
      session_id: task.runId,
      root_session_id: task.runId,
      assignment_path: task.assignmentPath,
      team: 'writing-team',
      agent_name: 'writer',
      agent_type: 'agent',
    })
    await voice.waitFor(statusLabelled(started.taskId, 'Dispatching agents'), t.signal)
  } finally {
    await octopus.close()
    await voice.close()
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})
