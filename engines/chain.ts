/**
 * Team Runtime — Chain Engine
 *
 * Sequential handoff: Agent A produces output -> output becomes input for Agent B -> etc.
 * Each step's output is stored as `chain-step-{N}-{agent}.md` in the assignment folder.
 *
 * Tool registered: `handoff`
 */

import { whenDefined } from '../core/optional-properties.js'
import { AgentQuestionInterruptionError } from '../core/agent-question-interruption.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Type } from 'typebox'
import { Text } from '@earendil-works/pi-tui'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  ChainStageConfig,
  ChainState,
  BaseEngineContext,
  LevelConfig,
  TeamConfig,
} from '../core/types.js'
import {
  adoptBudgetDispatchAdmission,
  type BudgetDispatchAdmission,
} from '../core/budget-ledger.js'
import type { QualityVerdict } from '../contracts/deep-research.js'
import { STAGE_TYPE, STAGE_LIFECYCLE_STATUS } from '../core/constants.js'
import {
  dispatchWithFailurePolicy,
  resolveFailurePolicy,
  DispatchResultValidationError,
  HaltError,
} from '../domains/agent-execution/failure-policy.js'
import { resolveChildWorkspacePath } from '../parsers/team-config.js'
import { checkConstraints, formatCost, formatElapsed } from '../core/constraints.js'
import { combineAbortSignals } from '../core/timeout-manager.js'
import { substituteTemplateVars } from '../domains/runtime/template.js'
import { buildDeepResearchSynthesisBundle } from '../domains/deep-research/deep-research-synthesis-bundle.js'
import { buildDeepResearchQualityBundle } from '../domains/deep-research/deep-research-quality-bundle.js'
import {
  buildArtifactMetadata,
  resolveRuntimeOwnedArtifactContent,
  readMarkdownArtifact,
  writeMarkdownArtifact,
} from '../domains/runtime/artifacts.js'
import { publishAcceptedTeamChatMessage } from '../domains/runtime/team-chat-messages.js'
import { buildStageDispatchInvocationId } from '../core/stage-dispatch-identity.js'
import { canTransitionStageStatus, transitionStageStatus } from '../domains/stage/stage-lifecycle.js'
import { deriveEffectiveStageContractsForTeam } from '../domains/stage/stage-contracts.js'
import { writeFileAtomicSync } from '../core/file-mutation.js'
import { resolveOwnedRunRelativePath } from '../domains/runtime/runtime-paths.js'
import {
  DEEP_RESEARCH_SHUTDOWN_RESERVE_MS,
  buildDeepResearchQualityReviewFailureVerdict,
  parseDeepResearchQualityReviewResult,
  persistVersionedDeepResearchQualityVerdict,
  describeDeepResearchDispatchRefusal,
  planDeepResearchDispatchBudget,
  validateDeepResearchLevelTimeout,
  resolveDeepResearchDeadline,
} from '../domains/deep-research/deep-research-pipeline-adapter.js'
import { createDeepResearchQualityVerdictOutputSchema } from '../domains/deep-research/deep-research-quality-output-schema.js'

interface ChainContext extends BaseEngineContext<ChainStageConfig> {
  onStateCheckpoint?: () => void
}

function resolveBlockedChainStepReason(output: string): string | null {
  const normalized = resolveRuntimeOwnedArtifactContent(output)
  if (!/(^|\n)\*\*Status:\*\*\s*BLOCKED\b/m.test(normalized) && !/(^|\n)Status:\s*BLOCKED\b/m.test(normalized)) {
    return null
  }

  const hardGapsMatch = normalized.match(/## Hard Gaps[\s\S]*?(?=\n## |\n### |$)/i)
  if (hardGapsMatch?.[0]) {
    return hardGapsMatch[0].trim()
  }

  const gapsMatch = normalized.match(/## Gaps[\s\S]*?(?=\n## |\n### |$)/i)
  if (gapsMatch?.[0]) {
    return gapsMatch[0].trim()
  }

  const firstLines = normalized.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8).join('\n')
  return firstLines || 'A chain step returned BLOCKED.'
}

function normalizeChainParams(input: unknown): { action?: 'start' | 'status' | 'resume'; message?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (typeof input === 'string' && input.trim()) return { message: input }
    return {}
  }

  const raw = input as Record<string, unknown>
  const action: 'status' | 'start' | 'resume' | undefined = raw.action === 'status'
    ? 'status'
    : raw.action === 'start'
      ? 'start'
      : raw.action === 'resume'
        ? 'resume'
        : undefined
  const message = typeof raw.message === 'string'
    ? raw.message
    : typeof raw.content === 'string'
      ? raw.content
      : undefined

  return {
    ...whenDefined(action, (presentAction) => ({ action: presentAction })),
    ...whenDefined(message, (presentMessage) => ({ message: presentMessage })),
  }
}

// ─── State Helpers ───────────────────────────────────────────────────────────

/** Get existing chain state or null — does NOT mutate. */
function getChainState(ctx: ChainContext): ChainState | null {
  const es = ctx.state.levelStates.get(ctx.levelId)?.engineState
  if (es?.type === STAGE_TYPE.CHAIN) return es
  return null
}

/** Initialize chain state and store it in level state. */
function initChainState(ctx: ChainContext, sequence: string[]): ChainState {
  const chainState: ChainState = {
    type: STAGE_TYPE.CHAIN,
    currentStep: 0,
    totalSteps: sequence.length,
    outputs: [],
  }
  const levelState = ctx.state.levelStates.get(ctx.levelId)
  if (levelState) levelState.engineState = chainState
  return chainState
}

function updateChainStageStatus(
  ctx: ChainContext,
  next: typeof STAGE_LIFECYCLE_STATUS[keyof typeof STAGE_LIFECYCLE_STATUS],
): void {
  const levelState = ctx.state.levelStates.get(ctx.levelId)
  if (!levelState || !levelState.stageStatus || levelState.stageStatus === next) return
  if (!canTransitionStageStatus(levelState.stageStatus, next)) return
  transitionStageStatus(levelState, next)
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Build the user message for one chain step. */
function buildStepMessage(
  ctx: ChainContext,
  sequence: string[],
  stepIndex: number,
  currentInput: string,
  initialInput: string,
): string {
  const { config } = ctx
  const handoffFormat = config.config.handoff_format || 'markdown'
  const inputFilesSection = stepIndex === 0 && ctx.inputFilesContent
    ? `\n**Input Files:**\n${ctx.inputFilesContent}\n\n`
    : ''
  const n = stepIndex + 1
  const total = sequence.length
  const inputSection = stepIndex === 0
    ? `**Initial input:**\n\n${currentInput}`
    : `**Input from ${sequence[stepIndex - 1]}:**\n\n${currentInput}`
  const preservedInitialInput =
    stepIndex > 0 && config.config.preserve_initial_input
      ? [
          '',
          '# Authoritative Initial Input',
          '',
          'The following entry artifact remains the immutable factual reference. Preserve its exact evidence values even when the preceding chain output summarizes them.',
          '',
          initialInput,
        ].join('\n')
      : ''
  const nextAgent = stepIndex < sequence.length - 1 ? sequence[stepIndex + 1] : 'the final output'

  return (
    `# Chain Step ${n}/${total}\n\n` +
    `**Your role in this chain:** Process the input below and produce your output.\n` +
    `**Format:** ${handoffFormat}\n\n` +
    inputFilesSection +
    inputSection +
    preservedInitialInput +
    `\n\nProduce your output. It will be passed to ${nextAgent}.`
  )
}

/** Build the substituted system prompt for a chain step agent. */
function buildAgentPrompt(
  teamRootPath: string,
  agent: { systemPrompt: string; agentDir: string; experienceEnabled: boolean },
  state: ChainContext['state'],
  workspacePath: string,
  outputPath: string,
  finalOutputPath: string,
  taskContent: string,
): string {
  return substituteTemplateVars(agent.systemPrompt, {
    SESSION_ID: state.sessionId,
    WORKSPACE_PATH: workspacePath,
    ASSIGNMENT_PATH: outputPath,
    OUTPUT_PATH: finalOutputPath,
    EXPERIENCE_PATH: agent.experienceEnabled ? path.join(agent.agentDir, 'experience') : '',
    TEAM_ROOT_PATH: teamRootPath,
    TEMPLATES_PATH: path.join(teamRootPath, 'templates'),
    PROFILES_PATH: path.join(teamRootPath, 'profiles'),
    STYLE_GUIDE_PATH: path.join(teamRootPath, 'style-guide.md'),
    CLIENT_NAME: '',
    PROJECT_NAME: '',
    TASK_CONTENT: taskContent,
  })
}

/**
 * The entry content for a Deep Research synthesis step: one runtime-owned
 * bundle, admitted against an explicit budget before any process starts.
 *
 * The bundle is authoritative. A supplied `message` is carried inside it as
 * extra instructions rather than in place of it, so a coordinator note can
 * never replace the validated evidence — and its cost is counted like any
 * other part of the request.
 *
 * Accounting reproduces the real first step, because a chain sends its input
 * twice: once substituted into the agent's system prompt and once inside the
 * step's user message.
 */
function buildAdmittedSynthesisBundle(
  ctx: ChainContext,
  sequence: string[],
  outputPath: string,
  providedMessage?: string,
): string {
  const bundleConfig = ctx.config.config.research_synthesis_bundle
  if (!bundleConfig) throw new Error('No Deep Research synthesis bundle is configured.')
  const firstAgentName = sequence[0]
  const firstAgent = firstAgentName ? ctx.agents.get(firstAgentName) : undefined
  if (!firstAgentName || !firstAgent) {
    throw new Error('The Deep Research synthesis chain has no first agent.')
  }
  return buildDeepResearchSynthesisBundle({
    assignmentPath: outputPath,
    planArtifact: bundleConfig.plan_artifact,
    dossierIndexArtifact: bundleConfig.dossier_index_artifact,
    synthesisArtifact: bundleConfig.synthesis_artifact,
    ...whenDefined(bundleConfig.corrections_artifact, (correctionsArtifact) => ({ correctionsArtifact })),
    budget: {
      contextWindowTokens: bundleConfig.context_window_tokens,
      outputReserveTokens: bundleConfig.output_reserve_tokens,
    },
    ...(providedMessage?.trim()
      ? { additionalInstructions: providedMessage }
      : {}),
    renderRequest: (bundleText) => ({
      systemPrompt: buildAgentPrompt(
        ctx.teamRootPath,
        firstAgent,
        ctx.state,
        ctx.workspacePath,
        outputPath,
        getChainStepArtifactPath(outputPath, 0, firstAgentName),
        bundleText,
      ),
      userMessage: buildStepMessage(ctx, sequence, 0, bundleText, bundleText),
      ...(firstAgent.tools ? { toolDescriptors: firstAgent.tools } : {}),
    }),
  }).text
}

/** Build the quality critic's input only from artifacts this assignment owns. */
function buildAdmittedQualityReviewBundle(
  ctx: ChainContext,
  outputPath: string,
  providedMessage?: string,
): string {
  const bundleConfig = ctx.config.config.research_quality_bundle
  if (!bundleConfig) throw new Error('No Deep Research quality bundle is configured.')
  const firstAgentName = ctx.config.sequence[0]
  const firstAgent = firstAgentName ? ctx.agents.get(firstAgentName) : undefined
  if (!firstAgentName || !firstAgent) {
    throw new Error('The Deep Research quality chain has no first agent.')
  }
  return buildDeepResearchQualityBundle({
    assignmentPath: outputPath,
    planArtifact: bundleConfig.plan_artifact,
    qualityPacketArtifact: bundleConfig.quality_packet_artifact,
    deterministicVerdictArtifact: bundleConfig.deterministic_verdict_artifact,
    reportArtifact: bundleConfig.report_artifact,
    budget: {
      contextWindowTokens: bundleConfig.context_window_tokens,
      outputReserveTokens: bundleConfig.output_reserve_tokens,
    },
    ...(providedMessage?.trim()
      ? { additionalInstructions: providedMessage }
      : {}),
    renderRequest: (bundleText) => ({
      systemPrompt: buildAgentPrompt(
        ctx.teamRootPath,
        firstAgent,
        ctx.state,
        outputPath,
        outputPath,
        getChainStepArtifactPath(outputPath, 0, firstAgentName),
        bundleText,
      ),
      userMessage: buildStepMessage(
        ctx,
        ctx.config.sequence,
        0,
        bundleText,
        bundleText,
      ),
      ...(firstAgent.tools ? { toolDescriptors: firstAgent.tools } : {}),
    }),
  })
}

function resolveInitialChainContent(
  ctx: ChainContext,
  teamConfig: TeamConfig,
  currentLevelId: string,
  outputPath: string,
  providedMessage?: string,
): string {
  if (ctx.config.config.research_synthesis_bundle) {
    return buildAdmittedSynthesisBundle(ctx, ctx.config.sequence, outputPath, providedMessage)
  }
  if (ctx.config.config.research_quality_bundle) {
    return buildAdmittedQualityReviewBundle(ctx, outputPath, providedMessage)
  }
  if (providedMessage && providedMessage.trim()) return providedMessage
  const contracts = deriveEffectiveStageContractsForTeam(teamConfig, currentLevelId)
  for (const artifact of contracts.input.artifacts ?? []) {
    const artifactPath = path.join(outputPath, artifact.path)
    if (!fs.existsSync(artifactPath)) continue
    const content = fs.readFileSync(artifactPath, 'utf8')
    if (content.trim()) return content
  }
  return ''
}

function buildChainBootstrapError(
  teamConfig: TeamConfig,
  currentLevelId: string,
  outputPath: string,
  providedMessage?: string,
): string {
  if (providedMessage && providedMessage.trim()) {
    return `Chain bootstrap failed: provided chain message was empty after trimming for level '${currentLevelId}'.`
  }

  const contracts = deriveEffectiveStageContractsForTeam(teamConfig, currentLevelId)
  const artifactPreview = (contracts.input.artifacts ?? [])
    .map((artifact) => `\`${artifact.path}\``)
    .join(', ')

  return (
    `Chain bootstrap failed: no initial chain content was available for level '${currentLevelId}'. ` +
    `Expected one of the declared input artifacts ${artifactPreview || '`brief.md`'} to exist in \`${outputPath}\`, ` +
    `or explicit \`message\` / \`content\` to be passed to \`handoff\`.`
  )
}

/** Run one step in the chain sequence. Returns { output, done } or { error }. */
async function runChainStep(
  ctx: ChainContext,
  chainState: ChainState,
  sequence: string[],
  stepIndex: number,
  currentInput: string,
  initialInput: string,
  signal: AbortSignal | undefined,
  budgetAdmission: BudgetDispatchAdmission | undefined,
): Promise<
  | {
      output: string
      qualityVerdict?: QualityVerdict
      /** Non-fatal operator diagnostic surfaced beside the step result. */
      notice?: string
      error?: never
    }
  | {
      output?: never
      qualityVerdict?: never
      notice?: never
      error: string
    }
> {
  const { agents, rosterEntries, state, workspacePath, agentMetrics, onDashboardUpdate } = ctx
  const agentName = sequence[stepIndex]
  if (!agentName) return { error: `[Chain step ${stepIndex + 1} has no agent]` }
  const agent = agents.get(agentName)

  if (!agent) return { error: `[Agent not found: ${agentName}]` }

  let effectiveTimeoutMinutes = ctx.config.config.constraints?.agent_timeout_minutes
  let retryDeadlineMs: number | undefined
  let levelTimeoutNotice: string | undefined
  if (ctx.config.config.deadline_artifact) {
    try {
      const deadline = resolveDeepResearchDeadline({
        assignmentPath: ctx.outputPath,
        deadlineArtifact: ctx.config.config.deadline_artifact,
      })
      // A declared timeout at or above the plan budget can never fire. The
      // pipeline engine reports this at admission; a chain stage was clamped
      // silently until the deadline began carrying the plan budget.
      levelTimeoutNotice = validateDeepResearchLevelTimeout({
        declaredAgentTimeoutMinutes: effectiveTimeoutMinutes,
        planMaxDurationMinutes: deadline.maxDurationMinutes,
        levelId: ctx.levelId,
      })
      const dispatchBudget = planDeepResearchDispatchBudget({
        declaredTimeoutMinutes: effectiveTimeoutMinutes,
        remainingMs: deadline.remainingMs,
      })
      if (dispatchBudget.refusalReason) {
        return {
          error: describeDeepResearchDispatchRefusal(dispatchBudget, {
            subject: 'this chain step',
          }),
        }
      }
      retryDeadlineMs = Date.parse(deadline.deadlineAt)
      effectiveTimeoutMinutes = dispatchBudget.effectiveTimeoutMinutes
    } catch (error) {
      return {
        error: `Deep Research deadline validation failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  chainState.currentStep = stepIndex + 1
  updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER)
  const metrics = agentMetrics.get(agentName)
  const userMessage = buildStepMessage(
    ctx,
    sequence,
    stepIndex,
    currentInput,
    initialInput,
  )
  const stepFile = getChainStepArtifactPath(ctx.outputPath, stepIndex, agentName)
  const canonicalStepOutputPath = stepIndex === sequence.length - 1
    ? getChainOutputPath(ctx.config, ctx.outputPath)
    : stepFile
  const agentWorkspacePath =
    ctx.config.config.research_quality_bundle ? ctx.outputPath : workspacePath
  const finalPrompt = buildAgentPrompt(
    ctx.teamRootPath,
    agent,
    state,
    agentWorkspacePath,
    ctx.outputPath,
    canonicalStepOutputPath,
    currentInput,
  )

  const rosterEntry = rosterEntries.get(agentName)
  const teamWorkspacePath = rosterEntry?.type === 'team' && rosterEntry.team_path
    ? resolveChildWorkspacePath(rosterEntry.team_path)
    : undefined

  const agentPolicy = rosterEntry?.on_failure
  const resolvedPolicy = resolveFailurePolicy(
    agentName,
    STAGE_TYPE.CHAIN,
    ctx.stageFailureOverride,
    agentPolicy,
  )
  const fallbackName = resolvedPolicy.fallbackAgent
  const fallbackAgent = fallbackName ? ctx.agents.get(fallbackName) : undefined
  const fallbackRosterEntry = fallbackName ? ctx.rosterEntries.get(fallbackName) : undefined
  const fallbackFinalPrompt = fallbackAgent
    ? buildAgentPrompt(
      ctx.teamRootPath,
      fallbackAgent,
      state,
      agentWorkspacePath,
      ctx.outputPath,
      canonicalStepOutputPath,
      currentInput,
    )
    : undefined
  let validatedQualityVerdict: QualityVerdict | undefined
  // Built once for the whole step so every attempt — including a retry after a
  // validation failure — asks the provider for the same shape. Ordinary chain
  // stages produce prose and get no schema at all.
  const qualityOutputSchema =
    ctx.config.config.structured_output === 'deep_research_quality_verdict'
      ? createDeepResearchQualityVerdictOutputSchema()
      : undefined

  try {
    const result = await dispatchWithFailurePolicy({
      agent,
      rosterEntry,
      finalPrompt,
      userMessage,
      state,
      workspacePath: agentWorkspacePath,
      outputPath: ctx.outputPath,
      ...whenDefined(teamWorkspacePath, (definedValue) => ({ teamWorkspacePath: definedValue })),
      metrics,
      ...whenDefined(ctx.shutdownSignal ? combineAbortSignals(signal, ctx.shutdownSignal) : signal, (definedValue) => ({ signal: definedValue })),
      ...whenDefined(onDashboardUpdate, (definedValue) => ({ onDashboardUpdate: definedValue })),
      triggerTool: 'handoff',
      logicalInvocationId: buildStageDispatchInvocationId({
        sessionId: state.sessionId,
        levelId: ctx.levelId,
        visitCount: state.levelStates.get(ctx.levelId)?.visitCount ?? 0,
        stageType: STAGE_TYPE.CHAIN,
        slot: `step:${stepIndex}`,
        target: agentName,
      }),
      ...whenDefined(ctx.teamName, (definedValue) => ({ teamName: definedValue })),
      fromName: ctx.config.coordinator ?? 'coordinator',
      policy: resolvedPolicy,
      ...whenDefined(fallbackAgent, (definedValue) => ({ fallbackAgent: definedValue })),
      ...whenDefined(fallbackRosterEntry, (definedValue) => ({ fallbackRosterEntry: definedValue })),
      ...whenDefined(fallbackFinalPrompt, (definedValue) => ({ fallbackFinalPrompt: definedValue })),
      levelId: ctx.levelId,
      stageType: STAGE_TYPE.CHAIN,
      sessionId: state.sessionId,
      ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
      errorLogPath: ctx.outputPath,
      onFailureRecorded: (aName, error) => {
        const m = ctx.agentMetrics.get(aName)
        if (m) { m.failureCount++; m.lastError = error }
      },
      ...whenDefined(ctx.budgetLedger, (definedValue) => ({ budgetLedger: definedValue })),
      totalCost: state.totalCost,
      ...(budgetAdmission ? { budgetAdmission } : {}),
      ...whenDefined(effectiveTimeoutMinutes, (definedValue) => ({ timeoutMinutes: definedValue })),
      ...whenDefined(retryDeadlineMs, (definedValue) => ({ retryDeadlineMs: definedValue })),
      ...whenDefined(qualityOutputSchema, (definedValue) => ({ outputSchema: definedValue })),
      ...whenDefined(ctx.config.config.structured_output === 'deep_research_quality_verdict'
        ? (text: string) => {
            try {
              const verdict = parseDeepResearchQualityReviewResult({
                text,
                assignmentPath: ctx.outputPath,
              })
              validatedQualityVerdict = verdict
              return JSON.stringify(verdict)
            } catch (error) {
              const detail = qualityReviewFailureDetail(error)
              throw new DispatchResultValidationError(
                `Structured quality verdict failed validation: ${detail}`,
                'deep_research_quality_verdict',
                [
                  'Return exactly one strict QualityVerdict JSON object with no Markdown fences or commentary.',
                  'Correction request impactScope must be exactly local or global; use local for section, claim, requirement, or task corrections.',
                  `Runtime validator: ${detail}`,
                ].join(' '),
              )
            }
          }
        : undefined, (definedValue) => ({ validateResult: definedValue })),
    })

    if (result.interruption) {
      ctx.onStateCheckpoint?.()
      throw new AgentQuestionInterruptionError(result.interruption)
    }
    if (result.skipped) {
      // Chain cannot skip steps — a missing link breaks the chain. Escalate to error.
      return { error: `Agent ${agentName} was skipped but chain requires all steps. Halting chain.` }
    }

    const canonicalOutput = resolveRuntimeOwnedArtifactContent(result.text, canonicalStepOutputPath)
    const blockedReason = resolveBlockedChainStepReason(canonicalOutput)
    writeMarkdownArtifact(
      stepFile,
      canonicalOutput,
      buildArtifactMetadata({
        filePath: stepFile,
        rootDir: ctx.outputPath,
        artifactType: 'handoff',
        sessionId: state.sessionId,
        ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
        ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
        level: ctx.levelId,
        stageType: 'chain',
        agent: agentName,
        status: blockedReason
          ? 'blocked'
          : stepIndex === sequence.length - 1
            ? 'complete'
            : 'handoff',
        step: stepIndex + 1,
        role: 'chain-step',
      }),
    )

    if (blockedReason) {
      if (stepIndex === sequence.length - 1) {
        writeMarkdownArtifact(
          canonicalStepOutputPath,
          canonicalOutput,
          buildArtifactMetadata({
            filePath: canonicalStepOutputPath,
            rootDir: ctx.outputPath,
            artifactType: 'result',
            artifactRole: 'final',
            sessionId: state.sessionId,
            ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
            ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
            level: ctx.levelId,
            stageType: 'chain',
            agent: agentName,
            status: 'blocked',
            step: stepIndex + 1,
            role: 'chain-blocker',
          }),
        )

        const workflowCompletionArtifact = ctx.teamConfig.workflow?.output_contract?.completion_artifact
        if (workflowCompletionArtifact) {
          const workflowOutputPath = resolveOwnedRunRelativePath({
            assignmentPath: ctx.outputPath,
            relativePath: workflowCompletionArtifact,
            label: 'Blocked chain workflow output',
          })
          if (path.resolve(workflowOutputPath) !== path.resolve(canonicalStepOutputPath)) {
            writeMarkdownArtifact(
              workflowOutputPath,
              canonicalOutput,
              buildArtifactMetadata({
                filePath: workflowOutputPath,
                rootDir: ctx.outputPath,
                artifactType: 'report',
                artifactRole: 'final',
                sessionId: state.sessionId,
                ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
                ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
                level: ctx.levelId,
                stageType: 'chain',
                agent: agentName,
                status: 'blocked',
                step: stepIndex + 1,
                role: 'workflow-blocker',
              }),
            )
          }
        }
      }
      updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
      return {
        error:
          `Agent ${agentName} returned a BLOCKED handoff and the chain cannot continue.\n\n` +
          `${blockedReason}`,
      }
    }

    chainState.outputs.push({ agent: agentName, text: canonicalOutput })
    // Only here: the response has survived canonicalization and the BLOCKED
    // check above, so this is the first point at which the step has an answer
    // rather than a provider reply.
    publishAcceptedTeamChatMessage(ctx, {
      agentName: result.agentName ?? agentName,
      ...whenDefined(result.dispatchId, (dispatchId) => ({ dispatchId })),
      stageType: STAGE_TYPE.CHAIN,
      text: canonicalOutput,
    })
    updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.RUNNING)

    return {
      output: canonicalOutput,
      ...(validatedQualityVerdict === undefined
        ? {}
        : { qualityVerdict: validatedQualityVerdict }),
      ...(levelTimeoutNotice === undefined
        ? {}
        : { notice: `Level timeout clamped: ${levelTimeoutNotice}` }),
    }
  } catch (err) {
    if (err instanceof AgentQuestionInterruptionError) throw err
    if (signal?.aborted || ctx.shutdownSignal?.aborted) {
      throw err
    }
    if (err instanceof HaltError) {
      return { error: `Chain halted at step ${stepIndex + 1} (${agentName}): ${err.message}` }
    }
    const errMsg = err instanceof Error ? err.message : String(err)
    return { error: errMsg }
  }
}

/** Format constraint status note. */
function buildConstraintNote(config: ChainStageConfig, state: ChainContext['state']): string {
  if (!config.config.constraints) return ''
  checkConstraints(config.config.constraints, state.startTime, state.totalCost, state.endTime)
  return `\n\n---\n**Constraints:** ${formatElapsed(state.startTime, state.endTime)} elapsed, ${formatCost(state.totalCost)} spent`
}

// ─── handoff tool ────────────────────────────────────────────────────────────

/**
 * Create the `handoff` tool for a chain stage.
 */
export function createChainTool(ctx: ChainContext): ToolDefinition {
  return {
    name: 'handoff',
    label: 'Chain Handoff',
    description:
      `Start or continue the chain handoff sequence. ` +
      `Use action: 'status' to check chain progress. ` +
      `The chain runs automatically through the configured agent sequence.`,
    promptSnippet:
      `Use \`handoff\` to start a sequential chain of agents. Each agent's output becomes the next agent's input.`,
    promptGuidelines: [
      'Call `handoff` with no arguments to bootstrap from the current assignment input artifact.',
      "The chain runs through all agents in sequence automatically.",
      'Each step output is saved as chain-step-{N}-{agent}.md inside the current assignment folder.',
      'After a successful chain run, stop. Do not call `handoff` again in the same coordinator turn; the runtime will advance levels automatically.',
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('start'),
        Type.Literal('status'),
        Type.Literal('resume'),
      ])),
      message: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
    }, {
      additionalProperties: true,
      description:
        'Optional chain parameters as an object. Supports { action, message } and accepts content as an alias for message. ' +
        'When no message is provided, the runtime loads the current chain input artifact automatically.',
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _extensionCtx) {
      const budgetAdmission = adoptBudgetDispatchAdmission({
        ledger: ctx.budgetLedger,
        adopt: ctx.adoptCapabilityBudget,
        toolCallId: _toolCallId,
      })
      const { config, outputPath } = ctx
      const safeParams = normalizeChainParams(params)

      // ── status ──
      if (safeParams.action === 'status') {
        const chainState = getChainState(ctx)
        if (!chainState) {
          return { details: undefined, content: [{ type: 'text' as const, text: 'Chain not started yet. Use action: "start" to begin.' }] }
        }
        const progress = `Step ${chainState.currentStep}/${chainState.totalSteps}`
        const outputs = chainState.outputs.map((o) => `  - ${o.agent}: ${o.text.slice(0, 100)}...`).join('\n')
        return { details: undefined, content: [{ type: 'text' as const, text: `**Chain Progress:** ${progress}\n\n**Completed steps:**\n${outputs}` }] }
      }

      const sequence = config.sequence
      if (sequence.length === 0) {
        updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
        return { details: undefined, content: [{ type: 'text' as const, text: 'Chain sequence is empty — no agents configured.' }] }
      }
      if (
        config.config.structured_output === 'deep_research_quality_verdict' &&
        sequence.length !== 1
      ) {
        let blockerFailure = ''
        try {
          persistQualityReviewEmergencyBlocker({ ctx, outputPath })
        } catch (error) {
          blockerFailure = ` Emergency publication blocker failed: ${error instanceof Error ? error.message : String(error)}`
        }
        updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
        return {
          details: undefined,
          content: [{
            type: 'text' as const,
            text:
              'Chain blocked: structured Deep Research quality review must contain exactly one critic step.' +
              blockerFailure,
          }],
        }
      }

      const existingState = getChainState(ctx)
      if (existingState && isChainComplete(existingState)) {
        updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)
        return {
          details: undefined,
          content: [{
            type: 'text' as const,
            text: 'Chain already complete for this level. Stop here and let the runtime advance to the next level.',
          }],
        }
      }
      if (existingState && existingState.currentStep > 0 && safeParams.action !== 'resume') {
        return {
          details: undefined,
          content: [{
            type: 'text' as const,
            text:
              `Chain already started for this level (${existingState.currentStep}/${existingState.totalSteps} steps recorded). ` +
              `Use action: "resume" to retry from the failed step or action: "status" to inspect progress.`,
          }],
        }
      }

      const isResuming = Boolean(existingState && safeParams.action === 'resume')
      const chainState = existingState ?? initChainState(ctx, sequence)
      if (!isResuming) {
        chainState.currentStep = 0
        chainState.totalSteps = sequence.length
        chainState.outputs = []
      }
      updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.RUNNING)

      let initialContent: string
      try {
        initialContent = resolveInitialChainContent(
          ctx,
          ctx.teamConfig,
          ctx.levelId,
          outputPath,
          safeParams.message,
        )
      } catch (error) {
        // Refused before launch, or a runtime artifact that does not belong to
        // this approved plan. Either way no provider process starts and the
        // reason reaches the operator intact.
        updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
        return {
          details: undefined,
          content: [{
            type: 'text' as const,
            text: `**Chain Blocked** — ${error instanceof Error ? error.message : String(error)}`,
          }],
        }
      }
      if (!initialContent.trim()) {
        updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
        return {
          details: undefined,
          content: [{
            type: 'text' as const,
            text: buildChainBootstrapError(ctx.teamConfig, ctx.levelId, outputPath, safeParams.message),
          }],
        }
      }

      if (!isResuming) {
        const briefPath = path.join(outputPath, 'brief.md')
        writeMarkdownArtifact(
          briefPath,
          `# Chain Brief\n\n${initialContent}`,
          buildArtifactMetadata({
            filePath: briefPath,
            rootDir: outputPath,
            artifactType: 'brief',
            sessionId: ctx.state.sessionId,
            ...whenDefined(ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
            ...whenDefined(ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
            level: ctx.levelId,
            stageType: 'chain',
            status: 'active',
          }),
        )
      }

      // Run through the sequence
      const firstPendingStep = Math.min(chainState.outputs.length, sequence.length)
      chainState.currentStep = firstPendingStep
      let currentInput = chainState.outputs.at(-1)?.text ?? initialContent
      let validatedQualityVerdict: QualityVerdict | undefined
      const responses: string[] = isResuming
        ? [`Resuming from step ${firstPendingStep + 1}.`]
        : []
      let failed = false
      let failureReason: string | undefined

      for (let i = firstPendingStep; i < sequence.length; i++) {
        const stepResult = await runChainStep(
          ctx,
          chainState,
          sequence,
          i,
          currentInput,
          initialContent,
          _signal,
          budgetAdmission,
        )

        if ('error' in stepResult) {
          responses.push(`**Step ${i + 1} (${sequence[i]}):** Error — ${stepResult.error}`)
          failed = true
          failureReason = stepResult.error
          break
        }

        currentInput = stepResult.output
        validatedQualityVerdict =
          stepResult.qualityVerdict ?? validatedQualityVerdict
        if (stepResult.notice) responses.push(`**${stepResult.notice}**`)
        responses.push(`**Step ${i + 1} (${sequence[i]}):** Completed`)
      }

      const constraintNote = buildConstraintNote(config, ctx.state)
      if (failed) {
        if (config.config.structured_output === 'deep_research_quality_verdict') {
          try {
            const fallback = persistQualityReviewFailureEscalation({
              ctx,
              chainState,
              sequence,
              outputPath,
              ...whenDefined(failureReason, (definedValue) => ({ failureReason: definedValue })),
            })
            updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)
            return {
              details: undefined,
              content: [{
                type: 'text' as const,
                text:
                  `**Chain Complete** (${chainState.currentStep}/${chainState.totalSteps} steps)\n\n` +
                  `**Quality reviewer unavailable after bounded recovery:** ${qualityReviewFailureDetail(failureReason)}\n\n` +
                  '**Fallback:** deterministic escalation saved.\n\n' +
                  `**Final output saved to:** ${fallback.outputFilePath}\n` +
                  `Do not call \`handoff\` again in this turn. The runtime will advance levels automatically.${constraintNote}`,
              }],
            }
          } catch (fallbackError) {
            let emergencyBlockerError: unknown
            try {
              persistQualityReviewEmergencyBlocker({
                ctx,
                outputPath,
              })
            } catch (error) {
              emergencyBlockerError = error
            }
            responses.push(
              `**Deterministic escalation failed:** ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
            )
            if (emergencyBlockerError) {
              responses.push(
                `**Emergency publication blocker failed:** ${emergencyBlockerError instanceof Error ? emergencyBlockerError.message : String(emergencyBlockerError)}`,
              )
            }
          }
        }
        updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
        return {
          details: undefined,
          content: [{
            type: 'text' as const,
            text: `**Chain Blocked** (${chainState.currentStep}/${chainState.totalSteps} steps)\n\n` +
              responses.join('\n') +
              `${constraintNote}`,
          }],
        }
      }

      const outputFilePath = getChainOutputPath(config, outputPath)
      if (config.config.structured_output === 'deep_research_quality_verdict') {
        try {
          if (validatedQualityVerdict === undefined) {
            throw new Error(
              'Structured quality verdict was not retained after successful validation.',
            )
          }
          const verdict = validatedQualityVerdict
          persistVersionedDeepResearchQualityVerdict({
            assignmentPath: outputPath,
            verdict,
          })
          if (verdict.decision === 'ESCALATE') {
            persistQualityEscalationBlocker({
              ctx,
              outputPath,
              verdict,
            })
          }
          writeFileAtomicSync(outputFilePath, `${JSON.stringify(verdict, null, 2)}\n`)
        } catch (error) {
          try {
            const fallback = persistQualityReviewFailureEscalation({
              ctx,
              chainState,
              sequence,
              outputPath,
              failureReason: qualityReviewFailureDetail(error),
            })
            updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)
            return {
              details: undefined,
              content: [{
                type: 'text' as const,
                text:
                  `**Chain Complete** (${chainState.currentStep}/${chainState.totalSteps} steps)\n\n` +
                  `**Quality reviewer returned an invalid verdict:** ${qualityReviewFailureDetail(error)}\n\n` +
                  '**Fallback:** deterministic escalation saved.\n\n' +
                  `**Final output saved to:** ${fallback.outputFilePath}\n` +
                  `Do not call \`handoff\` again in this turn. The runtime will advance levels automatically.${constraintNote}`,
              }],
            }
          } catch (fallbackError) {
            let emergencyBlockerError: unknown
            try {
              persistQualityReviewEmergencyBlocker({
                ctx,
                outputPath,
              })
            } catch (emergencyError) {
              emergencyBlockerError = emergencyError
            }
            updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
            return {
              details: undefined,
              content: [{
                type: 'text' as const,
                text:
                  `**Chain Blocked:** Structured quality verdict failed validation: ${error instanceof Error ? error.message : String(error)} ` +
                  `Deterministic escalation also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}` +
                  (emergencyBlockerError
                    ? ` Emergency publication blocker also failed: ${emergencyBlockerError instanceof Error ? emergencyBlockerError.message : String(emergencyBlockerError)}`
                    : ''),
              }],
            }
          }
        }
      } else {
        writeMarkdownArtifact(
          outputFilePath,
          currentInput,
          buildArtifactMetadata({
            filePath: outputFilePath,
            rootDir: outputPath,
            artifactType: 'result',
            sessionId: ctx.state.sessionId,
            ...whenDefined(ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
            ...whenDefined(ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
            level: ctx.levelId,
            stageType: 'chain',
            status: 'complete',
          }),
        )
      }
      updateChainStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)

      return {
        details: undefined,
        content: [{
          type: 'text' as const,
          text: `**Chain Complete** (${chainState.currentStep}/${chainState.totalSteps} steps)\n\n` +
            responses.join('\n') +
            `\n\n**Final output saved to:** ${outputFilePath}\n` +
            `Do not call \`handoff\` again in this turn. The runtime will advance levels automatically.${constraintNote}`,
        }],
      }
    },

    renderCall(args, theme) {
      const action = (args as Record<string, unknown>).action ?? 'start'
      return new Text(`${theme.fg('accent', 'handoff')} ${action}`)
    },

    renderResult(result, _options, theme) {
      const text = (result.content?.[0] as { text?: string })?.text ?? ''
      const isComplete = text.includes('Chain Complete')
      return new Text(isComplete ? theme.fg('success', 'Chain complete') : theme.fg('warning', 'Chain in progress'))
    },
  }
}

function persistQualityReviewFailureEscalation(input: {
  readonly ctx: ChainContext
  readonly chainState: ChainState
  readonly sequence: readonly string[]
  readonly outputPath: string
  readonly failureReason?: string
}): { readonly outputFilePath: string } {
  if (input.sequence.length !== 1 || input.chainState.totalSteps !== 1) {
    throw new Error('Structured Deep Research quality review must contain exactly one critic step.')
  }
  const verdict = buildDeepResearchQualityReviewFailureVerdict({
    assignmentPath: input.outputPath,
    ...whenDefined(input.failureReason, (definedValue) => ({ failureReason: definedValue })),
  })
  persistVersionedDeepResearchQualityVerdict({
    assignmentPath: input.outputPath,
    verdict,
  })
  persistQualityEscalationBlocker({
    ctx: input.ctx,
    outputPath: input.outputPath,
    verdict,
  })
  const outputFilePath = getChainOutputPath(input.ctx.config, input.outputPath)
  const verdictText = `${JSON.stringify(verdict, null, 2)}\n`
  writeFileAtomicSync(outputFilePath, verdictText)

  const stepIndex = Math.max(
    0,
    Math.min(input.chainState.currentStep - 1, input.sequence.length - 1),
  )
  const agentName = input.sequence[stepIndex] ?? 'evidence-critic'
  const stepFile = getChainStepArtifactPath(
    input.outputPath,
    stepIndex,
    agentName,
  )
  writeMarkdownArtifact(
    stepFile,
    verdictText,
    buildArtifactMetadata({
      filePath: stepFile,
      rootDir: input.outputPath,
      artifactType: 'handoff',
      sessionId: input.ctx.state.sessionId,
      ...whenDefined(input.ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
      ...whenDefined(input.ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
      level: input.ctx.levelId,
      stageType: 'chain',
      agent: agentName,
      status: 'complete',
      step: stepIndex + 1,
      role: 'quality-review-fallback',
    }),
  )
  input.chainState.outputs = [{ agent: agentName, text: verdictText }]
  input.chainState.currentStep = input.chainState.totalSteps
  return { outputFilePath }
}

function persistQualityEscalationBlocker(input: {
  readonly ctx: ChainContext
  readonly outputPath: string
  readonly verdict: QualityVerdict
}): void {
  const blockingFindings = input.verdict.findings.filter(
    (finding) => finding.severity === 'blocking',
  )
  const findings = blockingFindings.length > 0
    ? blockingFindings
    : input.verdict.findings
  const blocker = [
    '# Deep Research Requires Attention',
    '',
    '**Status:** BLOCKED',
    '',
    '## Hard Gaps',
    '',
    ...(findings.length > 0
      ? findings.map((finding) => {
          const affected = [
            finding.taskIds.length > 0 ? `tasks ${finding.taskIds.join(', ')}` : '',
            finding.sectionIds.length > 0 ? `sections ${finding.sectionIds.join(', ')}` : '',
          ].filter(Boolean).join('; ')
          return `- ${finding.message}${affected ? ` (${affected})` : ''}`
        })
      : ['- The required quality review could not establish that automatic publication is safe.']),
    '',
    '## Required Action',
    '',
    'Review the listed evidence gaps, adjust the approved scope or source access if needed, and start a new bounded research run.',
  ].join('\n')

  persistQualityBlockerArtifacts({
    ctx: input.ctx,
    outputPath: input.outputPath,
    blocker,
    label: 'Deep Research quality escalation',
    correctionWave: input.verdict.correctionWave,
  })
}

function persistQualityReviewEmergencyBlocker(input: {
  readonly ctx: ChainContext
  readonly outputPath: string
}): void {
  const blocker = [
    '# Deep Research Requires Attention',
    '',
    '**Status:** BLOCKED',
    '',
    '## Hard Gaps',
    '',
    '- The required quality review could not be completed or safely persisted.',
    '',
    '## Required Action',
    '',
    'Review the run diagnostics and start a new bounded research run after the quality-review path is available.',
  ].join('\n')

  persistQualityBlockerArtifacts({
    ctx: input.ctx,
    outputPath: input.outputPath,
    blocker,
    label: 'Deep Research emergency quality blocker',
  })
}

function persistQualityBlockerArtifacts(input: {
  readonly ctx: ChainContext
  readonly outputPath: string
  readonly blocker: string
  readonly label: string
  readonly correctionWave?: number
}): void {
  preserveResearchReportBeforeBlocker(input)

  for (const [relativePath, artifactType, role] of [
    ['research/quality/escalation.md', 'result', 'research-escalation'],
    ['research-package.md', 'report', 'workflow-blocker'],
  ] as const) {
    const filePath = resolveOwnedRunRelativePath({
      assignmentPath: input.outputPath,
      relativePath,
      label: input.label,
    })
    writeMarkdownArtifact(
      filePath,
      input.blocker,
      buildArtifactMetadata({
        filePath,
        rootDir: input.outputPath,
        artifactType,
        artifactRole: 'final',
        sessionId: input.ctx.state.sessionId,
        ...whenDefined(input.ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
        ...whenDefined(input.ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
        level: input.ctx.levelId,
        stageType: 'chain',
        status: 'blocked',
        role,
      }),
    )
  }
}

function preserveResearchReportBeforeBlocker(input: {
  readonly ctx: ChainContext
  readonly outputPath: string
  readonly correctionWave?: number
}): void {
  const reportPath = resolveOwnedRunRelativePath({
    assignmentPath: input.outputPath,
    relativePath: 'research-package.md',
    label: 'Deep Research synthesized report',
  })
  if (!fs.existsSync(reportPath)) return
  const reportStat = fs.lstatSync(reportPath)
  if (!reportStat.isFile() || reportStat.isSymbolicLink()) {
    throw new Error('Deep Research synthesized report must be a regular owned file.')
  }
  const report = fs.readFileSync(reportPath, 'utf8')
  const reportBody = resolveRuntimeOwnedArtifactContent(report, reportPath)
  if (resolveBlockedChainStepReason(reportBody)) return

  const archivePath = resolveOwnedRunRelativePath({
    assignmentPath: input.outputPath,
    relativePath: `research/reports/report-wave-${input.correctionWave ?? 0}.md`,
    label: 'Deep Research synthesized report archive',
  })
  if (fs.existsSync(archivePath)) return
  writeFileAtomicSync(archivePath, report)
}

function qualityReviewFailureDetail(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error ?? 'Unknown quality-review failure.')
  return value.replace(/\s+/gu, ' ').trim().slice(0, 500) || 'Unknown quality-review failure.'
}

// ─── Public Engine API ───────────────────────────────────────────────────────

export function isChainComplete(state: ChainState): boolean {
  // `currentStep` is set before a worker dispatch starts, so it can point at
  // the final step even when that dispatch failed. Persisted outputs are the
  // durable record of completed work and therefore the correct completion test.
  return state.outputs.length >= state.totalSteps
}

export function getChainOutputPath(config: ChainStageConfig, outputPath: string): string {
  const configuredPath = config.config.output.path
  const outputDir = configuredPath
    ? (path.isAbsolute(configuredPath) ? configuredPath : path.join(outputPath, configuredPath))
    : outputPath
  return path.join(outputDir, config.config.output.format)
}

export function getChainStepArtifactPath(outputPath: string, stepIndex: number, agentName: string): string {
  return path.join(outputPath, `chain-step-${stepIndex + 1}-${agentName}.md`)
}

/**
 * Whether the agent at this step answered with its own BLOCKED verdict.
 *
 * The step file is written before the chain records BLOCKED, so an agent's
 * decision is on disk. A step that stopped for any other reason, such as a
 * lost parent or a stopped process, left no such file.
 */
export function hasBlockedChainStepVerdict(
  outputPath: string,
  sequence: readonly string[],
  stepIndex: number,
): boolean {
  const agentName = sequence[stepIndex]
  if (agentName === undefined) return false
  const stepFile = getChainStepArtifactPath(outputPath, stepIndex, agentName)
  if (!fs.existsSync(stepFile)) return false
  return readMarkdownArtifact(stepFile).metadata.status === 'blocked'
}
