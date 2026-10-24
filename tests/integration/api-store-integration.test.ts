import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { startApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { logRuntimeEvent, logSessionStart } from '../../domains/runtime/logger.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'api-store-integration-'))
}

test('API + FileSystemRunStore integration serves real assignment state consistently', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'run-int')
  fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
  logSessionStart(assignmentPath, 'run-int', 'writing-team', ['writer'], 'root-int')
  fs.writeFileSync(path.join(assignmentPath, 'output', 'report.md'), 'integrated-artifact')
  logRuntimeEvent(assignmentPath, {
    timestamp: new Date().toISOString(),
    event: 'run.completed',
    session_id: 'run-int',
    root_session_id: 'root-int',
    assignment_path: assignmentPath,
    team: 'writing-team',
    level_id: 'final',
    stage_type: 'review',
  })

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun(request) {
        return { launched: true, pid: 999, cwd: request.cwd }
      },
    },
  })

  try {
    const runsResponse = await fetch(`${server.url}/runs`)
    const runsPayload = await runsResponse.json() as { runs: Array<{ id: string; status: string }> }
    const detailResponse = await fetch(`${server.url}/runs/run-int`)
    const detailPayload = await detailResponse.json() as { id: string; status: string; artifactPaths: string[] }
    const artifactResponse = await fetch(`${server.url}/runs/run-int/assignments/output/report.md`)
    const artifactText = await artifactResponse.text()

    assert.equal(runsResponse.status, 200)
    assert.equal(requiredValue(runsPayload.runs[0], 'tests/integration/api-store-integration.test.ts:50').id, 'run-int')
    assert.equal(requiredValue(runsPayload.runs[0], 'tests/integration/api-store-integration.test.ts:51').status, 'completed')
    assert.equal(detailResponse.status, 200)
    assert.equal(detailPayload.status, 'completed')
    assert.ok(detailPayload.artifactPaths.includes(path.join('output', 'report.md')))
    assert.equal(artifactResponse.status, 200)
    assert.equal(artifactText, 'integrated-artifact')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
