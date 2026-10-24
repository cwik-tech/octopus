/**
 * The closer's strict view of processes (POSIX only).
 *
 * Unlike the supervisor's own listing, which returns an empty table when `ps`
 * fails (`domains/sessions/task-process-supervisor.ts`), a failure here is
 * always reported as one, so it can never read as "no process"
 * (`docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md`,
 * section 5).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export interface ProcessRow {
  readonly pid: number
  readonly processGroupId: number
  readonly state: string
  readonly command: string
}

export type ProcessTableRead =
  | { readonly kind: 'table'; readonly rows: readonly ProcessRow[] }
  | { readonly kind: 'failure'; readonly reason: string }

export type ProcessGroupState =
  | { readonly kind: 'alive' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'failure'; readonly reason: string }

const PROCESS_TABLE_TIMEOUT_MS = 10_000
const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/u

export interface ProcessTableReadOptions {
  /**
   * Leave out the row of the `ps` this read runs. That `ps` is the reader's
   * own child and shares its process group, so a reader asking what else runs
   * in its group must not count it.
   */
  readonly excludeOwnProbe?: boolean
}

/**
 * Every process, from `ps -axo pid=,pgid=,stat=,command=`. A `ps` that cannot
 * run, exits non-zero, times out, or prints any line that does not parse is a
 * failure.
 */
export async function readProcessTableStrict(options: ProcessTableReadOptions = {}): Promise<ProcessTableRead> {
  let output: string
  let probePid: number | undefined
  try {
    const listing = execFileAsync('ps', ['-axo', 'pid=,pgid=,stat=,command='], {
      encoding: 'utf8',
      timeout: PROCESS_TABLE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    })
    probePid = listing.child.pid
    const listed = await listing
    output = listed.stdout
  } catch (error) {
    return { kind: 'failure', reason: `ps could not list processes: ${describeError(error)}` }
  }
  const rows: ProcessRow[] = []
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    const match = PROCESS_ROW.exec(line)
    const [, pid, processGroupId, state, command] = match ?? []
    if (pid === undefined || processGroupId === undefined || state === undefined || command === undefined) {
      return { kind: 'failure', reason: `ps printed a line that does not parse: ${JSON.stringify(line)}` }
    }
    rows.push({ pid: Number(pid), processGroupId: Number(processGroupId), state, command })
  }
  if (!rows.some((row) => row.pid === process.pid)) {
    return { kind: 'failure', reason: 'ps did not list the process reading it' }
  }
  return {
    kind: 'table',
    rows: options.excludeOwnProbe && probePid !== undefined ? rows.filter((row) => row.pid !== probePid) : rows,
  }
}

/**
 * Whether any process of group `processGroupId` still runs.
 *
 * `kill(-pgid, 0)` alone decides: ESRCH is gone; success or EPERM is alive;
 * anything else is a failure. No process table can turn a live answer into a
 * gone one: a table read earlier may predate a group that exists now. A group
 * whose last member exited but is not yet reaped therefore reads as alive
 * until it is reaped, which only ever holds a scope, never releases one.
 */
export function probeProcessGroup(processGroupId: number): ProcessGroupState {
  try {
    process.kill(-processGroupId, 0)
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return { kind: 'gone' }
    if (!hasCode(error, 'EPERM')) {
      return { kind: 'failure', reason: `group ${processGroupId} could not be probed: ${describeError(error)}` }
    }
  }
  return { kind: 'alive' }
}

/** Whether `argument` appears in `command` as a whole, space-separated argument. */
export function commandCarriesArgument(command: string, argument: string): boolean {
  let from = 0
  for (;;) {
    const index = command.indexOf(argument, from)
    if (index < 0) return false
    const before = index === 0 ? ' ' : command[index - 1]
    const after = command[index + argument.length] ?? ' '
    if (before === ' ' && after === ' ') return true
    from = index + 1
  }
}

const execFileAsync = promisify(execFile)

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
