import * as fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'

import type { CapabilityAssignmentScope } from '../contracts/capability-dispatch.js'
import {
  normalizeExternalCapabilityEffect,
  type CapabilityEffectKind,
} from '../contracts/capability-effect.js'
import type {
  CapabilityDispatchResolutionPort,
  CapabilityRecoveryPolicy,
  DurableDispatchState,
  DurableRecoveryDecision,
  OperatorResolutionDecision,
  OperatorResolutionOutcome,
  OperatorResolutionPrincipal,
  OperatorSuppliedResult,
  CapabilityResultRetentionSummary,
} from '../contracts/durable-dispatch.js'
import type { RouteCredentialScope } from '../contracts/route-credentials.js'
import {
  ExecutionJournalError,
  type ExecutionJournalEvent,
  type ExecutionJournalManifest,
} from '../contracts/execution-journal.js'
import { parseExecutionJournalManifest } from '../core/execution-journal.js'
import {
  readWorkflowJournalDivergence,
  type WorkflowJournalDivergenceRead,
} from './workflow-journal-divergence.js'
import {
  DURABLE_DISPATCH_STREAM_KIND,
  narrowRecoveryPolicy,
  reduceDurableDispatchState,
  resolveDurableRecovery,
} from '../core/durable-dispatch.js'
import {
  summarizeAgentTurnStreams,
  type AgentTurnSummary,
} from '../domains/agent-execution/agent-turn-journal.js'
import {
  summarizeWebEvidenceValidationCohorts,
  type WebEvidenceValidationCohortSummary,
} from '../domains/browser/web-evidence-validation-journal.js'
import {
  EXECUTION_JOURNAL_DIRECTORY_NAME,
  readExecutionJournal,
  type ExecutionJournalMetrics,
} from '../core/execution-journal.js'
import {
  DISPATCH_EVENT_TYPES,
  isDurableStreamEvent,
  summarizeCapabilityResultRetention,
  toStreamEvent,
} from '../core/durable-dispatch-journal.js'
import {
  CAPABILITY_EVIDENCE_PROJECTION_ID,
  CAPABILITY_EVIDENCE_REDUCER_VERSION,
  lastDispatchSequence,
} from '../core/capability-dispatch-projection.js'
import {
  classifyProjectionLag,
  JournalProjectionMetadataStore,
  type ProjectionLagStatus,
} from '../core/journal-projection.js'
import { errorCodeOf, hasErrorCode } from '../core/node-errors.js'
import { isPathInside } from '../core/path-safety.js'
import {
  buildSessionRunAssignmentLocation,
  RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
} from '../core/run-assignment-location.js'
import {
  ACTIVITY_SHAPED_NAME,
  isConversationActivityId,
  CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  type ConversationOwner,
} from '../core/conversation-activity-location.js'
import { readPrivateFile } from './safe-workspace-directory.js'
import { CONVERSATION_MAX_PROJECTED_IDS } from '../domains/conversations/conversation-turn-retention-policy.js'

const MANIFEST_FILENAME = 'manifest.json'

/** Bounds one discovery request; see `listJournals`. */
const DEFAULT_JOURNAL_LIST_LIMIT = 500

/**
 * How many distinct tenants a conversation walk will summarise.
 *
 * A healthy workspace has one. More than a handful means something is wrong,
 * and the aggregate refuses to grow rather than faithfully reporting damage.
 */
export const CONVERSATION_DISCOVERY_MAX_TENANTS = 8

/**
 * How many unreadable paths one walk will name.
 *
 * The list is held in memory and serialized by a route, and what goes into it
 * is decided by whatever is in the workspace — so it is a bound, not a
 * expectation. Past it the walk stops naming them and says the list is short.
 */
export const CONVERSATION_DISCOVERY_MAX_UNREADABLE = 256

/**
 * How many entries that are not directories one listing will step over.
 *
 * The bound is on the skipped entries, not on the listing as a whole, and the
 * distinction is the difference between a limit and a regression. Directories
 * are already bounded by the contract above them — a conversation may hold up
 * to its retained cap of activities, and a workspace holds the sessions it
 * holds — so bounding raw entries at any fixed number turns a legal workspace
 * into one that cannot be described. What nothing bounds is the rest: links and
 * plain files can be created without limit by anyone who can write into the
 * directory, and a scan that filters them before counting still pulls every one.
 * So that is what stops.
 */
export const CONVERSATION_DISCOVERY_MAX_SKIPPED_ENTRIES = 1_024

/**
 * How many entries a session, run or assignment listing will read at all.
 *
 * The skip bound above only limits what a listing steps over; the directories
 * it keeps are unbounded, and those listings have no page bound to fall back
 * on. So there is a ceiling on the listing as a whole. Ten thousand sessions
 * under one workspace, or ten thousand assignments under one run, is past what
 * startup will describe — and saying so is the right answer, because the
 * alternative is a walk whose cost is chosen by whoever fills the directory.
 */
export const DISCOVERY_MAX_HIERARCHY_ENTRIES = 10_000

/**
 * How many conversation activities one startup walk will examine in total.
 *
 * Every other bound here is per directory, and none of them bounds their
 * product: ten thousand sessions each holding a legal ten thousand activities
 * is a hundred million journals to open, with no single limit exceeded. The
 * walk needs a budget of its own, and a walk that spends it has not described
 * the workspace — which is a refusal, not a partial answer.
 */
export const DISCOVERY_MAX_WORKSPACE_ACTIVITIES = 100_000

/**
 * The largest manifest this walk will read.
 *
 * A manifest is a fixed set of short fields; anything approaching this is not
 * one. Generous enough that a legitimate manifest never approaches it, small
 * enough that a file dropped in its place cannot make startup allocate.
 */
const MANIFEST_MAX_BYTES = 64 * 1024

/**
 * What a walk could not read, held to a bound.
 *
 * The list is kept in memory and serialized by a route, and what goes into it
 * is decided by whatever happens to be in the workspace — so it is collected
 * through something that stops rather than through an array that grows. Past
 * the bound the walk stops naming individual paths and records that it did.
 */
class WalkFaultLog {
  private readonly entries: { path: string; reason: string }[] = []
  private overflowed = false

  record(faultPath: string, reason: string): void {
    if (this.entries.length >= CONVERSATION_DISCOVERY_MAX_UNREADABLE) {
      this.overflowed = true
      return
    }
    this.entries.push({ path: faultPath, reason })
  }

  get paths(): { path: string; reason: string }[] {
    return this.entries
  }

  /** True when more was unreadable than this log was willing to name. */
  get truncated(): boolean {
    return this.overflowed
  }
}

/**
 * The most activities one conversation may hold before the walk gives up on it.
 *
 * Exactly what admission will let a conversation hold, rather than a number
 * restated beside it. Admission reserves projection capacity for every turn it
 * accepts — the turns being kept plus the ones still open have to fit together —
 * so that bound is the largest number of activity directories production can
 * legitimately create. Anything above it here would let startup bless a state
 * production cannot reach; anything below would make startup refuse a state
 * production creates, which is the worst place for two limits to disagree
 * because it only shows up as a workspace that will not open.
 *
 * Past this the conversation is outside what retention permits, and startup does
 * not need an exact count to know it: "over the cap" is the whole answer, so the
 * walk stops one past the bound rather than reading thousands more manifests to
 * reach the same verdict.
 */
export const CONVERSATION_RETAINED_CAP = CONVERSATION_MAX_PROJECTED_IDS

/**
 * Operator read path for the durable execution journal (Phase 8 ADR §15).
 *
 * A lazy dispatch registry only holds journals it happened to open, so after a
 * restart nothing can find an abandoned journal or an unresolved dispatch.
 * Discovery answers that from disk. The read methods never provision storage,
 * never take the per-scope lock, and never repair a journal they inspect.
 *
 * `resolveDispatch` is the exception and the reason this is no longer a purely
 * read-only surface (AC11a). It records what an authorized operator decided
 * about a dispatch nobody can prove the outcome of, which is the only way a
 * wedged dispatch is ever resolved. It reaches the journal through the
 * registry that owns it rather than opening one of its own, so a resolution
 * cannot reopen an assignment that registry has already barred (D4).
 */

/** The conversation an operator asked to see the lifecycle of. */
export interface ConversationInspectionScope {
  readonly ownerKind: ConversationOwner['kind']
  readonly conversationId: string
}

/**
 * What the operator surface asks permission for.
 *
 * One union rather than one policy per surface: the assignment journals and
 * the conversation journals are the same operator system, and two authorities
 * over it would be two rules that drift apart without anything noticing. The
 * subject is discriminated, so a policy that means to treat conversation reads
 * differently can, and one that does not still answers both.
 *
 * `credentialScope` is which credential the transport admitted, or absent when
 * it authenticated nobody. A read surface can live with that; a write path
 * that changes replay decisions cannot, so `resolve` is expected to refuse it.
 */
export type ExecutionJournalAuthorizationRequest =
  | {
      readonly action: 'list'
      readonly credentialScope?: RouteCredentialScope
    }
  | {
      readonly action: 'inspect' | 'resolve'
      readonly scope: CapabilityAssignmentScope
      readonly credentialScope?: RouteCredentialScope
    }
  | {
      readonly action: 'inspect'
      readonly conversationScope: ConversationInspectionScope
      readonly credentialScope?: RouteCredentialScope
    }

export interface ExecutionJournalInspectionAuthority {
  authorize(request: ExecutionJournalAuthorizationRequest): Promise<boolean>
}

/**
 * What the operator surface needs before it may record a resolution: a way to
 * reach the assignment's journal, and a principal it derives itself.
 *
 * Absent where resolutions cannot be recorded at all — a composition with no
 * workspace has no registry — so the surface reports "not configured" rather
 * than pretending the write happened.
 */
export interface ExecutionJournalResolutionSupport {
  readonly ports: {
    resolveResolutionPort(input: {
      readonly scope: CapabilityAssignmentScope
      readonly signal: AbortSignal
      readonly deadlineMs: number
    }): Promise<CapabilityDispatchResolutionPort | undefined>
  }
  /**
   * The principal sealed into the resolution. Server-derived by construction:
   * the only per-request input is the credential scope the transport resolved,
   * and nothing here reads the request body.
   */
  principal(input: {
    readonly credentialScope: RouteCredentialScope
  }): OperatorResolutionPrincipal
  readonly clock?: () => number
}

export type ExecutionJournalResolutionReport =
  | OperatorResolutionOutcome
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'journal_unavailable'; readonly reason: string }

/** How long the operator surface waits for the assignment's journal. */
const RESOLUTION_JOURNAL_BUDGET_MS = 5_000

export class ExecutionJournalAuthorizationError extends Error {
  constructor() {
    super('Execution journal inspection failed authorization.')
    this.name = 'ExecutionJournalAuthorizationError'
  }
}

export interface DiscoveredJournal {
  readonly scope: CapabilityAssignmentScope
  readonly journalDirectory: string
}

/**
 * What discovery could establish about one journal directory.
 *
 * `indeterminate` is the load-bearing value. A journal directory that exists
 * without a readable manifest is not an absent journal — it is durable state
 * nobody has read, and treating it as absence lets a caller authorize a tenant
 * pin over it.
 */
export type DiscoveredJournalState = 'enrolled' | 'indeterminate'

export interface DiscoveredJournalCandidate extends DiscoveredJournal {
  readonly state: DiscoveredJournalState
  /** Why the state is indeterminate; absent when enrolled. */
  readonly reason?: string
}

/**
 * One conversation activity journal found by discovery.
 *
 * Kept as its own list rather than widened into `DiscoveredJournal.scope`. That
 * scope is consumed by `inspect()`, which is assignment-shaped down to
 * comparing `manifest.scopeId` against `scope.assignmentId`; making it a union
 * would mean a second report shape inside a service that has one. What startup
 * actually needs from a conversation journal is narrower — can it be read, and
 * does it agree about the tenant — and that is what this carries.
 */
export interface DiscoveredConversationJournal {
  readonly conversationId: string
  readonly ownerKind?: ConversationOwner['kind']
  readonly sessionId?: string
  readonly activityId: string
  readonly journalDirectory: string
  readonly state: DiscoveredJournalState
  readonly reason?: string
  /** The tenant the manifest is sealed to, when it could be read. */
  readonly tenantId?: string
}

export interface DiscoveredJournalDivergence {
  readonly scope: CapabilityAssignmentScope
  readonly read: WorkflowJournalDivergenceRead
}

export interface ExecutionJournalDiscovery {
  readonly candidates: readonly DiscoveredJournalCandidate[]
  readonly conversationCandidates: readonly DiscoveredConversationJournal[]
  /**
   * The conversation list was paged, not the walk.
   *
   * Deliberately separate from `truncated`: an incomplete assignment walk
   * cannot support a verdict about the workspace, but a paged conversation
   * list can, because every activity was still examined for tenant agreement
   * and readability.
   */
  readonly conversationsTruncated: boolean
  /**
   * How many conversation activities the walk examined.
   *
   * Distinct from `conversationCandidates.length`, which is a page. An operator
   * told a workspace is blocked needs the number that was actually inspected,
   * not the number that fit in the response.
   */
  readonly conversationCount: number
  /**
   * The walk found more unreadable activities than it will report.
   *
   * Fail closed on this: an unreadable activity is why a pin is refused, so a
   * walk that could not even list them all cannot support a verdict.
   */
  readonly indeterminateConversationsOverflowed: boolean
  /**
   * Distinct tenants seen across the conversation walk, bounded.
   *
   * A workspace should hold one. The bound exists because this is an aggregate
   * a caller holds and a route may serialize, and an unbounded set derived from
   * on-disk content is a way for damage to become memory pressure.
   */
  readonly conversationTenantIdsBounded: readonly string[]
  /**
   * More distinct tenants than the aggregate may hold.
   *
   * Fail closed on this: a tenant set that could not be summarised cannot
   * support a decision about which tenant a workspace belongs to.
   */
  readonly conversationTenantsOverflowed: boolean
  /** Enrolled conversation activities across the whole walk, not the page. */
  readonly enrolledConversationCount: number
  /**
   * A conversation holds more activities than retention permits.
   *
   * The walk stopped there, so counts are a floor rather than a total, and
   * activation fails closed: a workspace whose conversations are outside their
   * retention bounds has not been described.
   */
  readonly conversationRetainedCapExceeded: boolean
  /**
   * Assignments where an authoritative cancellation could not reach the
   * journal. Collected on the same walk, and for every assignment rather than
   * only the ones holding a journal: a divergence can be recorded precisely
   * because the journal was never reachable.
   */
  readonly divergences: readonly DiscoveredJournalDivergence[]
  /**
   * True when the walk stopped early, so the candidate list is a prefix of the
   * workspace rather than a description of it.
   */
  readonly truncated: boolean
  /** Directories the walk could not read. Empty means the walk was complete. */
  readonly unreadablePaths: readonly { readonly path: string; readonly reason: string }[]
  /**
   * True when a listing stopped before it had seen the whole directory.
   *
   * Separate from `truncated`, which is about the reported page. This says the
   * walk did not finish reading, so an activity may exist that it never saw —
   * and a workspace that has not been read cannot be described.
   */
  readonly conversationScanOverflowed: boolean
}

export interface UnresolvedDispatch {
  readonly dispatchId: string
  readonly state: DurableDispatchState
  readonly recovery: 'blocked' | 'reconcile' | 'retriable'
  readonly lastSequence: number
  /** When this dispatch last moved, from the journal's own record. */
  readonly unresolvedSince: string
  /** How long ago that was, at the moment the report was built (ADR §15). */
  readonly ageMs: number
  /**
   * What the adapter sealed at `prepared`, which is what an operator has to
   * decide from: `non_retryable`, `unknown`, and no declaration at all lead to
   * three different decisions. Absent when the stream holds no readable
   * preparation, because inventing a policy for one is worse than saying so.
   */
  readonly declared?: DeclaredDispatch
}

export interface DeclaredDispatch {
  readonly capabilityId: string
  /**
   * Both fields are narrowed the way the runtime narrows them, so the report
   * predicts what recovery will actually do rather than echoing journal text
   * it would not honour. A value outside the union becomes `unknown`, which is
   * the fail-closed reading, and is never passed through to a reader as-is.
   */
  readonly effectKind: CapabilityEffectKind
  readonly recoveryPolicy: CapabilityRecoveryPolicy
}

/**
 * Where the report gets this process's journal counters.
 *
 * Deliberately a peek and never an open: the report is a read path, and the
 * counters are per-handle and in-memory, so opening a journal to read them
 * would report the numbers of the open that just happened.
 */
export interface ExecutionJournalMetricsSource {
  peekMetrics(
    scope: CapabilityAssignmentScope,
  ): Promise<ExecutionJournalMetrics | undefined>
}

/**
 * The counters, or an honest statement about why there are none.
 *
 * Three arms rather than an optional field, because "nobody has this journal
 * open", "the counters could not be read", and a set of zeros are three
 * different things, and the last is what the other two would be mistaken for.
 */
export type ExecutionJournalReportMetrics =
  | { readonly kind: 'live'; readonly counters: ExecutionJournalMetrics }
  | { readonly kind: 'no-open-handle' }
  /**
   * The counters could not be read. Distinct from `no-open-handle`, which is a
   * fact about the process; this is a fault, and reporting it as the former
   * would state something untrue about the journal. The reason is an error
   * code rather than a message, because a message can carry a path.
   */
  | { readonly kind: 'unavailable'; readonly reason: string }

export type ExecutionJournalInspectionReport =
  | {
      readonly kind: 'report'
      readonly scope: CapabilityAssignmentScope
      /**
       * The tenant sealed into this journal's manifest. Exposed because the
       * activation preflight has to compare tenants across a workspace before
       * one can be pinned, and re-reading every manifest to learn it would
       * duplicate the identity checks this method already performs.
       */
      readonly tenantId: string
      readonly eventCount: number
      readonly lastSequence: number
      readonly unresolved: readonly UnresolvedDispatch[]
      /**
       * One entry per selected-agent reply recorded on this assignment.
       *
       * Derived from the journal on every read rather than from a projection:
       * the reducer already runs over events this method has validated, and a
       * stored index would have to be rebuilt before it could be trusted. Add
       * one only once a measured query cost justifies it.
       *
       * Carries no prompt, no reply text, no provider body, and no header —
       * only the lifecycle state and the sanitized failure identity.
       */
      readonly agentTurns: readonly AgentTurnSummary[]
      /**
       * The sanitized web evidence rollout evidence on this assignment,
       * aggregated by provider kind, provider route, and rollout mode — the
       * cohort dimensions the §8.2 shadow review rates. Derived from the
       * journal on every read, same as `agentTurns`, and carrying only counts
       * and closed-union codes: no question, answer, URL, title, or content.
       */
      readonly webEvidenceValidations: WebEvidenceValidationCohortSummary
      /**
       * How this assignment's result-bearing records retain their results,
       * and whether any of them still hold that content inside the journal
       * (`docs/adr/2026-08-26-Execution-Journal-Content-Separation.md`).
       *
       * Counts and closed unions only. A summary that reproduced a result to
       * describe it would defeat what it exists to report.
       */
      readonly capabilityResults: CapabilityResultRetentionSummary
      readonly projection: ProjectionLagStatus
      /** This process's counters for the journal, when it holds it open. */
      readonly metrics: ExecutionJournalReportMetrics
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'corrupt'; readonly reason: string }
  | { readonly kind: 'unsupported_version' }
  /** The journal at this path was sealed for a different assignment. */
  | {
      readonly kind: 'identity_mismatch'
      readonly requested: CapabilityAssignmentScope
      readonly sealed: {
        readonly scopeId: string
        readonly sessionId?: string
        readonly runId?: string
        readonly assignmentId?: string
      }
    }

export interface ExecutionJournalInspectionOptions {
  readonly workspacePath: string
  readonly authority: ExecutionJournalInspectionAuthority
  /** Present only where an operator may record resolutions. */
  readonly resolution?: ExecutionJournalResolutionSupport
  /** Present where this process may already hold the journal open. */
  readonly journals?: ExecutionJournalMetricsSource
  readonly clock?: () => number
}

export class ExecutionJournalInspectionService {
  private readonly workspacePath: string
  private readonly authority: ExecutionJournalInspectionAuthority
  private readonly resolution: ExecutionJournalResolutionSupport | undefined
  private readonly journals: ExecutionJournalMetricsSource | undefined
  private readonly clock: () => number

  constructor(options: ExecutionJournalInspectionOptions) {
    this.workspacePath = options.workspacePath
    this.authority = options.authority
    this.resolution = options.resolution
    this.journals = options.journals
    this.clock = options.clock ?? (() => Date.now())
  }

  /**
   * Record an authorized operator's resolution of a blocked dispatch (ADR §7
   * option 3, AC11a).
   *
   * This is the one method here that writes, and the reason the authority
   * parameter stopped being a documented constant. What it decides is not
   * cosmetic: the next dispatch on this identity executes again, returns a
   * retained result, or stops for good, according to what is recorded here.
   *
   * The principal is assembled from the credential scope the transport
   * resolved and the server's own tenant and process instance. Nothing in the
   * request body reaches it, because a caller-supplied identity would read as
   * provenance while carrying none.
   */
  async resolveDispatch(input: {
    readonly scope: CapabilityAssignmentScope
    readonly dispatchId: string
    readonly decision: OperatorResolutionDecision
    readonly reason: string
    readonly credentialScope?: RouteCredentialScope
    readonly result?: OperatorSuppliedResult
  }): Promise<ExecutionJournalResolutionReport> {
    const authorized = await this.authority.authorize({
      action: 'resolve',
      scope: input.scope,
      ...(input.credentialScope === undefined
        ? {}
        : { credentialScope: input.credentialScope }),
    })
    if (!authorized) throw new ExecutionJournalAuthorizationError()

    const support = this.resolution
    if (!support || input.credentialScope === undefined) {
      // An authority that admits a resolution with no credential to name it
      // has already failed; refusing here as well keeps the principal
      // unforgeable even if it ever does.
      return { kind: 'not_configured' }
    }
    const credentialScope = input.credentialScope

    const clock = support.clock ?? (() => Date.now())
    let port: CapabilityDispatchResolutionPort | undefined
    try {
      port = await support.ports.resolveResolutionPort({
        scope: input.scope,
        signal: new AbortController().signal,
        deadlineMs: clock() + RESOLUTION_JOURNAL_BUDGET_MS,
      })
    } catch (error) {
      // A barred, closed, or unopenable assignment is reported as itself. It
      // is not "not found": the journal may hold everything and simply be out
      // of reach, and an operator retrying later is the correct response.
      return {
        kind: 'journal_unavailable',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    if (!port) return { kind: 'not_found' }

    return port.recordOperatorResolution({
      dispatchId: input.dispatchId,
      scope: input.scope,
      decision: input.decision,
      principal: support.principal({ credentialScope }),
      reason: input.reason,
      recordedAtMs: clock(),
      ...(input.result === undefined ? {} : { result: input.result }),
    })
  }

  /**
   * Enrolled assignments under this workspace, found without opening them.
   *
   * `limit` bounds the directory walk: the scan is O(sessions x runs x
   * assignments) syscalls, so an unbounded endpoint lets a caller make the
   * event loop walk the whole workspace by polling.
   */
  async listJournals(options: {
    readonly limit?: number
  } = {}): Promise<readonly DiscoveredJournal[]> {
    const discovery = await this.discoverJournals(options)
    return discovery.candidates
      .filter((candidate) => candidate.state === 'enrolled')
      .map(({ scope, journalDirectory }) => ({ scope, journalDirectory }))
  }

  /**
   * Every journal directory under this workspace, with what could be
   * established about each, plus what the walk could not read.
   *
   * Fail-closed: a directory that exists is a candidate whatever its manifest
   * looks like, an unreadable traversal is reported rather than skipped, and
   * hitting the limit is reported rather than silently truncating. A caller
   * deciding whether a workspace is safe to activate needs the difference
   * between "there is nothing here" and "I could not tell".
   */
  async discoverJournals(options: {
    readonly limit?: number
    /** Injected so the bound is testable without seeding ten thousand. */
    readonly conversationRetainedCap?: number
    /** Likewise for the ceiling on session, run and assignment listings. */
    readonly hierarchyScanCeiling?: number
    /** Likewise for the whole walk's activity budget. */
    readonly workspaceActivityBudget?: number
  } = {}): Promise<ExecutionJournalDiscovery> {
    const limit = options.limit ?? DEFAULT_JOURNAL_LIST_LIMIT
    if (!(await this.authority.authorize({ action: 'list' }))) {
      throw new ExecutionJournalAuthorizationError()
    }
    const candidates: DiscoveredJournalCandidate[] = []
    const divergences: DiscoveredJournalDivergence[] = []
    const faults = new WalkFaultLog()
    const unreadablePaths = faults.paths
    let scanOverflowed = false
    let truncated = false
    let conversationsTruncated = false
    const conversationCandidates: DiscoveredConversationJournal[] = []
    // Held separately so an unreadable activity is never dropped by the page
    // bound: it is the one kind activation must always see.
    const indeterminateConversations: DiscoveredConversationJournal[] = []
    const conversationTenants = new Set<string>()
    let conversationCount = 0
    let indeterminateConversationsOverflowed = false
    let conversationTenantsOverflowed = false
    let enrolledConversationCount = 0
    let conversationRetainedCapExceeded = false
    const retainedCap =
      options.conversationRetainedCap ?? CONVERSATION_RETAINED_CAP
    const hierarchyCeiling =
      options.hierarchyScanCeiling ?? DISCOVERY_MAX_HIERARCHY_ENTRIES
    const activityBudget =
      options.workspaceActivityBudget ?? DISCOVERY_MAX_WORKSPACE_ACTIVITIES
    let activitiesExamined = 0

    const sessionsRoot = path.join(this.workspacePath, 'sessions')
    const sessionScan = await readDirectoryNames(sessionsRoot, faults, hierarchyCeiling)
    if (sessionScan.scanOverflowed) scanOverflowed = true
    const createRoot = path.join(this.workspacePath, 'create')
    const createRootScan = await readDirectoryNames(createRoot, faults, hierarchyCeiling)
    if (createRootScan.scanOverflowed) scanOverflowed = true
    const createConversationsRoot = path.join(createRoot, 'conversations')
    const createScan = createRootScan.names.includes('conversations')
      ? await readDirectoryNames(createConversationsRoot, faults, hierarchyCeiling)
      : { names: [], scanOverflowed: false }
    if (createScan.scanOverflowed) scanOverflowed = true
    const owners: ConversationOwner[] = [
      ...createScan.names.map(conversationId => ({ kind: 'create-resource-architect' as const, conversationId })),
      ...sessionScan.names.map(sessionId => ({ kind: 'run-session' as const, sessionId, conversationId: sessionId })),
    ]
    for (const owner of owners) {
      const activitiesRoot = path.join(
        owner.kind === 'run-session' ? sessionsRoot : createConversationsRoot,
        owner.conversationId,
        CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
      )
      // Bounded at the source: a conversation over its cap costs the cap, not
      // its size. Taking one past the bound is what distinguishes "at the
      // limit" from "over it" without enumerating the remainder.
      const activityScan = await readBoundedDirectoryNames(
        activitiesRoot,
        retainedCap,
        faults,
      )
      if (activityScan.overflowed) conversationRetainedCapExceeded = true
      // A listing that stopped reading is not a listing. An activity may exist
      // behind whatever filled the directory, so nothing derived from this walk
      // may present itself as a description of the workspace.
      if (activityScan.scanOverflowed) scanOverflowed = true
      activitiesExamined += activityScan.names.length
      if (activitiesExamined > activityBudget) {
        // Spent. Everything after this point is unexamined, so nothing derived
        // from this walk describes the workspace.
        scanOverflowed = true
        break
      }
      for (const activityId of activityScan.names) {
        const conversationJournalDirectory = path.join(
          activitiesRoot,
          activityId,
          RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
          EXECUTION_JOURNAL_DIRECTORY_NAME,
        )
        const conversationCandidate = await classifyConversationJournalDirectory(
          {
            ...(owner.kind === 'run-session' ? { sessionId: owner.sessionId } : { ownerKind: owner.kind }),
            conversationId: owner.conversationId, activityId,
          },
          conversationJournalDirectory,
        )
        if (conversationCandidate) {
          // Every activity is examined, because activation has to know about
          // all of them: one sealed to a foreign tenant, or one that cannot be
          // read, must block the pin wherever it sits in the walk. Only the
          // returned list is bounded, and its own flag says so.
          //
          // Bounding this the way assignments are bounded was a mistake: it
          // made the 501st retained turn report an incomplete walk, which
          // preflight turns into a blocked verdict and tenant-pin turns into a
          // startup throw. A workspace stopped booting because it had held a
          // normal number of conversations.
          conversationCount += 1
          if (conversationCandidate.tenantId !== undefined) {
            if (
              conversationTenants.size < CONVERSATION_DISCOVERY_MAX_TENANTS ||
              conversationTenants.has(conversationCandidate.tenantId)
            ) {
              conversationTenants.add(conversationCandidate.tenantId)
            } else {
              conversationTenantsOverflowed = true
            }
          }
          if (conversationCandidate.state === 'enrolled') {
            enrolledConversationCount += 1
          }
          // One page across both kinds. Collecting them separately and
          // concatenating meant a caller asking for `limit` could receive twice
          // that. Unreadable activities come first, because they are the ones a
          // reader has to act on.
          const reported =
            indeterminateConversations.length + conversationCandidates.length
          if (conversationCandidate.state === 'indeterminate') {
            if (reported < limit) {
              indeterminateConversations.push(conversationCandidate)
            } else if (conversationCandidates.length > 0) {
              // Displace a healthy entry rather than dropping the damaged one.
              // A page of activities that are all fine, omitting the one that
              // is not, is the least useful page this could return.
              conversationCandidates.pop()
              indeterminateConversations.push(conversationCandidate)
              conversationsTruncated = true
            } else {
              indeterminateConversationsOverflowed = true
            }
          } else if (reported < limit) {
            conversationCandidates.push(conversationCandidate)
          } else {
            conversationsTruncated = true
          }
        }
      }

      if (owner.kind !== 'run-session') continue
      const sessionId = owner.sessionId
      const runsRoot = path.join(sessionsRoot, sessionId, 'runs')
      const runScan = await readDirectoryNames(runsRoot, faults, hierarchyCeiling)
      if (runScan.scanOverflowed) scanOverflowed = true
      for (const runId of runScan.names) {
        const assignmentsRoot = path.join(runsRoot, runId, 'assignments')
        const assignmentScan = await readDirectoryNames(
          assignmentsRoot,
          faults,
          hierarchyCeiling,
        )
        if (assignmentScan.scanOverflowed) scanOverflowed = true
        for (const assignmentId of assignmentScan.names) {
          const scope = { sessionId, runId, assignmentId }
          const divergence = await readWorkflowJournalDivergence(
            path.join(assignmentsRoot, assignmentId),
          )
          if (divergence) divergences.push({ scope, read: divergence })
          const journalDirectory = path.join(
            assignmentsRoot,
            assignmentId,
            RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
            EXECUTION_JOURNAL_DIRECTORY_NAME,
          )
          const candidate = await classifyJournalDirectory(
            scope,
            journalDirectory,
          )
          if (!candidate) continue
          candidates.push(candidate)
          // One past the limit, so "exactly `limit` journals" is reported as a
          // complete description and only a genuinely larger workspace is
          // reported as truncated.
          if (candidates.length > limit) {
            return {
              candidates: candidates.slice(0, limit),
              conversationCandidates: [
                ...indeterminateConversations,
                ...conversationCandidates,
              ],
              conversationsTruncated,
              conversationCount,
              conversationTenantIdsBounded: [...conversationTenants].sort(),
              conversationTenantsOverflowed,
              conversationRetainedCapExceeded,
              enrolledConversationCount,
              indeterminateConversationsOverflowed,
              divergences,
              conversationScanOverflowed: scanOverflowed || faults.truncated,
              truncated: true,
              unreadablePaths,
            }
          }
        }
      }
    }
    return {
      candidates,
      conversationCandidates: [
        ...indeterminateConversations,
        ...conversationCandidates,
      ],
      conversationsTruncated,
      conversationCount,
      conversationTenantIdsBounded: [...conversationTenants].sort(),
      conversationTenantsOverflowed,
      conversationRetainedCapExceeded,
      enrolledConversationCount,
      indeterminateConversationsOverflowed,
      divergences,
      truncated,
      unreadablePaths,
      conversationScanOverflowed: scanOverflowed || faults.truncated,
    }
  }

  /**
   * Report one assignment's unresolved dispatches and projection lag. Each
   * failure mode is reported distinctly rather than collapsed into "missing".
   */
  async inspect(
    scope: CapabilityAssignmentScope,
  ): Promise<ExecutionJournalInspectionReport> {
    if (!(await this.authority.authorize({ action: 'inspect', scope }))) {
      throw new ExecutionJournalAuthorizationError()
    }
    const location = buildSessionRunAssignmentLocation(this.workspacePath, scope)
    if (!location) return { kind: 'not_found' }

    // Path containment alone is textual: a symlinked session directory still
    // resolves inside the workspace by string while pointing outside it.
    // `listJournals` is lstat-based and already skips those, so reading here
    // without canonicalising would make the two disagree.
    const canonical = await canonicalizeWithin(
      this.workspacePath,
      location.assignmentPath,
    )
    if (!canonical) return { kind: 'not_found' }

    const read = await readExecutionJournal(canonical)
    if (read.kind !== 'ok') return read

    // The manifest seals the identity this journal was created for. A journal
    // copied or restored under another assignment would otherwise be reported
    // as that assignment's, which is a plausible but wrong answer.
    const { manifest } = read
    if (
      manifest.scopeId !== scope.assignmentId ||
      (manifest.sessionId !== undefined && manifest.sessionId !== scope.sessionId) ||
      (manifest.runId !== undefined && manifest.runId !== scope.runId) ||
      (manifest.assignmentId !== undefined &&
        manifest.assignmentId !== scope.assignmentId)
    ) {
      return {
        kind: 'identity_mismatch',
        requested: scope,
        sealed: {
          scopeId: manifest.scopeId,
          ...(manifest.sessionId === undefined ? {} : { sessionId: manifest.sessionId }),
          ...(manifest.runId === undefined ? {} : { runId: manifest.runId }),
          ...(manifest.assignmentId === undefined
            ? {}
            : { assignmentId: manifest.assignmentId }),
        },
      }
    }

    const lastSequence = read.events[read.events.length - 1]?.sequence ?? 0
    return {
      kind: 'report',
      scope,
      tenantId: manifest.tenantId,
      eventCount: read.events.length,
      lastSequence,
      unresolved: collectUnresolvedDispatches(read.events, this.clock()),
      agentTurns: summarizeAgentTurnStreams(read.events),
      webEvidenceValidations: summarizeWebEvidenceValidationCohorts(read.events),
      capabilityResults: summarizeCapabilityResultRetention(read.events),
      // The report's own `lastSequence` is journal-wide, which is what an
      // operator means by it. The projection is judged against the dispatch
      // stream's maximum instead: it derives nothing from workflow events,
      // which share this journal and its counter (N31).
      projection: await this.classifyEvidenceProjection(
        canonical,
        lastDispatchSequence(read.events),
      ),
      metrics: await this.readMetrics(scope),
    }
  }

  /**
   * This process's counters for the journal, when it holds it open.
   *
   * A peek, never an open — the counters are per-handle and in-memory, so
   * opening a journal to read them would report the numbers of the open that
   * just happened.
   *
   * A peek that faults is reported as a fault, not as an absent handle: the
   * two are different facts, and an operator told "nobody has it open" would
   * stop looking. It does not fail the whole report either, because the
   * unresolved list is what an operator came for and it does not depend on
   * these numbers.
   */
  private async readMetrics(
    scope: CapabilityAssignmentScope,
  ): Promise<ExecutionJournalReportMetrics> {
    if (!this.journals) return { kind: 'no-open-handle' }
    try {
      const counters = await this.journals.peekMetrics(scope)
      return counters ? { kind: 'live', counters } : { kind: 'no-open-handle' }
    } catch (error) {
      return { kind: 'unavailable', reason: describeErrorCode(error) }
    }
  }

  private async classifyEvidenceProjection(
    assignmentPath: string,
    lastSequence: number,
  ): Promise<ProjectionLagStatus> {
    const store = new JournalProjectionMetadataStore({
      projectionId: CAPABILITY_EVIDENCE_PROJECTION_ID,
      reducerVersion: CAPABILITY_EVIDENCE_REDUCER_VERSION,
      projectionDirectory: path.join(
        assignmentPath,
        RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
        EXECUTION_JOURNAL_DIRECTORY_NAME,
        'projections',
      ),
    })
    try {
      return classifyProjectionLag(
        await store.readMetadata(),
        lastSequence,
        CAPABILITY_EVIDENCE_REDUCER_VERSION,
      )
    } catch {
      return 'rebuild-required'
    }
  }
}

/**
 * A dispatch is unresolved when its stream neither settled nor stayed safely
 * retriable — the states an operator has to act on.
 */
function collectUnresolvedDispatches(
  events: readonly ExecutionJournalEvent[],
  now: number,
): readonly UnresolvedDispatch[] {
  const streams = new Map<string, ExecutionJournalEvent[]>()
  for (const event of events) {
    if (event.streamKind !== DURABLE_DISPATCH_STREAM_KIND) continue
    const existing = streams.get(event.streamId)
    if (existing) existing.push(event)
    else streams.set(event.streamId, [event])
  }

  const unresolved: UnresolvedDispatch[] = []
  for (const [dispatchId, stream] of streams) {
    const reduction = reduceDurableDispatchState(
      stream.map(toStreamEvent).filter(isDurableStreamEvent),
    )
    const state: DurableDispatchState =
      reduction.kind === 'valid' ? reduction.state : 'indeterminate'
    const last = stream[stream.length - 1]
    const recovery = reportableRecovery(resolveDurableRecovery(state).kind, last)
    if (!recovery) continue
    const declared = declaredBy(stream)
    unresolved.push({
      dispatchId,
      state,
      recovery,
      lastSequence: last?.sequence ?? 0,
      unresolvedSince: last?.recordedAt ?? '',
      ageMs: ageSince(last?.recordedAt, now),
      ...(declared === undefined ? {} : { declared }),
    })
  }
  return unresolved
}

/**
 * Which dispatches an operator is asked about, and under which arm.
 *
 * Blocked and reconcilable are the states that cannot proceed on their own. A
 * retriable dispatch is normally nobody's business — a pre-effect crash
 * retries itself and needs no decision — with one exception: an operator
 * authorized the retry and it has not happened yet. That is something a person
 * asked for, so they should be able to see whether it has taken effect, which
 * is what makes the third arm reachable at all.
 */
function reportableRecovery(
  decision: DurableRecoveryDecision['kind'],
  last: ExecutionJournalEvent | undefined,
): UnresolvedDispatch['recovery'] | undefined {
  if (decision === 'blocked' || decision === 'reconcile') return decision
  if (
    decision === 'retriable' &&
    last?.type === DISPATCH_EVENT_TYPES.operatorRetryAuthorized
  ) {
    return 'retriable'
  }
  return undefined
}

/**
 * What the adapter sealed when it prepared this dispatch — the difference
 * between `non_retryable`, `unknown`, and nothing recorded at all, which are
 * three different decisions for whoever has to act.
 *
 * A `prepared` event whose identity fields are unreadable yields nothing
 * rather than a partial declaration: half a description of an effect is not
 * something to decide on.
 */
function declaredBy(
  stream: readonly ExecutionJournalEvent[],
): DeclaredDispatch | undefined {
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const event = stream[index]
    if (!event || event.type !== DISPATCH_EVENT_TYPES.prepared) continue
    const capabilityId = event.payload['capabilityId']
    if (typeof capabilityId !== 'string') return undefined
    return {
      capabilityId,
      // Through the runtime's own effect boundary, both recorded fields at
      // once, so journal text outside the union lands on `unknown` here
      // exactly as it would anywhere else it is read.
      effectKind: normalizeExternalCapabilityEffect({
        kind: event.payload['effectKind'],
        concurrency: event.payload['effectConcurrency'],
      }).kind,
      recoveryPolicy: narrowRecoveryPolicy(event.payload['recoveryPolicy']),
    }
  }
  return undefined
}

/**
 * How long the dispatch has been where it is (ADR §15).
 *
 * Clamped at zero rather than reported negative: `recordedAt` comes from
 * whichever process wrote it, and a clock slightly ahead of this one is not
 * evidence that a dispatch has been waiting for a negative length of time.
 */
function ageSince(recordedAt: string | undefined, now: number): number {
  if (!recordedAt) return 0
  const at = Date.parse(recordedAt)
  return Number.isFinite(at) ? Math.max(0, now - at) : 0
}

/**
 * Resolve a path and confirm the real location is still inside the workspace.
 * Returns undefined when it escapes or does not exist.
 */
async function canonicalizeWithin(
  workspacePath: string,
  candidatePath: string,
): Promise<string | undefined> {
  try {
    const [workspaceReal, candidateReal] = await Promise.all([
      fs.realpath(workspacePath),
      fs.realpath(candidatePath),
    ])
    return isPathInside(workspaceReal, candidateReal) ? candidateReal : undefined
  } catch {
    return undefined
  }
}

/**
 * Directory names under one path, refusing links.
 *
 * Bounded in what it steps over, not in what it finds. A directory can be
 * filled with entries that are not directories, and a scan that filters them
 * before counting still pulls every one of them — so whoever can write into a
 * workspace decides how much startup pays. Past that bound it stops, and says
 * so, because a listing that did not finish is not a description of the
 * directory.
 *
 * A symlink standing in for a session, run, assignment, or activity is not
 * something to walk: its target is controlled by whoever can write the link and
 * may point anywhere. It is also not nothing — whatever it stood in for is now
 * unaccounted for — so it is recorded rather than filtered away.
 */
async function readDirectoryNames(
  directory: string,
  faults: WalkFaultLog,
  rawCeiling: number,
): Promise<{ names: string[]; scanOverflowed: boolean }> {
  const scan = await scanDirectoryNames(directory, faults, { rawCeiling })
  return { names: scan.names, scanOverflowed: scan.scanOverflowed }
}

/**
 * Directory names, keeping at most `limit` of them.
 *
 * `limit` bounds what is kept; the skip bound above bounds what is stepped
 * over. Both are reported, because "I have a full page" and "I stopped reading"
 * lead to different decisions: the first is a page of a described workspace,
 * the second is a workspace nobody has described.
 */
async function readBoundedDirectoryNames(
  directory: string,
  limit: number,
  faults: WalkFaultLog,
): Promise<{ names: string[]; overflowed: boolean; scanOverflowed: boolean }> {
  // The ceiling is derived from the page bound rather than fixed, so it is
  // always above what retention permits. A fixed number here would become a
  // second, lower cap and would reject conversations that are perfectly legal.
  return scanDirectoryNames(directory, faults, {
    keepLimit: limit,
    rawCeiling: limit + CONVERSATION_DISCOVERY_MAX_SKIPPED_ENTRIES,
    // Only what an activity is called counts against the conversation's cap.
    // A workspace is a place people and tools write into, and a `notes` or
    // `.backup` folder beside the activities is not a turn: counting it means
    // a few stray directories make a healthy conversation read as past its
    // limit, which preflight turns into a blocked verdict and a workspace that
    // will not boot.
    keepOnly: isConversationActivityId,
  })
}

async function scanDirectoryNames(
  directory: string,
  faults: WalkFaultLog,
  bounds: {
    readonly keepLimit?: number
    readonly rawCeiling: number
    /** Which directory names are the thing being listed, when that is narrower. */
    readonly keepOnly?: (name: string) => boolean
  },
): Promise<{ names: string[]; overflowed: boolean; scanOverflowed: boolean }> {
  const { keepLimit, rawCeiling, keepOnly } = bounds
  let handle: Awaited<ReturnType<typeof fs.opendir>>
  try {
    handle = await fs.opendir(directory)
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      faults.record(directory, describeErrorCode(error))
    }
    return { names: [], overflowed: false, scanOverflowed: false }
  }

  const names: string[] = []
  let overflowed = false
  let scanOverflowed = false
  let skipped = 0
  let raw = 0
  // `for await` closes the handle on both normal completion and `break`, which
  // is why there is no explicit close: adding one would double-close.
  for await (const entry of handle) {
    raw += 1
    // The ceiling makes the listing finite whatever it holds. The skip bound
    // below is the tighter, earlier stop for the part a caller can grow
    // independently of any contract; this one is the backstop for the rest.
    if (raw > rawCeiling) {
      scanOverflowed = true
      break
    }
    if (entry.isDirectory()) {
      if (keepOnly && !keepOnly(entry.name)) {
        // Stepped over rather than kept, and counted against the bound for
        // what a caller can grow — a directory nobody meant as an activity is
        // filler, but filler somebody can produce a lot of.
        skipped += 1
        if (skipped > CONVERSATION_DISCOVERY_MAX_SKIPPED_ENTRIES) {
          scanOverflowed = true
          break
        }
        continue
      }
      if (keepLimit !== undefined && names.length >= keepLimit) {
        // One entry past the bound is what turns "I have my quota" into "there
        // was more than my quota" without enumerating the remainder.
        overflowed = true
        break
      }
      names.push(entry.name)
      continue
    }
    skipped += 1
    if (skipped > CONVERSATION_DISCOVERY_MAX_SKIPPED_ENTRIES) {
      scanOverflowed = true
      break
    }
    if (entry.isSymbolicLink()) {
      faults.record(path.join(directory, entry.name), 'symbolic link')
      continue
    }
    // A name is a claim. An entry called what an activity is called, holding
    // something that is not one, is a half-written or tampered activity — and
    // stepping over it as filler describes a conversation while leaving one of
    // its activities unaccounted for.
    if (ACTIVITY_SHAPED_NAME.test(entry.name)) {
      faults.record(path.join(directory, entry.name), 'not a directory')
    }
  }
  return { names, overflowed, scanOverflowed }
}

/**
 * Classify one assignment's journal directory, or `undefined` when there is
 * genuinely nothing there.
 *
 * The directory's existence — not the manifest's — is what makes this a
 * candidate. A journal directory holding events but no readable manifest is
 * exactly the state that must never read as "no journal here".
 */
async function classifyJournalDirectory(
  scope: CapabilityAssignmentScope,
  journalDirectory: string,
): Promise<DiscoveredJournalCandidate | undefined> {
  let directoryStat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    directoryStat = await fs.lstat(journalDirectory)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    return {
      scope,
      journalDirectory,
      state: 'indeterminate',
      reason: `the journal directory could not be read (${describeErrorCode(error)})`,
    }
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    return {
      scope,
      journalDirectory,
      state: 'indeterminate',
      reason: 'the journal path is a symbolic link or not a directory',
    }
  }

  const manifestPath = path.join(journalDirectory, MANIFEST_FILENAME)
  let manifestStat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    manifestStat = await fs.lstat(manifestPath)
  } catch (error) {
    return {
      scope,
      journalDirectory,
      state: 'indeterminate',
      reason: hasErrorCode(error, 'ENOENT')
        ? 'the journal directory exists but holds no manifest'
        : `the manifest could not be read (${describeErrorCode(error)})`,
    }
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    return {
      scope,
      journalDirectory,
      state: 'indeterminate',
      reason: 'the manifest is a symbolic link or not a regular file',
    }
  }
  return { scope, journalDirectory, state: 'enrolled' }
}

/** An errno for a diagnostic message; `unknown` when the error carries none. */
function describeErrorCode(error: unknown): string {
  return errorCodeOf(error) ?? 'unknown'
}

/**
 * Classify one conversation activity journal directory.
 *
 * Same rules as the assignment classifier — an existing directory without a
 * readable manifest is durable state nobody has read, not an absent journal —
 * and additionally reports the tenant the manifest is sealed to, which is what
 * activation has to agree about before it pins a workspace.
 */
async function classifyConversationJournalDirectory(
  identity: {
    readonly sessionId?: string
    readonly ownerKind?: ConversationOwner['kind']
    readonly conversationId: string
    readonly activityId: string
  },
  journalDirectory: string,
): Promise<DiscoveredConversationJournal | undefined> {
  const indeterminate = (
    reason: string,
  ): DiscoveredConversationJournal => ({ ...identity, journalDirectory, state: 'indeterminate', reason })

  let directoryStat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    directoryStat = await fs.lstat(journalDirectory)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    return indeterminate(
      `the journal directory could not be read (${describeErrorCode(error)})`,
    )
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    return indeterminate('the journal path is a symbolic link or not a directory')
  }

  const manifestPath = path.join(journalDirectory, MANIFEST_FILENAME)
  let manifestStat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    manifestStat = await fs.lstat(manifestPath)
  } catch (error) {
    return indeterminate(
      hasErrorCode(error, 'ENOENT')
        ? 'the journal directory exists but holds no manifest'
        : `the manifest could not be read (${describeErrorCode(error)})`,
    )
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    return indeterminate('the manifest is a symbolic link or not a regular file')
  }

  // The journal's own validator, not a second weaker one. A manifest this build
  // could not open must not be reported as healthy, and the only way to be sure
  // of that is to judge it by the same rules the journal uses.
  let manifest: ExecutionJournalManifest
  try {
    // Read through the bounded, no-follow primitive rather than by name. The
    // `lstat` above described the path a moment ago; between then and the read
    // it can be replaced, and `readFile` would follow whatever is there now and
    // pull all of it into memory. A manifest is a small fixed document, so the
    // read is what carries the bound.
    const raw = await readPrivateFile(manifestPath, {
      maxBytes: MANIFEST_MAX_BYTES,
    })
    if (raw === undefined) {
      return indeterminate('the journal directory exists but holds no manifest')
    }
    manifest = parseExecutionJournalManifest(JSON.parse(raw) as unknown)
  } catch (error) {
    return indeterminate(
      `the manifest is not valid (${
        error instanceof ExecutionJournalError ? error.code : describeErrorCode(error)
      })`,
    )
  }
  if (manifest.scopeKind !== 'conversation') {
    return indeterminate(
      'the manifest below a conversation activity does not claim the conversation scope',
    )
  }
  // The registry binds every one of these to the activity it belongs to, so a
  // manifest that disagrees on any of them is durable state whose identity does
  // not match where it lives. It cannot be opened, and reporting it as healthy
  // would let a workspace look pinnable on journals nothing can read.
  if (manifest.scopeId !== identity.activityId) {
    return indeterminate(
      'the manifest is bound to a different activity than the one holding it',
    )
  }
  if ((manifest.ownerKind ?? 'run-session') !== (identity.ownerKind ?? 'run-session')) {
    return indeterminate('the manifest names a different conversation owner kind')
  }
  if (manifest.sessionId !== identity.sessionId) {
    return indeterminate('the manifest names a different session')
  }
  if (manifest.conversationId !== identity.conversationId) {
    return indeterminate('the manifest names a different conversation')
  }
  if (manifest.activityKind !== 'turn') {
    return indeterminate(
      'the manifest does not name a turn activity, which is the only kind this build writes',
    )
  }

  // A manifest is a name plate. Stopping here meant an activity with a perfectly
  // good manifest and a journal that is missing, truncated, hash-broken or over
  // its bounds still read as enrolled — and a workspace full of journals nothing
  // can open would pin its tenant and start.
  //
  // Read through the journal's own reader, which is bounded and does not repair
  // what it finds, so startup and the writer agree about what is openable.
  const scopeRootPath = path.dirname(
    path.dirname(journalDirectory),
  )
  const opened = await readExecutionJournal(scopeRootPath)
  if (opened.kind !== 'ok') {
    return indeterminate(
      opened.kind === 'not_found'
        ? 'the manifest names a journal that is not there'
        : `the journal could not be opened (${opened.kind})`,
    )
  }

  return {
    ...identity,
    journalDirectory,
    state: 'enrolled',
    tenantId: manifest.tenantId,
  }
}
