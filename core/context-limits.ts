/**
 * Core — every policy number that decides what a model reads.
 *
 * `core/constants.ts` already opens with the commitment this file keeps:
 * "Single source of truth for all repeated literal values. Every magic string
 * or number used in more than one place lives here." Practice drifted to 248
 * separate context-shaping literals, each written at the point of use, none
 * consulting the model that would receive the text. Nothing ever checked,
 * because there was nothing to check against.
 *
 * This is that something. A number belongs here when it decides how much of a
 * model's window is spent, and only then.
 *
 * **What does not belong here.** Ceilings that protect memory, disk, time or
 * cost are a different kind of decision and live with the code that enforces
 * them. A file-read budget that stops a 3 GB PDF exhausting the heap does not
 * become wrong because the model has a million-token window, and folding it in
 * here would let a large window argue for a larger read. The same goes for
 * request-validation bounds — a Zod `.max()` on an HTTP body is a protocol
 * fact, not a context policy. Roughly 150 such ceilings exist; none of them is
 * a context limit and none of them should move here.
 *
 * **How these are meant to be read.** Almost everything below is a *fraction*,
 * because the one authoritative number — the receiving model's context window —
 * is not knowable until dispatch. A share is a ceiling, not an allocation: what
 * a class does not use is offered to the others. That is what lets the same
 * policy serve a 32k local model and a 1M-token hosted one without either
 * being sized for the other.
 *
 * Because they are ceilings rather than allocations, the shares deliberately
 * sum above 1. If they summed to less, part of the window could never be spent
 * by anything. If they summed to exactly 1 they would be allocations, and a
 * turn with no attached files could not give that room to its transcript.
 *
 * Every entry carries the reason it holds its value and the observation that
 * should make someone change it. A number without those is how the 248
 * happened.
 */

/** What the number counts. */
export type ContextLimitKind =
  /** A whole number of tokens. */
  | 'tokens'
  /** A whole number of bytes. */
  | 'bytes'
  /** A whole number of things. */
  | 'count'
  /** A share of something else, between 0 and 1. */
  | 'fraction'
  /** A conversion factor between two units, which is not bounded by 1. */
  | 'ratio'

/** Which boundary refuses or reshapes when this limit binds. */
export type ContextLimitEnforcer =
  /** The fitter, by dropping or shortening an item. */
  | 'fitter'
  /** A prompt-assembly step that bounds one block before the fitter sees it. */
  | 'assembly'
  /** Admission, by measuring the whole request before it is paid for. */
  | 'admission'
  /** The window resolver, when nothing better is known about a model. */
  | 'resolver'
  /** A wire adapter, as a bound below the provider's own. */
  | 'transport'

export interface ContextLimitDefinition {
  readonly value: number
  readonly kind: ContextLimitKind
  readonly enforcedBy: ContextLimitEnforcer
  /** Why this number and not another. */
  readonly reason: string
  /** The observation that should make someone change it. */
  readonly changeWhen: string
  /**
   * The literals this limit is meant to retire.
   *
   * A target, not a record. Listing a literal here does **not** mean it has been
   * removed: most of these are still live and still enforcing on paths that have
   * not been migrated yet. Nothing records migration status but the code, so
   * the honest way to check one is to grep for it. The registry itself is
   * `docs/adr/2026-09-12-Unified-Context-Budget-Registry.md`.
   *
   * Named `supersedes` rather than `replaces` because the first draft read as a
   * completed burn-down and a reviewer reasonably checked all 21 claims against
   * the tree. Eighteen were still live. A registry that overstates what it has
   * retired is worse than no registry, because it is the thing people will trust
   * instead of grepping.
   */
  readonly supersedes?: readonly string[]
}

const DEFINITIONS = {
  'estimator.bytesPerToken': {
    value: 3.5,
    kind: 'ratio',
    enforcedBy: 'admission',
    reason:
      'Below the roughly four bytes per token English prose averages, so the ' +
      'estimate runs high. An estimate that runs low readmits the overflow ' +
      'admission exists to prevent. Inherited from provider-request-budget.ts, ' +
      'which is the one place in the system that had reasoned about it.',
    changeWhen:
      'Recorded estimate-to-reported ratios sit consistently outside 0.9 to 1.4 ' +
      'for a provider we route to often. Move it down, never up.',
    supersedes: [
      'domains/provider/provider-request-budget.ts CONSERVATIVE_BYTES_PER_TOKEN',
      'domains/deep-research/deep-research-prompt-budget.ts bytes/4',
      'domains/agent-execution/context-compressor.ts characters/4',
    ],
  },

  'window.assumedTokens': {
    value: 128_000,
    kind: 'tokens',
    enforcedBy: 'resolver',
    reason:
      'What to assume when neither the static table nor a provider catalog ' +
      'names a window. Large enough that ordinary turns are not needlessly ' +
      'trimmed, small enough that a genuinely small local model is not ' +
      'promised room it does not have. A window this uncertain never earns the ' +
      'right to refuse a turn: where the source is assumed, the fitter trims ' +
      'and records a receipt. Any other source — the checked-in table, a live ' +
      'catalog, or a limit the provider itself stated — may refuse, which is ' +
      'what contextWindowMayRefuse decides and the single rule on the subject.',
    changeWhen:
      'Receipts show assumed windows either refusing real work or letting small ' +
      'local models overflow.',
    supersedes: ['teams/research-team/team.yaml context_window_tokens: 200000 (x3)'],
  },

  'budget.inputFillFraction': {
    value: 0.5,
    kind: 'fraction',
    enforcedBy: 'fitter',
    reason:
      'How much of the admissible window to actually fill. Deliberately not 1.0. ' +
      'Long-context studies the audit itself cites — Chroma on context rot, ' +
      'NoLiMa, lost-in-the-middle — report accuracy falling well before a ' +
      'window is full, so filling a 1M-token window with stale conversation ' +
      'buys a worse answer at a higher price. This is the number most worth ' +
      'arguing about and the one the owner should set deliberately.',
    changeWhen:
      'A probe eval shows later turns losing facts that a fuller prompt would ' +
      'have retained, or shows no loss at a lower value.',
    supersedes: [
      'services/agent-chat-service.ts formatHistory slice(-40)',
      'domains/sessions/continuation-context.ts 2000 / 6000 / 300',
      'services/team-chat-context.ts 3 / 8 / 1200',
      'services/delivery-context.ts 8000',
      'services/task-service.ts buildTaskBrief slice(-12)',
    ],
  },

  'budget.inputSafetyFraction': {
    value: 0.9,
    kind: 'fraction',
    enforcedBy: 'admission',
    reason:
      'The share of a window offered to input at all, before any class takes ' +
      'its share. Covers the gap between a byte-ratio estimate and a real ' +
      'tokenizer, plus the wrapper tokens every provider adds to a request and ' +
      'none of them documents.',
    changeWhen:
      'Turns are refused whose reported input tokens came in comfortably under ' +
      'the window, meaning the margin is larger than it needs to be.',
  },

  'budget.outputReserveFraction': {
    value: 0.15,
    kind: 'fraction',
    enforcedBy: 'admission',
    reason:
      'Room held back for the answer, as a share of the window, so a large ' +
      'model reserves proportionally and a small one is not starved by a flat ' +
      'number chosen for a large one. It is the lowest rung of the existing ' +
      'ceiling ladder in model-client.ts, never a replacement for it: an ' +
      "agent's own max_tokens, an operator override and a thinking level all " +
      'still win, because the pre-dispatch check and the request body must ' +
      'agree on one ceiling.',
    changeWhen:
      'Replies are cut off by the output ceiling rather than by the model ' +
      'choosing to stop.',
  },

  'budget.outputReserveMaxTokens': {
    value: 32_000,
    kind: 'tokens',
    enforcedBy: 'admission',
    reason:
      'A 15% reserve on a 1M-token window is 150k tokens no reply will ever ' +
      'use. Capping the reserve returns that room to the input. Further ' +
      "clamped per route, because a model's real output ceiling is not " +
      'recorded anywhere in this system and exceeding it is a 400, not a trim.',
    changeWhen:
      'A route ships a genuinely larger output ceiling that a stage needs, and ' +
      'the per-route table records it.',
    supersedes: ['domains/provider/model-client.ts DEFAULT_MAX_TOKENS as an implicit reserve'],
  },

  'share.history': {
    value: 0.4,
    kind: 'fraction',
    enforcedBy: 'fitter',
    reason:
      'A ceiling on the conversation transcript. Set below half because the ' +
      'transcript is the class that grows without anyone choosing to add to ' +
      'it, so left uncapped it crowds out material the user deliberately ' +
      'attached.',
    changeWhen:
      'Agents lose the thread of a long conversation while attached references ' +
      'are still reaching them uncut.',
    supersedes: [
      'services/team-chat-context.ts MAX_PRIOR_TURNS / MAX_REPLIES_PER_TURN / MAX_REPLY_CHARACTERS',
      'services/agent-chat-service.ts formatHistory slice(-40)',
      'domains/sessions/chat-llm.ts buildReceptionistModelMessages uncapped history',
    ],
  },

  'share.reference': {
    value: 0.4,
    kind: 'fraction',
    enforcedBy: 'fitter',
    reason:
      'Uploaded files and selected project references together. The user chose ' +
      'these, so they outrank transcript, but they are also the largest and ' +
      'most re-attachable class: a dropped file can be sent again, whereas a ' +
      'silently dropped turn cannot be re-said.',
    changeWhen:
      'Agents answer without having read an attached file that plainly fits the ' +
      'window.',
    supersedes: [
      'services/session-chat-file-context.ts SESSION_CHAT_FILE_MAX_CHARS / SESSION_CHAT_FILES_TOTAL_MAX_CHARS',
      'services/project-context-service.ts PROJECT_CHAT_BRIEF_MAX_CHARS / PROJECT_CHAT_FILE_MAX_CHARS / PROJECT_CHAT_FILES_TOTAL_MAX_CHARS',
      'services/delivery-context.ts MAX_DELIVERY_CONTEXT_CHARS',
    ],
  },

  'share.perAttachment': {
    value: 0.4,
    kind: 'fraction',
    enforcedBy: 'assembly',
    reason:
      'The share of the whole attachment block any single file may take. One ' +
      'upload must not starve the rest of a turn, which is what the old fixed ' +
      'pair of 24,000 per file inside 60,000 total was really expressing.',
    changeWhen:
      'A single large attachment is routinely the whole point of a turn and is ' +
      'being cut while other files take room they do not need.',
    supersedes: ['services/session-chat-file-context.ts SESSION_CHAT_FILE_MAX_CHARS'],
  },

  'share.folderMap': {
    value: 0.25,
    kind: 'fraction',
    enforcedBy: 'assembly',
    reason:
      'The share of the reference block the attached-folder map may take ' +
      '(docs/feature-local-folder-access.md). The map is structure, not ' +
      'content: the agent reads files through tools, so the map only has to ' +
      'name each folder and show enough of its tree to search well. Built ' +
      'first and shrunk in steps, it leaves the rest of the block to uploads ' +
      'and project references.',
    changeWhen:
      'Agents search blindly or list folders repeatedly because the map ' +
      'collapsed a tree they needed, or uploads are cut while the map takes ' +
      'room it does not use.',
  },

  'share.carry': {
    value: 0.15,
    kind: 'fraction',
    enforcedBy: 'fitter',
    reason:
      'Carried results from finished Teams and Workflows. Small on purpose: ' +
      'what belongs in a prompt is the conclusion a producer already wrote, ' +
      'with a pointer to the rest, not the whole of the work.',
    changeWhen:
      'A handoff loses the conclusion the previous stage actually reached — the ' +
      'failure the audit found, where a synthesis was cut first because ' +
      'replies were joined oldest-first.',
    supersedes: [
      'domains/sessions/continuation-context.ts MAX_CONTINUATION_RESULT_CHARS / MAX_CONTINUATION_CONTEXT_CHARS',
    ],
  },

  'share.toolResult': {
    value: 0.2,
    kind: 'fraction',
    enforcedBy: 'transport',
    reason:
      'What one tool result may occupy. Derives both tool lanes from the ' +
      'receiving window instead of two unrelated powers of two chosen years ' +
      'apart. Note this bounds the transport seams only: the browser, ' +
      'acquisition and YouTube producers cut their own output long before a ' +
      'seam is reached, and those cuts are a separate problem.',
    changeWhen:
      'A tool whose entire output is the answer is being truncated mid-result ' +
      'on a model with room to spare.',
    supersedes: [
      'domains/provider/provider-tool-loop.ts DEFAULT_MAX_TOOL_RESULT_BYTES',
      'domains/mcp/mcp-cli-host-bridge.ts DEFAULT_MAX_RESPONSE_BYTES',
    ],
  },

  'item.minimumTokens': {
    value: 64,
    kind: 'tokens',
    enforcedBy: 'fitter',
    reason:
      'Below this a truncation is not an excerpt, it is a misleading fragment ' +
      'that the model will read as complete. The fitter drops an item that ' +
      'cannot be given this much rather than shredding it — the exact failure ' +
      'in the context compressor, which cut every message to 500 characters ' +
      'and then summarized the wreckage.',
    changeWhen:
      'Receipts show items being dropped that a slightly smaller floor would ' +
      'have kept as useful excerpts.',
  },

} as const satisfies Record<string, ContextLimitDefinition>

/** Every context policy number in the system. */
export const CONTEXT_LIMITS: Record<ContextLimitName, ContextLimitDefinition> = DEFINITIONS

export type ContextLimitName = keyof typeof DEFINITIONS

/** The registry's keys, for checks that walk the whole set. */
export function contextLimitNames(): ContextLimitName[] {
  return Object.keys(DEFINITIONS).filter(isContextLimitName)
}

/**
 * Read a limit's value.
 *
 * Named rather than imported as a bare constant so that every use site is
 * greppable and so that an unknown name is a compile error rather than an
 * `undefined` that quietly becomes `NaN` three frames later.
 */
export function contextLimit(name: ContextLimitName): number {
  return DEFINITIONS[name].value
}

function isContextLimitName(value: string): value is ContextLimitName {
  return Object.hasOwn(DEFINITIONS, value)
}
