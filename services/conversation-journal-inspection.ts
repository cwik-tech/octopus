/**
 * Operator inspection for one conversation's activity journals.
 *
 * Derived from the validated journals on every read and content-free by
 * construction: the summaries it returns come from `conversation.turn`
 * payloads, which hold identities, outcomes and counts and never prose. The
 * transcript is a separate, separately authorized resource.
 *
 * Reading never provisions. An activity that retention removed, or that never
 * existed, reads as absent rather than springing back into being because an
 * operator looked at it.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { readResourceArchitectJournalActivity, type ResourceArchitectJournalRead } from './resource-architect-journal-recorder.js'

import {
  CONVERSATION_TURN_STREAM_KIND,
  reduceConversationTurnStream,
  type ConversationTurnSummary,
} from '../domains/conversations/conversation-turn-journal.js'
import {
  CONVERSATION_RETAINED_CAP,
  ExecutionJournalAuthorizationError,
  type ExecutionJournalInspectionAuthority,
} from './execution-journal-inspection.js'

/**
 * How many entries that are not activities one inspection listing steps over.
 *
 * Separate from the page bound on purpose: the page bounds what is kept, this
 * bounds what is read, and only the second is decided by whoever can write into
 * the directory.
 */
const CONVERSATION_INSPECTION_MAX_SKIPPED_ENTRIES = 1_024
import {
  buildConversationActivitiesRoot,
  buildCreateConversationActivitiesRoot,
  isConversationActivityId,
} from '../core/conversation-activity-location.js'
import type { RouteCredentialScope } from '../contracts/route-credentials.js'
import type {
  ConversationJournalMode,
  WorkspaceConversationJournalRegistry,
} from './workspace-conversation-journal-registry.js'

/** Bounded like every other inspection surface; an operator gets a page. */
const DEFAULT_LIMIT = 100
export const CONVERSATION_INSPECTION_MAX_LIMIT = 500

export type ConversationJournalIntegrity = 'ok' | 'unreadable'

export interface ConversationTurnReport extends ConversationTurnSummary {
  readonly activityId: string
  readonly integrity: ConversationJournalIntegrity
  readonly eventCount: number
}

export interface ConversationJournalReport {
  readonly ownerKind: 'run-session'
  readonly conversationId: string
  readonly sessionId: string
  /**
   * Whether this build records conversation lifecycles at all.
   *
   * Carried on every report because "this conversation recorded nothing" and
   * "nothing was being recorded" are different facts that look identical in a
   * report holding only turns. The first is a conversation an operator can
   * stop investigating; the second is one whose evidence was never collected.
   *
   * It says what this build does with *new* activities and nothing else. An
   * activity that already has a journal keeps it, and its turns are reported
   * exactly as they are — the flag never hides authority that already exists.
   */
  readonly journalMode: ConversationJournalMode
  readonly activityCount: number
  readonly turns: readonly ConversationTurnReport[]
  /** Activities present on disk but beyond this page. */
  readonly truncated: boolean
  /**
   * Where the next page starts, when there is one.
   *
   * Without this a report could only ever show the first page, and every later
   * turn in a long conversation would be permanently unreachable. The cursor is
   * the last activity id on this page, and ids are listed in a stable order.
   */
  readonly nextCursor?: string
}

export type ConversationInspectionOutcome =
  | { readonly kind: 'report'; readonly report: ConversationJournalReport }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable' }

export type CreateConversationInspectionOutcome =
  | { readonly kind: 'report'; readonly report: {
      readonly ownerKind: 'create-resource-architect';
      readonly conversationId: string;
      readonly journalMode: 'authoritative';
      readonly activityCount: number;
      readonly activities: readonly (ResourceArchitectJournalRead & { readonly activityId: string })[];
      readonly truncated: boolean;
      readonly nextCursor?: string;
    } }
  | { readonly kind: 'not_found' | 'unavailable' };

export class ConversationJournalInspectionService {
  constructor(
    private readonly options: {
      readonly workspacePath: string
      readonly registry?: WorkspaceConversationJournalRegistry
      /**
       * Required, not optional. A surface that reads conversation lifecycle
       * without a policy is one that was never given one, and defaulting to
       * "allowed" would make that indistinguishable from a decision.
       */
      readonly authority: ExecutionJournalInspectionAuthority
    },
  ) {}

  async inspectCreateConversation(input: {
    readonly conversationId: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly credentialScope?: RouteCredentialScope;
  }): Promise<CreateConversationInspectionOutcome> {
    const permitted = await this.options.authority.authorize({
      action: 'inspect',
      conversationScope: { ownerKind: 'create-resource-architect', conversationId: input.conversationId },
      ...(input.credentialScope === undefined ? {} : { credentialScope: input.credentialScope }),
    });
    if (!permitted) throw new ExecutionJournalAuthorizationError();
    const registry = this.options.registry;
    if (!registry) return { kind: 'unavailable' };
    const root = buildCreateConversationActivitiesRoot(this.options.workspacePath, input.conversationId);
    if (!root) return { kind: 'not_found' };
    // Check each owner segment before following the activity path.
    let ancestor = this.options.workspacePath;
    for (const segment of ['create', 'conversations', input.conversationId]) {
      ancestor = path.join(ancestor, segment);
      try {
        if (!(await fs.lstat(ancestor)).isDirectory()) return { kind: 'unavailable' };
      } catch (error) {
        return { kind: errorCodeOf(error) === 'ENOENT' ? 'not_found' : 'unavailable' };
      }
    }
    const listing = await listActivityIds(root, CONVERSATION_RETAINED_CAP);
    if (listing.overflowed) return { kind: 'unavailable' };
    const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), CONVERSATION_INSPECTION_MAX_LIMIT);
    const start = input.cursor === undefined ? 0 : listing.names.indexOf(input.cursor) + 1 || listing.names.length;
    const remaining = listing.names.slice(start);
    const page = remaining.slice(0, limit);
    const activities: (ResourceArchitectJournalRead & { activityId: string })[] = [];
    for (const activityId of page) {
      const read = await readResourceArchitectJournalActivity({ registry, conversationId: input.conversationId, activityId });
      activities.push({ ...read, activityId });
    }
    return { kind: 'report', report: {
      ownerKind: 'create-resource-architect', conversationId: input.conversationId,
      journalMode: 'authoritative', activityCount: listing.names.length, activities,
      truncated: remaining.length > page.length,
      ...whenLast(remaining.length > page.length ? page.at(-1) : undefined, nextCursor => ({ nextCursor })),
    } };
  }

  async inspectRunSession(input: {
    readonly sessionId: string
    readonly limit?: number
    /** Resume after this activity id; from a previous report's `nextCursor`. */
    readonly cursor?: string
    /** Injected so the bound is testable without seeding ten thousand. */
    readonly retainedCap?: number
    /** Which credential the transport admitted for this request, if any. */
    readonly credentialScope?: RouteCredentialScope
  }): Promise<ConversationInspectionOutcome> {
    // Before the workspace is consulted at all. A refusal that arrives after
    // the session directory has been probed answers a question it was supposed
    // to withhold: a refused caller would learn which conversations exist by
    // watching `not_found` turn into `403`.
    const permitted = await this.options.authority.authorize({
      action: 'inspect',
      conversationScope: {
        ownerKind: 'run-session',
        conversationId: input.sessionId,
      },
      ...(input.credentialScope === undefined
        ? {}
        : { credentialScope: input.credentialScope }),
    })
    if (!permitted) throw new ExecutionJournalAuthorizationError()

    const registry = this.options.registry
    if (!registry) return { kind: 'unavailable' }

    const root = buildConversationActivitiesRoot(
      this.options.workspacePath,
      input.sessionId,
    )
    if (!root) return { kind: 'not_found' }
    // A session with no activities is a real, empty report rather than a 404:
    // "this conversation has published nothing" is a different fact from "no
    // such conversation", and only the session store can tell the difference.
    const sessionRoot = path.join(
      this.options.workspacePath,
      'sessions',
      input.sessionId,
    )
    // `lstat`, not "does this path exist?". Existence follows a link, so a link
    // standing in for a session answers yes and the report then describes a
    // conversation the caller did not ask about.
    let sessionStat
    try {
      sessionStat = await fs.lstat(sessionRoot)
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') return { kind: 'not_found' }
      return { kind: 'unavailable' }
    }
    if (!sessionStat.isDirectory()) return { kind: 'unavailable' }

    const limit = Math.min(
      Math.max(1, input.limit ?? DEFAULT_LIMIT),
      CONVERSATION_INSPECTION_MAX_LIMIT,
    )
    const retainedCap = Math.max(1, input.retainedCap ?? CONVERSATION_RETAINED_CAP)
    const listing = await listActivityIds(root, retainedCap)
    if (listing.overflowed) {
      // A conversation holding more than admission can create has not been
      // described by anything, and a page of it would read as if it had. The
      // honest answer is that this report cannot be produced.
      return { kind: 'unavailable' }
    }
    const allActivityIds = listing.names
    // A cursor names the last id already seen, so the next page starts after
    // it. An unknown cursor yields an empty page rather than silently restarting
    // from the beginning, which would loop a paging reader forever.
    const startIndex =
      input.cursor === undefined
        ? 0
        : allActivityIds.indexOf(input.cursor) + 1 || allActivityIds.length
    const activityIds = allActivityIds.slice(startIndex)
    const page = activityIds.slice(0, limit)

    const turns: ConversationTurnReport[] = []
    for (const activityId of page) {
      turns.push(
        await this.readActivity({
          sessionId: input.sessionId,
          activityId,
          registry,
        }),
      )
    }

    return {
      kind: 'report',
      report: {
        ownerKind: 'run-session',
        conversationId: input.sessionId,
        sessionId: input.sessionId,
        journalMode: registry.journalMode,
        activityCount: allActivityIds.length,
        turns,
        truncated: activityIds.length > page.length,
        ...whenLast(
          activityIds.length > page.length ? page[page.length - 1] : undefined,
          (nextCursor) => ({ nextCursor }),
        ),
      },
    }
  }

  private async readActivity(input: {
    readonly sessionId: string
    readonly activityId: string
    readonly registry: WorkspaceConversationJournalRegistry
  }): Promise<ConversationTurnReport> {
    const scope = {
      owner: {
        kind: 'run-session' as const,
        conversationId: input.sessionId,
        sessionId: input.sessionId,
      },
      activityId: input.activityId,
      activityKind: 'turn' as const,
    }
    // A snapshot, not a lease. Opening the activity the way a writer does
    // creates a missing journal and truncates a torn tail, so an operator
    // asking what happened would repair the damage they were asking about —
    // and the next answer would say it was fine.
    let snapshot
    try {
      snapshot = await input.registry.snapshot(scope)
    } catch {
      // One damaged activity must not hide the rest of the page.
      return unreadable(input.activityId)
    }
    if (snapshot.kind !== 'read') return unreadable(input.activityId)

    // The whole journal, not one stream. An activity holding events that are
    // not this turn's is not one this report can describe as healthy.
    const foreign = snapshot.events.some(
      (event) =>
        event.streamKind !== CONVERSATION_TURN_STREAM_KIND ||
        event.streamId !== input.activityId,
    )
    if (foreign) return unreadable(input.activityId)

    const summary = reduceConversationTurnStream(
      input.activityId,
      snapshot.events.map((event) => ({
        type: event.type,
        payload: event.payload,
      })),
    )
    return {
      ...summary,
      activityId: input.activityId,
      integrity: 'ok',
      eventCount: snapshot.events.length,
    }
  }
}

function unreadable(activityId: string): ConversationTurnReport {
  return {
    turnId: activityId,
    activityId,
    state: 'invalid',
    assistantMessageIds: [],
    integrity: 'unreadable',
    eventCount: 0,
  }
}

/**
 * Activity ids, stopping one past the cap, sorted for a stable page.
 *
 * Streamed rather than listed. Reading every entry and applying a page bound
 * afterwards means an operator read costs whatever the conversation holds —
 * which is the growth per-activity journals exist to avoid, arriving through the
 * read path instead of the write path.
 */
async function listActivityIds(
  root: string,
  cap: number,
): Promise<{ names: string[]; overflowed: boolean }> {
  // The directory itself, before anything in it. A link standing in for this
  // conversation's activities opens perfectly well, and what comes back is
  // another conversation's history under this one's name.
  try {
    const rootStat = await fs.lstat(root)
    if (!rootStat.isDirectory()) return { names: [], overflowed: true }
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return { names: [], overflowed: false }
    return { names: [], overflowed: true }
  }

  let dir
  try {
    dir = await fs.opendir(root)
  } catch (error) {
    // Only "it is not there" is an empty conversation. Every other failure used
    // to escape into the generic API error path, which turns an operator read
    // into a response carrying whatever the errno said — including the path it
    // failed on. It is an answer, not an exception.
    if (errorCodeOf(error) === 'ENOENT') return { names: [], overflowed: false }
    return { names: [], overflowed: true }
  }
  const names: string[] = []
  let overflowed = false
  // Bounding the directories kept says nothing about the entries stepped over,
  // and the two are bounded by different things. How many activities a
  // conversation may hold is a contract; how many other files sit beside them is
  // whatever someone chose to put there, so that is the part with its own
  // ceiling.
  let skipped = 0
  try {
    for await (const entry of dir) {
      if (!entry.isDirectory()) {
        skipped += 1
        if (skipped > CONVERSATION_INSPECTION_MAX_SKIPPED_ENTRIES) {
          overflowed = true
          break
        }
        continue
      }
      if (!isConversationActivityId(entry.name)) {
        // A directory beside the activities is not an activity. Reporting one
        // puts a turn in front of an operator that never existed, and counting
        // one toward the cap makes a handful of stray folders read as a
        // conversation past its limit.
        skipped += 1
        if (skipped > CONVERSATION_INSPECTION_MAX_SKIPPED_ENTRIES) {
          overflowed = true
          break
        }
        continue
      }
      if (names.length >= cap) {
        // One past the bound is what turns "at the cap" into "over it" without
        // enumerating the remainder.
        overflowed = true
        break
      }
      names.push(entry.name)
    }
  } catch {
    // A listing that stopped part-way through has not described the directory,
    // whatever stopped it.
    return { names: [], overflowed: true }
  }
  return { names: names.sort(), overflowed }
}

/** Spread a value only when it is there, without an intermediate assertion. */
function whenLast<TValue, TShape extends object>(
  value: TValue | undefined,
  shape: (value: TValue) => TShape,
): TShape | Record<string, never> {
  return value === undefined ? {} : shape(value)
}

/** An errno, without asserting a shape onto an unknown error. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
