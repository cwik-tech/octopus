import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

import { DEFAULT_MAX_SPAWN_DEPTH } from '../../core/constants.js'
import { withFileMutationLock } from '../../core/file-mutation.js'
import { isSafePathSegment } from '../../core/path-safety.js'

export const RUN_ASSIGNMENT_AUTHORITY_GRANT_VERSION = 1 as const
export const MAX_RUN_ASSIGNMENT_AUTHORITY_DEPTH = DEFAULT_MAX_SPAWN_DEPTH

export interface RunAssignmentAuthorityGrant {
  readonly version: typeof RUN_ASSIGNMENT_AUTHORITY_GRANT_VERSION
  readonly sessionId: string
  readonly runId: string
  readonly taskId: string
  readonly assignmentId: string
  readonly parentAssignmentId: string | null
  readonly depth: number
}

export type RunAssignmentAuthorityStoreErrorCode =
  | 'invalid-grant'
  | 'noncanonical-path'
  | 'conflict'
  | 'corrupt-grant'
  | 'invalid-lineage'

export class RunAssignmentAuthorityStoreError extends Error {
  constructor(
    readonly code: RunAssignmentAuthorityStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RunAssignmentAuthorityStoreError'
  }
}

export async function writeRunAssignmentAuthorityGrant(
  workspacePath: string,
  grant: RunAssignmentAuthorityGrant,
): Promise<void> {
  const validatedGrant = validateGrant(grant, 'invalid-grant')
  const lockPath = grantMutationPath(
    workspacePath,
    validatedGrant.assignmentId,
  )
  return withFileMutationLock(authorityMutationPath(workspacePath), () =>
    withFileMutationLock(lockPath, () =>
      writeValidatedGrant(workspacePath, validatedGrant)))
}

async function writeValidatedGrant(
  workspacePath: string,
  grant: RunAssignmentAuthorityGrant,
): Promise<void> {
  const paths = await ensureAuthorityPaths(workspacePath)
  await validateParentGrant(paths, grant)
  const existing = await readGrantFromPaths(paths, grant.assignmentId)
  if (existing) return acceptIdempotentGrant(existing, grant)
  try {
    await publishGrant(paths, grant)
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error
    const concurrentlyPublished = await readGrantFromPaths(
      paths,
      grant.assignmentId,
    )
    if (!concurrentlyPublished) throw error
    acceptIdempotentGrant(concurrentlyPublished, grant)
  }
}

export async function readRunAssignmentAuthorityGrant(
  workspacePath: string,
  assignmentId: string,
): Promise<RunAssignmentAuthorityGrant | null> {
  requireSafeAssignmentId(assignmentId)
  const paths = await findAuthorityPaths(workspacePath)
  return paths ? readGrantFromPaths(paths, assignmentId) : null
}

export async function removeRunAssignmentAuthorityGrant(
  workspacePath: string,
  assignmentId: string,
): Promise<boolean> {
  requireSafeAssignmentId(assignmentId)
  return withFileMutationLock(
    authorityMutationPath(workspacePath),
    () => withFileMutationLock(
      grantMutationPath(workspacePath, assignmentId),
      () => removeValidatedGrant(workspacePath, assignmentId),
    ),
  )
}

export async function resolveRunAssignmentAuthorityChain(
  workspacePath: string,
  assignmentId: string,
): Promise<readonly RunAssignmentAuthorityGrant[] | null> {
  requireSafeAssignmentId(assignmentId)
  const paths = await findAuthorityPaths(workspacePath)
  if (!paths) return null
  const leaf = await readGrantFromPaths(paths, assignmentId)
  if (!leaf) return null
  return resolveChainFromLeaf(paths, leaf)
}

interface AuthorityPaths {
  readonly workspaceRoot: string
  readonly indexRoot: string
  readonly authorityRoot: string
  readonly workspaceIdentity: FileIdentity
  readonly indexIdentity: FileIdentity
  readonly authorityIdentity: FileIdentity
}

interface FileIdentity {
  readonly device: number
  readonly inode: number
}

const GRANT_FIELDS = [
  'version',
  'sessionId',
  'runId',
  'taskId',
  'assignmentId',
  'parentAssignmentId',
  'depth',
] as const

const MAX_GRANT_FILE_BYTES = 16 * 1024
const MAX_GRANT_IDENTIFIER_LENGTH = 512

async function ensureAuthorityPaths(
  workspacePath: string,
): Promise<AuthorityPaths> {
  const workspaceRoot = await requireCanonicalWorkspace(workspacePath)
  const indexRoot = await ensureCanonicalChildDirectory(
    workspaceRoot,
    'run-index',
  )
  const authorityRoot = await ensureCanonicalChildDirectory(
    indexRoot,
    'authority',
    true,
  )
  return captureAuthorityPaths(workspaceRoot, indexRoot, authorityRoot)
}

async function findAuthorityPaths(
  workspacePath: string,
): Promise<AuthorityPaths | null> {
  const workspaceRoot = await requireCanonicalWorkspace(workspacePath)
  const indexRoot = await findCanonicalChildDirectory(
    workspaceRoot,
    'run-index',
  )
  if (!indexRoot) return null
  const authorityRoot = await findCanonicalChildDirectory(
    indexRoot,
    'authority',
    true,
  )
  return authorityRoot
    ? captureAuthorityPaths(workspaceRoot, indexRoot, authorityRoot)
    : null
}

async function requireCanonicalWorkspace(
  workspacePath: string,
): Promise<string> {
  if (!path.isAbsolute(workspacePath) || path.resolve(workspacePath) !== workspacePath) {
    throw noncanonicalPathError('Workspace path must be absolute and normalized.')
  }
  const stat = await lstatOrNull(workspacePath)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw noncanonicalPathError('Workspace path must be a real directory.')
  }
  const realPath = await fsp.realpath(workspacePath).catch(() => null)
  if (realPath !== workspacePath) {
    throw noncanonicalPathError('Workspace path must be canonical.')
  }
  return realPath
}

async function ensureCanonicalChildDirectory(
  parentPath: string,
  name: string,
  requirePrivateMode = false,
): Promise<string> {
  const existing = await findCanonicalChildDirectory(
    parentPath,
    name,
    requirePrivateMode,
  )
  if (existing) return existing
  const childPath = path.join(parentPath, name)
  try {
    await fsp.mkdir(childPath, { mode: 0o700 })
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error
  }
  const created = await findCanonicalChildDirectory(
    parentPath,
    name,
    requirePrivateMode,
  )
  if (!created) {
    throw noncanonicalPathError(`Authority path is unavailable: ${name}`)
  }
  return created
}

async function findCanonicalChildDirectory(
  parentPath: string,
  name: string,
  requirePrivateMode = false,
): Promise<string | null> {
  const childPath = path.join(parentPath, name)
  const stat = await lstatOrNull(childPath)
  if (!stat) return null
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw noncanonicalPathError(`Authority path is not a directory: ${name}`)
  }
  const realPath = await fsp.realpath(childPath).catch(() => null)
  if (realPath !== childPath || (requirePrivateMode && !hasPrivateDirectoryMode(stat))) {
    throw noncanonicalPathError(`Authority path is not canonical: ${name}`)
  }
  return childPath
}

async function captureAuthorityPaths(
  workspaceRoot: string,
  indexRoot: string,
  authorityRoot: string,
): Promise<AuthorityPaths> {
  const [workspaceStat, indexStat, authorityStat, workspaceReal, indexReal, authorityReal] =
    await Promise.all([
      fsp.lstat(workspaceRoot),
      fsp.lstat(indexRoot),
      fsp.lstat(authorityRoot),
      fsp.realpath(workspaceRoot),
      fsp.realpath(indexRoot),
      fsp.realpath(authorityRoot),
    ])
  if (
    !isCanonicalDirectory(workspaceStat, workspaceReal, workspaceRoot) ||
    !isCanonicalDirectory(indexStat, indexReal, indexRoot) ||
    !isCanonicalDirectory(authorityStat, authorityReal, authorityRoot) ||
    !hasPrivateDirectoryMode(authorityStat)
  ) {
    throw noncanonicalPathError('Authority store directories are not canonical.')
  }
  return {
    workspaceRoot,
    indexRoot,
    authorityRoot,
    workspaceIdentity: identityFromStat(workspaceStat),
    indexIdentity: identityFromStat(indexStat),
    authorityIdentity: identityFromStat(authorityStat),
  }
}

async function validateAuthorityPaths(paths: AuthorityPaths): Promise<void> {
  let current: AuthorityPaths
  try {
    current = await captureAuthorityPaths(
      paths.workspaceRoot,
      paths.indexRoot,
      paths.authorityRoot,
    )
  } catch (error) {
    if (error instanceof RunAssignmentAuthorityStoreError) throw error
    throw noncanonicalPathError('Authority store paths changed.', error)
  }
  if (
    !sameFileIdentity(paths.workspaceIdentity, current.workspaceIdentity) ||
    !sameFileIdentity(paths.indexIdentity, current.indexIdentity) ||
    !sameFileIdentity(paths.authorityIdentity, current.authorityIdentity)
  ) {
    throw noncanonicalPathError('Authority store path identity changed.')
  }
}

function isCanonicalDirectory(
  stat: fs.Stats,
  realPath: string,
  expectedPath: string,
): boolean {
  return stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    realPath === expectedPath
}

async function readGrantFromPaths(
  paths: AuthorityPaths,
  assignmentId: string,
): Promise<RunAssignmentAuthorityGrant | null> {
  await validateAuthorityPaths(paths)
  const grantPath = path.join(paths.authorityRoot, `${assignmentId}.json`)
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(grantPath, readNoFollowFlags())
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      await validateAuthorityPaths(paths)
      return null
    }
    throw noncanonicalPathError('Authority grant could not be opened safely.', error)
  }
  try {
    await validateOpenedGrant(paths, grantPath, handle)
    const content = await handle.readFile({ encoding: 'utf8' })
    await validateOpenedGrant(paths, grantPath, handle)
    return parsePersistedGrant(content, assignmentId)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function validateOpenedGrant(
  paths: AuthorityPaths,
  grantPath: string,
  handle: fsp.FileHandle,
  options: {
    readonly expectedIdentity?: FileIdentity
    readonly allowAnySize?: boolean
  } = {},
): Promise<void> {
  const [handleStat, pathStat, realPath] = await Promise.all([
    handle.stat(),
    fsp.lstat(grantPath).catch(() => null),
    fsp.realpath(grantPath).catch(() => null),
  ])
  if (
    !handleStat.isFile() ||
    (!options.allowAnySize &&
      (handleStat.size < 1 || handleStat.size > MAX_GRANT_FILE_BYTES)) ||
    !hasPrivateFileMode(handleStat) ||
    !pathStat?.isFile() ||
    pathStat.isSymbolicLink() ||
    !hasPrivateFileMode(pathStat) ||
    !sameStatIdentity(handleStat, pathStat) ||
    realPath !== grantPath ||
    (options.expectedIdentity !== undefined &&
      !sameFileIdentity(options.expectedIdentity, identityFromStat(handleStat)))
  ) {
    throw noncanonicalPathError('Authority grant must be a private regular file.')
  }
  await validateAuthorityPaths(paths)
}

async function removeValidatedGrant(
  workspacePath: string,
  assignmentId: string,
): Promise<boolean> {
  const paths = await findAuthorityPaths(workspacePath)
  if (!paths) return false
  const grantPath = path.join(paths.authorityRoot, `${assignmentId}.json`)
  let handle = await openGrantForRemoval(paths, grantPath)
  if (!handle) return false
  try {
    await validateOpenedGrant(paths, grantPath, handle, { allowAnySize: true })
    const identity = identityFromStat(await handle.stat())
    if (process.platform === 'win32') {
      await handle.close()
      handle = undefined
    }
    await unlinkExactGrant(paths, grantPath, identity)
  } finally {
    await handle?.close().catch(() => undefined)
  }
  await removeAuthorityDirectoryIfEmpty(paths)
  return true
}

async function openGrantForRemoval(
  paths: AuthorityPaths,
  grantPath: string,
): Promise<fsp.FileHandle | undefined> {
  await validateAuthorityPaths(paths)
  try {
    return await fsp.open(grantPath, readNoFollowFlags())
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      await validateAuthorityPaths(paths)
      return undefined
    }
    throw noncanonicalPathError('Authority grant could not be opened safely.', error)
  }
}

async function unlinkExactGrant(
  paths: AuthorityPaths,
  grantPath: string,
  expectedIdentity: FileIdentity,
): Promise<void> {
  const before = await fsp.lstat(grantPath).catch(() => null)
  if (!before || !sameFileIdentity(expectedIdentity, identityFromStat(before))) {
    throw noncanonicalPathError('Authority grant identity changed before removal.')
  }
  await validateAuthorityPaths(paths)
  await fsp.unlink(grantPath)
  if (await lstatOrNull(grantPath)) {
    throw noncanonicalPathError('Authority grant removal could not be verified.')
  }
  await validateAuthorityPaths(paths)
}

async function removeAuthorityDirectoryIfEmpty(
  paths: AuthorityPaths,
): Promise<void> {
  await validateAuthorityPaths(paths)
  const entries = await fsp.readdir(paths.authorityRoot)
  if (entries.length > 0) return
  await validateAuthorityPaths(paths)
  try {
    await fsp.rmdir(paths.authorityRoot)
  } catch (error) {
    if (hasErrorCode(error, 'ENOTEMPTY')) return
    if (!hasErrorCode(error, 'ENOENT')) throw error
  }
  await validateAuthorityParentPaths(paths)
  if (await lstatOrNull(paths.authorityRoot)) {
    throw noncanonicalPathError('Authority directory removal could not be verified.')
  }
}

async function validateAuthorityParentPaths(
  paths: AuthorityPaths,
): Promise<void> {
  const [workspaceStat, indexStat, workspaceReal, indexReal] =
    await Promise.all([
      fsp.lstat(paths.workspaceRoot),
      fsp.lstat(paths.indexRoot),
      fsp.realpath(paths.workspaceRoot),
      fsp.realpath(paths.indexRoot),
    ])
  if (
    !isCanonicalDirectory(workspaceStat, workspaceReal, paths.workspaceRoot) ||
    !isCanonicalDirectory(indexStat, indexReal, paths.indexRoot) ||
    !sameFileIdentity(paths.workspaceIdentity, identityFromStat(workspaceStat)) ||
    !sameFileIdentity(paths.indexIdentity, identityFromStat(indexStat))
  ) {
    throw noncanonicalPathError('Authority parent path identity changed.')
  }
}

function parsePersistedGrant(
  content: string,
  expectedAssignmentId: string,
): RunAssignmentAuthorityGrant {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw corruptGrantError('Authority grant is not valid JSON.', error)
  }
  const grant = validateGrant(value, 'corrupt-grant')
  if (grant.assignmentId !== expectedAssignmentId) {
    throw corruptGrantError('Authority grant identity does not match its file.')
  }
  return grant
}

function validateGrant(
  value: unknown,
  errorCode: 'invalid-grant' | 'corrupt-grant',
): RunAssignmentAuthorityGrant {
  if (!isJsonObject(value) || !hasExactGrantFields(value)) {
    throw grantValidationError(errorCode)
  }
  const { version, sessionId, runId, taskId, assignmentId, parentAssignmentId, depth } = value
  if (
    version !== RUN_ASSIGNMENT_AUTHORITY_GRANT_VERSION ||
    !isSafeIdentifier(sessionId) ||
    !isSafeIdentifier(runId) ||
    !isSafeIdentifier(taskId) ||
    !isSafeIdentifier(assignmentId) ||
    !isValidDepth(depth) ||
    !isValidParent(parentAssignmentId, depth)
  ) {
    throw grantValidationError(errorCode)
  }
  return { version, sessionId, runId, taskId, assignmentId, parentAssignmentId, depth }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactGrantFields(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  return keys.length === GRANT_FIELDS.length &&
    GRANT_FIELDS.every((field) => Object.hasOwn(value, field))
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= MAX_GRANT_IDENTIFIER_LENGTH &&
    !/[\0-\x1f\x7f]/u.test(value) &&
    isSafePathSegment(value)
}

function isValidDepth(value: unknown): value is number {
  return Number.isInteger(value) &&
    typeof value === 'number' &&
    value >= 0 &&
    value <= MAX_RUN_ASSIGNMENT_AUTHORITY_DEPTH
}

function isValidParent(
  value: unknown,
  depth: number,
): value is string | null {
  return depth === 0 ? value === null : isSafeIdentifier(value)
}

async function validateParentGrant(
  paths: AuthorityPaths,
  grant: RunAssignmentAuthorityGrant,
): Promise<void> {
  if (grant.depth === 0) return
  const parentId = grant.parentAssignmentId
  if (!parentId) throw invalidLineageError()
  const parent = await readGrantFromPaths(paths, parentId)
  if (!parent || !isDirectParent(parent, grant)) {
    throw invalidLineageError()
  }
}

async function resolveChainFromLeaf(
  paths: AuthorityPaths,
  leaf: RunAssignmentAuthorityGrant,
): Promise<readonly RunAssignmentAuthorityGrant[]> {
  const reversed: RunAssignmentAuthorityGrant[] = []
  const visited = new Set<string>()
  let current = leaf
  while (reversed.length <= MAX_RUN_ASSIGNMENT_AUTHORITY_DEPTH) {
    if (visited.has(current.assignmentId)) throw invalidLineageError()
    visited.add(current.assignmentId)
    reversed.push(current)
    if (current.depth === 0) return validateResolvedChain(reversed, leaf)
    const parentId = current.parentAssignmentId
    if (!parentId) throw invalidLineageError()
    const parent = await readGrantFromPaths(paths, parentId)
    if (!parent || !isDirectParent(parent, current)) throw invalidLineageError()
    current = parent
  }
  throw invalidLineageError()
}

function validateResolvedChain(
  reversed: readonly RunAssignmentAuthorityGrant[],
  leaf: RunAssignmentAuthorityGrant,
): readonly RunAssignmentAuthorityGrant[] {
  if (reversed.length !== leaf.depth + 1) throw invalidLineageError()
  return [...reversed].reverse()
}

function isDirectParent(
  parent: RunAssignmentAuthorityGrant,
  child: RunAssignmentAuthorityGrant,
): boolean {
  return child.parentAssignmentId === parent.assignmentId &&
    child.depth === parent.depth + 1 &&
    child.sessionId === parent.sessionId &&
    child.runId === parent.runId &&
    child.taskId === parent.taskId
}

function acceptIdempotentGrant(
  existing: RunAssignmentAuthorityGrant,
  incoming: RunAssignmentAuthorityGrant,
): void {
  if (sameGrant(existing, incoming)) return
  throw new RunAssignmentAuthorityStoreError(
    'conflict',
    `Authority grant already exists: ${incoming.assignmentId}`,
  )
}

function sameGrant(
  left: RunAssignmentAuthorityGrant,
  right: RunAssignmentAuthorityGrant,
): boolean {
  return GRANT_FIELDS.every((field) => left[field] === right[field])
}

async function publishGrant(
  paths: AuthorityPaths,
  grant: RunAssignmentAuthorityGrant,
): Promise<void> {
  const targetPath = path.join(
    paths.authorityRoot,
    `${grant.assignmentId}.json`,
  )
  const temporaryPath = path.join(
    paths.authorityRoot,
    `.${grant.assignmentId}.${process.pid}.${randomUUID()}.tmp`,
  )
  const contents = Buffer.from(`${JSON.stringify(grant, null, 2)}\n`, 'utf8')
  let handle: fsp.FileHandle | undefined
  let temporaryIdentity: FileIdentity | undefined
  try {
    await validateAuthorityPaths(paths)
    handle = await fsp.open(temporaryPath, exclusiveWriteNoFollowFlags(), 0o600)
    await handle.writeFile(contents)
    await handle.sync()
    temporaryIdentity = await validateOpenedTemporary(
      paths,
      temporaryPath,
      handle,
      contents.byteLength,
    )
    await fsp.link(temporaryPath, targetPath)
    let publishedHandle: fsp.FileHandle | undefined
    try {
      publishedHandle = await fsp.open(targetPath, readNoFollowFlags())
      await validateOpenedGrant(
        paths,
        targetPath,
        publishedHandle,
        { expectedIdentity: temporaryIdentity },
      )
    } finally {
      await publishedHandle?.close().catch(() => undefined)
    }
    await syncAuthorityDirectory(paths)
  } finally {
    await handle?.close().catch(() => undefined)
    if (temporaryIdentity) {
      await removePathIfIdentity(temporaryPath, temporaryIdentity)
    }
  }
}

async function validateOpenedTemporary(
  paths: AuthorityPaths,
  temporaryPath: string,
  handle: fsp.FileHandle,
  expectedSize: number,
): Promise<FileIdentity> {
  const [handleStat, pathStat, realPath] = await Promise.all([
    handle.stat(),
    fsp.lstat(temporaryPath).catch(() => null),
    fsp.realpath(temporaryPath).catch(() => null),
  ])
  if (
    !handleStat.isFile() ||
    handleStat.size !== expectedSize ||
    !hasPrivateFileMode(handleStat) ||
    !pathStat?.isFile() ||
    pathStat.isSymbolicLink() ||
    !sameStatIdentity(handleStat, pathStat) ||
    realPath !== temporaryPath
  ) {
    throw noncanonicalPathError('Authority grant staging file is unsafe.')
  }
  await validateAuthorityPaths(paths)
  return identityFromStat(handleStat)
}

async function syncAuthorityDirectory(paths: AuthorityPaths): Promise<void> {
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(paths.authorityRoot, directoryReadNoFollowFlags())
    const handleStat = await handle.stat()
    if (
      !handleStat.isDirectory() ||
      !sameFileIdentity(paths.authorityIdentity, identityFromStat(handleStat))
    ) {
      throw noncanonicalPathError('Authority directory handle is unsafe.')
    }
    await validateAuthorityPaths(paths)
    await handle.sync().catch((error: unknown) => {
      if (process.platform !== 'win32') throw error
    })
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function removePathIfIdentity(
  candidatePath: string,
  expectedIdentity: FileIdentity,
): Promise<void> {
  const stat = await lstatOrNull(candidatePath)
  if (!stat || !sameFileIdentity(expectedIdentity, identityFromStat(stat))) return
  await fsp.unlink(candidatePath).catch(() => undefined)
}

function readNoFollowFlags(): number {
  return fs.constants.O_RDONLY | noFollowFlag()
}

function directoryReadNoFollowFlags(): number {
  return fs.constants.O_RDONLY | noFollowFlag()
}

function exclusiveWriteNoFollowFlags(): number {
  return fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    noFollowFlag()
}

function noFollowFlag(): number {
  return process.platform !== 'win32' &&
    typeof fs.constants.O_NOFOLLOW === 'number'
    ? fs.constants.O_NOFOLLOW
    : 0
}

function identityFromStat(stat: fs.Stats): FileIdentity {
  return { device: stat.dev, inode: stat.ino }
}

function sameStatIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function requireSafeAssignmentId(assignmentId: string): void {
  if (isSafeIdentifier(assignmentId)) return
  throw grantValidationError('invalid-grant')
}

function grantMutationPath(
  workspacePath: string,
  assignmentId: string,
): string {
  return path.resolve(
    workspacePath,
    'run-index',
    'authority',
    `${assignmentId}.json`,
  )
}

function authorityMutationPath(workspacePath: string): string {
  return path.resolve(workspacePath, 'run-index', 'authority')
}

async function lstatOrNull(candidatePath: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(candidatePath)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expectedCode
}

function hasPrivateDirectoryMode(stat: fs.Stats): boolean {
  return process.platform === 'win32' || (stat.mode & 0o777) === 0o700
}

function hasPrivateFileMode(stat: fs.Stats): boolean {
  return process.platform === 'win32' || (stat.mode & 0o777) === 0o600
}

function grantValidationError(
  code: 'invalid-grant' | 'corrupt-grant',
): RunAssignmentAuthorityStoreError {
  return new RunAssignmentAuthorityStoreError(
    code,
    code === 'invalid-grant'
      ? 'Run assignment authority grant is invalid.'
      : 'Persisted run assignment authority grant is invalid.',
  )
}

function noncanonicalPathError(
  message: string,
  cause?: unknown,
): RunAssignmentAuthorityStoreError {
  return new RunAssignmentAuthorityStoreError(
    'noncanonical-path',
    message,
    { cause },
  )
}

function corruptGrantError(
  message: string,
  cause?: unknown,
): RunAssignmentAuthorityStoreError {
  return new RunAssignmentAuthorityStoreError(
    'corrupt-grant',
    message,
    { cause },
  )
}

function invalidLineageError(): RunAssignmentAuthorityStoreError {
  return new RunAssignmentAuthorityStoreError(
    'invalid-lineage',
    'Run assignment authority lineage is incomplete or inconsistent.',
  )
}
