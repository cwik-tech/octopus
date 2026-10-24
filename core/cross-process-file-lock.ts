import * as crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { hasErrorCode } from './node-errors.js'

const DEFAULT_TIMEOUT_MS = 5_000
const LEGACY_OWNERLESS_RECLAIM_GUARD_MAX_AGE_MS = 60_000
const LEGACY_RECLAIM_GUARD_OWNER_FILENAME = 'owner.json'

export interface CrossProcessFileLockRecord {
  pid: number
  nonce: string
  createdAt: string
}

export interface ProcessFileLockAdapter<TRecord> {
  parse(value: unknown): TRecord | null
  pid(record: TRecord): number
  token(record: TRecord): string
}

export interface AcquiredProcessFileLock<TRecord> {
  readonly path: string
  readonly record: TRecord
  readonly reclaimed: boolean
  isCurrentOwner(): Promise<boolean>
  release(): Promise<void>
}

export class ProcessFileLockError extends Error {
  constructor(
    readonly code: 'in_use' | 'corrupt' | 'timeout',
    message: string,
  ) {
    super(message)
    this.name = 'ProcessFileLockError'
  }
}

export async function acquireProcessFileLock<TRecord>(params: {
  lockPath: string
  record: TRecord
  adapter: ProcessFileLockAdapter<TRecord>
  timeoutMs?: number
  retryMs?: number
  waitDescription?: string
  corruptBehavior?: 'fail' | 'wait'
  isProcessAlive?: (pid: number) => boolean
  signal?: AbortSignal
}): Promise<AcquiredProcessFileLock<TRecord>> {
  throwIfLockAborted(params.signal)
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retryMs = params.retryMs ?? 10
  const deadline = Date.now() + timeoutMs
  const isProcessAlive = params.isProcessAlive ?? defaultIsProcessAlive
  const corruptBehavior = params.corruptBehavior ?? 'fail'
  await fs.mkdir(path.dirname(params.lockPath), { recursive: true, mode: 0o700 })

  let handle: fs.FileHandle | undefined
  let reclaimed = false
  while (!handle) {
    throwIfLockAborted(params.signal)
    const reclaimPath = `${params.lockPath}.reclaim`
    if (existsSync(reclaimPath)) {
      if (await removeOrphanedReclaimGuard(reclaimPath, isProcessAlive)) {
        continue
      }
      if (Date.now() >= deadline) {
        throw lockWaitError(params.lockPath, params.waitDescription)
      }
      await waitForRetry(timeoutMs, retryMs, params.signal)
      continue
    }

    const candidateHandle = await publishExclusiveRecord(
      params.lockPath,
      params.record,
      params.adapter,
    )
    if (!candidateHandle) {
      const existing = await readProcessFileLockRecord(
        params.lockPath,
        params.adapter,
      )
      if (existing.kind === 'missing') {
        // Publication lost the race, and by the time we looked the winner had
        // already released: the lock is free, not damaged. Retry publication
        // at once rather than condemning a file that is no longer there.
        if (Date.now() >= deadline) {
          throw lockWaitError(params.lockPath, params.waitDescription)
        }
        continue
      }
      if (existing.kind === 'invalid') {
        if (corruptBehavior === 'fail') {
          throw new ProcessFileLockError(
            'corrupt',
            `Lock record is corrupt: ${path.basename(params.lockPath)}`,
          )
        }
      } else if (isProcessAlive(params.adapter.pid(existing.record))) {
        if (timeoutMs === 0) {
          throw new ProcessFileLockError(
            'in_use',
            `Lock is owned by live process ${params.adapter.pid(existing.record)}`,
          )
        }
      } else if (
        await reclaimStaleRecord({
          lockPath: params.lockPath,
          adapter: params.adapter,
          isProcessAlive,
        })
      ) {
        reclaimed = true
        continue
      }

      if (Date.now() >= deadline) {
        throw lockWaitError(params.lockPath, params.waitDescription)
      }
      await waitForRetry(timeoutMs, retryMs, params.signal)
      continue
    }

    handle = candidateHandle
    if (existsSync(reclaimPath)) {
      await handle.close().catch(() => undefined)
      handle = undefined
      await removeOwnedRecord(
        params.lockPath,
        params.record,
        params.adapter,
      )
    }
  }

  let released = false
  return {
    path: params.lockPath,
    record: params.record,
    reclaimed,
    async isCurrentOwner(): Promise<boolean> {
      if (released) return false
      return recordMatches(
        await readRecord(params.lockPath, params.adapter),
        params.record,
        params.adapter,
      )
    },
    async release(): Promise<void> {
      if (released) return
      released = true
      await handle?.close().catch(() => undefined)
      await removeOwnedRecord(
        params.lockPath,
        params.record,
        params.adapter,
      )
    },
  }
}

export async function withCrossProcessFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireProcessFileLock({
    lockPath,
    record: createCrossProcessFileLockRecord(),
    adapter: crossProcessFileLockAdapter,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    waitDescription: 'lifecycle lock',
    corruptBehavior: 'wait',
  })
  try {
    return await operation()
  } finally {
    await lock.release()
  }
}

export function createCrossProcessFileLockRecord(
  now = new Date(),
): CrossProcessFileLockRecord {
  return {
    pid: process.pid,
    nonce: crypto.randomUUID(),
    createdAt: now.toISOString(),
  }
}

export const crossProcessFileLockAdapter: ProcessFileLockAdapter<CrossProcessFileLockRecord> = {
  parse: parseCrossProcessFileLockRecord,
  pid: (record) => record.pid,
  token: (record) => record.nonce,
}

export function parseCrossProcessFileLockRecord(
  value: unknown,
): CrossProcessFileLockRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<CrossProcessFileLockRecord>
  if (
    typeof record.pid !== 'number' ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.nonce !== 'string' ||
    !record.nonce ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    return null
  }
  return {
    pid: record.pid,
    nonce: record.nonce,
    createdAt: record.createdAt,
  }
}

export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function publishExclusiveRecord<TRecord>(
  lockPath: string,
  record: TRecord,
  adapter: ProcessFileLockAdapter<TRecord>,
): Promise<fs.FileHandle | null> {
  const candidatePath = `${lockPath}.candidate-${adapter.pid(record)}-${adapter.token(record)}`
  const handle = await fs.open(candidatePath, 'wx', 0o600)
  let published = false
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    await handle.sync()
    try {
      await fs.link(candidatePath, lockPath)
      published = true
      // The record's bytes are synced above, before the link publishes the
      // name — that ordering is what keeps a post-crash lock file parseable,
      // and it is load-bearing: an unparseable lock has no reclaim path and
      // wedges the journal permanently.
      //
      // Making the directory entry itself durable is not. A link lost to a
      // crash means the lock does not exist, and the next acquirer takes it
      // freely — the safe direction. The fsync cost is real (measured ~5 ms
      // per acquisition, and every journal append takes the lock), so it is
      // not paid for a failure mode that is already safe.
      return handle
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    }
  } finally {
    await fs.unlink(candidatePath).catch(() => undefined)
    if (!published) await handle.close().catch(() => undefined)
  }
}

/** What a lock file turned out to hold. */
export type ProcessFileLockRecordRead<TRecord> =
  | { readonly kind: 'record'; readonly record: TRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }

export async function readProcessFileLockRecord<TRecord>(
  lockPath: string,
  adapter: ProcessFileLockAdapter<TRecord>,
): Promise<ProcessFileLockRecordRead<TRecord>> {
  let raw: string
  try {
    raw = await fs.readFile(lockPath, 'utf8')
  } catch (error) {
    // Only "there is no file" is absence, and absence is the release case: the
    // holder unlinked the lock, so it is free rather than damaged. Every other
    // read failure — a permission change, a directory in its place, an I/O
    // fault — keeps its own error instead of being relabelled as absence or as
    // damage, because none of them is evidence about the record's contents.
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'missing' }
    throw error
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    const record = adapter.parse(parsed)
    return record ? { kind: 'record', record } : { kind: 'invalid' }
  } catch {
    // Bytes are on disk and cannot be read as a record. That is damage.
    return { kind: 'invalid' }
  }
}

async function readRecord<TRecord>(
  lockPath: string,
  adapter: ProcessFileLockAdapter<TRecord>,
): Promise<TRecord | null> {
  // The ownership and reclaim sites ask one question — "is this record mine?"
  // — and have always answered "no" to anything they could not read, a failed
  // read included. That is preserved here so narrowing the boundary does not
  // change their semantics.
  try {
    const read = await readProcessFileLockRecord(lockPath, adapter)
    return read.kind === 'record' ? read.record : null
  } catch {
    return null
  }
}

function recordMatches<TRecord>(
  left: TRecord | null,
  right: TRecord,
  adapter: ProcessFileLockAdapter<TRecord>,
): boolean {
  return Boolean(
    left &&
      adapter.pid(left) === adapter.pid(right) &&
      adapter.token(left) === adapter.token(right),
  )
}

async function removeOwnedRecord<TRecord>(
  lockPath: string,
  record: TRecord,
  adapter: ProcessFileLockAdapter<TRecord>,
): Promise<void> {
  if (!recordMatches(await readRecord(lockPath, adapter), record, adapter)) {
    return
  }
  await fs.unlink(lockPath).catch(() => undefined)
  // Not synced, for the same reason as publication: an unlink lost to a crash
  // leaves a record whose owning pid is dead, which `reclaimStaleRecord`
  // already reclaims. Both directions of a lost directory entry fail safe.
}

async function reclaimStaleRecord<TRecord>(params: {
  lockPath: string
  adapter: ProcessFileLockAdapter<TRecord>
  isProcessAlive: (pid: number) => boolean
}): Promise<boolean> {
  const reclaimPath = `${params.lockPath}.reclaim`
  const guard = await acquireReclaimGuard(reclaimPath, params.isProcessAlive)
  if (!guard) return false
  try {
    const stat = await fs.stat(params.lockPath).catch(() => null)
    if (!stat) return true
    const record = await readRecord(params.lockPath, params.adapter)
    if (!record || params.isProcessAlive(params.adapter.pid(record))) {
      return false
    }
    if (!(await ownsReclaimGuard(reclaimPath, guard))) return false
    const currentStat = await fs.stat(params.lockPath).catch(() => null)
    const currentRecord = await readRecord(params.lockPath, params.adapter)
    if (
      !currentStat ||
      currentStat.dev !== stat.dev ||
      currentStat.ino !== stat.ino ||
      !recordMatches(currentRecord, record, params.adapter)
    ) {
      return false
    }
    await fs.unlink(params.lockPath).catch(() => undefined)
    await syncDirectory(path.dirname(params.lockPath))
    return true
  } finally {
    await releaseReclaimGuard(reclaimPath, guard)
  }
}

async function acquireReclaimGuard(
  reclaimPath: string,
  isProcessAlive: (pid: number) => boolean,
): Promise<CrossProcessFileLockRecord | null> {
  await removeOrphanedReclaimGuard(reclaimPath, isProcessAlive)
  const guard = createCrossProcessFileLockRecord()
  const handle = await publishExclusiveRecord(
    reclaimPath,
    guard,
    crossProcessFileLockAdapter,
  )
  await handle?.close().catch(() => undefined)
  return handle ? guard : null
}

async function ownsReclaimGuard(
  reclaimPath: string,
  guard: CrossProcessFileLockRecord,
): Promise<boolean> {
  return recordMatches(
    await readRecord(reclaimPath, crossProcessFileLockAdapter),
    guard,
    crossProcessFileLockAdapter,
  )
}

async function releaseReclaimGuard(
  reclaimPath: string,
  guard: CrossProcessFileLockRecord,
): Promise<void> {
  await removeOwnedRecord(reclaimPath, guard, crossProcessFileLockAdapter)
}

interface ReclaimGuardSnapshot {
  dev: number
  ino: number
  kind: 'file' | 'legacy_directory'
  mtimeMs: number
  record: CrossProcessFileLockRecord | null
}

async function readReclaimGuardSnapshot(
  reclaimPath: string,
): Promise<ReclaimGuardSnapshot | null> {
  const stat = await fs.lstat(reclaimPath).catch(() => null)
  if (!stat || stat.isSymbolicLink()) return null
  const kind = stat.isFile()
    ? 'file'
    : stat.isDirectory()
      ? 'legacy_directory'
      : null
  if (!kind) return null
  const record = await readRecord(
    kind === 'file'
      ? reclaimPath
      : path.join(reclaimPath, LEGACY_RECLAIM_GUARD_OWNER_FILENAME),
    crossProcessFileLockAdapter,
  )
  return {
    dev: stat.dev,
    ino: stat.ino,
    kind,
    mtimeMs: stat.mtimeMs,
    record,
  }
}

function sameReclaimGuard(
  left: ReclaimGuardSnapshot,
  right: ReclaimGuardSnapshot,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.kind === right.kind &&
    left.record?.pid === right.record?.pid &&
    left.record?.nonce === right.record?.nonce
  )
}

function reclaimGuardIsOrphaned(
  snapshot: ReclaimGuardSnapshot,
  isProcessAlive: (pid: number) => boolean,
): boolean {
  if (snapshot.record) return !isProcessAlive(snapshot.record.pid)
  return (
    snapshot.kind === 'legacy_directory' &&
    Date.now() - snapshot.mtimeMs >= LEGACY_OWNERLESS_RECLAIM_GUARD_MAX_AGE_MS
  )
}

async function removeOrphanedReclaimGuard(
  reclaimPath: string,
  isProcessAlive: (pid: number) => boolean,
): Promise<boolean> {
  const observed = await readReclaimGuardSnapshot(reclaimPath)
  if (!observed || !reclaimGuardIsOrphaned(observed, isProcessAlive)) {
    return false
  }
  const confirmed = await readReclaimGuardSnapshot(reclaimPath)
  if (
    !confirmed ||
    !sameReclaimGuard(observed, confirmed) ||
    !reclaimGuardIsOrphaned(confirmed, isProcessAlive)
  ) {
    return false
  }

  const quarantinePath = `${reclaimPath}.orphan-${process.pid}-${crypto.randomUUID()}`
  try {
    await fs.rename(reclaimPath, quarantinePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const moved = await readReclaimGuardSnapshot(quarantinePath)
  if (
    !moved ||
    !sameReclaimGuard(confirmed, moved) ||
    !reclaimGuardIsOrphaned(moved, isProcessAlive)
  ) {
    await fs.rename(quarantinePath, reclaimPath).catch(() => undefined)
    return false
  }
  if (moved.kind === 'legacy_directory') {
    await fs.rm(quarantinePath, { recursive: true, force: true })
  } else {
    await fs.unlink(quarantinePath).catch(() => undefined)
  }
  return true
}

function lockWaitError(lockPath: string, description?: string): ProcessFileLockError {
  return new ProcessFileLockError(
    'timeout',
    `Timed out waiting for ${description ?? 'lock'}: ${path.basename(lockPath)}`,
  )
}

async function waitForRetry(
  timeoutMs: number,
  retryMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (timeoutMs === 0) return
  throwIfLockAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, retryMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(lockAbortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function throwIfLockAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw lockAbortError(signal)
}

function lockAbortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException('Lock acquisition was aborted', 'AbortError')
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync().catch(() => undefined)
  } finally {
    await handle.close().catch(() => undefined)
  }
}
