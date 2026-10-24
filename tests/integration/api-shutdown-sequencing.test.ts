import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import type { FileParserLauncher } from '../../core/file-parser-launcher.js'
import { parseFileNotExpected } from '../support/file-parser-launcher-doubles.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  createGracefulShutdown,
  startApiServer,
} from '../../server/api-server.js'

/**
 * AC18, Journey A: graceful shutdown must not destroy work it is still
 * allowed to finish.
 *
 * Shutdown used to run the HTTP teardown and the composition dispose
 * concurrently and destroy every connection immediately, so a request that
 * was mid-handler lost its socket and had the services under it disposed
 * while it was still allowed to run. `closeServerAndComposition` now stops
 * accepting, drains within one deadline, and only then destroys.
 *
 * The route held here is the project file upload. It awaits an injected
 * collaborator before writing anything —
 * `await fileParserLauncher.parseDirectory(filesDir)` in
 * `server/routes/projects.ts` — and writes its response only after that
 * returns, while holding a file-mutation lock over state it has already
 * changed. That makes it a real in-flight application handler rather than a
 * trivial read, and it is gated through a normal composition option rather
 * than any test-only seam.
 */

/** Every request carries its own bound; nothing here waits indefinitely. */
const REQUEST_TIMEOUT_MS = 10_000

function makeWorkspace(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'api-shutdown-')),
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => {
    resolve = () => settle()
  })
  return { promise, resolve }
}

/**
 * Response bodies cross a process boundary, so they arrive as `unknown` and
 * are narrowed rather than asserted into shape. Destructuring after an `in`
 * check narrows without a type assertion.
 */
function readIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value)) {
    return undefined
  }
  const { id } = value
  return typeof id === 'string' ? id : undefined
}

function readName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('name' in value)) {
    return undefined
  }
  const { name } = value
  return typeof name === 'string' ? name : undefined
}

/** A parser the test can hold open, injected the way production injects one. */
function gatedFileParserLauncher(gate: {
  readonly entered: { resolve: () => void }
  readonly release: Promise<void>
}): FileParserLauncher {
  return {
    parseDirectory: async () => {
      gate.entered.resolve()
      await gate.release
    },
    parseFile: parseFileNotExpected,
  }
}

test('shutdown lets an in-flight request finish and refuses new connections', {
  timeout: 30_000,
}, async (t) => {
  const workspacePath = makeWorkspace()
  const parseEntered = deferred()
  const releaseParse = deferred()
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 0, cwd: '' }
      },
    },
    sessionStore: new FileSystemSessionStore(workspacePath),
    fileParserLauncher: gatedFileParserLauncher({
      entered: parseEntered,
      release: releaseParse.promise,
    }),
    workspacePath,
  })
  let closed = false
  t.after(async () => {
    releaseParse.resolve()
    if (!closed) await server.close().catch(() => undefined)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  })

  const created = await fetch(`${server.url}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Shutdown sequencing' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const createdBody = await created.text()
  assert.equal(created.status, 201, createdBody)
  const projectId = readIdentifier(JSON.parse(createdBody))
  assert.ok(projectId, `the created project must carry an id: ${createdBody}`)

  // A real upload, held inside the handler by the injected parser.
  const upload = fetch(`${server.url}/projects/${projectId}/files`, {
    method: 'POST',
    headers: { 'x-filename': 'notes.md', 'content-type': 'text/markdown' },
    body: '# Notes\n',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  await parseEntered.promise

  // Shutdown begins while that handler is still running.
  const closing = server.close().then(() => {
    closed = true
  })

  // New work is refused from the moment shutdown starts.
  await assert.rejects(
    fetch(`${server.url}/projects`, {
      // Bounded well below the shutdown deadline: the listener is already
      // closed, so this can only fail — the bound exists so a regression that
      // kept accepting fails here instead of hanging the run.
      signal: AbortSignal.timeout(750),
    }),
    'a listener that has begun shutting down must not accept new connections',
  )

  // Close is still waiting. Preserving the socket is only half the contract:
  // shutdown must also not report itself finished while a handler it is
  // letting run has not returned.
  await new Promise((settle) => setImmediate(settle))
  await new Promise((settle) => setImmediate(settle))
  assert.equal(
    closed,
    false,
    'close must not resolve while the in-flight handler is still running',
  )

  // The in-flight request is allowed to finish, and finishes truthfully.
  releaseParse.resolve()
  const uploaded = await upload
  assert.equal(
    uploaded.status,
    201,
    `the in-flight request must complete: ${uploaded.status}`,
  )
  const uploadedBody = await uploaded.text()
  assert.equal(
    readName(JSON.parse(uploadedBody)),
    'notes.md',
    `and return the file it actually saved: ${uploadedBody}`,
  )

  await closing
  assert.equal(closed, true, 'and close resolves only once it has')
})

/**
 * AC18: the shutdown a process actually calls, rather than the sequence in
 * isolation.
 *
 * Three properties that only hold together. Both doors into the process shut
 * at the same moment, before anything the running handlers depend on is
 * taken away. The drain and the disposal share one absolute window, so a
 * shutdown bounded at N ms cannot spend 2N. And a shutdown that failed can be
 * tried again — the fault may be transient, and a process that could only
 * ever attempt one close would be stuck with its first bad outcome — without
 * re-closing a listener that is already down, which would report
 * `ERR_SERVER_NOT_RUNNING` and mask the disposal that still has to happen.
 */

/** A listening server on an ephemeral loopback port. */
async function listeningServer(
  handler: http.RequestListener,
): Promise<http.Server> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return server
}

/**
 * A loopback port nothing is listening on.
 *
 * Taken by binding and releasing, so the number is one the OS just handed
 * out rather than a guess that might collide with something already running.
 */
async function freePort(): Promise<number> {
  const probe = await listeningServer(() => undefined)
  const address = probe.address()
  assert.ok(address && typeof address !== 'string', 'probe must be listening')
  const { port } = address
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** Whether the port can be bound again — that is, nothing holds it. */
async function portIsFree(port: number): Promise<boolean> {
  const probe = http.createServer(() => undefined)
  const bound = await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => resolve(true))
  })
  if (bound) await new Promise<void>((resolve) => probe.close(() => resolve()))
  return bound
}

function serverUrl(server: http.Server): string {
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'server must be listening')
  return `http://127.0.0.1:${address.port}`
}

test('shutdown bars new work first, then drains and disposes inside one window', {
  timeout: 30_000,
}, async (t) => {
  const handlerEntered = deferred()
  const holdHandler = deferred()
  let heldSocket: import('node:net').Socket | undefined
  const server = await listeningServer((request, response) => {
    // Never answered. The connection stays active, so the listener cannot
    // finish closing and the drain has to run out its window — which is what
    // makes the deadline observable rather than instantaneous.
    heldSocket = request.socket
    handlerEntered.resolve()
    void holdHandler.promise.then(() => response.end())
  })
  t.after(() => {
    holdHandler.resolve()
    if (server.listening) server.close()
  })

  const calls: string[] = []
  let disposeDeadlineMs: number | undefined
  let socketDestroyedAtDispose: boolean | undefined
  const shutdownDeadlineMs = 250
  const close = createGracefulShutdown({
    server,
    composition: {
      beginShutdown: () => {
        calls.push('beginShutdown')
      },
      dispose: async (options) => {
        calls.push('dispose')
        disposeDeadlineMs = options?.deadlineMs
        // Read synchronously on entry: `destroy()` marks a socket destroyed
        // before it yields, so this is the state of the connection at the
        // moment disposal begins, not some later settled value.
        socketDestroyedAtDispose = heldSocket?.destroyed
      },
    },
    shutdownDeadlineMs,
  })

  // A request that is mid-handler when shutdown starts. Its socket is
  // destroyed at the end of the window, so the client sees a failure — the
  // bound is what this test is about, not the response.
  const inFlight = fetch(serverUrl(server), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).then(
    () => undefined,
    () => undefined,
  )
  // Shutdown must begin with that request genuinely in the handler. Starting
  // it before the connection exists would let the listener close instantly,
  // and the deadline assertions below would then hold for a fresh window as
  // easily as for a shared one.
  await handlerEntered.promise

  const startedAt = Date.now()
  // Two callers, one shutdown: a second caller must join the attempt in
  // flight rather than start a competing one.
  await Promise.all([close(), close()])
  await inFlight

  assert.deepEqual(
    calls,
    ['beginShutdown', 'dispose'],
    'new work is barred before anything the handlers use is disposed, and ' +
      'concurrent callers share one shutdown',
  )
  // The order is stop, drain, destroy, dispose. Ending a socket does not stop
  // handler code that is already running — nothing does — so what is pinned
  // here is which of the two forced teardowns happens first, not the absence
  // of a straggler: the transport is taken down before the services beneath
  // it, rather than the process disposing services while their transport is
  // still live.
  assert.equal(
    socketDestroyedAtDispose,
    true,
    'a connection that outlived the drain must be ended before the services ' +
      'beneath it are disposed',
  )
  assert.ok(
    disposeDeadlineMs !== undefined,
    'disposal is given the shutdown window rather than left unbounded',
  )
  assert.ok(
    disposeDeadlineMs >= startedAt + shutdownDeadlineMs &&
      disposeDeadlineMs < startedAt + shutdownDeadlineMs * 2,
    'and it is the same absolute deadline the drain used, not a fresh ' +
      `window opened after the drain: ${String(disposeDeadlineMs)} vs ` +
      `${String(startedAt)}`,
  )
  assert.equal(server.listening, false, 'the listener is down')
})

test('a shutdown window that is not a positive duration is refused', {
  timeout: 30_000,
}, async (t) => {
  const server = await listeningServer((_request, response) => response.end())
  t.after(() => {
    if (server.listening) server.close()
  })
  const composition = {
    beginShutdown: () => undefined,
    dispose: async () => undefined,
  }

  // This is a public entry point in its own right, so it cannot lean on the
  // validation `startApiServer` runs over its options: a caller that builds a
  // shutdown directly reaches this code without passing through them.
  //
  // Rejected rather than coerced. The window is the only thing standing
  // between a drain and a process that never exits, so substituting a default
  // for a bad value would hide the misconfiguration until it mattered.
  for (const shutdownDeadlineMs of [Number.NaN, Infinity, -Infinity, 0, -1]) {
    assert.throws(
      () =>
        createGracefulShutdown({ server, composition, shutdownDeadlineMs }),
      /shutdownDeadlineMs/,
      `a shutdown window of ${String(shutdownDeadlineMs)} must be refused`,
    )
  }

  // An omitted window is not a bad one: it means "use the default".
  assert.doesNotThrow(() => createGracefulShutdown({ server, composition }))

  // And the server enforces the same rule before it binds anything, so a bad
  // configuration cannot leave a listening socket behind to be cleaned up.
  const workspacePath = makeWorkspace()
  t.after(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  })
  const port = await freePort()
  const outcome = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 0, cwd: '' }
      },
    },
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
    port,
    shutdownDeadlineMs: 0,
  }).then(
    async (unexpected) => {
      // A start that should have been refused still bound a listener. Close
      // it before failing: a stranded listening socket keeps the whole test
      // process alive, which would turn this assertion into a hang.
      await unexpected.close().catch(() => undefined)
      return 'started'
    },
    (error: unknown) => String(error),
  )
  assert.match(
    outcome,
    /shutdownDeadlineMs/,
    'the option is refused at configuration time, not at shutdown time',
  )

  // And refused early enough that nothing was bound. A validation that ran
  // only while the handle was being assembled would throw after `listen` had
  // already succeeded, abandoning a socket with no handle to close it by —
  // so the port it was given must still be free.
  assert.equal(
    await portIsFree(port),
    true,
    'a refused configuration must not leave a listener behind',
  )
})

test('a failed shutdown is retryable and never closes the listener twice', {
  timeout: 30_000,
}, async (t) => {
  const server = await listeningServer((_request, response) => response.end())
  t.after(() => {
    if (server.listening) server.close()
  })

  let disposeCalls = 0
  const close = createGracefulShutdown({
    server,
    composition: {
      beginShutdown: () => undefined,
      dispose: async () => {
        disposeCalls += 1
        if (disposeCalls === 1) throw new Error('journal registry close failed')
      },
    },
    shutdownDeadlineMs: 250,
  })

  await assert.rejects(
    close(),
    'a disposal that failed must reach whoever is shutting the process down',
  )
  assert.equal(server.listening, false, 'the listener still came down')

  await close()
  assert.equal(
    disposeCalls,
    2,
    'the retry re-runs the disposal that failed rather than re-reporting a ' +
      'listener that is already closed',
  )

  await close()
  assert.equal(
    disposeCalls,
    2,
    'and a shutdown that already succeeded is not run a second time',
  )
})
