/**
 * The incident, reproduced with a real process and a real kill.
 *
 * Every other recovery test seeds the durable state and asks what recovery does
 * with it. That proves the classification and it proves the repair, but it
 * cannot prove the premise: that a composition killed mid-provider actually
 * leaves the record those tests describe. If the real turn left something else
 * behind — an extra event, a terminal written by a shutdown path, no
 * reservation at all — recovery would be correct about a situation that never
 * happens.
 *
 * So this one runs the API server in its own process, sends a selected-agent
 * turn, waits until the provider has genuinely been entered, and `SIGKILL`s it.
 * Nothing gets to clean up. A second server then opens the same workspace the
 * way the desktop would, and the assertions are about what the user gets back.
 *
 * The provider lives in this process, so its request log survives the kill —
 * which is what makes "the abandoned call was never re-run" a fact rather than
 * an assumption.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import {
  conversationRetentionRoot,
  readRetentionDocument,
} from '../../services/conversation-terminal-ledger.js'
import { isConversationTurnOutcome } from '../../contracts/sessions.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'

/**
 * The child, located from this file rather than from the working directory.
 *
 * `tests/fixtures/**` is excluded from the test compile, so the fixture is
 * plain JavaScript in the source tree and is spawned with bare `node`. That is
 * also what this particular child needs: loading it through `--import tsx`
 * would put an esbuild service beside it, and `SIGKILL` — the signal this test
 * exists to send — is exactly the one that leaves such a helper behind.
 *
 * This module runs from `.tests-dist`, so the source tree is two levels above
 * the compiled `tests/` directory it sits in.
 */
const API_CHILD_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'interrupted-chat-api-child.mjs',
)

/** How long the child is given to say it is listening. */
const CHILD_READY_BUDGET_MS = 30_000
/** How long the turn is given to reach the provider. */
const PROVIDER_ENTRY_BUDGET_MS = 60_000

const CONNECTION_ID = '33333333-4444-5555-6666-777777777777'
const MODEL_ID = 'fake/restart'
const QUESTION = 'The question whose answer never arrived.'

function writeAgent(projectRoot: string): void {
  const directory = path.join(projectRoot, 'agents', 'scout')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'scout.md'),
    [
      '---',
      'name: scout',
      'description: Restart journey fixture agent.',
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
  )
}

function writeProviderSettings(storagePath: string, baseUrl: string): void {
  fs.writeFileSync(
    storagePath,
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: CONNECTION_ID,
          kind: 'lm-studio',
          name: 'Restart fixture provider',
          baseUrl: `${baseUrl}/v1`,
          enabled: true,
          status: 'connected',
          models: [
            {
              id: MODEL_ID,
              name: 'Restart Fixture',
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
 * Wait for something, but never forever.
 *
 * Every wait here is on a child process that may have failed in a way this
 * test cannot see. Bounding them is what keeps a fixture fault reported as
 * itself rather than as the whole test timing out with the child still alive.
 */
async function within<T>(
  work: Promise<T>,
  budgetMs: number,
  describe: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${budgetMs}ms: ${describe()}`)),
          budgetMs,
        )
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Kill a child and wait for it to actually be gone. */
async function stopChild(
  child: ChildProcessWithoutNullStreams | undefined,
): Promise<void> {
  if (!child) return
  // Listened for before the kill, and checked again after: a process that had
  // already exited fires nothing, and waiting on an event that will never
  // arrive is how cleanup becomes the hang it was meant to prevent.
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('exit', () => resolve())
  })
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  await exited
}

/**
 * Start the child against the temporary project, and wait for the URL it
 * prints.
 *
 * The project root is the temporary one holding `agents/scout`, not this
 * repository: agent discovery reads it, and pointing the child at the real repo
 * made every turn fail as an unknown agent before the provider was ever
 * reached.
 */
async function startApiChild(input: {
  readonly workspacePath: string
  readonly projectRoot: string
  readonly providerSettingsPath: string
}): Promise<{ child: ChildProcessWithoutNullStreams; url: string }> {
  const child = spawn(
    process.execPath,
    [
      API_CHILD_PATH,
      input.workspacePath,
      input.projectRoot,
      input.providerSettingsPath,
    ],
    { cwd: input.projectRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))

  const url = await within(
    new Promise<string>((resolve, reject) => {
      let buffered = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === '') continue
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            Reflect.get(parsed, 'type') === 'ready'
          ) {
            const ready = Reflect.get(parsed, 'url')
            if (typeof ready === 'string') resolve(ready)
            return
          }
        }
      })
      child.once('exit', (code) =>
        reject(new Error(`the api child exited with ${code}: ${stderr.join('')}`)),
      )
    }),
    CHILD_READY_BUDGET_MS,
    () => `the api child never reported a url: ${stderr.join('')}`,
  ).catch(async (error: unknown) => {
    // Awaited, not fired and forgotten. `startApiChild` never returns on this
    // path, so the caller has no handle to clean up with — and a child still
    // alive while the test removes its workspace turns a readiness failure
    // into a different, less useful one.
    await stopChild(child)
    throw error
  })
  return { child, url }
}

test(
  'a killed api process leaves a turn the next one finishes without re-running it',
  { timeout: 120_000 },
  async () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'interrupted-chat-restart-')),
    )
    const projectRoot = path.join(directory, 'project')
    const workspacePath = path.join(directory, 'workspace')
    const providerSettingsPath = path.join(directory, 'provider-settings.json')
    fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true })
    fs.mkdirSync(workspacePath, { recursive: true })
    writeAgent(projectRoot)

    // The provider is entered and never answers, which is what leaves
    // `agent.turn.started` durable with nothing after it. `match` is the seam
    // that says when that happened — it is consulted once per request, so it
    // reports entry without anything here watching a clock.
    let announceEntered: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      announceEntered = resolve
    })
    const provider = await startFakeChatCompletionsServer({
      script: [
        {
          gate: new Promise<void>(() => {}),
          match: (request) => {
            if (request.userMessage?.includes(QUESTION) !== true) return false
            announceEntered()
            return true
          },
        },
      ],
    })
    writeProviderSettings(providerSettingsPath, provider.url)
    const scoutTurns = () =>
      provider.requests.filter(
        (request) => request.userMessage?.includes(QUESTION) === true,
      )

    let child: ChildProcessWithoutNullStreams | undefined
    let restarted: StartedApiServer | undefined
    try {
      const started = await startApiChild({
        workspacePath,
        projectRoot,
        providerSettingsPath,
      })
      child = started.child

      const sessionResponse = await fetch(`${started.url}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Restart Journey' }),
      })
      assert.equal(sessionResponse.status, 201)
      const session: unknown = await sessionResponse.json()
      const sessionId = Reflect.get(session as object, 'id')
      assert.ok(typeof sessionId === 'string')

      const turnId = randomUUID()
      // Not awaited: this request never comes back, because the process
      // answering it is about to stop existing.
      void fetch(`${started.url}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: QUESTION,
          turnId,
          target: { kind: 'agents', agentNames: ['scout'] },
        }),
      }).catch(() => undefined)

      await within(
        entered,
        PROVIDER_ENTRY_BUDGET_MS,
        () => 'the turn never reached the provider',
      )
      await stopChild(child)
      child = undefined

      assert.equal(
        scoutTurns().length,
        1,
        'the abandoned turn reached the provider exactly once',
      )

      // A second process opens the same workspace, exactly as a restart does.
      restarted = await startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        sessionStore: new FileSystemSessionStore(workspacePath),
        providerSettingsService: new ProviderSettingsService({
          storagePath: providerSettingsPath,
        }),
        repoRootPath: projectRoot,
        workspacePath,
      })

      const reload = await fetch(
        `${restarted.url}/sessions/${sessionId}/messages`,
      )
      assert.equal(reload.status, 200)
      const payload: unknown = await reload.json()
      assert.ok(
        typeof payload === 'object' && payload !== null && !Array.isArray(payload),
      )
      const body: Record<string, unknown> = { ...payload }

      assert.ok(Array.isArray(body.messages))
      assert.equal(
        body.messages.filter(
          (message: unknown) =>
            typeof message === 'object' &&
            message !== null &&
            Reflect.get(message, 'role') === 'assistant',
        ).length,
        0,
        'the killed turn published no reply, and recovery invented none',
      )

      assert.ok(Array.isArray(body.outcomes))
      const outcome: unknown = body.outcomes.find(
        (candidate: unknown) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          Reflect.get(candidate, 'turnId') === turnId,
      )
      assert.ok(
        isConversationTurnOutcome(outcome),
        `the reopened session explains the killed turn: ${JSON.stringify(body.outcomes)}`,
      )
      assert.equal(outcome.state, 'interrupted')
      assert.ok(outcome.retryable, 'the user may ask again')
      assert.deepEqual(
        outcome.agentNames,
        ['scout'],
        'and it still knows who the turn was addressed to',
      )

      const retentionRoot = conversationRetentionRoot({
        workspacePath,
        owner: {
          kind: 'run-session',
          conversationId: sessionId,
          sessionId,
        },
      })
      assert.ok(retentionRoot)
      const stored = await readRetentionDocument(retentionRoot)
      assert.ok(stored !== 'damaged')
      assert.ok(
        !stored.openTurnIds.has(turnId),
        'the killed turn stopped holding an admission slot',
      )

      assert.equal(
        scoutTurns().length,
        1,
        'and recovery asked the provider nothing at all',
      )
    } finally {
      // The child is gone before the directory is: removing a workspace a live
      // process still holds is how a cleanup turns into a different failure.
      await stopChild(child)
      await restarted?.close()
      await provider.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
