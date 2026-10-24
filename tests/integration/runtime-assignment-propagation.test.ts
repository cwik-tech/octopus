import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { runTeam } from '../../domains/agent-execution/agent-runner.js'
import {
  buildSessionRunAssignmentLocation,
  resolveRunAssignmentLocation,
} from '../../domains/run/run-location.js'

async function withFakePi<T>(
  handlerSource: string,
  run: (binDirectory: string) => Promise<T>,
): Promise<T> {
  const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-scope-pi-'))
  const scriptPath = path.join(binDirectory, 'pi')
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node\n${handlerSource}\n`,
    { mode: 0o755 },
  )
  try {
    return await run(binDirectory)
  } finally {
    fs.rmSync(binDirectory, { recursive: true, force: true })
  }
}

test('runTeam propagates canonical session assignment scope to a real child process', async () => {
  await withFakePi(`
const fs = require('node:fs')
const path = require('node:path')
const keys = [
  'TEAM_RUNTIME_SESSION_ID',
  'TEAM_RUNTIME_RUN_ID',
  'TEAM_RUNTIME_ASSIGNMENT_ID',
  'TEAM_RUNTIME_ASSIGNMENT_PATH',
  'TEAM_RUNTIME_RUN_PATH',
  'TEAM_SESSION_ID',
  'TEAM_ROOT_SESSION_ID',
  'TEAM_PARENT_SESSION_ID',
  'TEAM_WORKSPACE_PATH',
]
const payload = { cwd: process.cwd() }
for (const key of keys) payload[key] = process.env[key] || ''
fs.writeFileSync(path.join(process.cwd(), 'scope.json'), JSON.stringify(payload, null, 2))
`, async (binDirectory) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-scope-run-'))
    const workspacePath = path.join(root, 'workspace')
    const teamPath = path.join(root, 'child-team')
    const originalPath = process.env.PATH
    const originalBundledCli = process.env.TEAM_RUNTIME_PI_CLI_PATH
    process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ''}`
    delete process.env.TEAM_RUNTIME_PI_CLI_PATH

    try {
      fs.mkdirSync(teamPath, { recursive: true })
      const parentAssignmentLocation = buildSessionRunAssignmentLocation(
        workspacePath,
        {
          sessionId: 'product-session',
          runId: 'run-1',
          assignmentId: 'root-assignment',
        },
      )
      assert.ok(parentAssignmentLocation)

      const result = await runTeam({
        teamPath,
        workspacePath,
        workspacePathOverride: workspacePath,
        brief: 'Exercise scoped child paths.',
        childSessionId: 'child-assignment',
        outputArtifact: 'scope.json',
        spawnDepth: 0,
        rootSessionId: 'run-1',
        parentSessionId: 'root-assignment',
        parentAssignmentLocation,
      })

      const expectedAssignmentPath = path.join(
        workspacePath,
        'sessions',
        'product-session',
        'runs',
        'run-1',
        'assignments',
        'child-assignment',
      )
      const expectedRunPath = path.join(
        workspacePath,
        'sessions',
        'product-session',
        'runs',
        'run-1',
      )
      assert.equal(result.succeeded, true)
      assert.equal(result.assignmentPath, expectedAssignmentPath)
      assert.equal(fs.existsSync(path.join(workspacePath, 'assignments', 'child-assignment')), false)

      const childEnvironment = JSON.parse(result.text) as Record<string, string>
      assert.equal(childEnvironment.cwd, fs.realpathSync(expectedAssignmentPath))
      assert.equal(childEnvironment.TEAM_RUNTIME_SESSION_ID, 'product-session')
      assert.equal(childEnvironment.TEAM_RUNTIME_RUN_ID, 'run-1')
      assert.equal(childEnvironment.TEAM_RUNTIME_ASSIGNMENT_ID, 'child-assignment')
      assert.equal(childEnvironment.TEAM_RUNTIME_ASSIGNMENT_PATH, expectedAssignmentPath)
      assert.equal(childEnvironment.TEAM_RUNTIME_RUN_PATH, expectedRunPath)
      assert.equal(childEnvironment.TEAM_SESSION_ID, 'child-assignment')
      assert.equal(childEnvironment.TEAM_ROOT_SESSION_ID, 'run-1')
      assert.equal(childEnvironment.TEAM_PARENT_SESSION_ID, 'root-assignment')
      assert.equal(childEnvironment.TEAM_WORKSPACE_PATH, workspacePath)

      const indexed = resolveRunAssignmentLocation(workspacePath, 'child-assignment')
      assert.equal(indexed?.layout, 'session')
      assert.equal(indexed?.assignmentPath, expectedAssignmentPath)
    } finally {
      process.env.PATH = originalPath
      if (originalBundledCli === undefined) {
        delete process.env.TEAM_RUNTIME_PI_CLI_PATH
      } else {
        process.env.TEAM_RUNTIME_PI_CLI_PATH = originalBundledCli
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
