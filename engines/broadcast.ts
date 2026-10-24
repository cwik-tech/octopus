/**
 * Team Runtime — Broadcast Engine
 *
 * Fan-out: Send the same message to multiple agents in parallel,
 * collect results, and aggregate them.
 *
 * Aggregation modes:
 * - merge: concatenate all responses
 * - vote: extract decisions, count votes
 * - best: return all and let coordinator pick
 *
 * Tool registered: `broadcast`
 */

import { whenDefined } from '../core/optional-properties.js'
import { AgentQuestionInterruptionError } from '../core/agent-question-interruption.js'
import type { AgentQuestionInterruption } from '../contracts/agent-questions.js'
import type { BroadcastSettledSlot } from '../contracts/agent-question-engine-progress.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Type } from 'typebox'
import { Text } from '@earendil-works/pi-tui'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  BroadcastStageConfig,
  BroadcastState,
  BaseEngineContext,
  LevelConfig,
  TeamConfig,
} from '../core/types.js'
import {
  adoptBudgetDispatchAdmission,
  type BudgetDispatchAdmission,
} from '../core/budget-ledger.js'
import { STAGE_TYPE, AGENT_STATE, AGGREGATION_MODE, STAGE_LIFECYCLE_STATUS } from '../core/constants.js'
import { dispatchWithFailurePolicy, resolveFailurePolicy, HaltError } from '../domains/agent-execution/failure-policy.js'
import { resolveChildWorkspacePath } from '../parsers/team-config.js'
import { checkConstraints, formatCost, formatElapsed } from '../core/constraints.js'
import { combineAbortSignals } from '../core/timeout-manager.js'
import { substituteTemplateVars } from '../domains/runtime/template.js'
import { buildArtifactMetadata, writeMarkdownArtifact } from '../domains/runtime/artifacts.js'
import { publishAcceptedTeamChatMessage } from '../domains/runtime/team-chat-messages.js'
import { buildStageDispatchInvocationId } from '../core/stage-dispatch-identity.js'
import { canTransitionStageStatus, transitionStageStatus } from '../domains/stage/stage-lifecycle.js'
import { deriveEffectiveStageContractsForTeam } from '../domains/stage/stage-contracts.js'

interface BroadcastContext extends BaseEngineContext<BroadcastStageConfig> {
  onStateCheckpoint?: () => void
}

function normalizeBroadcastParams(input: unknown): { message?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (typeof input === 'string' && input.trim()) return { message: input }
    return {}
  }

  const raw = input as Record<string, unknown>
  return {
    ...whenDefined(typeof raw.message === 'string'
      ? raw.message
      : typeof raw.content === 'string'
        ? raw.content
        : undefined, (message) => ({ message })),
  }
}

function updateBroadcastStageStatus(
  ctx: BroadcastContext,
  next: typeof STAGE_LIFECYCLE_STATUS[keyof typeof STAGE_LIFECYCLE_STATUS],
): void {
  const levelState = ctx.state.levelStates.get(ctx.levelId)
  if (!levelState || !levelState.stageStatus || levelState.stageStatus === next) return
  if (!canTransitionStageStatus(levelState.stageStatus, next)) return
  transitionStageStatus(levelState, next)
}

function resolveInitialBroadcastMessage(
  teamConfig: TeamConfig | undefined,
  currentLevelId: string,
  outputPath: string,
  providedMessage?: string,
): string {
  if (providedMessage && providedMessage.trim()) return providedMessage
  if (!teamConfig) return ''
  const contracts = deriveEffectiveStageContractsForTeam(teamConfig, currentLevelId)
  for (const artifact of contracts.input.artifacts ?? []) {
    const artifactPath = path.join(outputPath, artifact.path)
    if (!fs.existsSync(artifactPath)) continue
    const content = fs.readFileSync(artifactPath, 'utf8')
    if (content.trim()) return content
  }
  return ''
}

function buildBroadcastBootstrapError(
  teamConfig: TeamConfig | undefined,
  currentLevelId: string,
  outputPath: string,
  providedMessage?: string,
): string {
  if (providedMessage && providedMessage.trim()) {
    return `Broadcast bootstrap failed: provided broadcast message was empty after trimming for level '${currentLevelId}'.`
  }

  const contracts = teamConfig ? deriveEffectiveStageContractsForTeam(teamConfig, currentLevelId) : { input: { artifacts: [] } }
  const artifactPreview = (contracts.input.artifacts ?? [])
    .map((artifact) => `\`${artifact.path}\``)
    .join(', ')

  return (
    `Broadcast bootstrap failed: no initial broadcast message was available for level '${currentLevelId}'. ` +
    `Expected one of the declared input artifacts ${artifactPreview || '`brief.md`'} to exist in \`${outputPath}\`, ` +
    `or explicit \`message\` / \`content\` to be passed to \`broadcast\`.`
  )
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Build the substituted system prompt for one fan-out agent. */
function buildAgentPrompt(
  teamRootPath: string,
  agent: { systemPrompt: string; agentDir: string; experienceEnabled: boolean },
  state: BroadcastContext['state'],
  workspacePath: string,
  outputPath: string,
  taskContent: string,
): string {
  return substituteTemplateVars(agent.systemPrompt, {
    SESSION_ID: state.sessionId,
    WORKSPACE_PATH: workspacePath,
    ASSIGNMENT_PATH: outputPath,
    OUTPUT_PATH: outputPath,
    EXPERIENCE_PATH: agent.experienceEnabled ? path.join(agent.agentDir, 'experience') : '',
    TEAM_ROOT_PATH: teamRootPath,
    TEMPLATES_PATH: path.join(teamRootPath, 'templates'),
    PROFILES_PATH: path.join(teamRootPath, 'profiles'),
    STYLE_GUIDE_PATH: path.join(teamRootPath, 'style-guide.md'),
    CLIENT_NAME: '',
    PROJECT_NAME: '',
    // Without this the literal `{{TASK_CONTENT}}` reaches the model, because
    // `substituteTemplateVars` leaves absent keys untouched. The broadcast
    // question is this stage's concrete task, matching `currentInput` in
    // engines/chain.ts and `initialContent` in engines/review.ts.
    TASK_CONTENT: taskContent,
  })
}

/** Build the user message for a single fan-out agent. */
function buildFanOutMessage(ctx: BroadcastContext, broadcastMessage: string): string {
  const inputFilesSection = ctx.inputFilesContent
    ? `\n**Input Files:**\n${ctx.inputFilesContent}\n\n`
    : ''

  return (
    `# Broadcast Question\n\n` +
    inputFilesSection +
    `Respond independently to the following:\n\n` +
    `${broadcastMessage}\n\n` +
    `Provide your analysis and conclusion.`
  )
}

/** Dispatch all fan-out agents in parallel, collecting results. */
async function fanOut(
  ctx: BroadcastContext,
  broadcastMessage: string,
  signal: AbortSignal | undefined,
  budgetAdmission: BudgetDispatchAdmission | undefined,
): Promise<Array<Omit<BroadcastSettledSlot, 'slot'>>> {
  const { config, agents, rosterEntries, state, workspacePath, agentMetrics, onDashboardUpdate } = ctx
  const fanOutList = config.fan_out
  const level = state.levelStates.get(ctx.levelId)
  const previous = level?.engineState
  // The in-flight record holds settled slots and nothing else. A record written
  // before this normalization, or inherited from a completed broadcast being
  // redone, arrives carrying `responses` as well; adopting it by reference kept
  // every inherited answer a second time and, after a redo, described the
  // previous run. Both terminal writes below replace this object wholesale with
  // the mapped responses, failure placeholders included.
  const inherited = previous?.type === 'broadcast' ? previous : undefined
  const settledSlots: BroadcastSettledSlot[] = inherited?.settledSlots ?? []
  const progress: BroadcastState = {
    type: 'broadcast',
    responses: [],
    aggregatedResult: inherited?.aggregatedResult ?? null,
    settledSlots,
  }
  if (level) level.engineState = progress
  ctx.onStateCheckpoint?.()
  const interruptions: AgentQuestionInterruption[] = []

  // Mark all agents as active before firing.
  // When a rate limiter is active, skip pre-marking here — each agent will be
  // marked ACTIVE individually by dispatchToAgentOrTeam when its semaphore slot
  // is released, giving an accurate picture of what is actually running.
  if (!ctx.rateLimiter) {
    for (const [slot, agentName] of fanOutList.entries()) {
      if (settledSlots.some((entry) => entry.slot === slot)) continue
      const metrics = agentMetrics.get(agentName)
      if (metrics) {
        metrics.state = AGENT_STATE.ACTIVE
        metrics.activeStartedAt = Date.now()
      }
    }
    if (onDashboardUpdate) onDashboardUpdate()
  }

  updateBroadcastStageStatus(ctx, STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER)

  const promises = fanOutList.map(async (agentName, fanOutIndex) => {
    const completed = settledSlots.find((entry) => entry.slot === fanOutIndex)
    if (completed) return completed
    const agent = agents.get(agentName)
    if (!agent) return { agent: agentName, text: '[Agent not found]', cost: 0, halted: false, succeeded: false }

    const userMessage = buildFanOutMessage(ctx, broadcastMessage)
    const finalPrompt = buildAgentPrompt(ctx.teamRootPath, agent, state, workspacePath, ctx.outputPath, broadcastMessage)
    const metrics = agentMetrics.get(agentName)
    const rosterEntry = rosterEntries.get(agentName)
    const teamWorkspacePath = rosterEntry?.type === 'team' && rosterEntry.team_path
      ? resolveChildWorkspacePath(rosterEntry.team_path)
      : undefined

    const agentPolicy = rosterEntry?.on_failure
    const resolvedPolicy = resolveFailurePolicy(
      agentName,
      STAGE_TYPE.BROADCAST,
      ctx.stageFailureOverride,
      agentPolicy,
    )
    const fallbackName = resolvedPolicy.fallbackAgent
    const fallbackAgent = fallbackName ? agents.get(fallbackName) : undefined
    const fallbackRosterEntry = fallbackName ? rosterEntries.get(fallbackName) : undefined
    const fallbackFinalPrompt = fallbackAgent
      ? buildAgentPrompt(ctx.teamRootPath, fallbackAgent, state, workspacePath, ctx.outputPath, broadcastMessage)
      : undefined

    const doDispatch = async (): Promise<Omit<BroadcastSettledSlot, 'slot'> & { interruption?: AgentQuestionInterruption }> => {
      const waiting = interruptions[0]
      if (waiting) return { agent: agentName, text: '', cost: 0, halted: false, succeeded: false, interruption: waiting }
      try {
        const result = await dispatchWithFailurePolicy({
          agent,
          rosterEntry,
          finalPrompt,
          userMessage,
          state,
          workspacePath,
          outputPath: ctx.outputPath,
          ...whenDefined(teamWorkspacePath, (definedValue) => ({ teamWorkspacePath: definedValue })),
          metrics,
          ...whenDefined(ctx.shutdownSignal ? combineAbortSignals(signal, ctx.shutdownSignal) : signal, (definedValue) => ({ signal: definedValue })),
          ...whenDefined(onDashboardUpdate, (definedValue) => ({ onDashboardUpdate: definedValue })),
          triggerTool: 'broadcast',
          logicalInvocationId: buildStageDispatchInvocationId({
            sessionId: state.sessionId,
            levelId: ctx.levelId,
            visitCount: state.levelStates.get(ctx.levelId)?.visitCount ?? 0,
            stageType: STAGE_TYPE.BROADCAST,
            slot: `fan-out:${fanOutIndex}`,
            target: agentName,
          }),
          ...whenDefined(ctx.teamName, (definedValue) => ({ teamName: definedValue })),
          fromName: ctx.config.coordinator ?? 'coordinator',
          policy: resolvedPolicy,
          ...whenDefined(fallbackAgent, (definedValue) => ({ fallbackAgent: definedValue })),
          ...whenDefined(fallbackRosterEntry, (definedValue) => ({ fallbackRosterEntry: definedValue })),
          ...whenDefined(fallbackFinalPrompt, (definedValue) => ({ fallbackFinalPrompt: definedValue })),
          levelId: ctx.levelId,
          stageType: STAGE_TYPE.BROADCAST,
          sessionId: state.sessionId,
          ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
          errorLogPath: ctx.outputPath,
          onFailureRecorded: (aName, error) => {
            const m = agentMetrics.get(aName)
            if (m) { m.failureCount++; m.lastError = error }
          },
          ...whenDefined(ctx.budgetLedger, (definedValue) => ({ budgetLedger: definedValue })),
          totalCost: state.totalCost,
          ...(budgetAdmission ? { budgetAdmission } : {}),
          ...whenDefined(ctx.config.config.constraints?.agent_timeout_minutes, (definedValue) => ({ timeoutMinutes: definedValue })),
        })

        if (result.interruption) {
          interruptions.push(result.interruption)
          ctx.onStateCheckpoint?.()
          return { agent: agentName, text: '', cost: result.cost, halted: false, succeeded: false, interruption: result.interruption }
        }
        if (result.skipped) {
          return { agent: agentName, text: '[Skipped — agent failed]', cost: 0, halted: false, succeeded: false }
        }
        // Past the skip and the halt branches, so this participant answered.
        // A skipped or failed one falls out above and keeps its placeholder,
        // which is a status the reader can trust rather than a contribution.
        publishAcceptedTeamChatMessage(ctx, {
          agentName: result.agentName ?? agentName,
          ...whenDefined(result.dispatchId, (dispatchId) => ({ dispatchId })),
          stageType: STAGE_TYPE.BROADCAST,
          text: result.text,
        })
        return { agent: agentName, text: result.text, cost: result.cost, halted: false, succeeded: true }
      } catch (err) {
        // Shutdown must propagate — never report an aborted fan-out as a
        // completed stage result (mirrors engines/chain.ts).
        if (signal?.aborted || ctx.shutdownSignal?.aborted) {
          throw err
        }
        if (err instanceof HaltError) {
          return { agent: agentName, text: `[HALTED: ${err.message}]`, cost: 0, halted: true, succeeded: false }
        }
        const errMsg = err instanceof Error ? err.message : String(err)
        return { agent: agentName, text: `[Error: ${errMsg}]`, cost: 0, halted: false, succeeded: false }
      }
    }

    const result = await (ctx.rateLimiter ? ctx.rateLimiter.run(doDispatch) : doDispatch())
    if (!result.interruption) {
      const { agent, text, cost, halted, succeeded } = result
      // `settledSlots` is the only record of work in flight. Copying it into
      // `responses` stored every answer twice, carried `slot`, `halted` and
      // `succeeded` into a field that does not declare them, and disagreed with
      // the terminal write below, which keeps the agents that failed. Both
      // terminal writes replace this object wholesale, so nothing reads
      // `responses` before then.
      settledSlots.push({ slot: fanOutIndex, agent, text, cost, halted, succeeded })
      ctx.onStateCheckpoint?.()
    }
    return result
  })

  const results = await Promise.all(promises)
  const interruption = interruptions.find((entry) => entry.kind === 'blocked') ?? interruptions[0]
  if (interruption) throw new AgentQuestionInterruptionError(interruption)
  return results
}

/** Aggregate fan-out results based on the configured aggregation mode. */
function aggregateResults(
  results: Array<{ agent: string; text: string; cost: number }>,
  aggregation: string,
): string {
  switch (aggregation) {
    case AGGREGATION_MODE.MERGE:
      return results.map((r) => `## ${r.agent}\n\n${r.text}`).join('\n\n---\n\n')

    case AGGREGATION_MODE.VOTE:
      return buildVoteSummary(results)

    case AGGREGATION_MODE.BEST:
      return (
        `**All responses collected. Choose the best one:**\n\n` +
        results.map((r, i) => `### Option ${i + 1}: ${r.agent}\n\n${r.text}`).join('\n\n---\n\n')
      )

    default:
      return results.map((r) => `**${r.agent}:** ${r.text}`).join('\n\n')
  }
}

/** Format constraint status note. */
function buildConstraintNote(config: BroadcastStageConfig, state: BroadcastContext['state']): string {
  if (!config.config.constraints) return ''
  checkConstraints(config.config.constraints, state.startTime, state.totalCost, state.endTime)
  return `\n\n---\n**Constraints:** ${formatElapsed(state.startTime, state.endTime)} elapsed, ${formatCost(state.totalCost)} spent`
}

// ─── broadcast tool ──────────────────────────────────────────────────────────

/**
 * Create the `broadcast` tool for a broadcast stage.
 */
export function createBroadcastTool(ctx: BroadcastContext): ToolDefinition {
  return {
    name: 'broadcast',
    label: 'Broadcast',
    description:
      `Send the same message to all fan-out agents in parallel, collect responses, and aggregate. ` +
      `Aggregation mode: ${ctx.config.config.aggregation}.`,
    promptSnippet:
      `Use \`broadcast\` to send a question to all agents simultaneously. Responses are aggregated (${ctx.config.config.aggregation} mode).`,
    promptGuidelines: [
      'Call `broadcast` with no arguments to bootstrap from the current assignment input artifact.',
      "After receiving responses: if agents surface questions that require user input, present them to the user before proceeding.",
      "All agents receive the same message and respond independently.",
      "Responses are collected in parallel for speed.",
      `Aggregation mode is '${ctx.config.config.aggregation}'.`,
    ],
    parameters: Type.Object({
      message: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
    }, {
      additionalProperties: true,
      description:
        'Optional broadcast parameters as an object. Supports { message } and accepts content as an alias for message. ' +
        'When no message is provided, the runtime loads the current broadcast input artifact automatically.',
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _extensionCtx) {
      const budgetAdmission = adoptBudgetDispatchAdmission({
        ledger: ctx.budgetLedger,
        adopt: ctx.adoptCapabilityBudget,
        toolCallId: _toolCallId,
      })
      const { config, state, outputPath, onDashboardUpdate } = ctx
      const safeParams = normalizeBroadcastParams(params)

      if (config.fan_out.length === 0) {
        updateBroadcastStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
        return { details: undefined, content: [{ type: 'text' as const, text: 'No agents in fan_out list.' }] }
      }

      const broadcastMessage = resolveInitialBroadcastMessage(
        ctx.teamConfig,
        ctx.levelId,
        outputPath,
        safeParams.message,
      )
      if (!broadcastMessage.trim()) {
        updateBroadcastStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
        return {
          details: undefined,
          content: [{
            type: 'text' as const,
            text: buildBroadcastBootstrapError(ctx.teamConfig, ctx.levelId, outputPath, safeParams.message),
          }],
        }
      }
      updateBroadcastStageStatus(ctx, STAGE_LIFECYCLE_STATUS.RUNNING)

      // Save brief.md on first broadcast
      const briefPath = path.join(outputPath, 'brief.md')
      if (!fs.existsSync(briefPath)) {
        writeMarkdownArtifact(
          briefPath,
          `# Broadcast Brief\n\n${broadcastMessage}`,
          buildArtifactMetadata({
            filePath: briefPath,
            rootDir: outputPath,
            artifactType: 'brief',
            sessionId: state.sessionId,
            ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
            ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
            level: ctx.levelId,
            stageType: 'broadcast',
            status: 'active',
          }),
        )
      }

      const results = await fanOut(
        ctx,
        broadcastMessage,
        _signal,
        budgetAdmission,
      )
      updateBroadcastStageStatus(ctx, STAGE_LIFECYCLE_STATUS.RUNNING)
      if (onDashboardUpdate) onDashboardUpdate()

      // Note: state.totalCost is already updated by dispatchToAgentOrTeam inside fanOut.
      // Do NOT add r.cost again here — that would double-count.

      // Check for any halted agents and surface a warning
      const haltedResults = results.filter((r) => r.halted)
      const successfulResults = results.filter((r) => r.succeeded)

      // A fan-out that produced no response is not a completed stage. Writing
      // the aggregate anyway hands the next level a document of placeholder
      // strings, and gate readiness opens on the file alone
      // (team-runtime/level-lifecycle.ts). The stored state therefore carries a
      // null aggregate too, because `isBroadcastComplete` reads only that.
      //
      // A halt and a starved fan-out stay distinguishable, matching the split
      // engines/discussion.ts already uses: a halt is FAILED, no successful
      // participant is BLOCKED. A partial fan-out is unaffected — one real
      // response is still a usable broadcast.
      if (successfulResults.length === 0) {
        updateBroadcastStageStatus(
          ctx,
          haltedResults.length > 0
            ? STAGE_LIFECYCLE_STATUS.FAILED
            : STAGE_LIFECYCLE_STATUS.BLOCKED,
        )
        const failedLevelState = state.levelStates.get(ctx.levelId)
        if (failedLevelState) {
          failedLevelState.engineState = {
            type: STAGE_TYPE.BROADCAST,
            responses: results.map(({ agent, text, cost }) => ({ agent, text, cost })),
            aggregatedResult: null,
          }
        }
        const haltDetail = haltedResults.length > 0
          ? ` ${haltedResults.length} halted: ${haltedResults.map((r) => r.agent).join(', ')}.`
          : ''
        return {
          details: undefined,
          content: [{
            type: 'text' as const,
            text: `**Broadcast failed:** none of the ${results.length} fan-out agent(s) ` +
              `produced a response.${haltDetail} Do not treat this stage as complete. ` +
              `Check agent provider configuration or runtime credentials and retry, or ` +
              `inspect agent-errors.jsonl for the recorded failures.`,
          }],
        }
      }

      const aggregated = aggregateResults(results, config.config.aggregation)

      // Save aggregated output
      const outputFilePath = getBroadcastOutputPath(config, outputPath)
      writeMarkdownArtifact(
        outputFilePath,
        aggregated,
        buildArtifactMetadata({
          filePath: outputFilePath,
          rootDir: outputPath,
          artifactType: 'result',
          sessionId: state.sessionId,
          ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
          ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
          level: ctx.levelId,
          stageType: 'broadcast',
          status: 'complete',
        }),
      )

      // Store broadcast state (strip halted flag before storing)
      const broadcastState: BroadcastState = {
        type: STAGE_TYPE.BROADCAST,
        responses: results.map(({ agent, text, cost }) => ({ agent, text, cost })),
        aggregatedResult: aggregated,
      }
      const levelState = state.levelStates.get(ctx.levelId)
      if (levelState) levelState.engineState = broadcastState
      updateBroadcastStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)

      const constraintNote = buildConstraintNote(config, state)
      const haltWarning = haltedResults.length > 0
        ? `\n\n⚠️ **WARNING:** ${haltedResults.length} agent(s) halted: ${haltedResults.map((r) => r.agent).join(', ')}. Check agent-errors.jsonl for details.`
        : ''

      return {
        details: undefined,
        content: [{
          type: 'text' as const,
          text: `**Broadcast Complete** (${results.length} responses, ${config.config.aggregation} mode)\n\n` +
            aggregated + constraintNote + haltWarning,
        }],
      }
    },

    renderCall(args, theme) {
      return new Text(`${theme.fg('accent', 'broadcast')} \u2192 ${ctx.config.fan_out.length} agents`)
    },

    renderResult(result, _options, theme) {
      return new Text(theme.fg('success', 'Broadcast complete'))
    },
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function buildVoteSummary(results: Array<{ agent: string; text: string; cost: number }>): string {
  const lines: string[] = ['## Vote Summary\n']

  for (const r of results) {
    lines.push(`**${r.agent}:** ${r.text.slice(0, 200)}${r.text.length > 200 ? '...' : ''}`)
  }

  lines.push(`\n**Total votes:** ${results.length}`)
  return lines.join('\n\n')
}

// ─── Public Engine API ───────────────────────────────────────────────────────

export function isBroadcastComplete(state: BroadcastState): boolean {
  return state.aggregatedResult !== null
}

export function getBroadcastOutputPath(config: BroadcastStageConfig, outputPath: string): string {
  const configuredPath = config.config.output.path
  const outputDir = configuredPath
    ? (path.isAbsolute(configuredPath) ? configuredPath : path.join(outputPath, configuredPath))
    : outputPath
  return path.join(outputDir, config.config.output.format)
}

/**
 * Build a readable history string from broadcast state.
 * Used for post-completion experience reflections.
 */
export function buildBroadcastHistory(state: BroadcastState): string {
  if (state.responses.length === 0) return '_No responses recorded._'

  const lines: string[] = ['### Broadcast Responses\n']

  for (const r of state.responses) {
    lines.push(`**${r.agent}:**\n${r.text}\n`)
  }

  return lines.join('\n')
}
