/**
 * Where a provider turn's process record is kept.
 *
 * The shell around `domains/runtime/provider-turn-diagnostics.ts`: that module
 * owns what a record may contain and how it is validated, and this owns the
 * one thing it must not — the filesystem. Splitting them is what lets the
 * content rule be checked without a temporary directory, and the path rules be
 * checked with a real one.
 *
 * Records live beneath the assignment's private runtime, beside the rest of
 * that assignment's evidence, so they are removed with it and are visible to
 * an operator looking in the obvious place.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { getRunRuntimePaths } from '../domains/runtime/runtime-paths.js'
import {
  parseProviderTurnDiagnosticRecords,
  sanitizeProviderTurnDiagnosticRecord,
  type ProviderTurnDiagnosticEntry,
  type ProviderTurnDiagnosticRecord,
  type ProviderTurnDiagnosticsRecorder,
} from '../domains/runtime/provider-turn-diagnostics.js'

/** Directory beneath an assignment's private runtime that holds these. */
const DIAGNOSTICS_DIRECTORY_NAME = 'provider-turns'

/**
 * The largest record file this will read back.
 *
 * A turn can emit a great many protocol events, and a reader that loaded an
 * unbounded file would turn a diagnostic into a memory fault. Records past the
 * bound are dropped from the read, never from the file.
 */
const MAX_READ_BYTES = 4 * 1024 * 1024

/** A key that names a file, and nothing else. */
const TURN_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * How many protocol events one turn's record keeps.
 *
 * The stream half is the only unbounded part: a tool loop emits events for as
 * long as the model keeps working, and every one of them is a synchronous
 * open/append/close on the thread running the live turn. Capping it bounds
 * both the file and the syscalls to a fixed cost per turn.
 *
 * Large enough to show the shape of a turn that went wrong, and deliberately
 * not applied to anything else: the ending is what an operator came for, and a
 * cap that could swallow the exit record would defeat the whole record.
 */
const MAX_PROTOCOL_EVENT_RECORDS = 200
const MAX_CLI_DIAGNOSTIC_RECORDS = 64

/**
 * A recorder that never fails its caller.
 *
 * This is observability laid over a live turn. A diagnostic that could throw
 * would end turns that were working, which inverts the point of having one.
 */
export function createProviderTurnDiagnosticsRecorder(input: {
  readonly assignmentPath: string
  readonly turnKey: string
  readonly now?: () => Date
  /** Injected so the cap is testable without emitting two hundred events. */
  readonly maxProtocolEvents?: number
  readonly maxCliDiagnostics?: number
}): ProviderTurnDiagnosticsRecorder | undefined {
  const filePath = diagnosticsFilePath(input.assignmentPath, input.turnKey)
  if (!filePath) return undefined
  try {
    // Every component, checked and created one at a time. `O_NOFOLLOW` on the
    // open below guards the file it names and nothing above it, and
    // `mkdirSync(..., { recursive: true })` walks straight through a symlink
    // standing where a directory belongs — so a link dropped in the assignment
    // would send every record wherever it pointed. The assignment's own path
    // validation does not reach this child.
    ensureOwnedDirectory(path.dirname(filePath))
  } catch {
    return undefined
  }
  const clock = input.now ?? (() => new Date())
  const maxProtocolEvents = input.maxProtocolEvents ?? MAX_PROTOCOL_EVENT_RECORDS
  let protocolEvents = 0
  let truncationAnnounced = false
  let cliDiagnostics = 0
  let cliTruncationAnnounced = false
  const maxCliDiagnostics = input.maxCliDiagnostics ?? MAX_CLI_DIAGNOSTIC_RECORDS
  const append = (entry: ProviderTurnDiagnosticEntry): void => {
    try {
      const sanitized = sanitizeProviderTurnDiagnosticRecord(
        entry,
        clock().toISOString(),
      )
      if (!sanitized) return
      writeRecord(filePath, sanitized)
    } catch {
      // A record that cannot be written is a record nobody gets. It is not a
      // reason to fail the turn it was describing.
    }
  }
  return {
    record(entry: ProviderTurnDiagnosticEntry) {
      // Only the stream half is capped. Everything else is the account of how
      // the turn ended, which is what the record exists to preserve.
      if (entry.kind === 'provider-protocol-event') {
        protocolEvents += 1
        if (protocolEvents > maxProtocolEvents) {
          if (truncationAnnounced) return
          truncationAnnounced = true
          append({ kind: 'protocol-events-truncated', limit: maxProtocolEvents })
          return
        }
      }
      if (entry.kind === 'provider-cli-diagnostic') {
        cliDiagnostics += 1
        if (cliDiagnostics > maxCliDiagnostics) {
          if (!cliTruncationAnnounced) append({ kind: 'cli-diagnostics-truncated', limit: maxCliDiagnostics })
          cliTruncationAnnounced = true
          return
        }
      }
      append(entry)
    },
  }
}

function writeRecord(
  filePath: string,
  sanitized: ProviderTurnDiagnosticRecord,
): void {
  // `O_NOFOLLOW` so a symlink dropped in the assignment directory cannot
  // redirect this append somewhere outside it, and `0o600` so the file is no
  // more readable than the runtime that owns it.
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      fs.constants.O_NOFOLLOW,
    0o600,
  )
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(sanitized)}\n`)
  } finally {
    fs.closeSync(descriptor)
  }
}

/** Read one turn's record back, re-validating every line. */
export function readProviderTurnDiagnostics(
  assignmentPath: string,
  turnKey: string,
): readonly ProviderTurnDiagnosticRecord[] {
  const filePath = diagnosticsFilePath(assignmentPath, turnKey)
  if (!filePath) return []
  try {
    // The same rule as the writer's, for the same reason. `O_NOFOLLOW` refuses
    // a link in the final position only, so a link standing where the
    // directory belongs would have this read a file outside the assignment and
    // present it as that assignment's own record.
    assertOwnedDirectory(path.dirname(filePath))
    const handle = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    )
    try {
      const stat = fs.fstatSync(handle)
      if (!stat.isFile()) return []
      const length = Math.min(stat.size, MAX_READ_BYTES)
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, 0)
      return parseProviderTurnDiagnosticRecords(buffer.toString('utf8'))
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return []
  }
}

/**
 * Create a directory this runtime owns, refusing anything that is not one.
 *
 * `recursive: false` per component, so an existing entry has to survive an
 * `lstat` that rejects symbolic links before the walk continues through it.
 */
function assertOwnedDirectory(directoryPath: string): void {
  let current = path.isAbsolute(directoryPath) ? path.sep : ''
  for (const segment of directoryPath.split(path.sep)) {
    if (segment === '') continue
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('The provider diagnostics path is invalid.')
    }
  }
}

function ensureOwnedDirectory(directoryPath: string): void {
  const segments = directoryPath.split(path.sep)
  let current = path.isAbsolute(directoryPath) ? path.sep : ''
  for (const segment of segments) {
    if (segment === '') continue
    current = path.join(current, segment)
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (errnoCodeOf(error) !== 'ENOENT') throw error
    }
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('The provider diagnostics path is invalid.')
      }
      continue
    }
    try {
      fs.mkdirSync(current, { recursive: false, mode: 0o700 })
    } catch (error) {
      // Another writer created it between the check and the create. That is the
      // race this loop is allowed to lose; the `lstat` below still decides
      // whether what now exists is something this runtime may write into.
      if (errnoCodeOf(error) !== 'EEXIST') throw error
    }
    const created = fs.lstatSync(current)
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error('The provider diagnostics path is invalid.')
    }
  }
}

/**
 * An errno, without asserting a shape onto an unknown error.
 *
 * `catch` binds `unknown`, and the value is not always a Node error: a cause
 * put there by another layer can be anything at all.
 */
function errnoCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const code: unknown = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function diagnosticsFilePath(
  assignmentPath: string,
  turnKey: string,
): string | undefined {
  // A key that is not a plain segment names no file. Anything else would let a
  // caller's identity decide where this writes.
  if (!TURN_KEY_PATTERN.test(turnKey)) return undefined
  try {
    const { privateRuntimePath } = getRunRuntimePaths(assignmentPath)
    return path.join(
      privateRuntimePath,
      DIAGNOSTICS_DIRECTORY_NAME,
      `${turnKey}.jsonl`,
    )
  } catch {
    return undefined
  }
}
