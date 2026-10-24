import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import { Text } from '@earendil-works/pi-tui'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type {
  DelegationStatusSnapshot,
  LevelPermissions,
  RegistryEntry,
  RuntimeState,
  TeamConfig,
  OutputConfig,
} from '../core/types.js'
import { roundUsd, type BudgetLedger } from '../core/budget-ledger.js'
import {
  acquireSpawnPolicy,
  type SpawnBudgetAdmission,
} from '../core/spawn-policy.js'
import { buildArtifactMetadata, writeMarkdownArtifact } from '../domains/runtime/artifacts.js'
import { buildUserFacingResultEnvelope } from '../domains/delegation/reception-contracts.js'
import { logDelegationEvent } from '../domains/runtime/logger.js'
import { recordDelegationLifecycle } from '../domains/delegation/delegation-lifecycle.js'
import { runWorkflow } from '../workflows/runner.js'
import type { WorkflowExecutionResult, WorkflowRegistryEntry } from '../workflows/types.js'
import type { RunAssignmentLocation } from '../domains/run/run-location.js'

export interface SpawnWorkflowContext {
  teamName: string
  teamConfig: TeamConfig
  teamRegistry: Map<string, RegistryEntry>
  workflowRegistry: Map<string, WorkflowRegistryEntry>
  permissions?: LevelPermissions
  levelId: string
  stageType?: string
  routingOutput?: OutputConfig
  outputPath: string
  state: RuntimeState
  assignmentLocation?: RunAssignmentLocation
  shutdownSignal?: AbortSignal
  onDashboardUpdate?: () => void
  budgetLedger?: BudgetLedger
  adoptCapabilityBudget?: (toolCallId: string) =>
    SpawnBudgetAdmission | undefined
  activeSpawnCountRef: { count: number }
  coordinatorName?: string
  getCurrentCoordinatorRunId?: () => number
  setDelegationStatus?: (delegationId: string, snapshot: DelegationStatusSnapshot | null) => void
}

export interface SpawnWorkflowDependencies {
  runWorkflowImpl?: typeof runWorkflow
}

function requireSpawnPermission(permissions: LevelPermissions | undefined): void {
  if (!permissions?.spawn_teams) {
    throw new Error('Dynamic workflow spawning is not enabled for this level.')
  }
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow'
}

function buildWorkflowCompletionText(result: WorkflowExecutionResult, workflowName: string): string {
  const isComplete = result.status === 'completed' || result.status === 'completed_with_warnings'
  return [
    `${isComplete ? 'Workflow completed' : 'Workflow started'}: ${workflowName}`,
    `Status: ${result.status}`,
    `Primary artifact: ${result.primaryArtifact || '[none]'}`,
    '',
    `${isComplete ? 'Final summary' : 'Workflow summary'}: ${result.summary}`,
  ].join('\n')
}

function resolveWorkflowEntry(
  workflowName: unknown,
  workflowRegistry: Map<string, WorkflowRegistryEntry>,
): WorkflowRegistryEntry {
  const available = [...workflowRegistry.keys()].sort().join(', ')
  if (typeof workflowName !== 'string' || workflowName.length === 0) {
    throw new Error(
      available
        ? `spawn_workflow requires an exact workflow id. Available workflows: ${available}`
        : 'spawn_workflow requires an exact workflow id. No workflows are registered.',
    )
  }

  const direct = workflowRegistry.get(workflowName)
  if (direct) return direct
  throw new Error(
    available
      ? `Unknown workflow '${workflowName}'. Available workflows: ${available}`
      : `Unknown workflow '${workflowName}'. No workflows are registered.`,
  )
}

export function createSpawnWorkflowTool(
  ctx: SpawnWorkflowContext,
  deps: SpawnWorkflowDependencies = {},
) {
  const runWorkflowImpl = deps.runWorkflowImpl ?? runWorkflow
  let lastRoutingCoordinatorRunId: number | null = null
  let routingSpawnAttempted = false

  return defineTool({
    name: 'spawn_workflow',
    label: 'Spawn Workflow',
    description:
      'Delegate the request to an exact registered inter-team workflow selected from the available workflows list. ' +
      'Use this when the request should run through multiple specialist teams in a declared sequence.',
    promptSnippet:
      'Use `spawn_workflow` with the exact id of the registered workflow you selected; the runtime validates and executes it deterministically.',
    promptGuidelines: [
      'Prefer workflows when the request clearly needs multiple specialist teams in sequence.',
      'Choose semantically from the available workflows list, then pass its exact workflow id. Never omit or invent the id.',
      'Treat the tool result as authoritative. Do not narrate downstream workflow execution yourself.',
    ],
    parameters: Type.Object({
      workflow: Type.String({
        minLength: 1,
        description: 'Exact registered workflow id selected from the available workflows list.',
      }),
      brief: Type.String({
        description: 'The request or delegated brief to run through the workflow.',
      }),
      rationale: Type.Optional(Type.String({
        description: 'Short explanation of why this workflow fits the request.',
      })),
    }),

    async execute(_toolCallId, params, _signal) {
      if (ctx.stageType === 'routing') {
        const coordinatorRunId = ctx.getCurrentCoordinatorRunId?.() ?? 0
        if (lastRoutingCoordinatorRunId !== coordinatorRunId) {
          lastRoutingCoordinatorRunId = coordinatorRunId
          routingSpawnAttempted = false
        }
        if (routingSpawnAttempted) {
          throw new Error(
            'Routing stages may call spawn_workflow at most once per coordinator turn. ' +
            'If workflow execution fails, stop and report the failure instead of trying another workflow in the same turn.',
          )
        }
        routingSpawnAttempted = true
      }

      requireSpawnPermission(ctx.permissions)
      const workflowEntry = resolveWorkflowEntry(params.workflow, ctx.workflowRegistry)
      const budgetAdmission = ctx.adoptCapabilityBudget?.(_toolCallId)
      const spawnPolicy = await acquireSpawnPolicy({
        state: ctx.state,
        teamConfig: ctx.teamConfig,
        activeSpawnCountRef: ctx.activeSpawnCountRef,
        ...whenDefined(ctx.budgetLedger, (definedValue) => ({ budgetLedger: definedValue })),
        ...(budgetAdmission ? { budgetAdmission } : {}),
        subject: 'workflow',
      })
      try {
      const remainingBudget = spawnPolicy.remainingBudget
      const safeWorkflowName = sanitizeName(workflowEntry.name)
      const resultArtifactPath = path.join(ctx.outputPath, `workflow-${safeWorkflowName}-result.md`)
      const requestArtifactPath = path.join(ctx.outputPath, `workflow-${safeWorkflowName}-request.md`)
      const routingDecisionPath = ctx.routingOutput
        ? path.join(ctx.outputPath, ctx.routingOutput.path ?? '', ctx.routingOutput.format)
        : path.join(ctx.outputPath, 'routing-decision.md')
      const delegationId = `${ctx.state.sessionId}:${safeWorkflowName}:${randomUUID()}`
      const startedAt = new Date().toISOString()
      const buildLifecycleSnapshot = (
        status: DelegationStatusSnapshot['status'],
        extra: Partial<DelegationStatusSnapshot> = {},
      ): DelegationStatusSnapshot => ({
        jobId: delegationId,
        parentJobId: ctx.state.sessionId,
        rootJobId: ctx.state.rootSessionId ?? ctx.state.sessionId,
        delegationId,
        fromTeam: ctx.teamName,
        fromLevel: ctx.levelId,
        fromAgent: ctx.coordinatorName ?? ctx.teamName,
        toTeam: workflowEntry.name,
        requestedResultType: 'workflow',
        briefArtifact: requestArtifactPath,
        resultArtifact: resultArtifactPath,
        startedAt,
        status,
        lastEventAt: new Date().toISOString(),
        ...extra,
      })

      recordDelegationLifecycle(ctx.outputPath, buildLifecycleSnapshot('queued'))

      writeMarkdownArtifact(
        requestArtifactPath,
        [
          '# Workflow Request',
          '',
          `- Workflow: ${workflowEntry.name}`,
          `- Rationale: ${params.rationale || 'No rationale provided.'}`,
          '',
          '## Brief',
          '',
          params.brief,
        ].join('\n'),
        buildArtifactMetadata({
          filePath: requestArtifactPath,
          rootDir: ctx.outputPath,
          artifactType: 'contract',
          sessionId: ctx.state.sessionId,
          ...whenDefined(ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
          ...whenDefined(ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
          from: ctx.coordinatorName ?? ctx.teamName,
          to: workflowEntry.name,
          team: ctx.teamName,
          level: ctx.levelId,
          ...whenDefined(ctx.stageType, (definedValue) => ({ stageType: definedValue })),
          status: 'delegated',
          title: `Workflow request for ${workflowEntry.name}`,
        }),
      )

      const runningSnapshot = buildLifecycleSnapshot('running')
      recordDelegationLifecycle(ctx.outputPath, runningSnapshot)
      ctx.setDelegationStatus?.(delegationId, runningSnapshot)
      ctx.onDashboardUpdate?.()
      let terminalDelegationStatus: 'blocked' | 'failed' | null = null

      try {
        const result = await runWorkflowImpl({
          workflowEntry,
          teamRegistry: ctx.teamRegistry,
          brief: params.brief,
          workspacePath: ctx.teamConfig.workspace.path,
          spawnDepth: ctx.state.spawnDepth,
          ...whenDefined([ctx.shutdownSignal, _signal].filter(Boolean).length > 1
            ? AbortSignal.any([ctx.shutdownSignal, _signal].filter(Boolean) as AbortSignal[])
            : (ctx.shutdownSignal ?? _signal), (definedValue) => ({ signal: definedValue })),
          ...whenDefined(remainingBudget, (definedValue) => ({ budgetUsd: definedValue })),
          ...whenDefined(ctx.budgetLedger?.policy, (definedValue) => ({ budgetPolicy: definedValue })),
          ...whenDefined(ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
          parentSessionId: ctx.state.sessionId,
          ...whenDefined(ctx.assignmentLocation, (definedValue) => ({ assignmentLocation: definedValue })),
          // Nested tool workflows remain part of the owning parent attempt;
          // only persisted top-level session tasks are independently recoverable.
          persistenceMode: 'ephemeral',
        })

        ctx.state.totalCost = roundUsd(ctx.state.totalCost + result.totalCost)
        const userResult = buildUserFacingResultEnvelope({
          childStatus: result.status,
          ...whenDefined(result.primaryArtifact, (definedValue) => ({ primaryArtifact: definedValue })),
          summarySource: result.summary,
          lineage: {
            receptionist_team: ctx.teamName,
            workflow: workflowEntry.name,
          },
        })

        writeMarkdownArtifact(
          resultArtifactPath,
          [
            '# Workflow Result',
            '',
            `- Workflow: ${workflowEntry.name}`,
            `- Status: ${result.status}`,
            `- Primary artifact: ${result.primaryArtifact || '[none]'}`,
            '',
            '## Steps',
            '',
            ...result.steps.flatMap((step) => [
              `### ${step.stepId}`,
              `- Team: ${step.team}`,
              `- Status: ${step.status}`,
              `- Artifact: ${step.artifactPath || '[none]'}`,
              '',
              step.summary,
              '',
            ]),
          ].join('\n'),
          buildArtifactMetadata({
            filePath: resultArtifactPath,
            rootDir: ctx.outputPath,
            artifactType: 'result',
            sessionId: ctx.state.sessionId,
            ...whenDefined(ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
            ...whenDefined(ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
            from: workflowEntry.name,
            to: ctx.coordinatorName ?? ctx.teamName,
            team: ctx.teamName,
            level: ctx.levelId,
            ...whenDefined(ctx.stageType, (definedValue) => ({ stageType: definedValue })),
            status: result.status,
            title: `Workflow result from ${workflowEntry.name}`,
          }),
        )

        if (ctx.stageType === 'routing') {
          writeMarkdownArtifact(
            routingDecisionPath,
            [
              '# Routing Decision',
              '',
              `Workflow: ${workflowEntry.name}`,
              `Workflow status: ${result.status}`,
              `Primary artifact: ${result.primaryArtifact || '[none]'}`,
              '',
              '## Final Result',
              '',
              result.summary,
              '',
              '## Workflow Request',
              '',
              `- Request: ${requestArtifactPath}`,
              `- Result: ${resultArtifactPath}`,
              '',
              '## User Result Envelope',
              '',
              '```json',
              JSON.stringify(userResult, null, 2),
              '```',
            ].join('\n'),
            buildArtifactMetadata({
              filePath: routingDecisionPath,
              rootDir: ctx.outputPath,
              artifactType: 'report',
              sessionId: ctx.state.sessionId,
              ...whenDefined(ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
              ...whenDefined(ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
              from: ctx.coordinatorName ?? ctx.teamName,
              to: workflowEntry.name,
              team: ctx.teamName,
              level: ctx.levelId,
              stageType: ctx.stageType,
              status: result.status,
              title: `Routing decision for workflow ${workflowEntry.name}`,
            }),
          )
        }

        logDelegationEvent(ctx.outputPath, {
          timestamp: new Date().toISOString(),
          job_id: delegationId,
          parent_job_id: ctx.state.sessionId,
          root_job_id: ctx.state.rootSessionId ?? ctx.state.sessionId,
          delegation_id: delegationId,
          root_session_id: ctx.state.rootSessionId,
          parent_session_id: ctx.state.sessionId,
          from: ctx.coordinatorName ?? ctx.teamName,
          to: workflowEntry.name,
          from_team: ctx.teamName,
          from_level: ctx.levelId,
          from_agent: ctx.coordinatorName ?? ctx.teamName,
          to_team: workflowEntry.name,
          brief_artifact: requestArtifactPath,
          result_artifact: resultArtifactPath,
          requested_result_type: result.requestedResultType ?? 'workflow',
          status: result.status,
        })

        const terminalSnapshot = buildLifecycleSnapshot(result.status, {
          requestedResultType: result.requestedResultType ?? 'workflow',
          ...whenDefined(result.primaryArtifact, (definedValue) => ({ lastArtifact: definedValue })),
        })
        recordDelegationLifecycle(ctx.outputPath, terminalSnapshot)
        ctx.setDelegationStatus?.(delegationId, terminalSnapshot)

        if (result.status === 'failed' || result.status === 'blocked') {
          terminalDelegationStatus = result.status
          throw new Error(result.summary)
        }

        return {
          content: [{
            type: 'text' as const,
            text: buildWorkflowCompletionText(result, workflowEntry.name),
          }],
          details: undefined,
        }
      } catch (err) {
        // Persist the routing decision as an audit record even when workflow
        // execution fails before its normal result document is available.
        if (!fs.existsSync(routingDecisionPath)) {
          const failureReason = err instanceof Error ? err.message : String(err)
          try {
            writeMarkdownArtifact(
              routingDecisionPath,
              [
                '# Routing Decision',
                '',
                `Workflow: ${workflowEntry.name}`,
                `Workflow status: ${terminalDelegationStatus ?? 'failed'}`,
                '',
                '## Workflow Request',
                '',
                `- Request: ${requestArtifactPath}`,
                `- Result: ${resultArtifactPath}`,
                '',
                '## Failure',
                '',
                failureReason,
              ].join('\n'),
              buildArtifactMetadata({
                filePath: routingDecisionPath,
                rootDir: ctx.outputPath,
                artifactType: 'report',
                sessionId: ctx.state.sessionId,
                ...whenDefined(ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
                ...whenDefined(ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
                from: ctx.coordinatorName ?? ctx.teamName,
                to: workflowEntry.name,
                team: ctx.teamName,
                level: ctx.levelId,
                ...whenDefined(ctx.stageType, (definedValue) => ({ stageType: definedValue })),
                status: terminalDelegationStatus ?? 'failed',
                title: `Failed routing decision for workflow ${workflowEntry.name}`,
              }),
            )
          } catch (writeError) {
            // The audit artifact is best-effort: a write failure must not
            // mask the original delegation error.
            console.error(
              `[spawn-workflows] Failed to write routing decision artifact: ${
                writeError instanceof Error ? writeError.message : String(writeError)
              }`,
            )
          }
        }
        if (!terminalDelegationStatus) {
          logDelegationEvent(ctx.outputPath, {
            timestamp: new Date().toISOString(),
            job_id: delegationId,
            parent_job_id: ctx.state.sessionId,
            root_job_id: ctx.state.rootSessionId ?? ctx.state.sessionId,
            delegation_id: delegationId,
            root_session_id: ctx.state.rootSessionId,
            parent_session_id: ctx.state.sessionId,
            from: ctx.coordinatorName ?? ctx.teamName,
            to: workflowEntry.name,
            from_team: ctx.teamName,
            from_level: ctx.levelId,
            from_agent: ctx.coordinatorName ?? ctx.teamName,
            to_team: workflowEntry.name,
            brief_artifact: requestArtifactPath,
            result_artifact: resultArtifactPath,
            requested_result_type: 'workflow',
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          })
          recordDelegationLifecycle(ctx.outputPath, buildLifecycleSnapshot('failed', {
            failureReason: err instanceof Error ? err.message : String(err),
          }))
        }
        throw err
      } finally {
        ctx.setDelegationStatus?.(delegationId, null)
        ctx.onDashboardUpdate?.()
      }
      } finally {
        spawnPolicy.release()
      }
    },

    renderCall(args, theme) {
      const workflow = (args as Record<string, unknown>).workflow as string ?? 'missing-workflow-id'
      return new Text(`${theme.fg('accent', 'spawn_workflow')} -> ${workflow}`)
    },

    renderResult(result, _options, theme) {
      const text = (result.content?.[0] as { text?: string })?.text ?? ''
      const firstLine = text.split('\n')[0] || 'Workflow complete'
      return new Text(theme.fg('success', firstLine))
    },
  })
}
