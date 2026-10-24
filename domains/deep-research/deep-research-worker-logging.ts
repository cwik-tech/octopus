import * as fs from 'node:fs'
import * as path from 'node:path'

import { isSafePathSegment } from '../../core/path-safety.js'
import { getRunRuntimePaths } from '../../domains/runtime/runtime-paths.js'

export type DeepResearchWorkerFailureCategory =
  | 'no_web_capability_result'
  /** Written before the gate became route-neutral; still read from old logs. */
  | 'no_browser_observation'
  | 'response_schema_invalid'
  | 'binding_invalid'
  | 'dispatch_failed'

const FAILURE_MESSAGES: Readonly<Record<DeepResearchWorkerFailureCategory, string>> = {
  no_web_capability_result: 'No governed web capability returned a result.',
  no_browser_observation: 'Managed Browser produced no usable observation.',
  response_schema_invalid: 'Provider response did not satisfy the EvidencePacket schema.',
  binding_invalid: 'EvidencePacket did not match the approved assignment or runtime source observation receipts.',
  dispatch_failed: 'The attempt ended before validation: the provider timed out, stalled, or crashed.',
}

/** Resolve one private, lane-specific log directory without following links. */
export function prepareDeepResearchWorkerLogDirectory(input: {
  readonly assignmentPath: string
  readonly laneId: string
}): string {
  if (!isSafePathSegment(input.laneId)) {
    throw new Error('Deep Research worker lane is invalid.')
  }
  const { privateRuntimePath } = getRunRuntimePaths(input.assignmentPath)
  ensureOwnedDirectory(privateRuntimePath, 'Deep Research private runtime')
  const workerLogsPath = path.join(privateRuntimePath, 'worker-logs')
  ensureOwnedDirectory(workerLogsPath, 'Deep Research worker logs')
  const lanePath = path.join(workerLogsPath, input.laneId)
  ensureOwnedDirectory(lanePath, 'Deep Research worker lane logs')
  return lanePath
}

/** Persist only a sanitized validation category; never persist provider output. */
export function appendDeepResearchWorkerFailure(input: {
  readonly assignmentPath: string
  readonly laneId: string
  readonly taskId?: string
  readonly attempt?: number
  readonly category: DeepResearchWorkerFailureCategory
  readonly attemptDirName?: string
}): void {
  const lanePath = prepareDeepResearchWorkerLogDirectory(input)
  const failurePath = path.join(lanePath, 'validation.jsonl')
  assertOwnedLogFile(failurePath)
  const descriptor = fs.openSync(
    failurePath,
    fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      fs.constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('Deep Research worker validation log is invalid.')
    fs.fchmodSync(descriptor, 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...(input.taskId ? { task_id: input.taskId } : {}),
      lane_id: input.laneId,
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      category: input.category,
      message: FAILURE_MESSAGES[input.category],
      ...(input.attemptDirName ? { attempt_dir: input.attemptDirName } : {}),
    })}\n`)
  } finally {
    fs.closeSync(descriptor)
  }
}

export type DeepResearchWorkerAttemptOutcome =
  | 'accepted'
  | 'rejected'
  | 'no_response'

export interface DeepResearchWorkerAttemptValidator {
  readonly name: string
  readonly field?: string
  readonly message: string
  readonly category: string
}

/** Attempt records stay in the private tier; keep the disk budget bounded. */
const MAX_ATTEMPT_PROMPT_BYTES = 1_048_576
const MAX_ATTEMPT_RESPONSE_BYTES = 1_048_576
const ATTEMPT_RECORD_RETENTION = 12

function isWorkerAttemptDirectoryName(name: string): boolean {
  return /^.*-attempt(-\d+)?(-r\d+)?$/.test(name) || /^attempt-unknown(-r\d+)?$/.test(name)
}

function nextFreeAttemptDirectoryName(lanePath: string, baseName: string): string {
  if (!fs.existsSync(path.join(lanePath, baseName))) return baseName
  for (let revision = 2; ; revision += 1) {
    const candidate = `${baseName}-r${revision}`
    if (!fs.existsSync(path.join(lanePath, candidate))) return candidate
  }
}

function writeOwnedPrivateFile(
  filePath: string,
  content: string,
  label: string,
): void {
  assertOwnedLogFile(filePath)
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw new Error(`${label} path is invalid.`)
    fs.fchmodSync(descriptor, 0o600)
    fs.writeFileSync(descriptor, content)
  } finally {
    fs.closeSync(descriptor)
  }
}

const TRUNCATION_NOTICE = '\n[truncated by runtime retention cap]\n'

/**
 * Bound a value to `maximumBytes` **including** the truncation notice.
 *
 * The notice has to fit inside the budget, not be appended after it: a cap
 * that the truncated output exceeds is not a cap, and these files exist
 * precisely to stop a runaway prompt or response filling the private log.
 */
function boundedUtf8(value: string, maximumBytes: number): string {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.byteLength <= maximumBytes) return value
  const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8')
  const budget = Math.max(0, maximumBytes - noticeBytes)
  return `${buffer.subarray(0, budget).toString('utf8')}${TRUNCATION_NOTICE}`
}

function collectAttemptObservationStats(input: {
  readonly assignmentPath: string
  readonly laneId: string
  readonly attemptStartedAtMs: number
  readonly elapsedMs: number
}): { count: number; time_to_first_observation_ms: number; observations_per_minute: number } | undefined {
  const observationsPath = path.join(
    input.assignmentPath,
    'research',
    'observations',
    input.laneId,
  )
  let receiptNames: string[]
  try {
    receiptNames = fs.readdirSync(observationsPath).filter((name) => name.endsWith('.json'))
  } catch {
    return undefined
  }
  const observedTimes: number[] = []
  for (const name of receiptNames) {
    try {
      const stat = fs.statSync(path.join(observationsPath, name))
      if (stat.mtimeMs >= input.attemptStartedAtMs) observedTimes.push(stat.mtimeMs)
    } catch {
      // A concurrently pruned receipt is not an observability failure.
    }
  }
  if (observedTimes.length === 0) return undefined
  const first = Math.min(...observedTimes) - input.attemptStartedAtMs
  const minutes = Math.max(input.elapsedMs, 1) / 60_000
  return {
    count: observedTimes.length,
    time_to_first_observation_ms: Math.max(0, Math.round(first)),
    observations_per_minute: Math.round((observedTimes.length / minutes) * 100) / 100,
  }
}

function pruneWorkerAttemptRecords(lanePath: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(lanePath, { withFileTypes: true })
  } catch {
    return
  }
  const attemptDirectories = entries
    .filter((entry) => entry.isDirectory() && isWorkerAttemptDirectoryName(entry.name))
    .map((entry) => ({
      fullPath: path.join(lanePath, entry.name),
      modifiedAtMs: fs.statSync(path.join(lanePath, entry.name)).mtimeMs,
      baseAttempt: Number(entry.name.match(/-attempt-(\d+)/)?.[1] ?? 0),
    }))
    .sort((a, b) =>
      b.modifiedAtMs - a.modifiedAtMs || b.baseAttempt - a.baseAttempt)
  for (const stale of attemptDirectories.slice(ATTEMPT_RECORD_RETENTION)) {
    try {
      fs.rmSync(stale.fullPath, { recursive: true, force: true })
    } catch {
      // Retention is best-effort; never fail the attempt record for it.
    }
  }
}

/**
 * Persist one private, per-attempt worker record: the exact dispatched prompt,
 * the raw unvalidated response, and a classified outcome with validator detail
 * and observation timing. Returns the attempt directory name for indexing, or
 * undefined when the lane id is invalid.
 */
export function persistDeepResearchWorkerAttemptRecord(input: {
  readonly assignmentPath: string
  readonly laneId: string
  readonly taskId?: string
  readonly attempt?: number
  readonly systemPrompt: string
  readonly userMessage: string
  readonly responseText?: string
  readonly outcome: DeepResearchWorkerAttemptOutcome
  readonly validator?: DeepResearchWorkerAttemptValidator
  readonly attemptStartedAtMs: number
  readonly elapsedMs: number
}): string | undefined {
  const lanePath = prepareDeepResearchWorkerLogDirectory(input)
  const baseName = input.taskId !== undefined && input.attempt !== undefined
    ? `${input.taskId}-attempt-${input.attempt}`
    : 'attempt-unknown'
  const attemptDirName = nextFreeAttemptDirectoryName(lanePath, baseName)
  const attemptPath = path.join(lanePath, attemptDirName)
  ensureOwnedDirectory(attemptPath, 'Deep Research worker attempt record')

  writeOwnedPrivateFile(
    path.join(attemptPath, 'prompt.md'),
    boundedUtf8(
      [
        '# Dispatched System Prompt',
        '',
        input.systemPrompt,
        '',
        '# Dispatched User Message',
        '',
        input.userMessage,
        '',
      ].join('\n'),
      MAX_ATTEMPT_PROMPT_BYTES,
    ),
    'Deep Research worker attempt prompt',
  )
  if (input.responseText !== undefined && input.responseText.length > 0) {
    writeOwnedPrivateFile(
      path.join(attemptPath, 'response.txt'),
      boundedUtf8(input.responseText, MAX_ATTEMPT_RESPONSE_BYTES),
      'Deep Research worker attempt response',
    )
  }
  const observations = collectAttemptObservationStats(input)
  writeOwnedPrivateFile(
    path.join(attemptPath, 'outcome.json'),
    `${JSON.stringify({
      outcome: input.outcome,
      ...(input.taskId ? { task_id: input.taskId } : {}),
      lane_id: input.laneId,
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      started_at: new Date(input.attemptStartedAtMs).toISOString(),
      elapsed_ms: input.elapsedMs,
      ...(input.validator ? { validator: input.validator } : {}),
      ...(observations ? { observations } : {}),
    }, null, 2)}\n`,
    'Deep Research worker attempt outcome',
  )
  pruneWorkerAttemptRecords(lanePath)
  return attemptDirName
}

/** Cap one persisted tool-loop message so a huge tool result cannot dominate. */
const MAX_TOOL_LOOP_MESSAGE_BYTES = 262_144

/**
 * Persist one provider tool-loop turn: the ordered messages that formed the
 * worker's context, including every tool call and tool result.
 *
 * CLI providers stream their own protocol transcript into this same directory;
 * providers driven by the in-process tool loop have no such stream, so without
 * this the tool traffic of a DeepSeek-style turn leaves no record at all.
 */
export function persistDeepResearchWorkerToolLoopMessages(input: {
  readonly laneLogDirectory: string
  readonly turnStartedAt: string
  readonly model?: string
  readonly messages: ReadonlyArray<Readonly<Record<string, unknown>>>
}): void {
  const logsPath = path.join(input.laneLogDirectory, 'logs')
  ensureOwnedDirectory(logsPath, 'Deep Research worker lane logs')
  const filePath = path.join(logsPath, 'tool-loop-messages.jsonl')
  assertOwnedLogFile(filePath)
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      fs.constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('Deep Research tool-loop log is invalid.')
    fs.fchmodSync(descriptor, 0o600)
    const lines = input.messages.map((message, index) => {
      const serialized = JSON.stringify({
        turn_started_at: input.turnStartedAt,
        ...(input.model ? { model: input.model } : {}),
        sequence: index,
        message,
      })
      return serialized.length > MAX_TOOL_LOOP_MESSAGE_BYTES
        ? JSON.stringify({
          turn_started_at: input.turnStartedAt,
          ...(input.model ? { model: input.model } : {}),
          sequence: index,
          truncated: true,
          message: {
            role: message.role,
            preview: serialized.slice(0, MAX_TOOL_LOOP_MESSAGE_BYTES),
          },
        })
        : serialized
    })
    fs.writeFileSync(descriptor, `${lines.join('\n')}\n`)
  } finally {
    fs.closeSync(descriptor)
  }
}

function ensureOwnedDirectory(directoryPath: string, label: string): void {
  try {
    const stat = fs.lstatSync(directoryPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} path is invalid.`)
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    fs.mkdirSync(directoryPath, { recursive: false, mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const created = fs.lstatSync(directoryPath)
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`${label} path is invalid.`)
  }
}

function assertOwnedLogFile(filePath: string): void {
  try {
    const stat = fs.lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Deep Research worker validation log path is invalid.')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
