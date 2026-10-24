import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { createFixtureHost } from '../support/team-runtime-fixture-boot.js'

const repoRoot = process.cwd()

/** The invocation source the runtime stamps on every dispatch it starts itself. */
const RUNTIME_AUTOSTART_SOURCE_ID = 'team-runtime:runtime-autostart'

interface RegisteredTool {
  readonly name: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const value: unknown = JSON.parse(line)
      assert.ok(isRecord(value), `${path.basename(filePath)} holds a non-object line: ${line}`)
      return value
    })
}

function writeAgent(filePath: string, name: string, role: string): void {
  fs.writeFileSync(
    filePath,
    `---
name: ${name}
description: ${role}
provider: claude
model: claude-haiku-4-5
thinking: low
---

You are ${name}. ${role}
`,
  )
}

test('a delegated Team chat lets a Claude CLI lead choose the roster and control continuation without a Pi host', async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-neutral-team-'))
  const teamRoot = path.join(fixtureRoot, 'team')
  const binRoot = path.join(fixtureRoot, 'bin')
  const workspace = path.join(fixtureRoot, 'workspace')
  const invocationLog = path.join(fixtureRoot, 'claude-invocations.txt')
  fs.mkdirSync(path.join(teamRoot, 'agents'), { recursive: true })
  fs.mkdirSync(binRoot, { recursive: true })

  writeAgent(path.join(teamRoot, 'agents', 'lead.md'), 'lead', 'Coordinates the discussion.')
  writeAgent(path.join(teamRoot, 'agents', 'specialist.md'), 'specialist', 'Reviews the material.')
  fs.writeFileSync(
    path.join(teamRoot, 'team.yaml'),
    `team:
  name: provider-neutral-team
  description: Provider-neutral coordinator acceptance fixture.

workspace:
  path: workspace
  watch: false

models:
  orchestration:
    provider: claude
    model: claude-haiku-4-5
    thinking: low
  strategic:
    provider: claude
    model: claude-haiku-4-5
    thinking: low

agents:
  - name: lead
    type: agent
    role: Coordinates the discussion.
    tier: orchestration
    tools: []
    agent_file: ./agents/lead.md
  - name: specialist
    type: agent
    role: Reviews the material.
    tier: strategic
    tools: []
    agent_file: ./agents/specialist.md

levels:
  - id: discuss
    name: Discuss
    order: 0
    stage:
      type: discussion
      coordinator: lead
      participants:
        - specialist
      config:
        mode: deliberate
        min_rounds: 1
        max_rounds: 2
        output:
          format: result.md
          user_review: false

gates: []

workflow:
  entry_level: discuss
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
`,
  )

  const fakeClaudePath = path.join(binRoot, 'claude')
  fs.writeFileSync(
    fakeClaudePath,
	`#!/usr/bin/env node
const fs = require('node:fs')
const hasSchema = process.argv.includes('--json-schema')
const previousInvocations = fs.existsSync(${JSON.stringify(invocationLog)})
  ? fs.readFileSync(${JSON.stringify(invocationLog)}, 'utf8').trim().split('\\n').filter(Boolean)
  : []
const coordinatorCount = previousInvocations.filter((kind) => kind === 'coordinator').length
const participantCount = previousInvocations.filter((kind) => kind === 'participant').length
fs.appendFileSync(${JSON.stringify(invocationLog)}, hasSchema ? 'coordinator\\n' : 'participant\\n')
const structuredOutput = coordinatorCount === 0
  ? {
      agents: ['specialist'],
      rosterRationale: { specialist: 'The request needs a teaching-material review.' },
    }
  : coordinatorCount === 1
    ? {
        decision: 'continue',
        reason: 'The first pass needs a concrete recommendation.',
        message: 'Turn the review into one concrete recommendation.',
        targets: ['specialist'],
      }
    : {
        decision: 'complete',
        reason: 'The second pass resolved the request.',
        finalResponse: 'The lead synthesis recommends the concrete teaching-material revision.',
      }
const payload = hasSchema
  ? {
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: structuredOutput,
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 5, output_tokens: 5 },
      total_cost_usd: 0,
    }
  : {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: participantCount === 0
        ? 'The specialist completed the first teaching-material review pass.'
        : 'The specialist completed the concrete recommendation pass.',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 5, output_tokens: 5 },
      total_cost_usd: 0,
    }
process.stdout.write(JSON.stringify(payload) + '\\n')
`,
    { mode: 0o700 },
  )

  const assignmentPath = path.join(
    workspace,
    'sessions',
    'session-provider-neutral',
    'runs',
    'run-provider-neutral',
    'assignments',
    'assignment-provider-neutral',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  fs.writeFileSync(path.join(assignmentPath, 'incoming-brief.md'), 'Evaluate this teaching material.')

  const previousEnv = { ...process.env }
  // Runtime modes an inherited environment could switch on; the finally block restores them.
  for (const key of ['TEAM_RUNTIME_FAULT_INJECT', 'TEAM_RUNTIME_RECOVERY', 'TEAM_CONFIG_OVERRIDES_JSON', 'TEAM_BOOT_ENTRY_JSON']) {
    delete process.env[key]
  }
  process.env.PATH = `${binRoot}${path.delimiter}${previousEnv.PATH ?? ''}`
  process.env.TEAM_CONFIG_PATH = path.join(teamRoot, 'team.yaml')
  process.env.TEAM_WORKSPACE_PATH = workspace
  process.env.TEAM_RUNTIME_START_SERVICES = '0'
  process.env.TEAM_RUNTIME_SESSION_ID = 'session-provider-neutral'
  process.env.TEAM_RUNTIME_RUN_ID = 'run-provider-neutral'
  process.env.TEAM_RUNTIME_ASSIGNMENT_ID = 'assignment-provider-neutral'
  process.env.TEAM_RUNTIME_TASK_ID = 'task-provider-neutral'
  process.env.TEAM_RUNTIME_PROCESS_IDENTITY = 'process-provider-neutral'
  process.env.TEAM_SESSION_ID = 'assignment-provider-neutral'
  process.env.TEAM_ROOT_SESSION_ID = 'session-provider-neutral'
  process.env.TEAM_INPUT_ARTIFACT = 'incoming-brief.md'
  process.env.TEAM_OUTPUT_ARTIFACT = 'unused-result.md'
  process.env.TEAM_DELEGATED_AUTOSTART = '1'
  process.env.TEAM_CHAT_MODE = '1'
  process.env.TEAM_RUNTIME_FILE_PARSER_ENTRY = path.join(repoRoot, 'file-parser/index.ts')

  try {
    const { default: teamRuntimeExtension } = await import('../../team-runtime/index.js')
    const handlers = new Map<string, (...args: never[]) => unknown>()
    const registered: RegisteredTool[] = []
    let hostModelSelections = 0
    const pi = {
      on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
      registerTool: (tool: RegisteredTool) => registered.push(tool),
      registerCommand: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      registerMessageRenderer: () => {},
      registerEntryRenderer: () => {},
      registerMarkdownTransformer: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      getActiveTools: () => registered.map((tool) => tool.name),
      getAllTools: () => registered.map((tool) => ({
        ...tool,
        sourceInfo: { path: path.join(repoRoot, 'team-runtime/index.ts') },
      })),
      setActiveTools: () => {},
      getCommands: () => [],
      setModel: async () => {
        hostModelSelections += 1
        return true
      },
      getThinkingLevel: () => 'medium',
      setThinkingLevel: () => {},
      registerProvider: () => {},
      unregisterProvider: () => {},
      events: { on: () => {}, off: () => {}, emit: () => {} },
    }
    const extensionContext = {
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      mode: 'headless',
      hasUI: false,
      cwd: repoRoot,
      sessionManager: {
        getEntries: () => [],
        getSessionId: () => 'pi-session',
        getSessionFile: () => undefined,
      },
      modelRegistry: { getAvailable: () => [], getAll: () => [] },
      model: undefined,
      scopedModels: [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      signal: undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => '',
    }

    teamRuntimeExtension(pi as never)
    const sessionStart = handlers.get('session_start')
    assert.ok(sessionStart, 'the extension must register session_start')
    await (sessionStart as (event: unknown, context: unknown) => Promise<void>)({}, extensionContext)

    const input = handlers.get('input')
    assert.ok(input, 'runtime-owned delegated execution must register an input interceptor')
    const inputResult = await (input as (
      event: unknown,
      context: unknown,
    ) => Promise<unknown>)({ type: 'input', text: 'Evaluate this teaching material.', source: 'interactive' }, extensionContext)
    assert.deepEqual(inputResult, { action: 'handled' })
    assert.equal(hostModelSelections, 0)
    const invocationKinds = fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
    const runtimeLogPath = path.join(assignmentPath, 'logs', 'runtime-events.jsonl')
    const runtimeLogBeforeShutdown = fs.existsSync(runtimeLogPath)
      ? fs.readFileSync(runtimeLogPath, 'utf8')
      : '(runtime log missing)'
    const logsRoot = path.join(assignmentPath, 'logs')
    const diagnosticLogs = fs.existsSync(logsRoot)
      ? fs.readdirSync(logsRoot)
          .map((name) => `${name}:\n${fs.readFileSync(path.join(logsRoot, name), 'utf8')}`)
          .join('\n')
      : runtimeLogBeforeShutdown
    assert.deepEqual(
      invocationKinds,
      ['coordinator', 'participant', 'coordinator', 'participant', 'coordinator'],
      diagnosticLogs,
    )

    const shutdown = handlers.get('session_shutdown')
    assert.ok(shutdown, 'the extension must register session_shutdown')
    await (shutdown as () => Promise<void>)()

    const runtimeEvents = fs.readFileSync(
      runtimeLogPath,
      'utf8',
    )
    assert.match(runtimeEvents, /"tool_name":"delegated_discussion_autostart"/)
    assert.match(runtimeEvents, /"event":"run\.completed"/)

    const messages = fs.readFileSync(
      path.join(assignmentPath, 'logs', 'team-chat-messages.jsonl'),
      'utf8',
    )
    const rosterIndex = messages.indexOf('Convening 1 of 1 Team members')
    const firstResponseIndex = messages.indexOf('first teaching-material review pass')
    const continuationIndex = messages.indexOf('Turn the review into one concrete recommendation')
    const secondResponseIndex = messages.indexOf('concrete recommendation pass')
    const synthesisIndex = messages.indexOf('The lead synthesis recommends')
    assert.ok(
      rosterIndex >= 0 &&
        firstResponseIndex > rosterIndex &&
        continuationIndex > firstResponseIndex &&
        secondResponseIndex > continuationIndex &&
        synthesisIndex > secondResponseIndex,
    )

    await t.test('every stage tool the discussion autostart dispatched is recorded under the runtime-autostart source', () => {
      const capabilityEvents = readJsonl(
        path.join(assignmentPath, 'logs', 'capability-dispatch-events.jsonl'),
      )
      const requested = capabilityEvents.filter(
        (event) => event.type === 'capability.dispatch.requested',
      )
      assert.deepEqual(
        requested.map((event) => event.capabilityId),
        [
          'team-runtime.engine.set_roster',
          'team-runtime.engine.create_brief',
          'team-runtime.engine.converse',
          'team-runtime.engine.converse',
        ],
      )
      for (const event of capabilityEvents) {
        assert.equal(
          event.sourceId,
          RUNTIME_AUTOSTART_SOURCE_ID,
          `${String(event.type)} for ${String(event.capabilityId)} must name the runtime-autostart source`,
        )
        assert.equal(event.sourceKind, 'engine')
      }
      assert.equal(
        capabilityEvents.filter((event) => event.type === 'capability.dispatch.completed').length,
        requested.length,
        'every autostart dispatch must complete',
      )
    })

    await t.test('each call the runtime makes to the discussion lead records the model selection the lead declared', () => {
      const leadStarts = readJsonl(path.join(assignmentPath, 'logs', 'agent-runs.jsonl')).filter(
        (event) => event.event === 'start' && event.agent_name === 'lead',
      )
      assert.deepEqual(
        leadStarts.map((event) => event.trigger_tool),
        [
          'delegated_discussion_plan',
          'delegated_discussion_decision',
          'delegated_discussion_decision',
        ],
      )
      for (const start of leadStarts) {
        assert.deepEqual(start.model_selection, {
          provider: 'claude',
          model: 'claude-haiku-4-5',
          source: 'agent',
          reason: 'explicit-agent-choice',
          caller: 'agent',
        })
      }
    })
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key]
    }
    Object.assign(process.env, previousEnv)
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('a runtime-owned review stage with no coordinator autostarts, is admitted and completes', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-owned-review-'))
  const teamRoot = path.join(fixtureRoot, 'team')
  const binRoot = path.join(fixtureRoot, 'bin')
  const workspace = path.join(fixtureRoot, 'workspace')
  const invocationLog = path.join(fixtureRoot, 'claude-invocations.txt')
  fs.mkdirSync(path.join(teamRoot, 'agents'), { recursive: true })
  fs.mkdirSync(binRoot, { recursive: true })

  writeAgent(path.join(teamRoot, 'agents', 'writer.md'), 'writer', 'Writes the draft.')
  writeAgent(path.join(teamRoot, 'agents', 'editor.md'), 'editor', 'Reviews the draft.')
  fs.writeFileSync(
    path.join(teamRoot, 'team.yaml'),
    `team:
  name: runtime-owned-review-team
  description: A review stage the runtime drives with no coordinator.

workspace:
  path: workspace
  watch: false

agents:
  - name: writer
    type: agent
    role: Writes the draft.
    tools: []
    agent_file: ./agents/writer.md
  - name: editor
    type: agent
    role: Reviews the draft.
    tools: []
    agent_file: ./agents/editor.md

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

gates: []

workflow:
  entry_level: review
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
`,
  )

  const draft =
    'The revised teaching material opens with one worked example, states the learning goal in a single sentence, ' +
    'and closes with three practice questions that check the goal directly, so a reader can tell what changed and why.'
  const fakeClaudePath = path.join(binRoot, 'claude')
  // The persona body names the agent, and the adapter passes it in a file, so
  // the fake answers by role rather than by call order.
  fs.writeFileSync(
    fakeClaudePath,
    `#!/usr/bin/env node
const fs = require('node:fs')
const promptFile = process.argv[process.argv.indexOf('--system-prompt-file') + 1]
const systemPrompt = promptFile ? fs.readFileSync(promptFile, 'utf8') : ''
const role = systemPrompt.includes('You are writer.')
  ? 'writer'
  : systemPrompt.includes('You are editor.')
    ? 'editor'
    : 'unknown'
fs.appendFileSync(${JSON.stringify(invocationLog)}, role + '\\n')
const result = role === 'writer'
  ? ${JSON.stringify(draft)}
  : '<review_decision>APPROVE</review_decision>\\n\\nThe draft covers the brief.'
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result,
  model: 'claude-haiku-4-5',
  usage: { input_tokens: 5, output_tokens: 5 },
  total_cost_usd: 0,
}) + '\\n')
`,
    { mode: 0o700 },
  )

  const assignmentPath = path.join(
    workspace,
    'sessions',
    'session-runtime-review',
    'runs',
    'run-runtime-review',
    'assignments',
    'assignment-runtime-review',
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  fs.writeFileSync(path.join(assignmentPath, 'incoming-brief.md'), 'Revise this teaching material.')

  const previousEnv = { ...process.env }
  // Runtime modes an inherited environment could switch on; the finally block restores them.
  for (const key of ['TEAM_RUNTIME_FAULT_INJECT', 'TEAM_RUNTIME_RECOVERY', 'TEAM_CHAT_MODE', 'TEAM_CONFIG_OVERRIDES_JSON', 'TEAM_BOOT_ENTRY_JSON']) {
    delete process.env[key]
  }
  process.env.PATH = `${binRoot}${path.delimiter}${previousEnv.PATH ?? ''}`
  process.env.TEAM_CONFIG_PATH = path.join(teamRoot, 'team.yaml')
  process.env.TEAM_WORKSPACE_PATH = workspace
  process.env.TEAM_RUNTIME_START_SERVICES = '0'
  process.env.TEAM_RUNTIME_SESSION_ID = 'session-runtime-review'
  process.env.TEAM_RUNTIME_RUN_ID = 'run-runtime-review'
  process.env.TEAM_RUNTIME_ASSIGNMENT_ID = 'assignment-runtime-review'
  process.env.TEAM_RUNTIME_TASK_ID = 'task-runtime-review'
  process.env.TEAM_RUNTIME_PROCESS_IDENTITY = 'process-runtime-review'
  process.env.TEAM_SESSION_ID = 'assignment-runtime-review'
  process.env.TEAM_ROOT_SESSION_ID = 'session-runtime-review'
  process.env.TEAM_INPUT_ARTIFACT = 'incoming-brief.md'
  process.env.TEAM_OUTPUT_ARTIFACT = 'unused-result.md'
  process.env.TEAM_DELEGATED_AUTOSTART = '1'
  process.env.TEAM_RUNTIME_FILE_PARSER_ENTRY = path.join(repoRoot, 'file-parser/index.ts')

  try {
    const { default: teamRuntimeExtension } = await import('../../team-runtime/index.js')
    const host = createFixtureHost(repoRoot)
    // The fake host stands in for Pi's ExtensionAPI, and the handler map is
    // typed loosely because each Pi event has its own signature.
    teamRuntimeExtension(host.pi as never)
    const sessionStart = host.handlers.get('session_start')
    assert.ok(sessionStart, 'the extension must register session_start')
    // Boot awaits the entry level's autostart, so the review loop has run when
    // this resolves.
    await (sessionStart as (event: unknown, context: unknown) => Promise<void>)(
      {},
      host.extensionContext,
    )
    const shutdown = host.handlers.get('session_shutdown')
    assert.ok(shutdown, 'the extension must register session_shutdown')
    await (shutdown as () => Promise<void>)()

    const logsRoot = path.join(assignmentPath, 'logs')
    const runtimeEvents = readJsonl(path.join(logsRoot, 'runtime-events.jsonl'))
    const invocations = fs.existsSync(invocationLog)
      ? fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
      : []
    assert.deepEqual(invocations, ['writer', 'editor'], JSON.stringify(runtimeEvents, null, 2))

    const autostartEnd = runtimeEvents.filter(
      (event) => event.event === 'runtime.stage_autostart.end',
    )
    assert.deepEqual(
      autostartEnd.map((event) => [event.tool_name, event.is_error]),
      [['submit_for_review', false]],
    )

    const capabilityEvents = readJsonl(path.join(logsRoot, 'capability-dispatch-events.jsonl'))
    assert.deepEqual(
      capabilityEvents.map((event) => [event.type, event.capabilityId, event.sourceId]),
      [
        ['capability.dispatch.requested', 'team-runtime.engine.submit_for_review', RUNTIME_AUTOSTART_SOURCE_ID],
        ['capability.dispatch.started', 'team-runtime.engine.submit_for_review', RUNTIME_AUTOSTART_SOURCE_ID],
        ['capability.dispatch.completed', 'team-runtime.engine.submit_for_review', RUNTIME_AUTOSTART_SOURCE_ID],
      ],
    )

    const toolUse = readJsonl(path.join(logsRoot, 'tool-use.jsonl'))
    assert.deepEqual(
      toolUse.filter((record) => record.policy_code !== undefined),
      [],
      'no tool call may be refused by the capability policy',
    )
    assert.ok(
      toolUse.some(
        (record) =>
          record.tool_name === 'submit_for_review' &&
          record.runtime_autostart === true &&
          record.is_error === false,
      ),
      JSON.stringify(toolUse, null, 2),
    )

    assert.equal(
      fs.readFileSync(path.join(assignmentPath, 'final-draft.md'), 'utf8').includes(draft),
      true,
      'the approved draft must be published as the stage output',
    )
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key]
    }
    Object.assign(process.env, previousEnv)
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
