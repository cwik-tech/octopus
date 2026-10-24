/**
 * Team Runtime — Discussion Engine
 *
 * Round-based multi-agent discussion where a coordinator moderates
 * exchanges between participant agents. Supports brainstorm, evaluate,
 * debate, and deliberate modes.
 *
 * Extracted and generalized from CMO-crew's `converse` tool.
 *
 * Tool registered: `converse`
 */

import { whenDefined } from '../core/optional-properties.js'
import { AgentQuestionInterruptionError } from '../core/agent-question-interruption.js'
import { TEAM_CHAT_ROSTER_SIZE_GUIDELINE } from '../core/team-chat-roster-policy.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Type } from 'typebox'
import { Text } from '@earendil-works/pi-tui'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  DiscussionStageConfig,
  DiscussionState,
  ConversationMessage,
  BaseEngineContext,
  ContextStrategy,
  LevelConfig,
  TeamConfig,
} from '../core/types.js'
import {
  STAGE_TYPE,
  DISCUSSION_MODE,
  DEFAULT_CONTEXT_STRATEGY,
  DEFAULT_CONTEXT_WINDOW_ROUNDS,
  DEFAULT_SUMMARIZE_AFTER_ROUNDS,
  DEFAULT_AUXILIARY_LLM_TIMEOUT_MINUTES,
  LEVEL_STATUS,
  STAGE_LIFECYCLE_STATUS,
} from '../core/constants.js'
import { compressConversation } from '../domains/agent-execution/context-compressor.js'
import { dispatchWithFailurePolicy, resolveFailurePolicy, HaltError } from '../domains/agent-execution/failure-policy.js'
import { resolveChildWorkspacePath } from '../parsers/team-config.js'
import { checkConstraints, formatConstraintStatus } from '../core/constraints.js'
import { combineAbortSignals } from '../core/timeout-manager.js'
import { substituteTemplateVars } from '../domains/runtime/template.js'
import { getAssignmentLogPath, logConversationMessage, logSessionStart } from '../domains/runtime/logger.js'
import {
  publishAcceptedTeamChatMessage,
  type TeamChatMessageOutcome,
  type TeamChatMessageScope,
} from '../domains/runtime/team-chat-messages.js'
import { canTransitionStageStatus, transitionStageStatus } from '../domains/stage/stage-lifecycle.js'
import { buildArtifactMetadata, writeMarkdownArtifact } from '../domains/runtime/artifacts.js'
import { deriveEffectiveStageContractsForTeam } from '../domains/stage/stage-contracts.js'
import {
  adoptBudgetDispatchAdmission,
  roundUsd,
  type BudgetDispatchAdmission,
} from '../core/budget-ledger.js'
import {
  buildDiscussionSpecialistInvocationId,
  recordDiscussionTargetCompletion,
  deriveDiscussionContributionStatus,
  resolveDiscussionEffectiveTargets,
} from '../core/discussion-continuation-control.js'
import {
  hasHumanInputBroadcast,
  humanInputDirectRecipientIds,
  humanInputMessagesForRecipient,
} from '../contracts/human-input.js'

export interface DiscussionContext extends BaseEngineContext<DiscussionStageConfig> {
  humanQuestions?: boolean
  teamName: string
  getCurrentCoordinatorRunId: () => number
  onRosterSelected?: (agents: readonly string[]) => void
  onStateCheckpoint?: () => void
}

function normalizeDiscussionParams(
  input: unknown,
): { to?: string | string[]; message?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (typeof input === 'string' && input.trim()) return { message: input }
    return {}
  }

  const raw = input as Record<string, unknown>
  const to = Array.isArray(raw.to)
    ? raw.to.filter((value): value is string => typeof value === 'string')
    : typeof raw.to === 'string'
      ? raw.to
      : undefined
  const message = typeof raw.message === 'string'
    ? raw.message
    : typeof raw.content === 'string'
      ? raw.content
      : undefined

  return {
    ...whenDefined(to, (presentTo) => ({ to: presentTo })),
    ...whenDefined(message, (presentMessage) => ({ message: presentMessage })),
  }
}

function updateDiscussionStageStatus(
  ctx: DiscussionContext,
  next: typeof STAGE_LIFECYCLE_STATUS[keyof typeof STAGE_LIFECYCLE_STATUS],
): void {
  const levelState = ctx.state.levelStates.get(ctx.levelId)
  if (!levelState || !levelState.stageStatus || levelState.stageStatus === next) return
  if (!canTransitionStageStatus(levelState.stageStatus, next)) return
  transitionStageStatus(levelState, next)
}

function resolveInitialDiscussionMessage(
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

function buildDiscussionBootstrapError(
  teamConfig: TeamConfig | undefined,
  currentLevelId: string,
  outputPath: string,
  providedMessage?: string,
): string {
  if (providedMessage && providedMessage.trim()) {
    return `Discussion bootstrap failed: provided discussion message was empty after trimming for level '${currentLevelId}'.`
  }
  const contracts = teamConfig ? deriveEffectiveStageContractsForTeam(teamConfig, currentLevelId) : { input: { artifacts: [] } }
  const artifactPreview = (contracts.input.artifacts ?? [])
    .map((artifact) => `\`${artifact.path}\``)
    .join(', ')

  return (
    `Discussion bootstrap failed: no initial discussion brief was available for level '${currentLevelId}'. ` +
    `Expected one of the declared input artifacts ${artifactPreview || '`brief.md`'} to exist in \`${outputPath}\`, ` +
    `or explicit \`message\` / \`content\` to be passed to \`converse\`.`
  )
}

function buildDiscussionResult(text: string, terminate = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
    ...(terminate ? { terminate: true } : {}),
  }
}

function buildContinuationPrompt(round: number): string {
  return (
    `Continue the discussion for round ${round}. ` +
    `Refine positions, converge where possible, and surface any remaining disagreements or open questions.`
  )
}

// ─── State Helpers ───────────────────────────────────────────────────────────

/** Get existing discussion state or null — does NOT mutate. */
export function getDiscussionState(ctx: DiscussionContext): DiscussionState | null {
  const es = ctx.state.levelStates.get(ctx.levelId)?.engineState
  if (es?.type === STAGE_TYPE.DISCUSSION) return es
  return null
}

/** Initialize a fresh discussion state and store it in level state. */
function initDiscussionState(ctx: DiscussionContext): DiscussionState {
  const { outputPath } = ctx
  fs.mkdirSync(outputPath, { recursive: true })

  const discussion: DiscussionState = {
    type: STAGE_TYPE.DISCUSSION,
    round: 0,
    messages: [],
    outputPath,
  }

  const levelState = ctx.state.levelStates.get(ctx.levelId)
  if (levelState) {
    levelState.engineState = discussion
  } else {
    ctx.state.levelStates.set(ctx.levelId, {
      status: LEVEL_STATUS.ACTIVE,
      stageStatus: STAGE_LIFECYCLE_STATUS.READY,
      engineState: discussion,
      loopbackCount: 0,
    })
  }
  return discussion
}

/** Get or initialize discussion state for the `set_roster` / `create_brief` tools. */
export function getOrInitDiscussionState(ctx: DiscussionContext): DiscussionState {
  return getDiscussionState(ctx) ?? initDiscussionState(ctx)
}

// Setup tools (set_roster, create_brief) are in ./discussion-tools.ts

// ─── converse tool ───────────────────────────────────────────────────────────

// Mode-specific prompt additions (module-level constant, not per-call)
const modeInstructions: Record<string, string> = {
  [DISCUSSION_MODE.BRAINSTORM]: 'This is a brainstorming session. Generate ideas freely. Avoid criticism at this stage — build on ideas instead.',
  [DISCUSSION_MODE.EVALUATE]: 'This is an evaluation session. Score and rank the options presented. Be rigorous and data-driven.',
  [DISCUSSION_MODE.DEBATE]: 'This is a debate session. Take clear positions and argue them. Challenge opposing viewpoints with evidence.',
  [DISCUSSION_MODE.DELIBERATE]: 'This is a deliberation session. Weigh all perspectives carefully. Seek consensus where possible, note dissent where not.',
}

/**
 * A delegated child run is headless (`-p --no-session`): it has no user turn,
 * so instructing the coordinator to wait for approval would strand the stage.
 * Interactive runs keep the approval handshake.
 */
function buildRosterGuidelines(delegated: boolean, chatMode: boolean, humanQuestions: boolean): string[] {
  const teamChatRosterGuideline = chatMode
    ? [`TEAM CHAT ROSTER SIZE: ${TEAM_CHAT_ROSTER_SIZE_GUIDELINE}`]
    : []
  if (delegated) {
    if (humanQuestions) return [
      'AGENT SELECTION: select the roster yourself from relevant participants, then set_roster, create_brief, and converse. Do not request roster approval.',
      ...teamChatRosterGuideline,
      'A necessary blocking question may pause an agent through the managed human-question mechanism. Batch necessary questions into one round; optional preferences do not block this run.',
      'Keep runtime identifiers and filesystem paths out of participant responses.',
    ]
    return [
      "AGENT SELECTION (mandatory before first converse): This is a delegated session with no user to consult. Do not wait for approval — select the roster yourself from the participants most relevant to this topic, call `set_roster` with those names, then call `create_brief`, then `converse`. `converse` will NOT work until `set_roster` has been called.",
      ...teamChatRosterGuideline,
      "Do not pause for user confirmation at any point; treat the delegated brief as sufficient and proceed with the analysis you can produce.",
      "Keep internal session IDs, run IDs, assignment IDs, and filesystem paths out of participant responses. They are runtime metadata, not user-facing report content.",
    ]
  }
  return [
    "AGENT SELECTION (mandatory before first converse): Before calling converse for the first time, you MUST propose which agents should participate in this discussion. List each available agent with a one-line rationale for why they are or aren't relevant to this specific topic. Then ask the user if they are okay with this selection. Wait for their response. Treat clear affirmative replies such as 'yes', 'ok', 'okay', 'go ahead', 'looks good', 'sounds good', and close variants as approval. Treat ambiguous replies as non-approval and clarify instead of assuming. If the user wants changes, adjust accordingly. After explicit approval, call `set_roster` once with the approved agent names. `converse` will NOT work until `set_roster` has been called. After locking the roster with `set_roster`, call `create_brief` to create a formal assignment brief synthesizing the user's inquiry, objectives, and scope before starting the discussion.",
    ...teamChatRosterGuideline,
    "BEFORE calling converse: Present your initial analysis/classification to the user first. Ask if they agree with the framing and if they have anything to add. Only call converse AFTER the user confirms or provides additional input. If the user just says 'yes', 'go ahead', 'looks good' or similar — proceed immediately to converse.",
  ]
}

function buildPostRoundGuideline(delegated: boolean): string {
  if (delegated) {
    return "AFTER each converse round: Continue autonomously from the delegated brief. Resolve uncertainty with explicit assumptions and proceed directly to the next useful analysis step."
  }
  return "AFTER each converse round: If the board surfaces questions that require user input (missing context, ambiguous requirements, strategic choices the user must make), DO NOT guess the answers. Present the questions to the user and wait for their response before calling converse again. You are the bridge between the board and the user."
}

/**
 * Create the `converse` tool for a discussion stage.
 */
export function createDiscussionTool(ctx: DiscussionContext): ToolDefinition {
  return {
    name: 'converse',
    label: 'Team Discussion',
    description:
      `Send a message to team members. Use to: 'all' to broadcast, or a specific agent name for targeted follow-up. ` +
      `Returns each addressed agent's response plus constraint status (time elapsed, budget spent).`,
    promptSnippet:
      `Use \`converse\` to communicate with team members. Default to \`to: 'all'\` for broadcasts. ` +
      `Use specific agent names for targeted follow-ups. Returns responses + constraint state.`,
    promptGuidelines: [
      ...buildRosterGuidelines(
        ctx.delegatedAutostart === true,
        ctx.chatMode === true,
        ctx.humanQuestions === true,
      ),
      ...(ctx.chatMode
        ? [
            "TEAM CHAT: `converse` performs one specialist pass per call. The discussion lead reviews that pass and either targets a follow-up or completes with a final synthesis.",
            "You can target specific members for follow-ups: `to: 'agent-name'`.",
          ]
        : [
            buildPostRoundGuideline(ctx.delegatedAutostart === true),
            "You can target specific members for follow-ups: `to: 'agent-name'`.",
          ]),
      "When using `to: 'all'`, only the roster-approved agents receive the message. You can also target specific approved agents by name.",
      "Calls are sequential — later members see earlier responses from the same round.",
      "Watch the constraint status in each response. When time or budget is near the max, wrap up.",
    ],
    parameters: Type.Object({
      to: Type.Optional(Type.Union([
        Type.String(),
        Type.Array(Type.String()),
      ])),
      message: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
    }, {
      additionalProperties: true,
      description:
        'Optional discussion parameters as an object. Supports { to, message } and accepts content as an alias for message. ' +
        'When omitted, the runtime bootstraps from the current discussion input artifact and runs bounded rounds automatically.',
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _extensionCtx) {
      const budgetAdmission = adoptBudgetDispatchAdmission({
        ledger: ctx.budgetLedger,
        adopt: ctx.adoptCapabilityBudget,
        toolCallId: _toolCallId,
      })
      const { config, state, outputPath, onDashboardUpdate } = ctx
      const safeParams = normalizeDiscussionParams(params)

      const discussion = initOrGetConversation(ctx, outputPath, config, state)

      // ── Hard gate: roster must be set before converse can run ──
      if (!discussion.approvedRoster) {
        throw new Error(
          'Cannot converse: no roster set. Call `set_roster` with the user-approved agent list before the first `converse` call.'
        )
      }

      // In chat the reader sees the convened subset in the sidebar the moment
      // it is dispatched, so the reasons for it have to arrive first.
      if (ctx.chatMode && !discussion.rosterAnnounced) {
        throw new Error(
          'Cannot converse: the selected roster has not been shared with the user yet. ' +
          'Call `create_brief` with a rationale for every selected agent first.'
        )
      }

      const runningPass = ctx.chatMode &&
        discussion.continuation?.phase === 'running_specialist_pass'
          ? discussion.continuation
          : undefined
      const resumingCurrentPass =
        runningPass !== undefined && discussion.round === runningPass.passNumber
      if (discussion.round >= config.config.max_rounds && !resumingCurrentPass) {
        if (!ctx.chatMode) {
          updateDiscussionStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)
        }
        return buildDiscussionResult(
          ctx.chatMode
            ? 'The configured discussion safety ceiling has been reached. The discussion lead must complete with a final synthesis.'
            : 'Discussion already complete for this level. Stop here and let the runtime advance.',
        )
      }
      const targets = resolveTargets(
        {
          to: safeParams.to ?? 'all',
          message: safeParams.message ?? '',
        },
        discussion,
      )
      const bootstrapMessage = resolveInitialDiscussionMessage(
        ctx.teamConfig,
        ctx.levelId,
        outputPath,
        safeParams.message,
      )
      if (!bootstrapMessage.trim()) {
        updateDiscussionStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
        return buildDiscussionResult(
          buildDiscussionBootstrapError(ctx.teamConfig, ctx.levelId, outputPath, safeParams.message),
        )
      }

      updateDiscussionStageStatus(ctx, STAGE_LIFECYCLE_STATUS.RUNNING)
      const roundSummaries: string[] = []

      const roundLimit = ctx.chatMode ? 1 : config.config.max_rounds
      while (
        ctx.chatMode
          ? roundSummaries.length < roundLimit
          : discussion.round < roundLimit
      ) {
        if (runningPass) {
          if (discussion.round === runningPass.passNumber - 1) {
            discussion.round = runningPass.passNumber
          } else if (discussion.round !== runningPass.passNumber) {
            throw new Error(
              `Recovered specialist pass ${runningPass.passNumber} does not match round ${discussion.round}.`,
            )
          }
        } else {
          discussion.round++
        }
        const roundMessage = ctx.chatMode || discussion.round === 1
          ? bootstrapMessage
          : buildContinuationPrompt(discussion.round)

        if (!resumingCurrentPass) {
          logOutgoingMessage(ctx, discussion, {
            to: safeParams.to ?? 'all',
            message: roundMessage,
          })
          ctx.onStateCheckpoint?.()
        }
        if (onDashboardUpdate) onDashboardUpdate()

        await maybeCompressHistory(ctx, discussion)
        updateDiscussionStageStatus(ctx, STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER)

        const roundResult = await runRound(
          ctx,
          discussion,
          targets,
          roundMessage,
          _signal,
          budgetAdmission,
        )
        if (roundResult.haltError) {
          updateDiscussionStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
          return buildDiscussionResult(
            `Discussion halted in round ${discussion.round}: ${roundResult.haltError.message}. ` +
            'Do not treat this stage as complete.',
          )
        }
        const contributionStatus = deriveDiscussionContributionStatus(discussion.messages, discussion.approvedRoster ?? [])
        const minSuccessfulParticipants = Math.min(
          Math.max(1, config.config.min_successful_participants ?? 1),
          Math.max(1, ctx.chatMode ? (discussion.approvedRoster?.length ?? 0) : roundResult.targetCount),
        )
        const successfulCount = ctx.chatMode ? contributionStatus.successfulCount : roundResult.successCount
        if (successfulCount < minSuccessfulParticipants) {
          updateDiscussionStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
          return buildDiscussionResult(
            `Discussion failed for round ${discussion.round}: only ${successfulCount} ` +
            `approved participant${successfulCount === 1 ? '' : 's'} produced a response, ` +
            `but ${minSuccessfulParticipants} ${minSuccessfulParticipants === 1 ? 'was' : 'were'} required. ` +
            'Do not treat this stage as complete. Check agent provider configuration or runtime credentials and retry.',
          )
        }
        roundSummaries.push(ctx.chatMode
          ? roundResult.responses.join('\n\n---\n\n')
          : `## Round ${discussion.round}\n\n${roundResult.responses.join('\n\n---\n\n')}`)
        updateDiscussionStageStatus(ctx, STAGE_LIFECYCLE_STATUS.RUNNING)
      }

      if (ctx.chatMode) {
        if (onDashboardUpdate) onDashboardUpdate()
        return buildDiscussionResult(roundSummaries.join('\n\n'))
      }

      const constraintStatus = checkConstraints(
        config.config.constraints,
        state.startTime,
        state.totalCost,
        state.endTime,
      )

      const outputFilePath = getDiscussionOutputPath(config, outputPath)
      const history = buildDiscussionHistory(discussion)
      const outputTitle = path.basename(outputFilePath).toLowerCase() === 'minutes.md'
        ? '# Meeting Minutes'
        : '# Discussion Outcome'
      writeMarkdownArtifact(
        outputFilePath,
        `${outputTitle}\n\n${history}`,
        buildArtifactMetadata({
          filePath: outputFilePath,
          rootDir: outputPath,
          artifactType: 'result',
          sessionId: state.sessionId,
          ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
          ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
          level: ctx.levelId,
          stageType: 'discussion',
          status: 'complete',
        }),
      )
      updateDiscussionStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)

      const statusText = formatConstraintStatus(
        constraintStatus,
        config.config.constraints,
        discussion.round,
        outputFilePath,
        config.config.output.user_review,
      )

      if (onDashboardUpdate) onDashboardUpdate()

      return buildDiscussionResult(roundSummaries.join('\n\n') + statusText)
    },

    renderCall(args, theme) {
      const to = (args as Record<string, unknown>).to ?? 'all'
      const toStr = Array.isArray(to) ? to.join(', ') : String(to)
      return new Text(`${theme.fg('accent', 'converse')} \u2192 ${toStr}`)
    },

    renderResult(result, _options, theme) {
      const text = (result.content?.[0] as { text?: string })?.text ?? ''
      const agentCount = (text.match(/\*\*[\w-]+:\*\*/g) || []).length
      return new Text(`${theme.fg('success', `${agentCount} response(s)`)} received`)
    },
  }
}

// ─── converse internal helpers ───────────────────────────────────────────────

/** Initialize or retrieve the discussion state, logging session start on first call. */
function initOrGetConversation(
  ctx: DiscussionContext,
  outputPath: string,
  config: DiscussionStageConfig,
  state: DiscussionContext['state'],
): DiscussionState {
  const existing = getDiscussionState(ctx)
  if (existing) return existing

  fs.mkdirSync(outputPath, { recursive: true })
  logSessionStart(outputPath, state.sessionId, ctx.teamName, config.participants, state.rootSessionId)

  const discussion: DiscussionState = {
    type: STAGE_TYPE.DISCUSSION,
    round: 0,
    messages: [],
    outputPath,
  }
  const levelState = state.levelStates.get(ctx.levelId)
  if (levelState) levelState.engineState = discussion
  return discussion
}

/** Resolve the list of target agent names from the `to` parameter. */
function resolveTargets(
  params: { to: string | string[]; message: string },
  discussion: DiscussionState,
): string[] {
  const effectiveParticipants = discussion.approvedRoster
  if (!effectiveParticipants) {
    throw new Error('Cannot resolve discussion targets: converse reached target resolution without an approved roster.')
  }

  if (params.to === 'all') return [...effectiveParticipants]

  if (Array.isArray(params.to)) {
    return (params.to as string[]).filter(name => effectiveParticipants.includes(name))
  }

  if (effectiveParticipants.includes(params.to)) return [params.to]

  throw new Error(`Agent '${params.to}' is not in the approved roster: ${effectiveParticipants.join(', ')}`)
}

interface DiscussionRoundResult {
  responses: string[]
  successCount: number
  targetCount: number
  haltError?: HaltError
}

/**
 * Record one accepted discussion reply in whichever durable family owns it.
 *
 * Exported because the choice made here is the whole of a defect that is
 * otherwise unreachable from outside: a Team chat run records the reply as
 * `team.message`, and the legacy `discussion.message` must then stay silent —
 * including on a second pass over an attempt already recorded, where the
 * publisher reports nothing new rather than nothing owned.
 *
 * The conversation file is written either way. It is the discussion's own
 * record, and the engine reads it back to build the next round.
 */
export function recordAcceptedDiscussionMessage(
  ctx: TeamChatMessageScope & { teamName?: string },
  message: ConversationMessage,
  contribution: { agentName: string; dispatchId?: string },
): TeamChatMessageOutcome {
  const outcome = publishAcceptedTeamChatMessage(ctx, {
    agentName: contribution.agentName,
    ...whenDefined(contribution.dispatchId, (dispatchId) => ({ dispatchId })),
    messageType: message.type,
    stageType: STAGE_TYPE.DISCUSSION,
    text: message.message,
  })
  logConversationMessage(ctx.outputPath, message, ctx.state.rootSessionId, {
    sessionId: ctx.state.sessionId,
    ...whenDefined(ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
    ...whenDefined(ctx.teamName, (definedValue) => ({ team: definedValue })),
    levelId: ctx.levelId,
    stageType: STAGE_TYPE.DISCUSSION,
    // The Team-chat contract decides this, never the insertion result.
    // `duplicate` and `unrecordable` both mean this run's messages belong to
    // the `team.message` family; emitting the legacy event on either would
    // put a second copy of the same answer in front of the reader.
    publishContentEvent: outcome === 'disabled',
  })
  return outcome
}

/** Log the coordinator's outgoing message. */
function logOutgoingMessage(
  ctx: DiscussionContext,
  discussion: DiscussionState,
  params: { to: string | string[]; message: string },
): void {
  const coordMsg: ConversationMessage = {
    from: ctx.config.coordinator,
    to: params.to === 'all' ? 'all' : (Array.isArray(params.to) ? params.to : [params.to]),
    round: discussion.round,
    timestamp: new Date().toISOString(),
    type: discussion.round === 1 ? 'framing' : 'probe',
    message: params.message,
  }
  discussion.messages.push(coordMsg)
  logConversationMessage(discussion.outputPath, coordMsg, ctx.state.rootSessionId, {
    sessionId: ctx.state.sessionId,
    ...whenDefined(ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
    ...whenDefined(ctx.teamName, (definedValue) => ({ team: definedValue })),
    levelId: ctx.levelId,
    stageType: STAGE_TYPE.DISCUSSION,
    // Direct Team chat publishes the lead's accepted framing through the same
    // durable `team.message` boundary as every other visible contribution.
    // The runtime owns that publication; emitting the legacy discussion event
    // here would show the same lead instruction twice.
    publishContentEvent: ctx.chatMode !== true,
  })
}

/** Build the substituted system prompt for a fallback agent in discussion context. */
function buildFallbackPrompt(
  agent: { systemPrompt: string; agentDir: string },
  state: DiscussionContext['state'],
  workspacePath: string,
  ctx: DiscussionContext,
): string {
  let prompt = agent.systemPrompt
  prompt = prompt.replaceAll('{{SESSION_ID}}', state.sessionId)
  prompt = prompt.replaceAll('{{TEAM_NAME}}', ctx.teamName)
  prompt = prompt.replaceAll('{{WORKSPACE_PATH}}', workspacePath)
  return prompt
}

// ─── Context Strategy Helpers ────────────────────────────────────────────────

/** Format a list of conversation messages into a readable history string. */
function formatMessages(messages: ConversationMessage[]): string {
  return messages.map((m) => {
    const toStr = Array.isArray(m.to) ? m.to.join(', ') : m.to
    return `[Round ${m.round}] ${m.from} \u2192 ${toStr}: ${m.message}`
  }).join('\n\n')
}

/**
 * Build the conversation context string for an agent based on the active
 * context strategy. Defaults to `full` (identical to prior behavior).
 */
export function buildConversationContext(
  discussion: DiscussionState,
  strategy: ContextStrategy,
  windowRounds: number,
): string {
  switch (strategy) {
    case 'full':
      return formatMessages(discussion.messages)

    case 'recent_N': {
      const cutoff = discussion.round - windowRounds
      const recentMessages = discussion.messages.filter(m => m.round > cutoff)
      // Graceful fallback: if windowRounds >= total rounds, show all messages
      return recentMessages.length > 0
        ? formatMessages(recentMessages)
        : formatMessages(discussion.messages)
    }

    case 'rolling_summary': {
      const parts: string[] = []
      if (discussion.compressedSummary) {
        parts.push(
          `**Summary of rounds 1\u2013${discussion.compressedUpToRound}:**\n${discussion.compressedSummary}`,
        )
      }
      const recentMessages = discussion.messages.filter(
        m => m.round > (discussion.compressedUpToRound ?? 0),
      )
      if (recentMessages.length > 0) {
        parts.push(formatMessages(recentMessages))
      }
      return parts.join('\n\n')
    }

    default:
      return formatMessages(discussion.messages)
  }
}

/**
 * Trigger rolling-summary compression when enough uncompressed rounds have
 * accumulated. No-op for all other strategies.
 */
export async function maybeCompressHistory(
  ctx: DiscussionContext,
  discussion: DiscussionState,
): Promise<void> {
  const strategy = ctx.config.config.context_strategy
  if (strategy !== 'rolling_summary') return

  const summarizeAfter = ctx.config.config.summarize_after_rounds ?? DEFAULT_SUMMARIZE_AFTER_ROUNDS
  const compressedUpTo = discussion.compressedUpToRound ?? 0
  // discussion.round was already incremented before this call; completedRounds = round - 1
  const completedRounds = discussion.round - 1
  const uncompressedRounds = completedRounds - compressedUpTo

  if (uncompressedRounds < summarizeAfter) return

  const messagesToCompress = discussion.messages.filter(
    m => m.round > compressedUpTo && m.round < discussion.round,
  )
  if (messagesToCompress.length === 0) return

  const result = await compressConversation({
    messages: messagesToCompress,
    teamName: ctx.teamName,
    levelId: ctx.levelId,
    currentRound: discussion.round,
    ...whenDefined(discussion.compressedSummary, (definedValue) => ({ existingSummary: definedValue })),
    ...whenDefined(ctx.rateLimiter, (definedValue) => ({ rateLimiter: definedValue })),
    ...whenDefined(ctx.shutdownSignal, (definedValue) => ({ signal: definedValue })),
    // The run this compression belongs to, so the model it uses is disclosed to
    // the conversation that caused it rather than to nobody.
    runIdentity: {
      outputPath: ctx.outputPath,
      sessionId: ctx.state.sessionId,
      levelId: ctx.levelId,
      ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
    },
    timeoutMinutes: DEFAULT_AUXILIARY_LLM_TIMEOUT_MINUTES,
  })

  discussion.compressedSummary = result.summary
  discussion.compressedUpToRound = completedRounds
  ctx.state.totalCost = roundUsd(ctx.state.totalCost + result.cost)
}

/** Build the user message for one agent in the discussion. */
function buildAgentMessage(
  ctx: DiscussionContext,
  discussion: DiscussionState,
  agentName: string,
  coordinatorMessage: string,
): string {
  const { config } = ctx
  const strategy = (ctx.config.config.context_strategy ?? DEFAULT_CONTEXT_STRATEGY) as ContextStrategy
  const windowRounds = ctx.config.config.context_window_rounds ?? DEFAULT_CONTEXT_WINDOW_ROUNDS
  const conversationContext = buildConversationContext(discussion, strategy, windowRounds)

  const modeNote = modeInstructions[config.config.mode] || ''
  const routing = ctx.humanInputRouting
  const directRecipients = routing
    ? humanInputDirectRecipientIds(routing)
    : new Set<string>()
  const shouldInjectInputFiles = !routing ||
    discussion.round === 1 ||
    (!hasHumanInputBroadcast(routing) && !directRecipients.has(agentName))
  const inputFilesSection = shouldInjectInputFiles && ctx.inputFilesContent
    ? `\n\n**Input Files:**\n${ctx.inputFilesContent}\n`
    : ''
  const routedHumanInput = routing && discussion.round === 1
    ? humanInputMessagesForRecipient(routing, agentName)
    : []
  const humanInputSection = routing && routedHumanInput.length > 0
    ? [
        '',
        '',
        '**Human feedback for you:**',
        ...routedHumanInput.map((message) => `- ${message.text}`),
        '',
      ].join('\n')
    : ''

  return (
    `# Discussion Context\n\n` +
    (modeNote ? `**Mode:** ${modeNote}\n\n` : '') +
    inputFilesSection +
    humanInputSection +
    `**Conversation so far:**\n${conversationContext}\n\n` +
    `**Latest message from coordinator (to you):**\n${coordinatorMessage}\n\n` +
    `Respond with your position. Follow your Report format.`
  )
}

/** Run one discussion round: dispatch all targets sequentially, collect responses. */
async function runRound(
  ctx: DiscussionContext,
  discussion: DiscussionState,
  targets: string[],
  coordinatorMessage: string,
  signal: AbortSignal | undefined,
  budgetAdmission: BudgetDispatchAdmission | undefined,
): Promise<DiscussionRoundResult> {
  const { agents, rosterEntries, state, workspacePath, agentMetrics, onDashboardUpdate } = ctx
  const routedTargets = resolveHumanInputTargets(ctx, discussion, targets)
  const responses: string[] = []
  const runningPass = discussion.continuation?.phase === 'running_specialist_pass'
    ? discussion.continuation
    : undefined
  const completedTargets = new Set(runningPass?.completedTargets ?? [])
  let successCount = (runningPass?.successfulTargets ?? [])
    .filter((target) => routedTargets.includes(target)).length
  let haltError: HaltError | undefined

  for (const targetName of routedTargets) {
    if (completedTargets.has(targetName)) {
      const acceptedMessage = [...discussion.messages].reverse().find(
        (message) =>
          (message.target ?? message.from) === targetName &&
          message.round === discussion.round &&
          message.type === 'position',
      )
      if (acceptedMessage) {
        publishAcceptedTeamChatMessage(
          { ...ctx, outputPath: discussion.outputPath },
          {
            agentName: acceptedMessage.from,
            ...whenDefined(acceptedMessage.dispatchId, (dispatchId) => ({ dispatchId })),
            messageType: acceptedMessage.type,
            stageType: STAGE_TYPE.DISCUSSION,
            text: acceptedMessage.message,
          },
        )
        responses.push(`**${acceptedMessage.from}:**\n\n${acceptedMessage.message}`)
      }
      continue
    }
    const agent = agents.get(targetName)
    if (!agent) {
      responses.push(`**${targetName}:** [Agent not found]`)
      checkpointDiscussionTarget(ctx, discussion, targetName, false)
      continue
    }

    const metrics = agentMetrics.get(agent.name)
    const userMessage = buildAgentMessage(ctx, discussion, targetName, coordinatorMessage)

    const finalPrompt = substituteTemplateVars(agent.systemPrompt, {
      SESSION_ID: state.sessionId,
      TEAM_NAME: ctx.teamName,
      DISCUSSION_PATH: getAssignmentLogPath(discussion.outputPath, 'conversation.jsonl'),
      EXPERIENCE_PATH: agent.experienceEnabled ? path.join(agent.agentDir, 'experience') : '',
      TASK_CONTENT: ctx.inputFilesContent || coordinatorMessage,
    })

    const rosterEntry = rosterEntries.get(targetName)
    const teamWorkspacePath = rosterEntry?.type === 'team' && rosterEntry.team_path
      ? resolveChildWorkspacePath(rosterEntry.team_path)
      : undefined

    const agentPolicy = rosterEntry?.on_failure
    const resolvedPolicy = resolveFailurePolicy(
      targetName,
      STAGE_TYPE.DISCUSSION,
      ctx.stageFailureOverride,
      agentPolicy,
    )
    const fallbackName = resolvedPolicy.fallbackAgent
    const fallbackAgent = fallbackName ? agents.get(fallbackName) : undefined
    const fallbackRosterEntry = fallbackName ? rosterEntries.get(fallbackName) : undefined
    const fallbackFinalPrompt = fallbackAgent
      ? buildFallbackPrompt(fallbackAgent, state, workspacePath, ctx)
      : undefined

    try {
      const result = await dispatchWithFailurePolicy({
        agent,
        rosterEntry,
        finalPrompt,
        userMessage,
        state,
        workspacePath,
        outputPath: discussion.outputPath,
        ...whenDefined(teamWorkspacePath, (definedValue) => ({ teamWorkspacePath: definedValue })),
        metrics,
        ...whenDefined(ctx.shutdownSignal ? combineAbortSignals(signal, ctx.shutdownSignal) : signal, (definedValue) => ({ signal: definedValue })),
        ...whenDefined(onDashboardUpdate, (definedValue) => ({ onDashboardUpdate: definedValue })),
        triggerTool: 'converse',
        logicalInvocationId: buildDiscussionSpecialistInvocationId({
          sessionId: state.sessionId,
          levelId: ctx.levelId,
          visitCount:
            state.levelStates.get(ctx.levelId)?.visitCount ?? 0,
          round: discussion.round,
          target: targetName,
        }),
        teamName: ctx.teamName,
        fromName: ctx.config.coordinator ?? 'coordinator',
        policy: resolvedPolicy,
        ...whenDefined(fallbackAgent, (definedValue) => ({ fallbackAgent: definedValue })),
        ...whenDefined(fallbackRosterEntry, (definedValue) => ({ fallbackRosterEntry: definedValue })),
        ...whenDefined(fallbackFinalPrompt, (definedValue) => ({ fallbackFinalPrompt: definedValue })),
        levelId: ctx.levelId,
        stageType: STAGE_TYPE.DISCUSSION,
        sessionId: state.sessionId,
        ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
        errorLogPath: discussion.outputPath,
        onFailureRecorded: (agentName, error) => {
          const m = agentMetrics.get(agentName)
          if (m) { m.failureCount++; m.lastError = error }
        },
        ...whenDefined(ctx.budgetLedger, (definedValue) => ({ budgetLedger: definedValue })),
        totalCost: state.totalCost,
        ...(budgetAdmission ? { budgetAdmission } : {}),
        ...whenDefined(ctx.config.config.constraints?.agent_timeout_minutes, (definedValue) => ({ timeoutMinutes: definedValue })),
      })

      if (result.interruption) {
        ctx.onStateCheckpoint?.()
        throw new AgentQuestionInterruptionError(result.interruption)
      }
      if (result.skipped) {
        responses.push(`**${agent.name}:** [Skipped — agent failed, continuing without this participant]`)
        if (ctx.chatMode) {
          const failedMessage: ConversationMessage = {
            from: agent.name, target: targetName, to: 'all', round: discussion.round,
            timestamp: new Date().toISOString(), type: 'error',
            message: 'This participant did not complete its contribution.',
          }
          discussion.messages.push(failedMessage)
          logConversationMessage(discussion.outputPath, failedMessage, state.rootSessionId, {
            sessionId: state.sessionId, levelId: ctx.levelId, stageType: STAGE_TYPE.DISCUSSION,
            publishContentEvent: false,
          })
        }
        checkpointDiscussionTarget(ctx, discussion, targetName, false)
        continue
      }

      const acceptedAgentName = result.agentName ?? agent.name
      const agentMsg: ConversationMessage = {
        from: acceptedAgentName,
        target: targetName,
        to: 'all',
        round: discussion.round,
        timestamp: new Date().toISOString(),
        type: 'position',
        message: result.text,
        // Names the attempt that produced this text, so the live preview it
        // finishes can be replaced by exactly this message rather than by
        // whatever the same agent said on some other attempt.
        ...whenDefined(result.dispatchId, (dispatchId) => ({ dispatchId })),
      }
      discussion.messages.push(agentMsg)
      checkpointDiscussionTarget(ctx, discussion, targetName, true)
      // The discussion's own path, not the context's: a restored state keeps
      // the assignment it was recorded under, and this call must write where
      // the rest of that discussion already lives.
      recordAcceptedDiscussionMessage(
        { ...ctx, outputPath: discussion.outputPath },
        agentMsg,
        {
          agentName: acceptedAgentName,
          ...whenDefined(result.dispatchId, (dispatchId) => ({ dispatchId })),
        },
      )

      responses.push(`**${acceptedAgentName}:**\n\n${result.text}`)
      successCount++
    } catch (err) {
      if (err instanceof HaltError) {
        const haltMsg: ConversationMessage = {
          from: agent.name,
          to: 'all',
          round: discussion.round,
          timestamp: new Date().toISOString(),
          type: 'error',
          message: `[HALTED — critical failure: ${err.originalError}]`,
        }
        discussion.messages.push(haltMsg)
        logConversationMessage(discussion.outputPath, haltMsg, state.rootSessionId, {
          sessionId: state.sessionId,
          ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
          team: ctx.teamName,
          levelId: ctx.levelId,
          stageType: STAGE_TYPE.DISCUSSION,
        })
        responses.push(`**${agent.name}:** [HALTED — critical failure. ${err.message}]`)
        haltError = err
        break
      }
      // Unexpected errors still propagate
      throw err
    }
  }

  return {
    responses,
    successCount,
    targetCount: routedTargets.length,
    ...whenDefined(haltError, (presentHaltError) => ({ haltError: presentHaltError })),
  }
}

function checkpointDiscussionTarget(
  ctx: DiscussionContext,
  discussion: DiscussionState,
  targetName: string,
  successful: boolean,
): void {
  if (discussion.continuation?.phase !== 'running_specialist_pass') return
  discussion.continuation = recordDiscussionTargetCompletion(
    discussion.continuation,
    targetName,
    successful,
  )
  ctx.onStateCheckpoint?.()
}

function resolveHumanInputTargets(
  ctx: DiscussionContext,
  discussion: DiscussionState,
  targets: string[],
): string[] {
  const approvedRoster = new Set(discussion.approvedRoster ?? [])
  return resolveDiscussionEffectiveTargets(
    targets,
    discussion.round,
    ctx.humanInputRouting,
  )
    .filter(
      (recipientId) => approvedRoster.has(recipientId) && ctx.agents.has(recipientId),
    )
}

// ─── Public Engine API ───────────────────────────────────────────────────────

/**
 * Check if a discussion has reached completion.
 */
export function isDiscussionComplete(state: DiscussionState, config: DiscussionStageConfig): boolean {
  return state.round >= config.config.max_rounds
}

/**
 * Get the expected output artifact path for this discussion.
 */
export function getDiscussionOutputPath(config: DiscussionStageConfig, outputPath: string): string {
  const configuredPath = config.config.output.path
  const outputDir = configuredPath
    ? (path.isAbsolute(configuredPath) ? configuredPath : path.join(outputPath, configuredPath))
    : outputPath
  return path.join(outputDir, config.config.output.format)
}

/**
 * Build a readable conversation history string from discussion state.
 * Used for post-completion experience reflections.
 */
export function buildDiscussionHistory(state: DiscussionState): string {
  if (state.messages.length === 0) return '_No conversation recorded._'

  const lines: string[] = []
  let currentRound = 0

  for (const msg of state.messages) {
    if (msg.round !== currentRound) {
      currentRound = msg.round
      lines.push(`\n### Round ${currentRound}\n`)
    }
    const toStr = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to
    lines.push(`**${msg.from}** → ${toStr} _(${msg.type})_:\n${msg.message}\n`)
  }

  return lines.join('\n')
}
