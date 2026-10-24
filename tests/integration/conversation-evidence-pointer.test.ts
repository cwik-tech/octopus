/**
 * A pointer to evidence has to point at evidence.
 *
 * A published reply carries `conversation`, which names the activity journal
 * holding that turn's lifecycle. Its whole purpose is to be followed: an
 * operator reading a transcript line uses it to open the record of how that
 * reply came to exist.
 *
 * So it may only be written when the record exists. A build with journalling
 * switched off records nothing, and a reply that still carries the pointer
 * sends every reader to an activity that was never created — a durable claim
 * about evidence, made by the one component that knew there was none.
 *
 * The turn's own identity is a different thing and stays either way. A
 * transcript line names its turn and its source so a reload can group the
 * conversation, and none of that claims a journal exists.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { initProviders } from '../../providers/index.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startDeterministicOpenAiServer } from '../electron/support/deterministic-openai-server.js'

initProviders()

const CASE_TIMEOUT_MS = 20_000

function decision(message: string): string {
  return JSON.stringify({
    message,
    selectionAction: 'clear',
    workflowId: null,
    launchIntent: 'none',
    deepResearchPlanAction: 'keep',
    deepResearchMissingInputs: [],
  })
}

/** The durable lines, guarded rather than asserted into a shape. */
function transcriptLines(
  workspacePath: string,
  sessionId: string,
): Record<string, unknown>[] {
  const chatPath = path.join(workspacePath, 'sessions', sessionId, 'chat.jsonl')
  return fs
    .readFileSync(chatPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      assert.ok(
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
        `a transcript line is not an object: ${line}`,
      )
      return { ...parsed }
    })
}

/**
 * Run one turn through the real loopback API and return where it landed.
 *
 * `journalMode` is the only difference between the two cases, which is what
 * makes the pointer's presence attributable to it and nothing else.
 */
async function runOneTurn(input: {
  readonly prefix: string
  readonly journalMode: 'authoritative' | 'disabled'
  readonly assert: (context: {
    readonly workspacePath: string
    readonly sessionId: string
    readonly turnId: string
    readonly assistant: Record<string, unknown>
  }) => void
}): Promise<void> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), input.prefix)),
  )
  const workspacePath = path.join(directory, 'workspace')
  const projectRoot = path.join(directory, 'project')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })

  const previousKey = process.env.OPENAI_API_KEY
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  const previousGeneratorUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  const previousJournal = process.env.PIPELINE_DURABLE_JOURNAL
  process.env.OPENAI_API_KEY = 'pointer-key'
  if (input.journalMode === 'disabled') {
    process.env.PIPELINE_DURABLE_JOURNAL = 'disabled'
  } else {
    delete process.env.PIPELINE_DURABLE_JOURNAL
  }

  const provider = await startDeterministicOpenAiServer({
    script: [{ text: decision('here is the answer') }],
  })
  process.env.OPENAI_BASE_URL = provider.baseUrl
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `${provider.baseUrl}/chat/completions`

  let server: StartedApiServer | undefined
  try {
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore: new FileSystemSessionStore(workspacePath),
      repoRootPath: projectRoot,
      workspacePath,
    })

    const created = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `pointer ${input.journalMode}` }),
    })
    assert.equal(created.status, 201, await created.clone().text())
    const sessionId = (await created.json() as { id: string }).id

    const turnId = randomUUID()
    const posted = await fetch(`${server.url}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'point me at the evidence',
        provider: 'openai',
        model: 'test-model',
        turnId,
      }),
    })
    assert.equal(posted.status, 201, await posted.clone().text())

    const lines = transcriptLines(workspacePath, sessionId)
    const assistant = lines.find((line) => line['role'] === 'assistant')
    assert.ok(assistant, 'the reply is durable')

    // The turn's identity is the same either way, and this is the half that
    // must not move: a reload groups the conversation from it.
    assert.equal(assistant['schemaVersion'], 2)
    assert.equal(assistant['kind'], 'chat')
    assert.deepEqual(assistant['source'], { kind: 'conversation-turn', turnId })
    assert.equal(assistant['turnId'], turnId)
    assert.equal(assistant['conversationId'], sessionId)

    input.assert({ workspacePath, sessionId, turnId, assistant })
  } finally {
    await server?.close()
    await provider.close()
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previousBaseUrl
    if (previousGeneratorUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    } else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousGeneratorUrl
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousJournal === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
    else process.env.PIPELINE_DURABLE_JOURNAL = previousJournal
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test(
  'an authoritative build points a published reply at its own activity journal',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    await runOneTurn({
      prefix: 'pointer-authoritative-',
      journalMode: 'authoritative',
      assert: ({ workspacePath, sessionId, turnId, assistant }) => {
        assert.deepEqual(
          assistant['conversation'],
          { conversationId: sessionId, activityId: turnId, turnId },
          'the reply names the activity that holds its lifecycle',
        )
        // And what it names is there, which is the only thing that makes the
        // pointer worth writing.
        assert.equal(
          fs.existsSync(
            path.join(
              workspacePath,
              'sessions',
              sessionId,
              CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
              turnId,
              '.runtime',
              'execution-journal',
              'journal.jsonl',
            ),
          ),
          true,
        )
      },
    })
  },
)

test(
  'a build that records nothing does not point a reply at a journal',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    await runOneTurn({
      prefix: 'pointer-disabled-',
      journalMode: 'disabled',
      assert: ({ workspacePath, sessionId, assistant }) => {
        assert.equal(
          Object.hasOwn(assistant, 'conversation'),
          false,
          'a reply with no lifecycle behind it must not claim to have one',
        )
        assert.equal(
          fs.existsSync(
            path.join(
              workspacePath,
              'sessions',
              sessionId,
              CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
            ),
          ),
          false,
          'there is no activity for a pointer to have named',
        )
      },
    })
  },
)
