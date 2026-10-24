import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { startApiServer } from '../../server/api-server.js'
import { logRuntimeEvent, logSessionStart } from '../../domains/runtime/logger.js'
import {
  buildSessionRunAssignmentLocation,
  writeRunAssignmentLocator,
} from '../../domains/run/run-location.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-storage-api-'))
}

function completeAssignment(params: {
  assignmentPath: string
  assignmentId: string
  rootRunId: string
  artifactBody: string
}): void {
  fs.mkdirSync(path.join(params.assignmentPath, 'output'), { recursive: true })
  logSessionStart(
    params.assignmentPath,
    params.assignmentId,
    'storage-contract-team',
    ['storage-contract-agent'],
    params.rootRunId,
  )
  fs.writeFileSync(
    path.join(params.assignmentPath, 'output', 'report.md'),
    params.artifactBody,
  )
  logRuntimeEvent(params.assignmentPath, {
    timestamp: new Date().toISOString(),
    event: 'run.completed',
    session_id: params.assignmentId,
    root_session_id: params.rootRunId,
    assignment_path: params.assignmentPath,
    team: 'storage-contract-team',
    level_id: 'final',
    stage_type: 'review',
  })
}

test('existing run API contract reads session-scoped and legacy assignments through the same URLs', async () => {
  const workspacePath = makeWorkspace()
  const nested = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-api-contract',
    runId: 'root-api-contract',
    assignmentId: 'nested-api-contract',
  })
  assert.ok(nested)

  const legacyPath = path.join(
    workspacePath,
    'assignments',
    'legacy-api-contract',
  )
  completeAssignment({
    assignmentPath: nested.assignmentPath,
    assignmentId: nested.assignmentId,
    rootRunId: nested.runId,
    artifactBody: 'nested-artifact',
  })
  completeAssignment({
    assignmentPath: legacyPath,
    assignmentId: 'legacy-api-contract',
    rootRunId: 'legacy-api-contract',
    artifactBody: 'legacy-artifact',
  })
  await writeRunAssignmentLocator(workspacePath, nested)

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    workspacePath,
  })

  try {
    const runsResponse = await fetch(`${server.url}/runs`)
    assert.equal(runsResponse.status, 200)
    const runsPayload = (await runsResponse.json()) as {
      runs: Array<{ id: string; status: string }>
    }
    assert.deepEqual(
      new Set(runsPayload.runs.map((run) => run.id)),
      new Set(['nested-api-contract', 'legacy-api-contract']),
    )
    assert.ok(runsPayload.runs.every((run) => run.status === 'completed'))

    for (const [runId, expectedBody] of [
      ['nested-api-contract', 'nested-artifact'],
      ['legacy-api-contract', 'legacy-artifact'],
    ] as const) {
      const detailResponse = await fetch(`${server.url}/runs/${runId}`)
      assert.equal(detailResponse.status, 200)
      const detail = (await detailResponse.json()) as {
        id: string
        status: string
        artifactPaths: string[]
      }
      assert.equal(detail.id, runId)
      assert.equal(detail.status, 'completed')
      assert.ok(detail.artifactPaths.includes(path.join('output', 'report.md')))

      const artifactResponse = await fetch(
        `${server.url}/runs/${runId}/assignments/output/report.md`,
      )
      assert.equal(artifactResponse.status, 200)
      assert.equal(await artifactResponse.text(), expectedBody)

      const eventResponse = await fetch(
        `${server.url}/runs/${runId}/events?snapshot=1`,
      )
      assert.equal(eventResponse.status, 200)
      const eventPayload = (await eventResponse.json()) as {
        events: Array<{ type: string }>
      }
      assert.ok(eventPayload.events.some((event) => event.type === 'run.completed'))

      const diagnosticsResponse = await fetch(
        `${server.url}/runs/${runId}/diagnostics`,
      )
      assert.equal(diagnosticsResponse.status, 200)
    }
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
