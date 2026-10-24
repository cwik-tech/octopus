import { providerAbortSource } from '../contracts/provider-abort.js';
import type { AgentProgressUpdate } from '../contracts/agent-progress.js';
import { createAgentProgressToolAdapter } from '../domains/mcp/agent-progress-tool-adapter.js';
import { whenDefined } from '../core/optional-properties.js'
import { assertDocumentRequestBudget, DocumentRequestBudgetError } from '../domains/document-access/document-request-budget.js'
import type { DocumentSource, DocumentReviewCoverage } from '../contracts/document-reference.js'
import { reviewDocuments, requestsWholeDocument, DOCUMENT_REVIEW_INSTRUCTION, buildDocumentReviewPrompt, documentReviewOutputSchema, type DocumentReviewFragment } from '../domains/document-access/document-review.js'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { agentQuestionRequestSchema, agentQuestionContinuationEvidenceSchema, agentQuestionToolResultSchema, agentQuestionTurnOutcomeSchema, MAX_PROVIDER_ROUNDS, MAX_TOOL_CALLS, type AgentQuestionInterruption, type AgentQuestionTurnOutcome, type AgentQuestionContinuationEvidence } from '../contracts/agent-questions.js'
import { hashCanonicalJson } from '../core/canonical-json-hash.js'
import { canonicalizeCapabilityEffect } from '../contracts/capability-effect.js'
import { normalizeTokenUsage } from '../contracts/model-diagnostics.js'
import { createAgentQuestionToolAdapter, type AgentQuestionCapture } from '../domains/mcp/agent-question-tool-adapter.js'

import { executeProvider } from '../providers/protocol.js'
import { getProvider } from '../providers/registry.js'
import type {
  ProviderExecuteOptions,
  ProviderProtocolEvent,
  ProviderResult,
} from '../providers/types.js'
import {
  McpCliHostBridgeError,
  startMcpCliHostBridge,
  type McpCliHostBridgeCall,
  type McpCliHostBridgeCounters,
} from '../domains/mcp/mcp-cli-host-bridge.js'
import type {
  BuiltinAgentToolAdapter,
  BuiltinToolArtifact,
} from '../domains/mcp/builtin-agent-tool-adapter.js'
import { McpParentBroker } from '../domains/mcp/mcp-parent-broker.js'
import {
  createMcpProviderSupportResolver,
  type McpProviderSupportResolver,
} from '../domains/mcp/mcp-provider-support.js'
import type { ProviderToolLoopTarget } from '../domains/mcp/mcp-provider-tool-target.js'
import { resolveProviderToolLoopTarget } from '../domains/mcp/mcp-provider-tool-target.js'
import { McpRunLeaseStore } from '../domains/mcp/mcp-run-lease-store.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
  type McpProviderSupport,
  type McpSanitizedErrorCode,
} from '../domains/mcp/mcp-runtime.js'
import { normalizeMcpAgentPath } from '../domains/mcp/mcp-settings.js'
import {
  BEHAVIOURAL_PROVIDER_OPTION_NAMES,
  retainCompatibleProviderOptions,
} from '../providers/provider-option-support.js'
import { createOpenAIChatCompletionsToolAdapter } from '../domains/provider/openai-chat-completions-tool-adapter.js'
import { boundedProviderCode, ProviderError } from '../domains/provider/provider-error.js'
import {
  ProviderToolLoopError,
  runProviderToolLoop,
  type ProviderToolLoopAdapterRequest,
  type ProviderToolLoopResult,
} from '../domains/provider/provider-tool-loop.js'
import type {
  GovernedWebEvidenceMode,
  ThinkingLevel,
} from '../core/types.js'
import type { ProviderSettingsService } from './provider-settings-service.js'
import { isSafePathSegment } from '../core/path-safety.js'
import {
  formatProviderErrorForUser,
  parseProviderError,
  usageLimitResetAt,
  usageLimitResetLabel,
} from '../domains/provider/provider-error.js'
import { PROVIDER_STALLED_CODE } from '../providers/codex.js'
import { PROVIDER_TRUNCATED_CODE } from '../domains/provider/provider-truncation.js'
import {
  decideWebResearchLinks,
  enforceWebResearchEvidence,
  INSUFFICIENT_WEB_RESEARCH_RESPONSE,
  type ObservedWebSource,
  type WebEvidenceTurnMode,
} from '../domains/browser/web-research-evidence.js'
import {
  resolveWebEvidenceLinksMode,
  type WebEvidenceCapabilityMode,
  type WebEvidenceProviderRoute,
  type WebEvidenceRolloutConfig,
} from '../domains/browser/web-evidence-rollout.js'
import type { WebEvidenceValidationRecorder } from './web-evidence-validation-recorder.js'
import { logProcessWarning } from '../domains/runtime/logger.js'
import { createProviderTurnDiagnosticsRecorder } from './provider-turn-diagnostics-store.js'
import type { CapabilityAssignmentScope } from '../contracts/capability-dispatch.js'
import { createDeepResearchEvidenceOutputSchema } from '../domains/deep-research/deep-research-evidence-output-schema.js'
import {
  appendDeepResearchWorkerFailure,
  persistDeepResearchWorkerToolLoopMessages,
  prepareDeepResearchWorkerLogDirectory,
} from '../domains/deep-research/deep-research-worker-logging.js'
import { ProviderCapabilityGateway } from './provider-capability-gateway.js'
import { RESEARCH_WEB_TOOL_NAME } from '../domains/acquisition/acquisition-types.js'
import { BROWSER_TOOL_NAME } from '../domains/browser/browser-types.js'
import {
  effortUnderReasoningSuppressor,
  openAiEffortValue,
  resolveEffort,
  suppressedEffortConflictMessage,
} from '../domains/provider/effort-support.js'
import type {
  AgentTurnFailureLayer,
  AgentTurnFailurePhase,
  AgentTurnRoute,
} from '../domains/agent-execution/agent-turn-journal.js'

const MCP_CLI_BRIDGE_TOKEN_ENV = 'PIPELINE_MCP_CLI_BRIDGE_TOKEN'

/**
 * The two governed routes to the web. Research Web is the ordinary one;
 * Browser is for pages that only yield to interaction. A Deep Research turn is
 * entitled to reach the packet validator once either of them has answered.
 */
const GOVERNED_WEB_CAPABILITY_IDS: readonly string[] = [
  RESEARCH_WEB_TOOL_NAME,
  BROWSER_TOOL_NAME,
]

/**
 * Whether a governed web capability handed this turn a result.
 *
 * A typed source error counts: a page that refused to be read is news about
 * that source, not a failure of the capability, and discarding an otherwise
 * valid provider response over it is what this predicate exists to prevent.
 * Whether the evidence is usable stays with receipt and packet validation.
 */
function receivedGovernedWebResult(gateway: ProviderCapabilityGateway): boolean {
  return GOVERNED_WEB_CAPABILITY_IDS.some((capabilityId) =>
    gateway.hasResolvedCapabilityResult(capabilityId))
}

export type McpCliProviderExecutor = (
  provider: string,
  options: ProviderExecuteOptions,
) => Promise<ProviderResult>

export interface McpAgentToolServiceOptions {
  readonly broker: McpParentBroker
  readonly leaseStore: McpRunLeaseStore
  readonly providerSettingsService: ProviderSettingsService
  readonly providerSupportResolver?: McpProviderSupportResolver
  readonly cliProviderExecutor?: McpCliProviderExecutor
  readonly builtinAgentTools?: readonly BuiltinAgentToolAdapter[]
  /** Parent-owned Gemini API target, never accepted from a worker request. */
  readonly youtubeQuotaFallback?: () => Promise<{ readonly model: string; readonly target: ProviderToolLoopTarget } | undefined>
  readonly maxConcurrentToolCalls?: number
  /**
   * The composition-resolved web evidence rollout. Absent means `off`: the
   * current guard runs exactly as it always has.
   */
  readonly webEvidence?: McpAgentToolServiceWebEvidence
}

export interface McpAgentToolServiceWebEvidence {
  readonly config: WebEvidenceRolloutConfig
  /**
   * Per-turn recorder resolution. `shadow` and `enforce` exist to produce
   * rollout evidence, so composition injects this from the workspace journal
   * registry; its absence at turn time is logged, never silently treated as a
   * cohort with zero rejections.
   */
  readonly resolveRecorder?: (input: {
    readonly scope: CapabilityAssignmentScope
    readonly agentPath: string
    readonly requestId: string
    readonly signal?: AbortSignal | undefined
  }) => Promise<WebEvidenceValidationRecorder | undefined>
}

export interface McpAgentToolTurnInput {
  readonly onProgress?: (progress: AgentProgressUpdate) => void
  /** Host-admitted resource snapshot; never read from model tool arguments. */
  readonly resourceRootPath?: string
  readonly documentSources?: readonly DocumentSource[]
  readonly documentQuestion?: string
  readonly documentReviewCacheDir?: string
  readonly onDocumentCoverage?: (coverage: readonly DocumentReviewCoverage[]) => Promise<void>
  /** Structured decisions keep their direct provider contract and use no tools. */
  readonly outputSchema?: Readonly<Record<string, unknown>>
  /** Only a trusted resumable host execution may supply this capability. */
  readonly humanInput?: AgentQuestionCapture
  readonly continuationEvidence?: import('../contracts/agent-questions.js').AgentQuestionContinuationEvidence
  /** Keep an admitted question continuation on its original managed lane. */
  readonly managedQuestionTurn?: boolean
  readonly questionAllowanceSpent?: boolean
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly activityScopeId?: string
  readonly agentDisplayName?: string
  readonly taskId?: string
  readonly workflowId?: string
  readonly workflowStepId?: string
  readonly agentPath: string
  readonly provider: string
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly cwd?: string
  readonly providerConfig?: Readonly<Record<string, unknown>>
  readonly systemPrompt: string
  readonly userMessage: string
  /**
   * Display-only observer for the turn's final answer, called once with the
   * whole answer.
   *
   * Only the answer is reported. A tool-requesting round's prose is planning,
   * not the answer, and showing it would put text on screen that the reply
   * does not contain (D9).
   */
  readonly onFinalRoundText?: (text: string) => void
  /**
   * Display-only observer for the answer's text as the provider streams it.
   *
   * On the native tool loop it makes the answer arrive from a separate
   * tool-free, streamed request, which counts as a provider round. It is
   * withheld where the answer must be validated before anything is shown
   * (enforced web evidence), and `onFinalRoundText` then carries the validated
   * answer once. Callers without it keep one buffered request per round.
   */
  readonly onFinalTextDelta?: (text: string) => void
  readonly researchQuestion?: string
  readonly governedWebEvidenceMode?: GovernedWebEvidenceMode
  /** Sealed workflow-step candidates. Live broker checks still apply. */
  readonly allowedServerIds?: readonly string[]
  /** One candidate-server group per required capability owned by this agent. */
  readonly requiredServerGroups?: readonly (readonly string[])[]
  /** Built-in tools handled deterministically by the caller for this turn. */
  readonly excludedBuiltinToolNames?: readonly string[]
  /**
   * Host tools created for this turn only, such as the folder tools bound to
   * the turn's attached folders. Added whatever the agent's tool line says,
   * like the human-input tool, because the turn's own context enables them.
   */
  readonly turnBuiltinAgentTools?: readonly BuiltinAgentToolAdapter[]
  readonly stallWatchdog?: ProviderExecuteOptions['stallWatchdog']
  /**
   * Keep a content-free account of this turn's provider process.
   *
   * Off by default and asked for by route rather than inferred: Deep Research
   * already persists its own worker logs, and a record nobody asked for is a
   * file that grows under every assignment for no reader.
   */
  readonly recordProviderDiagnostics?: boolean
  readonly signal?: AbortSignal
}

export type McpAgentToolTurnResult =
  | (AgentQuestionTurnOutcome & {
      readonly providerSupport: McpProviderSupport
      readonly route: AgentTurnRoute
      readonly result: McpProviderTurnResult
      readonly availableToolCount: number
      readonly droppedProviderOptions?: readonly string[]
    })
  | {
      readonly kind: 'unavailable'
      readonly providerSupport: McpProviderSupport
    }
  | {
      readonly kind: 'no-tools'
      readonly providerSupport: McpProviderSupport
    }
  | {
      readonly kind: 'completed'
      readonly providerSupport: McpProviderSupport
      /**
       * Which client produced the answer. The caller journals the route the
       * turn took, and `providerSupport.mode` is what was *offered* rather
       * than what ran.
       */
      readonly route: AgentTurnRoute
      readonly result: McpProviderTurnResult
      readonly availableToolCount: number
      readonly artifacts: readonly BuiltinToolArtifact[]
      /**
       * Agent settings this turn's lane did not apply, by name.
       *
       * Decided here because this is where the lane is known. A CLI host bridge
       * hands settings to the CLI, which applies the ones it understands; the
       * native tool loop's request body carries none at all
       * (`domains/provider/openai-chat-completions-tool-adapter.ts:137-149`).
       * A caller asking the same question separately would be a second lookup
       * that can disagree with this one, and then a turn could report a setting
       * as in force on a lane that never sent it.
       */
      readonly droppedProviderOptions?: readonly string[]
    }

/**
 * The sanitized diagnostic identity of a failed MCP turn.
 *
 * Every code below this boundary used to collapse into `provider_failed` with
 * a safe message, which left the outer chat boundary with nothing durable to
 * record. These fields travel with the error instead — closed unions and the
 * provider's own short codes, never its prose.
 */
export interface McpAgentTurnDiagnostics {
  readonly layer: AgentTurnFailureLayer
  readonly phase: AgentTurnFailurePhase
  readonly route?: AgentTurnRoute
  readonly providerKind?: string
  readonly providerCode?: string
  readonly httpStatus?: number
  /**
   * When a usage-limited provider's quota resets, as an exact instant.
   *
   * Deliberately not the `resetsAt` on the error beside it, which is a
   * rendered date and time for a person to read. This one is for the journal
   * and the health view, which expire a failure by comparing moments — and a
   * sentence compared as a moment is a bug waiting for a timezone.
   */
  readonly resetsAt?: string
  /**
   * Agent settings this turn's lane did not apply, by name.
   *
   * Carried on a failure as well as a success because the decision is made when
   * the lane is chosen, which is before the provider is called — so a turn that
   * then fails has already dropped them, and the outcome where a person most
   * needs the explanation would otherwise be the one that withholds it.
   */
  readonly droppedProviderOptions?: readonly string[]
  /**
   * Whether the adapter had sent anything when it refused.
   *
   * Only ever `false`, and only when the adapter itself claimed it. A turn
   * routed through the parent does not run its own adapter, so without this
   * the child cannot tell a refusal that sent nothing from one that may have
   * run a tool — and unknown blocks the retry the first one had earned.
   */
  readonly dispatched?: boolean
}

/**
 * What a turn decided about its settings, readable after that turn has thrown.
 *
 * The lane is chosen deep inside a turn and every failure after it raises its
 * own error, so the decision has to be written somewhere the failure boundary
 * can still read. An absent `dropped` means no lane was ever chosen, which is
 * a different fact from a lane that dropped nothing.
 */
interface LaneProviderOptionDecision {
  toolDispatchStarted?: boolean
  dropped?: readonly string[]
}

export interface McpProviderTurnResult {
  readonly text: string
  readonly model?: string
  readonly toolCallCount: number
  readonly executedToolCallCount: number
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly totalTokens: number
  }
}

export class McpAgentToolServiceError extends Error {
  constructor(
    readonly code:
      | McpSanitizedErrorCode
      | 'provider_failed'
      | 'provider_stalled'
      | 'provider_truncated'
      | 'provider_usage_limit',
    message: string,
    readonly retryable = false,
    /** What the outer chat boundary records; absent where nothing is known. */
    readonly diagnostics?: McpAgentTurnDiagnostics,
    /**
     * When a usage-limited provider's quota resets, as the provider stated it.
     * A rendered date and time, never the provider's prose, so it may travel
     * where the message may not.
     */
    readonly resetsAt?: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'McpAgentToolServiceError'
  }
}

export class McpAgentToolService {
  private readonly providerSupportResolver: McpProviderSupportResolver
  private readonly cliProviderExecutor: McpCliProviderExecutor

  constructor(private readonly options: McpAgentToolServiceOptions) {
    this.providerSupportResolver =
      options.providerSupportResolver ??
      createMcpProviderSupportResolver(options.providerSettingsService)
    this.cliProviderExecutor =
      options.cliProviderExecutor ?? defaultCliProviderExecutor
  }

  /**
   * A turn, and — however it ends — which of the Agent's settings its lane did
   * not apply.
   *
   * The decision is made inside, once the lane is known, and a completed turn
   * carries it home as part of its outcome. A failed turn cannot: every
   * failure between that decision and here raises its own error with its own
   * diagnostics, so the one outcome where a person most needs to be told a
   * setting stopped applying would be the outcome that withholds it. This
   * boundary is where the decision is put back on.
   */
  async runTurn(input: McpAgentToolTurnInput): Promise<McpAgentToolTurnResult> {
    // Written when the lane is chosen, and still readable here after the turn
    // that wrote it has thrown. Unwritten is not "dropped nothing": a turn that
    // failed before a lane was chosen dropped nothing at all, and reporting
    // otherwise would state a decision that was never made.
    const lane: LaneProviderOptionDecision = {}
    const preparationUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let result: McpAgentToolTurnResult
    const recordCancellation = () => {
      if (input.recordProviderDiagnostics && input.cwd && normalizeMcpAgentPath(input.agentPath)) {
        createProviderTurnDiagnosticsRecorder({ assignmentPath: input.cwd, turnKey: input.assignmentId })?.record({
          kind: 'provider-cancellation', source: providerAbortSource(input.signal?.reason), phase: 'turn',
        })
      }
    }
    if (input.signal?.aborted) recordCancellation()
    else input.signal?.addEventListener('abort', recordCancellation, { once: true })
    try {
      result = await this.runTurnRecordingLane(input, lane, preparationUsage)
    } catch (error) {
      const quotaFailure = error instanceof McpAgentToolServiceError &&
        (error.diagnostics?.providerKind === 'usage_limit' || error.diagnostics?.providerKind === 'billing')
      if (quotaFailure && lane.toolDispatchStarted === false && !input.signal?.aborted &&
        input.workflowId === 'youtube-manual-generation' && input.agentPath === 'agents/youtube-extractor' &&
        !input.continuationEvidence && !input.outputSchema) {
        const fallback = await this.options.youtubeQuotaFallback?.()
        if (fallback) {
          const { providerConfig: _originalSettings, ...withoutProviderSettings } = input
          result = await this.runTurnRecordingLane({ ...withoutProviderSettings, provider: 'gemini-api',
            model: fallback.model, thinking: 'provider-default' }, {}, preparationUsage, fallback.target)
          if ('result' in result) result = { ...result, result: { ...result.result, text: `The selected worker model reached its quota. Continued with Gemini.\n\n${result.result.text}` } }
        } else {
          throw withLaneProviderOptions(error, lane.dropped)
        }
      } else {
        throw withLaneProviderOptions(error, lane.dropped)
      }
    } finally {
      input.signal?.removeEventListener('abort', recordCancellation)
    }
    if (!('result' in result)) return result
    return { ...result, result: { ...result.result, usage: {
      inputTokens: result.result.usage.inputTokens + preparationUsage.inputTokens,
      outputTokens: result.result.usage.outputTokens + preparationUsage.outputTokens,
      totalTokens: result.result.usage.totalTokens + preparationUsage.totalTokens,
    } } }
  }

  private async runTurnRecordingLane(
    input: McpAgentToolTurnInput,
    lane: LaneProviderOptionDecision,
    preparationUsage: { inputTokens: number; outputTokens: number; totalTokens: number },
    fallbackTarget?: ProviderToolLoopTarget,
  ): Promise<McpAgentToolTurnResult> {
    const agentPath = normalizeMcpAgentPath(input.agentPath)
    if (!agentPath) {
      throw new McpAgentToolServiceError(
        'invalid_request',
        'MCP agent path is invalid.',
      )
    }
    if (
      input.activityScopeId !== undefined &&
      !isSafePathSegment(input.activityScopeId)
    ) {
      throw new McpAgentToolServiceError(
        'invalid_request',
        'MCP activity scope is invalid.',
      )
    }
    const deepResearchEvidenceTurn =
      agentPath === 'agents/web-researcher' &&
      input.activityScopeId !== undefined &&
      Boolean(input.taskId?.trim()) &&
      Boolean(input.researchQuestion?.trim())
    // The host owns whether this turn requires research evidence. The optional
    // string stays at the caller interface during migration; it is converted
    // once, here. Deep Research evidence turns keep their own branch below and
    // are not subject to Capability A.
    const webEvidenceTurn: WebEvidenceTurnMode =
      !deepResearchEvidenceTurn && input.researchQuestion?.trim()
        ? { kind: 'required', question: input.researchQuestion }
        : { kind: 'not-required' }
    const webEvidenceLinksMode: WebEvidenceCapabilityMode =
      webEvidenceTurn.kind === 'required' && this.options.webEvidence
        ? resolveWebEvidenceLinksMode(
            this.options.webEvidence.config,
            input.assignmentId,
          )
        : 'off'
    // In enforce mode an invalid research answer must never reach the display
    // channel ahead of validation: the native adapter's final-round observer is
    // withheld and the validated answer is published exactly once, after the
    // loop. Shadow keeps the current display behavior because it must not
    // alter the visible answer.
    const deferResearchObserver =
      webEvidenceTurn.kind === 'required' && webEvidenceLinksMode === 'enforce'
    // What the display stream was actually shown, as opposed to what is later
    // persisted. In shadow mode the native adapter publishes the raw candidate
    // before validation runs, and the display-stream rollout metric has to be
    // about that text — recording it here keeps the metric truthful without
    // changing what the user sees. A streamed answer is shown piece by piece
    // through `onFinalTextDelta`; this whole-answer observer still hears it
    // once, complete, so the record is the complete answer.
    let adapterDisplayedText: string | undefined
    const recordingFinalRoundObserver = input.onFinalRoundText || input.onFinalTextDelta
      ? (text: string) => {
          adapterDisplayedText ??= text
          input.onFinalRoundText?.(text)
        }
      : undefined
    const deepResearchWorker = deepResearchEvidenceTurn
      ? requireDeepResearchWorker(input.cwd, input.activityScopeId)
      : undefined
    const providerOutputPath = deepResearchWorker
      ? prepareDeepResearchWorkerLogDirectory(deepResearchWorker)
      : undefined
    // Deliberately separate from `providerOutputPath` above. That one writes
    // the provider's protocol transcript, assistant text included, and is
    // built only for Deep Research; this is the process-only record that
    // ordinary direct chat can afford to keep for every turn.
    const turnDiagnostics =
      input.recordProviderDiagnostics && input.cwd
        ? createProviderTurnDiagnosticsRecorder({
            assignmentPath: input.cwd,
            turnKey: input.assignmentId,
          })
        : undefined
    const providerResolution = fallbackTarget
      ? { provider: 'gemini-api', state: 'supported' as const, mode: 'native-tool-loop' as const, resolvedModel: input.model }
      : await this.providerSupportResolver({
      provider: input.provider,
      model: input.model,
    })
    const { resolvedModel, ...providerSupport } = providerResolution
    const effectiveModel = resolvedModel ?? input.model
    let preparedUserMessage = input.userMessage
    const executeManagedDirect = async (fragment?: DocumentReviewFragment): Promise<McpAgentToolTurnResult> => {
      const laneOptions = retainCompatibleProviderOptions(
        { provider: input.provider, route: 'direct', thinking: input.thinking }, input.providerConfig,
      )
      const options: ProviderExecuteOptions = {
        systemPrompt: fragment ? DOCUMENT_REVIEW_INSTRUCTION : input.systemPrompt, userMessage: fragment ? buildDocumentReviewPrompt(fragment) : preparedUserMessage,
        model: effectiveModel, thinking: input.thinking, tools: [],
        ...whenDefined(fragment ? documentReviewOutputSchema : input.outputSchema, (outputSchema) => ({ outputSchema })),
        signal: input.signal ?? AbortSignal.timeout(30 * 60_000),
        ...whenDefined(input.cwd, (cwd) => ({ cwd })),
        ...whenDefined(providerSupport.mode === 'host-tool-bridge'
          ? cliProviderConfig(input.provider, laneOptions.kept) : laneOptions.kept,
        (providerConfig) => ({ providerConfig })),
        ...whenDefined(turnDiagnostics, (turnDiagnostics) => ({ turnDiagnostics })),
        sessionId: input.sessionId, agentName: agentPath.slice('agents/'.length),
      }
      if ((input.documentSources?.length ?? 0) > 0) assertDocumentRequestBudget({ provider: input.provider, model: effectiveModel, request: { systemPrompt: options.systemPrompt, userMessage: options.userMessage, outputSchema: options.outputSchema } })
      const result = input.provider.startsWith('connection:')
        ? await this.options.providerSettingsService.executeConfiguredProvider(input.provider, options)
        : await this.cliProviderExecutor(input.provider, options)
      return {
        kind: 'completed', providerSupport, route: 'direct-provider', availableToolCount: 0, artifacts: [],
        droppedProviderOptions: laneOptions.dropped,
        result: {
          text: result.text, model: result.model, toolCallCount: 0, executedToolCallCount: 0,
          usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, totalTokens: result.inputTokens + result.outputTokens },
        },
      }
    }
    const toolSupported = providerSupport.state === 'supported' || providerSupport.state === 'experimental'
    const documents = input.documentSources ?? []
    if (documents.length > 0 && (requestsWholeDocument(input.documentQuestion ?? input.userMessage) || Boolean(input.outputSchema && input.managedQuestionTurn) || !toolSupported)) {
      const review = await reviewDocuments({ documents, question: input.documentQuestion ?? input.userMessage.slice(0, 4_000), reviewerKey: `${input.provider}/${effectiveModel}`, ...(input.documentReviewCacheDir || input.cwd ? { cacheDir: input.documentReviewCacheDir ?? path.join(input.cwd ?? '', 'document-review') } : {}), ...whenDefined(input.signal, (signal) => ({ signal })), execute: async (fragment) => {
        const result = await executeManagedDirect(fragment)
        if (result.kind !== 'completed') throw new Error('Document preparation did not produce a review response')
        preparationUsage.inputTokens += result.result.usage.inputTokens
        preparationUsage.outputTokens += result.result.usage.outputTokens
        preparationUsage.totalTokens += result.result.usage.totalTokens
        return result.result.text
      } })
      preparedUserMessage = `${input.userMessage}\n\n${review.context}`
      await input.onDocumentCoverage?.(review.coverage)
      if (!toolSupported && (input.requiredServerGroups?.length ?? 0) === 0) return executeManagedDirect()
    }
    if (
      providerSupport.state !== 'supported' &&
      providerSupport.state !== 'experimental'
    ) {
      return { kind: 'unavailable', providerSupport }
    }
    if (input.outputSchema && input.managedQuestionTurn) return executeManagedDirect()
    const allowedServerIds = input.allowedServerIds
      ? new Set(input.allowedServerIds)
      : null
    const excludedBuiltinToolNames = new Set(
      input.excludedBuiltinToolNames ?? [],
    )
    const questionStop = new AbortController()
    const questionTurnStartedAt = Date.now()
    const priorEvidence = input.continuationEvidence
    /**
     * A resumed continuation runs a second provider loop, and that loop
     * restarts its tool-call ordinal at zero. `deriveDurableInvocationOperationId`
     * keys a durable operation partly on that ordinal, so the asking turn's
     * first call and the resumed turn's first call addressed one record: the
     * journal answered the resumed call from the asking turn's result, and the
     * same capability with different arguments collided instead.
     *
     * Continuing the sequence rather than restarting it says what is true, that
     * these are later calls of one logical turn. The offset is the saved count,
     * never the running one, so reconstructing the same continuation computes
     * the same ordinals and replay identity stays stable within an invocation.
     */
    const resumedOrdinalOffset = priorEvidence?.toolCalls ?? 0
    const completedTools: AgentQuestionContinuationEvidence['completedTools'] = [...(priorEvidence?.completedTools ?? [])]
    let providerRounds = priorEvidence?.providerRounds ?? 0
    let toolCalls = priorEvidence?.toolCalls ?? 0
    let continuationUnavailable = false
    let cliInterruption: AgentQuestionInterruption | undefined
    let progressToken: string | undefined
    const reportProgress = (update: AgentProgressUpdate) => {
      if (!input.onProgress || input.signal?.aborted) return
      const token = progressToken
      if (update.kind !== 'reported' || !token) { input.onProgress(update); return }
      input.onProgress({ ...update, summary: update.summary.replaceAll(token, '[REDACTED]'),
        ...(update.tasks ? { tasks: update.tasks.map(task => ({ ...task,
          id: task.id.includes(token) ? hashCanonicalJson({ taskId: task.id }).value : task.id,
          label: task.label.replaceAll(token, '[REDACTED]'),
        })) } : {}),
      })
    }
    const builtinAgentTools = (this.options.builtinAgentTools ?? []).map((adapter) =>
      input.resourceRootPath && adapter.forResourceRoot
        ? adapter.forResourceRoot(input.resourceRootPath)
        : adapter,
    ).filter(
      (adapter) =>
        !excludedBuiltinToolNames.has(adapter.name) &&
        adapter.isEnabledForAgent(agentPath),
    )
    builtinAgentTools.push(...(input.turnBuiltinAgentTools ?? []))
    if (input.onProgress) builtinAgentTools.push(createAgentProgressToolAdapter(reportProgress))
    const humanInput = input.humanInput
    if (humanInput) builtinAgentTools.push(createAgentQuestionToolAdapter({
      capture: async (request, signal) => {
        const evidence = agentQuestionContinuationEvidenceSchema.safeParse({
          completedTools, providerRounds, toolCalls,
          activeDurationMs: (priorEvidence?.activeDurationMs ?? 0) + Date.now() - questionTurnStartedAt,
        })
        const accepted: AgentQuestionInterruption = !evidence.success || continuationUnavailable
          ? { kind: 'blocked', code: 'continuation_unavailable' }
          : await humanInput.capture(request, signal, evidence.data)
        if (providerSupport.mode === 'host-tool-bridge') {
          cliInterruption = accepted
          questionStop.abort()
        }
        return accepted
      },
    }))
    if (
      allowedServerIds?.size === 0 &&
      builtinAgentTools.length === 0 && !input.managedQuestionTurn
    ) {
      return { kind: 'no-tools', providerSupport }
    }

    const lease = this.options.leaseStore.issue({
      sessionId: input.sessionId,
      runId: input.runId,
      assignmentId: input.assignmentId,
      ...whenDefined(input.taskId, (definedValue) => ({ taskId: definedValue })),
      allowedAgentPaths: [agentPath],
    })
    const baseContext: Omit<McpBrokerRequestContext, 'requestId'> = {
      contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      runId: lease.runId,
      assignmentId: lease.assignmentId,
      ...(lease.taskId ? { taskId: lease.taskId } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.workflowStepId
        ? { workflowStepId: input.workflowStepId }
        : {}),
      agentPath,
      ...(input.activityScopeId
        ? {
            agentId: input.activityScopeId,
            activityScopeId: input.activityScopeId,
          }
        : {}),
      ...(input.agentDisplayName
        ? { agentDisplayName: input.agentDisplayName }
        : {}),
    }
    let providerCapabilityGateway: ProviderCapabilityGateway | undefined
    let droppedProviderOptions: readonly string[] = []

    try {
      const listAllowedTools = async () => {
        const listed = await this.options.broker.listTools({
          context: { ...baseContext, requestId: randomUUID() },
        })
        const [failure] = listed.errors
        if (failure) {
          throw new McpAgentToolServiceError(
            failure.code,
            failure.message,
            failure.retryable,
            { layer: 'mcp-service', phase: 'tool-discovery' },
          )
        }
        const externalTools = allowedServerIds
          ? listed.tools.filter((tool) => allowedServerIds.has(tool.serverId))
          : listed.tools
        return [
          ...externalTools,
          ...builtinAgentTools.map((adapter) => adapter.tool),
        ]
      }
      const tools = await listAllowedTools()
      // Classified from the host-owned inventory, never from a tool's name.
      const readOnlyCapabilityIds = new Set(
        tools
          .filter((tool) => canonicalizeCapabilityEffect(tool.effect).kind === 'read-only')
          .map((tool) => tool.namespacedName),
      )
      const listedServerIds = new Set(tools.map((tool) => tool.serverId))
      if (
        input.requiredServerGroups?.some(
          (group) => !group.some((serverId) => listedServerIds.has(serverId)),
        )
      ) {
        throw new McpAgentToolServiceError(
          'unauthorized',
          'Required MCP tools are no longer available.',
          false,
          { layer: 'mcp-service', phase: 'tool-discovery' },
        )
      }
      // A turn with no tools falls through to the ordinary direct route, which
      // applies the Agent's settings itself — so nothing is decided about them
      // here, and that fall-through is left exactly as it was.
      if (tools.length === 0 && !input.managedQuestionTurn) return { kind: 'no-tools', providerSupport }
      if (tools.length === 0 && input.managedQuestionTurn && providerSupport.mode === 'host-tool-bridge') {
        return await executeManagedDirect()
      }
      // The one place the lane is known, so the one place this is decided.
      // `host-tool-bridge` hands settings to the CLI, which applies what its own
      // adapter reads; the native tool loop sends none. Reported either way,
      // because a setting that quietly stopped applying reads exactly like a
      // provider that ignored it.
      //
      // Only the behavioural settings are this decision's business. An
      // endpoint, a header or a sandbox permission is owned elsewhere and is
      // used here unchanged, so naming one as dropped would report a setting
      // that stopped applying when it did not.
      const laneOptions = retainCompatibleProviderOptions(
        {
          provider: input.provider,
          route:
            providerSupport.mode === 'host-tool-bridge' || input.managedQuestionTurn || humanInput
              ? 'direct'
              : 'mcp-tool-loop',
          thinking: input.thinking,
        },
        input.providerConfig
          ? Object.fromEntries(
              Object.entries(input.providerConfig).filter(([key]) =>
                BEHAVIOURAL_PROVIDER_OPTION_NAMES.has(key),
              ),
            )
          : undefined,
      )
      // Recorded as soon as it is made, not on the way out: everything after
      // this line can throw, and the decision is already true by then.
      lane.dropped = laneOptions.dropped
      const requiredServerIds = new Set(
        input.requiredServerGroups?.flatMap((group) => group) ?? [],
      )
      droppedProviderOptions = laneOptions.dropped
      const gateway = new ProviderCapabilityGateway({
        context: baseContext,
        broker: this.options.broker,
        tools,
        builtinTools: builtinAgentTools,
        requiredServerIds,
      })
      providerCapabilityGateway = gateway
      lane.toolDispatchStarted = false

      const executeProviderCapability = async (call: {
        readonly toolCallId: string
        readonly namespacedToolName: string
        readonly arguments: McpCliHostBridgeCall['arguments']
        readonly signal: AbortSignal
        readonly providerCallOrdinal?: number
      }) => {
        if (cliInterruption) return { content: 'Waiting for the human answer.', interruption: cliInterruption }
        if (providerSupport.mode === 'host-tool-bridge') { toolCalls += 1; providerRounds = 1 }
        const fingerprint = hashCanonicalJson({ name: call.namespacedToolName, arguments: call.arguments }).value
        // A completed side effect must not run a second time, so its saved
        // result stands in for it. An explicitly read-only capability is the
        // opposite case: the human may have changed the very thing the agent is
        // about to re-read, which is often why it asked. Anything not
        // classified read-only, `unknown` included, keeps the protection.
        const prior = readOnlyCapabilityIds.has(call.namespacedToolName)
          ? undefined
          : priorEvidence?.completedTools.find((entry) =>
            hashCanonicalJson({ name: entry.capabilityId, arguments: entry.arguments }).value === fingerprint)
        if (prior) return { content: prior.content, isError: prior.isError }
        lane.toolDispatchStarted = true
        const isProgressReport = call.namespacedToolName === 'report_progress'
        if (!isProgressReport && !call.signal.aborted) {
          const toolName = call.namespacedToolName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 99)
          input.onProgress?.({ kind: 'observed', phase: 'tool', ...(/^[a-zA-Z]/.test(toolName) ? { toolName } : {}) })
        }
        const result = await gateway.execute({
          toolCallId: call.toolCallId,
          capabilityId: call.namespacedToolName,
          arguments: call.arguments,
          signal: call.signal,
          ...(call.providerCallOrdinal === undefined
            ? {}
            : { providerCallOrdinal: call.providerCallOrdinal + resumedOrdinalOffset }),
        }).finally(() => {
          // A thrown call has ended too; the CLI bridge reports it and the turn continues.
          if (!isProgressReport && !call.signal.aborted) input.onProgress?.({ kind: 'observed', phase: 'waiting' })
        })
        if (humanInput && !result.interruption) {
          // Image-only context cannot be restored through both provider lanes.
          // Refuse a lossy pause rather than silently discard it.
          if (result.images?.length) continuationUnavailable = true
          const retained = agentQuestionToolResultSchema.safeParse({ capabilityId: call.namespacedToolName, arguments: call.arguments, content: result.content, isError: result.isError ?? false })
          if (retained.success) completedTools.push(retained.data)
          else continuationUnavailable = true
        }
        return result
      }

      let result: McpProviderTurnResult
      if (providerSupport.mode === 'host-tool-bridge') {
        const cliSignal = input.signal
          ? AbortSignal.any([input.signal, questionStop.signal])
          : questionStop.signal
        const bridge = await startMcpCliHostBridge({
          tools,
          callTool: executeProviderCapability,
          ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
        })
        progressToken = bridge.bearerToken
        let observedCliUsage: McpProviderTurnResult['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
        const suspendedCliTurn = (
          interruption: AgentQuestionInterruption,
          usage: McpProviderTurnResult['usage'],
          model: string,
        ): McpAgentToolTurnResult => ({
          ...agentQuestionTurnOutcomeSchema.parse({ kind: interruption.kind, interruption }), providerSupport,
          route: 'mcp-cli', availableToolCount: tools.length,
          droppedProviderOptions: laneOptions.dropped,
          result: {
            text: '', model,
            toolCallCount: bridge.getCounters().toolCallsStarted,
            executedToolCallCount: bridge.getCounters().toolCallsCompleted + 1,
            usage,
          },
        })
        try {
          const proxyNameByNamespacedTool = new Map(
            [...bridge.toolMappings].map(([proxyName, namespacedToolName]) => [
              namespacedToolName,
              proxyName,
            ] as const),
          )
          if ((input.documentSources?.length ?? 0) > 0) assertDocumentRequestBudget({ provider: input.provider, model: effectiveModel, request: { systemPrompt: input.systemPrompt, userMessage: preparedUserMessage, tools: tools.map((tool) => ({ name: tool.namespacedName, description: tool.description, inputSchema: tool.inputSchema })) } })
          const providerResult = await this.cliProviderExecutor(
            input.provider,
            {
              systemPrompt: input.systemPrompt,
              userMessage: preparedUserMessage,
              model: effectiveModel,
              thinking: input.thinking,
              tools: [],
              ...whenDefined(input.cwd, (definedValue) => ({ cwd: definedValue })),
              ...(deepResearchEvidenceTurn
                ? {
                    ...whenDefined(providerOutputPath, (outputPath) => ({ outputPath })),
                    outputSchema: createDeepResearchEvidenceOutputSchema(),
                  }
                : {}),
              signal: cliSignal,
              ...((humanInput || input.onProgress) ? { onProtocolEvent: (event: ProviderProtocolEvent) => {
                const usage = normalizeTokenUsage(event)
                if (usage) observedCliUsage = usage
                if (event.kind === 'progress' && event.progress) input.onProgress?.(event.progress)
              } } : {}),
              ...whenDefined(input.stallWatchdog, (definedValue) => ({ stallWatchdog: definedValue })),
              ...whenDefined(turnDiagnostics, (definedValue) => ({ turnDiagnostics: definedValue })),
              sessionId: input.sessionId,
              rootSessionId: input.sessionId,
              agentName: agentPath.slice('agents/'.length),
              // The CLI's own closed filter, over the settings this lane keeps.
              // `codex` supplies its own sandbox before that filter reads the
              // input at all, so narrowing here cannot take it away.
              ...whenDefined(cliProviderConfig(
                input.provider,
                laneOptions.kept,
              ), (definedValue) => ({ providerConfig: definedValue })),
              mcpBridge: {
                url: bridge.url,
                tokenEnvironmentVariable: MCP_CLI_BRIDGE_TOKEN_ENV,
                token: bridge.bearerToken,
                proxyToolNames: [...bridge.toolMappings.keys()],
                toolInventory: tools.flatMap((tool) => {
                  const proxyName = proxyNameByNamespacedTool.get(
                    tool.namespacedName,
                  )
                  return proxyName
                    ? [{
                        proxyName,
                        serverName: tool.serverName,
                        toolName: tool.toolName,
                        ...(tool.description
                          ? { description: tool.description }
                          : {}),
                      }]
                    : []
                }),
              },
            },
          )
          if (cliInterruption && !input.signal?.aborted) {
            return suspendedCliTurn(cliInterruption, {
              inputTokens: providerResult.inputTokens, outputTokens: providerResult.outputTokens,
              totalTokens: providerResult.inputTokens + providerResult.outputTokens,
            }, providerResult.model)
          }
          throwFatalProviderCapabilityError(gateway, 'mcp-cli')
          const counters = bridge.getCounters()
          result = providerTurnResultFromCli(providerResult, counters)
        } catch (error) {
          if (!cliInterruption || input.signal?.aborted) throw error
          return suspendedCliTurn(cliInterruption, observedCliUsage, effectiveModel)
        } finally {
          // Recorded around the close rather than after it: a teardown that
          // never returns is exactly the shape this record has to be able to
          // show, and an outcome written only on success could not show it.
          turnDiagnostics?.record({
            kind: 'bridge-cleanup',
            outcome: 'started',
          })
          try {
            await bridge.close()
            turnDiagnostics?.record({
              kind: 'bridge-cleanup',
              outcome: 'closed',
            })
          } catch (error) {
            turnDiagnostics?.record({
              kind: 'bridge-cleanup',
              outcome: 'failed',
            })
            throw error
          }
        }
      } else if (providerSupport.mode === 'native-tool-loop') {
        let target
        try {
          target = fallbackTarget ?? await resolveProviderToolLoopTarget(
            {
              provider: input.provider,
              model: effectiveModel,
              ...whenDefined(input.providerConfig, (definedValue) => ({ providerConfig: definedValue })),
            },
            this.options.providerSettingsService,
          )
        } catch {
          throw new McpAgentToolServiceError(
            'provider_unsupported',
            'Provider is unavailable for MCP tools.',
            false,
            {
              layer: 'mcp-service',
              phase: 'provider-resolution',
              route: 'mcp-native',
            },
          )
        }
        // The level this turn runs at, decided before the loop starts. A
        // tool-bearing turn is an ordinary turn: leaving the setting out here
        // would apply an agent's chosen depth everywhere except the moment it
        // was given tools. A level the pair cannot honour stops the turn
        // instead of running it at some other depth.
        const nativeEffort = resolveEffort({
          provider: input.provider,
          model: effectiveModel,
          requested: input.thinking,
        })
        if (nativeEffort.kind === 'refuse') {
          throw new McpAgentToolServiceError(
            'provider_unsupported',
            nativeEffort.message,
            false,
            {
              layer: 'mcp-service',
              phase: 'provider-resolution',
              route: 'mcp-native',
            },
          )
        }

        // `reasoning: false` predates this vocabulary and sends no reasoning
        // field at all. What a level means against it is already decided in the
        // effort contract, and this lane obeys the same rule as every other:
        // the legacy levels stay suppressed, an explicit `off` is still sent
        // because omitting it lets the vendor think, and a widened level stops
        // the turn rather than vanishing.
        const suppressedEffort = laneOptions.kept?.reasoning === false && nativeEffort.kind === 'send'
          ? effortUnderReasoningSuppressor(nativeEffort.level)
          : 'send'
        if (suppressedEffort === 'conflict' && nativeEffort.kind === 'send') {
          throw new McpAgentToolServiceError(
            'provider_unsupported',
            suppressedEffortConflictMessage(effectiveModel, nativeEffort.level),
            false,
            {
              layer: 'mcp-service',
              phase: 'provider-resolution',
              route: 'mcp-native',
            },
          )
        }
        const sendsNativeEffort = suppressedEffort === 'send'
        const nativeTurnStartedAt = new Date().toISOString()
        const nativeAdapter = createOpenAIChatCompletionsToolAdapter({
          ...((input.managedQuestionTurn || humanInput) ? {
            modelParameters: questionTurnModelParameters(input.provider, laneOptions.kept),
          } : {}),
          apiUrl: target.apiUrl, model: effectiveModel,
          ...(sendsNativeEffort && nativeEffort.kind === 'send'
            ? { reasoningEffort: openAiEffortValue(nativeEffort.level) }
            : {}),
          ...whenDefined(deferResearchObserver ? undefined : recordingFinalRoundObserver, (onFinalRoundText) => ({ onFinalRoundText })),
          // Ollama exception (owner decision, 2026-09-27). The live observer is
          // what adds the tool-free final request, and that request forbids
          // tools with `tool_choice: "none"`. Ollama's OpenAI-compatible
          // endpoint has no `tool_choice`, so there the final request can
          // still call a tool and fail a turn that succeeds when buffered. An
          // explicitly configured Ollama connection therefore keeps the
          // buffered route: one request per round, and the answering round's
          // text shown whole through `onFinalRoundText`. Every other provider
          // streams, and a tool call in its final reply still fails the turn.
          ...whenDefined(
            deferResearchObserver || target.connectionKind === 'ollama'
              ? undefined
              : input.onFinalTextDelta,
            (onFinalTextDelta) => ({ onFinalTextDelta }),
          ),
          ...whenDefined(target.apiKey, (apiKey) => ({ apiKey })),
          ...whenDefined(target.headers, (headers) => ({ headers })),
        })
        if ((input.documentSources?.length ?? 0) > 0) assertDocumentRequestBudget({ provider: input.provider, model: effectiveModel, request: { systemPrompt: input.systemPrompt, userMessage: preparedUserMessage, tools: tools.map((tool) => ({ name: tool.namespacedName, description: tool.description, inputSchema: tool.inputSchema })) }, ...whenDefined(target.connectionKind, (connectionKind) => ({ connectionKind })) })
        const nativeResult = await runProviderToolLoop({
          ...(priorEvidence ? { maxRounds: MAX_PROVIDER_ROUNDS - priorEvidence.providerRounds, maxToolCalls: MAX_TOOL_CALLS - priorEvidence.toolCalls } : {}),
          ...(input.questionAllowanceSpent ? { interceptToolCall: (call) =>
            call.name === 'request_human_input' && agentQuestionRequestSchema.safeParse(call.arguments).success
              ? { kind: 'blocked', code: 'question_limit_reached' } as const : undefined,
          } : {}),
          messages: [
            { role: 'system', content: input.systemPrompt },
            { role: 'user', content: preparedUserMessage },
          ],
          tools: tools.map((tool) => ({
            name: tool.namespacedName,
            ...whenDefined(tool.description, (description) => ({ description: description })),
            inputSchema: tool.inputSchema,
            effect: tool.effect,
          })),
          adapter: { complete: async (request) => {
            if ((input.documentSources?.length ?? 0) > 0) assertDocumentToolRoundBudget({ provider: input.provider, model: effectiveModel, request, ...whenDefined(target.connectionKind, (connectionKind) => ({ connectionKind })) })
            const turn = await nativeAdapter.complete(request)
            providerRounds += 1
            toolCalls += turn.toolCalls.length
            return turn
          },
          // Counted like a tool-capable round: `providerRounds` records rounds
          // that returned, so a request that fails or is cancelled is not
          // counted. Nothing reads it after this request: continuation evidence
          // is taken inside `request_human_input`, which only a tool-capable
          // round can call.
          // The round budget is kept by the reserved last slot in
          // `runProviderToolLoop` (domains/provider/provider-tool-loop.ts),
          // which gives tool-capable rounds at most `maxRounds - 1` requests.
          ...whenDefined(nativeAdapter.completeFinal?.bind(nativeAdapter), (completeFinal) => ({
            completeFinal: async (request: ProviderToolLoopAdapterRequest) => {
              if ((input.documentSources?.length ?? 0) > 0) assertDocumentToolRoundBudget({ provider: input.provider, model: effectiveModel, request, ...whenDefined(target.connectionKind, (connectionKind) => ({ connectionKind })) })
              const turn = await completeFinal(request)
              providerRounds += 1
              return turn
            },
          })) },
          executeTool: (call, context) => executeProviderCapability({
            toolCallId: call.id,
            namespacedToolName: call.name,
            arguments: call.arguments,
            signal: context.signal,
            providerCallOrdinal: context.ordinal,
          }),
          ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
          toolTimeoutMs: this.options.broker.toolLoopTimeoutMs,
          ...whenDefined(
            this.options.maxConcurrentToolCalls,
            (definedValue) => ({ maxConcurrentToolCalls: definedValue }),
          ),
        })
        if (providerOutputPath) {
          try {
            persistDeepResearchWorkerToolLoopMessages({
              laneLogDirectory: providerOutputPath,
              turnStartedAt: nativeTurnStartedAt,
              ...(nativeResult.model ? { model: nativeResult.model } : {}),
              messages: nativeResult.messages.map((message) =>
                ({ ...message }) as Readonly<Record<string, unknown>>),
            })
          } catch {
            // The turn record is observability; it must not fail the turn.
          }
        }
        result = providerTurnResultFromNativeLoop(nativeResult)
        if (nativeResult.interruption) {
          return {
            ...agentQuestionTurnOutcomeSchema.parse({ kind: nativeResult.interruption.kind, interruption: nativeResult.interruption }),
            providerSupport, route: 'mcp-native', result, availableToolCount: tools.length,
            droppedProviderOptions: laneOptions.dropped,
          }
        }
      } else {
        throw new McpAgentToolServiceError(
          'provider_unsupported',
          'Provider is unavailable for MCP tools.',
          false,
          { layer: 'mcp-service', phase: 'provider-resolution' },
        )
      }
      const observedWebSources = gateway.observedWebSources()
      if (input.requiredServerGroups?.length) {
        const remainingServerIds = new Set(
          (await listAllowedTools()).map((tool) => tool.serverId),
        )
        if (
          input.requiredServerGroups.some(
            (group) => !group.some((serverId) => remainingServerIds.has(serverId)),
          )
        ) {
          throw new McpAgentToolServiceError(
            'unauthorized',
            'Required MCP tools are no longer available.',
            false,
            { layer: 'mcp-service', phase: 'tool-discovery' },
          )
        }
      }
      if (
        deepResearchWorker &&
        (input.governedWebEvidenceMode ?? 'acquire') === 'acquire'
      ) {
        if (!receivedGovernedWebResult(gateway)) {
          appendDeepResearchWorkerFailure({
            assignmentPath: deepResearchWorker.assignmentPath,
            ...whenDefined(input.taskId, (definedValue) => ({ taskId: definedValue })),
            laneId: deepResearchWorker.laneId,
            category: 'no_web_capability_result',
          })
          throw new McpAgentToolServiceError(
            'provider_failed',
            'Deep Research worker did not return a governed web capability result.',
            true,
            { layer: 'mcp-service', phase: 'tool-execution' },
          )
        }
      } else if (webEvidenceTurn.kind === 'required') {
        result = await this.applyWebResearchEvidence({
          question: webEvidenceTurn.question,
          mode: webEvidenceLinksMode,
          providerKind: input.provider,
          route:
            providerSupport.mode === 'host-tool-bridge'
              ? 'mcp-cli'
              : 'mcp-native',
          candidate: result,
          sources: observedWebSources,
          ...whenDefined(
            deferResearchObserver && providerSupport.mode === 'native-tool-loop'
              ? input.onFinalRoundText
              : undefined,
            (definedValue) => ({ observer: definedValue }),
          ),
          adapterDisplayedText: () => adapterDisplayedText,
          // One validation event per invocation. The lease is issued once per
          // runTurn, so its id is the per-invocation identity the journal
          // event derives from — the workflow runId is not, because the
          // worker route reuses it across turns in one assignment.
          validationId: lease.leaseId,
          scope: {
            sessionId: lease.sessionId,
            runId: lease.runId,
            assignmentId: lease.assignmentId,
          },
          agentPath,
          ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
        })
      }
      return {
        kind: 'completed',
        providerSupport,
        route:
          providerSupport.mode === 'host-tool-bridge'
            ? 'mcp-cli'
            : 'mcp-native',
        result,
        availableToolCount: tools.length,
        artifacts: gateway.producedArtifacts(),
        ...(laneOptions.dropped.length
          ? { droppedProviderOptions: [...laneOptions.dropped] }
          : {}),
      }
    } catch (error) {
      // The safe half of whatever went wrong, taken from the normalized
      // taxonomy rather than from the exception's own words. `parseProviderError`
      // already owns which of those words are safe; nothing here reaches for
      // the message.
      if (turnDiagnostics) {
        const parsed = parseProviderError(error)
        turnDiagnostics.record({
          kind: 'provider-failure',
          ...whenDefined(parsed.kind, (failureKind) => ({ failureKind })),
          ...whenDefined(parsed.code, (failureCode) => ({ failureCode })),
          // The provider's own judgement when it made one; nothing inferred
          // from the message.
          retryable: error instanceof ProviderError && error.retryable === true,
        })
      }
      if (providerCapabilityGateway) {
        throwFatalProviderCapabilityError(
          providerCapabilityGateway,
          providerSupport.mode === 'host-tool-bridge' ? 'mcp-cli' : 'mcp-native',
        )
      }
      if (error instanceof McpAgentToolServiceError) {
        if (droppedProviderOptions.length === 0 || error.code === 'cancelled') throw error
        // Every throw reachable once the lane is chosen names its own layer and
        // phase, so the dropped settings join that record instead of an invented
        // one. Naming a phase here claimed provider resolution for failures that
        // came from tool discovery, execution or the provider request itself.
        throw new McpAgentToolServiceError(error.code, error.message, error.retryable,
          error.diagnostics ? { ...error.diagnostics, droppedProviderOptions } : undefined,
          error.resetsAt, { cause: error })
      }
      if (error instanceof DocumentRequestBudgetError) {
        throw new McpAgentToolServiceError('invalid_request', error.message, false, { layer: 'mcp-service', phase: 'provider-request' }, undefined, { cause: error })
      }
      if (error instanceof ProviderToolLoopError) {
        throw new McpAgentToolServiceError(
          providerLoopErrorCode(error),
          error.message,
          error.retryable,
          {
            ...providerLoopDiagnostics(error),
            ...(droppedProviderOptions.length ? { droppedProviderOptions } : {}),
          },
        )
      }
      if (error instanceof ProviderError) {
        if (input.signal?.aborted) {
          throw new McpAgentToolServiceError(
            'cancelled',
            'MCP agent tool execution was cancelled.',
            false,
            {
              layer: 'mcp-service',
              phase: 'provider-request',
              route: 'mcp-cli',
            },
          )
        }
        const parsed = parseProviderError(error)
        throw new McpAgentToolServiceError(
          // A turn killed for silence, and a turn cut off at its token
          // ceiling, are not provider failures in the usual sense — nothing was
          // wrong with the request — and the diagnostics must be able to say so
          // after this boundary rewrites the error. Every other code collapses
          // to `provider_failed`, so an identity that matters has to be named.
          error.code === PROVIDER_STALLED_CODE
            ? 'provider_stalled'
            : error.code === PROVIDER_TRUNCATED_CODE
              ? 'provider_truncated'
              // An exhausted quota is the one failure the user can act on
              // precisely, and only if it keeps its identity past this point.
              : parsed.kind === 'usage_limit'
                ? 'provider_usage_limit'
                : 'provider_failed',
          safeCliProviderFailureMessage(input.provider, error),
          error.retryable,
          {
            layer: 'mcp-service',
            phase: 'provider-request',
            route: 'mcp-cli',
            ...(parsed.kind === 'unknown' ? {} : { providerKind: parsed.kind }),
            ...whenDefined(boundedProviderCode(parsed.code), (providerCode) => ({
              providerCode,
            })),
            ...(parsed.statusCode === undefined
              ? {}
              : { httpStatus: parsed.statusCode }),
            // The adapter's own claim, carried verbatim. Absent stays absent:
            // only a positive `false` proves nothing was sent.
            ...(error.dispatched === false ? { dispatched: false } : {}),
            // Read here, at the moment the failure happened, because the
            // provider states a wall-clock time and often omits the year.
            ...whenDefined(usageLimitResetAt(error, new Date()), (resetsAt) => ({
              resetsAt,
            })),
          },
          usageLimitResetLabel(error),
        )
      }
      if (error instanceof McpCliHostBridgeError) {
        throw new McpAgentToolServiceError(
          error.code === 'cancelled' ? 'cancelled' : 'internal',
          'MCP CLI bridge execution failed.',
          error.code === 'startup_failed',
          {
            layer: 'mcp-service',
            phase: 'tool-execution',
            route: 'mcp-cli',
            providerCode: error.code,
          },
        )
      }
      throw new McpAgentToolServiceError(
        'internal',
        'MCP agent tool execution failed.',
        true,
        { layer: 'mcp-service', phase: 'provider-request' },
      )
    } finally {
      const assignmentScope = {
        sessionId: lease.sessionId,
        runId: lease.runId,
        assignmentId: lease.assignmentId,
        ...(input.activityScopeId
          ? { activityScopeId: input.activityScopeId }
          : {}),
      }
      for (const adapter of this.options.builtinAgentTools ?? []) {
        try {
          await adapter.releaseAssignment?.(assignmentScope)
        } catch {
          // Adapter cleanup is best-effort and must not mask the turn result.
        }
      }
      this.options.leaseStore.revoke(lease.leaseId)
      this.options.broker.releaseRun({
        sessionId: lease.sessionId,
        runId: lease.runId,
        assignmentId: lease.assignmentId,
        leaseId: lease.leaseId,
      })
    }
  }

  /**
   * The post-loop research-evidence boundary.
   *
   * `off` is the current guard, byte-for-byte. `shadow` computes the
   * Capability A decision and records it, but returns the current guard's
   * answer. `enforce` returns only the Capability A decision and — when the
   * caller's display observer was withheld from the native adapter — publishes
   * the validated text through it exactly once, the same text that is returned
   * for persistence.
   */
  private async applyWebResearchEvidence(input: {
    readonly question: string
    readonly mode: WebEvidenceCapabilityMode
    readonly providerKind: string
    readonly route: WebEvidenceProviderRoute
    readonly candidate: McpProviderTurnResult
    readonly sources: readonly ObservedWebSource[]
    readonly observer?: ((text: string) => void) | undefined
    readonly adapterDisplayedText: () => string | undefined
    /** Per-invocation, content-free identity for the telemetry event. */
    readonly validationId: string
    readonly scope: CapabilityAssignmentScope
    readonly agentPath: string
    readonly signal?: AbortSignal | undefined
  }): Promise<McpProviderTurnResult> {
    const { candidate } = input
    if (input.mode === 'off') {
      return {
        ...candidate,
        text: enforceWebResearchEvidence({
          question: input.question,
          answer: candidate.text,
          sources: input.sources,
        }),
      }
    }
    const startedAt = Date.now()
    const legacyAnswer = enforceWebResearchEvidence({
      question: input.question,
      answer: candidate.text,
      sources: input.sources,
    })
    const decision = decideWebResearchLinks({
      question: input.question,
      answer: candidate.text,
      sources: input.sources,
    })
    const durationMs = Date.now() - startedAt
    const enforcedAnswer =
      decision.kind === 'accepted'
        ? decision.answer
        : INSUFFICIENT_WEB_RESEARCH_RESPONSE
    const published = input.mode === 'enforce' ? enforcedAnswer : legacyAnswer
    // What the display stream actually showed, separately from what is
    // returned for persistence. An observer this method publishes (enforce,
    // native) shows `published`; a native shadow turn already showed the
    // candidate through the adapter; any other route's one final display
    // publication is the chat boundary's, from the persisted text.
    const displayed = input.observer
      ? published
      : input.adapterDisplayedText() ?? published

    // A telemetry append failure marks the cohort's rollout evidence
    // incomplete and blocks promotion — but it must never change the verdict
    // or expose an unsafe answer, so it is contained here. An undefined
    // recorder is the same kind of gap: under `shadow`/`enforce` it means the
    // turn produced no rollout evidence at all, and silence would read as a
    // cohort with zero rejections.
    try {
      const recorder = await this.options.webEvidence?.resolveRecorder?.({
        scope: input.scope,
        agentPath: input.agentPath,
        requestId: randomUUID(),
        ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
      })
      if (!recorder) {
        logProcessWarning(
          'web-evidence-validation',
          'No validation recorder was resolved for a shadow/enforce turn; ' +
            'this cohort’s rollout evidence is incomplete and cannot support promotion.',
        )
      } else {
        try {
          await recorder.recordValidation({
            turnId: input.validationId,
            stage: 'links',
            mode: input.mode,
            providerKind: input.providerKind,
            providerRoute: input.route,
            observedUrlCount: decision.observedUrlCount,
            citedUrlCount: decision.citedUrlCount,
            unobservedUrlCount:
              decision.kind === 'insufficient' ? decision.unobservedUrlCount : 0,
            legacyDecision:
              legacyAnswer === INSUFFICIENT_WEB_RESEARCH_RESPONSE
                ? 'insufficient'
                : 'accepted',
            decision: decision.kind === 'accepted' ? 'accepted' : decision.reason,
            displayedDiffersFromCandidate: displayed !== candidate.text,
            persistedDiffersFromCandidate: published !== candidate.text,
            enforcementWouldDiffer: enforcedAnswer !== legacyAnswer,
            durationMs,
          })
        } finally {
          await recorder.release()
        }
      }
    } catch {
      logProcessWarning(
        'web-evidence-validation',
        'Validation telemetry was not recorded; this cohort’s rollout ' +
          'evidence is incomplete and cannot support promotion.',
      )
    }

    input.observer?.(published)
    return { ...candidate, text: published }
  }
}

/**
 * A broker fault that ended the turn, raised with the route it happened on.
 *
 * The caller knows which client was running; the gateway does not. Without
 * that, a CLI tool execution that died in the broker reached the chat boundary
 * with no route and no phase, and was journaled under the default — the wrong
 * route and the wrong phase for what actually failed.
 */
function throwFatalProviderCapabilityError(
  gateway: ProviderCapabilityGateway,
  route: AgentTurnRoute,
): void {
  const error = gateway.fatalBrokerError()
  if (!error) return
  throw new McpAgentToolServiceError(
    error.code,
    error.message,
    error.retryable,
    { layer: 'mcp-service', phase: 'tool-execution', route },
  )
}

async function defaultCliProviderExecutor(
  provider: string,
  options: ProviderExecuteOptions,
): Promise<ProviderResult> {
  return executeProvider(getProvider(provider), options)
}

function cliProviderConfig(
  provider: string,
  source: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (provider === 'codex') {
    return { sandbox: 'read-only' }
  }
  if (!source) return undefined
  if (provider === 'kimi-cli') {
    const maxSteps = source.max_steps_per_turn
    return typeof maxSteps === 'number' &&
      Number.isSafeInteger(maxSteps) &&
      maxSteps > 0
      ? { max_steps_per_turn: maxSteps }
      : undefined
  }
  return undefined
}

function safeCliProviderFailureMessage(
  provider: string,
  error: ProviderError,
): string {
  const detail = error.message.toLowerCase()
  if (
    detail.includes('not logged in') ||
    detail.includes('not authenticated') ||
    detail.includes('authentication required') ||
    detail.includes('please run /login')
  ) {
    switch (provider) {
      case 'claude':
        return 'Claude Code is not signed in. Run `claude auth login`, then try again.'
      case 'kimi-cli':
        return 'Kimi Code CLI is not signed in. Run `kimi login`, then try again.'
      case 'codex':
        return 'Codex CLI is not signed in. Run `codex login`, then try again.'
    }
  }
  if (
    detail.includes('model not found') ||
    detail.includes('unknown model') ||
    detail.includes('invalid model') ||
    detail.includes('model is unavailable')
  ) {
    return 'The selected CLI model is unavailable. Choose an enabled model in AI Providers.'
  }
  // A limit the provider states a reset for is the one failure where the
  // operator can do something precise — wait until then, or add credits. The
  // shared formatter already renders both; falling through to the generic
  // sentence below would discard them.
  if (parseProviderError(error).kind === 'usage_limit') {
    return formatProviderErrorForUser(error)
  }
  return 'Provider CLI execution failed.'
}

function providerTurnResultFromCli(
  result: ProviderResult,
  counters: McpCliHostBridgeCounters,
): McpProviderTurnResult {
  if (!result.text.trim() || counters.activeToolCalls !== 0) {
    throw new McpAgentToolServiceError(
      'provider_failed',
      'Provider CLI returned an incomplete MCP turn.',
      counters.activeToolCalls !== 0,
      { layer: 'mcp-service', phase: 'provider-request', route: 'mcp-cli' },
    )
  }
  return {
    text: result.text,
    model: result.model,
    toolCallCount: counters.toolCallsStarted,
    executedToolCallCount: counters.toolCallsCompleted,
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.inputTokens + result.outputTokens,
    },
  }
}

function requireDeepResearchWorker(
  assignmentPath: string | undefined,
  laneId: string | undefined,
): { readonly assignmentPath: string; readonly laneId: string } {
  if (!assignmentPath) {
    throw new McpAgentToolServiceError(
      'invalid_request',
      'Deep Research worker assignment is unavailable.',
    )
  }
  if (laneId === undefined) {
    throw new Error('A Deep Research evidence turn must carry its activity scope id as the lane id.')
  }
  return { assignmentPath, laneId }
}

function providerTurnResultFromNativeLoop(
  result: ProviderToolLoopResult,
): McpProviderTurnResult {
  return {
    text: result.text,
    ...(result.model ? { model: result.model } : {}),
    toolCallCount: result.toolCallCount,
    executedToolCallCount: result.executedToolCallCount,
    usage: { ...result.usage },
  }
}

/**
 * The same failure, carrying the settings decision its lane had already made.
 *
 * Rebuilt rather than edited in place: these diagnostics are what the outer
 * chat boundary records, and a record that can be rewritten after it is raised
 * is not one. The original stack travels with it, because this boundary
 * explains the failure rather than causing it.
 *
 * Left untouched where there is nothing to add — no lane was chosen, the lane
 * dropped nothing, the failure already says what it dropped, or it is not this
 * service's error and so has no diagnostics to extend.
 */
function withLaneProviderOptions(
  error: unknown,
  dropped: readonly string[] | undefined,
): unknown {
  if (
    dropped === undefined ||
    dropped.length === 0 ||
    !(error instanceof McpAgentToolServiceError) ||
    error.diagnostics === undefined ||
    error.diagnostics.droppedProviderOptions !== undefined
  ) {
    return error
  }
  const carried = new McpAgentToolServiceError(
    error.code,
    error.message,
    error.retryable,
    { ...error.diagnostics, droppedProviderOptions: [...dropped] },
    error.resetsAt,
  )
  if (error.stack !== undefined) carried.stack = error.stack
  return carried
}

/**
 * Where a native tool-loop failure happened, and what the provider said.
 *
 * The tool-loop and the HTTP adapter are different layers with different
 * remedies: a tool that threw is the runtime's problem, a refused request is
 * the provider's. Collapsing both into `provider_failed` is exactly what left
 * the journal unable to tell them apart.
 */
function providerLoopDiagnostics(
  error: ProviderToolLoopError,
): McpAgentTurnDiagnostics {
  const toolPhase =
    error.code === 'tool_execution_failed' ||
    error.code === 'tool_not_found' ||
    error.code === 'tool_result_too_large'
  return {
    layer: toolPhase ? 'provider-tool-loop' : 'provider-adapter',
    phase: toolPhase ? 'tool-execution' : 'provider-request',
    route: 'mcp-native',
    ...(error.providerIdentity?.providerKind === undefined
      ? {}
      : { providerKind: error.providerIdentity.providerKind }),
    ...(error.providerIdentity?.providerCode === undefined
      ? {}
      : { providerCode: error.providerIdentity.providerCode }),
    ...(error.statusCode === undefined ? {} : { httpStatus: error.statusCode }),
  }
}

/**
 * The lane's own settings for a managed question turn. Effort is deliberately
 * absent: it is resolved once against what the pair accepts and travels as the
 * adapter's `reasoningEffort`.
 *
 * The old raw copy was validated against only three levels in modelParameters,
 * which rejected wider choices before dispatch. The resolved carrier also
 * applies the existing reasoning suppressor policy before the request is sent.
 */
function questionTurnModelParameters(
  provider: string,
  options: Readonly<Record<string, unknown>> | undefined,
) {
  if (provider === 'openai') {
    // Chat Completions names the same total output ceiling differently from Responses.
    // https://platform.openai.com/docs/api-reference/chat/create
    const maximum = options?.max_output_tokens ?? options?.max_tokens
    return {
      ...(typeof maximum === 'number' ? { max_completion_tokens: maximum } : {}),
    }
  }
  const maximum = options?.max_tokens ?? options?.max_output_tokens
  return {
    ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {}),
    ...(typeof maximum === 'number' ? { max_tokens: maximum } : {}),
  }
}

function providerLoopErrorCode(
  error: ProviderToolLoopError,
): McpAgentToolServiceError['code'] {
  switch (error.code) {
    case 'cancelled':
      return 'cancelled'
    case 'timeout':
      return 'timeout'
    case 'tool_not_found':
      return 'tool_not_found'
    case 'request_too_large':
      return 'invalid_request'
    case 'tool_result_too_large':
    case 'response_too_large':
    case 'limit_exceeded':
      return 'result_too_large'
    case 'tool_execution_failed':
      return 'tool_failed'
    case 'provider_truncated':
      // Same identity the direct-HTTP providers raise, so a truncated turn is
      // one fact whichever client produced it.
      return 'provider_truncated'
    default:
      return 'provider_failed'
  }
}


function assertDocumentToolRoundBudget(input: Parameters<typeof assertDocumentRequestBudget>[0]): void {
  try { assertDocumentRequestBudget(input) }
  catch (error) {
    // The tool loop preserves typed protocol errors across its provider boundary.
    if (error instanceof DocumentRequestBudgetError) throw new ProviderToolLoopError('request_too_large', false)
    throw error
  }
}
