/**
 * A level the runtime moves into after finishing a stage it ran itself is not
 * a stage the runtime owns.
 *
 * The runtime records ownership for whichever level is active once autostart
 * returns. If it recorded the finished stage's result against the level it
 * advanced into, the input handler would treat that level as runtime-owned and
 * swallow the user's message, and the level's coordinator would never hear it.
 *
 * Observed through the real `team-runtime/index.ts` booted on a two-level
 * fixture Team with no delegated autostart: a review stage the runtime runs
 * itself through a fake `claude` CLI, whose gate opens a routing level with a
 * coordinator.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { createFixtureHost } from '../support/team-runtime-fixture-boot.js'

const repoRoot = process.cwd()

/** Runtime modes an inherited environment could switch on for this boot. */
const INHERITED_RUNTIME_MODES = [
  'TEAM_DELEGATED_AUTOSTART',
  'TEAM_RUNTIME_FAULT_INJECT',
  'TEAM_RUNTIME_RECOVERY',
  'TEAM_CHAT_MODE',
  'TEAM_CONFIG_OVERRIDES_JSON',
  'TEAM_BOOT_ENTRY_JSON',
] as const

const DRAFT =
  'The revised teaching material opens with one worked example, states the learning goal in a single sentence, and closes with three practice questions that check the goal directly, so a reader can tell what changed and why.'

function persona(name: string, provider: string, model: string): string {
  return `---
name: ${name}
description: ${name}
provider: ${provider}
model: ${model}
thinking: low
---

You are ${name}.
`
}

function writeTeam(teamRoot: string): void {
  fs.mkdirSync(path.join(teamRoot, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(teamRoot, 'agents', 'writer.md'), persona('writer', 'claude', 'claude-haiku-4-5'))
  fs.writeFileSync(path.join(teamRoot, 'agents', 'editor.md'), persona('editor', 'claude', 'claude-haiku-4-5'))
  fs.writeFileSync(path.join(teamRoot, 'agents', 'lead.md'), persona('lead', 'lm-studio', 'local-model'))
  fs.writeFileSync(
    path.join(teamRoot, 'team.yaml'),
    `team:
  name: destination-ownership-team
  description: A review stage the runtime runs, then a coordinated routing stage.

workspace:
  path: workspace
  watch: false

agents:
  - name: writer
    type: agent
    role: Writes the draft.
    tools: []
    agent_file: ./agents/writer.md
    produces:
      - path: final-draft.md
  - name: editor
    type: agent
    role: Reviews the draft.
    tools: []
    agent_file: ./agents/editor.md
  - name: lead
    type: agent
    role: Routes the follow-up.
    agent_file: ./agents/lead.md
    produces:
      - path: routing-decision.md

levels:
  - id: review
    name: Review
    order: 0
    stage:
      type: review
      producer: writer
      reviewer: editor
      config:
        max_iterations: 2
        output:
          format: final-draft.md
          user_review: false
  - id: next
    name: Next
    order: 1
    stage:
      type: routing
      coordinator: lead
      config:
        output:
          format: routing-decision.md
          user_review: false

gates:
  - from: review
    to: next
    condition:
      type: artifact_exists
      artifact: final-draft.md
  - from: next
    to: done
    condition:
      type: artifact_exists
      artifact: routing-decision.md

workflow:
  entry_level: review
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
`,
  )
}

/** A `claude` that writes the draft for the writer and approves it for the editor. */
function writeFakeClaude(binRoot: string): void {
  fs.mkdirSync(binRoot, { recursive: true })
  fs.writeFileSync(
    path.join(binRoot, 'claude'),
    `#!/usr/bin/env node
const fs = require('node:fs')
const promptFile = process.argv[process.argv.indexOf('--system-prompt-file') + 1]
const systemPrompt = promptFile ? fs.readFileSync(promptFile, 'utf8') : ''
const result = systemPrompt.includes('You are writer.')
  ? ${JSON.stringify(DRAFT)}
  : '<review_decision>APPROVE</review_decision>\\n\\nThe draft meets the brief.'
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, model: 'claude-haiku-4-5', usage: { input_tokens: 5, output_tokens: 5 }, total_cost_usd: 0 }) + '\\n')
`,
    { mode: 0o700 },
  )
}

interface RuntimeEvent {
  readonly event?: unknown
  readonly level_id?: unknown
  readonly is_error?: unknown
}

function readRuntimeEvents(assignmentPath: string): RuntimeEvent[] {
  return fs
    .readFileSync(path.join(assignmentPath, 'logs', 'runtime-events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line): RuntimeEvent => JSON.parse(line))
}

test('a level entered after a runtime-run stage finishes is not runtime-owned, so user input reaches its coordinator', {
  timeout: 60_000,
  skip: process.platform === 'win32',
}, async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'destination-ownership-'))
  const teamRoot = path.join(fixtureRoot, 'team')
  const binRoot = path.join(fixtureRoot, 'bin')
  const workspace = path.join(fixtureRoot, 'workspace')
  writeTeam(teamRoot)
  writeFakeClaude(binRoot)
  const assignmentPath = path.join(
    workspace,
    'sessions',
    'session-destination-ownership',
    'runs',
    'run-destination-ownership',
    'assignments',
    'assignment-destination-ownership',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  fs.writeFileSync(path.join(assignmentPath, 'incoming-brief.md'), 'Revise the teaching material.')

  const previousEnv = { ...process.env }
  for (const key of INHERITED_RUNTIME_MODES) delete process.env[key]
  process.env.PATH = `${binRoot}${path.delimiter}${previousEnv.PATH ?? ''}`
  process.env.TEAM_CONFIG_PATH = path.join(teamRoot, 'team.yaml')
  process.env.TEAM_WORKSPACE_PATH = workspace
  process.env.TEAM_RUNTIME_START_SERVICES = '0'
  process.env.TEAM_RUNTIME_SESSION_ID = 'session-destination-ownership'
  process.env.TEAM_RUNTIME_RUN_ID = 'run-destination-ownership'
  process.env.TEAM_RUNTIME_ASSIGNMENT_ID = 'assignment-destination-ownership'
  process.env.TEAM_RUNTIME_TASK_ID = 'task-destination-ownership'
  process.env.TEAM_RUNTIME_PROCESS_IDENTITY = 'process-destination-ownership'
  process.env.TEAM_SESSION_ID = 'assignment-destination-ownership'
  process.env.TEAM_ROOT_SESSION_ID = 'session-destination-ownership'
  process.env.TEAM_INPUT_ARTIFACT = 'incoming-brief.md'
  process.env.TEAM_OUTPUT_ARTIFACT = 'unused-result.md'
  process.env.TEAM_RUNTIME_FILE_PARSER_ENTRY = path.join(repoRoot, 'file-parser/index.ts')

  const host = createFixtureHost(repoRoot)
  let booted = false
  try {
    const { default: teamRuntimeExtension } = await import('../../team-runtime/index.js')
    // The fixture host implements the part of Pi's extension API the runtime
    // uses; the full type is not constructible in a test.
    teamRuntimeExtension(host.pi as never)
    await host.callHandler('session_start')
    booted = true

    const events = readRuntimeEvents(assignmentPath)
    const diagnostics = JSON.stringify(events, null, 2)
    assert.ok(
      events.some((entry) => entry.event === 'runtime.stage_autostart.end' && entry.level_id === 'review' && entry.is_error === false),
      `the runtime must run and finish the review stage itself:\n${diagnostics}`,
    )
    assert.ok(
      events.some((entry) => entry.event === 'tools.registered' && entry.level_id === 'next'),
      `the review gate must move the run into the routing level:\n${diagnostics}`,
    )

    const inputResult = await host.callHandler('input', { type: 'input', text: 'Route the follow-up.', source: 'interactive' })
    assert.deepEqual(inputResult, { action: 'continue' }, 'the routing level is not runtime-owned, so the input goes to its coordinator')
  } finally {
    if (booted) await host.callHandler('session_shutdown')
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key]
    }
    Object.assign(process.env, previousEnv)
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
