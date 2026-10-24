import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { CapabilityExecutionContext } from '../../contracts/capability-dispatch.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'

/**
 * The journal is assignment-scoped while the dispatcher is process-global, so
 * the registry owns one journal per assignment, decides enrollment, and is the
 * single place authority stickiness is enforced (ADR §1, §16).
 */

const TENANT = 'tenant-under-test'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'journal-registry-'))
}

function assignmentPath(
  workspacePath: string,
  sessionId: string,
  runId: string,
  assignmentId: string,
): string {
  return path.join(
    workspacePath,
    'sessions',
    sessionId,
    'runs',
    runId,
    'assignments',
    assignmentId,
  )
}

function makeAssignment(
  workspacePath: string,
  assignmentId = 'assignment-one',
): CapabilityExecutionContext {
  const context: CapabilityExecutionContext = {
    contractVersion: 1,
    requestId: `request-${assignmentId}`,
    sessionId: 'session-one',
    runId: 'run-one',
    assignmentId,
    agentPath: 'agents/probe',
    authority: { kind: 'runtime-assignment', processIdentity: 'probe' },
  }
  fs.mkdirSync(
    assignmentPath(workspacePath, 'session-one', 'run-one', assignmentId),
    { recursive: true },
  )
  return context
}

function resolveInput(context: CapabilityExecutionContext) {
  return {
    context,
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 5_000,
  }
}

test('authoritative mode enrolls an assignment and reuses one journal for it', async () => {
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeAssignment(workspacePath)
    const first = await registry.resolve(resolveInput(context))
    const second = await registry.resolve(resolveInput(context))
    assert.ok(first)
    assert.equal(first, second, 'one assignment must share one journal')

    const other = await registry.resolve(
      resolveInput(makeAssignment(workspacePath, 'assignment-two')),
    )
    assert.ok(other)
    assert.notEqual(first, other, 'separate assignments get separate journals')

    assert.equal(
      fs.existsSync(
        path.join(
          assignmentPath(workspacePath, 'session-one', 'run-one', 'assignment-one'),
          '.runtime',
          'execution-journal',
          'manifest.json',
        ),
      ),
      true,
    )
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('disabled mode never enrolls a new assignment', async () => {
  // `shadow` was folded into `disabled` (ADR A-1): it never supplied a
  // dispatcher port and never wrote a shadow stream, so it was this mode under
  // another name. It survives only as a deprecated flag value.
  for (const mode of ['disabled'] as const) {
    const workspacePath = makeWorkspace()
    const registry = new WorkspaceExecutionJournalRegistry({
      workspacePath,
      tenantId: TENANT,
      mode,
    })
    try {
      const context = makeAssignment(workspacePath)
      assert.equal(await registry.resolve(resolveInput(context)), undefined, mode)
      // Disabled mode must never supply the dispatcher's port, and must not
      // write a canonical stream for an unenrolled assignment.
      assert.equal(
        fs.existsSync(
          path.join(
            assignmentPath(workspacePath, 'session-one', 'run-one', 'assignment-one'),
            '.runtime',
            'execution-journal',
          ),
        ),
        false,
        mode,
      )
    } finally {
      await registry.close()
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  }
})

test('an enrolled assignment stays journal-authoritative when the flag is off', async () => {
  const workspacePath = makeWorkspace()
  const context = makeAssignment(workspacePath)
  const enrolling = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  assert.ok(await enrolling.resolve(resolveInput(context)))
  await enrolling.close()

  // A later process with the flag off must not return the assignment to the
  // legacy authority: its journal already holds canonical events (ADR §16).
  const disabled = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'disabled',
  })
  try {
    assert.ok(
      await disabled.resolve(resolveInput(context)),
      'enrollment is sticky regardless of flag state',
    )
  } finally {
    await disabled.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a tenant that disagrees with the sealed manifest fails closed', async () => {
  const workspacePath = makeWorkspace()
  const context = makeAssignment(workspacePath)
  const first = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  assert.ok(await first.resolve(resolveInput(context)))
  await first.close()

  const changed = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'a-different-tenant',
    mode: 'authoritative',
  })
  try {
    await assert.rejects(changed.resolve(resolveInput(context)))
  } finally {
    await changed.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a context whose assignment path is unresolvable fails closed', async () => {
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeAssignment(workspacePath)
    await assert.rejects(
      registry.resolve(
        resolveInput({ ...context, assignmentId: '../escape' }),
      ),
    )
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('concurrent resolutions open one journal, and release bars reopening', async () => {
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeAssignment(workspacePath)
    const resolved = await Promise.all(
      Array.from({ length: 6 }, () => registry.resolve(resolveInput(context))),
    )
    for (const port of resolved) assert.equal(port, resolved[0])

    await registry.releaseAssignment({
      sessionId: context.sessionId,
      runId: context.runId,
      assignmentId: context.assignmentId,
    })

    // After terminal release the journal must not silently reopen.
    await assert.rejects(
      registry.resolve(resolveInput(context)),
      /released/i,
    )
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a release racing an in-flight open drains rather than leaking', async () => {
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeAssignment(workspacePath)
    const scope = {
      sessionId: context.sessionId,
      runId: context.runId,
      assignmentId: context.assignmentId,
    }
    const opening = registry.resolve(resolveInput(context))
    const releasing = registry.releaseAssignment(scope)
    await Promise.allSettled([opening, releasing])
    await releasing

    // The drained journal is closed: a later append through the port it handed
    // out cannot land after teardown.
    const port = await opening.catch(() => undefined)
    if (port) {
      await assert.rejects(
        port.recordRequested({ dispatchId: 'after-teardown', attemptId: 'a1' }),
      )
    }
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an enrollment marker that cannot be read fails closed', async () => {
  // A marker that is not a readable regular file leaves enrollment unknown.
  // Reporting "unenrolled" would return a possibly-enrolled assignment to the
  // legacy authority and risk repeating an unsafe effect (ADR §16).
  for (const damage of ['directory', 'symlink'] as const) {
    const workspacePath = makeWorkspace()
    const context = makeAssignment(workspacePath)
    const enrolling = new WorkspaceExecutionJournalRegistry({
      workspacePath,
      tenantId: TENANT,
      mode: 'authoritative',
    })
    assert.ok(await enrolling.resolve(resolveInput(context)))
    await enrolling.close()

    const manifestPath = path.join(
      assignmentPath(workspacePath, 'session-one', 'run-one', 'assignment-one'),
      '.runtime',
      'execution-journal',
      'manifest.json',
    )
    fs.rmSync(manifestPath)
    if (damage === 'directory') fs.mkdirSync(manifestPath)
    else fs.symlinkSync('/dev/null', manifestPath)

    for (const mode of ['disabled', 'authoritative'] as const) {
      const registry = new WorkspaceExecutionJournalRegistry({
        workspacePath,
        tenantId: TENANT,
        mode,
      })
      try {
        await assert.rejects(
          registry.resolve(resolveInput(context)),
          `${damage}/${mode} must fail closed`,
        )
      } finally {
        await registry.close()
      }
    }
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('resolution that outruns its deadline fails closed rather than hanging', async () => {
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeAssignment(workspacePath)
    const startedAt = Date.now()
    await assert.rejects(
      registry.resolve({
        context,
        signal: new AbortController().signal,
        // Already past: the contract is an absolute deadline.
        deadlineMs: Date.now() - 1,
      }),
    )
    assert.ok(Date.now() - startedAt < 2_000)
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a cancelled resolution does not fail a concurrent resolution on the same assignment', async () => {
  // The registry shares one in-flight open per assignment. Binding that open
  // to the first caller's signal means one cancelled tool call fails every
  // other dispatch of the same turn, which parallel tool fan-out makes the
  // normal shape rather than an edge case.
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeAssignment(workspacePath)
    const cancelled = new AbortController()
    const live = new AbortController()

    const first = registry.resolve({
      context,
      signal: cancelled.signal,
      deadlineMs: Date.now() + 5_000,
    })
    const second = registry.resolve({
      context,
      signal: live.signal,
      deadlineMs: Date.now() + 5_000,
    })
    cancelled.abort()

    // The cancelling caller may fail; the live one must not.
    await first.catch(() => undefined)
    const port = await second
    assert.ok(port, 'a live concurrent caller must still resolve its journal')
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a sibling arriving after the shared budget was abandoned still resolves', async () => {
  // AC19. The case above has the second caller join *before* the first is
  // cancelled, so the refcount never reaches zero. This one is the shape the
  // refcount does not cover: the first caller starts the open alone, is
  // cancelled, and drops `liveWaiters` to zero — which aborts the shared
  // budget. An `AbortController` cannot be un-aborted, so a healthy sibling
  // that arrives afterwards joins an attempt that is already doomed and
  // awaits its rejection.
  //
  // Same class of defect as the deadline one a previous package fixed in this
  // file: the refcount was added and the already-abandoned case was not.
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeAssignment(workspacePath)
    const cancelled = new AbortController()
    const live = new AbortController()

    const first = registry.resolve({
      context,
      signal: cancelled.signal,
      deadlineMs: Date.now() + 5_000,
    })
    // Synchronously, before the open can finish: the sole waiter leaves and
    // the shared budget is abandoned with the journal still unopened.
    cancelled.abort()

    const second = registry.resolve({
      context,
      signal: live.signal,
      deadlineMs: Date.now() + 5_000,
    })

    // The initiating waiter really was cancelled — otherwise this test could
    // pass with the sibling merely inheriting a successful open.
    await assert.rejects(first)

    const port = await second
    assert.ok(
      port,
      'a healthy sibling must not inherit a budget abandoned before it arrived',
    )

    // And it is a real, usable journal shared by the assignment — not a fresh
    // one per caller, which would break the one-journal-per-assignment rule.
    const third = await registry.resolve(resolveInput(context))
    assert.equal(third, port, 'the recovered attempt must still be shared')
    assert.equal(
      fs.existsSync(
        path.join(
          assignmentPath(workspacePath, 'session-one', 'run-one', 'assignment-one'),
          '.runtime',
          'execution-journal',
          'manifest.json',
        ),
      ),
      true,
      'and it must have actually enrolled the assignment',
    )
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * Await `work`, failing if it does not settle within the budget.
 *
 * A failure deadline, not polling: the outcome still arrives on its own
 * promise, and the timer exists only so a regression that strands a gate
 * fails here instead of hanging. node:test's own `timeout` marks a test
 * failed but does not cancel its body, so an inner deadline is what actually
 * lets the process finish.
 */
async function boundedAwait<T>(
  work: Promise<T>,
  description: string,
  budgetMs = 1_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} did not settle in ${budgetMs}ms`)),
          budgetMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** A promise plus its resolver, so a test can gate on an event rather than time. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => {
    resolve = () => settle()
  })
  return { promise, resolve }
}

test('an abandoned attempt that still succeeds is closed, not leaked', {
  // Bounded so a regression that removes the cleanup fails promptly instead
  // of hanging on a gate that nothing will ever resolve.
  timeout: 2_000,
}, async (t) => {
  // AC19, second half. An aborted open does not only reject: after
  // `initializeExecutionJournal` checks the signal it performs several
  // awaited filesystem operations without checking again
  // (`core/execution-journal.ts:601-643`), so an abort landing in that window
  // still resolves an `OpenJournal`. Detaching the abandoned attempt without
  // cleaning up after it therefore leaks a live journal handle — and for as
  // long as it lives, the assignment has two authorities, which is the one
  // thing ADR §1 does not allow.
  //
  // Every step is gated on an event, never on elapsed time: the first open is
  // held open until the replacement exists, so the late success is produced
  // deliberately rather than raced for.
  const workspacePath = makeWorkspace()
  const firstStarted = deferred()
  const releaseFirst = deferred()
  const firstClosed = deferred()
  let openerCalls = 0

  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
    journalOpener: async ({ scopeRoot, identity }) => {
      openerCalls += 1
      const isFirst = openerCalls === 1
      if (isFirst) {
        firstStarted.resolve()
        // Held until the replacement exists, and deliberately indifferent to
        // the abort — which is exactly what the unchecked window does.
        await releaseFirst.promise
      }
      const journal = await initializeExecutionJournal({ scopeRoot, identity })
      return {
        manifest: journal.manifest,
        journalDirectoryPath: journal.journalDirectoryPath,
        append: (appendInput) => journal.append(appendInput),
        scan: () => journal.scan(),
        scanStream: (streamKind, streamId) =>
          journal.scanStream(streamKind, streamId),
        getMetrics: () => journal.getMetrics(),
        isRetired: () => journal.isRetired(),
        close: async () => {
          await journal.close()
          if (isFirst) firstClosed.resolve()
        },
      }
    },
  })
  t.after(async () => {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  })

  const context = makeAssignment(workspacePath)
  const cancelled = new AbortController()
  const live = new AbortController()

  const first = registry.resolve({
    context,
    signal: cancelled.signal,
    deadlineMs: Date.now() + 5_000,
  })
  await firstStarted.promise
  // The sole waiter leaves while its open is still in flight.
  cancelled.abort()

  const second = registry.resolve({
    context,
    signal: live.signal,
    deadlineMs: Date.now() + 5_000,
  })

  let port: Awaited<typeof second>
  try {
    port = await boundedAwait(second, 'the sibling resolution')
  } finally {
    // Released whatever happened above: without the fresh-attempt branch the
    // sibling waits on this very gate, and stranding it would hang the run
    // rather than fail it.
    releaseFirst.resolve()
  }
  assert.ok(port, 'the sibling must resolve through a fresh attempt')
  assert.equal(openerCalls, 2, 'and that must be a second open, not the first')

  // The abandoned open now succeeds, behind the abort, and must be closed.
  await boundedAwait(firstClosed.promise, "the abandoned journal's close")

  // Its gate is already released, so this cannot deadlock. The opener
  // deliberately ignores the cancellation, so the first caller really does
  // receive the port it asked for — which is the whole point: the open
  // *succeeded* after being abandoned. Swallowing the outcome here would let
  // a rejection pass for a late success and prove nothing.
  const abandonedPort = await boundedAwait(first, 'the abandoned resolution')
  assert.ok(
    abandonedPort,
    'the abandoned open must have succeeded, or this proves no late success',
  )
  assert.notEqual(
    abandonedPort,
    port,
    'and it must be a different port from the replacement',
  )

  // The cleanup must not have taken the replacement with it.
  const again = await registry.resolve(resolveInput(context))
  assert.equal(again, port, 'the replacement must survive the cleanup')
})

test('releasing an assignment drains an abandoned open still in flight', {
  timeout: 2_000,
}, async (t) => {
  // AC19, third part. `releaseAssignment` closes the assignment's *cached*
  // journal, which after the recovery above is the replacement — not the
  // abandoned open that is still behind its gate. So release could return
  // while an old opener was still going to produce a live journal, letting
  // terminal finalization finish before the lifecycle was drained. Its own
  // contract says it closes the assignment's journal, and that has to mean
  // all of them.
  const workspacePath = makeWorkspace()
  const firstStarted = deferred()
  const releaseFirst = deferred()
  const firstClosed = deferred()
  const replacementClosed = deferred()
  let openerCalls = 0

  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
    journalOpener: async ({ scopeRoot, identity }) => {
      openerCalls += 1
      const isFirst = openerCalls === 1
      if (isFirst) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      const journal = await initializeExecutionJournal({ scopeRoot, identity })
      return {
        manifest: journal.manifest,
        journalDirectoryPath: journal.journalDirectoryPath,
        append: (appendInput) => journal.append(appendInput),
        scan: () => journal.scan(),
        scanStream: (streamKind, streamId) =>
          journal.scanStream(streamKind, streamId),
        getMetrics: () => journal.getMetrics(),
        isRetired: () => journal.isRetired(),
        close: async () => {
          await journal.close()
          if (isFirst) firstClosed.resolve()
          else replacementClosed.resolve()
        },
      }
    },
  })
  t.after(async () => {
    // Deliberately unsuppressed: this test specifies how a lifecycle failure
    // propagates, so swallowing one here would hide the thing under test.
    releaseFirst.resolve()
    try {
      await registry.close()
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  const context = makeAssignment(workspacePath)
  const scope = {
    sessionId: context.sessionId,
    runId: context.runId,
    assignmentId: context.assignmentId,
  }
  const cancelled = new AbortController()
  const live = new AbortController()

  const first = registry.resolve({
    context,
    signal: cancelled.signal,
    deadlineMs: Date.now() + 5_000,
  })
  await firstStarted.promise
  cancelled.abort()

  const port = await boundedAwait(
    registry.resolve({
      context,
      signal: live.signal,
      deadlineMs: Date.now() + 5_000,
    }),
    'the replacement resolution',
  )
  assert.ok(port)
  assert.equal(openerCalls, 2)

  // Terminal finalization, with the abandoned opener still gated.
  const release = registry.releaseAssignment(scope)
  let releaseSettled = false
  void release.then(
    () => {
      releaseSettled = true
    },
    () => {
      releaseSettled = true
    },
  )

  // The cached journal closes immediately; release must not be finished,
  // because the abandoned open has not produced its journal yet.
  await boundedAwait(replacementClosed.promise, "the replacement's close")
  await new Promise((settle) => setImmediate(settle))
  await new Promise((settle) => setImmediate(settle))
  assert.equal(
    releaseSettled,
    false,
    'release must not finish while an abandoned open can still produce a journal',
  )

  // Now the abandoned open succeeds. Its journal must be closed, and only
  // then may release complete.
  releaseFirst.resolve()
  await boundedAwait(firstClosed.promise, "the abandoned journal's close")
  await boundedAwait(release, 'releaseAssignment')

  // The opener ignores the cancellation, so the abandoned open really did
  // succeed — asserting it directly is what makes this a late success rather
  // than a swallowed rejection.
  const abandonedPort = await boundedAwait(first, 'the abandoned resolution')
  assert.ok(abandonedPort, 'the abandoned open must have succeeded')
  assert.notEqual(abandonedPort, port, 'and it is not the replacement')
})

test('closing while a release is draining waits for the same abandoned open', {
  timeout: 2_000,
}, async (t) => {
  // AC19, fourth part. `releaseAssignment` and `close()` both drain detached
  // cleanups, so ownership has to stay discoverable until the work settles.
  // If the first drainer takes the registry's only record of that cleanup,
  // a concurrent `close()` finds nothing and reports the registry shut down
  // while a journal is still being opened — the same lifecycle hole as
  // before, moved one level up.
  const workspacePath = makeWorkspace()
  const firstStarted = deferred()
  const releaseFirst = deferred()
  const firstClosed = deferred()
  const replacementClosed = deferred()
  let openerCalls = 0

  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
    journalOpener: async ({ scopeRoot, identity }) => {
      openerCalls += 1
      const isFirst = openerCalls === 1
      if (isFirst) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      const journal = await initializeExecutionJournal({ scopeRoot, identity })
      return {
        manifest: journal.manifest,
        journalDirectoryPath: journal.journalDirectoryPath,
        append: (appendInput) => journal.append(appendInput),
        scan: () => journal.scan(),
        scanStream: (streamKind, streamId) =>
          journal.scanStream(streamKind, streamId),
        getMetrics: () => journal.getMetrics(),
        isRetired: () => journal.isRetired(),
        close: async () => {
          await journal.close()
          if (isFirst) firstClosed.resolve()
          else replacementClosed.resolve()
        },
      }
    },
  })
  t.after(async () => {
    // An assertion that fails before the gates below must not leave a live
    // registry holding an open journal.
    releaseFirst.resolve()
    try {
      await registry.close()
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  const context = makeAssignment(workspacePath)
  const scope = {
    sessionId: context.sessionId,
    runId: context.runId,
    assignmentId: context.assignmentId,
  }
  const cancelled = new AbortController()
  const live = new AbortController()

  const first = registry.resolve({
    context,
    signal: cancelled.signal,
    deadlineMs: Date.now() + 5_000,
  })
  await firstStarted.promise
  cancelled.abort()

  const port = await boundedAwait(
    registry.resolve({
      context,
      signal: live.signal,
      deadlineMs: Date.now() + 5_000,
    }),
    'the replacement resolution',
  )
  assert.ok(port)

  const release = registry.releaseAssignment(scope)
  let releaseSettled = false
  void release.then(
    () => {
      releaseSettled = true
    },
    () => {
      releaseSettled = true
    },
  )
  await boundedAwait(replacementClosed.promise, "the replacement's close")
  await new Promise((settle) => setImmediate(settle))

  // Shutdown begins while the release is still draining the gated open.
  const closing = registry.close()
  let closeSettled = false
  void closing.then(
    () => {
      closeSettled = true
    },
    () => {
      closeSettled = true
    },
  )
  await new Promise((settle) => setImmediate(settle))
  await new Promise((settle) => setImmediate(settle))

  assert.equal(
    releaseSettled,
    false,
    'the release must still be draining its abandoned open',
  )
  assert.equal(
    closeSettled,
    false,
    'and close must join that drain rather than report a shutdown that has ' +
      'not happened',
  )

  releaseFirst.resolve()
  await boundedAwait(firstClosed.promise, "the abandoned journal's close")
  await boundedAwait(release, 'releaseAssignment')
  await boundedAwait(closing, 'close')

  const abandonedPort = await boundedAwait(first, 'the abandoned resolution')
  assert.ok(abandonedPort, 'the abandoned open must have succeeded')
  assert.notEqual(abandonedPort, port, 'and it is not the replacement')
})

test('a short-deadline resolution does not shorten a concurrent caller deadline', async () => {
  // The shared open also inherited the first caller's deadline, so a caller
  // with a tight budget could time out a caller that had a generous one.
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeAssignment(workspacePath)
    const impatient = registry.resolve({
      context,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 1,
    })
    const patient = registry.resolve({
      context,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    })

    await impatient.catch(() => undefined)
    const port = await patient
    assert.ok(port, 'a caller with budget left must still resolve its journal')
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('resolution after close fails closed rather than reporting no authority', async () => {
  // `undefined` means "no durable authority, proceed on the legacy path".
  // Returning it from a closed registry would run a dispatch with no barrier,
  // which ADR §7 forbids; the released path already throws.
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeAssignment(workspacePath)
    await registry.resolve(resolveInput(context))
    await registry.close()

    await assert.rejects(
      registry.resolve(resolveInput(context)),
      /unavailable|released/i,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the workflow recorder and the dispatch port share one journal per assignment', async () => {
  // ADR §1: an assignment has one journal, and the dispatcher and its stores
  // write to it behind one lock. A second journal for workflow state would
  // reintroduce exactly the split authority Phase 8 removes.
  const workspacePath = makeWorkspace()
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: TENANT,
    mode: 'authoritative',
  })
  try {
    const context = makeAssignment(workspacePath)
    const port = await registry.resolve(resolveInput(context))
    assert.ok(port)

    const journal = await registry.resolveJournalHandle(resolveInput(context))
    assert.ok(journal, 'the registry must expose the journal its stores share')

    // Same assignment, same underlying journal: one manifest, one lock.
    const again = await registry.resolveJournalHandle(resolveInput(context))
    assert.equal(again, journal)
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
