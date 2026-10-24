/**
 * One journal per conversation activity, resolved from a trusted owner.
 *
 * This deliberately does not reuse `WorkspaceExecutionJournalRegistry`. That
 * class is assignment-shaped end to end — its cache key joins session, run and
 * assignment, its root comes from `buildSessionRunAssignmentLocation`, and its
 * errors name an assignment. Reusing it would mean minting a synthetic
 * assignment for chat that has none, which is precisely the design the plan
 * rejects.
 *
 * What is copied is the lease *semantics*, because they were paid for. A count
 * rather than a flag, since a turn recorder, a crash reconciliation and an
 * operator read can hold the same activity at once. And a close barrier that a
 * later acquisition must join before reopening from disk, because without it an
 * activity could briefly hold two journals — the split authority that one
 * journal per scope exists to prevent. A failed close stays as a rejected
 * barrier: reopening is unsafe when the registry cannot prove the previous
 * handle is gone.
 */
import * as fs from 'node:fs/promises'
import { join as joinPath } from 'node:path'

import {
  ExecutionJournalError,
  type ExecutionJournalEvent,
  type ExecutionJournalManifest,
  type ExecutionJournalScopeIdentity,
} from '../contracts/execution-journal.js'
import {
  buildConversationActivityLocation,
  type ConversationOwner,
} from '../core/conversation-activity-location.js'
import { ensureSafeWorkspaceDirectory } from './safe-workspace-directory.js'
import {
  initializeExecutionJournal,
  readExecutionJournal,
  type ExecutionJournal,
} from '../core/execution-journal.js'

export type { ConversationOwner }

/** What one activity journal records. Later phases widen this. */
export type ConversationActivityKind = 'turn'

export interface ConversationActivityScope {
  readonly owner: ConversationOwner
  readonly activityId: string
  readonly activityKind: ConversationActivityKind
}

export interface ConversationJournalLease {
  readonly journal: ExecutionJournal
  /** Releases this holder's claim; the last one out closes the handle. */
  release(): Promise<void>
}

export class ConversationJournalUnavailableError extends Error {
  readonly activityId: string

  constructor(activityId: string, options?: { readonly cause?: unknown }) {
    super(
      `Conversation activity journal ${activityId} is enrolled but unavailable.`,
      options,
    )
    this.activityId = activityId
    this.name = 'ConversationJournalUnavailableError'
  }
}

export type ConversationJournalMode = 'authoritative' | 'disabled'

/**
 * One activity as a reader sees it: what is there, and nothing changed.
 *
 * `unreadable` covers every way an activity can exist without being openable —
 * a missing or torn journal, a manifest that is not one, a link where a file
 * belongs. They are one answer here because they call for one response: leave
 * it alone and say so.
 */
export type ConversationActivitySnapshot =
  | {
      readonly kind: 'read'
      readonly manifest: ExecutionJournalManifest
      readonly events: readonly ExecutionJournalEvent[]
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }

/** What became of a requested removal. */
export type ConversationActivityDeletion = 'deleted' | 'busy' | 'absent'

/**
 * Whether this activity already has a journal.
 *
 * Three answers, not two. `indeterminate` is on-disk evidence that an activity
 * exists without a journal this build can open, and it is the reason this is
 * not a boolean: reading it as `absent` would let a turn run with no authority
 * over an activity that demonstrably has one.
 */
export type ConversationActivityEnrollment =
  | 'absent'
  | 'enrolled'
  | 'indeterminate'

export interface WorkspaceConversationJournalRegistryOptions {
  readonly workspacePath: string
  readonly tenantId: string
  readonly mode: ConversationJournalMode
  readonly clock?: () => number
  readonly journalOpener?: typeof initializeExecutionJournal
  /**
   * How a path is examined when deciding whether an activity is enrolled.
   *
   * Injected so the unreadable case can be exercised deterministically. Whether
   * a permission bit actually denies access depends on who the process runs as,
   * and a check that quietly stops checking under a different user is worse
   * than no check at all. Defaults to `lstat`, which is what production uses.
   */
  readonly inspectPath?: (target: string) => Promise<PathEvidence>
  /**
   * How an activity's directory tree is removed.
   *
   * Injected for the same reason as `inspectPath`: a removal that fails is a
   * real and important case — retention then knows less than it thinks — and
   * the only way to cause one on a real filesystem is a permission bit, which
   * does not deny anything to every user. Defaults to a recursive remove,
   * which is what production uses.
   */
  readonly removeActivityTree?: (activityPath: string) => Promise<void>
}

/** What `lstat` says about a path, minus everything this does not need. */
export interface PathEvidence {
  isDirectory(): boolean
  isFile(): boolean
}

type OpenHandle = ExecutionJournal

export class WorkspaceConversationJournalRegistry {
  private readonly workspacePath: string
  private readonly tenantId: string
  private readonly mode: ConversationJournalMode
  private readonly journalOpener: typeof initializeExecutionJournal
  private readonly inspectPath: (target: string) => Promise<PathEvidence>
  private readonly removeActivityTree: (activityPath: string) => Promise<void>
  private readonly open = new Map<string, Promise<OpenHandle>>()
  private readonly leases = new Map<string, number>()
  private readonly leaseClosures = new Map<string, Promise<void>>()
  /**
   * Removals in flight, by activity key.
   *
   * Published before the removal starts and joined by every acquisition, so an
   * activity is never opened against a directory that is on its way out.
   */
  private readonly deletions = new Map<string, Promise<void>>()
  private closed = false

  /**
   * Whether this build enrols new activities.
   *
   * Exposed because callers have work to do — housekeeping, admission — that
   * writes to a conversation's sidecars, and a build with journalling off must
   * not do any of it.
   */
  get journalMode(): ConversationJournalMode {
    return this.mode
  }

  constructor(options: WorkspaceConversationJournalRegistryOptions) {
    this.workspacePath = options.workspacePath
    this.tenantId = options.tenantId
    this.mode = options.mode
    this.journalOpener = options.journalOpener ?? initializeExecutionJournal
    // `lstat`, not `stat`: a link standing in for an activity or its manifest
    // must be seen as a link rather than resolved into whatever it points at.
    this.inspectPath = options.inspectPath ?? ((target) => fs.lstat(target))
    this.removeActivityTree =
      options.removeActivityTree ??
      ((activityPath) => fs.rm(activityPath, { recursive: true, force: true }))
  }

  /**
   * Borrow this activity's journal.
   *
   * `undefined` means conversation journaling is switched off, and the caller
   * proceeds without a durability barrier. A throw means the activity is
   * enrolled but unreachable, which must fail the turn closed rather than
   * publish without evidence.
   */
  async acquire(
    scope: ConversationActivityScope,
  ): Promise<ConversationJournalLease | undefined> {
    // The flag decides whether new activities are enrolled. It cannot decide
    // that an activity which already has a journal no longer has one: that
    // journal is the record a replay is classified against, and running the
    // turn without it would append nothing, prove nothing, and diverge from
    // what is already on disk.
    if (this.mode === 'disabled' && scope.owner.kind === 'run-session') {
      const enrollment = await this.classifyActivityEnrollment(scope)
      if (enrollment === 'absent') return undefined
      if (enrollment === 'indeterminate') {
        throw new ConversationJournalUnavailableError(scope.activityId)
      }
    }
    if (this.closed) {
      throw new ConversationJournalUnavailableError(scope.activityId)
    }

    const key = activityKey(scope)

    // A removal in flight owns this activity outright. Waiting for it and then
    // re-deriving from disk is what stops an acquisition from opening a journal
    // whose files are about to be unlinked underneath it. Whether the removal
    // succeeded does not change the answer: either way the truth is on disk
    // afterwards, not in the handle this call would otherwise have opened.
    const deleting = this.deletions.get(key)
    if (deleting) {
      await deleting.catch(() => undefined)
      return this.acquire(scope)
    }

    // A close in flight owns this activity until its handle is really gone.
    // Joining it, then reopening from disk, is what keeps two handles from
    // briefly existing for one activity.
    const closing = this.leaseClosures.get(key)
    if (closing) {
      try {
        await closing
      } catch (cause) {
        throw new ConversationJournalUnavailableError(scope.activityId, { cause })
      }
      return this.acquire(scope)
    }

    let opening = this.open.get(key)
    if (!opening) {
      opening = this.openActivity(scope)
      this.open.set(key, opening)
    }

    let handle: OpenHandle
    try {
      handle = await opening
    } catch (cause) {
      // A failed open is not cached: the next caller re-derives it from disk
      // rather than inheriting a rejection forever.
      if (this.open.get(key) === opening) this.open.delete(key)
      throw new ConversationJournalUnavailableError(scope.activityId, { cause })
    }

    this.leases.set(key, (this.leases.get(key) ?? 0) + 1)
    let releasedOnce = false
    return {
      journal: handle,
      release: async () => {
        if (releasedOnce) return
        releasedOnce = true
        await this.releaseLease(key)
      },
    }
  }

  /**
   * Read one activity without touching it.
   *
   * `acquire` opens a journal the way a writer does: it creates a missing
   * `journal.jsonl` and truncates a torn tail back to its last acknowledged
   * record. That is correct for the turn that owns the activity and wrong for
   * everyone else — an operator asking what happened, or a later turn deciding
   * whether a slot may go back, repaired the damage they were looking at, and
   * the evidence went with the repair.
   *
   * So a reader gets a snapshot instead: the manifest and the events, read
   * through the journal's own bounded reader, which writes nothing.
   */
  async snapshot(
    scope: ConversationActivityScope,
  ): Promise<ConversationActivitySnapshot> {
    const enrollment = await this.classifyActivityEnrollment(scope)
    if (enrollment === 'absent') return { kind: 'absent' }
    if (enrollment === 'indeterminate') return { kind: 'unreadable' }

    const location = buildConversationActivityLocation(this.workspacePath, {
      owner: scope.owner,
      activityId: scope.activityId,
    })
    if (!location) return { kind: 'absent' }
    let outcome
    try {
      outcome = await readExecutionJournal(location.activityPath)
    } catch {
      return { kind: 'unreadable' }
    }
    if (outcome.kind !== 'ok') return { kind: 'unreadable' }
    // A file that ends mid-record is not this activity's whole history. A
    // writer would truncate the fragment and carry on; a reader must not, and
    // must not present the surviving prefix as though it were everything.
    if (outcome.truncatedTail) return { kind: 'unreadable' }
    return {
      kind: 'read',
      manifest: outcome.manifest,
      events: outcome.events,
    }
  }


  /**
   * What is on disk for this activity, without provisioning anything.
   *
   * Every caller that has to decide whether an activity is already enrolled —
   * a reader, a disabled build, the turn resolver deciding whether to run any
   * housekeeping at all — asks the same question, so it is answered in one
   * place and cannot drift between them.
   */
  async classifyActivityEnrollment(
    scope: ConversationActivityScope,
  ): Promise<ConversationActivityEnrollment> {
    const location = buildConversationActivityLocation(this.workspacePath, {
      owner: scope.owner,
      activityId: scope.activityId,
    })
    // An identity that cannot name a safe location names no journal.
    if (!location) return 'absent'

    // Only one thing means "nothing here": the activity root is not there at
    // all. Everything else — a stat that failed, a link or a file where a
    // directory belongs — is evidence that something exists which this build
    // cannot account for, and calling that absence is how a damaged activity
    // becomes a turn that runs with no authority over a record it already has.
    const activity = await this.examine(location.activityPath)
    if (activity === 'missing') return 'absent'
    if (activity === 'unreadable') return 'indeterminate'
    if (!activity.isDirectory()) return 'indeterminate'

    // Under an activity that does exist, a manifest that is missing, is not a
    // regular file, or cannot be examined all mean the same thing: there is
    // something here and it is not a journal this build can continue.
    const manifest = await this.examine(
      joinPath(
        location.activityPath,
        '.runtime',
        'execution-journal',
        'manifest.json',
      ),
    )
    if (manifest === 'missing' || manifest === 'unreadable') return 'indeterminate'
    return manifest.isFile() ? 'enrolled' : 'indeterminate'
  }

  /**
   * `lstat` for one path, with the two failures that mean different things kept
   * apart: gone, and could-not-tell.
   */
  private async examine(
    target: string,
  ): Promise<PathEvidence | 'missing' | 'unreadable'> {
    try {
      return await this.inspectPath(target)
    } catch (error) {
      return errorCodeOf(error) === 'ENOENT' ? 'missing' : 'unreadable'
    }
  }

  /**
   * Forget one activity, whole.
   *
   * Retention deletes directories, and a directory is only safe to delete when
   * nothing is using it. Doing that from outside the registry meant reading an
   * activity through a lease, letting go, and removing the tree — with a window
   * in between where any caller could acquire the same activity and be handed a
   * journal that was about to lose its files. So the decision to delete lives
   * with the only thing that knows who is holding what.
   *
   * `busy` is not a failure. It means some holder exists — a counted lease, an
   * open still resolving, or a close that could not prove its handle is gone —
   * and housekeeping simply comes back later.
   */
  async deleteActivity(
    scope: ConversationActivityScope,
  ): Promise<ConversationActivityDeletion> {
    const location = buildConversationActivityLocation(this.workspacePath, {
      owner: scope.owner,
      activityId: scope.activityId,
    })
    // An identity that cannot name a safe location names no activity, so there
    // is nothing here to forget.
    if (!location) return 'absent'

    const key = activityKey(scope)
    if ((this.leases.get(key) ?? 0) > 0) return 'busy'
    // An open that has not resolved yet counts no lease, and is exactly the
    // window this exists to close.
    if (this.open.has(key)) return 'busy'
    // A close left behind is a close that failed. It cannot prove its handle is
    // gone, so neither can this.
    if (this.leaseClosures.has(key)) return 'busy'
    if (this.deletions.has(key)) return 'busy'

    // Published synchronously, before the first await, and everything else
    // happens behind it. An acquisition issued in the same tick has to be able
    // to see it — otherwise it opens the activity, creates the directories it
    // needs, and the removal below walks a tree that is being rebuilt under it.
    let settle: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => {
      settle = resolve
    })
    this.deletions.set(key, barrier)
    try {
      // Same rule as enrolment: only a path that is genuinely not there is
      // absent. Retention advances past whatever this reports as gone, so an
      // activity nobody could examine being called `absent` would move the
      // record past it — leaving it on disk with nothing referring to it.
      const evidence = await this.examine(location.activityPath)
      if (evidence === 'missing') return 'absent'
      if (evidence === 'unreadable') return 'busy'
      // An activity is a directory. A file or a link standing where one belongs
      // is tampered or half-written state, and removing it while reporting a
      // deletion lets retention forget the entry too — so what was there
      // disappears along with the record that it ever was.
      if (!evidence.isDirectory()) return 'busy'

      await this.removeActivityTree(location.activityPath)
      return 'deleted'
    } finally {
      this.deletions.delete(key)
      settle()
    }
  }

  /** Close every open activity. Used at process shutdown. */
  async close(): Promise<void> {
    this.closed = true
    const closings = [...this.leaseClosures.values()]
    await Promise.allSettled([...closings, ...this.deletions.values()])
    const opens = [...this.open.entries()]
    this.open.clear()
    this.leases.clear()
    for (const [, opening] of opens) {
      const handle = await opening.then(
        (value) => value,
        () => undefined,
      )
      await handle?.close().catch(() => undefined)
    }
  }

  private async releaseLease(key: string): Promise<void> {
    const remaining = (this.leases.get(key) ?? 1) - 1
    if (remaining > 0) {
      this.leases.set(key, remaining)
      return
    }
    this.leases.delete(key)

    const opening = this.open.get(key)
    this.open.delete(key)
    if (!opening) return

    // The barrier is published before the close begins, so an acquisition that
    // arrives mid-close finds it and waits instead of opening a second handle.
    const closing = (async () => {
      const handle = await opening.then(
        (value) => value,
        () => undefined,
      )
      await handle?.close()
    })()
    this.leaseClosures.set(key, closing)
    try {
      await closing
      this.leaseClosures.delete(key)
    } catch (error) {
      // Left in place on purpose. A close that failed cannot prove the old
      // handle is gone, so every later acquisition must keep failing closed
      // rather than reopen over it.
      throw error
    }
  }

  private async openActivity(
    scope: ConversationActivityScope,
  ): Promise<OpenHandle> {
    const location = buildConversationActivityLocation(this.workspacePath, {
      owner: scope.owner,
      activityId: scope.activityId,
    })
    if (!location) {
      throw new ExecutionJournalError(
        'scope_invalid',
        'Conversation activity identity is not a safe workspace location.',
      )
    }
    // The activity directory is this registry's to create — an assignment
    // journal can assume its root exists because the run machinery made it, and
    // a conversation activity has no such owner. Delegated to the shared
    // primitive so the registry and the admission index cannot drift apart on
    // what counts as a safe path.
    await ensureSafeWorkspaceDirectory({
      workspacePath: this.workspacePath,
      segments: relativeSegments(location.relativeActivityPath),
      // `sessions` and the session id are the owner's, not this activity's. A
      // turn that arrives just after its session was deleted must fail rather
      // than rebuild the session directory on its way to journalling itself.
      requireExisting: scope.owner.kind === 'run-session' ? 2 : 0,
    })

    const identity: ExecutionJournalScopeIdentity = {
      scopeKind: 'conversation',
      scopeId: scope.activityId,
      tenantId: this.tenantId,
      ...(scope.owner.kind === 'run-session'
        ? { sessionId: scope.owner.sessionId }
        : { ownerKind: scope.owner.kind }),
      conversationId: location.conversationId,
      activityKind: scope.activityKind,
    }
    return this.journalOpener({ scopeRoot: location.activityPath, identity })
  }
}

function activityKey(scope: ConversationActivityScope): string {
  // `/` cannot appear in a validated path segment, so it cannot be smuggled in
  // to make two different activities collide on one key.
  return `${scope.owner.kind}/${scope.owner.conversationId}/${scope.activityId}`
}

/** Path segments of a workspace-relative path, in order. */
function relativeSegments(relativePath: string): string[] {
  return relativePath.split('/').filter((segment) => segment.length > 0)
}

/** An errno, without asserting a shape onto an unknown error. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
