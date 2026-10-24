import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { parseWorkflowRegistry } from '../../workflows/loader.js'
import { runWorkflow } from '../../workflows/runner.js'

const REPO_ROOT = process.cwd()
const WORKFLOW_ID = 'clarify-debate-write'
const DIRECT_API_CREDENTIALS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
] as const

test(
  'clarify-debate-write completes through the ChatGPT subscription without API keys',
  { timeout: 15 * 60_000 },
  async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-subscription-live-'))
    const keepWorkspace = process.env.PIPELINE_KEEP_LIVE_WORKSPACE === '1'
    const originalCredentials = Object.fromEntries(
      DIRECT_API_CREDENTIALS.map((name) => [name, process.env[name]]),
    )
    for (const name of DIRECT_API_CREDENTIALS) process.env[name] = ''

    try {
      const teamRegistryResult = parseTeamRegistry(path.join(REPO_ROOT, 'teams.yaml'))
      assert.deepEqual(teamRegistryResult.errors, [])
      const workflowRegistryResult = parseWorkflowRegistry(
        path.join(REPO_ROOT, 'workflows', 'registry.yaml'),
      )
      assert.deepEqual(workflowRegistryResult.errors, [])
      const workflowEntry = workflowRegistryResult.entries.find(
        (entry) => entry.name === WORKFLOW_ID,
      )
      assert.ok(workflowEntry)

      const rootSessionId = `subscription-live-${randomUUID()}`
      const result = await runWorkflow({
        workflowEntry,
        teamRegistry: new Map(
          teamRegistryResult.entries.map((entry) => [entry.name, entry]),
        ),
        brief: 'Discuss recent United States foreign policy trends, pressure-test the main interpretations, and produce a concise general-reader brief.',
        workspacePath,
        spawnDepth: 0,
        rootSessionId,
        parentSessionId: rootSessionId,
        persistenceMode: 'ephemeral',
      })

      assert.equal(result.status, 'completed', result.summary)
      assert.deepEqual(
        result.steps.map((step) => step.stepId),
        ['debate-decompose', 'write'],
      )
      assert.ok(result.steps.every((step) => step.status === 'completed'))
      assert.ok(result.primaryArtifact)
      assert.equal(fs.existsSync(result.primaryArtifact), true)

      for (const step of result.steps) {
        const hostLog = fs.readFileSync(
          path.join(step.assignmentPath, 'logs', 'host-events.jsonl'),
          'utf8',
        )
        assert.match(hostLog, /"resolved_host_provider":"openai-codex"/)
        assert.doesNotMatch(hostLog, /openai-responses-api|invalid_api_key|\b401\b/)
      }

      const workerLogs = result.steps
        .map((step) => path.join(step.assignmentPath, 'logs', 'provider-events.jsonl'))
        .filter((filePath) => fs.existsSync(filePath))
        .map((filePath) => fs.readFileSync(filePath, 'utf8'))
        .join('\n')
      assert.match(workerLogs, /"provider":"codex"/)
      assert.doesNotMatch(workerLogs, /"provider":"(?:openai|anthropic|deepseek|xai)"/)
    } finally {
      for (const name of DIRECT_API_CREDENTIALS) {
        const value = originalCredentials[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      if (keepWorkspace) {
        process.stderr.write(`Preserved live workflow workspace: ${workspacePath}\n`)
      } else {
        fs.rmSync(workspacePath, { recursive: true, force: true })
      }
    }
  },
)
