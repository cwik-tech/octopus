import { whenDefined } from "../../core/optional-properties.js"
import { prepareModelDocuments } from '../document-access/model-document-preparation.js';
import { randomUUID } from "node:crypto";
import { combineAbortSignals } from '../../core/timeout-manager.js';
import { RESOURCE_ARCHITECT_TURN_TIMEOUT_MS } from '../../contracts/resource-architect.js';
import type { ResourceArchitectComposerSelection } from '../../contracts/schemas/resource-architect-composer.js';
import { resourceArchitectReviewWarnings, type ResourceArchitectFeedbackDiagnostics } from '../../contracts/schemas/resource-architect-review.js';
import { getRuntimeDefaultModelState } from '../provider/default-model-selection.js';
import { loadResourceArchitectReviewerConfig } from './resource-architect-reviewer.js';
import { runResourceArchitectFeedback } from './resource-architect-feedback.js';

import type {
  ChatTurn,
  CreateResourceRef,
  ResourceArchitectPlan,
  ResourceArchitectOperation,
  ResourceArchitectTranscriptTurn,
  ResourceReferenceDocument,
  ResourceArchitectDraftProposalResponse,
  ResourceArchitectDraftTurnResponse,
  ResourceArchitectTurnTiming,
} from "../../contracts/resource-architect.js";
import { listAgents, listPublishedTeams, readTeamBuilderTeam } from "../agent-generator/index.js";
import { isSelectableAgent } from "../../contracts/agent-generator.js";
import {
  callModel,
  helperProviderOptionTransport,
  mapHelperProviderOptions,
  readApiKey,
  type HelperProviderOptionTransport,
  type HelperProviderOptions,
  type ModelCallParams,
  type ModelMessage,
} from "../provider/model-client.js";
import { createTrailingMarkerSuppressor } from '../provider/streaming-trailing-marker.js'
import {
  toModelSelectionRecord,
  userChoiceSelectionRecord,
  composerSelectionRecord,
  type ModelSelectionRecord,
} from "../../contracts/agent-model-selection.js";
import {
  admitResourceArchitectRequest,
  admitSelectedAgentPackage,
  isResourceArchitectBudgetRefusal,
  resolveResourceArchitectRequestBudget,
  type ResolveConnectionKind,
} from "./resource-architect-request-budget.js";
import type { ProviderRequestAccounting } from "../provider/provider-request-budget.js";
import {
  loadResourceArchitectConfig,
  readSelectedAgentPackageContext,
  renderAgentLibraryBlock,
  renderSelectedAgentPackageBlock,
  renderTeamLibraryBlock,
  ResourceArchitectNotConfiguredError,
  UPLOADED_DOCUMENTS_POLICY,
  type SelectedAgentMcpServers,
} from "./resource-architect-prompt.js";
import { RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA } from "./resource-architect-output-schema.js";
import { buildResourceArchitectHistoryMessages } from "./resource-architect-history-messages.js";
import { MAX_PLANNED_AGENT_SUMMARY_LENGTH } from "../agent-generator/planned-agent-rules.js";
import type { ThinkingLevel } from "../../contracts/thinking-levels.js";
import {
  parseProposalTurn,
  type ParsedProposalResponse,
} from "./resource-architect-proposal-parser.js";

/**
 * What a turn runs at where the Agent's own level does not apply.
 *
 * The ordinary middle level, dispatched rather than left to each transport's
 * own idea of a default — the CLI adapter has one and an Anthropic request does
 * not, and a turn that thinks differently by route is a turn nobody configured.
 */
const DEFAULT_TURN_THINKING = "medium" as const;

export interface RunResourceArchitectTurnInput {
  documentReviewCacheDir?: string;
  repoRoot: string;
  operation?: ResourceArchitectOperation;
  history: ChatTurn[];
  currentPlan: ResourceArchitectPlan | null;
  selectedResource?: CreateResourceRef;
  /**
   * The MCP rows the Tools tab shows for a selected Agent, resolved by the
   * service shell. Only the grants view crosses into the prompt.
   */
  selectedAgentMcpServers?: SelectedAgentMcpServers;
  /** Names the connection kind behind a `connection:<id>` provider, for its window. */
  resolveConnectionKind?: ResolveConnectionKind;
  provider?: string;
  model?: string;
  composerSelection?: ResourceArchitectComposerSelection;
  reviewEnabled?: boolean;
  onReviewDiagnostics?: (review: ResourceArchitectFeedbackDiagnostics) => Promise<void>;
  uploadedDocuments?: ResourceReferenceDocument[];
  /**
   * The saved conversation as this turn's admission wrote it, with server turn
   * times. When present, provider messages are built from it so each uploaded
   * document sits beside the user message that first used it.
   */
  admittedHistory?: ResourceArchitectTranscriptTurn[];
  signal?: AbortSignal;
  /** Injectable deadline source; callers may supply deterministic clocks. */
  createTurnTimeoutSignal?: (durationMs: number) => AbortSignal;
  /**
   * Display-only observer for streamed answer suffixes.
   *
   * Only the first attempt reports. A repair attempt replaces what the first
   * one said rather than continuing it, so streaming it would splice two
   * different answers into one bubble.
   */
  onTextDelta?: (text: string) => void;
  /**
   * Reported once, as soon as the turn knows which pair it will run on and
   * before anything is sent.
   *
   * The owning operation persists it here rather than waiting for the reply,
   * so the disclosure exists while the model is in use and survives a crash
   * that happens before the turn returns.
   */
  onSelectionResolved?: (selection: ModelSelectionRecord) => Promise<void>;
}

export interface RunResourceArchitectTurnResult {
  response: ResourceArchitectDraftTurnResponse;
  provider: string;
  model: string;
  /**
   * How this turn's pair was decided.
   *
   * The Architect is an Agent like any other, so the operation that owns the
   * turn has to be able to say when it ran on the application default — and to
   * say it from what the turn recorded rather than from Settings as they stand
   * when someone looks. A pair the caller supplied for one authoring turn is
   * recorded as the *user's* choice, never as the Architect's own.
   */
  selection?: ModelSelectionRecord;
  fallback: boolean;
  reasoning: ThinkingLevel;
  timing: ResourceArchitectTurnTiming;
  reason?: string;
  review?: ResourceArchitectFeedbackDiagnostics;
}

export interface ResourceArchitectPromptMeasurement {
  operation: ResourceArchitectOperation;
  reasoning: ThinkingLevel;
  contextAssemblyMs: number;
  context: ResourceArchitectTurnTiming["context"];
}

const CONVERSATION_POLICY = `
## CONVERSATION_RESPONSE_POLICY

Reply with concise natural language. Do not return a JSON envelope, plan, or
authorization field. You may explain that enough information appears available
for a proposal. Ask at most one focused clarification when needed.
When the previous assistant message asks "Did you mean Team" with an exact Team ID,
a plain affirmative answer, or a reply consisting of that exact Team ID, confirms
only that Team. Prepare its proposal for review by ending your reply with
[[proposal-requested]]. A negative or qualified answer does not confirm it;
clarify the exact Team instead.
When the user clearly asks you to proceed with the build (for example
"build it", "do it", or "go ahead"), reply briefly and end the reply with a
final line containing exactly [[proposal-requested]] so the client prepares
the proposal for review. Never claim that your response starts creation: the
user's explicit Create action on the proposal card remains the only build
authorization.
`.trim();

const PROPOSAL_REQUEST_MARKER = "[[proposal-requested]]";
const PROPOSAL_DROPPED_FOR_BUDGET_WARNING =
  "The proposal was not prepared, because a reviewed turn does not fit this model's context window. " +
  "Choose a model with a larger context window, select a different Agent, or shorten the conversation, then ask again.";
const PROPOSAL_REQUEST_ACKNOWLEDGEMENT =
  "Understood — preparing the proposal for your review.";

/**
 * Recognizes a proposal request in an untrusted conversational reply.
 *
 * The signal is accepted only when the trimmed reply ends with one final line
 * that is exactly the marker and the marker occurs nowhere else. A marker in
 * the middle, quoted marker text, or repeated markers leave the message
 * untouched and carry no signal, so an echoed marker from user text or an
 * uploaded document cannot promote the turn.
 */
export function extractProposalRequest(message: string): {
  message: string;
  proposalRequested: boolean;
} {
  const trimmed = message.trimEnd();
  const lines = trimmed.split("\n");
  const finalLine = lines.at(-1) ?? "";
  const body = lines.slice(0, -1).join("\n").trimEnd();
  if (finalLine !== PROPOSAL_REQUEST_MARKER || body.includes(PROPOSAL_REQUEST_MARKER)) {
    return { message, proposalRequested: false };
  }
  return {
    message: body.trim() || PROPOSAL_REQUEST_ACKNOWLEDGEMENT,
    proposalRequested: true,
  };
}

export const RESOURCE_ARCHITECT_PROPOSAL_RESPONSE_CONTRACT = `
## RESOURCE_ARCHITECT_RESPONSE_SCHEMA

Return one JSON object with message, warnings, and exactly one discriminated outcome.
Use outcome.kind standalone_agents for one or more independent Agents, team for a new Team,
resource_updates when the user explicitly names an existing Team and the Agents to add to it,
or an existing Agent and the skills to create or rewrite on it,
discussion when no write is requested, or edit_existing only when the request explicitly
pins a typed target and asks for nothing to be written. A creation outcome never contains an
authorization intent.
Never send a revision field. The server records the exact Team revision when it persists the
plan; a revision you invent would pin the update to a Team state that never existed.
Choose every final Agent name before creation. Names must be unique kebab-case identifiers
of at most 40 characters. Never infer an edit target from the currently visible Agent.
Standalone shape: {"id":"proposal","kind":"standalone_agents","agents":[{"name":"...","role":"...","summary":"...","description":"...","rationale":"...","webResearchEnabled":false}]}
Team shape: {"id":"proposal","kind":"team","team":{"teamId":"...","description":"...","tags":[],"existingAgents":[{"name":"...","role":"...","rationale":"..."}],"newAgents":[{"name":"...","role":"...","summary":"...","description":"...","rationale":"...","webResearchEnabled":false}],"questionsResolved":[],"shape":{...}}}
Every new Agent must include webResearchEnabled. Set it true when its role needs live web
research, current facts or prices, or website review; otherwise false. Honor explicit offline
requests. The user can change this recommendation on the proposal card before Create.
Every new Agent must include summary and description, and they are different texts.
summary is one plain sentence of at most ${MAX_PLANNED_AGENT_SUMMARY_LENGTH} characters, shown on the proposal
card: say what the Agent does and for whom. Never repeat the brief or list its steps in it.
description is the detailed build brief the Agent generator builds the Agent from: its scope,
method, inputs, outputs, and constraints. The card does not show it by default, so keep every
detail there.
On a team proposal, team.shape says how the members work together. Choose it from the task
and state it; never ask the user which one to use, and never leave it null on a new Team.
Use "chain" when each member improves what the one before produced. Use "discussion" when
the members hold different views that are worth hearing side by side. Use "review" when one
member drafts and another checks the draft before it counts.
The three forms, with the roles each requires:
{"kind":"chain","rationale":"...","depth":"...","order":["<every member, in run order>"]}
{"kind":"discussion","rationale":"...","depth":"...","coordinator":"<one member>","participants":["<the others>"]}
{"kind":"review","rationale":"...","depth":"...","producer":"<the writer>","reviewer":"<the checker>"}
Every member of the team must hold exactly one role. Never name a member twice, never leave
one out, and never name anyone who is not on the team.
Discussion participants form the full eligible roster. In Team Chat, the lead selects the
right agents from that roster, at most five for a conversation; this does not limit team size.
A review is exactly two members, one writer and one checker, and a third would never run.
depth is "quick", "standard" or "thorough". A chain always runs each member once,
in order, regardless of depth: no revision loop and no separate coordinator.
In a workflow run, discussion/review depth caps rounds or draft/check attempts at one, three
or five. Team Chat discussion runs one participant pass per lead request.
Discussion participants respond in turn, not in parallel. Only discussion has a named lead
(coordinator); review has only its writer and checker. Never invent an extra lead.
There is no automatic convergence detection. Never promise an unbounded loop. The team card is the executable
proposal. Do not promise multiple stages, branches or feedback loops it cannot represent.
rationale is one plain sentence shown to the user under the shape, saying why these members
work together this way. Write it to them, in their words, and never name a stage type.
Team update shape: {"id":"proposal","kind":"resource_updates","operations":[{"kind":"add_team_agents","target":{"kind":"team","id":"<existing team id>"},"libraryAgentsToAdd":[{"name":"...","role":"...","rationale":"..."}],"newAgentsToCreate":[{"name":"...","role":"...","summary":"...","description":"...","rationale":"...","webResearchEnabled":false,"documentSpecialization":null}]}]}
Agent skill update shape: {"id":"proposal","kind":"resource_updates","operations":[{"kind":"update_agent_skills","target":{"kind":"agent","id":"<existing agent id>"},"skillUpdates":[{"action":"create","name":"<new skill folder name>","instruction":"<what the new SKILL.md must contain>"},{"action":"update","name":"<existing skill folder name>","instruction":"<how the existing SKILL.md must change>"}]}]}
Use one operation per Team and one operation per Agent. Put an Agent that already exists in
libraryAgentsToAdd and an Agent that must be generated in newAgentsToCreate. Never repeat a name
across the two lists.
A name in newAgentsToCreate may appear once in the whole plan, because one name is one Agent.
An Agent that already exists may be added to several Teams in the same plan.
Use action create only for a skill the Agent does not have, and action update only for one it
already has. Skill names are lowercase kebab-case folder names with no path separators.
Never name the same skill twice in one operation, and write an instruction for every skill:
it is the only thing the skill author is given to write from.
`.trim();

export function measureResourceArchitectPrompt(input: {
  repoRoot: string;
  operation: ResourceArchitectOperation;
  history?: ChatTurn[];
  currentPlan?: ResourceArchitectPlan | null;
  selectedResource?: CreateResourceRef;
  uploadedDocuments?: ResourceReferenceDocument[];
}): ResourceArchitectPromptMeasurement {
  const config = loadResourceArchitectConfig(input.repoRoot);
  const assembled = assembleResourceArchitectContext({
    ...input,
    history: input.history ?? [],
    currentPlan: input.currentPlan ?? null,
    uploadedDocuments: input.uploadedDocuments ?? [],
  }, config);
  return {
    operation: input.operation,
    // The level the Architect's own file declares, for every operation. A
    // measurement that reported a level the turn would not run on would be
    // describing a different request.
    reasoning: config.thinking,
    contextAssemblyMs: assembled.contextAssemblyMs,
    context: assembled.context,
  };
}

export async function runResourceArchitectTurn(
  input: RunResourceArchitectTurnInput,
): Promise<RunResourceArchitectTurnResult> {
  const startedAt = performance.now();
  const operation = input.operation ?? "conversation";
  const authoringSignal = operation === 'conversation'
    ? combineAbortSignals(input.signal, (input.createTurnTimeoutSignal ?? AbortSignal.timeout)(RESOURCE_ARCHITECT_TURN_TIMEOUT_MS))
    : input.signal;
  const defaultSnapshot = structuredClone(getRuntimeDefaultModelState());
  const reviewEnabled = input.reviewEnabled ?? true;
  const reviewer = operation === 'conversation' && reviewEnabled
    ? loadResourceArchitectReviewerConfig(input.repoRoot, defaultSnapshot)
    : undefined;
  const defaultReasoning = operation === "conversation" ? "low" : "medium";
  throwIfAborted(authoringSignal);
  let config;
  try {
    config = loadResourceArchitectConfig(input.repoRoot);
  } catch (error) {
    return fallback(
      operation,
      error instanceof ResourceArchitectNotConfiguredError || error instanceof Error
        ? error.message
        : String(error),
      defaultReasoning,
      startedAt,
    );
  }
  // An explicit ad hoc choice for this authoring turn is the caller's own,
  // not the architect Agent's. Only when the caller supplies none does the
  // architect's unresolved selection become the reason this cannot run.
  const callerProvider = input.composerSelection?.provider ?? input.provider?.trim();
  const callerModel = input.composerSelection?.model ?? input.model?.trim();
  const provider = callerProvider || config.provider;
  const model = callerModel || config.model;
  const selection =
    input.composerSelection
      ? composerSelectionRecord(input.composerSelection)
      : callerProvider && callerModel
      ? userChoiceSelectionRecord(
          { provider: callerProvider, model: callerModel },
          "authoring",
        )
      : config.selection
        ? toModelSelectionRecord(config.selection, "authoring")
        : undefined;
  // The Architect's settings describe the pair the Architect chose. A caller's
  // ad hoc pair for one turn is a different selection, and carrying settings
  // across would shape a request for a provider nobody is using.
  const callerChose = Boolean(callerProvider && callerModel);
  // §4.3: the Architect is an Agent and runs on the settings its own file
  // declares — for a conversation as much as for a proposal. This used to force
  // `low` on every conversation whatever the file said, so an Architect asking
  // for more thought was answered with less and had no way to tell that from a
  // provider ignoring the setting.
  //
  // The level travels with the Agent onto whatever pair the *Agent* runs on,
  // including the application default, because it says how much this Agent
  // should think rather than naming a vendor's field. It does not follow a pair
  // somebody picked for one turn: that is their choice, and shaping it with the
  // persona's level applies a setting nobody asked for.
  //
  // Such a turn runs at the ordinary default instead — chosen, dispatched and
  // recorded as one value. Leaving the level absent would mean each transport
  // supplying its own: the CLI adapter defaults to `medium`
  // (`domains/provider/model-client.ts:860`) while an Anthropic request would
  // carry no thinking at all, so the same ad hoc pair would think differently
  // depending on the route, and the check that runs before dispatch would be
  // judging a request nobody was going to send.
  const reasoning = callerChose ? DEFAULT_TURN_THINKING : config.thinking;
  // Settings describe the provider the Architect chose. An Agent that names no
  // pair has chosen none, so its settings describe nothing — carrying them to
  // whatever the application default happens to be would shape a request for a
  // provider nobody selected. This is the same rule the Agent loader applies.
  const architectChose = config.selection?.source === "agent";
  const ownSelection = !callerChose && architectChose;
  const providerOptions = ownSelection ? config.providerOptions : undefined;
  // Independent of which pair runs. A valid setting that no longer applies is
  // dropped and the turn continues; one that is malformed, or that names a
  // credential, cannot be used by any pair and must be reported — which is what
  // Team startup and Agent chat already do whatever the selection source is.
  if (config.providerOptionsError) {
    // Refused rather than dropped. A setting that silently does nothing cannot
    // be told apart from one the provider ignores, and only a refusal can be
    // acted on.
    return fallback(operation, config.providerOptionsError, reasoning, startedAt);
  }
  if (!provider || !model) {
    return fallback(
      operation,
      config.selectionError?.message ??
        "The Agent Architect has no model selected.",
      reasoning,
      startedAt,
    );
  }
  // Reported before anything is sent. The owning operation persists it here so
  // the disclosure exists while the model is in use rather than once the turn
  // is over, and so a crash before the reply still leaves a record.
  // Awaited, not fired and forgotten. A record written after the provider has
  // already been called is not a disclosure during the wait, and a write that
  // fails silently leaves the turn running a model nothing can account for. If
  // it cannot be recorded, the turn does not start.
  if (selection) await input.onSelectionResolved?.(selection)
  throwIfAborted(authoringSignal);
  // Checked before anything is sent, against the transport this pair actually
  // uses. A CLI turn has no request body to carry settings into, so an option
  // for one is refused rather than quietly ignored.
  const transport = helperProviderOptionTransport(provider, reasoning, model);
  const optionsRefusal = describeHelperProviderOptionRefusal(
    transport,
    providerOptions,
  );
  if (optionsRefusal) {
    return fallback(
      operation,
      optionsRefusal,
      reasoning,
      startedAt,
      undefined,
      provider,
      selection,
    );
  }
  const key = readApiKey(provider);
  if (key.apiKey == null) {
    return fallback(
      operation,
      `${key.envVar} is not set`,
      reasoning,
      startedAt,
      undefined,
      provider,
      selection,
    );
  }

  const documentPreparation = await prepareModelDocuments({ documents: (input.uploadedDocuments ?? []).flatMap((document) => document.documentSource ? [document.documentSource] : []), question: input.history.filter((turn) => turn.role === 'user').at(-1)?.text ?? 'Use the attached sources.', apiKey: key.apiKey, ...whenDefined(input.documentReviewCacheDir, (cacheDir) => ({ cacheDir })), model: { provider, model, thinking: reasoning, ...whenDefined(providerOptions, (providerOptions) => ({ providerOptions })), ...whenDefined(authoringSignal, (signal) => ({ signal })) } });

  const {
    systemPrompt,
    messages,
    contextAssemblyMs,
    context,
    selectedAgentPackage,
  } = assembleResourceArchitectContext({
    ...input,
    operation,
    uploadedDocuments: input.uploadedDocuments ?? [],
  }, config);
  if (documentPreparation.context) messages.push({ role: 'user', content: documentPreparation.context });
  // Measured before anything is sent. The selected package is supplied whole
  // or the turn is refused here; it is never shortened to make room.
  const admitPhaseRequest = (
    stage: string,
    params: Pick<ModelCallParams, "provider" | "model" | "systemPrompt" | "messages" | "outputSchema">,
  ): ProviderRequestAccounting => admitResourceArchitectRequest({
    stage,
    budget: resolveResourceArchitectRequestBudget(params, input.resolveConnectionKind),
    systemPrompt: params.systemPrompt,
    messages: params.messages,
    ...whenDefined(params.outputSchema, (outputSchema) => ({ outputSchema })),
  });
  let selectedAgentPackageTokens = 0;
  let draftAccounting: ProviderRequestAccounting;
  try {
    if (selectedAgentPackage) {
      selectedAgentPackageTokens = admitSelectedAgentPackage({
        ...selectedAgentPackage,
        budget: resolveResourceArchitectRequestBudget({ provider, model }, input.resolveConnectionKind),
      }).tokens;
    }
    draftAccounting = admitPhaseRequest("Agent Architect draft", {
      provider, model, systemPrompt, messages,
      ...(operation === "proposal" ? { outputSchema: RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA } : {}),
    });
  } catch (error) {
    if (!isResourceArchitectBudgetRefusal(error)) throw error;
    return fallback(
      operation,
      error.message,
      reasoning,
      startedAt,
      createTiming({ startedAt, contextAssemblyMs, providerDurationMs: 0, firstTextMs: null, context }),
      provider,
      selection,
    );
  }
  const providerStartedOffsetMs = elapsed(startedAt);
  const markerSuppressor = createTrailingMarkerSuppressor(
    PROPOSAL_REQUEST_MARKER,
  )
  if (operation === 'conversation') {
    let firstVisibleTextMs: number | null = null;
    const publishVisibleText = (text: string): void => {
      throwIfAborted(authoringSignal);
      if (!text) return;
      firstVisibleTextMs ??= elapsed(startedAt);
      input.onTextDelta?.(text);
    };
    const feedback = await runResourceArchitectFeedback({
      architect: {
        provider, model, systemPrompt, messages, thinking: reasoning,
        ...whenDefined(providerOptions, (options) => ({ providerOptions: options })),
        ...whenDefined(authoringSignal, (signal) => ({ signal })),
        onTextDelta: (raw) => {
          const visible = markerSuppressor.push(raw);
          publishVisibleText(visible);
        },
      },
      architectApiKey: key.apiKey,
      ...whenDefined(reviewer, (value) => ({ reviewer: value })),
      reviewEnabled,
      clock: () => performance.now(),
      startedAt,
      ...whenDefined(input.onReviewDiagnostics, (onDiagnostics) => ({ onDiagnostics })),
      admission: {
        selectedAgentPackageTokens,
        draft: draftAccounting,
        admit: (phase, params) => admitPhaseRequest(`Agent Architect ${phase}`, params),
      },
    });
    throwIfAborted(authoringSignal);
    const answer = feedback.result;
    const timing = createTiming({
      startedAt, contextAssemblyMs, context,
      providerDurationMs: feedback.providerDurationMs,
      processSpawnMs: answer.timing.processSpawnMs === null ? null : providerStartedOffsetMs + answer.timing.processSpawnMs,
      firstProviderEventMs: feedback.review.phases[0]?.firstProviderEventMs === null ? null : (feedback.review.phases[0]?.startOffsetMs ?? 0) + (feedback.review.phases[0]?.firstProviderEventMs ?? 0),
      firstTextMs: firstVisibleTextMs,
    });
    if (!answer.ok || !answer.text.trim()) {
      return { ...fallback(operation, answer.ok ? 'Resource architect returned an empty conversational response' : answer.reason, reasoning, startedAt, timing, provider, selection), review: feedback.review };
    }
    const unreviewed = feedback.review.reviewStatus === 'not_reviewed';
    const parsed = unreviewed
      ? { message: answer.text.replaceAll(PROPOSAL_REQUEST_MARKER, '').trim(), proposalRequested: false }
      : extractProposalRequest(answer.text.trim());
    // An unreviewed answer never prepares a proposal. When the reason is only
    // that the reviewed turn does not fit, it will not fit next time either,
    // so the dropped request is named rather than silently lost.
    const proposalDroppedForBudget = unreviewed &&
      feedback.review.failureReason === 'context_budget_exceeded' &&
      extractProposalRequest(answer.text.trim()).proposalRequested;
    const warnings = [
      ...resourceArchitectReviewWarnings(feedback.review),
      ...(proposalDroppedForBudget ? [PROPOSAL_DROPPED_FOR_BUDGET_WARNING] : []),
    ];
    if (!unreviewed) {
      const tail = markerSuppressor.finish();
      publishVisibleText(tail);
      // A marker-only answer becomes the visible acknowledgement only here.
      if (firstVisibleTextMs === null) publishVisibleText(parsed.message);
    }
    timing.firstTextMs = firstVisibleTextMs;
    timing.totalDurationMs = elapsed(startedAt);
    return {
      response: { operation, message: parsed.message, warnings, ...(parsed.proposalRequested ? { proposalRequested: true as const } : {}) },
      provider, model, ...whenDefined(selection, (value) => ({ selection: value })),
      fallback: false, reasoning, timing, review: feedback.review,
    };
  }
  const first = await callModel(key.apiKey, {
    provider,
    model,
    systemPrompt,
    messages,
    thinking: reasoning,
    ...whenDefined(providerOptions, (options) => ({ providerOptions: options })),
    ...(operation === "proposal"
      ? { outputSchema: RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA }
      : {}),
    ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
    ...whenDefined(input.onTextDelta, (report) => ({
      // The reply may end with a control marker the client acts on and the
      // saved message never contains. Streaming it raw would show the user
      // machinery, then remove it.
      onTextDelta: (raw: string) => {
        const visible = markerSuppressor.push(raw)
        if (visible !== '') report(visible)
      },
    })),
  });
  // The reply is over, so anything still held back can no longer become the
  // control marker and must be shown rather than lost.
  const heldTail = markerSuppressor.finish()
  if (heldTail !== '') input.onTextDelta?.(heldTail)
  const firstProviderEventMs = first.timing.firstProviderEventMs === null
    ? null
    : providerStartedOffsetMs + first.timing.firstProviderEventMs;
  const firstTextMs = first.timing.firstTextMs === null
    ? null
    : providerStartedOffsetMs + first.timing.firstTextMs;
  const processSpawnMs = first.timing.processSpawnMs === null
    ? null
    : providerStartedOffsetMs + first.timing.processSpawnMs;
  throwIfAborted(input.signal);
  if (!first.ok) {
    return fallback(
      operation,
      first.reason,
      reasoning,
      startedAt,
      createTiming({
        startedAt,
        contextAssemblyMs,
        providerDurationMs: first.timing.providerDurationMs,
        processSpawnMs,
        firstProviderEventMs,
        firstTextMs,
        context,
      }),
      provider,
      selection,
    );
  }

  const parseStartedAt = performance.now();
  const firstParsed = parseProposalTurn(first.text);
  const firstParseDurationMs = elapsed(parseStartedAt);
  if (firstParsed.ok) {
    return {
      response: {
        ...assignServerPlanIdentity(firstParsed.value),
        operation,
      },
      provider,
      model: first.model,
      ...(selection ? { selection } : {}),
      fallback: false,
      reasoning,
      timing: createTiming({
        startedAt,
        contextAssemblyMs,
        providerDurationMs: first.timing.providerDurationMs,
        processSpawnMs,
        firstProviderEventMs,
        firstTextMs,
        parseDurationMs: firstParseDurationMs,
        context,
      }),
    };
  }

  const repairMessages: ModelMessage[] = [
    ...messages,
    { role: "assistant", content: first.text },
    {
      role: "user",
      content: `The response did not match the required JSON contract: ${firstParsed.reason}. Return one corrected JSON object only.`,
    },
  ];
  // The repair resends the whole draft, selected package included, plus the
  // first answer, so it is measured like every other phase before it is sent.
  try {
    admitPhaseRequest("Agent Architect repair", {
      provider, model, systemPrompt, messages: repairMessages,
      outputSchema: RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA,
    });
  } catch (error) {
    if (!isResourceArchitectBudgetRefusal(error)) throw error;
    return fallback(
      operation,
      error.message,
      reasoning,
      startedAt,
      createTiming({
        startedAt,
        contextAssemblyMs,
        providerDurationMs: first.timing.providerDurationMs,
        processSpawnMs,
        firstProviderEventMs,
        firstTextMs,
        parseDurationMs: firstParseDurationMs,
        context,
      }),
      provider,
      selection,
    );
  }
  const repaired = await callModel(key.apiKey, {
    provider,
    model,
    systemPrompt,
    messages: repairMessages,
    thinking: reasoning,
    outputSchema: RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA,
    // The repair runs on the same selection, so it carries the same settings.
    ...whenDefined(providerOptions, (options) => ({ providerOptions: options })),
    ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
  });
  throwIfAborted(input.signal);
  if (!repaired.ok) {
    return fallback(
      operation,
      repaired.reason,
      reasoning,
      startedAt,
      createTiming({
        startedAt,
        contextAssemblyMs,
        providerDurationMs:
          first.timing.providerDurationMs + repaired.timing.providerDurationMs,
        processSpawnMs,
        firstProviderEventMs,
        firstTextMs,
        parseDurationMs: firstParseDurationMs,
        repairOccurred: true,
        repairDurationMs: repaired.timing.providerDurationMs,
        context,
      }),
      provider,
      selection,
    );
  }
  const repairedParseStartedAt = performance.now();
  const repairedParsed = parseProposalTurn(repaired.text);
  const repairedParseDurationMs = elapsed(repairedParseStartedAt);
  if (!repairedParsed.ok) {
    return fallback(
      operation,
      `Resource architect returned invalid JSON twice: ${repairedParsed.reason}`,
      reasoning,
      startedAt,
      createTiming({
        startedAt,
        contextAssemblyMs,
        providerDurationMs:
          first.timing.providerDurationMs + repaired.timing.providerDurationMs,
        processSpawnMs,
        firstProviderEventMs,
        firstTextMs,
        parseDurationMs: firstParseDurationMs + repairedParseDurationMs,
        repairOccurred: true,
        repairDurationMs:
          repaired.timing.providerDurationMs + repairedParseDurationMs,
        context,
      }),
      provider,
      selection,
    );
  }
  return {
    response: {
      ...assignServerPlanIdentity(repairedParsed.value),
      operation,
    },
    provider,
    model: repaired.model,
    ...(selection ? { selection } : {}),
    fallback: false,
    reasoning,
    timing: createTiming({
      startedAt,
      contextAssemblyMs,
      providerDurationMs:
        first.timing.providerDurationMs + repaired.timing.providerDurationMs,
      processSpawnMs,
      firstProviderEventMs,
      firstTextMs,
      parseDurationMs: firstParseDurationMs + repairedParseDurationMs,
      repairOccurred: true,
      repairDurationMs:
        repaired.timing.providerDurationMs + repairedParseDurationMs,
      context,
    }),
  };
}

function assembleResourceArchitectContext(
  input: {
    repoRoot: string;
    operation: ResourceArchitectOperation;
    history: ChatTurn[];
    currentPlan: ResourceArchitectPlan | null;
    selectedResource?: CreateResourceRef;
    selectedAgentMcpServers?: SelectedAgentMcpServers;
    uploadedDocuments: ResourceReferenceDocument[];
    admittedHistory?: ResourceArchitectTranscriptTurn[];
  },
  config: ReturnType<typeof loadResourceArchitectConfig>,
): {
  systemPrompt: string;
  messages: ModelMessage[];
  contextAssemblyMs: number;
  context: ResourceArchitectTurnTiming["context"];
  /** The selected Agent's block exactly as the system prompt carries it. */
  selectedAgentPackage?: { agentName: string; text: string };
} {
  const contextStartedAt = performance.now();
  const agents = listAgents(input.repoRoot).filter(isSelectableAgent);
  // Published teams only. Proposing reuse of one still being built would plan
  // around a roster that is not yet what it will be, and a team that may never
  // finish existing at all.
  const teams = listPublishedTeams(input.repoRoot).map((team) =>
    readTeamBuilderTeam(input.repoRoot, team.id),
  );
  const detailedTeamIds = resolveDetailedTeamIds(
    teams.map((team) => team.id),
    input.history,
    input.selectedResource,
  );
  const detailedAgentIds = resolveDetailedResourceIds(
    agents.map((agent) => agent.name),
    "agent",
    input.history,
    input.selectedResource,
  );
  // Read from disk on every turn, so the next turn sees what the inspector
  // last saved. Only the exact inspector selection gets its whole package.
  const selectedAgent = input.selectedResource?.kind === "agent"
    ? readSelectedAgentPackageContext({
        repoRoot: input.repoRoot,
        agentName: input.selectedResource.id,
        ...whenDefined(input.selectedAgentMcpServers, (mcp) => ({ mcp })),
      })
    : undefined;
  const sections = {
    instructions: config.systemPrompt.trim(),
    operation: input.operation === "conversation"
      ? CONVERSATION_POLICY
      : RESOURCE_ARCHITECT_PROPOSAL_RESPONSE_CONTRACT,
    uploadedDocumentPolicy: UPLOADED_DOCUMENTS_POLICY,
    // Re-enable diagrams only when they can be derived from the executable
    // proposal. Free-form Mermaid currently promises flows the build ignores.
    visualizationPolicy: "Use plain prose or a roster table. Do not include Mermaid diagrams or speculative workflow diagrams. Describe only the interaction supported by the proposed team shape.",
    teamLibrary: renderTeamLibraryBlock(teams, detailedTeamIds),
    agentLibrary: renderAgentLibraryBlock(agents, detailedAgentIds, selectedAgent),
  };
  const systemPrompt = Object.values(sections).join("\n\n");
  const messages = buildMessages(
    input.admittedHistory ?? input.history,
    input.currentPlan,
    input.uploadedDocuments,
  );
  return {
    systemPrompt,
    messages,
    ...whenDefined(selectedAgent, (selected) => ({
      selectedAgentPackage: {
        agentName: selected.agentName,
        text: renderSelectedAgentPackageBlock(selected),
      },
    })),
    contextAssemblyMs: elapsed(contextStartedAt),
    context: {
      instructionsChars: sections.instructions.length,
      operationChars: sections.operation.length,
      uploadedDocumentPolicyChars: sections.uploadedDocumentPolicy.length,
      visualizationPolicyChars: sections.visualizationPolicy.length,
      teamLibraryChars: sections.teamLibrary.length,
      agentLibraryChars: sections.agentLibrary.length,
      totalChars: systemPrompt.length,
      historyChars: messages.reduce(
        (total, message) => total + message.content.length,
        0,
      ),
    },
  };
}

function buildMessages(
  history: readonly ResourceArchitectTranscriptTurn[],
  currentPlan: ResourceArchitectPlan | null,
  uploadedDocuments: ResourceReferenceDocument[],
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  if (currentPlan) {
    messages.push({
      role: "user",
      content: `Current proposed plan for context only:\n\n\`\`\`json\n${JSON.stringify(currentPlan, null, 2)}\n\`\`\``,
    });
    messages.push({ role: "assistant", content: "I will continue from that proposal." });
  }
  messages.push(...buildResourceArchitectHistoryMessages(history, uploadedDocuments));
  if (messages.length === 0) {
    messages.push({
      role: "user",
      content: "Greet briefly and ask whether I need independent Agents or a Team.",
    });
  }
  return messages;
}


function assignServerPlanIdentity(
  response: ParsedProposalResponse,
): ParsedProposalResponse {
  return response.outcome.kind === "standalone_agents" ||
      response.outcome.kind === "team" ||
      response.outcome.kind === "resource_updates"
    ? { ...response, outcome: { ...response.outcome, id: randomUUID() } }
    : response;
}


/**
 * Why these settings cannot be used on this pair, if they cannot.
 *
 * One sentence a person can act on, naming the setting. Silence would be the
 * defect: an option that does nothing is indistinguishable from one the
 * provider ignores.
 */
function describeHelperProviderOptionRefusal(
  transport: HelperProviderOptionTransport | undefined,
  options: HelperProviderOptions | undefined,
): string | undefined {
  // Asked even with nothing written beside it: a transport still has to decide
  // whether a declared level's budget fits the answer ceiling, and whether it
  // serves this model at all. Both can fail with no options in sight.
  // A CLI turn has no request body to map settings into, but its adapter reads
  // settings of its own and decides what it understands. Refusing here would
  // take away a capability that already exists.
  if (!transport) return undefined;
  const mapped = mapHelperProviderOptions(transport, options);
  if (mapped.ok) return undefined;
  if ('conflict' in mapped) return `${mapped.conflict} Nothing was sent.`;
  return 'unsupported' in mapped
    ? `'provider_options.${mapped.unsupported}' is not a setting this provider ` +
      'request can carry. Nothing was sent.'
    : `'provider_options.${mapped.invalid}' must be ${mapped.expected}. Nothing was sent.`;
}

function fallback(
  operation: ResourceArchitectOperation,
  reason: string,
  reasoning: ThinkingLevel,
  startedAt: number,
  timing?: ResourceArchitectTurnTiming,
  provider = "fallback",
  // Once a pair has been resolved, the failure ran on it. A person reading
  // "the Architect is unavailable" needs to know whether the model that failed
  // was the application default or one they picked, so the record travels with
  // the failure rather than only with the reply.
  selection?: ModelSelectionRecord,
): RunResourceArchitectTurnResult {
  const response: ResourceArchitectDraftTurnResponse = operation === "conversation"
    ? {
        operation,
        message: `The Agent Architect is unavailable: ${reason}`,
        warnings: [],
      }
    : {
        operation,
        message: `The Agent Architect is unavailable: ${reason}`,
        outcome: { kind: "discussion" },
        warnings: [],
      };
  return {
    response,
    provider,
    model: "fallback",
    fallback: true,
    reasoning,
    timing: timing ?? emptyTiming(startedAt),
    reason,
    ...(selection ? { selection } : {}),
  };
}

function resolveDetailedTeamIds(
  teamIds: string[],
  history: ChatTurn[],
  selectedResource: CreateResourceRef | undefined,
): Set<string> {
  return resolveDetailedResourceIds(
    teamIds,
    "team",
    history,
    selectedResource,
  );
}

function resolveDetailedResourceIds(
  resourceIds: string[],
  kind: CreateResourceRef["kind"],
  history: ChatTurn[],
  selectedResource: CreateResourceRef | undefined,
): Set<string> {
  const selected = new Set<string>();
  if (selectedResource?.kind === kind && resourceIds.includes(selectedResource.id)) {
    selected.add(selectedResource.id);
  }
  const text = history.map((turn) => turn.text).join("\n");
  for (const resourceId of resourceIds) {
    const escaped = resourceId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`, "iu").test(text)) {
      selected.add(resourceId);
    }
  }
  return selected;
}

function createTiming(params: {
  startedAt: number;
  contextAssemblyMs: number;
  providerDurationMs: number;
  processSpawnMs?: number | null;
  firstProviderEventMs?: number | null;
  firstTextMs: number | null;
  context: ResourceArchitectTurnTiming["context"];
  parseDurationMs?: number;
  repairOccurred?: boolean;
  repairDurationMs?: number;
}): ResourceArchitectTurnTiming {
  return {
    contextAssemblyMs: params.contextAssemblyMs,
    providerDurationMs: params.providerDurationMs,
    processSpawnMs: params.processSpawnMs ?? null,
    firstProviderEventMs: params.firstProviderEventMs ?? null,
    firstTextMs: params.firstTextMs,
    parseDurationMs: params.parseDurationMs ?? 0,
    repairOccurred: params.repairOccurred ?? false,
    repairDurationMs: params.repairDurationMs ?? 0,
    totalDurationMs: elapsed(params.startedAt),
    context: params.context,
  };
}

function emptyTiming(startedAt: number): ResourceArchitectTurnTiming {
  return createTiming({
    startedAt,
    contextAssemblyMs: 0,
    providerDurationMs: 0,
    firstTextMs: null,
    context: {
      instructionsChars: 0,
      operationChars: 0,
      uploadedDocumentPolicyChars: 0,
      visualizationPolicyChars: 0,
      teamLibraryChars: 0,
      agentLibraryChars: 0,
      totalChars: 0,
      historyChars: 0,
    },
  });
}

function elapsed(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
