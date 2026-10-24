import { TASK_SUPERVISOR_GRACEFUL_TIMEOUT_MS } from '../../core/constants.js'
import { execFileSync } from 'node:child_process'

import type { SessionTask } from './session-types.js'

export const PROCESS_IDENTITY_ARGUMENT = '--runtime-process-identity='

export type ProcessSignal = (target: number, signal: NodeJS.Signals) => void
export type ProcessProbe = (target: number) => boolean

export interface TaskTerminationController {
  signal: AbortSignal
  dispose(): void
}

export interface TaskTerminationSignalSource {
  once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown
  off(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown
}

export interface PosixProcessStateRow {
  pid: number
  processGroupId: number
  state: string
}

export function posixProcessRowsContainLiveTarget(
  rows: readonly PosixProcessStateRow[],
  target: number,
): boolean {
  const identifier = Math.abs(target)
  return rows.some((row) => {
    const matches = target < 0
      ? row.processGroupId === identifier
      : row.pid === identifier
    return matches && !row.state.startsWith('Z')
  })
}

export function createTaskTerminationController(
  processSignals: TaskTerminationSignalSource = process,
): TaskTerminationController {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  processSignals.once('SIGTERM', abort)
  processSignals.once('SIGINT', abort)
  return {
    signal: controller.signal,
    dispose() {
      processSignals.off('SIGTERM', abort)
      processSignals.off('SIGINT', abort)
    },
  }
}

export interface LocatedTaskProcess {
  pid: number
  processGroupId?: number
}

export type TaskProcessIdentityClassification =
  | { kind: 'absent'; matches: readonly [] }
  | { kind: 'unique'; process: LocatedTaskProcess; matches: readonly LocatedTaskProcess[] }
  | { kind: 'ambiguous'; matches: readonly LocatedTaskProcess[] }

export interface TerminateTaskProcessOptions {
  signalProcess?: ProcessSignal
  isProcessAlive?: ProcessProbe
  isProcessIdentityValid?: (task: SessionTask) => boolean
  allowUnverifiedIdentity?: boolean
  gracefulTimeoutMs?: number
  forceTimeoutMs?: number
  pollIntervalMs?: number
}

export type TaskProcessTerminationResult =
  | 'exited'
  | 'identity_mismatch'
  | 'still_running'

export function taskProcessTarget(task: SessionTask): number | null {
  if (
    process.platform !== 'win32' &&
    typeof task.processGroupId === 'number' &&
    task.processGroupId > 0
  ) {
    return -task.processGroupId
  }
  return typeof task.pid === 'number' && task.pid > 0 ? task.pid : null
}

export function defaultIsProcessAlive(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function isTaskProcessIdentityValid(task: SessionTask): boolean {
  if (!task.processIdentity) return false
  const marker = `${PROCESS_IDENTITY_ARGUMENT}${task.processIdentity}`
  return readTaskProcessCommands(task).some((command) => command.includes(marker))
}

export function findTaskProcessByIdentity(
  processIdentity: string,
): LocatedTaskProcess | null {
  const classified = classifyTaskProcessesByIdentity(processIdentity)
  return classified.kind === 'unique' ? classified.process : null
}

export function classifyTaskProcessesByIdentity(
  processIdentity: string,
): TaskProcessIdentityClassification {
  if (!processIdentity.trim()) return { kind: 'absent', matches: [] }
  const marker = `${PROCESS_IDENTITY_ARGUMENT}${processIdentity}`
  const matches = process.platform === 'win32'
    ? findWindowsProcessesByMarker(marker)
    : findPosixProcessesByMarker(marker)
  const [first] = matches
  if (!first) return { kind: 'absent', matches: [] }
  if (matches.length === 1) {
    return { kind: 'unique', process: first, matches }
  }
  return { kind: 'ambiguous', matches }
}

export async function terminateTaskProcess(
  task: SessionTask,
  options: TerminateTaskProcessOptions = {},
): Promise<TaskProcessTerminationResult> {
  const target = taskProcessTarget(task)
  if (target == null) return 'exited'

  const isAlive = options.isProcessAlive ?? defaultIsTerminableProcessAlive
  if (!isAlive(target)) return 'exited'

  const identityIsValid = task.processIdentity
    ? (options.isProcessIdentityValid ?? isTaskProcessIdentityValid)(task)
    : Boolean(options.allowUnverifiedIdentity)
  if (!identityIsValid) return isAlive(target) ? 'identity_mismatch' : 'exited'

  const signalProcess = options.signalProcess ?? process.kill.bind(process)
  signalIfAlive(target, 'SIGTERM', signalProcess, isAlive)
  if (
    await waitForProcessExit(
      target,
      options.gracefulTimeoutMs ?? TASK_SUPERVISOR_GRACEFUL_TIMEOUT_MS,
      options.pollIntervalMs ?? 25,
      isAlive,
    )
  ) {
    return 'exited'
  }

  signalIfAlive(target, 'SIGKILL', signalProcess, isAlive)
  return await waitForProcessExit(
    target,
    options.forceTimeoutMs ?? 1_000,
    options.pollIntervalMs ?? 25,
    isAlive,
  )
    ? 'exited'
    : 'still_running'
}

function readTaskProcessCommands(task: SessionTask): string[] {
  return process.platform === 'win32'
    ? readWindowsProcessCommand(task.pid)
    : readPosixProcessGroupCommands(task)
}

function readWindowsProcessCommand(pid: number | undefined): string[] {
  if (!pid) return []
  try {
    const command = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return command ? [command] : []
  } catch {
    return []
  }
}

function readPosixProcessGroupCommands(task: SessionTask): string[] {
  return readPosixProcessRows()
    .filter((row) => matchesTaskProcess(row, task))
    .map((row) => row.command)
}

function matchesTaskProcess(
  processRow: PosixProcessRow,
  task: SessionTask,
): boolean {
  return task.processGroupId
    ? processRow.processGroupId === task.processGroupId
    : processRow.pid === task.pid
}

interface PosixProcessRow {
  pid: number
  processGroupId: number
  state: string
  command: string
}

function readPosixProcessRows(): PosixProcessRow[] {
  return tryReadPosixProcessRows() ?? []
}

function tryReadPosixProcessRows(): PosixProcessRow[] | null {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,pgid=,stat=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output
      .split('\n')
      .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => ({
        pid: Number(match[1]),
        processGroupId: Number(match[2]),
        state: match[3] ?? '',
        command: match[4] ?? '',
      }))
  } catch {
    return null
  }
}

function defaultIsTerminableProcessAlive(target: number): boolean {
  if (!defaultIsProcessAlive(target)) return false
  if (process.platform === 'win32') return true
  const rows = tryReadPosixProcessRows()
  return rows === null ? true : posixProcessRowsContainLiveTarget(rows, target)
}

function findPosixProcessesByMarker(marker: string): LocatedTaskProcess[] {
  const matches = readPosixProcessRows().filter((row) =>
    row.command.includes(marker),
  )
  const groups = new Map<number, PosixProcessRow[]>()
  for (const match of matches) {
    const group = groups.get(match.processGroupId) ?? []
    group.push(match)
    groups.set(match.processGroupId, group)
  }
  return [...groups.values()].map((group) => {
    const selected = group.find((row) => row.pid === row.processGroupId) ?? group[0]
    if (!selected) throw new Error('Task process group has no process rows.')
    return { pid: selected.pid, processGroupId: selected.processGroupId }
  })
}

function findWindowsProcessesByMarker(marker: string): LocatedTaskProcess[] {
  const escapedMarker = marker.replaceAll("'", "''")
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          `$marker = '${escapedMarker}';`,
          'Get-CimInstance Win32_Process',
          '| Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like "*$marker*" }',
          '| Select-Object ProcessId',
          '| ConvertTo-Json -Compress',
        ].join(' '),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    if (!output) return []
    const parsed = JSON.parse(output) as
      | { ProcessId?: unknown }
      | Array<{ ProcessId?: unknown }>
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
      .map((row) => Number(row.ProcessId))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .map((pid) => ({ pid }))
  } catch {
    return []
  }
}

function signalIfAlive(
  target: number,
  signal: NodeJS.Signals,
  signalProcess: ProcessSignal,
  isAlive: ProcessProbe,
): void {
  if (!isAlive(target)) return
  try {
    signalProcess(target, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return
    // On macOS a process group whose last member has exited but is not yet
    // reaped refuses signals with EPERM. The probe does not count such a
    // member as alive, so a group that exited after the check above is gone.
    if (code === 'EPERM' && !isAlive(target)) return
    throw error
  }
}

async function waitForProcessExit(
  target: number,
  timeoutMs: number,
  pollIntervalMs: number,
  isAlive: ProcessProbe,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isAlive(target)) {
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())),
    )
  }
  return true
}
