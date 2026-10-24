/**
 * Where one conversation activity's durable state lives.
 *
 * A conversation is a logical owner; the physical journal belongs to one
 * bounded activity below it. That split is deliberate: opening a journal reads
 * and validates the whole file and indexes every event, so one journal covering
 * a whole session would make each turn pay for all the turns before it, and the
 * accepted journal ADR forbids compaction in version 1.
 *
 * The path is derived from a validated owner and activity id, never from
 * anything a caller supplies directly. Every segment is checked and the result
 * is proven to stay inside the workspace, exactly as the assignment layout does.
 */
import * as path from 'node:path'

import { isSafePathSegment, resolveRelativePathInside } from './path-safety.js'

/** The directory holding every activity journal below one conversation owner. */
export const CONVERSATION_ACTIVITIES_DIRECTORY_NAME = '.conversation-activities'

/**
 * The identity shape Phase 1 gives an activity: a uuid.
 *
 * Shared, because two places need the same answer to the same question — is
 * this entry claiming to be an activity? — and two copies of it would be two
 * definitions of what an activity is called.
 */
export const ACTIVITY_SHAPED_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether this value names an activity.
 *
 * The one definition. Path resolution, the retention record, workspace
 * discovery and the operator report all have to answer the same question the
 * same way: a directory that resolves as an activity but is filtered out of the
 * report, or counted by retention but skipped by discovery, is a conversation
 * described differently depending on who asked.
 *
 * A safe path segment is a weaker test and not a substitute. `notes`, `backup`
 * and `.keep` are all safe, and none of them is a turn — admitting one gives a
 * directory somebody dropped into the conversation a journal, an admission
 * slot, a place in the retained cap and a line in an operator's report.
 */
export function isConversationActivityId(value: unknown): value is string {
  return typeof value === 'string' && ACTIVITY_SHAPED_NAME.test(value)
}

/**
 * Who owns a conversation.
 *
 * A Run session already exists as a durable directory and owns `chat.jsonl`, so
 * its activities live beneath it and are removed with it. Create authoring
 * owns a separate draft conversation and never manufactures a Run session.
 */
export type RunSessionConversationOwner = {
  readonly kind: 'run-session'
  readonly conversationId: string
  readonly sessionId: string
}

export type ConversationOwner = RunSessionConversationOwner | {
  readonly kind: 'create-resource-architect'
  readonly conversationId: string
}

export interface ConversationActivityLocation {
  readonly ownerKind: ConversationOwner['kind']
  readonly conversationId: string
  readonly sessionId?: string
  readonly activityId: string
  /** The activity's scope root; the journal lives in `.runtime` below it. */
  readonly activityPath: string
  readonly relativeActivityPath: string
}

/**
 * Resolve one activity's scope root, or null when the identity is unsafe.
 *
 * Null rather than a throw, matching the assignment builder: an unusable
 * identity is a fact the caller decides how to fail on, and every caller here
 * fails closed.
 */
export function buildConversationActivityLocation(
  workspacePath: string,
  identity: {
    readonly owner: ConversationOwner
    readonly activityId: string
  },
): ConversationActivityLocation | null {
  const { owner, activityId } = identity
  if (!isSafePathSegment(owner.conversationId)) return null
  if (owner.kind === 'create-resource-architect' && owner.conversationId.length > 128) return null
  if (!isConversationActivityId(activityId)) return null
  // Run paths are keyed by session; their logical conversation must agree.
  if (owner.kind === 'run-session' && (
    !isSafePathSegment(owner.sessionId) || owner.conversationId !== owner.sessionId
  )) return null
  const ownerPath = owner.kind === 'run-session'
    ? path.join('sessions', owner.sessionId)
    : path.join('create', 'conversations', owner.conversationId)
  const relativeActivityPath = toPosixPath(path.join(
    ownerPath, CONVERSATION_ACTIVITIES_DIRECTORY_NAME, activityId,
  ))
  const activityPath = resolveRelativePathInside(
    workspacePath,
    relativeActivityPath,
  )
  if (!activityPath) return null
  return {
    ownerKind: owner.kind,
    conversationId: owner.conversationId,
    ...(owner.kind === 'run-session' ? { sessionId: owner.sessionId } : {}),
    activityId,
    activityPath,
    relativeActivityPath,
  }
}

/**
 * The directory that holds every activity for one Run-session conversation.
 *
 * Discovery and deletion both need it without naming a single activity.
 */
export function buildConversationActivitiesRoot(
  workspacePath: string,
  sessionId: string,
): string | null {
  if (!isSafePathSegment(sessionId)) return null
  return resolveRelativePathInside(
    workspacePath,
    toPosixPath(
      path.join('sessions', sessionId, CONVERSATION_ACTIVITIES_DIRECTORY_NAME),
    ),
  )
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

/** The activity root for a Create draft, independent of Run session storage. */
export function buildCreateConversationActivitiesRoot(
  workspacePath: string,
  conversationId: string,
): string | null {
  if (!isSafePathSegment(conversationId) || conversationId.length > 128) return null
  return resolveRelativePathInside(workspacePath, toPosixPath(path.join(
    'create', 'conversations', conversationId, CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  )))
}
