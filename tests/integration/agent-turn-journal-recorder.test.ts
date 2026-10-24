/**
 * The recorder that puts `agent.turn` events onto a real assignment journal.
 *
 * It owns two things the pure domain cannot: that a start is on disk before
 * the provider is ever asked, and that a retry of the same turn re-appends
 * rather than forks. Both are filesystem facts, so this runs against the real
 * registry, a real temporary workspace, and the real journal file.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  EXECUTION_JOURNAL_DIRECTORY_NAME,
  EXECUTION_JOURNAL_FILENAME,
} from '../../core/execution-journal.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../../core/run-assignment-location.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { resolveAgentTurnJournalRecorder } from '../../services/agent-turn-journal-recorder.js'
import type { AgentTurnJournalRecorder } from '../../services/agent-turn-journal-recorder.js'

const AGENT_PATH = 'agents/quick-scout'
const REPLY_ID = 'quick-scout:0'

interface Fixture {
  readonly workspacePath: string
  readonly registry: WorkspaceExecutionJournalRegistry
  readonly scope: {
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
  }
  readonly journalPath: string
  recorder(): Promise<AgentTurnJournalRecorder>
  cleanup(): Promise<void>
}

async function makeFixture(): Promise<Fixture> {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agent-turn-recorder-')),
  )
  const scope = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    assignmentId: randomUUID(),
  }
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    scope.sessionId,
    'runs',
    scope.runId,
    'assignments',
    scope.assignmentId,
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  return {
    workspacePath,
    registry,
    scope,
    journalPath: path.join(
      assignmentPath,
      RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
      EXECUTION_JOURNAL_DIRECTORY_NAME,
      EXECUTION_JOURNAL_FILENAME,
    ),
    recorder: async () => {
      const resolved = await resolveAgentTurnJournalRecorder({
        registry,
        scope,
        agentPath: AGENT_PATH,
        requestId: randomUUID(),
        processIdentity: 'agent-turn-recorder-test',
      })
      assert.ok(resolved, 'an authoritative workspace enrolls the assignment')
      return resolved
    },
    cleanup: async () => {
      await registry.close()
      fs.rmSync(workspacePath, { recursive: true, force: true })
    },
  }
}

function journalEventTypes(journalPath: string): string[] {
  if (!fs.existsSync(journalPath)) return []
  return fs
    .readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { streamKind?: string; type?: string })
    .filter((event) => event.streamKind === 'agent.turn')
    .map((event) => event.type ?? '')
}

function journalRevisions(journalPath: string): number[] {
  return fs
    .readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map(
      (line) =>
        JSON.parse(line) as { streamKind?: string; streamRevision?: number },
    )
    .filter((event) => event.streamKind === 'agent.turn')
    .map((event) => event.streamRevision ?? -1)
}

function startedInput(turnId: string, model = 'fixture/quick-scout') {
  return {
    turnId,
    replyId: REPLY_ID,
    speakerOrdinal: 0,
    agentPath: AGENT_PATH,
    requestedProvider: 'connection:abc',
    requestedModel: model,
  }
}

test('the start is on disk before the turn operation runs', async () => {
  const fixture = await makeFixture()
  const turnId = randomUUID()
  try {
    const recorder = await fixture.recorder()
    let typesSeenByOperation: string[] = []

    await recorder.recordStarted(startedInput(turnId))
    // Standing in for the provider request: whatever runs next already has the
    // start behind it.
    typesSeenByOperation = journalEventTypes(fixture.journalPath)

    assert.deepEqual(typesSeenByOperation, ['agent.turn.started'])
  } finally {
    await fixture.cleanup()
  }
})

test('re-recording the same start is accepted rather than duplicated', async () => {
  const fixture = await makeFixture()
  const turnId = randomUUID()
  try {
    const first = await fixture.recorder()
    await first.recordStarted(startedInput(turnId))
    // A retry arrives on a fresh handle, as it would after a restart.
    const second = await fixture.recorder()
    await second.recordStarted(startedInput(turnId))

    assert.deepEqual(journalEventTypes(fixture.journalPath), [
      'agent.turn.started',
    ])
  } finally {
    await fixture.cleanup()
  }
})

test('a start that changed its content fails closed', async () => {
  const fixture = await makeFixture()
  const turnId = randomUUID()
  try {
    const recorder = await fixture.recorder()
    await recorder.recordStarted(startedInput(turnId))

    const retry = await fixture.recorder()
    await assert.rejects(
      () => retry.recordStarted(startedInput(turnId, 'a-different-model')),
      /identity/i,
    )
    assert.deepEqual(journalEventTypes(fixture.journalPath), [
      'agent.turn.started',
    ])
  } finally {
    await fixture.cleanup()
  }
})

test('preparation and terminal take consecutive stream revisions', async () => {
  const fixture = await makeFixture()
  const turnId = randomUUID()
  try {
    const recorder = await fixture.recorder()
    await recorder.recordStarted(startedInput(turnId))
    await recorder.recordPrepared({
      turnId,
      replyId: REPLY_ID,
      assistantMessageId: 'msg-1',
      outcome: 'success',
      route: 'mcp-native',
      resolvedModel: 'fixture/quick-scout',
      outputByteLength: 42,
    })
    await recorder.recordCompleted({
      turnId,
      replyId: REPLY_ID,
      assistantMessageId: 'msg-1',
      route: 'mcp-native',
    })

    assert.deepEqual(journalRevisions(fixture.journalPath), [1, 2, 3])
    assert.deepEqual(journalEventTypes(fixture.journalPath), [
      'agent.turn.started',
      'agent.turn.prepared',
      'agent.turn.completed',
    ])
    assert.equal((await recorder.readSummary())?.state, 'completed')
  } finally {
    await fixture.cleanup()
  }
})

test('a turn whose reply was prepared but never stored reads as reply_pending', async () => {
  const fixture = await makeFixture()
  const turnId = randomUUID()
  try {
    const recorder = await fixture.recorder()
    await recorder.recordStarted(startedInput(turnId))
    await recorder.recordPrepared({
      turnId,
      replyId: REPLY_ID,
      assistantMessageId: 'msg-9',
      outcome: 'success',
      route: 'direct-provider',
      outputByteLength: 7,
    })

    // A fresh handle is what a retry after a crash actually holds.
    const recovered = await fixture.recorder()
    const summary = await recovered.readSummary()
    assert.equal(summary?.state, 'reply_pending')
    assert.equal(summary?.assistantMessageId, 'msg-9')

    // And the terminal it appends still lands on revision 2.
    await recovered.recordCompleted({
      turnId,
      replyId: REPLY_ID,
      assistantMessageId: 'msg-9',
      route: 'direct-provider',
    })
    assert.deepEqual(journalRevisions(fixture.journalPath), [1, 2, 3])
  } finally {
    await fixture.cleanup()
  }
})

test('cancellation is a distinct terminal state, not a provider failure', async () => {
  const fixture = await makeFixture()
  const turnId = randomUUID()
  try {
    const recorder = await fixture.recorder()
    await recorder.recordStarted(startedInput(turnId))
    await recorder.recordCancelled({
      turnId,
      replyId: REPLY_ID,
      phase: 'provider-request',
    })

    const summary = await recorder.readSummary()
    assert.equal(summary?.state, 'cancelled')
    assert.equal(summary?.failure, undefined)
    assert.deepEqual(journalRevisions(fixture.journalPath), [1, 2])
  } finally {
    await fixture.cleanup()
  }
})

test('a failure before preparation records its identity and claims no reply', async () => {
  const fixture = await makeFixture()
  const turnId = randomUUID()
  try {
    const recorder = await fixture.recorder()
    await recorder.recordStarted(startedInput(turnId))
    await recorder.recordFailed({
      turnId,
      replyId: REPLY_ID,
      failure: {
        layer: 'chat-persistence',
        phase: 'assistant-persistence',
        serviceCode: 'internal',
        retryable: false,
      },
    })

    const summary = await recorder.readSummary()
    assert.equal(summary?.state, 'failed')
    assert.equal(summary?.assistantMessageId, undefined)
    assert.equal(summary?.failure?.serviceCode, 'internal')
  } finally {
    await fixture.cleanup()
  }
})
