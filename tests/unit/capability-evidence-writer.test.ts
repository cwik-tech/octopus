import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { CapabilityDispatchEvent } from '../../contracts/capability-dispatch.js'
import {
  AssignmentCapabilityEvidenceWriter,
  CAPABILITY_DISPATCH_EVENT_LOG_FILENAME,
} from '../../domains/runtime/capability-evidence-writer.js'
import { WorkspaceCapabilityEvidenceWriter } from '../../services/workspace-capability-evidence-writer.js'
import { buildSessionRunAssignmentLocation } from '../../core/run-assignment-location.js'

interface WriterHarness {
  readonly rootPath: string
  readonly assignmentPath: string
  readonly writer: AssignmentCapabilityEvidenceWriter
  cleanup(): Promise<void>
}

function createHarness(): WriterHarness {
  const rootPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'capability-evidence-writer-'),
  )
  const assignmentPath = path.join(rootPath, 'assignment-1')
  fs.mkdirSync(assignmentPath, { recursive: true, mode: 0o700 })
  const writer = new AssignmentCapabilityEvidenceWriter({
    assignmentPath,
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })
  return {
    rootPath,
    assignmentPath,
    writer,
    cleanup: async () => {
      await writer.close()
      fs.rmSync(rootPath, { recursive: true, force: true })
    },
  }
}

function dispatchEvent(
  type: CapabilityDispatchEvent['type'],
  overrides: Partial<CapabilityDispatchEvent> = {},
): CapabilityDispatchEvent {
  return {
    contractVersion: 1,
    type,
    timestamp: '2026-08-14T15:00:00.000Z',
    dispatchId: 'dispatch-1',
    attemptId: 'attempt-1',
    requestId: 'request-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/researcher',
    authorityKind: 'runtime-assignment',
    capabilityId: 'browser.navigate',
    sourceKind: 'builtin',
    sourceId: 'browser',
    argumentDigest: 'a'.repeat(64),
    argumentNames: ['url'],
    effect: { kind: 'read-only', concurrency: 'serial' },
    ...overrides,
  }
}

function readJsonLines(filePath: string): readonly unknown[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

test('concurrent appends persist complete JSONL records in invocation order through one assignment directory owner', async () => {
  const harness = createHarness()
  const requested = dispatchEvent('capability.dispatch.requested')
  const started = dispatchEvent('capability.dispatch.started')
  const completed = dispatchEvent('capability.dispatch.completed', {
    costTracked: false,
    budgetOverrun: false,
  })

  try {
    await Promise.all([
      harness.writer.append(requested),
      harness.writer.append(started),
      harness.writer.append(completed),
    ])

    const persisted = fs.readFileSync(harness.writer.filePath, 'utf8')
    assert.equal(persisted.endsWith('\n'), true)
    assert.deepEqual(readJsonLines(harness.writer.filePath), [
      requested,
      started,
      completed,
    ])
    assert.equal(
      harness.writer.filePath,
      path.join(
        harness.assignmentPath,
        'logs',
        CAPABILITY_DISPATCH_EVENT_LOG_FILENAME,
      ),
    )
    assert.equal(harness.writer.getMetrics().directoryCreateOperations, 1)
  } finally {
    await harness.cleanup()
  }
})

test('successful appends report deterministic operation and UTF-8 byte metrics', async () => {
  const harness = createHarness()
  const events = [
    dispatchEvent('capability.dispatch.requested'),
    dispatchEvent('capability.dispatch.started'),
  ] as const

  try {
    for (const event of events) await harness.writer.append(event)

    const persisted = fs.readFileSync(harness.writer.filePath, 'utf8')
    assert.deepEqual(harness.writer.getMetrics(), {
      appendOperations: events.length,
      bytesWritten: Buffer.byteLength(persisted, 'utf8'),
      directoryCreateOperations: 1,
    })
  } finally {
    await harness.cleanup()
  }
})

test('persisted evidence strips raw argument and result fields from runtime-shaped input', async () => {
  const harness = createHarness()
  const argumentSecret = 'argument-secret-45ae'
  const resultSecret = 'result-secret-58c2'
  const eventWithRuntimeExtras: CapabilityDispatchEvent &
    Readonly<Record<string, unknown>> = {
      ...dispatchEvent('capability.dispatch.completed'),
      arguments: { url: argumentSecret },
      result: { text: resultSecret },
    }

  try {
    await harness.writer.append(eventWithRuntimeExtras)

    const persisted = fs.readFileSync(harness.writer.filePath, 'utf8')
    assert.equal(persisted.includes(argumentSecret), false)
    assert.equal(persisted.includes(resultSecret), false)
    assert.equal(persisted.includes('"arguments"'), false)
    assert.equal(persisted.includes('"result"'), false)
  } finally {
    await harness.cleanup()
  }
})

test('close waits for accepted appends and rejects every later append without changing metrics', async () => {
  const harness = createHarness()
  const accepted = harness.writer.append(
    dispatchEvent('capability.dispatch.requested'),
  )

  try {
    await harness.writer.close()
    await accepted
    const metricsAtClose = harness.writer.getMetrics()

    await assert.rejects(
      harness.writer.append(dispatchEvent('capability.dispatch.started')),
      /closed/i,
    )
    assert.deepEqual(harness.writer.getMetrics(), metricsAtClose)
    assert.equal(readJsonLines(harness.writer.filePath).length, 1)
    await harness.writer.close()
  } finally {
    await harness.cleanup()
  }
})

test('filesystem append failures reject the caller and do not report a successful append', async () => {
  const harness = createHarness()
  const logsPath = path.dirname(harness.writer.filePath)
  fs.mkdirSync(logsPath, { recursive: true, mode: 0o700 })
  fs.mkdirSync(harness.writer.filePath, { mode: 0o700 })

  try {
    await assert.rejects(
      harness.writer.append(dispatchEvent('capability.dispatch.requested')),
    )
    assert.equal(harness.writer.getMetrics().appendOperations, 0)
    assert.equal(harness.writer.getMetrics().bytesWritten, 0)
  } finally {
    await harness.cleanup()
  }
})

test('rejects a symlinked logs directory without writing outside the assignment', async () => {
  const harness = createHarness()
  const outsideLogsPath = path.join(harness.rootPath, 'outside-logs')
  fs.mkdirSync(outsideLogsPath, { mode: 0o700 })
  fs.symlinkSync(
    outsideLogsPath,
    path.dirname(harness.writer.filePath),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  try {
    await assert.rejects(
      harness.writer.append(dispatchEvent('capability.dispatch.requested')),
      /canonical|symbolic|symlink|unsafe/i,
    )
    assert.equal(
      fs.existsSync(
        path.join(outsideLogsPath, CAPABILITY_DISPATCH_EVENT_LOG_FILENAME),
      ),
      false,
    )
    assert.equal(harness.writer.getMetrics().appendOperations, 0)
  } finally {
    await harness.cleanup()
  }
})

test('rejects a symlinked event file without modifying its external target', async () => {
  const harness = createHarness()
  const logsPath = path.dirname(harness.writer.filePath)
  const outsideTargetPath = path.join(harness.rootPath, 'outside-events.jsonl')
  fs.mkdirSync(logsPath, { mode: 0o700 })
  fs.writeFileSync(outsideTargetPath, 'sentinel\n', { mode: 0o600 })
  fs.symlinkSync(outsideTargetPath, harness.writer.filePath, 'file')

  try {
    await assert.rejects(
      harness.writer.append(dispatchEvent('capability.dispatch.requested')),
      /canonical|symbolic|symlink|unsafe|loop/i,
    )
    assert.equal(fs.readFileSync(outsideTargetPath, 'utf8'), 'sentinel\n')
    assert.equal(harness.writer.getMetrics().appendOperations, 0)
  } finally {
    await harness.cleanup()
  }
})

test('assignment release waits for accepted evidence and replaces the closed writer on later use', async () => {
  const rootPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workspace-capability-evidence-'),
  )
  const workspacePath = path.join(rootPath, 'workspace')
  const assignmentScope = {
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  }
  const location = buildSessionRunAssignmentLocation(
    workspacePath,
    assignmentScope,
  )
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true, mode: 0o700 })
  const writer = new WorkspaceCapabilityEvidenceWriter({ workspacePath })
  const filePath = path.join(
    location.assignmentPath,
    'logs',
    CAPABILITY_DISPATCH_EVENT_LOG_FILENAME,
  )

  try {
    const accepted = writer.append(
      dispatchEvent('capability.dispatch.requested'),
    )
    await writer.releaseAssignment(assignmentScope)
    await accepted
    const archivedPath = `${filePath}.before-release`
    fs.renameSync(filePath, archivedPath)

    await writer.append(dispatchEvent('capability.dispatch.started'))

    assert.deepEqual(readJsonLines(archivedPath), [
      dispatchEvent('capability.dispatch.requested'),
    ])
    assert.deepEqual(readJsonLines(filePath), [
      dispatchEvent('capability.dispatch.started'),
    ])
  } finally {
    await writer.close()
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})
