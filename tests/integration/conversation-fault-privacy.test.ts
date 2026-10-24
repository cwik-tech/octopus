/**
 * A fault is a fact about the turn, never a copy of what caused it.
 *
 * The things that go wrong here carry text nobody chose to publish: an errno
 * message names an absolute path, a provider error can quote a response body, a
 * cause can carry a token in its `code`. Every one of those was reaching a
 * caller — the admission error embedded the raw reason, the API handler sent the
 * message straight out, the retention warning logged it, and the fault
 * classifier turned any short string into a structured code.
 *
 * What an operator needs is which turn, which stage, and which of a fixed set of
 * faults. That is all any of these paths may say.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { CONVERSATION_ACTIVITIES_DIRECTORY_NAME } from '../../core/conversation-activity-location.js'
import { reserveConversationActivity } from '../../services/conversation-admission-reservation.js'
import {
  ConversationAdmissionError,
  resolveConversationTurnJournalRecorder,
} from '../../services/conversation-turn-journal-recorder.js'
import { Buffer } from 'node:buffer'
import { writeRetentionDocument } from '../../services/conversation-terminal-ledger.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import { writeBulkTerminalActivities } from '../support/bulk-conversation-activities.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  runSessionMessageTurn,
  type ConversationTurnDiagnostic,
} from '../../services/session-service.js'

const CASE_TIMEOUT_MS = 15_000

/**
 * Distinctive enough that finding it anywhere proves raw text travelled. It is
 * planted in the workspace path, so every errno message about this workspace
 * quotes it.
 */
const SENTINEL = 'zzq-secret-9f2c'
/** One sentinel per channel a fault can travel down, so a leak names itself. */
const MESSAGE_SENTINEL = 'zzq-message-a1b2'
const CODE_SENTINEL = 'zzqCodeC3D4'
const NAME_SENTINEL = 'zzqNameE5F6'

/**
 * Nothing anywhere under the workspace quotes a fault.
 *
 * The whole tree, not the journal file: a conversation's durable state is
 * spread across manifests, sidecars and retention records, and a leak that
 * lands in any of them is as permanent as one in the journal itself. The
 * workspace path carries `SENTINEL`, so every errno about this workspace
 * quotes it — which is what makes an absent sentinel evidence rather than
 * luck.
 */
function assertNothingDurableQuotesTheFault(workspacePath: string): void {
  const durable = fs
    .readdirSync(workspacePath, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
    .join('')
  for (const sentinel of [SENTINEL, MESSAGE_SENTINEL, CODE_SENTINEL, NAME_SENTINEL]) {
    assert.equal(
      durable.includes(sentinel),
      false,
      `${sentinel} was written somewhere under the workspace`,
    )
  }
}

/** A workspace with no sessions in it, for the paths that start a real server. */
function makeBareWorkspace() {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `privacy-${SENTINEL}-`)),
  )
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(path.join(workspacePath, 'sessions'), { recursive: true })
  return { directory, workspacePath }
}

function makeWorkspace() {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `privacy-${SENTINEL}-`)),
  )
  const workspacePath = path.join(directory, 'workspace')
  const sessionId = randomUUID()
  fs.mkdirSync(path.join(workspacePath, 'sessions', sessionId), { recursive: true })
  return { directory, workspacePath, sessionId }
}

const owner = (sessionId: string) => ({
  kind: 'run-session' as const,
  conversationId: sessionId,
  sessionId,
})

/** Capture what the process wrote while `body` ran. */
async function captureStderr(body: () => Promise<void>): Promise<string> {
  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  const capture = (chunk: unknown): boolean => {
    written.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }
  Object.defineProperty(process.stderr, 'write', {
    value: capture,
    configurable: true,
    writable: true,
  })
  try {
    await body()
  } finally {
    Object.defineProperty(process.stderr, 'write', {
      value: original,
      configurable: true,
      writable: true,
    })
  }
  return written.join('')
}

test(
  'a refused admission says which turn and nothing about why it broke',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace()
    try {
      // A write this conversation cannot make safely. The failure is real and
      // its message names the absolute path it failed on — which is how the
      // workspace's own name ends up in an answer sent to a caller.
      const root = path.join(
        workspacePath,
        'sessions',
        sessionId,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      )
      fs.mkdirSync(root, { recursive: true })
      fs.symlinkSync(
        path.join(directory, 'elsewhere.json'),
        path.join(root, '.unresolved.json.tmp'),
      )

      const outcome = await reserveConversationActivity({
        workspacePath,
        owner: owner(sessionId),
        turnId: randomUUID(),
      })
      assert.equal(outcome.kind, 'indeterminate')
      assert.equal(
        outcome.kind === 'indeterminate' && outcome.reason.includes(SENTINEL),
        false,
        `the reason quoted the fault verbatim: ${
          outcome.kind === 'indeterminate' ? outcome.reason : ''
        }`,
      )
      assertNothingDurableQuotesTheFault(workspacePath)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'nothing a caller or an operator is shown quotes the fault',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace()
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
    })
    try {
      const root = path.join(
        workspacePath,
        'sessions',
        sessionId,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      )
      fs.mkdirSync(root, { recursive: true })
      fs.symlinkSync(
        path.join(directory, 'elsewhere.json'),
        path.join(root, '.unresolved.json.tmp'),
      )

      let thrown: unknown
      const logged = await captureStderr(async () => {
        thrown = await resolveConversationTurnJournalRecorder({
          registry,
          owner: owner(sessionId),
          turnId: randomUUID(),
          workspacePath,
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
      })

      assert.ok(thrown instanceof ConversationAdmissionError)
      assert.equal(
        thrown.message.includes(SENTINEL),
        false,
        `the error a caller sees quoted the fault: ${thrown.message}`,
      )
      assert.equal(
        logged.includes(SENTINEL),
        false,
        `the process log quoted the fault: ${logged}`,
      )
      assertNothingDurableQuotesTheFault(workspacePath)
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a fault a caller is answered with says nothing about the fault',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeBareWorkspace()
    let server: StartedApiServer | undefined
    try {
      // The whole way out: through the route, through the generic error
      // handler, into a response body a client reads.
      //
      // Planted after startup on purpose. Startup runs its own preflight and
      // fail-closes on this, which is correct and is a different path — the one
      // under test here is a turn arriving at a server that is already up.
      server = await startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore: new FileSystemSessionStore(workspacePath),
        repoRootPath: path.join(directory, 'project'),
        workspacePath,
      })
      const created = await fetch(`${server.url}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'privacy' }),
      })
      const liveSessionId = (await created.json() as { id: string }).id

      // Break the live session's record the same way.
      const liveRoot = path.join(
        workspacePath,
        'sessions',
        liveSessionId,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      )
      fs.mkdirSync(liveRoot, { recursive: true })
      fs.symlinkSync(
        path.join(directory, 'elsewhere-live.json'),
        path.join(liveRoot, '.unresolved.json.tmp'),
      )

      const response = await fetch(
        `${server.url}/sessions/${liveSessionId}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: 'answer me',
            provider: 'openai',
            model: 'test-model',
            turnId: randomUUID(),
          }),
        },
      )
      const body = await response.text()
      assert.notEqual(response.status, 201)
      assert.equal(
        body.includes(SENTINEL),
        false,
        `the response quoted the fault: ${body}`,
      )
      assert.equal(
        body.includes(workspacePath),
        false,
        'and did not name the workspace it failed inside',
      )
    } finally {
      await server?.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test(
  'a diagnostic carries a known fault, not whatever the cause called itself',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath } = makeWorkspace()
    const store = new FileSystemSessionStore(workspacePath)
    try {
      const session = await store.createSession({ title: 'diagnostic privacy' })
      const turnId = randomUUID()
      const diagnostics: ConversationTurnDiagnostic[] = []

      // Three channels, three sentinels. `code` and `name` are set by whoever
      // produced the error — a provider, or something further away than that —
      // so a shape test on them is not a safety test.
      const planted = Object.assign(new Error(MESSAGE_SENTINEL), {
        code: CODE_SENTINEL,
        name: NAME_SENTINEL,
      })
      const chatPath = path.join(workspacePath, 'sessions', session.id, 'chat.jsonl')

      const logged = await captureStderr(async () => {
        await runSessionMessageTurn({
          sessionId: session.id,
          session,
          sessionStore: store,
          text: 'diagnose',
          workflows: [],
          workflowEntries: [],
          turnId,
          conversationRecorder: {
            recordStarted: async () => {
              fs.rmSync(chatPath)
              fs.mkdirSync(chatPath)
            },
            recordPrepared: async () => {},
            recordCompleted: async () => {},
            recordFailed: async () => {
              throw planted
            },
            recordCancelled: async () => {
              throw planted
            },
            readSummary: async () => ({
              turnId,
              state: 'absent' as const,
              assistantMessageIds: [],
            }),
            abandon: async () => {},
      release: async () => {},
          },
          onDiagnostic: (event) => diagnostics.push(event),
        }).catch(() => undefined)
      })

      const divergence = diagnostics.find(
        (event) => event.code === 'terminal_not_recorded',
      )
      assert.ok(divergence, `no diagnostic was produced: ${JSON.stringify(diagnostics)}`)
      assert.equal(
        divergence.fault,
        'unknown',
        'a cause that names itself is not a classification',
      )
      const serialized = JSON.stringify(diagnostics)
      for (const sentinel of [MESSAGE_SENTINEL, CODE_SENTINEL, NAME_SENTINEL]) {
        assert.equal(
          serialized.includes(sentinel),
          false,
          `the diagnostic carried ${sentinel}: ${serialized}`,
        )
        assert.equal(
          logged.includes(sentinel),
          false,
          `the process log carried ${sentinel}`,
        )
      }

      // And nothing durable kept it either.
      assertNothingDurableQuotesTheFault(workspacePath)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)


test(
  'a sweep that cannot delete says so without quoting the reason',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    const { directory, workspacePath, sessionId } = makeWorkspace()
    // The removal itself is what fails. Injected at the registry's own I/O
    // boundary rather than staged with a permission bit: permissions are not
    // enforced for every user, so a bit would make this case quietly stop
    // testing anything on some machines. The fault carries the absolute path,
    // which is exactly what must not reach the log.
    const registry = new WorkspaceConversationJournalRegistry({
      workspacePath,
      tenantId: 'local',
      mode: 'authoritative',
      removeActivityTree: (activityPath) => {
        throw new Error(`EACCES: permission denied, rm '${activityPath}' ${SENTINEL}`)
      },
    })
    const root = path.join(
      workspacePath,
      'sessions',
      sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    )
    try {
      // A finished turn old enough to reclaim. The sweep decides correctly and
      // then cannot carry the decision out, which is the one path that reaches
      // the retention warning.
      const long_ago = Date.parse('2026-01-01T00:00:00.000Z')
      const written = writeBulkTerminalActivities({
        workspacePath,
        sessionId,
        tenantId: 'local',
        count: 1,
        firstTerminalAtMs: long_ago,
      })
      const activityId = written[0]?.activityId ?? ''
      await writeRetentionDocument(root, {
        openTurnIds: new Set(),
        retained: [{ activityId, atMs: long_ago }],
        reconcileCursor: 0,
      })

      // This turn takes its slot before the record is blocked, so the
      // reservation is already held and short-circuits without writing. What
      // is left failing is the sweep's own write, which is the path under test.
      const turnId = randomUUID()
      assert.equal(
        (
          await reserveConversationActivity({
            workspacePath,
            owner: owner(sessionId),
            turnId,
          })
        ).kind,
        'reserved',
      )
      const logged = await captureStderr(async () => {
        await resolveConversationTurnJournalRecorder({
          registry,
          owner: owner(sessionId),
          turnId,
          workspacePath,
        }).catch(() => undefined)
      })

      assert.equal(
        logged.includes('conversation-retention'),
        true,
        `the sweep failure was never reported at all: ${logged}`,
      )
      assert.equal(
        logged.includes(SENTINEL),
        false,
        `the retention warning quoted the fault: ${logged}`,
      )
      assert.equal(
        logged.includes(workspacePath),
        false,
        'and did not name the path it failed on',
      )
      assertNothingDurableQuotesTheFault(workspacePath)
    } finally {
      await registry.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
