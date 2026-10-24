import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Cleanup for test fixture processes identified by their own marker.
 *
 * Each fixture process carries a unique, non-secret identity, so it can be
 * found and verified without trusting a remembered pid or group that the
 * system may have reused. The identity is either a whole argument on its
 * command line, or a `NAME=value` its environment inherited from the test
 * that started it, which also reaches descendants the test never saw. A
 * process is signalled only if it still carries its identity when read again
 * immediately before the signal. This test process itself is never matched.
 * Every wait is bounded, every process is attempted whatever failed for
 * another, and every failure is reported with what was seen. Reports carry
 * pids, groups and the fixture token only, never a command line or an
 * environment.
 *
 * Platforms. The environment is read the way the test-run reaper reads it
 * (`tests/support/test-run-reaper.ts`, which runs in the Ubuntu CI jobs):
 * macOS `ps -E` ("Display the environment as well. This does not reflect
 * changes in the environment after process launch", ps(1)), and on Linux the
 * BSD-style `e` operand, which procps reads from /proc/<pid>/environ. macOS is
 * verified here; the Linux forms are not verified in this workspace. Any other
 * platform throws rather than passing without cleanup.
 */

const STOP_BOUND_MS = 5_000
const POLL_MS = 50
const PS_ENVIRONMENT: NodeJS.ProcessEnv = {}

interface ListedProcess {
  readonly pid: number
  readonly groupId: number
  readonly command: string
}

/** Where an identity is read: the command line, or the command line and environment. */
type IdentityScope = 'arguments' | 'environment'

/**
 * The system `ps`, by absolute path and run with an empty environment: a `ps`
 * that inherited the test's environment would match an environment identity
 * itself, and tests put a failing `ps` first on PATH.
 */
function systemPs(): string {
  for (const candidate of ['/bin/ps', '/usr/bin/ps']) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('No system ps at /bin/ps or /usr/bin/ps; fixture processes cannot be verified')
}

function listArguments(scope: IdentityScope): string[] {
  if (process.platform === 'darwin') {
    return ['-A', ...(scope === 'environment' ? ['-E'] : []), '-ww', '-o', 'pid=,pgid=,command=']
  }
  if (process.platform === 'linux') {
    return [scope === 'environment' ? 'axeww' : 'axww', '-o', 'pid=,pgid=,command=']
  }
  throw new Error(`Fixture process identities cannot be read on ${process.platform}`)
}

function pidArguments(scope: IdentityScope, pid: number): string[] {
  if (process.platform === 'darwin') {
    return [...(scope === 'environment' ? ['-E'] : []), '-ww', '-o', 'command=', '-p', String(pid)]
  }
  if (process.platform === 'linux') {
    return [scope === 'environment' ? 'eww' : 'ww', '-o', 'command=', '-p', String(pid)]
  }
  throw new Error(`Fixture process identities cannot be read on ${process.platform}`)
}

/** A `ps` failure, described by its status and signal only, never its output. */
function psFailure(action: string, error: unknown): Error {
  const status = error instanceof Error && 'status' in error ? String(error.status) : 'unknown'
  const signal = error instanceof Error && 'signal' in error ? String(error.signal) : 'none'
  return new Error(`ps failed while ${action} (status ${status}, signal ${signal})`)
}

/** Every process, strictly: any failure or unparsable line throws. */
function listProcesses(scope: IdentityScope): ListedProcess[] {
  let output: string
  try {
    output = execFileSync(systemPs(), listArguments(scope), {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
      env: PS_ENVIRONMENT,
    })
  } catch (error) {
    throw psFailure('listing processes', error)
  }
  return output.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/u.exec(line)
    if (!match?.[1] || !match[2] || match[3] === undefined) {
      // The line itself may hold an environment, so only its shape is reported.
      const leading = /^\s*(\d+)/u.exec(line)?.[1]
      const fields = line.trim().split(/\s+/u).length
      throw new Error(`ps printed a line that does not parse (pid ${leading ?? 'unknown'}, ${fields} fields)`)
    }
    return { pid: Number(match[1]), groupId: Number(match[2]), command: match[3] }
  })
}

/** What `ps` shows for `pid`, or undefined when ps says no such process (exit 1, no text). */
function processTextAt(pid: number, scope: IdentityScope): string | undefined {
  try {
    return execFileSync(systemPs(), pidArguments(scope, pid), {
      encoding: 'utf8',
      timeout: 5_000,
      env: PS_ENVIRONMENT,
    }).trim()
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error && error.status === 1 &&
      'stdout' in error && typeof error.stdout === 'string' && error.stdout.trim() === '' &&
      'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim() === ''
    ) {
      return undefined
    }
    throw psFailure(`reading process ${pid}`, error)
  }
}

export function carriesArgument(command: string, argument: string): boolean {
  return ` ${command} `.includes(` ${argument} `)
}

function matching(token: string, scope: IdentityScope): ListedProcess[] {
  if (/\s/u.test(token)) throw new Error(`A fixture identity must not contain whitespace: ${JSON.stringify(token)}`)
  return listProcesses(scope).filter((row) => row.pid !== process.pid && carriesArgument(row.command, token))
}

/** The processes that carry `marker` as a whole argument. */
export function processesCarrying(marker: string): ListedProcess[] {
  return matching(marker, 'arguments')
}

/** The processes whose environment carries `name=value`. */
export function processesWithEnvironment(name: string, value: string): ListedProcess[] {
  return matching(`${name}=${value}`, 'environment')
}

export interface StopOptions {
  /** How a verified process is signalled; a seam for testing this helper. */
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void
}

async function stopMatching(token: string, scope: IdentityScope, options: StopOptions): Promise<void> {
  const signal = options.signal ?? ((pid: number, name: NodeJS.Signals) => { process.kill(pid, name) })
  const errors: unknown[] = []
  const failed = new Set<number>()
  const deadline = Date.now() + STOP_BOUND_MS
  // Passes repeat until none is left, so a process that one of them started
  // after the previous scan is stopped too.
  for (;;) {
    const remaining = matching(token, scope).filter((row) => !failed.has(row.pid))
    if (remaining.length === 0) break
    if (Date.now() >= deadline) {
      errors.push(new Error(
        `Processes carrying ${token} did not stop within ${STOP_BOUND_MS}ms: ` +
        remaining.map((row) => `${row.pid} (group ${row.groupId})`).join('; '),
      ))
      break
    }
    for (const row of remaining) {
      try {
        const text = processTextAt(row.pid, scope)
        if (text === undefined || !carriesArgument(text, token)) continue
        try {
          signal(row.pid, 'SIGKILL')
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
        }
      } catch (error) {
        failed.add(row.pid)
        errors.push(error)
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS))
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Stopping the processes carrying ${token} failed: ${describeErrors(errors)}`)
  }
}

/** The messages of `errors`, for a report whose reporter prints only the outer message. */
export function describeErrors(errors: readonly unknown[]): string {
  return errors.map((error) => (error instanceof Error ? error.message : String(error))).join(' | ')
}

/**
 * Stops every process carrying `marker`, rechecking each immediately before
 * its signal, and waits, bounded, until none it signalled carries it. Each
 * process is attempted whatever failed for another; every failure, and every
 * survivor, is reported together.
 */
export async function stopProcessesCarrying(marker: string, options: StopOptions = {}): Promise<void> {
  await stopMatching(marker, 'arguments', options)
}

/** As `stopProcessesCarrying`, for processes whose environment carries `name=value`. */
export async function stopProcessesWithEnvironment(
  name: string,
  value: string,
  options: StopOptions = {},
): Promise<void> {
  await stopMatching(`${name}=${value}`, 'environment', options)
}

/**
 * Stops the processes of every marker, attempting each whatever failed
 * before, and returns every error.
 */
export async function stopAllCarrying(markers: readonly string[]): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const marker of markers) {
    try {
      await stopProcessesCarrying(marker)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

/** Resolves when `event` settles, or rejects with `description` after `boundMs`. */
export async function withinBound<T>(event: Promise<T>, boundMs: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${boundMs}ms waiting for ${description}`)), boundMs)
  })
  try {
    return await Promise.race([event, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
