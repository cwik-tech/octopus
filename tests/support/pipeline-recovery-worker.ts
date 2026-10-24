import * as fs from 'node:fs'
import * as path from 'node:path'

import { createPipelineTool } from '../../engines/pipeline.js'
import { parsePlan } from '../../parsers/plan-parser.js'
import { initProviders } from '../../providers/index.js'
import {
  readCheckpoint,
  restoreLevelStatesFromCheckpoint,
} from '../../domains/runtime/checkpoint.js'
import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function readTextResult(result: unknown): string {
  const content = (result as {
    content?: Array<{ type?: string; text?: string }>
  }).content
  return content?.find((entry) => entry.type === 'text')?.text ?? ''
}

async function main(): Promise<void> {
  if (process.env.TEAM_RUNTIME_RECOVERY !== '1') {
    throw new Error('Replacement pipeline worker requires TEAM_RUNTIME_RECOVERY=1')
  }

  const assignmentPath = requiredEnv('PIPELINE_RECOVERY_ASSIGNMENT_PATH')
  const providerUrl = requiredEnv('PIPELINE_RECOVERY_PROVIDER_URL')
  const outputPath = requiredEnv('PIPELINE_RECOVERY_OUTPUT_PATH')
  const checkpoint = readCheckpoint(assignmentPath)
  if (!checkpoint) throw new Error('Replacement worker could not read its checkpoint')

  const levelStates = restoreLevelStatesFromCheckpoint(checkpoint)
  const levelState = levelStates.get('execution')
  if (levelState?.engineState?.type !== 'pipeline') {
    throw new Error('Checkpoint does not contain the execution pipeline state')
  }
  const planPath = levelState.engineState.planPath
  const before = parsePlan(planPath)
  if (
    before?.tasks.get('T1')?.status !== 'completed' ||
    before.tasks.get('T2')?.status !== 'in_progress'
  ) {
    throw new Error('Replacement worker did not encounter the interrupted claim')
  }
  const checkpointActiveTaskIds = [...levelState.engineState.activeTaskIds]

  initProviders()
  const context = {
    teamName: 'pipeline-recovery-process-fixture',
    teamRootPath: assignmentPath,
    levelId: 'execution',
    config: {
      type: 'pipeline',
      coordinator: 'coordinator',
      participants: ['writer'],
      config: {
        plan_file: '.pi-tasks/unused-source-plan.md',
        output: { format: 'unused.md', user_review: false },
      },
    },
    agents: new Map([
      ['writer', {
        name: 'writer',
        model: 'deterministic-recovery-model',
        thinking: 'low',
        systemPrompt: 'Complete the one assigned recovery task.',
        experienceContent: '',
        experienceEnabled: false,
        skillsContent: '',
        knowledgeContent: '',
        agentDir: assignmentPath,
        color: 1,
        provider: 'openai',
        providerConfig: {
          base_url: providerUrl,
          reasoning: false,
          input_cost_per_million_usd: 1,
          output_cost_per_million_usd: 1,
        },
      }],
    ]),
    rosterEntries: new Map([
      ['writer', { name: 'writer', type: 'agent' }],
    ]),
    state: {
      sessionId: checkpoint.sessionId,
      currentLevelIndex: checkpoint.currentLevelIndex,
      levelStates,
      totalCost: checkpoint.totalCost,
      startTime: checkpoint.startTime,
      timerStarted: true,
      endTime: null,
      spawnDepth: checkpoint.spawnDepth,
      rootSessionId: checkpoint.rootSessionId,
      parentSessionId: checkpoint.parentSessionId,
    },
    workspacePath: assignmentPath,
    outputPath: assignmentPath,
    inputFilesContent: '',
    agentMetrics: new Map(),
    stageFailureOverride: undefined,
    shutdownSignal: undefined,
    budgetLedger: undefined,
    recoveryMode: process.env.TEAM_RUNTIME_RECOVERY === '1',
    onDashboardUpdate: undefined,
  } as any

  const staleResultPath = path.join(assignmentPath, 'result.md')
  const staleResultExistedBeforeRecovery = fs.existsSync(staleResultPath)
  const tool = createPipelineTool(context)
  const recoveredResult = await tool.execute(
    'replacement-process-recovery',
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
  )
  const terminalProbe = await tool.execute(
    'replacement-process-terminal-probe',
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
  )

  const after = parsePlan(planPath)
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify({
      pid: process.pid,
      recoveryMode: process.env.TEAM_RUNTIME_RECOVERY,
      checkpointSessionId: checkpoint.sessionId,
      checkpointRootSessionId: checkpoint.rootSessionId,
      checkpointPlanPath: planPath,
      checkpointActiveTaskIds,
      completedStatusBeforeRecovery: before.tasks.get('T1')?.status,
      completedStatusAfterRecovery: after?.tasks.get('T1')?.status,
      interruptedStatusBeforeRecovery: before.tasks.get('T2')?.status,
      interruptedStatusAfterRecovery: after?.tasks.get('T2')?.status,
      stageStatus: context.state.levelStates.get('execution')?.stageStatus,
      staleResultExistedBeforeRecovery,
      staleResultExistsAfterRecovery: fs.existsSync(staleResultPath),
      recoveredText: readTextResult(recoveredResult),
      terminalProbeText: readTextResult(terminalProbe),
    }, null, 2)}\n`,
  )

  if (
    after?.tasks.get('T1')?.status !== 'completed' ||
    after?.tasks.get('T2')?.status !== 'completed' ||
    context.state.levelStates.get('execution')?.stageStatus !==
      STAGE_LIFECYCLE_STATUS.COMPLETED
  ) {
    throw new Error('Replacement pipeline worker did not reach terminal state')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
