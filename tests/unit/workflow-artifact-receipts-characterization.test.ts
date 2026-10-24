import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { getRunRuntimePaths } from '../../domains/runtime/runtime-paths.js'
import type { WorkflowArtifactReference } from '../../workflows/types.js'
import {
  createWorkflowArtifactReference,
  hashWorkflowContent,
  readVerifiedWorkflowArtifactPreview,
  readWorkflowCompletionReceipt,
  verifyWorkflowArtifactReference,
  WORKFLOW_COMPLETION_RECEIPT_FILENAME,
  WorkflowStateStoreError,
  writeWorkflowCompletionReceipt,
  type WorkflowCompletionReceiptInput,
} from '../../workflows/workflow-state-store.js'

// Artifact references and completion receipts, observed through the store's
// exported functions against real files in a temporary workspace. A refusal is
// compared as `code: message`; only a WorkflowStateStoreError is turned into
// one, and any other error fails the test.

const CHILD_RUN_ID = 'child-run'
const COMPLETED_AT = '2026-07-13T12:00:02.000Z'
const LATER = '2026-07-13T12:05:00.000Z'
// Each pair has the same byte length and different bytes: only the recorded
// hash tells them apart.
const REPORT = '# Durable report\n'
const ALTERED_REPORT = '# Altered report\n'
const SECOND = '# Second artifact\n'
const ALTERED_SECOND = '# Second artefact\n'

interface ChildRun {
  workspace: string
  child: string
  reportPath: string
}

/** A workspace holding assignments/child-run/report.md, removed when the test ends. */
function childRunIn(t: TestContext): ChildRun {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-artifact-receipts-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const child = path.join(workspace, 'assignments', CHILD_RUN_ID)
  fs.mkdirSync(child, { recursive: true })
  const reportPath = path.join(child, 'report.md')
  fs.writeFileSync(reportPath, REPORT)
  return { workspace, child, reportPath }
}

function referenceToReport(child: string): Promise<WorkflowArtifactReference> {
  return createWorkflowArtifactReference({
    childAssignmentPath: child,
    childRunId: CHILD_RUN_ID,
    relativePath: 'report.md',
  })
}

/** Writes second.md into the child run and returns a reference to it. */
function referenceToSecond(child: string): Promise<WorkflowArtifactReference> {
  fs.writeFileSync(path.join(child, 'second.md'), SECOND)
  return createWorkflowArtifactReference({
    childAssignmentPath: child,
    childRunId: CHILD_RUN_ID,
    relativePath: 'second.md',
  })
}

/** Where recovery reads a child run's completion receipt. */
function receiptPathIn(childAssignmentPath: string): string {
  return path.join(
    getRunRuntimePaths(childAssignmentPath).privateRuntimePath,
    WORKFLOW_COMPLETION_RECEIPT_FILENAME,
  )
}

function failedReceipt(childRunId = CHILD_RUN_ID): WorkflowCompletionReceiptInput {
  return {
    taskId: 'task-one',
    rootRunId: 'root-run',
    workflowId: 'research-workflow',
    stepId: 'research',
    childRunId,
    executionAttemptId: 'attempt-one',
    status: 'failed',
    summary: 'The child failed.',
    costUsd: 0,
    completedAt: COMPLETED_AT,
  }
}

function completedReceipt(artifact: WorkflowArtifactReference): WorkflowCompletionReceiptInput {
  return {
    ...failedReceipt(),
    status: 'completed',
    artifact,
    summary: 'Completed research.',
    costUsd: 0.75,
  }
}

/** The operation's result, or the store's refusal as `code: message`. */
async function attempt<T>(operation: () => Promise<T>): Promise<T | string> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof WorkflowStateStoreError) return `${error.code}: ${error.message}`
    throw error
  }
}

test('a receipt write with only a new completion time returns the stored receipt, and a different outcome is refused and changes nothing', async (t) => {
  const { child, reportPath } = childRunIn(t)
  const input = completedReceipt(await referenceToReport(child))
  const stored = await writeWorkflowCompletionReceipt(child, input)
  assert.deepEqual(stored, { ...input, schemaVersion: 1 })

  assert.deepEqual(
    await attempt(() => writeWorkflowCompletionReceipt(child, { ...input, completedAt: LATER })),
    stored,
  )
  assert.equal(
    await attempt(() => writeWorkflowCompletionReceipt(child, { ...input, summary: 'A conflicting completion.' })),
    'already_exists: A different completion receipt already exists for this child run.',
  )
  assert.deepEqual(await readWorkflowCompletionReceipt(child), stored)

  // The artifact is verified again before the stored receipt is consulted.
  fs.writeFileSync(reportPath, ALTERED_REPORT)
  assert.equal(
    await attempt(() => writeWorkflowCompletionReceipt(child, input)),
    "artifact_invalid: Artifact 'report.md' hash does not match its durable reference.",
  )
})

test("once a receipt's second artifact changes, repeating its write and reading it are both refused", async (t) => {
  const { child } = childRunIn(t)
  const report = await referenceToReport(child)
  const input = { ...completedReceipt(report), artifacts: [report, await referenceToSecond(child)] }
  await writeWorkflowCompletionReceipt(child, input)
  fs.writeFileSync(path.join(child, 'second.md'), ALTERED_SECOND)

  const observed = {
    'write repeated': await attempt(() => writeWorkflowCompletionReceipt(child, input)),
    read: await attempt(() => readWorkflowCompletionReceipt(child)),
  }

  assert.deepEqual(observed, {
    'write repeated':
      "artifact_invalid: Artifact 'second.md' hash does not match its durable reference.",
    read: "artifact_invalid: Artifact 'second.md' hash does not match its durable reference.",
  })
})

test('a receipt write refused by a field check, the artifact alias rules included, or by the ownership check leaves no receipt, and the field checks decide first', async (t) => {
  const { child } = childRunIn(t)
  const report = await referenceToReport(child)
  const second = await referenceToSecond(child)

  // `artifact` is the alias of `artifacts[0]`. The alias rows' receipts name this child run.
  const observed = {
    'naming another child run': await attempt(() =>
      writeWorkflowCompletionReceipt(child, failedReceipt('other-run'))),
    'successful without an artifact, naming another child run': await attempt(() =>
      writeWorkflowCompletionReceipt(child, { ...failedReceipt('other-run'), status: 'completed' })),
    'with an alias owned by another child run': await attempt(() =>
      writeWorkflowCompletionReceipt(child, completedReceipt({ ...report, childRunId: 'other-run' }))),
    'with artifacts but no alias': await attempt(() =>
      writeWorkflowCompletionReceipt(child, { ...failedReceipt(), status: 'completed', artifacts: [report, second] })),
    'with an alias that is not the first artifact': await attempt(() =>
      writeWorkflowCompletionReceipt(child, { ...completedReceipt(report), artifacts: [second, report] })),
  }

  assert.deepEqual(observed, {
    'naming another child run':
      "identity_mismatch: Child run 'other-run' does not own assignment 'child-run'.",
    'successful without an artifact, naming another child run':
      'invalid_state: A successful completion receipt requires an artifact reference.',
    'with an alias owned by another child run':
      'invalid_state: Completion receipt artifact belongs to a different child run.',
    'with artifacts but no alias':
      'invalid_state: Completion receipt artifacts require an artifact alias.',
    'with an alias that is not the first artifact':
      'invalid_state: Completion receipt artifact alias must match the first artifact.',
  })
  assert.equal(await readWorkflowCompletionReceipt(child), null)
})

test("a stored receipt is refused if it is not JSON, has a future schema version, lies in another child run's folder or fails the caller's expectation, and ownership is checked before the expectation, the expectation before the artifact", async (t) => {
  const { workspace, child, reportPath } = childRunIn(t)
  const stored = await writeWorkflowCompletionReceipt(child, completedReceipt(await referenceToReport(child)))
  const copy = path.join(workspace, 'assignments', 'child-copy')
  fs.mkdirSync(path.dirname(receiptPathIn(copy)), { recursive: true })
  fs.copyFileSync(receiptPathIn(child), receiptPathIn(copy))

  const observed = {
    "read from another child run's folder, expecting another workflow": await attempt(() =>
      readWorkflowCompletionReceipt(copy, { workflowId: 'other-workflow' })),
    "write where another child run's receipt already lies": await attempt(() =>
      writeWorkflowCompletionReceipt(copy, failedReceipt('child-copy'))),
    'read expecting another workflow after the artifact changed': await attempt(() => {
      fs.writeFileSync(reportPath, ALTERED_REPORT)
      return readWorkflowCompletionReceipt(child, { workflowId: 'other-workflow' })
    }),
    'read with a future schema version': await attempt(() => {
      fs.writeFileSync(receiptPathIn(child), JSON.stringify({ ...stored, schemaVersion: 2 }))
      return readWorkflowCompletionReceipt(child)
    }),
    'read of a receipt that is not JSON': await attempt(() => {
      fs.writeFileSync(receiptPathIn(child), '{broken')
      return readWorkflowCompletionReceipt(child)
    }),
  }

  assert.deepEqual(observed, {
    "read from another child run's folder, expecting another workflow":
      "identity_mismatch: Child run 'child-run' does not own assignment 'child-copy'.",
    "write where another child run's receipt already lies":
      "identity_mismatch: Child run 'child-run' does not own assignment 'child-copy'.",
    'read expecting another workflow after the artifact changed':
      "identity_mismatch: Completion receipt does not match expected 'workflowId'.",
    'read with a future schema version':
      'unsupported_version: Workflow completion receipt schema version 2 is not supported.',
    'read of a receipt that is not JSON':
      'corrupt: Could not parse workflow completion receipt as JSON.',
  })
})

test('an artifact reference is made and verified only for a regular file inside its child run, with the size checked before the hash', async (t) => {
  const { workspace, child } = childRunIn(t)
  const outsideFile = path.join(workspace, 'outside.md')
  fs.writeFileSync(outsideFile, 'outside')
  const outsideDirectory = path.join(workspace, 'outside')
  fs.mkdirSync(outsideDirectory)
  fs.writeFileSync(path.join(outsideDirectory, 'secret.md'), 'secret')
  fs.mkdirSync(path.join(child, 'folder'))
  fs.symlinkSync(outsideFile, path.join(child, 'linked.md'))
  fs.symlinkSync(outsideDirectory, path.join(child, 'linked-folder'))
  const reference = (relativePath: string, childRunId = CHILD_RUN_ID) =>
    attempt(() => createWorkflowArtifactReference({ childAssignmentPath: child, childRunId, relativePath }))
  const report = await referenceToReport(child)
  const verify = (changes: Partial<WorkflowArtifactReference>) =>
    attempt(() => verifyWorkflowArtifactReference(child, { ...report, ...changes }))

  const observed = {
    'a regular file': await reference('report.md'),
    'a path that climbs out': await reference('../outside.md'),
    'a path that climbs out, for another child run': await reference('../outside.md', 'other-run'),
    'a folder': await reference('folder'),
    'a missing file': await reference('missing.md'),
    'a symbolic link': await reference('linked.md'),
    'a file below a linked folder': await reference('linked-folder/secret.md'),
    'a reference without a digest': await verify({ sha256: 'not-a-digest' }),
    'a reference with another hash': await verify({ sha256: hashWorkflowContent(ALTERED_REPORT) }),
    'a reference with another size and hash': await verify({
      sha256: hashWorkflowContent(ALTERED_REPORT),
      byteLength: report.byteLength + 1,
    }),
  }

  assert.deepEqual(observed, {
    'a regular file': {
      childRunId: CHILD_RUN_ID,
      relativePath: 'report.md',
      sha256: hashWorkflowContent(REPORT),
      byteLength: Buffer.byteLength(REPORT),
    },
    'a path that climbs out':
      'invalid_state: Artifact relative path must be a safe slash-delimited relative path.',
    'a path that climbs out, for another child run':
      "identity_mismatch: Child run 'other-run' does not own assignment 'child-run'.",
    'a folder': "artifact_invalid: Artifact 'folder' is not a regular owned file.",
    'a missing file': "artifact_invalid: Artifact 'missing.md' is not a regular owned file.",
    'a symbolic link': "artifact_invalid: Artifact 'linked.md' is not a regular owned file.",
    'a file below a linked folder':
      "artifact_invalid: Artifact 'linked-folder/secret.md' resolves outside its child assignment.",
    'a reference without a digest':
      'invalid_state: Artifact reference hash must be a lowercase SHA-256 digest.',
    'a reference with another hash':
      "artifact_invalid: Artifact 'report.md' hash does not match its durable reference.",
    'a reference with another size and hash':
      "artifact_invalid: Artifact 'report.md' byte length does not match its durable reference.",
  })
})

test('a preview is truncated only when the artifact is longer than the byte limit', async (t) => {
  const { child } = childRunIn(t)
  const report = await referenceToReport(child)
  const length = Buffer.byteLength(REPORT)

  assert.deepEqual(
    await readVerifiedWorkflowArtifactPreview(child, report, length),
    { text: REPORT, truncated: false, byteLength: length },
  )
  assert.deepEqual(
    await readVerifiedWorkflowArtifactPreview(child, report, length - 1),
    { text: REPORT.slice(0, length - 1), truncated: true, byteLength: length },
  )
})

test('a receipt write waits on the child run\'s own completion-receipt.lock and times out naming it, with no receipt written', async (t) => {
  // A live owner holds the lock: this test's own process, so it is never read
  // as stale. The write gives up after the store's 5-second default.
  const { child } = childRunIn(t)
  const input = completedReceipt(await referenceToReport(child))
  const runtime = getRunRuntimePaths(child).privateRuntimePath
  fs.mkdirSync(runtime, { mode: 0o700 })
  fs.writeFileSync(path.join(runtime, 'completion-receipt.lock'), JSON.stringify({
    pid: process.pid, nonce: 'held-by-this-test', createdAt: new Date().toISOString(),
  }))

  assert.equal(
    await attempt(() => writeWorkflowCompletionReceipt(child, input)),
    "lock_timeout: Timed out waiting for workflow lock 'completion-receipt.lock'.",
  )
  assert.equal(fs.existsSync(receiptPathIn(child)), false)
})

test('the receipt a write returns shares no object with the caller\'s input', async (t) => {
  const { child } = childRunIn(t)
  const input = completedReceipt(await referenceToReport(child))

  const stored = await writeWorkflowCompletionReceipt(child, input)
  assert.deepEqual(stored.artifact, input.artifact)
  assert.notEqual(stored.artifact, input.artifact, 'the returned artifact is a copy, not the caller\'s object')
})
