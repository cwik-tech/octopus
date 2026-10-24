import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { ExecutionJournalEvent } from '../../contracts/execution-journal.js'
import {
  classifyProjectionLag,
  JournalJsonlProjectionStore,
  ProjectionRebuildRequiredError,
  type JournalProjectionMetadata,
} from '../../core/journal-projection.js'
import {
  projectCapabilityDispatchEvidenceLine,
  CAPABILITY_EVIDENCE_REDUCER_VERSION,
} from '../../core/capability-dispatch-projection.js'

function makeMetadata(
  overrides: Partial<JournalProjectionMetadata> = {},
): JournalProjectionMetadata {
  return {
    schemaVersion: 1,
    projectionId: 'capability-evidence',
    reducerVersion: CAPABILITY_EVIDENCE_REDUCER_VERSION,
    lastAppliedSequence: 10,
    updatedAt: '2026-08-16T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Deliberate contract reversal (AC8).
 *
 * Missing metadata used to read `absent` whatever the journal held. After a
 * restart that is exactly the state a view left behind by a failed derive is
 * in — nothing was ever recorded — and `absent` says "no view is configured"
 * rather than "the configured view has not caught up". An operator reading the
 * inspection report could not tell those apart, and the second is the one that
 * needs acting on.
 *
 * Absent now means what it says: nothing to project yet.
 */
test('projection lag classification covers absent, current, lagging, and drift states', () => {
  const version = CAPABILITY_EVIDENCE_REDUCER_VERSION
  assert.equal(
    classifyProjectionLag(undefined, 0, version),
    'absent',
    'nothing to project and nothing projected',
  )
  assert.equal(
    classifyProjectionLag(undefined, 10, version),
    'lagging',
    'events to project and no record of any being applied',
  )
  assert.equal(classifyProjectionLag(makeMetadata(), 10, version), 'current')
  assert.equal(classifyProjectionLag(makeMetadata(), 12, version), 'lagging')
  assert.equal(
    classifyProjectionLag(makeMetadata({ reducerVersion: 999 }), 10, version),
    'rebuild-required',
  )
  // A projection ahead of the journal is impossible from canonical appends;
  // treat it as corrupt drift requiring a rebuild.
  assert.equal(classifyProjectionLag(makeMetadata(), 5, version), 'rebuild-required')
})

test('dispatch journal events project to legacy evidence lines', () => {
  const requested = makeDispatchEvent('capability.dispatch.requested', 1)
  const started = makeDispatchEvent('capability.dispatch.started', 2)
  const accepted = makeDispatchEvent('capability.dispatch.accepted', 3, {
    status: 'completed',
    costTracked: true,
    budgetOverrun: false,
    actualCostUsd: 0.25,
    resultKind: 'inline',
  })
  const lines = [requested, started, accepted].map(
    projectCapabilityDispatchEvidenceLine,
  )
  const requestedLine = lines[0]
  const startedLine = lines[1]
  const completedLine = lines[2]
  assert.ok(requestedLine !== undefined)
  assert.ok(startedLine !== undefined)
  assert.ok(completedLine !== undefined)
  const requestedRecord = JSON.parse(requestedLine)
  const startedRecord = JSON.parse(startedLine)
  const completedRecord = JSON.parse(completedLine)
  assert.equal(requestedRecord.type, 'capability.dispatch.requested')
  assert.equal(startedRecord.type, 'capability.dispatch.started')
  assert.equal(completedRecord.type, 'capability.dispatch.completed')
  assert.equal(completedRecord.costTracked, true)
  assert.equal(completedRecord.budgetOverrun, false)
  assert.equal(completedRecord.actualCostUsd, 0.25)
  for (const record of [requestedRecord, startedRecord, completedRecord]) {
    assert.equal(record.contractVersion, 1)
    assert.equal(record.dispatchId, 'dispatch-1')
    assert.equal(record.attemptId, 'attempt-1')
    assert.equal(record.capabilityId, 'test.project')
    assert.equal(record.sourceKind, 'builtin')
    assert.equal(record.sourceId, 'projections')
    assert.equal(record.argumentDigest, 'ab'.repeat(32))
    assert.deepEqual(record.argumentNames, ['target'])
    assert.equal(record.agentPath, 'agents/projections')
    assert.equal(record.authorityKind, 'runtime-assignment')
    assert.equal(record.sessionId, 'session-1')
    assert.equal(record.runId, 'run-1')
    assert.equal(record.assignmentId, 'assignment-1')
  }
})

test('terminal dispatch events project with their outcome code', () => {
  const rejected = makeDispatchEvent('capability.dispatch.rejected', 2, {
    code: 'policy_denied',
  })
  const indeterminate = makeDispatchEvent(
    'capability.dispatch.indeterminate',
    2,
    { code: 'completion_fence_failed' },
  )
  const cancelled = makeDispatchEvent('capability.dispatch.cancelled', 2, {
    code: 'dispatch_cancelled',
  })
  const failed = makeDispatchEvent('capability.dispatch.failed', 2, {
    code: 'capability_execution_failed',
  })
  const records = [rejected, indeterminate, cancelled, failed].map((event) => {
    const line = projectCapabilityDispatchEvidenceLine(event)
    assert.ok(line !== undefined)
    return JSON.parse(line as string)
  })
  assert.deepEqual(
    records.map((record) => [record.type, record.code]),
    [
      ['capability.dispatch.rejected', 'policy_denied'],
      ['capability.dispatch.indeterminate', 'completion_fence_failed'],
      ['capability.dispatch.cancelled', 'dispatch_cancelled'],
      ['capability.dispatch.failed', 'capability_execution_failed'],
    ],
  )
})

test('canonical-only dispatch stages do not project to legacy evidence', () => {
  assert.equal(
    projectCapabilityDispatchEvidenceLine(
      makeDispatchEvent('capability.dispatch.prepared', 2),
    ),
    undefined,
  )
  assert.equal(
    projectCapabilityDispatchEvidenceLine(
      makeDispatchEvent('capability.dispatch.committed', 3),
    ),
    undefined,
  )
  const nonDispatch = makeDispatchEvent('test.observation', 1, {}, 'other.stream')
  assert.equal(projectCapabilityDispatchEvidenceLine(nonDispatch), undefined)
})

function makeDispatchEvent(
  type: string,
  sequence: number,
  extraPayload: Record<string, unknown> = {},
  streamKind = 'capability.dispatch',
): ExecutionJournalEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    recordedAt: '2026-08-16T00:00:01.000Z',
    scopeKind: 'assignment',
    scopeId: 'scope-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    streamKind,
    streamId: 'dispatch-1',
    streamRevision: sequence,
    type,
    payloadSchemaVersion: 1,
    appendRequestDigest: 'cd'.repeat(32),
    correlationId: 'dispatch-1',
    previousEventHash: 'ab'.repeat(32),
    eventHash: 'ef'.repeat(32),
    payload: {
      identity: {
        contractVersion: 1,
        dispatchId: 'dispatch-1',
        attemptId: 'attempt-1',
        requestId: 'request-1',
        sessionId: 'session-1',
        runId: 'run-1',
        assignmentId: 'assignment-1',
        agentPath: 'agents/projections',
        authorityKind: 'runtime-assignment',
        capabilityId: 'test.project',
        sourceKind: 'builtin',
        sourceId: 'projections',
        sourceVersion: '1',
        argumentDigest: 'ab'.repeat(32),
        argumentNames: ['target'],
        effect: { kind: 'mutating', concurrency: 'serial' },
      },
      ...extraPayload,
    },
  }
}

/**
 * Metadata written before `appliedLineCount` existed carries no line count.
 * Treating that absence as "zero lines were ever written" would skip the
 * deleted-view check and silently rebuild the view from the current sequence
 * onward, dropping every historical record.
 */
test('metadata without a line count still detects a deleted view', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-upgrade-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const targetPath = path.join(root, 'view.jsonl')
  const store = new JournalJsonlProjectionStore({
    projectionId: 'legacy-view',
    reducerVersion: 1,
    projectionDirectory: path.join(root, 'projections'),
    targetPath,
    targetContainerPath: root,
  })

  await store.applyEvents([makeEvent(1)], () => '{"n":1}')
  assert.equal((await fs.readFile(targetPath, 'utf8')).trim(), '{"n":1}')

  // Downgrade the metadata to its pre-upgrade shape.
  const metadataPath = store.metadataPath
  const raw: Record<string, unknown> = JSON.parse(
    await fs.readFile(metadataPath, 'utf8'),
  )
  delete raw['appliedLineCount']
  await fs.writeFile(metadataPath, `${JSON.stringify(raw)}\n`, 'utf8')

  // The view is gone; its historical line cannot be recovered by appending.
  await fs.rm(targetPath)
  await assert.rejects(
    store.applyEvents([makeEvent(2)], () => '{"n":2}'),
    ProjectionRebuildRequiredError,
  )
})

/**
 * AC8: catch-up must count the lines it recognises, not only the ones it
 * writes.
 *
 * `applySerialized` appends the view and records the metadata second, so a
 * process that dies between them leaves lines present above the recorded
 * watermark. Nothing classifies that state — `classifyProjectionLag` compares
 * only sequence and reducer version, and the view check tests existence, not
 * contents — so catch-up is what has to tolerate it.
 *
 * Skipping by content is the only sound way. This view has other writers (the
 * parent's approval records, the worker's own evidence writer), so a line
 * count cannot tell our duplicate from someone else's record; each dispatch
 * event projects to a unique canonical line, so identity can.
 *
 * And a recognised line must still be *counted*. `appliedLineCount` is the
 * only thing distinguishing "nothing has projected yet" from "the view was
 * deleted": undercount it and a later deletion slips past the check that
 * would have demanded a rebuild, losing the history in silence.
 */
test('catch-up counts lines it recognises as already applied', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-catchup-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const targetPath = path.join(root, 'view.jsonl')
  const store = new JournalJsonlProjectionStore({
    projectionId: 'legacy-view',
    reducerVersion: 1,
    projectionDirectory: path.join(root, 'projections'),
    targetPath,
    targetContainerPath: root,
  })
  const lineFor = (event: ExecutionJournalEvent): string =>
    `{"n":${event.sequence}}`

  // Exactly what a crash between the append and the metadata write leaves:
  // the view holds the line, and no metadata records it.
  await fs.writeFile(targetPath, `${lineFor(makeEvent(1))}\n`, 'utf8')

  await store.catchUp([makeEvent(1), makeEvent(2)], lineFor)

  const view = (await fs.readFile(targetPath, 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
  assert.deepEqual(
    view,
    ['{"n":1}', '{"n":2}'],
    'the recognised line is not appended again, and the missing one is',
  )
  const metadata = await store.readMetadata()
  assert.equal(metadata?.lastAppliedSequence, 2)
  assert.equal(
    metadata?.appliedLineCount,
    2,
    'both lines are applied — one recovered, one written — and the count ' +
      'must say so',
  )

  // With the count honest, losing the view is detected instead of being
  // quietly rebuilt from the current sequence onward.
  await fs.rm(targetPath)
  await assert.rejects(
    store.applyEvents([makeEvent(3)], lineFor),
    ProjectionRebuildRequiredError,
  )
})

test('catch-up appends a repeated projected line only once', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-repeat-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const targetPath = path.join(root, 'view.jsonl')
  const store = new JournalJsonlProjectionStore({
    projectionId: 'legacy-view',
    reducerVersion: 1,
    projectionDirectory: path.join(root, 'projections'),
    targetPath,
    targetContainerPath: root,
  })

  // Two events that project to the same line. The reducer does not promise
  // they cannot, and appending both would duplicate the record — so the batch
  // is deduplicated against itself, not only against the view.
  await store.catchUp([makeEvent(1), makeEvent(2)], () => '{"same":true}')

  const view = (await fs.readFile(targetPath, 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
  assert.deepEqual(view, ['{"same":true}'])
  assert.equal((await store.readMetadata())?.appliedLineCount, 1)
})

/**
 * AC20: a rebuild is redirected by a symlinked parent, and must refuse.
 *
 * `rebuild` does not open the target: it writes a temporary file beside it and
 * renames over the name. A rename *replaces* a symlinked file rather than
 * following it, so that shape cannot escape this path — which is exactly why
 * it needs its own case. What it does follow is the directory: a symlinked
 * parent takes the temporary write and the rename with it, so a republish of
 * the whole view lands outside the workspace.
 *
 * The external directory is checked byte-for-byte, because the failure here is
 * silent by construction — the caller sees a successful rebuild either way.
 */
test('a rebuild refuses a redirected parent directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-rebuild-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const outsidePath = path.join(root, 'outside')
  const viewDirectory = path.join(root, 'container', 'view')
  await fs.mkdir(outsidePath, { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(root, 'container'), { recursive: true, mode: 0o700 })
  await fs.symlink(outsidePath, viewDirectory, 'dir')

  const store = new JournalJsonlProjectionStore({
    projectionId: 'legacy-view',
    reducerVersion: 1,
    projectionDirectory: path.join(root, 'projections'),
    targetPath: path.join(viewDirectory, 'view.jsonl'),
    targetContainerPath: path.join(root, 'container'),
  })

  const outcome = await store
    .rebuild([makeEvent(1)], () => '{"n":1}')
    .then(() => 'published', (error: unknown) => String(error))

  // The escape first: what lands outside is the observable harm, and a test
  // that only checked for a rejection would report a missing error rather than
  // the file it failed to prevent.
  assert.deepEqual(
    await fs.readdir(outsidePath),
    [],
    'the external directory must be untouched',
  )
  assert.match(
    outcome,
    /unsafe|redirect|canonical|symlink/i,
    'and the republish must be refused rather than silently succeeding',
  )
})

function makeEvent(sequence: number): ExecutionJournalEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    recordedAt: '2026-08-18T12:00:00.000Z',
    scopeKind: 'assignment',
    scopeId: 'scope',
    tenantId: 'tenant',
    streamKind: 'test.stream',
    streamId: 'stream-1',
    streamRevision: sequence,
    type: 'test.event',
    payloadSchemaVersion: 1,
    appendRequestDigest: 'a'.repeat(64),
    correlationId: 'corr',
    previousEventHash: 'b'.repeat(64),
    eventHash: 'c'.repeat(64),
    payload: {},
  }
}
