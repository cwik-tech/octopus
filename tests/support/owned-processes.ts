import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Test fixtures only. A working directory inside a folder a test created for
// itself, and that nothing else uses, identifies the processes that test
// left behind. That is not a production process identity.

/** A process found by its working directory. */
export interface WorkingProcess {
  readonly pid: number
  readonly cwd: string
}

/** How long cleanup waits for signalled processes to go before it fails. */
const STOP_BOUND_MS = 10_000

/**
 * Processes whose working directory is `root` or lies inside it.
 *
 * Found by working directory, which a process that rewrites its own title
 * cannot hide. The listing has to be usable and well formed: `lsof` has to
 * succeed, every process record has to carry a positive pid followed by its
 * working directory, and this process has to appear in it. Seeing this
 * process shows the listing works; it does not prove the listing covers every
 * process on the system. Anything else throws, so a failed or malformed
 * listing is never read as "none left".
 */
export function processesWorkingUnder(root: string): WorkingProcess[] {
  const output = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const found: WorkingProcess[] = []
  // The process record still waiting for its working directory record.
  let pending: number | undefined
  let listedSelf = false
  for (const line of output.split('\n')) {
    if (line === '' || line.startsWith('f')) continue
    if (line.startsWith('p')) {
      if (pending !== undefined) {
        throw new Error(`Process ${pending} has no working directory record in the lsof listing`)
      }
      const pid = Number(line.slice(1))
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`Malformed process record in the lsof listing: ${JSON.stringify(line)}`)
      }
      if (pid === process.pid) listedSelf = true
      pending = pid
      continue
    }
    if (line.startsWith('n')) {
      const cwd = line.slice(1)
      if (pending === undefined || cwd === '') {
        throw new Error(`Malformed working directory record in the lsof listing: ${JSON.stringify(line)}`)
      }
      if (isAtOrInside(root, cwd)) found.push({ pid: pending, cwd })
      pending = undefined
      continue
    }
    throw new Error(`Unexpected record in the lsof listing: ${JSON.stringify(line)}`)
  }
  if (pending !== undefined) {
    throw new Error(`Process ${pending} has no working directory record in the lsof listing`)
  }
  if (!listedSelf) throw new Error(`The lsof listing does not include this process (${process.pid})`)
  return found
}

/**
 * Stops every process whose working directory is `root` or lies inside it,
 * and waits until none is left.
 *
 * Each process is checked again after its group is read and right before its
 * signal, because its pid may have been reused since the listing, and its
 * group is signalled only when it leads it. These are not this process's
 * children, so nothing reports their exit as an event; the bounded wait lists
 * them again.
 */
export async function stopProcessesWorkingUnder(root: string): Promise<void> {
  for (const { pid } of processesWorkingUnder(root)) {
    const groupId = processGroupOf(pid)
    if (groupId === undefined) continue
    const cwd = workingDirectoryOf(pid)
    if (cwd === undefined || !isAtOrInside(root, cwd)) continue
    try {
      process.kill(groupId === pid ? -pid : pid, 'SIGKILL')
    } catch (error) {
      // Gone between the check and the signal; anything else is a failure.
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
  }
  const deadline = Date.now() + STOP_BOUND_MS
  let left = processesWorkingUnder(root)
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    left = processesWorkingUnder(root)
  }
  if (left.length > 0) {
    throw new Error(`Processes working under ${root} did not stop: ${JSON.stringify(left)}`)
  }
}

/**
 * Stops the process at `pid` only while its command line carries `marker`,
 * and waits until no process at that pid carries it.
 *
 * For a process that keeps its command line, such as a session task runner
 * started with `--runtime-process-identity=<attempt>`. The marker is checked
 * again after the group is read and right before the signal, because the pid
 * may have been reused, and the group is signalled only when the process
 * leads it. A pid that no longer carries the marker belongs to someone else
 * and is left alone.
 */
export async function stopProcessCarrying(pid: number, marker: string): Promise<void> {
  const carries = (): boolean => commandLineOf(pid)?.includes(marker) ?? false
  if (carries()) {
    const groupId = processGroupOf(pid)
    if (groupId !== undefined && carries()) {
      try {
        process.kill(groupId === pid ? -pid : pid, 'SIGKILL')
      } catch (error) {
        // Gone between the check and the signal; anything else is a failure.
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
    }
  }
  const deadline = Date.now() + STOP_BOUND_MS
  while (carries() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  if (carries()) throw new Error(`Process ${pid} still carries ${marker} and did not stop`)
}

/** The full command line of one process, or undefined when no process has this pid. */
function commandLineOf(pid: number): string | undefined {
  const output = strictProbe('ps', ['-ww', '-o', 'command=', '-p', String(pid)])
  return output === undefined ? undefined : output.trim()
}

/**
 * Whether `candidate` is `root` or lies inside it. `lsof` reports resolved
 * paths, so the root is resolved too (`/var` is `/private/var` on macOS).
 */
function isAtOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(resolvedPath(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolvedPath(directory: string): string {
  try {
    return fs.realpathSync.native(directory)
  } catch (error) {
    // Only a folder that no longer exists is compared as written; any other
    // failure to resolve it is an error.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return path.resolve(directory)
    throw error
  }
}

/**
 * The working directory of one process, or undefined when no process has
 * this pid. `lsof` exiting 1 with no output and no error text is the only
 * result read as absence; any other failure throws.
 */
function workingDirectoryOf(pid: number): string | undefined {
  const output = strictProbe('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  if (output === undefined) return undefined
  const line = output.split('\n').find((entry) => entry.startsWith('n'))
  if (line === undefined || line === 'n') {
    throw new Error(`Unreadable working directory listing for ${pid}: ${JSON.stringify(output)}`)
  }
  return line.slice(1)
}

/** The process group of one process, or undefined when no process has this pid. */
function processGroupOf(pid: number): number | undefined {
  const output = strictProbe('ps', ['-o', 'pgid=', '-p', String(pid)])
  if (output === undefined) return undefined
  const group = Number(output.trim())
  if (!Number.isInteger(group) || group <= 0) {
    throw new Error(`Unreadable process group for ${pid}: ${JSON.stringify(output)}`)
  }
  return group
}

/**
 * Runs a probe that exits 1 with no output and no error text when the process
 * does not exist. Returns undefined only for exactly that; throws otherwise.
 */
function strictProbe(command: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 5_000 })
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error && error.status === 1 &&
      'stdout' in error && typeof error.stdout === 'string' && error.stdout.trim() === '' &&
      'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim() === ''
    ) {
      return undefined
    }
    throw error
  }
}
