/**
 * Which model named a session that a Team launch named.
 *
 * A Team launch owns no Agent either, so naming its session runs on the one
 * application default and said nothing about it. This is the third title
 * caller, and it differs from the two chat ones in what owns the record: there
 * is no chat turn here, there is an admitted task, so the attempt is owned by
 * that task's identity and nothing else.
 *
 * It also differs in when it runs. The naming happens *after* the task has been
 * admitted and after the brief is durable
 * (`services/team-launch-service.ts:275-288`), and none of the reads it needs —
 * the transcript, the session's files, their parsed context — has a catch. So a
 * fault in optional work rejects a launch whose task is already running, and the
 * caller is told their prompt failed while the Team works on it.
 *
 * The lock faults below are armed after required publication and accompanied by
 * proof that the required work really did succeed. A fault broad enough to also
 * break the task record or the brief would prove the opposite of what is
 * wanted: those two are not optional, and a launch that loses either of them
 * *should* fail. On the message route, the lock fault also prevents ownership
 * cleanup, so the completed response must retain its unreleased claim.
 *
 * Driven through the real API server, a real `FileSystemSessionStore`, a real
 * repo fixture and an owned loopback provider, because what is being proved is
 * what a launch actually admits, which model it actually asked for, and what
 * actually ends up in the file.
 *
 * The task launcher is the one thing replaced. These tests are about admission
 * and persistence, so spawning a real Team worker would add a process, its
 * runtime and its own failure modes to every case here without changing what
 * any of them asserts. That a person running a Team actually sees the notice is
 * a different claim, and the desktop journey is what makes it.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import { UNTITLED_SESSION_TITLE } from '../../domains/sessions/session-title.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { sessionActivityClaimsSchema } from '../../contracts/session-activity.js'

/** The one application default. A Team launch may run its title on nothing else. */
const DEFAULT_MODEL = 'app-default-model'
/** A phrase only the title helper's own system prompt carries. */
const TITLE_PROMPT_MARKER = 'session title that summarizes'
const GENERATED_TITLE = 'Reviewing The Warehouse Automation Proposal'
const BRIEF =
  'Review the warehouse automation proposal for operations leaders, identify its ' +
  'delivery risks, and recommend concrete rollout priorities.'

interface TeamLaunchHarness {
  readonly base: string
  readonly sessionStore: FileSystemSessionStore
  readonly providerName: string
  /** Every model a title request named, in order, read from the wire. */
  titleModels(): (string | undefined)[]
  metadataPath(sessionId: string): string
  chatPath(sessionId: string): string
  taskRecordPath(sessionId: string, taskId: string): string
  locksPath(): string
}

/**
 * A real API server over a real repo fixture, with the provider owned.
 *
 * `onTitleRequest` runs when the title call reaches the provider, which is how
 * "recorded before the send" is proved where it matters: reading only after the
 * call returned could not tell that apart from a record written afterwards. It
 * also faults the later title write and, on the message route, ownership cleanup
 * without breaking the publication that came before it.
 *
 */
async function withTeamLaunch(
  hooks: {
    onTitleRequest?: (harness: TeamLaunchHarness) => void
  },
  run: (harness: TeamLaunchHarness) => Promise<void>,
): Promise<void> {
  initProviders()
  let harness: TeamLaunchHarness | undefined
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        content: GENERATED_TITLE,
        match: (request) => {
          const isTitle = request.systemPrompt?.includes(TITLE_PROMPT_MARKER) ?? false
          if (isTitle && harness) hooks.onTitleRequest?.(harness)
          return isTitle
        },
      },
      { content: 'Unclaimed fixture answer.' },
    ],
  })

  const fixture = createSchedulerFixture('session-title-team-launch-')
  // The fixture's Team is internal by default; a chat-selected Team has to be
  // one a person is allowed to address.
  const teamYamlPath = path.join(fixture.repoRootPath, 'teams', 'test-team', 'team.yaml')
  fs.writeFileSync(
    teamYamlPath,
    fs
      .readFileSync(teamYamlPath, 'utf8')
      .replace('  user_facing: false\n', '  user_facing: true\n')
      .replace('    - team\n', '    - team\n    - user\n'),
  )

  const sessionStore = new FileSystemSessionStore(fixture.workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 0, cwd: '' }
      },
    },
    taskLauncher: {
      async startRun(request) {
        return { launched: true as const, pid: 0, cwd: request.cwd }
      },
    },
    sessionStore,
    workspacePath: fixture.workspacePath,
    repoRootPath: fixture.repoRootPath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
  })

  const connectionId = randomUUID()
  const providerName = `connection:${connectionId}`
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Team launch title provider',
      baseUrl: `${provider.url}/v1`,
      apiKey: 'team-launch-title-key',
    },
  ])

  const sessionDir = (sessionId: string) =>
    path.join(fixture.workspacePath, 'sessions', sessionId)
  harness = {
    base: server.url,
    sessionStore,
    providerName,
    titleModels: () =>
      provider.requests
        .filter((request) => request.systemPrompt?.includes(TITLE_PROMPT_MARKER) ?? false)
        .map((request) => request.model),
    metadataPath: (sessionId: string) => path.join(sessionDir(sessionId), 'session.json'),
    chatPath: (sessionId: string) => path.join(sessionDir(sessionId), 'chat.jsonl'),
    taskRecordPath: (sessionId: string, taskId: string) =>
      path.join(sessionDir(sessionId), 'tasks', taskId, 'task.json'),
    locksPath: () => path.join(fixture.workspacePath, 'sessions', '.locks'),
  }

  const previousDefault = getRuntimeDefaultModelState()
  setRuntimeDefaultModelState({
    status: 'available',
    provider: providerName,
    model: DEFAULT_MODEL,
  })
  try {
    await run(harness)
  } finally {
    setRuntimeDefaultModelState(previousDefault)
    setConfiguredProviderConnections([])
    await server.close()
    await provider.close()
    fixture.cleanup()
  }
}

/** An untitled session, which is the only kind a launch tries to name. */
async function createUntitledSession(base: string): Promise<string> {
  const response = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const body: unknown = await response.json()
  assert.ok(body && typeof body === 'object')
  const id = Reflect.get(body, 'id')
  assert.equal(typeof id, 'string', JSON.stringify(body))
  assert.equal(Reflect.get(body, 'title'), UNTITLED_SESSION_TITLE)
  return String(id)
}

async function launchTeam(
  base: string,
  sessionId: string,
): Promise<{ status: number; task: Record<string, unknown> }> {
  const response = await fetch(`${base}/sessions/${sessionId}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ teamId: 'test-team', brief: BRIEF }),
  })
  const body: unknown = await response.json()
  return {
    status: response.status,
    task: body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {},
  }
}

/**
 * A Team turn the way the product sends one.
 *
 * `POST /tasks` is the API-only entry; the desktop addresses a Team through the
 * message endpoint, and only that response carries the session back to the
 * page. So the returned-session rule has to be proved here rather than there.
 */
async function sendTeamMessage(
  base: string,
  sessionId: string,
  turnId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: BRIEF,
      target: { kind: 'team', teamId: 'test-team' },
      // A client-minted identity is what makes a repeat recognisable as one
      // rather than as a second ask.
      ...(turnId === undefined ? {} : { turnId }),
    }),
  })
  const body: unknown = await response.json()
  return {
    status: response.status,
    body: body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {},
  }
}

/** The recorded history as it stands on disk, unvalidated. */
function storedAttempts(metadataPath: string): unknown[] {
  const raw = fs.readFileSync(metadataPath, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return []
  const attempts = Reflect.get(parsed, 'titleAttempts')
  return Array.isArray(attempts) ? attempts : []
}

/**
 * What the launch is not allowed to lose, whatever happens to the naming.
 *
 * The task record and the brief are both written before any optional work, and
 * both are required. Asserting them beside every fault below is what keeps a
 * best-effort boundary from quietly swallowing a real failure.
 */
function assertLaunchIsDurable(
  harness: TeamLaunchHarness,
  sessionId: string,
  taskId: unknown,
): void {
  assert.equal(typeof taskId, 'string', 'the launch returned no task id')
  // Read from the files these writes actually produce, not from a second API
  // call. `GET /sessions/:id/tasks` reconciles task state as it answers, so
  // with a fault still armed it would be measuring that later operation rather
  // than what the launch left behind.
  const recordPath = harness.taskRecordPath(sessionId, String(taskId))
  assert.ok(fs.existsSync(recordPath), `the admitted task has no record at ${recordPath}`)
  const record: unknown = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
  assert.ok(record && typeof record === 'object')
  assert.equal(Reflect.get(record, 'id'), taskId)
  assert.equal(Reflect.get(record, 'targetKind'), 'team-chat')

  const transcript = fs
    .readFileSync(harness.chatPath(sessionId), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): unknown => JSON.parse(line))
  assert.ok(
    transcript.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        Reflect.get(entry, 'role') === 'user' &&
        Reflect.get(entry, 'text') === BRIEF,
    ),
    `the brief the user submitted is not in the transcript: ${JSON.stringify(transcript)}`,
  )
}

test('a Team launch records the model that named its session, owned by the task it admitted', async () => {
  let historyAtSend: unknown[] = []
  let sessionId = ''
  await withTeamLaunch(
    {
      onTitleRequest: (harness) => {
        historyAtSend = sessionId ? storedAttempts(harness.metadataPath(sessionId)) : []
      },
    },
    async (harness) => {
      sessionId = await createUntitledSession(harness.base)
      const launched = await launchTeam(harness.base, sessionId)
      assert.equal(launched.status, 202, JSON.stringify(launched.task))
      const taskId = launched.task.id
      assertLaunchIsDurable(harness, sessionId, taskId)

      // The title ran on the one application default, read from the wire rather
      // than inferred from which scripted answer came back.
      assert.deepEqual(harness.titleModels(), [DEFAULT_MODEL])

      // The entry was already on disk when the request went out.
      assert.equal(historyAtSend.length, 1, JSON.stringify(historyAtSend))
      const atSend = historyAtSend[0]
      assert.ok(atSend && typeof atSend === 'object', JSON.stringify(atSend))
      assert.deepEqual(Reflect.get(atSend, 'selection'), {
        provider: harness.providerName,
        model: DEFAULT_MODEL,
        source: 'app-default',
        reason: 'agent-default',
        caller: 'title',
      }, JSON.stringify(atSend))

      // What the session now says, read back through the ordinary session read.
      const reloaded = await harness.sessionStore.getSession(sessionId)
      assert.ok(reloaded)
      const attempts = reloaded.titleAttempts ?? []
      assert.equal(attempts.length, 1, JSON.stringify(attempts))
      const attempt = attempts[0]
      assert.ok(attempt)
      assert.equal(attempt.operation, 'team-launch')
      // A Team launch has no chat turn. The admitted task is what owns this,
      // and nothing else may stand in for it.
      assert.equal(attempt.owner, taskId, 'the attempt is owned by the admitted task')
      assert.ok(attempt.attemptId, 'and carries an identity of its own')
      assert.deepEqual(attempt.selection, {
        provider: harness.providerName,
        model: DEFAULT_MODEL,
        source: 'app-default',
        reason: 'agent-default',
        caller: 'title',
      }, JSON.stringify(attempt.selection))

      // The launch did what it was asked to do as well.
      assert.equal(reloaded.title, GENERATED_TITLE)
    },
  )
})

/*
 * The naming's *reads* — the transcript, the session's files, their parsed
 * context — are inside the same best-effort block as its generation and its
 * write, and that is what the production change moved. There is deliberately no
 * case here that faults one of those reads on its own, because this boundary
 * cannot arm one honestly:
 *
 * - The launcher hook fires while admission is still in flight. `TaskQueue.wake`
 *   dispatches asynchronously (`services/task-queue.ts:612-622`), so whether the
 *   fault landed before the naming read came down to timing. Observed: the same
 *   case passed twice and then failed twice with a title request it expected
 *   none of.
 * - Arming before the launch is deterministic and too broad. The session's
 *   inputs directory is also read by admission's own input snapshot, so
 *   poisoning it up front fails the launch itself: `500`, `ENOTDIR ... /inputs`,
 *   before any naming happened.
 *
 * Both failing runs are kept rather than tidied away.
 *
 * This is an open gap, not a covered case. The write-fault case below does not
 * stand in for it: moving the transcript and file-context reads back outside
 * `attemptSessionTitle` would leave that case Green, so it says nothing about
 * where those reads sit. Until a synchronous post-admission boundary exists to
 * arm a fault against, the reads are inside the block by construction and by
 * review only.
 */

test('a title that cannot be saved leaves the Team task admitted and keeps its record', async () => {
  // The same boundary after the send rather than before it. By the time the
  // title request goes out the task and the brief are both durable, so a fault
  // in the write that follows must cost the title alone — and the attempt
  // already recorded still has to come back, or a person would see no account
  // of a model that really was used.
  await withTeamLaunch(
    {
      onTitleRequest: (harness) => {
        // The session lock lives outside the session directory, so replacing
        // the directory that holds it with a file fails the title write. Every
        // other write this launch makes has already finished.
        fs.rmSync(harness.locksPath(), { recursive: true, force: true })
        fs.writeFileSync(harness.locksPath(), '')
      },
    },
    async (harness) => {
      const sessionId = await createUntitledSession(harness.base)
      const launched = await launchTeam(harness.base, sessionId)

      assert.equal(launched.status, 202, JSON.stringify(launched.task))
      assertLaunchIsDurable(harness, sessionId, launched.task.id)

      // The record was taken before the send, which is why the title reached
      // the provider on the default at all.
      assert.deepEqual(harness.titleModels(), [DEFAULT_MODEL])
      const attempts = storedAttempts(harness.metadataPath(sessionId))
      assert.equal(attempts.length, 1, JSON.stringify(attempts))
      const attempt = attempts[0]
      assert.ok(attempt && typeof attempt === 'object')
      assert.equal(Reflect.get(attempt, 'operation'), 'team-launch')
      assert.equal(Reflect.get(attempt, 'owner'), launched.task.id)
    },
  )
})

test('a Team turn whose title cannot be saved still returns the session and its record', async () => {
  // The response is the only thing that carries the record to the screen: the
  // page updates the session it holds from `response.session` and nothing else.
  // So a failed title that returns no session at all would leave a person with
  // no account of a model that really was used until they reload — which is the
  // notice this whole capability exists to put on the page.
  await withTeamLaunch(
    {
      onTitleRequest: (harness) => {
        // Required publication is durable. This faults title saving and the
        // message route's later ownership cleanup, which must retain its claim.
        fs.rmSync(harness.locksPath(), { recursive: true, force: true })
        fs.writeFileSync(harness.locksPath(), '')
      },
    },
    async (harness) => {
      const sessionId = await createUntitledSession(harness.base)
      const sent = await sendTeamMessage(harness.base, sessionId)

      assert.equal(sent.status, 201, JSON.stringify(sent.body))
      const task = sent.body.task
      assert.ok(task && typeof task === 'object', JSON.stringify(sent.body))
      const taskId = Reflect.get(task, 'id')
      assertLaunchIsDurable(harness, sessionId, taskId)

      // The session came back as it stands: not renamed, and carrying the
      // record of the model that was about to name it.
      const session = sent.body.session
      assert.ok(session && typeof session === 'object', JSON.stringify(sent.body))
      assert.equal(Reflect.get(session, 'title'), UNTITLED_SESSION_TITLE)
      const attempts = Reflect.get(session, 'titleAttempts')
      assert.ok(Array.isArray(attempts), JSON.stringify(session))
      assert.equal(attempts.length, 1, JSON.stringify(attempts))
      const attempt: unknown = attempts[0]
      assert.ok(attempt && typeof attempt === 'object')
      assert.equal(Reflect.get(attempt, 'operation'), 'team-launch')
      assert.equal(Reflect.get(attempt, 'owner'), taskId)
      assert.deepEqual(Reflect.get(attempt, 'selection'), {
        provider: harness.providerName,
        model: DEFAULT_MODEL,
        source: 'app-default',
        reason: 'agent-default',
        caller: 'title',
      }, JSON.stringify(attempt))
      const claimsPath = path.join(path.dirname(harness.metadataPath(sessionId)), 'activity-claims.json')
      const raw: unknown = JSON.parse(fs.readFileSync(claimsPath, 'utf8'))
      const claims = sessionActivityClaimsSchema.parse(raw)
      assert.equal(claims.length, 1, 'failed cleanup must retain the admitted Team turn ownership')
      assert.equal(claims[0]?.kind, 'chat')
      assert.equal(claims[0]?.ownerLaunchId, harness.sessionStore.getInstanceId())
      assert.equal(claims[0]?.processId, process.pid)
    },
  )
})

test('a replayed Team turn names nothing again, and still returns the record', async () => {
  // A retry costs nothing: the task is already admitted and the session is
  // already named, so no model may be asked anything a second time and no
  // second attempt may appear beside the first.
  //
  // But the retry still has to answer. A first response lost on the wire is
  // exactly when a client repeats itself, and returning no session then would
  // leave that client with no account of the model that named the session —
  // the record exists and nothing would carry it.
  await withTeamLaunch({}, async (harness) => {
    const sessionId = await createUntitledSession(harness.base)
    const turnId = randomUUID()

    const first = await sendTeamMessage(harness.base, sessionId, turnId)
    assert.equal(first.status, 201, JSON.stringify(first.body))
    const firstTask = first.body.task
    assert.ok(firstTask && typeof firstTask === 'object')
    const taskId = Reflect.get(firstTask, 'id')

    const replay = await sendTeamMessage(harness.base, sessionId, turnId)
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.equal(replay.body.replayed, true, JSON.stringify(replay.body))
    const replayTask = replay.body.task
    assert.ok(replayTask && typeof replayTask === 'object')
    assert.equal(Reflect.get(replayTask, 'id'), taskId, 'the replay admitted a second task')

    // One naming, once.
    assert.deepEqual(harness.titleModels(), [DEFAULT_MODEL])
    const attempts = storedAttempts(harness.metadataPath(sessionId))
    assert.equal(attempts.length, 1, JSON.stringify(attempts))

    // And the replay carries it back, naming the same task that owns it.
    const session = replay.body.session
    assert.ok(session && typeof session === 'object', JSON.stringify(replay.body))
    const returned = Reflect.get(session, 'titleAttempts')
    assert.ok(Array.isArray(returned), JSON.stringify(session))
    assert.equal(returned.length, 1, JSON.stringify(returned))
    const attempt: unknown = returned[0]
    assert.ok(attempt && typeof attempt === 'object')
    assert.equal(Reflect.get(attempt, 'operation'), 'team-launch')
    assert.equal(Reflect.get(attempt, 'owner'), taskId)
  })
})
