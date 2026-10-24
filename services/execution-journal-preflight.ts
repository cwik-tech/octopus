import type { CapabilityAssignmentScope } from '../contracts/capability-dispatch.js'
import { ExecutionJournalInspectionService } from './execution-journal-inspection.js'
import type { WorkflowJournalDivergenceSite } from './workflow-journal-divergence.js'

/**
 * Activation preflight (AC21): what is already enrolled in a workspace, and is
 * it consistent enough to activate?
 *
 * Read-only by contract. It provisions nothing, opens no journal for writing,
 * and takes no scope lock — it aggregates `ExecutionJournalInspectionService`,
 * which already guarantees those properties, rather than reading manifests
 * again and drifting from its identity checks.
 *
 * It exists because "the flag defaults to off" does not prove "no journal was
 * ever created". The flag is an environment variable, the live cutover test
 * sets it and can retain its workspace, and enrollment is irreversible — so the
 * population has to be measured before a tenant is pinned or a default changes.
 */

export type ExecutionJournalPreflightProblemKind =
  | 'tenant_disagreement'
  | 'environment_tenant_mismatch'
  | 'unsupported_version'
  | 'corrupt'
  | 'identity_mismatch'
  /** Durable state exists here that could not be read. Never treat as absence. */
  | 'indeterminate'
  /** The walk itself was incomplete, so the report describes a prefix. */
  | 'discovery_incomplete'

export interface ExecutionJournalPreflightProblem {
  readonly kind: ExecutionJournalPreflightProblemKind
  readonly detail: string
  readonly scope?: CapabilityAssignmentScope
  /**
   * The conversation activity a problem concerns, when it has no assignment.
   * An operator has to be told which owner to look at, and a conversation
   * cannot be named by an assignment triple.
   */
  readonly conversationScope?: {
    readonly conversationId: string
    readonly sessionId?: string
    readonly ownerKind?: 'run-session' | 'create-resource-architect'
    readonly activityId: string
  }
}

export interface ExecutionJournalPreflightDivergence {
  readonly scope: CapabilityAssignmentScope
  readonly site: WorkflowJournalDivergenceSite | 'unreadable'
  readonly detail: string
  readonly taskId?: string
  readonly recordedAt?: string
}

export interface ExecutionJournalPreflightReport {
  readonly verdict: 'ready' | 'blocked'
  readonly environmentTenantId: string
  /** Every journal directory found, readable or not. */
  readonly journalCount: number
  /** The subset whose manifest was readable and whose identity checked out. */
  readonly enrolledJournalCount: number
  /** Every distinct tenant sealed into a readable journal, sorted. */
  readonly tenantIds: readonly string[]
  readonly problems: readonly ExecutionJournalPreflightProblem[]
  /**
   * Reported, never blocking. An unresolved dispatch is a thing an operator
   * needs to see; it becomes a gate only once there is a way to resolve one.
   */
  readonly unresolvedDispatchCount: number
  /**
   * Assignments where an authoritative cancellation could not reach the
   * journal, so the durable record and the task record disagree.
   *
   * Reported, never blocking, for the same reason as unresolved dispatches:
   * there is no operator path to resolve one yet, and a gate nobody can pass
   * is a gate that gets disabled. Gating belongs with AC11, which is where
   * the report gains the fields needed to decide.
   */
  readonly journalDivergences: readonly ExecutionJournalPreflightDivergence[]
  /** Present only when the workspace is ready; the value AC2 may pin. */
  readonly pinnableTenantId?: string
}

export interface ExecutionJournalPreflightOptions {
  /** Injected so the retained bound is testable. */
  readonly conversationRetainedCap?: number
  readonly workspacePath: string
  readonly environmentTenantId: string
  readonly limit?: number
  /** Likewise for the ceiling on session, run and assignment listings. */
  readonly hierarchyScanCeiling?: number
  /** Likewise for the whole walk's activity budget. */
  readonly workspaceActivityBudget?: number
}

/**
 * The preflight reads; it does not decide who may read. Discovery is already
 * gated by the transport that reaches it, and a preflight run from a script has
 * the operator's own filesystem access. A predicate here that always returned
 * true would read as a check while enforcing nothing.
 */
const PREFLIGHT_READS_WITH_CALLER_AUTHORITY = Object.freeze({
  authorize: async (): Promise<boolean> => true,
})

export async function inspectWorkspaceActivationReadiness(
  options: ExecutionJournalPreflightOptions,
): Promise<ExecutionJournalPreflightReport> {
  const service = new ExecutionJournalInspectionService({
    workspacePath: options.workspacePath,
    authority: PREFLIGHT_READS_WITH_CALLER_AUTHORITY,
  })

  const discovery = await service.discoverJournals({
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.conversationRetainedCap === undefined
      ? {}
      : { conversationRetainedCap: options.conversationRetainedCap }),
    ...(options.hierarchyScanCeiling === undefined
      ? {}
      : { hierarchyScanCeiling: options.hierarchyScanCeiling }),
    ...(options.workspaceActivityBudget === undefined
      ? {}
      : { workspaceActivityBudget: options.workspaceActivityBudget }),
  })

  const problems: ExecutionJournalPreflightProblem[] = []
  const tenants = new Set<string>()
  let unresolvedDispatchCount = 0

  // A walk that could not complete cannot support a verdict about the
  // workspace, whatever the journals it did reach look like.
  if (discovery.truncated) {
    problems.push({
      kind: 'discovery_incomplete',
      detail:
        `Discovery stopped after ${discovery.candidates.length} journals, so ` +
        'this report describes part of the workspace rather than all of it. ' +
        'Raise the limit and re-run before treating the verdict as complete.',
    })
  }
  for (const unreadable of discovery.unreadablePaths) {
    problems.push({
      kind: 'discovery_incomplete',
      detail:
        `${unreadable.path} could not be read (${unreadable.reason}), so any ` +
        'journals beneath it are unaccounted for.',
    })
  }

  // Conversation activities are durable state in the same workspace and sealed
  // to the same tenant, so activation has to account for them. A retained
  // activity that cannot be read, or that claims another tenant, blocks the
  // pin exactly as an assignment journal would; one retention removed is
  // simply not there to find.
  for (const activity of discovery.conversationCandidates) {
    const conversationScope = {
      conversationId: activity.conversationId,
      ...(activity.sessionId === undefined ? {} : { sessionId: activity.sessionId }),
      ...(activity.ownerKind === undefined ? {} : { ownerKind: activity.ownerKind }),
      activityId: activity.activityId,
    }
    if (activity.state === 'indeterminate') {
      problems.push({
        kind: 'indeterminate',
        conversationScope,
        detail:
          `${activity.journalDirectory} holds durable conversation state that ` +
          `could not be read: ${activity.reason ?? 'unknown reason'}. It is ` +
          'not an absent journal, and must be resolved before this workspace ' +
          'is pinned.',
      })
      continue
    }
  }

  // Every tenant the walk saw, not just those on the reported page. Deriving
  // agreement from the page would miss a foreign tenant sitting past it, which
  // is precisely what the pin exists to catch.
  for (const tenantId of discovery.conversationTenantIdsBounded) {
    tenants.add(tenantId)
  }

  // A tenant set that could not be summarised cannot support a decision about
  // which tenant this workspace belongs to.
  // A conversation outside its retention bounds means the walk stopped early,
  // so nothing here describes the whole workspace.
  if (discovery.conversationRetainedCapExceeded) {
    problems.push({
      kind: 'discovery_incomplete',
      detail:
        'A conversation holds more activities than retention permits, so the ' +
        'walk stopped there and this report does not describe the whole ' +
        'workspace. Let retention run, or remove the conversation, and re-run.',
    })
  }

  if (discovery.conversationScanOverflowed) {
    problems.push({
      kind: 'discovery_incomplete',
      detail:
        'A conversation directory held more entries than this walk will read, ' +
        'so an activity may exist that it never saw and the workspace has not ' +
        'been described. Remove whatever is filling the directory and re-run.',
    })
  }

  if (discovery.conversationTenantsOverflowed) {
    problems.push({
      kind: 'discovery_incomplete',
      detail:
        'More distinct tenants were found among conversation activities than ' +
        'this report can summarise, so the workspace cannot be described as ' +
        'belonging to one tenant. Resolve the mixed tenants and re-run.',
    })
  }

  // A walk that could not list all of its unreadable activities cannot support
  // a verdict about the workspace, the same way an incomplete assignment walk
  // cannot.
  if (discovery.indeterminateConversationsOverflowed) {
    problems.push({
      kind: 'discovery_incomplete',
      detail:
        'More conversation activities are unreadable than this report can ' +
        'list, so the workspace cannot be described completely. Resolve the ' +
        'reported ones and re-run before treating the verdict as complete.',
    })
  }

  for (const journal of discovery.candidates) {
    if (journal.state === 'indeterminate') {
      problems.push({
        kind: 'indeterminate',
        scope: journal.scope,
        detail:
          `${journal.journalDirectory} holds durable state that could not be ` +
          `read: ${journal.reason ?? 'unknown reason'}. It is not an absent ` +
          'journal, and must be resolved before this workspace is pinned.',
      })
      continue
    }
    const report = await service.inspect(journal.scope)
    switch (report.kind) {
      case 'report':
        tenants.add(report.tenantId)
        unresolvedDispatchCount += report.unresolved.length
        break
      case 'unsupported_version':
        problems.push({
          kind: 'unsupported_version',
          scope: journal.scope,
          detail:
            `The journal at ${journal.journalDirectory} was written by a build ` +
            'this one cannot read. There is no migration path, so it must be ' +
            'resolved deliberately before activation.',
        })
        break
      case 'corrupt':
        problems.push({
          kind: 'corrupt',
          scope: journal.scope,
          detail: `The journal at ${journal.journalDirectory} is corrupt (${report.reason}).`,
        })
        break
      case 'identity_mismatch':
        problems.push({
          kind: 'identity_mismatch',
          scope: journal.scope,
          detail:
            `The journal at ${journal.journalDirectory} was sealed for scope ` +
            `'${report.sealed.scopeId}' but sits under assignment ` +
            `'${journal.scope.assignmentId}'.`,
        })
        break
      case 'not_found':
        // Discovery saw a manifest that `inspect` could not then read: either a
        // scan race, or a manifest naming a journal that is not there. Either
        // way this workspace holds something unread, which is the one thing a
        // pin must not be granted over.
        problems.push({
          kind: 'indeterminate',
          scope: journal.scope,
          detail:
            `${journal.journalDirectory} was discovered but could not then be ` +
            'inspected. Re-run the preflight; if it persists, the manifest ' +
            'names a journal that is missing.',
        })
        break
    }
  }

  const tenantIds = [...tenants].sort()
  // The whole walk, not the page an operator was shown.
  const enrolledConversationCount = discovery.enrolledConversationCount
  const enrolledCount = discovery.candidates.filter(
    (candidate) => candidate.state === 'enrolled',
  ).length

  if (tenantIds.length > 1) {
    problems.push({
      kind: 'tenant_disagreement',
      detail:
        `This workspace holds journals sealed for ${tenantIds.length} different ` +
        `tenants: ${tenantIds.map((tenant) => `'${tenant}'`).join(', ')}. ` +
        `No single pin can be correct while they disagree (the environment ` +
        `value is '${options.environmentTenantId}').`,
    })
  } else if (
    tenantIds.length === 1 &&
    tenantIds[0] !== options.environmentTenantId
  ) {
    problems.push({
      kind: 'environment_tenant_mismatch',
      detail:
        `Every journal in this workspace is sealed for tenant ` +
        `'${tenantIds[0]}', but TEAM_TENANT_ID resolves to ` +
        `'${options.environmentTenantId}'. Pinning the environment value would ` +
        'fail every enrolled assignment closed with a manifest conflict.',
    })
  }

  const verdict = problems.length === 0 ? 'ready' : 'blocked'
  const pinnableTenantId =
    verdict === 'ready'
      ? (tenantIds[0] ?? options.environmentTenantId)
      : undefined

  const journalDivergences: ExecutionJournalPreflightDivergence[] =
    discovery.divergences.map(({ scope, read }) =>
      read.kind === 'recorded'
        ? {
            scope,
            site: read.record.site,
            detail: read.record.detail,
            taskId: read.record.taskId,
            recordedAt: read.record.recordedAt,
          }
        : { scope, site: 'unreadable', detail: read.detail },
    )

  return {
    verdict,
    environmentTenantId: options.environmentTenantId,
    journalCount: discovery.candidates.length + discovery.conversationCount,
    enrolledJournalCount: enrolledCount + enrolledConversationCount,
    tenantIds,
    problems,
    unresolvedDispatchCount,
    journalDivergences,
    ...(pinnableTenantId === undefined ? {} : { pinnableTenantId }),
  }
}
