/**
 * The records an ownership scope holds, and how each is published and read.
 *
 * A scope is one folder per execution attempt
 * (`docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md`,
 * sections 1 and 2). Every file in it is published once and never rewritten:
 * written whole into the scope's staging folder, synced, then hard-linked to
 * its final name, so a reader never sees a record half written. A record that
 * exists but cannot be opened, parsed or validated is unreadable, which the
 * closer treats as unverifiable, never as absent.
 */
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

import { z } from 'zod'

export const OWNED_PROCESS_SCOPE_ENV = 'TEAM_RUNTIME_OWNED_PROCESS_SCOPE'
export const OWNED_PROCESS_ID_ENV = 'TEAM_RUNTIME_OWNED_PROCESS_ID'
export const OWNED_PROCESS_ARGUMENT = '--runtime-owned-process='

export const scopeRecordSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  executionAttemptNumber: z.number().int().positive(),
  createdAt: z.string().min(1),
}).strict()

export const intentRecordSchema = z.object({
  version: z.literal(1),
  ownedProcessId: z.string().min(1),
  parentOwnedProcessId: z.string().min(1).nullable(),
  kind: z.enum(['team', 'file-parser']),
  childRunId: z.string().min(1).nullable(),
  spawnerRunId: z.string().min(1).nullable(),
  spawnerAssignmentId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
}).strict()

export const claimRecordSchema = z.discriminatedUnion('claimant', [
  z.object({
    version: z.literal(1),
    ownedProcessId: z.string().min(1),
    claimant: z.literal('host'),
    pid: z.number().int().positive(),
    processGroupId: z.number().int().positive(),
    claimedAt: z.string().min(1),
  }).strict(),
  z.object({
    version: z.literal(1),
    ownedProcessId: z.string().min(1),
    claimant: z.literal('closer'),
    closedBy: z.string().min(1),
    claimedAt: z.string().min(1),
  }).strict(),
])

export const fenceRecordSchema = z.object({
  version: z.literal(1),
  ownedProcessId: z.string().min(1).optional(),
  closedBy: z.string().min(1),
  createdAt: z.string().min(1),
}).strict()

export const closedRecordSchema = z.object({
  version: z.literal(1),
  closedBy: z.string().min(1),
  closedAt: z.string().min(1),
}).strict()

/**
 * A host claim a closer has seen resolved: its group was gone, or was
 * confirmed gone after a signal. Its host can never start again, because its
 * claim exists, so the resolution is final and never probed again.
 */
export const resolvedRecordSchema = z.object({
  version: z.literal(1),
  ownedProcessId: z.string().min(1),
  resolvedBy: z.string().min(1),
  resolvedAt: z.string().min(1),
}).strict()

export type ScopeRecord = z.infer<typeof scopeRecordSchema>
export type IntentRecord = z.infer<typeof intentRecordSchema>
export type ClaimRecord = z.infer<typeof claimRecordSchema>
export type FenceRecord = z.infer<typeof fenceRecordSchema>
export type ClosedRecord = z.infer<typeof closedRecordSchema>
export type ResolvedRecord = z.infer<typeof resolvedRecordSchema>

export type ScopeRecordRead<T> =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly record: T }
  | { readonly kind: 'unreadable'; readonly reason: string }

export interface OwnedProcessScopeFolders {
  readonly intents: string
  readonly claims: string
  readonly fences: string
  readonly staging: string
}

export function ownedProcessScopeFolders(scopePath: string): OwnedProcessScopeFolders {
  return {
    intents: path.join(scopePath, 'intents'),
    claims: path.join(scopePath, 'claims'),
    fences: path.join(scopePath, 'fences'),
    staging: path.join(scopePath, '.staging'),
  }
}

/**
 * Where a scope's resolved records live. Not one of the folders a scope is
 * published with: the first closer that records a resolution creates it.
 */
export function ownedProcessResolvedFolder(scopePath: string): string {
  return path.join(scopePath, 'resolved')
}

/**
 * Publishes `record` at `target`, a path inside `scopePath`, once.
 * `'exists'` means another writer published that name first.
 *
 * The record is written whole into the scope's staging folder, synced, and
 * then hard-linked to its final name, so the name appears only with its full
 * content. The same pattern publishes run assignment grants
 * (`domains/run/run-assignment-authority-store.ts`).
 */
export async function publishScopeRecord(input: {
  readonly scopePath: string
  readonly target: string
  readonly record: unknown
}): Promise<'published' | 'exists'> {
  const staging = path.join(
    ownedProcessScopeFolders(input.scopePath).staging,
    `${path.basename(input.target)}.${process.pid}.${randomUUID()}.tmp`,
  )
  const contents = Buffer.from(`${JSON.stringify(input.record)}\n`, 'utf8')
  const handle = await fsp.open(
    staging,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  )
  try {
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await fsp.link(staging, input.target)
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) return 'exists'
      throw error
    }
    await syncDirectory(path.dirname(input.target))
    return 'published'
  } finally {
    await fsp.rm(staging, { force: true })
  }
}

export type ScopeRecordPublication<T> =
  | { readonly kind: 'published'; readonly record: T }
  | { readonly kind: 'existing'; readonly record: T }
  | { readonly kind: 'unreadable'; readonly reason: string }

/**
 * Publishes `record` at `target` once, or, when another writer already holds
 * that name, reads the winner back strictly. A winner that cannot be read and
 * validated is unreadable, never proof of anything.
 */
export async function publishOrReadScopeRecord<T>(input: {
  readonly scopePath: string
  readonly target: string
  readonly record: unknown
  readonly schema: z.ZodType<T>
  readonly expectedOwnedProcessId?: string
}): Promise<ScopeRecordPublication<T>> {
  // Never write a record this module would itself refuse to read.
  const validated = input.schema.safeParse(input.record)
  if (!validated.success) {
    throw new Error(`Refusing to publish an invalid scope record at ${input.target}: ${validated.error.message}`)
  }
  const published = await publishScopeRecord({ scopePath: input.scopePath, target: input.target, record: validated.data })
  if (published === 'published') return { kind: 'published', record: validated.data }
  const winner = await readScopeRecord({
    target: input.target,
    schema: input.schema,
    ...(input.expectedOwnedProcessId === undefined ? {} : { expectedOwnedProcessId: input.expectedOwnedProcessId }),
  })
  if (winner.kind === 'present') return { kind: 'existing', record: winner.record }
  if (winner.kind === 'unreadable') return winner
  return { kind: 'unreadable', reason: `${input.target} was held by another writer and then vanished` }
}

/**
 * Reads and validates the record at `target`.
 *
 * Only a name that does not exist reads as absent. Anything else that stops
 * the read — a link, a directory, an empty or partial file, a record that does
 * not validate or names another owned process — is unreadable.
 */
export async function readScopeRecord<T>(input: {
  readonly target: string
  readonly schema: z.ZodType<T>
  /** When given, the record must name this owned process. */
  readonly expectedOwnedProcessId?: string
}): Promise<ScopeRecordRead<T>> {
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(input.target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'absent' }
    return unreadable(input.target, describeError(error))
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return unreadable(input.target, 'it is not a regular file')
    const text = await handle.readFile('utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return unreadable(input.target, `it is not complete JSON (${describeError(error)})`)
    }
    const validated = input.schema.safeParse(parsed)
    if (!validated.success) return unreadable(input.target, `it does not validate (${validated.error.message})`)
    if (
      input.expectedOwnedProcessId !== undefined &&
      (!isRecord(parsed) || parsed.ownedProcessId !== input.expectedOwnedProcessId)
    ) {
      return unreadable(input.target, `it does not name owned process ${input.expectedOwnedProcessId}`)
    }
    return { kind: 'present', record: validated.data }
  } catch (error) {
    return unreadable(input.target, describeError(error))
  } finally {
    await handle.close()
  }
}

function unreadable(target: string, reason: string): { readonly kind: 'unreadable'; readonly reason: string } {
  return { kind: 'unreadable', reason: `${target} is unreadable: ${reason}` }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, fsConstants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
