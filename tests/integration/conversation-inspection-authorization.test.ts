/**
 * Who may look at a conversation's lifecycle, decided before anything is read.
 *
 * The report is content-free, but it is not fact-free: it says whether a
 * conversation exists, how many activities it holds, and how each turn ended.
 * A caller who is not allowed to see that must not learn it by inference
 * either, so the refusal has to happen before the workspace is touched — a
 * `not_found` for one session id and a `403` for another is an existence
 * oracle wearing a refusal's clothes.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { ConversationJournalInspectionService } from '../../services/conversation-journal-inspection.js'
import {
  ExecutionJournalAuthorizationError,
  type ExecutionJournalInspectionAuthority,
} from '../../services/execution-journal-inspection.js'
import { TRANSPORT_AUTHENTICATED_JOURNAL_AUTHORITY } from '../../server/composition.js'
import { handleExecutionJournalRoutes } from '../../server/routes/execution-journals.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'

const CASE_TIMEOUT_MS = 20_000

/** A workspace holding one real conversation with one real activity. */
function makeWorkspace(prefix: string) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(
    path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      randomUUID(),
    ),
    { recursive: true },
  )
  return { directory, workspacePath, sessionId }
}

const denyAll: ExecutionJournalInspectionAuthority = {
  authorize: async () => false,
}

test(
  'a denied inspection is refused without telling the caller the conversation exists',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('inspect-denied-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        registry,
        authority: denyAll,
      })
      // The same refusal for a conversation that is really there and one that
      // never existed. Any difference between them is the fact the refusal was
      // supposed to withhold.
      for (const [label, id] of [
        ['a conversation that exists', sessionId],
        ['a conversation that does not', randomUUID()],
      ] as const) {
        await assert.rejects(
          inspection.inspectRunSession({ sessionId: id }),
          (error: unknown) => {
            assert.ok(
              error instanceof ExecutionJournalAuthorizationError,
              `${label} must be refused, saw ${String(error)}`,
            )
            return true
          },
        )
      }
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'an inspection is authorized against the conversation it names',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('inspect-scope-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      // A policy is only as good as what it is handed. An authority asked
      // "may someone inspect something?" cannot decide anything.
      const asked: unknown[] = []
      const inspection = new ConversationJournalInspectionService({
        workspacePath,
        registry,
        authority: {
          authorize: async (input) => {
            asked.push(input)
            return true
          },
        },
      })
      const outcome = await inspection.inspectRunSession({
        sessionId,
        credentialScope: 'full',
      })
      assert.equal(outcome.kind, 'report')
      assert.deepEqual(asked, [
        {
          action: 'inspect',
          conversationScope: { ownerKind: 'run-session', conversationId: sessionId },
          credentialScope: 'full',
        },
      ])
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'the credential a worker holds cannot read conversation lifecycle',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // `broker` is the narrower credential a worker carries so it can reach the
    // credential broker. Lifecycle reports are not its business, and the
    // transport already refuses it every route but provider-execute — this is
    // the same rule, stated where the read happens.
    const scope = {
      action: 'inspect',
      conversationScope: { ownerKind: 'run-session', conversationId: randomUUID() },
    } as const
    assert.equal(
      await TRANSPORT_AUTHENTICATED_JOURNAL_AUTHORITY.authorize({
        ...scope,
        credentialScope: 'broker',
      }),
      false,
    )
    assert.equal(
      await TRANSPORT_AUTHENTICATED_JOURNAL_AUTHORITY.authorize({
        ...scope,
        credentialScope: 'full',
      }),
      true,
    )
    // A server started with no token authenticates nobody, and the loopback
    // path token is then the whole boundary.
    assert.equal(
      await TRANSPORT_AUTHENTICATED_JOURNAL_AUTHORITY.authorize(scope),
      true,
    )
  },
)

test(
  'the operator route answers a refused conversation read with 403 and nothing else',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace('inspect-route-')
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    const inspection = new ConversationJournalInspectionService({
      workspacePath,
      registry,
      authority: denyAll,
    })
    const server = http.createServer((request, response) => {
      void handleExecutionJournalRoutes({
        req: request,
        res: response,
        url: new URL(request.url ?? '/', 'http://127.0.0.1'),
        conversations: inspection,
        credentialScope: 'full',
      }).then((handled) => {
        if (!handled) {
          response.writeHead(404)
          response.end()
        }
      })
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const base = `http://127.0.0.1:${address.port}/execution-journals/conversation/run-session`

      const answers: { status: number; body: string }[] = []
      for (const id of [sessionId, randomUUID()]) {
        const response = await fetch(`${base}/${id}`)
        answers.push({ status: response.status, body: await response.text() })
      }
      assert.deepEqual(
        answers.map((answer) => answer.status),
        [403, 403],
      )
      assert.equal(
        answers[0]?.body,
        answers[1]?.body,
        'a body that differs is the existence answer the refusal withheld',
      )
      assert.equal(
        answers[0]?.body.includes(sessionId),
        false,
        'and the refusal does not echo the conversation back',
      )
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
