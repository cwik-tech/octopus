import { whenDefined } from '../../core/optional-properties.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  buildDelegationSourceAppendix,
  createSpawnTeamTool,
  extractLocalArtifactPaths,
  resolveDelegationSourceBriefForTest,
} from '../../engines/spawn-tools.js'
import { AGENT_STATE } from '../../core/constants.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'
import type { AgentMetrics, RuntimeState, TeamConfig, TeamRegistryEntry } from '../../core/types.js'
import { buildSessionRunAssignmentLocation, type RunAssignmentLocation } from '../../domains/run/run-location.js'

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-tool-test-'))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function findDelegationArtifact(
  dir: string,
  team: string,
  kind: 'brief' | 'result',
): string {
  const prefix = `delegation-${team}-`
  const suffix = `-${kind}.md`
  const matches = fs.readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
    .sort()
  assert.equal(matches.length, 1, `expected one ${kind} artifact for ${team}`)
  return path.join(dir, matches[0]!)
}

function createState(): RuntimeState {
  return {
    sessionId: 'test-session',
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: 0,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
    rootSessionId: 'root-session',
    
  }
}

function createTeamConfig(): TeamConfig {
  return {
    team: { name: 'reception-desk', description: 'test', version: '0.1.0' },
    workspace: { path: '/tmp/workspace', watch: false },
    agents: [
      {
        name: 'research-team',
        type: 'team',
        role: 'Research specialists',
        tier: 'strategic',
        agent_file: './unused.md',
        color: 141,
        host_model: 'gpt-5.4-mini',
        team_path: './child-team',
      },
    ],
    levels: [],
    gates: [],
    composition: {
      spawn_limits: {
        maxDepth: 3,
        maxConcurrent: 1,
        maxTotalBudgetUsd: 50,
      },
    },
  }
}

function writeChildTeamConfig(dir: string, completionArtifact = 'output/research.md'): void {
  fs.writeFileSync(path.join(dir, 'team.yaml'), `
team:
  name: child-team
  description: child team fixture
  version: '0.1.0'

workspace:
  path: ./workspace
  watch: false

workflow:
  entry_level: build
  invocation_modes:
    - team
  capabilities:
    - research
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
  output_contract:
    artifacts:
      - path: ${completionArtifact}
        required: true
    completion_artifact: ${completionArtifact}

models:
  orchestration:
    model: test
    thinking: high
  strategic:
    model: test
    thinking: medium
  execution:
    model: test
    thinking: low

agents:
  - name: worker
    type: agent
    role: worker
    tier: execution
    agent_file: ./worker.md
    produces:
      - path: ${completionArtifact}

levels:
  - id: build
    name: Build
    order: 0
    stage:
      type: chain
      sequence:
        - worker
      config:
        output:
          format: ${completionArtifact}
          user_review: false

gates:
  - from: build
    to: done
    condition:
      type: artifact_exists
      artifact: ${completionArtifact}
`)
  fs.writeFileSync(path.join(dir, 'worker.md'), '# worker')
}

test('spawn_team rejects when current level does not allow spawning', async () => {
  await withTempDir(async (dir) => {
    const entry: TeamRegistryEntry = {
      name: 'research-team',
      type: 'team',
      team_path: dir,
    }
    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: false },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    })

    await assert.rejects(
      tool.execute('call-1', { team: 'research-team', brief: 'Investigate' }, undefined as any, undefined as any, undefined as any),
      /not enabled/,
    )
  })
})

test('spawn_team rejects unknown team names with available options', async () => {
  await withTempDir(async (dir) => {
    const entry: TeamRegistryEntry = {
      name: 'research-team',
      type: 'team',
      team_path: dir,
    }
    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    })

    await assert.rejects(
      tool.execute('call-1', { team: 'writing-team', brief: 'Draft' }, undefined as any, undefined as any, undefined as any),
      /Available registered teams: research-team/,
    )
  })
})

test('spawn_team writes delegation artifacts and returns child result', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'output/research.md')

    const entry: TeamRegistryEntry = {
      name: 'research-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'output/research.md',
    }

    const state = createState()
    const activeSpawnCountRef = { count: 0 }
    let capturedRootSessionId: string | undefined
    let capturedParentSessionId: string | undefined
    let capturedChildSessionId: string | undefined
    let capturedParentAssignmentLocation: RunAssignmentLocation | undefined
    const assignmentLocation = buildSessionRunAssignmentLocation('/tmp/workspace', {
      sessionId: 'product-session',
      runId: 'root-session',
      assignmentId: 'test-session',
    })
    assert.ok(assignmentLocation)
    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state,
      assignmentLocation,
      activeSpawnCountRef,
    }, {
      runTeamImpl: async (options) => {
        capturedRootSessionId = options.rootSessionId
        capturedParentSessionId = options.parentSessionId
        capturedChildSessionId = options.childSessionId
        capturedParentAssignmentLocation = options.parentAssignmentLocation
        return {
          text: '---\nartifact_type: "report"\n---\n# Research\n\nFindings here.',
          cost: 1.25,
          durationMs: 10,
          artifactPath: path.join(childDir, 'output', 'research.md'),
          assignmentPath: path.join(dir, 'workspace', 'assignments', options.childSessionId!),
          childSessionId: options.childSessionId!,
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    const result = await tool.execute(
      'call-1',
      { team: 'research-team', brief: 'Investigate the market', rationale: 'Needs specialist research' },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    const text = (result.content?.[0] as { text?: string })?.text ?? ''
    assert.match(text, /Spawned team: research-team/)
    assert.match(text, /# Research/)
    assert.equal(state.totalCost, 1.25)
    assert.equal(activeSpawnCountRef.count, 0)
    assert.equal(capturedRootSessionId, 'root-session')
    assert.equal(capturedParentSessionId, 'test-session')
    assert.match(capturedChildSessionId ?? '', /^child-research-team-[0-9a-f-]{36}$/)
    assert.deepEqual(capturedParentAssignmentLocation, assignmentLocation)

    const briefPath = findDelegationArtifact(dir, 'research-team', 'brief')
    const resultPath = findDelegationArtifact(dir, 'research-team', 'result')
    const routingDecisionPath = path.join(dir, 'routing-decision.md')
    const spawnLogPath = getAssignmentLogPath(dir, 'team-spawns.jsonl')
    const delegationsLogPath = getAssignmentLogPath(dir, 'delegations.jsonl')
    const lifecycleLogPath = getAssignmentLogPath(dir, 'delegation-lifecycle.jsonl')
    const lifecycleStatePath = getAssignmentLogPath(dir, 'delegation-state.json')
    assert.ok(fs.existsSync(briefPath))
    assert.ok(fs.existsSync(resultPath))
    assert.ok(fs.existsSync(routingDecisionPath))
    assert.ok(fs.existsSync(spawnLogPath))
    assert.ok(fs.existsSync(delegationsLogPath))
    assert.ok(fs.existsSync(lifecycleLogPath))
    assert.ok(fs.existsSync(lifecycleStatePath))
    assert.match(fs.readFileSync(briefPath, 'utf8'), /"requested_result_type": "artifact:output\/research\.md"/)
    assert.match(fs.readFileSync(resultPath, 'utf8'), /"result_type": "artifact:output\/research\.md"/)
    assert.match(fs.readFileSync(resultPath, 'utf8'), /Findings here\./)
    assert.match(fs.readFileSync(routingDecisionPath, 'utf8'), /Delegated to: research-team/)
    assert.match(fs.readFileSync(routingDecisionPath, 'utf8'), /Result type: artifact:output\/research\.md/)
    assert.match(fs.readFileSync(briefPath, 'utf8'), /from: "reception-desk"/)
    assert.match(fs.readFileSync(briefPath, 'utf8'), /to: "research-team"/)
    assert.match(fs.readFileSync(resultPath, 'utf8'), /from: "research-team"/)
    assert.match(fs.readFileSync(resultPath, 'utf8'), /to: "reception-desk"/)

    const spawnEvents = fs.readFileSync(spawnLogPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    assert.equal(spawnEvents.length, 1)
    assert.equal(spawnEvents[0].parent_team, 'reception-desk')
    assert.equal(spawnEvents[0].from, 'reception-desk')
    assert.equal(spawnEvents[0].to, 'research-team')
    assert.equal(spawnEvents[0].child_team, 'research-team')
    assert.equal(spawnEvents[0].spawn_depth, 1)
    assert.equal(spawnEvents[0].root_session_id, 'root-session')
    assert.match(spawnEvents[0].brief_preview, /Investigate the market/)

    const delegationEvents = fs.readFileSync(delegationsLogPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    assert.equal(delegationEvents.length, 3)
    assert.equal(delegationEvents[0].status, 'validating_contract')
    assert.equal(delegationEvents[1].status, 'accepted')
    assert.equal(delegationEvents[2].status, 'completed')
    assert.equal(delegationEvents[2].requested_result_type, 'artifact:output/research.md')

    const lifecycleEvents = fs.readFileSync(lifecycleLogPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      lifecycleEvents.map((event) => event.status),
      ['queued', 'validating_contract', 'accepted', 'running', 'completed'],
    )
    const lifecycleState = JSON.parse(fs.readFileSync(lifecycleStatePath, 'utf8'))
    const latestLifecycle = Object.values(lifecycleState)[0] as Record<string, unknown>
    assert.equal(latestLifecycle.status, 'completed')
    assert.equal(latestLifecycle.lastArtifact, path.join(childDir, 'output', 'research.md'))
  })
})

test('spawn_team atomically reserves maxConcurrent before awaiting execution', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'output/research.md')
    const entry: TeamRegistryEntry = {
      name: 'research-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'output/research.md',
    }
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let calls = 0
    const activeSpawnCountRef = { count: 0 }
    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef,
    }, {
      runTeamImpl: async (options) => {
        calls += 1
        markStarted()
        await firstMayFinish
        return {
          text: '# Research\n\nDone.',
          cost: 0,
          durationMs: 1,
          artifactPath: path.join(childDir, 'output', 'research.md'),
          assignmentPath: path.join(dir, 'assignments', options.childSessionId!),
          childSessionId: options.childSessionId!,
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    const first = tool.execute('first-slot', {
      team: entry.name,
      brief: 'First.',
    }, undefined as any, undefined as any, undefined as any)
    await started
    const secondRejected = assert.rejects(
      tool.execute('second-slot', {
        team: entry.name,
        brief: 'Second.',
      }, undefined as any, undefined as any, undefined as any),
      /max concurrent/i,
    )
    assert.equal(activeSpawnCountRef.count, 1)
    releaseFirst()
    await first
    await secondRejected
    assert.equal(calls, 1)
    assert.equal(activeSpawnCountRef.count, 0)
  })
})

test('spawn_team binds the latest completed child artifact for deictic continuation briefs', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'final-draft.md')

    const previousChildArtifact = path.join(dir, 'previous-result.md')
    fs.writeFileSync(previousChildArtifact, '# Prior Result\n\nActual discussion body.')
    const delegationsLogPath = getAssignmentLogPath(dir, 'delegations.jsonl')
    fs.mkdirSync(path.dirname(delegationsLogPath), { recursive: true })
    fs.writeFileSync(
      delegationsLogPath,
      JSON.stringify({
        status: 'completed',
        to_team: 're-randal-team',
        child_output_artifact: previousChildArtifact,
      }) + '\n',
    )

    const entry: TeamRegistryEntry = {
      name: 'writing-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'final-draft.md',
    }

    let capturedBrief = ''
    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      stageType: 'routing',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    }, {
      runTeamImpl: async (options) => {
        capturedBrief = options.brief
        return {
          text: '# Summary\n\nDone.',
          cost: 0,
          durationMs: 10,
          artifactPath: path.join(childDir, 'final-draft.md'),
          assignmentPath: path.join(dir, 'workspace', 'assignments', 'child-session'),
          childSessionId: 'child-session',
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    await tool.execute(
      'call-continuation',
      { team: 'writing-team', brief: 'Write an executive summary for this.' },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(capturedBrief, /Use the latest completed child artifact/)
    assert.match(capturedBrief, /previous-result\.md/)
    assert.match(capturedBrief, /Embedded Source Artifacts/)
    assert.match(capturedBrief, /Actual discussion body\./)
  })
})

test('spawn_team embeds referenced local source artifacts into the delegated brief', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'final-draft.md')

    const sourcePath = path.join(dir, 'source.md')
    fs.writeFileSync(sourcePath, '# Source\n\nImportant findings go here.\n')

    const entry: TeamRegistryEntry = {
      name: 'writing-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'final-draft.md',
    }

    let capturedBrief = ''
    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      stageType: 'routing',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
      getCurrentCoordinatorRunId: () => 1,
    }, {
      runTeamImpl: async (options) => {
        capturedBrief = options.brief
        return {
          text: '# Final Draft',
          cost: 0,
          durationMs: 1,
          artifactPath: path.join(dir, 'child-assignment', 'final-draft.md'),
          assignmentPath: path.join(dir, 'child-assignment'),
          childSessionId: 'child-session',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
          requestedResultType: 'artifact:final-draft.md',
        }
      },
    })

    await tool.execute(
      'call-1',
      { team: 'writing-team', brief: `Summarize this source document: ${sourcePath}.` },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.match(capturedBrief, /## Embedded Source Artifacts/)
    assert.match(capturedBrief, /Important findings go here\./)

    const delegationBrief = fs.readFileSync(findDelegationArtifact(dir, 'writing-team', 'brief'), 'utf8')
    assert.match(delegationBrief, /## Embedded Source Artifacts/)
    assert.match(delegationBrief, /Important findings go here\./)
  })
})

test('spawn_team marks delegated team metrics active and then done', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'output/research.md')

    const entry: TeamRegistryEntry = {
      name: 'research-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'output/research.md',
    }

    const agentMetrics = new Map<string, AgentMetrics>([
      ['research-team', {
        state: AGENT_STATE.IDLE,
        rounds: 0,
        totalCost: 0,
        contextTokens: 0,
        model: 'gpt-5.4-mini',
        color: 141,
        failureCount: 0,
      }],
    ])

    let sawActiveState = false
    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      agentMetrics,
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    }, {
      runTeamImpl: async () => {
        sawActiveState = agentMetrics.get('research-team')?.state === AGENT_STATE.ACTIVE
        return {
          text: '# Research\n\nFindings here.',
          cost: 0.75,
          durationMs: 10,
          artifactPath: path.join(childDir, 'output', 'research.md'),
          assignmentPath: path.join(dir, 'workspace', 'assignments', 'child-session'),
          childSessionId: 'child-session',
          requestedResultType: 'artifact:output/research.md',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    await tool.execute(
      'call-1',
      { team: 'research-team', brief: 'Investigate the market' },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.equal(sawActiveState, true)
    assert.equal(agentMetrics.get('research-team')?.state, AGENT_STATE.DONE)
    assert.equal(agentMetrics.get('research-team')?.totalCost, 0.75)
  })
})

test('spawn_team marks blocked team metrics without counting a provider failure', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'output/research.md')

    const entry: TeamRegistryEntry = {
      name: 'research-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'output/research.md',
    }

    const agentMetrics = new Map<string, AgentMetrics>([
      ['research-team', {
        state: AGENT_STATE.IDLE,
        rounds: 0,
        totalCost: 0,
        contextTokens: 0,
        model: 'gpt-5.4-mini',
        color: 141,
        failureCount: 0,
      }],
    ])

    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      agentMetrics,
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    }, {
      runTeamImpl: async () => ({
        text: 'Child stage blocked',
        cost: 0.3,
        durationMs: 10,
        artifactPath: path.join(childDir, 'output', 'research.md'),
        assignmentPath: path.join(dir, 'workspace', 'assignments', 'child-session'),
        childSessionId: 'child-session',
        requestedResultType: 'artifact:output/research.md',
        succeeded: false,
        exitCode: 1,
        exitSignal: null,
      }),
    })

    await assert.rejects(
      tool.execute(
        'call-1',
        { team: 'research-team', brief: 'Investigate the market' },
        undefined as any,
        undefined as any,
        undefined as any,
      ),
    )

    assert.equal(agentMetrics.get('research-team')?.state, AGENT_STATE.ERROR)
    assert.equal(agentMetrics.get('research-team')?.failureCount, 0)
    assert.match(agentMetrics.get('research-team')?.lastError ?? '', /blocked/i)
  })
})

test('spawn_team writes a runtime-owned job request and user-facing routing envelope for routing stages', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'final-draft.md')

    const entry: TeamRegistryEntry = {
      name: 'writing-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'final-draft.md',
    }

    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      stageType: 'routing',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
      getCurrentCoordinatorRunId: () => 1,
    }, {
      runTeamImpl: async (options) => ({
        text: '# Final Draft\n\nMicrosoft one-pager ready.',
        cost: 0.5,
        durationMs: 10,
        artifactPath: path.join(childDir, 'final-draft.md'),
        assignmentPath: path.join(dir, 'workspace', 'assignments', 'child-session'),
        childSessionId: 'child-session',
        ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
        succeeded: true,
        exitCode: 0,
        exitSignal: null,
      }),
    })

    await tool.execute(
      'call-1',
      { team: 'writing-team', brief: 'Create a 1 page report on Microsoft.', rationale: 'Writing request.' },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    const jobRequestPath = path.join(dir, 'job-request.md')
    const routingDecisionPath = path.join(dir, 'routing-decision.md')

    assert.ok(fs.existsSync(jobRequestPath))
    assert.ok(fs.existsSync(routingDecisionPath))
    assert.match(fs.readFileSync(jobRequestPath, 'utf8'), /# Job Request/)
    assert.match(fs.readFileSync(jobRequestPath, 'utf8'), /"target_team": "writing-team"/)
    assert.match(fs.readFileSync(jobRequestPath, 'utf8'), /"request_type": "writing"/)
    assert.match(fs.readFileSync(routingDecisionPath, 'utf8'), /## User Result Envelope/)
    assert.match(fs.readFileSync(routingDecisionPath, 'utf8'), /"status": "completed"/)
    assert.match(fs.readFileSync(routingDecisionPath, 'utf8'), /"primary_artifact":/)
    assert.match(fs.readFileSync(routingDecisionPath, 'utf8'), /Job request:/)
  })
})

test('spawn_team automatically attaches the active parsed input bundle for routing-stage delegation', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'final-draft.md')

    const parsedDir = path.join(dir, 'input-files', 'parsed')
    fs.mkdirSync(parsedDir, { recursive: true })
    const structuredPath = path.join(parsedDir, 'source.pdf.structure.md')
    fs.writeFileSync(structuredPath, '# Structured Source\n\nImportant structured findings.')

    const entry: TeamRegistryEntry = {
      name: 'writing-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'final-draft.md',
    }

    let capturedBrief = ''
    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      stageType: 'routing',
      outputPath: dir,
      teamRootPath: dir,
      inputFilesContent: '## source.pdf.structure.md\n\nImportant structured findings.',
      state: createState(),
      activeSpawnCountRef: { count: 0 },
      getCurrentCoordinatorRunId: () => 1,
    }, {
      runTeamImpl: async (options) => {
        capturedBrief = options.brief
        return {
          text: '# Final Draft\n\nDone.',
          cost: 0.1,
          durationMs: 10,
          artifactPath: path.join(childDir, 'final-draft.md'),
          assignmentPath: path.join(dir, 'workspace', 'assignments', 'child-session'),
          childSessionId: 'child-session',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
          requestedResultType: 'artifact:final-draft.md',
        }
      },
    })

    await tool.execute(
      'call-1',
      { team: 'writing-team', brief: 'Create a one-page summary from the provided input files.' },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    const sourceBundlePath = path.join(dir, 'active-input-files.md')
    assert.ok(fs.existsSync(sourceBundlePath))
    const sourceBundle = fs.readFileSync(sourceBundlePath, 'utf8')
    assert.match(sourceBundle, /Preferred Parsed Source Artifacts/)
    assert.match(sourceBundle, /source\.pdf\.structure\.md/)
    assert.match(sourceBundle, /Important structured findings\./)

    assert.match(capturedBrief, /Use the active parsed input bundle/)
    assert.match(capturedBrief, /## Embedded Source Artifacts/)
    assert.match(capturedBrief, /Important structured findings\./)

    const delegationBrief = fs.readFileSync(findDelegationArtifact(dir, 'writing-team', 'brief'), 'utf8')
    assert.match(delegationBrief, /active-input-files\.md/)
    assert.match(delegationBrief, /Important structured findings\./)
  })
})

test('spawn_team writes job-request.md before the child team completes in routing stages', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'final-draft.md')

    const entry: TeamRegistryEntry = {
      name: 'writing-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'final-draft.md',
    }

    let observedJobRequestBeforeReturn = false
    const jobRequestPath = path.join(dir, 'job-request.md')

    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      stageType: 'routing',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
      getCurrentCoordinatorRunId: () => 1,
    }, {
      runTeamImpl: async () => {
        observedJobRequestBeforeReturn = fs.existsSync(jobRequestPath)
        return {
          text: '# Final Draft\n\nDone.',
          cost: 0.1,
          durationMs: 10,
          artifactPath: path.join(childDir, 'final-draft.md'),
          assignmentPath: path.join(dir, 'workspace', 'assignments', 'child-session'),
          childSessionId: 'child-session',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
          requestedResultType: 'artifact:final-draft.md',
        }
      },
    })

    await tool.execute(
      'call-1',
      { team: 'writing-team', brief: 'Create a 1 page report on Apple.', rationale: 'Writing request.' },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.equal(observedJobRequestBeforeReturn, true)
  })
})

test('spawn_team appends multiple spawn events to team-spawns.jsonl', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'output/research.md')

    const entry: TeamRegistryEntry = {
      name: 'research-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'output/research.md',
    }

    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    }, {
      runTeamImpl: async () => ({
        text: '# Research\n\nDone.',
        cost: 0.5,
        durationMs: 10,
        artifactPath: path.join(childDir, 'output', 'research.md'),
        assignmentPath: path.join(dir, 'workspace', 'assignments', 'child-session'),
        childSessionId: 'child-session',
        succeeded: true,
        exitCode: 0,
        exitSignal: null,
      }),
    })

    await tool.execute(
      'call-1',
      { team: 'research-team', brief: 'First delegated brief' },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    await tool.execute(
      'call-2',
      { team: 'research-team', brief: 'Second delegated brief' },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    const spawnLogPath = getAssignmentLogPath(dir, 'team-spawns.jsonl')
    const spawnEvents = fs.readFileSync(spawnLogPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    assert.equal(spawnEvents.length, 2)
    assert.match(spawnEvents[0].brief_preview, /First delegated brief/)
    assert.match(spawnEvents[1].brief_preview, /Second delegated brief/)
  })
})

test('spawn_team throws when child team does not produce final artifact', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'final-draft.md')

    const entry: TeamRegistryEntry = {
      name: 'writing-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'final-draft.md',
    }

    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    }, {
      runTeamImpl: async () => ({
        text: '[Child team process failed: exit 1]\n\npartial output only',
        cost: 0.2,
        durationMs: 10,
        artifactPath: '',
        assignmentPath: path.join(dir, 'workspace', 'assignments', 'child-session'),
        childSessionId: 'child-session',
        succeeded: false,
        exitCode: 1,
        exitSignal: null,
      }),
    })

    await assert.rejects(
      tool.execute(
        'call-1',
        { team: 'writing-team', brief: 'Draft this' },
        undefined as any,
        undefined as any,
        undefined as any,
      ),
      /Team run failed: writing-team/,
    )

    const resultPath = findDelegationArtifact(dir, 'writing-team', 'result')
    const resultBody = fs.readFileSync(resultPath, 'utf8')
    assert.match(resultBody, /status: "failed"/)
    assert.equal(fs.existsSync(path.join(dir, 'routing-decision.md')), true)
    assert.match(fs.readFileSync(path.join(dir, 'routing-decision.md'), 'utf8'), /Status: failed/)

    const delegationEvents = fs.readFileSync(getAssignmentLogPath(dir, 'delegations.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    assert.equal(delegationEvents.at(-1)?.status, 'failed')
  })
})

test('spawn_team surfaces child review-loop block details when the child misses its final artifact', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'final-draft.md')

    const childAssignmentPath = path.join(dir, 'workspace', 'assignments', 'child-session')
    fs.mkdirSync(path.join(childAssignmentPath, 'logs'), { recursive: true })
    fs.writeFileSync(
      path.join(childAssignmentPath, 'logs', 'review-events.jsonl'),
      JSON.stringify({
        step: 'loop.max-iterations-reached',
        iteration: 3,
        max_iterations: 3,
        last_verdict: 'revise',
      }) + '\n',
    )
    fs.writeFileSync(
      path.join(childAssignmentPath, 'review-feedback-v3.md'),
      [
        '---',
        'artifact_type: "review-feedback"',
        '---',
        'REVISE',
        '',
        '## Blocking Issues',
        '1. [Section: Placeholders] — Placeholder still present — Remove it.',
      ].join('\n'),
    )

    const entry: TeamRegistryEntry = {
      name: 'writing-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'final-draft.md',
    }

    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    }, {
      runTeamImpl: async () => ({
        text:
          '[Child team process completed without producing the expected output artifact: final-draft.md]\n\n' +
          'Child stage blocked after 3/3 review iterations without producing `final-draft.md`.\n\n' +
          'Latest reviewer feedback:\nREVISE',
        cost: 0.2,
        durationMs: 10,
        artifactPath: '',
        assignmentPath: childAssignmentPath,
        childSessionId: 'child-session',
        succeeded: false,
        exitCode: 0,
        exitSignal: null,
      }),
    })

    await assert.rejects(
      tool.execute(
        'call-1',
        { team: 'writing-team', brief: 'Draft this' },
        undefined as any,
        undefined as any,
        undefined as any,
      ),
      /Team run blocked: writing-team/,
    )

    const resultPath = findDelegationArtifact(dir, 'writing-team', 'result')
    const resultBody = fs.readFileSync(resultPath, 'utf8')
    assert.match(resultBody, /status: "blocked"/)
    const lifecycleState = JSON.parse(
      fs.readFileSync(getAssignmentLogPath(dir, 'delegation-state.json'), 'utf8'),
    ) as Record<string, { status?: string }>
    assert.equal(Object.values(lifecycleState)[0]?.status, 'blocked')
  })
})

test('spawn_team propagates completed_with_warnings from child artifact metadata', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'final-draft.md')

    const childAssignmentPath = path.join(dir, 'workspace', 'assignments', 'child-session')
    fs.mkdirSync(childAssignmentPath, { recursive: true })
    const childArtifactPath = path.join(childAssignmentPath, 'final-draft.md')
    fs.writeFileSync(
      childArtifactPath,
      [
        '---',
        'artifact_type: "result"',
        'status: "approved_with_warnings"',
        '---',
        '# Final Draft',
        '',
        'Delivered with warnings.',
      ].join('\n'),
    )

    const entry: TeamRegistryEntry = {
      name: 'writing-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'final-draft.md',
    }

    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      stageType: 'routing',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
      getCurrentCoordinatorRunId: () => 1,
    }, {
      runTeamImpl: async () => ({
        text: fs.readFileSync(childArtifactPath, 'utf8'),
        cost: 0.2,
        durationMs: 10,
        artifactPath: childArtifactPath,
        assignmentPath: childAssignmentPath,
        childSessionId: 'child-session',
        succeeded: true,
        exitCode: 0,
        exitSignal: null,
        requestedResultType: 'artifact:final-draft.md',
      }),
    })

    await tool.execute(
      'call-1',
      { team: 'writing-team', brief: 'Draft this', rationale: 'Route to writing.' },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    const resultPath = findDelegationArtifact(dir, 'writing-team', 'result')
    const routingDecisionPath = path.join(dir, 'routing-decision.md')
    assert.match(fs.readFileSync(resultPath, 'utf8'), /status: "completed_with_warnings"/)
    assert.match(fs.readFileSync(routingDecisionPath, 'utf8'), /"status": "completed_with_warnings"/)
  })
})

test('spawn_team rejects unsupported requested child result type before execution', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'output/research.md')

    const entry: TeamRegistryEntry = {
      name: 'research-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'output/research.md',
    }

    let runCount = 0
    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    }, {
      runTeamImpl: async () => {
        runCount++
        throw new Error('should not execute child team')
      },
    })

    await assert.rejects(
      tool.execute(
        'call-1',
        { team: 'research-team', brief: 'Investigate', result_type: 'artifact:final-report.md' },
        undefined as any,
        undefined as any,
        undefined as any,
      ),
      /does not support requested result 'final-report\.md'/,
    )
    assert.equal(runCount, 0)
  })
})

test('spawn_team normalizes semantic result labels like one-pager to the child completion artifact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-tool-semantic-result-'))
  try {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'output/research.md')

    const teamRegistry = new Map<string, any>([
      ['writing-team', {
        name: 'writing-team',
        type: 'team',
        team_path: childDir,
        input_artifact: 'incoming-brief.md',
        output_artifact: 'output/research.md',
      }],
    ])

    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: {
        team: { name: 'reception-desk', description: 'Parent', version: '1.0.0' },
        workspace: { path: path.join(dir, 'workspace'), watch: false },
        models: { orchestration: { model: 'openai/gpt-4o-mini', thinking: 'low' } as any },
        levels: [],
        gates: [],
        agents: [],
      } as any,
      teamRegistry,
      permissions: { spawn_teams: true },
      levelId: 'intake',
      stageType: 'routing',
      outputPath: path.join(dir, 'workspace', 'assignments', 'parent-session'),
      state: {
        sessionId: 'parent-session',
        rootSessionId: 'parent-session',
        
        currentLevelIndex: 0,
        levelStates: new Map(),
        totalCost: 0,
        startTime: 0,
        timerStarted: false,
        endTime: null,
        spawnDepth: 0,
      },
      activeSpawnCountRef: { count: 0 },
      getCurrentCoordinatorRunId: () => 1,
    }, {
      runTeamImpl: async () => ({
        text: '# Final draft',
        cost: 0,
        durationMs: 1,
        artifactPath: path.join(childDir, '..', 'workspace', 'assignments', 'child-session', 'output', 'research.md'),
        assignmentPath: path.join(childDir, '..', 'workspace', 'assignments', 'child-session'),
        childSessionId: 'child-session',
        succeeded: true,
        exitCode: 0,
        exitSignal: null,
        requestedResultType: 'artifact:output/research.md',
      } as any),
    })

    const result = await tool.execute('tool-call', {
      team: 'writing-team',
      brief: 'Write a one-pager on Audi.',
      result_type: 'one-pager',
    }, undefined, undefined, {} as any)

    assert.match(JSON.stringify(result), /writing-team/i)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('spawn_team refuses to spawn the current team from itself', async () => {
  await withTempDir(async (dir) => {
    const entry = {
      name: 'reception-desk',
      type: 'team',
      team_path: dir,
    } as any

    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    })

    await assert.rejects(
      tool.execute('call-1', { team: 'reception-desk', brief: 'Loop forever' }, undefined as any, undefined as any, undefined as any),
      /Refusing to spawn/,
    )
  })
})

test('spawn_team allows only one delegation attempt per routing coordinator turn', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'final-draft.md')

    const entry: TeamRegistryEntry = {
      name: 'writing-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'final-draft.md',
    }

    let coordinatorRunId = 1
    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      stageType: 'routing',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
      getCurrentCoordinatorRunId: () => coordinatorRunId,
    }, {
      runTeamImpl: async () => ({
        text: '[Child team process failed: exit 1]\n\npartial output only',
        cost: 0.2,
        durationMs: 10,
        artifactPath: '',
        assignmentPath: path.join(dir, 'workspace', 'assignments', 'child-session'),
        childSessionId: 'child-session',
        succeeded: false,
        exitCode: 1,
        exitSignal: null,
      }),
    })

    await assert.rejects(
      tool.execute(
        'call-1',
        { team: 'writing-team', brief: 'Draft this' },
        undefined as any,
        undefined as any,
        undefined as any,
      ),
      /Team run failed: writing-team/,
    )

    await assert.rejects(
      tool.execute(
        'call-2',
        { team: 'writing-team', brief: 'Try again' },
        undefined as any,
        undefined as any,
        undefined as any,
      ),
      /at most once per coordinator turn/i,
    )

    coordinatorRunId = 2

    await assert.rejects(
      tool.execute(
        'call-3',
        { team: 'writing-team', brief: 'Try again in a new turn' },
        undefined as any,
        undefined as any,
        undefined as any,
      ),
      /Team run failed: writing-team/,
    )
  })
})

test('spawn_team blocks switching specialist teams after a failed routing-stage delegation in the same turn', async () => {
  await withTempDir(async (dir) => {
    const childDir = path.join(dir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'final-draft.md')

    const writingEntry: TeamRegistryEntry = {
      name: 'writing-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'final-draft.md',
    }
    const problemEntry: TeamRegistryEntry = {
      name: 'problem-thinking-board',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'output/decomposition-plan.md',
    }

    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([
        [writingEntry.name, writingEntry],
        [problemEntry.name, problemEntry],
      ]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      stageType: 'routing',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
      getCurrentCoordinatorRunId: () => 1,
    }, {
      runTeamImpl: async () => ({
        text: '[Child team process failed: exit 1]\n\npartial output only',
        cost: 0.2,
        durationMs: 10,
        artifactPath: '',
        assignmentPath: path.join(dir, 'workspace', 'assignments', 'child-session'),
        childSessionId: 'child-session',
        succeeded: false,
        exitCode: 1,
        exitSignal: null,
      }),
    })

    await assert.rejects(
      tool.execute(
        'call-1',
        { team: 'writing-team', brief: 'Draft this' },
        undefined as any,
        undefined as any,
        undefined as any,
      ),
      /Team run failed: writing-team/,
    )

    await assert.rejects(
      tool.execute(
        'call-2',
        { team: 'problem-thinking-board', brief: 'Maybe think instead' },
        undefined as any,
        undefined as any,
        undefined as any,
      ),
      /instead of retrying or switching teams/i,
    )
  })
})

test('prose that merely contains a slash is not mistaken for a file path', () => {
  // The delegation brief is written by a model in prose. A pattern that starts
  // at any "/" and runs to a later extension turns "and/or the report.md" into
  // a path, and a false match does not merely add a bad file: it switches off
  // input bundling for the whole delegation, silently.
  assert.deepEqual(
    extractLocalArtifactPaths('Use the data and/or the report.md for this'),
    [],
  )
  assert.deepEqual(
    extractLocalArtifactPaths('See https://example.com/docs/page.html for details'),
    [],
  )
})

test('a path in backticks is still found, which is how a model usually writes one', () => {
  // Regression guard. Tightening the boundary class to stop `and/or the
  // report.md` matching also stopped backtick-wrapped paths matching, and a
  // model writing a brief reaches for backticks more often than not. A false
  // negative here is as bad as a false positive: both silently disable input
  // bundling for the whole delegation.
  assert.deepEqual(
    extractLocalArtifactPaths('Read `/a/b/notes.md` for context'),
    ['/a/b/notes.md'],
  )
  assert.deepEqual(
    extractLocalArtifactPaths('Compare `/a/b.json` with `/c/d.yaml`'),
    ['/a/b.json', '/c/d.yaml'],
  )
})

test('real absolute paths are still extracted', () => {
  assert.deepEqual(
    extractLocalArtifactPaths('Read /Users/example/project/notes.md please'),
    ['/Users/example/project/notes.md'],
  )
  assert.deepEqual(
    extractLocalArtifactPaths('Compare /a/b.json and /c/d.yaml'),
    ['/a/b.json', '/c/d.yaml'],
  )
  assert.deepEqual(
    extractLocalArtifactPaths('Open "/quoted path/with spaces.md" now'),
    ['/quoted path/with spaces.md'],
  )
})

test('a brief cannot pull a file from outside the workspace into a child prompt', async () => {
  // buildDelegationSourceAppendix reads every absolute path the brief names and
  // inlines up to 80,000 characters of it into the child team's prompt. The
  // brief is written by a model, and a model can be induced to name a path by
  // an uploaded document, a carried Team reply or a user message. Without a
  // root, "check /Users/me/.aws/credentials.json" exfiltrates that file into a
  // prompt and from there into a run artifact.
  await withTempDir(async (dir) => {
    const workspace = path.join(dir, 'workspace')
    const outside = path.join(dir, 'elsewhere')
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })

    const insidePath = path.join(workspace, 'notes.md')
    const outsidePath = path.join(outside, 'credentials.json')
    fs.writeFileSync(insidePath, 'WORKSPACE-CONTENT')
    fs.writeFileSync(outsidePath, 'SECRET-CANARY')

    const result = buildDelegationSourceAppendix(
      `Compare ${insidePath} with ${outsidePath} please`,
      [workspace],
    )

    assert.equal(
      result.enrichedBrief.includes('SECRET-CANARY'),
      false,
      'a file outside every allowed root must not reach the child brief',
    )
    assert.deepEqual(result.artifactRefs, [insidePath])
    assert.ok(result.enrichedBrief.includes('WORKSPACE-CONTENT'))
  })
})

test('a child assignment sibling is readable, because that is where child results live', async () => {
  // The production layout, which the first version of this confinement missed:
  //   <ws>/sessions/S/runs/R/assignments/<parent>   <- outputPath
  //   <ws>/sessions/S/runs/R/assignments/<child>    <- where a child writes
  // A child's artifact is a SIBLING of the parent's directory, never inside it.
  // Rooting confinement at outputPath therefore refused every artifact the
  // deictic-continuation branch exists to embed: the brief still told the child
  // to use it "as the source of truth" and the body never arrived. Silently.
  await withTempDir(async (dir) => {
    const parent = buildSessionRunAssignmentLocation(dir, {
      sessionId: 'S1', runId: 'R1', assignmentId: 'parent',
    })
    const child = buildSessionRunAssignmentLocation(dir, {
      sessionId: 'S1', runId: 'R1', assignmentId: 'child1',
    })
    assert.ok(parent && child)

    const artifact = path.join(child.assignmentPath, 'output', 'research.md')
    fs.mkdirSync(path.dirname(artifact), { recursive: true })
    fs.writeFileSync(artifact, '# Child result\n\nCHILD-ARTIFACT-BODY\n')

    const brief = `Continue from that.\n\nUse the latest completed child artifact at "${artifact}" as the source of truth.`

    // Rooted at the parent's own assignment directory: the sibling is refused.
    // The directory has to exist, or the refusal comes from an unresolvable
    // root rather than from the comparison this case is about.
    fs.mkdirSync(parent.assignmentPath, { recursive: true })
    const atAssignment = buildDelegationSourceAppendix(brief, [parent.assignmentPath])
    assert.deepEqual(atAssignment.artifactRefs, [])

    // Rooted at the run, which contains both: the artifact is embedded.
    const atRun = buildDelegationSourceAppendix(brief, [parent.runPath])
    assert.deepEqual(atRun.artifactRefs, [artifact])
    assert.ok(atRun.enrichedBrief.includes('CHILD-ARTIFACT-BODY'))

    // And the run root is still a boundary, not an opening.
    const secret = path.join(dir, 'outside.md')
    fs.writeFileSync(secret, 'RUN-ROOT-CANARY')
    const hostile = buildDelegationSourceAppendix(`Read ${secret}`, [parent.runPath])
    assert.equal(hostile.enrichedBrief.includes('RUN-ROOT-CANARY'), false)
  })
})

test('a symlink inside an allowed root cannot reach outside it', async () => {
  // Confinement compared resolved paths but never resolved the link itself, so
  // a symlink planted inside the root — or a symlinked directory, which escapes
  // with one link rather than one per file — passed the check and its target
  // was inlined into the child brief.
  await withTempDir(async (dir) => {
    const root = path.join(dir, 'run')
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'secret.md'), 'SYMLINK-CANARY')

    const linkedFile = path.join(root, 'link.md')
    fs.symlinkSync(path.join(outside, 'secret.md'), linkedFile)
    const linkedDir = path.join(root, 'linkdir')
    fs.symlinkSync(outside, linkedDir)

    for (const candidate of [linkedFile, path.join(linkedDir, 'secret.md')]) {
      const result = buildDelegationSourceAppendix(`Read ${candidate}`, [root])
      assert.equal(
        result.enrichedBrief.includes('SYMLINK-CANARY'),
        false,
        `a symlink reached outside the root: ${candidate}`,
      )
    }

    // A real file inside the root is still readable.
    fs.writeFileSync(path.join(root, 'real.md'), 'REAL-CONTENT')
    const ok = buildDelegationSourceAppendix(`Read ${path.join(root, 'real.md')}`, [root])
    assert.ok(ok.enrichedBrief.includes('REAL-CONTENT'))
  })
})

test('a path that escapes an allowed root by traversal is refused', async () => {
  await withTempDir(async (dir) => {
    const workspace = path.join(dir, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })
    const secret = path.join(dir, 'secret.md')
    fs.writeFileSync(secret, 'TRAVERSAL-CANARY')

    const traversal = path.join(workspace, '..', 'secret.md')
    const result = buildDelegationSourceAppendix(`Read ${traversal}`, [workspace])
    assert.equal(result.enrichedBrief.includes('TRAVERSAL-CANARY'), false)
    assert.deepEqual(result.artifactRefs, [])
  })
})

test('a real spawn_team call cannot read a file outside the run, however the brief names it', async () => {
  // The unit test above proves buildDelegationSourceAppendix refuses an outside
  // path when it is given roots. It proves nothing about whether the tool passes
  // any roots, and a confinement that the caller forgets to request is not a
  // confinement. This drives the real tool.
  //
  // The brief is model-written: an uploaded document, a carried Team reply or a
  // user message can all induce a coordinator to name a path. Before the roots
  // were threaded through, naming one read up to 80,000 characters of it into
  // the child's prompt and into a persisted delegation artifact.
  await withTempDir(async (dir) => {
    // The run's own tree, and a sibling that is not part of it. The secret has
    // to sit genuinely outside `outputPath`: a first draft of this test put it
    // under the run directory, where reading it is correct behaviour, and the
    // assertion failed for the right reason.
    const runDir = path.join(dir, 'run')
    const elsewhere = path.join(dir, 'elsewhere')
    fs.mkdirSync(runDir, { recursive: true })
    fs.mkdirSync(elsewhere, { recursive: true })

    const childDir = path.join(runDir, 'child-team')
    fs.mkdirSync(childDir, { recursive: true })
    writeChildTeamConfig(childDir, 'output/research.md')

    const secretPath = path.join(elsewhere, 'credentials.json')
    fs.writeFileSync(secretPath, '{"token":"SPAWN-CANARY"}')

    // A file the run may legitimately read, to prove the rule is a boundary and
    // not a blanket refusal.
    const allowedPath = path.join(runDir, 'notes.md')
    fs.writeFileSync(allowedPath, 'ALLOWED-CONTENT')

    const entry: TeamRegistryEntry = {
      name: 'research-team',
      type: 'team',
      team_path: childDir,
      input_artifact: 'incoming-brief.md',
      output_artifact: 'output/research.md',
    }

    let capturedBrief = ''
    const tool = createSpawnTeamTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      // The run's own output tree. Everything else on the machine is off limits.
      outputPath: runDir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    }, {
      runTeamImpl: async (options) => {
        capturedBrief = options.brief
        return {
          text: '---\nartifact_type: "report"\n---\n# Research\n\nDone.',
          cost: 0,
          durationMs: 1,
          artifactPath: path.join(childDir, 'output', 'research.md'),
          assignmentPath: path.join(runDir, 'workspace', 'assignments', options.childSessionId ?? 'c'),
          childSessionId: options.childSessionId ?? 'c',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    await tool.execute(
      'call-confine',
      {
        team: 'research-team',
        brief: `Read ${allowedPath} and cross-check it against ${secretPath} before you start`,
        rationale: 'Needs specialist research',
      },
      undefined as never,
      undefined as never,
      undefined as never,
    )

    assert.equal(
      capturedBrief.includes('SPAWN-CANARY'),
      false,
      'a file outside the run reached the child brief',
    )
    assert.ok(
      capturedBrief.includes('ALLOWED-CONTENT'),
      'a file inside the run should still be embedded; this is a boundary, not a ban',
    )
    // And nothing persisted it either.
    const briefPath = findDelegationArtifact(runDir, 'research-team', 'brief')
    if (briefPath) {
      assert.equal(
        fs.readFileSync(briefPath, 'utf8').includes('SPAWN-CANARY'),
        false,
        'a file outside the run was written into a delegation artifact',
      )
    }
  })
})

test('private runtime state is refused even inside an allowed root', async () => {
  // Rooting confinement at the run made every sibling assignment readable, and
  // that includes each one's `.runtime` directory: execution journals with full
  // prompts and responses, checkpoints, capability results. The repo refuses
  // that segment everywhere else (resolveOwnedRunRelativePath throws on it), so
  // admitting it here through a widened root would be a regression the rest of
  // the codebase has already decided against.
  await withTempDir(async (dir) => {
    const run = path.join(dir, 'run')
    const privateState = path.join(run, 'assignments', 'child1', '.runtime')
    fs.mkdirSync(privateState, { recursive: true })
    fs.writeFileSync(path.join(privateState, 'journal.json'), 'PRIVATE-CANARY')

    const result = buildDelegationSourceAppendix(
      `Read ${path.join(privateState, 'journal.json')}`,
      [run],
    )
    assert.equal(result.enrichedBrief.includes('PRIVATE-CANARY'), false)
    assert.deepEqual(result.artifactRefs, [])
  })
})

test('a runtime-chosen artifact outside every root is embedded, and nothing else is', async () => {
  // The legacy CLI layout has no run location, so `runPath` is absent and a
  // child's sibling assignment sits under no allowed root. The deictic branch
  // permits the one artifact the runtime resolved, by name.
  //
  // Neutralizing that permit left all the other spawn-tool tests green, because
  // each of them places the artifact inside an allowed root. This one does not:
  // remove the permit and it fails.
  await withTempDir(async (dir) => {
    const parentOutput = path.join(dir, 'assignments', 'parent')
    const childOutput = path.join(dir, 'assignments', 'child1')
    fs.mkdirSync(parentOutput, { recursive: true })
    fs.mkdirSync(childOutput, { recursive: true })

    const artifact = path.join(childOutput, 'output', 'research.md')
    fs.mkdirSync(path.dirname(artifact), { recursive: true })
    fs.writeFileSync(artifact, 'LEGACY-CHILD-BODY')

    const sibling = path.join(childOutput, 'private-notes.md')
    fs.writeFileSync(sibling, 'NOT-PERMITTED-BODY')

    const brief = [
      `Continue from that.`,
      ``,
      `Use the latest completed child artifact at "${artifact}" as the source of truth.`,
      `Also read ${sibling} while you are there.`,
    ].join('\n')

    // Only `parentOutput` is a root — the child's directory is a sibling of it.
    const result = buildDelegationSourceAppendix(brief, [parentOutput], [artifact])

    assert.ok(
      result.enrichedBrief.includes('LEGACY-CHILD-BODY'),
      'the permitted artifact was not embedded',
    )
    assert.deepEqual(result.artifactRefs, [artifact])
    assert.equal(
      result.enrichedBrief.includes('NOT-PERMITTED-BODY'),
      false,
      'a brief-named sibling rode in alongside the permitted path',
    )
  })
})

test('a permitted artifact survives a workspace that lives under a .runtime name', async () => {
  // The permit's private-state check is measured against the same anchor the
  // root check uses. Scanning the whole absolute path instead would refuse a
  // legitimate artifact whose workspace merely sits beneath a directory called
  // `.runtime` — the brief would still name it as the source of truth and the
  // body would never arrive.
  //
  // Without an anchor this test passes under either form, which is why the
  // anchor is supplied here and why the earlier permit test did not cover it.
  await withTempDir(async (dir) => {
    const workspace = path.join(dir, '.runtime', 'workspace')
    const parentOutput = path.join(workspace, 'assignments', 'parent')
    const childOutput = path.join(workspace, 'assignments', 'child1')
    fs.mkdirSync(parentOutput, { recursive: true })
    fs.mkdirSync(path.join(childOutput, 'output'), { recursive: true })

    const artifact = path.join(childOutput, 'output', 'research.md')
    fs.writeFileSync(artifact, 'ANCHORED-CHILD-BODY')
    const anchor = path.dirname(parentOutput)

    const embedded = buildDelegationSourceAppendix(
      `Use the latest completed child artifact at "${artifact}" as the source of truth.`,
      [parentOutput],
      [artifact],
      anchor,
    )
    assert.ok(
      embedded.enrichedBrief.includes('ANCHORED-CHILD-BODY'),
      'a legitimate artifact was refused because an ancestor was named .runtime',
    )

    // And private state *below* the anchor is still refused.
    const privatePath = path.join(childOutput, '.runtime', 'journal.json')
    fs.mkdirSync(path.dirname(privatePath), { recursive: true })
    fs.writeFileSync(privatePath, 'ANCHORED-PRIVATE-CANARY')
    const refused = buildDelegationSourceAppendix(
      `Read ${privatePath}`,
      [parentOutput],
      [privatePath],
      anchor,
    )
    assert.equal(refused.enrichedBrief.includes('ANCHORED-PRIVATE-CANARY'), false)
    assert.deepEqual(refused.artifactRefs, [])
  })
})

test('both brief phrasings reach the run\'s own latest child artifact', async () => {
  // Through resolveDelegationSourceBrief rather than buildDelegationSourceAppendix,
  // because the defect this pins is which permit each *branch* passes. Removing
  // the permit from either branch leaves every other spawn-tool test green: they
  // all place the artifact inside an allowed root, where no permit is needed.
  //
  // Legacy layout, so `runPath` is absent and the child's assignment is a
  // sibling of the parent's under no allowed root.
  await withTempDir(async (dir) => {
    const parentOutput = path.join(dir, 'assignments', 'parent')
    const childOutput = path.join(dir, 'assignments', 'child1')
    fs.mkdirSync(path.join(childOutput, 'output'), { recursive: true })
    const artifact = path.join(childOutput, 'output', 'research.md')
    fs.writeFileSync(artifact, 'BRANCH-PARITY-BODY')

    const logPath = getAssignmentLogPath(parentOutput, 'delegations.jsonl')
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(
      logPath,
      `${JSON.stringify({ status: 'completed', child_output_artifact: artifact })}\n`,
      'utf8',
    )

    // Deictic phrasing: the runtime binds the artifact itself.
    const deictic = resolveDelegationSourceBriefForTest({
      brief: 'Continue from that result.',
      outputPath: parentOutput,
      stageType: 'routing',
    })
    assert.ok(
      deictic.childBrief.includes('BRANCH-PARITY-BODY'),
      'the deictic branch did not embed the artifact',
    )

    // Explicit phrasing: the same file, named outright.
    const explicit = resolveDelegationSourceBriefForTest({
      brief: `Read ${artifact} and continue.`,
      outputPath: parentOutput,
      stageType: 'routing',
    })
    assert.ok(
      explicit.childBrief.includes('BRANCH-PARITY-BODY'),
      'naming the artifact outright lost what asking for it deictically got',
    )
  })
})
