/**
 * The desktop journey the incident actually produced.
 *
 * A selected-agent turn was interrupted: the transcript kept the question, no
 * reply was ever written, and both journals were left mid-flight. Reopening
 * that session showed the question and nothing under it — indistinguishable
 * from an agent still thinking, for as long as anybody cared to wait.
 *
 * This drives the whole stack the user touches. The workspace is seeded with
 * exactly what a dead process leaves behind, the desktop is started against
 * it, and the session is opened the way a user opens one. What must appear is
 * a durable "Response interrupted" with a Retry, and what Retry must do is
 * start a *new* turn — one provider request, under an identity the abandoned
 * turn never had.
 *
 * Only the renderer-to-API journey is asserted here. Which journal event was
 * appended, and what the outcome contract looks like on the wire, belong to
 * the integration tests that can say so precisely.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { resolveAgentTurnJournalRecorder } from '../../services/agent-turn-journal-recorder.js'
import { resolveConversationTurnJournalRecorder } from '../../services/conversation-turn-journal-recorder.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const CONNECTION_ID = '22222222-3333-4444-5555-666666666666'
const MODEL_ID = 'fake/recovery'
const QUESTION = 'Find me the TripAdvisor listing.'
const RETRY_ANSWER = 'Here is the listing you asked for.'

async function seedProviderSettings(
  userDataPath: string,
  baseUrl: string,
): Promise<void> {
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.writeFile(
    path.join(userDataPath, 'provider-settings.json'),
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: CONNECTION_ID,
          // Keyless LM Studio: the native tool route every Agent chat turn
          // takes refuses a keyless OpenAI-compatible connection.
          kind: 'lm-studio',
          name: 'Fake recovery provider',
          baseUrl: `${baseUrl}/v1`,
          enabled: true,
          status: 'connected',
          models: [
            {
              id: MODEL_ID,
              name: 'Fake Recovery',
              enabled: true,
              capabilities: ['chat'],
            },
          ],
        },
      ],
      cliEnabled: {},
      cliModelEnabled: {},
      defaultModel: { provider: `connection:${CONNECTION_ID}`, model: MODEL_ID },
    }),
    'utf8',
  )
}

/**
 * Write what a process that died mid-provider leaves on disk.
 *
 * Through the real recorders, so this is the state the product produces rather
 * than a hand-made approximation of it: the turn is admitted, both journals
 * say it began, the reply it meant to publish is named, and then nothing.
 */
async function seedAbandonedTurn(input: {
  readonly workspacePath: string
  readonly sessionId: string
}): Promise<string> {
  const turnId = randomUUID()
  const assignmentId = randomUUID()
  const assistantMessageId = `${turnId}:assistant:0`
  const owner = {
    kind: 'run-session' as const,
    conversationId: input.sessionId,
    sessionId: input.sessionId,
  }
  await fs.mkdir(
    path.join(
      input.workspacePath,
      'sessions',
      input.sessionId,
      'runs',
      turnId,
      'assignments',
      assignmentId,
    ),
    { recursive: true },
  )
  const conversationRegistry = new WorkspaceConversationJournalRegistry({
    workspacePath: input.workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const executionRegistry = new WorkspaceExecutionJournalRegistry({
    workspacePath: input.workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  try {
    const conversation = await resolveConversationTurnJournalRecorder({
      registry: conversationRegistry,
      owner,
      turnId,
      workspacePath: input.workspacePath,
    })
    if (!conversation) throw new Error('the conversation journal is not enrolled')
    await conversation.recordStarted({
      surface: 'run-selected-agents',
      userMessageId: `${turnId}:user`,
      requestDigest: 'd'.repeat(64),
      expectedResponseCount: 1,
      origin: 'client',
    })
    await conversation.recordPrepared({
      assistantMessageIds: [assistantMessageId],
      assignments: [{ assignmentId, assistantMessageId }],
    })
    const agentTurn = await resolveAgentTurnJournalRecorder({
      registry: executionRegistry,
      scope: { sessionId: input.sessionId, runId: turnId, assignmentId },
      agentPath: 'agents/scout',
      requestId: randomUUID(),
      processIdentity: 'abandoned-process',
    })
    if (!agentTurn) throw new Error('the assignment journal is not enrolled')
    await agentTurn.recordStarted({
      turnId,
      replyId: 'scout:0',
      speakerOrdinal: 0,
      agentPath: 'agents/scout',
    })
    await agentTurn.release()
    await conversation.release()
  } finally {
    await conversationRegistry.close()
    await executionRegistry.close()
  }
  return turnId
}

test('an interrupted turn is visible on reopen and retried as a new turn', async ({}, testInfo) => {
  test.setTimeout(180_000)

  // The desktop probes a configured connection's health on startup, so not
  // every request this server sees is a turn. The scripted answer is claimed
  // by predicate rather than by position, so a probe cannot consume it, and
  // the counts below are taken over the same predicate — which makes them
  // statements about how many times *scout* was invoked rather than about how
  // much traffic the fixture saw.
  const isScoutTurn = (request: { readonly userMessage: string | undefined }) =>
    request.userMessage?.includes(QUESTION) === true
  // An answered chat turn is two requests: a buffered tool-capable round, whose
  // answer is discarded, and the streamed tool-free request whose answer is
  // shown. Each is claimed by its own shape.
  const provider = await startFakeChatCompletionsServer({
    script: [
      { content: RETRY_ANSWER, match: (request) => isScoutTurn(request) && !request.stream },
      {
        content: RETRY_ANSWER,
        deltas: [RETRY_ANSWER],
        match: (request) => isScoutTurn(request) && request.stream,
      },
    ],
  })
  const scoutTurns = () => provider.requests.filter(isScoutTurn)
  /** One attempt is one buffered round; its streamed answer is counted apart. */
  const scoutAttempts = () => scoutTurns().filter((request) => !request.stream)
  const scoutAnswers = () => scoutTurns().filter((request) => request.stream)
  const workspacePath = testInfo.outputPath('recovery-workspace')
  const projectRoot = testInfo.outputPath('recovery-project')
  const userDataPath = testInfo.outputPath('recovery-user-data')

  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs
      .mkdir(path.join(projectRoot, 'agents', 'scout'), { recursive: true })
      .then(() =>
        fs.writeFile(
          path.join(projectRoot, 'agents', 'scout', 'scout.md'),
          [
            '---',
            'name: scout',
            'description: Recovery journey fixture agent.',
            'tier: strategic',
            `provider: connection:${CONNECTION_ID}`,
            `model: ${MODEL_ID}`,
            'thinking: low',
            '---',
            '',
            '# scout',
            '',
            'Answer the question.',
            '',
          ].join('\n'),
          'utf8',
        ),
      ),
    seedProviderSettings(userDataPath, provider.url),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Recovery Journey' })
  const abandonedTurnId = await seedAbandonedTurn({
    workspacePath,
    sessionId: session.id,
  })
  await sessionStore.appendChatMessageIfAbsent(session.id, {
    id: `${abandonedTurnId}:user`,
    role: 'user',
    text: QUESTION,
    createdAt: '2026-08-31T09:00:00.000Z',
    turnId: abandonedTurnId,
    turnRequest: { fingerprint: 'abandoned', expectedReplies: 1 },
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page
      .getByRole('button', { name: /^Recovery Journey\b/ })
      .first()
      .click()

    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByText(QUESTION)).toBeVisible({ timeout: 60_000 })

    // The durable outcome, reached the way a user reaches it: by opening the
    // session. Nothing in this process ran the abandoned turn.
    await expect(chat.getByText(/Response interrupted/i)).toBeVisible({
      timeout: 60_000,
    })

    // Nothing was retried on the user's behalf while they were reading it.
    expect(scoutTurns()).toHaveLength(0)

    // The route answers only after it has stored the turn's reply, so its
    // response is when the transcript can be read.
    const retried = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/sessions/${session.id}/messages`),
    )
    await chat.getByRole('button', { name: /Retry/i }).click()

    // The retry really did reach the provider, and the answer it produced is
    // on screen under the same question.
    await expect(chat.getByText(RETRY_ANSWER)).toBeVisible({ timeout: 60_000 })

    // Exactly one, so a retry cannot quietly become two attempts — and so the
    // abandoned turn is still proven never to have been run.
    expect(scoutAttempts()).toHaveLength(1)
    expect(scoutAnswers()).toHaveLength(1)

    // And it went to the agent the interrupted turn was addressed to. The
    // selection on screen after a reopen is not that agent, so a retry routed
    // from the screen rather than from the record would reach somebody else
    // while still producing an answer — which is why the recipient is asserted
    // and not merely the fact that somebody answered.
    expect(scoutTurns()[0]?.systemPrompt).toContain('scout')

    // The retry's own answer: 201 for a new turn (a replay answers 200), and
    // sent only once the reply is stored, so the transcript read below has it.
    expect((await retried).status()).toBe(201)

    // A new turn, not a replay of the abandoned one. The transcript is the
    // authority: a second user message, under a turn identity the interrupted
    // turn never had.
    const messages = await sessionStore.listChatMessages(session.id)
    const askedTurnIds = messages
      .filter((message) => message.role === 'user')
      .map((message) => message.turnId)
    expect(askedTurnIds).toHaveLength(2)
    // Asserted as a real identity, not merely as "different": an absent turn
    // id also differs from the abandoned one, and would pass a comparison
    // while proving nothing about what was sent.
    expect(typeof askedTurnIds[1]).toBe('string')
    expect(askedTurnIds[1]).not.toBe('')
    expect(askedTurnIds[1]).not.toBe(abandonedTurnId)

    const answered = messages.filter((message) => message.role === 'assistant')
    expect(answered).toHaveLength(1)
    expect(answered[0]?.turnId).toBe(askedTurnIds[1])
  } finally {
    await app.close()
    await provider.close()
  }
})
