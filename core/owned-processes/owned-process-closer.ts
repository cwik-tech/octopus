/**
 * Closing an attempt's ownership scope, or one child's subtree, without ever
 * signalling a process whose identity is not verified
 * (`docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md`,
 * sections 5 and 6). POSIX only.
 *
 * A closer publishes its fence before it scans, and a host publishes its claim
 * before it checks the fences, so on one filesystem either the scan sees the
 * host's claim or the host sees the fence. Each intent is then resolved:
 * claimed by the closer if nobody claimed it, stopped if its host is verified
 * by marker, pid and group, or left alone and reported unverifiable. A host
 * claim seen resolved is recorded once in `resolved/`, and never probed again.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

import { TASK_SUPERVISOR_GRACEFUL_TIMEOUT_MS } from '../constants.js'
import { walkAncestors } from './owned-process-lineage.js'
import {
  commandCarriesArgument,
  probeProcessGroup,
  readProcessTableStrict,
  type ProcessRow,
} from './owned-process-probe.js'
import {
  OWNED_PROCESS_ARGUMENT,
  claimRecordSchema,
  closedRecordSchema,
  fenceRecordSchema,
  hasErrorCode,
  ownedProcessResolvedFolder,
  ownedProcessScopeFolders,
  publishOrReadScopeRecord,
  readScopeRecord,
  resolvedRecordSchema,
  type ClaimRecord,
} from './owned-process-records.js'

export interface UnverifiableMember {
  readonly ownedProcessId: string
  readonly reason: string
}

export type OwnedProcessCloseResult =
  | { readonly kind: 'closed' }
  | { readonly kind: 'held'; readonly unverifiable: readonly UnverifiableMember[] }

export type ScopeClosure =
  | { readonly kind: 'closed' }
  | { readonly kind: 'open' }
  | { readonly kind: 'unreadable'; readonly reason: string }

type Resolution =
  | { readonly kind: 'resolved' }
  | { readonly kind: 'unverifiable'; readonly reason: string }

/** How long a closer waits for a group it SIGKILLed to be gone. */
export const OWNED_PROCESS_SIGKILL_CONFIRMATION_MS = 1_000
/** How often a wait on a process group reads it again. */
export const OWNED_PROCESS_GROUP_POLL_MS = 20

/**
 * Closes the whole attempt: fence, resolve every intent until a pass finds
 * nothing new, and record `closed.json` once every intent is resolved.
 */
export async function closeOwnedProcessScope(scopePath: string, closedBy: string): Promise<OwnedProcessCloseResult> {
  const fence = await publishOrReadScopeRecord({
    scopePath,
    target: path.join(ownedProcessScopeFolders(scopePath).fences, 'attempt.json'),
    record: { version: 1, closedBy, createdAt: new Date().toISOString() },
    schema: fenceRecordSchema,
  })
  if (fence.kind === 'unreadable') return heldBy('fence', fence.reason)
  const result = await resolveUntilSettled(scopePath, closedBy, async (ids) => ({ members: ids, unknown: [] }))
  if (result.kind !== 'closed') return result
  // Closed only once a valid closed.json reads back, whoever published it.
  const closed = await publishOrReadScopeRecord({
    scopePath,
    target: path.join(scopePath, 'closed.json'),
    record: { version: 1, closedBy, closedAt: new Date().toISOString() },
    schema: closedRecordSchema,
  })
  return closed.kind === 'unreadable' ? heldBy('closed.json', closed.reason) : result
}

/**
 * Closes one child's subtree: that child and every intent whose lineage
 * reaches it. The attempt stays open, so the subtree gets its own fence.
 */
export async function closeOwnedProcessSubtree(
  scopePath: string,
  rootOwnedProcessId: string,
  closedBy: string,
): Promise<OwnedProcessCloseResult> {
  const fence = await publishOrReadScopeRecord({
    scopePath,
    target: path.join(ownedProcessScopeFolders(scopePath).fences, `subtree-${rootOwnedProcessId}.json`),
    record: { version: 1, ownedProcessId: rootOwnedProcessId, closedBy, createdAt: new Date().toISOString() },
    schema: fenceRecordSchema,
    expectedOwnedProcessId: rootOwnedProcessId,
  })
  if (fence.kind === 'unreadable') return heldBy(rootOwnedProcessId, fence.reason)
  return resolveUntilSettled(scopePath, closedBy, async (ids) => {
    const members: string[] = []
    const unknown: UnverifiableMember[] = []
    for (const id of ids) {
      if (id === rootOwnedProcessId) {
        members.push(id)
        continue
      }
      const walk = await walkAncestors(scopePath, id)
      if (walk.kind === 'failed') unknown.push({ ownedProcessId: id, reason: walk.reason })
      else if (walk.ancestors.includes(rootOwnedProcessId)) members.push(id)
    }
    return { members, unknown }
  })
}

/** Whether the scope has a valid `closed.json`; only that proves it closed. */
export async function readScopeClosure(scopePath: string): Promise<ScopeClosure> {
  const read = await readScopeRecord({ target: path.join(scopePath, 'closed.json'), schema: closedRecordSchema })
  if (read.kind === 'present') return { kind: 'closed' }
  if (read.kind === 'absent') return { kind: 'open' }
  return { kind: 'unreadable', reason: read.reason }
}

async function resolveUntilSettled(
  scopePath: string,
  closedBy: string,
  select: (ids: readonly string[]) => Promise<{ readonly members: readonly string[]; readonly unknown: readonly UnverifiableMember[] }>,
): Promise<OwnedProcessCloseResult> {
  const resolved = new Set<string>()
  for (;;) {
    const listed = await listIntentIds(scopePath)
    if (listed.kind === 'unreadable') {
      return { kind: 'held', unverifiable: [{ ownedProcessId: '*', reason: listed.reason }] }
    }
    const { members, unknown } = await select(listed.ids)
    const unverifiable: UnverifiableMember[] = [...unknown]
    let progressed = false
    for (const id of members) {
      if (resolved.has(id)) continue
      const resolution = await resolveIntent(scopePath, id, closedBy)
      if (resolution.kind === 'resolved') {
        resolved.add(id)
        progressed = true
      } else {
        unverifiable.push({ ownedProcessId: id, reason: resolution.reason })
      }
    }
    if (unverifiable.length > 0) return { kind: 'held', unverifiable }
    if (!progressed) return { kind: 'closed' }
  }
}

async function listIntentIds(
  scopePath: string,
): Promise<{ readonly kind: 'listed'; readonly ids: readonly string[] } | { readonly kind: 'unreadable'; readonly reason: string }> {
  try {
    const names = await fsp.readdir(ownedProcessScopeFolders(scopePath).intents)
    return {
      kind: 'listed',
      ids: names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)),
    }
  } catch (error) {
    return { kind: 'unreadable', reason: `the scope's intents cannot be listed: ${describeError(error)}` }
  }
}

async function resolveIntent(scopePath: string, ownedProcessId: string, closedBy: string): Promise<Resolution> {
  const claimPath = path.join(ownedProcessScopeFolders(scopePath).claims, `${ownedProcessId}.json`)
  const existing = await readScopeRecord({ target: claimPath, schema: claimRecordSchema, expectedOwnedProcessId: ownedProcessId })
  if (existing.kind === 'unreadable') return { kind: 'unverifiable', reason: existing.reason }
  let claim: ClaimRecord
  if (existing.kind === 'present') {
    claim = existing.record
  } else {
    const published = await publishOrReadScopeRecord({
      scopePath,
      target: claimPath,
      record: { version: 1, ownedProcessId, claimant: 'closer', closedBy, claimedAt: new Date().toISOString() },
      schema: claimRecordSchema,
      expectedOwnedProcessId: ownedProcessId,
    })
    if (published.kind === 'unreadable') return { kind: 'unverifiable', reason: published.reason }
    claim = published.record
  }
  // Claimed for the closer: its host, if one ever runs, cannot claim it and exits.
  if (claim.claimant === 'closer') return { kind: 'resolved' }
  // A host claim resolved once stays resolved. Its host can never start
  // again, since its claim exists, so probing its pid again could only mistake
  // a process that reused that pid for it.
  const resolvedPath = path.join(ownedProcessResolvedFolder(scopePath), `${ownedProcessId}.json`)
  const recorded = await readScopeRecord({ target: resolvedPath, schema: resolvedRecordSchema, expectedOwnedProcessId: ownedProcessId })
  if (recorded.kind === 'present') return { kind: 'resolved' }
  if (recorded.kind === 'unreadable') return { kind: 'unverifiable', reason: recorded.reason }
  const stopped = await stopVerifiedHost(ownedProcessId, claim.pid, claim.processGroupId)
  if (stopped.kind !== 'resolved') return stopped
  await fsp.mkdir(path.dirname(resolvedPath), { recursive: true, mode: 0o700 })
  const published = await publishOrReadScopeRecord({
    scopePath,
    target: resolvedPath,
    record: { version: 1, ownedProcessId, resolvedBy: closedBy, resolvedAt: new Date().toISOString() },
    schema: resolvedRecordSchema,
    expectedOwnedProcessId: ownedProcessId,
  })
  return published.kind === 'unreadable' ? { kind: 'unverifiable', reason: published.reason } : stopped
}

/**
 * Stops the host's group only while the host is verified: exactly one process
 * carries the intent's marker, and it is the claimed pid leading the claimed
 * group. Rechecked before each signal.
 */
async function stopVerifiedHost(ownedProcessId: string, pid: number, processGroupId: number): Promise<Resolution> {
  const marker = `${OWNED_PROCESS_ARGUMENT}${ownedProcessId}`
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const state = await verifyHost(marker, pid, processGroupId)
    if (state.kind === 'gone') return { kind: 'resolved' }
    if (state.kind === 'unverifiable') return state
    try {
      process.kill(-processGroupId, signal)
    } catch (error) {
      if (!hasErrorCode(error, 'ESRCH')) {
        return { kind: 'unverifiable', reason: `group ${processGroupId} could not be signalled: ${describeError(error)}` }
      }
    }
    const windowMs = signal === 'SIGTERM' ? TASK_SUPERVISOR_GRACEFUL_TIMEOUT_MS : OWNED_PROCESS_SIGKILL_CONFIRMATION_MS
    if (await waitForGroupGone(processGroupId, windowMs)) return { kind: 'resolved' }
  }
  return { kind: 'unverifiable', reason: `group ${processGroupId} of ${ownedProcessId} was still alive after SIGTERM and SIGKILL` }
}

type HostState =
  | { readonly kind: 'verified' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unverifiable'; readonly reason: string }

async function verifyHost(marker: string, pid: number, processGroupId: number): Promise<HostState> {
  const table = await readProcessTableStrict()
  if (table.kind === 'failure') return { kind: 'unverifiable', reason: table.reason }
  const carriers: readonly ProcessRow[] = table.rows.filter((row) => commandCarriesArgument(row.command, marker))
  const group = probeProcessGroup(processGroupId)
  if (group.kind === 'failure') return { kind: 'unverifiable', reason: group.reason }
  if (carriers.length === 0) {
    return group.kind === 'gone'
      ? { kind: 'gone' }
      : { kind: 'unverifiable', reason: `no process carries ${marker}, but group ${processGroupId} is alive` }
  }
  const [only] = carriers
  if (carriers.length === 1 && only && only.pid === pid && only.processGroupId === processGroupId && pid === processGroupId) {
    return { kind: 'verified' }
  }
  return {
    kind: 'unverifiable',
    reason: `${marker} is carried by ${carriers.map((row) => `${row.pid} (group ${row.processGroupId})`).join(', ')}, not only by host ${pid} leading group ${processGroupId}`,
  }
}

/** Only ESRCH from kill(-pgid, 0) within the window counts as gone. */
async function waitForGroupGone(processGroupId: number, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs
  for (;;) {
    if (probeProcessGroup(processGroupId).kind === 'gone') return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, OWNED_PROCESS_GROUP_POLL_MS))
  }
}

function heldBy(ownedProcessId: string, reason: string): OwnedProcessCloseResult {
  return { kind: 'held', unverifiable: [{ ownedProcessId, reason }] }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
