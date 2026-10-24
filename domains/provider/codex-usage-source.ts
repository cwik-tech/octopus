import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {
  ProviderUsageReading,
  ProviderUsageSource,
  ProviderUsageWindow,
} from './provider-usage.js'

/**
 * What the Codex CLI already wrote down about the account it was using.
 *
 * Codex records the provider's own rate-limit answer into each session's
 * rollout log, so the number a run would otherwise discover by failing is
 * already on this machine. Reading it costs nothing and asks the provider for
 * nothing, which is why this source is free and may run on any render.
 *
 * It is somebody else's private log format, and it can change without notice.
 * Every rule below therefore fails closed: anything unrecognized yields no
 * reading rather than a guess, because a badge that invents a limit is worse
 * than one that stays quiet. If the format moves, this quietly stops helping
 * and nothing else changes.
 *
 * This app's own Codex runs pass `--ephemeral` and deliberately leave no
 * rollout behind — polluting a user's session history with agent turns would
 * be a worse trade — so what is read here is the user's own Codex usage. That
 * is why every reading carries the day it was taken.
 */

/** Sessions newer than this are examined; older ones cannot be the newest. */
const SESSIONS_EXAMINED = 8

/**
 * How much of a rollout's end to read.
 *
 * Rollouts reach hundreds of megabytes — past what a string can even hold —
 * and the newest answer is always at the end, so the file is read backwards
 * from there rather than opened whole.
 */
const TAIL_BYTES = 512 * 1024

export function createCodexRolloutUsageSource(options?: {
  readonly codexHome?: string | undefined
  readonly homeDirectory?: string | undefined
}): ProviderUsageSource {
  return {
    provider: 'codex',
    cost: 'free',
    read: async () => readNewestCodexUsage(resolveSessionsDirectory(options)),
  }
}

function resolveSessionsDirectory(options?: {
  readonly codexHome?: string | undefined
  readonly homeDirectory?: string | undefined
}): string {
  const codexHome =
    options?.codexHome?.trim() ||
    process.env['CODEX_HOME']?.trim() ||
    path.join(options?.homeDirectory ?? os.homedir(), '.codex')
  return path.join(codexHome, 'sessions')
}

/**
 * The newest allowance any recent session recorded.
 *
 * Every candidate is read, not just the first that answers. Modification time
 * bounds which files are worth opening — a session appended to recently is a
 * session worth looking in — but it cannot decide which answer is newest: a
 * session stays open and keeps being written to long after it last heard an
 * allowance, so the most recently touched file routinely holds the older
 * number. Returning that one would report a stale healthy allowance over a
 * newer spent one, and a healthy reading is what is allowed to retire a usage
 * limit a run hit.
 *
 * The candidate set is already bounded by `SESSIONS_EXAMINED`, so this is a
 * fixed handful of tail reads rather than a walk that grows with history.
 */
function readNewestCodexUsage(
  sessionsDirectory: string,
): ProviderUsageReading | undefined {
  let newest: ProviderUsageReading | undefined
  for (const rollout of newestRollouts(sessionsDirectory)) {
    const reading = readRolloutUsage(rollout)
    if (reading && (newest === undefined || answeredLater(reading, newest))) {
      newest = reading
    }
  }
  return newest
}

/**
 * Whether one answer was stated after another.
 *
 * A dated answer always wins over one dated only by its file, whatever the two
 * timestamps say: an upper bound cannot be compared with an exact time without
 * quietly inventing an ordering, and the whole reason these are ranked is to
 * get the ordering right.
 */
function answeredLater(
  candidate: ProviderUsageReading,
  incumbent: ProviderUsageReading,
): boolean {
  const candidateIsDated = candidate.observedAtIsUpperBound !== true
  const incumbentIsDated = incumbent.observedAtIsUpperBound !== true
  if (candidateIsDated !== incumbentIsDated) return candidateIsDated
  return Date.parse(candidate.observedAt) > Date.parse(incumbent.observedAt)
}

/**
 * The most recently written rollouts, newest first.
 *
 * More than one, because a session that opened and never completed a turn
 * states no allowance — and that is exactly the session a user has open right
 * now. Stopping at the newest file would find nothing precisely when someone
 * has just started working.
 */
function newestRollouts(sessionsDirectory: string): string[] {
  const found: Array<{
    readonly filePath: string
    readonly fileName: string
    readonly modifiedAt: number
  }> = []
  const walk = (directory: string, depth: number): void => {
    // Rollouts live at sessions/YYYY/MM/DD/, so nothing deeper is worth opening.
    if (depth > 3) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(entryPath, depth + 1)
        continue
      }
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
        continue
      }
      try {
        found.push({
          filePath: entryPath,
          fileName: entry.name,
          modifiedAt: fs.statSync(entryPath).mtimeMs,
        })
      } catch {
        // A session removed while being listed is simply not a candidate.
      }
    }
  }
  walk(sessionsDirectory, 0)
  return found
    .sort(byNewestFirst)
    .slice(0, SESSIONS_EXAMINED)
    .map((candidate) => candidate.filePath)
}

/**
 * Newest first, with the tie decided rather than left to the directory listing.
 *
 * Modification time leads, because a session opened days ago and still being
 * worked in holds a newer allowance than one opened this morning and closed.
 *
 * Two rollouts can share a modification time: Linux stamps an inode from a
 * clock that ticks far more coarsely than files are written, so sessions
 * written moments apart routinely land on the same millisecond. macOS does not,
 * which is why a reader that leaves the tie unresolved reads correctly on a
 * developer's machine and picks the older session on a Linux one — the walk
 * order stands in for recency, and `2026/09/09` is walked before `2026/09/11`.
 *
 * The session's own name settles it. Codex files a rollout as
 * `rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl`, a timestamp of fixed width at a
 * fixed offset, so comparing the names as text puts them in the order the
 * sessions were started. That is the real recency the tie was hiding, not
 * merely a stable answer.
 */
function byNewestFirst(
  left: { readonly fileName: string; readonly modifiedAt: number },
  right: { readonly fileName: string; readonly modifiedAt: number },
): number {
  if (left.modifiedAt !== right.modifiedAt) return right.modifiedAt - left.modifiedAt
  if (left.fileName === right.fileName) return 0
  return left.fileName < right.fileName ? 1 : -1
}

function readRolloutUsage(filePath: string): ProviderUsageReading | undefined {
  let tail: string
  let modifiedAt: Date
  try {
    const stats = fs.statSync(filePath)
    modifiedAt = stats.mtime
    const length = Math.min(stats.size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    const handle = fs.openSync(filePath, 'r')
    try {
      fs.readSync(handle, buffer, 0, length, stats.size - length)
    } finally {
      fs.closeSync(handle)
    }
    tail = buffer.toString('utf8')
  } catch {
    return undefined
  }

  // Backwards: the last stated allowance in the file is the newest one.
  const lines = tail.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line || !line.includes('rate_limits')) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      // The first line of a tail read is usually cut in half. Not an error.
      continue
    }
    const reading = readEventUsage(event, modifiedAt)
    if (reading) return reading
  }
  return undefined
}

function readEventUsage(
  event: unknown,
  modifiedAt: Date,
): ProviderUsageReading | undefined {
  if (!isRecord(event)) return undefined
  const payload = event['payload']
  if (!isRecord(payload) || payload['type'] !== 'token_count') return undefined
  const rateLimits = payload['rate_limits']
  if (!isRecord(rateLimits)) return undefined

  const primary = readRateLimitWindow(rateLimits['primary'])
  if (!primary) return undefined

  // Codex states a short window and a long one, and only some plans carry the
  // second. Stated and unreadable is not the same as absent: the first means
  // this build does not understand the record, and a record it cannot read in
  // full is not one it may summarize.
  const statedSecondary = rateLimits['secondary']
  const secondaryIsStated =
    statedSecondary !== undefined && statedSecondary !== null
  const secondary = secondaryIsStated
    ? readRateLimitWindow(statedSecondary)
    : undefined
  if (secondaryIsStated && !secondary) return undefined

  // Both are reported, not the worse of them. They cap different periods and
  // expire at different moments, so whichever binds now is a question only the
  // reader — who knows what time it is — can answer.
  const stated = answerStatedAt(event, modifiedAt)
  return {
    provider: 'codex',
    observedAt: stated.at,
    ...(stated.isUpperBound ? { observedAtIsUpperBound: true } : {}),
    windows: secondary ? [primary, secondary] : [primary],
  }
}

function readRateLimitWindow(value: unknown): ProviderUsageWindow | undefined {
  if (!isRecord(value)) return undefined

  const usedPercent = value['used_percent']
  if (
    typeof usedPercent !== 'number' ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100
  ) {
    return undefined
  }

  const windowMinutes = value['window_minutes']
  const resetsAt = value['resets_at']
  // A stated reset that cannot be read is not the same as no reset: it means
  // this build does not understand the record, so the record is not used.
  if (resetsAt !== undefined && resetsAt !== null && !isEpochSeconds(resetsAt)) {
    return undefined
  }

  return {
    usedPercent,
    ...(typeof windowMinutes === 'number' && Number.isFinite(windowMinutes)
      ? { windowMinutes }
      : {}),
    ...(isEpochSeconds(resetsAt)
      ? { resetsAt: new Date(resetsAt * 1000).toISOString() }
      : {}),
  }
}

/**
 * When the provider stated this allowance, and whether that is exactly known.
 *
 * A rollout keeps growing after the answer is written — more turns, more
 * messages, a newer modification time, the same stale number. A reading dated
 * by the file would therefore look fresher every time the session was touched,
 * which matters because freshness is what decides whether a reading may retire
 * a usage limit a run actually hit.
 *
 * An event that states no readable date still yields a reading: the file's
 * modification time is a true upper bound on when the answer was written, and
 * an upper bound is enough to say how much of an allowance is gone. It is
 * marked as one so that nothing mistakes it for proof of ordering, which is
 * the single thing it cannot supply.
 */
function answerStatedAt(
  event: Record<string, unknown>,
  modifiedAt: Date,
): { readonly at: string; readonly isUpperBound: boolean } {
  const stated = event['timestamp']
  if (typeof stated === 'string') {
    const parsed = Date.parse(stated)
    if (Number.isFinite(parsed)) {
      return { at: new Date(parsed).toISOString(), isUpperBound: false }
    }
  }
  return { at: modifiedAt.toISOString(), isUpperBound: true }
}

function isEpochSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
