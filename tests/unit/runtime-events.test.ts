import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  buildArtifactMetadata,
  publishRuntimeArtifactWrittenEvent,
  writeMarkdownArtifact,
} from '../../domains/runtime/artifacts.js'
import { getAssignmentLogPath, logAgentRun, logHostEvent, logSessionStart, logToolUse } from '../../domains/runtime/logger.js'
import { publishEngineEvent, subscribeEngineEvents } from '../../domains/runtime/runtime-events.js'

test('logSessionStart initializes engine-events.jsonl', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-events-init-'))

  try {
    logSessionStart(outputDir, 'session-1', 'writing-team', ['editor'], 'root-1')
    assert.ok(fs.existsSync(getAssignmentLogPath(outputDir, 'engine-events.jsonl')))
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('agent run logging publishes typed engine events with schema version and tenant', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-events-agent-'))
  const received: Array<Record<string, unknown>> = []
  const unsubscribe = subscribeEngineEvents((event) => {
    if (event.run_id === 'session-2') received.push(event as unknown as Record<string, unknown>)
  })

  try {
    logAgentRun(outputDir, {
      timestamp: new Date().toISOString(),
      event: 'start',
      session_id: 'session-2',
      root_session_id: 'root-2',
      assignment_path: outputDir,
      team: 'writing-team',
      level_id: 'draft',
      stage_type: 'pipeline',
      trigger_tool: 'dispatch',
      agent_name: 'writer',
      agent_id: 'market-analysis',
      agent_display_name: 'Market Analysis Specialist',
      activity_scope_id: 'market-analysis',
      agent_type: 'agent',
      from: 'writing-team',
      to: 'writer',
      status: 'active',
      model: 'gpt-5.4-mini',
      provider: 'openai',
    })

    const raw = fs.readFileSync(getAssignmentLogPath(outputDir, 'engine-events.jsonl'), 'utf8').trim().split('\n')
    const persisted = JSON.parse(raw.at(-1) ?? '{}') as Record<string, unknown>

    assert.equal(persisted.schema_version, 1)
    assert.equal(persisted.tenant_id, 'local')
    assert.equal(persisted.category, 'agent')
    assert.equal(persisted.type, 'agent.start')
    assert.equal(persisted.run_id, 'session-2')
    const payload = persisted.payload as Record<string, unknown>
    assert.equal(payload.agent_name, 'writer')
    assert.equal(payload.agent_id, 'market-analysis')
    assert.equal(payload.agent_display_name, 'Market Analysis Specialist')
    assert.equal(payload.activity_scope_id, 'market-analysis')
    assert.equal(received.length, 1)
  } finally {
    unsubscribe()
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('publishEngineEvent notifies subscribers even when outputDir is undefined', () => {
  const received: Array<Record<string, unknown>> = []
  const unsubscribe = subscribeEngineEvents((event) => {
    if (event.type === 'runtime.no_persist') received.push(event as unknown as Record<string, unknown>)
  })

  try {
    const event = publishEngineEvent(undefined, {
      timestamp: new Date().toISOString(),
      category: 'runtime',
      type: 'runtime.no_persist',
      run_id: 'session-no-persist',
      payload: { ok: true },
    })

    assert.equal(event.type, 'runtime.no_persist')
    assert.equal(received.length, 1)
    assert.equal(requiredValue(received[0], 'tests/unit/runtime-events.test.ts:93').run_id, 'session-no-persist')
  } finally {
    unsubscribe()
  }
})

test('unsubscribe stops future engine events from reaching the subscriber', () => {
  const received: Array<Record<string, unknown>> = []
  const unsubscribe = subscribeEngineEvents((event) => {
    if (event.type.startsWith('runtime.unsubscribe')) {
      received.push(event as unknown as Record<string, unknown>)
    }
  })

  publishEngineEvent(undefined, {
    timestamp: new Date().toISOString(),
    category: 'runtime',
    type: 'runtime.unsubscribe.before',
    run_id: 'session-unsubscribe',
    payload: {},
  })

  unsubscribe()

  publishEngineEvent(undefined, {
    timestamp: new Date().toISOString(),
    category: 'runtime',
    type: 'runtime.unsubscribe.after',
    run_id: 'session-unsubscribe',
    payload: {},
  })

  assert.equal(received.length, 1)
  assert.equal(requiredValue(received[0], 'tests/unit/runtime-events.test.ts:126').type, 'runtime.unsubscribe.before')
})

test('publishEngineEvent delivers the same event to multiple subscribers exactly once', () => {
  let firstCount = 0
  let secondCount = 0
  const unsubscribeFirst = subscribeEngineEvents((event) => {
    if (event.type === 'runtime.multi_subscriber') firstCount++
  })
  const unsubscribeSecond = subscribeEngineEvents((event) => {
    if (event.type === 'runtime.multi_subscriber') secondCount++
  })

  try {
    publishEngineEvent(undefined, {
      timestamp: new Date().toISOString(),
      category: 'runtime',
      type: 'runtime.multi_subscriber',
      run_id: 'session-multi',
      payload: {},
    })

    assert.equal(firstCount, 1)
    assert.equal(secondCount, 1)
  } finally {
    unsubscribeFirst()
    unsubscribeSecond()
  }
})

test('publishEngineEvent preserves custom tenant and run lineage fields', () => {
  const event = publishEngineEvent(undefined, {
    timestamp: new Date().toISOString(),
    tenant_id: 'workspace-a',
    category: 'delegation',
    type: 'delegation.child_started',
    run_id: 'child-run',
    root_run_id: 'root-run',
    parent_run_id: 'parent-run',
    assignment_path: '/tmp/assignment',
    team: 'writing-team',
    level_id: 'draft',
    stage_type: 'pipeline',
    payload: { child: true },
  })

  assert.equal(event.tenant_id, 'workspace-a')
  assert.equal(event.run_id, 'child-run')
  assert.equal(event.root_run_id, 'root-run')
  assert.equal(event.parent_run_id, 'parent-run')
  assert.equal(event.assignment_path, '/tmp/assignment')
})

test('engine event log appends events in order across multiple writes', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-events-order-'))

  try {
    logSessionStart(outputDir, 'session-order', 'writing-team', ['writer'], 'root-order')
    logToolUse(outputDir, 'dispatch', 'tool-1', false, 'root-order', {
      session_id: 'session-order',
      level_id: 'draft',
      stage_type: 'pipeline',
      team: 'writing-team',
    })
    logHostEvent(outputDir, {
      timestamp: new Date().toISOString(),
      event: 'host.custom',
      session_id: 'session-order',
      root_session_id: 'root-order',
      assignment_path: outputDir,
      team: 'writing-team',
      level_id: 'draft',
      stage_type: 'pipeline',
    })

    const persisted = fs.readFileSync(getAssignmentLogPath(outputDir, 'engine-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    const eventTypes = persisted.map((event) => event.type)
    assert.deepEqual(eventTypes.slice(-3), [
      'run.session_started',
      'tool.execution_logged',
      'host.custom',
    ])
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('a tool event without a session id is attributed to the run that owns the log', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-events-attribution-'))
  const outputDir = path.join(workspace, 'assignments', 'child-run')
  fs.mkdirSync(outputDir, { recursive: true })

  try {
    // Runtime-autostart tool calls carry no session id of their own. Without a
    // run they are absorbed by the root run, which renders them under the wrong
    // team and at the wrong delegation depth.
    logToolUse(outputDir, 'handoff', 'runtime-autostart-handoff', false, 'root-run', {
      runtime_autostart: true,
      level_id: 'extract',
      stage_type: 'chain',
    })

    const persisted = fs.readFileSync(getAssignmentLogPath(outputDir, 'engine-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    assert.equal(persisted.at(-1)?.type, 'tool.execution_logged')
    assert.equal(persisted.at(-1)?.run_id, 'child-run')
    assert.equal(persisted.at(-1)?.root_run_id, 'root-run')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('an explicit session id still wins over the owning run fallback', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-events-explicit-'))

  try {
    logToolUse(outputDir, 'dispatch', 'tool-9', false, 'root-run', {
      session_id: 'declared-run',
    })

    const persisted = fs.readFileSync(getAssignmentLogPath(outputDir, 'engine-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    assert.equal(persisted.at(-1)?.run_id, 'declared-run')
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('writing a runtime-owned artifact publishes an artifact engine event', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-events-artifact-'))
  const filePath = path.join(outputDir, 'report.md')

  try {
    logSessionStart(outputDir, 'session-3', 'writing-team', ['writer'], 'root-3')
    const metadata = buildArtifactMetadata({
      filePath,
      rootDir: outputDir,
      artifactType: 'report',
      sessionId: 'session-3',
      rootSessionId: 'root-3',
      team: 'writing-team',
      level: 'final',
      stageType: 'review',
      title: 'Final Report',
    })

    writeMarkdownArtifact(filePath, '# Report\n', metadata)

    const raw = fs.readFileSync(getAssignmentLogPath(outputDir, 'engine-events.jsonl'), 'utf8').trim().split('\n')
    const persisted = raw.map((line) => JSON.parse(line) as Record<string, unknown>)
    const artifactEvent = persisted.find((event) => event.type === 'artifact.written')

    assert.ok(artifactEvent)
    assert.equal(artifactEvent?.category, 'artifact')
    assert.equal((artifactEvent?.payload as Record<string, unknown>).artifact_type, 'report')
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('publishing a machine-owned JSON artifact creates a secure inspectable event', () => {
  const outputDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'engine-events-json-artifact-')),
  )
  const relativePath = 'research/evidence/wave-0/T1.json'
  const artifactPath = path.join(outputDir, relativePath)

  try {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
    fs.writeFileSync(artifactPath, '{"claim":"verified"}\n')
    logSessionStart(outputDir, 'research-child', 'research-team', ['web-researcher'], 'root-run')

    publishRuntimeArtifactWrittenEvent({
      outputDir,
      relativePath,
      artifactType: 'research-evidence',
      artifactRole: 'intermediate',
      sessionId: 'research-child',
      rootSessionId: 'root-run',
      team: 'research-team',
      agentId: 'lane-market',
      agentName: 'Market Analyst',
      agentBaseName: 'web-researcher',
      activityScopeId: 'lane-market',
      emitterName: 'source-observation-store',
      title: 'Evidence T1',
    })

    const persisted = fs.readFileSync(
      getAssignmentLogPath(outputDir, 'engine-events.jsonl'),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const artifactEvent = persisted.at(-1)
    const payload = artifactEvent?.payload as Record<string, unknown>
    assert.equal(artifactEvent?.type, 'artifact.written')
    assert.equal(artifactEvent?.run_id, 'research-child')
    assert.equal(artifactEvent?.root_run_id, 'root-run')
    assert.equal(payload.path, relativePath)
    assert.equal(payload.artifact_type, 'research-evidence')
    assert.equal(payload.artifact_role, 'intermediate')
    assert.equal(payload.agent_id, 'lane-market')
    assert.equal(payload.agent_name, 'Market Analyst')
    assert.equal(payload.agent_base_name, 'web-researcher')
    assert.equal(payload.activity_scope_id, 'lane-market')
    assert.equal(payload.emitter_name, 'source-observation-store')
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('machine-owned artifact events reject traversal and symlink paths', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'engine-events-json-safety-')),
  )
  const outputDir = path.join(root, 'assignment')
  const outsidePath = path.join(root, 'outside.json')

  try {
    fs.mkdirSync(path.join(outputDir, 'research'), { recursive: true })
    fs.writeFileSync(outsidePath, '{}\n')
    fs.symlinkSync(outsidePath, path.join(outputDir, 'research', 'linked.json'))

    assert.throws(() => publishRuntimeArtifactWrittenEvent({
      outputDir,
      relativePath: '../outside.json',
      artifactType: 'research-evidence',
    }), /unsafe/)
    assert.throws(() => publishRuntimeArtifactWrittenEvent({
      outputDir,
      relativePath: 'research/linked.json',
      artifactType: 'research-evidence',
    }), /contained regular file/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('writing a nested runtime-owned artifact preserves assignment path and lineage', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-events-artifact-nested-'))
  const filePath = path.join(outputDir, 'output', 'report.md')

  try {
    logSessionStart(outputDir, 'session-4', 'writing-team', ['writer'], 'root-4')
    const metadata = buildArtifactMetadata({
      filePath,
      rootDir: outputDir,
      artifactType: 'report',
      sessionId: 'session-4',
      rootSessionId: 'root-4',
      parentSessionId: 'parent-4',
      team: 'writing-team',
      level: 'final',
      stageType: 'review',
      title: 'Nested Report',
    })

    writeMarkdownArtifact(filePath, '# Nested Report\n', metadata)

    const persisted = fs.readFileSync(getAssignmentLogPath(outputDir, 'engine-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const artifactEvent = persisted.find((event) => event.type === 'artifact.written') as Record<string, unknown> | undefined

    assert.ok(artifactEvent)
    assert.equal(artifactEvent.assignment_path, outputDir)
    assert.equal(artifactEvent.run_id, 'session-4')
    assert.equal(artifactEvent.root_run_id, 'root-4')
    assert.equal(artifactEvent.parent_run_id, 'parent-4')
    assert.equal((artifactEvent.payload as Record<string, unknown>).path, path.join('output', 'report.md'))
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})
