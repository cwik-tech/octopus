/**
 * The owned process host
 * (`docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md`,
 * section 4). POSIX only.
 *
 * Run as `<node> <this file> --runtime-owned-process=<id> -- <target...>`,
 * detached, so it leads a new process group. It keeps that command line for
 * its whole life, which is how a closer verifies it. Before starting its
 * target it publishes its claim (its own pid and group), then walks its
 * lineage and checks every fence that covers it; a closer that claimed first,
 * any fence, or an unwalkable lineage means the target never starts. The
 * target runs as an ordinary child in the host's group with the host's stdio,
 * so the spawner reads the target's own output and sees `close` only after the
 * target exits. The host ignores SIGTERM, SIGINT and SIGHUP, which reach the
 * target through the group. Once its target exits, the host stays, bounded,
 * while any other process of its group still runs, so a closer can still
 * verify it and SIGKILL the group; it then ends with its target's exit code or
 * signal.
 */
import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TASK_SUPERVISOR_GRACEFUL_TIMEOUT_MS } from '../constants.js'
import {
  OWNED_PROCESS_GROUP_POLL_MS,
  OWNED_PROCESS_SIGKILL_CONFIRMATION_MS,
} from './owned-process-closer.js'
import { walkAncestors } from './owned-process-lineage.js'
import { readProcessTableStrict } from './owned-process-probe.js'
import {
  OWNED_PROCESS_ARGUMENT,
  OWNED_PROCESS_ID_ENV,
  OWNED_PROCESS_SCOPE_ENV,
  claimRecordSchema,
  hasErrorCode,
  ownedProcessScopeFolders,
  publishOrReadScopeRecord,
} from './owned-process-records.js'

/** The host did not start its target (EX_TEMPFAIL). */
export const OWNED_PROCESS_HOST_NOT_STARTED = 75
/** The target could not be started, as a shell reports it. */
export const OWNED_PROCESS_HOST_TARGET_MISSING = 127

const RELAYED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

interface HostArguments {
  readonly ownedProcessId: string
  readonly command: string
  readonly args: readonly string[]
}

function parseHostArguments(argv: readonly string[]): HostArguments | undefined {
  const [marker, separator, command, ...args] = argv
  if (!marker?.startsWith(OWNED_PROCESS_ARGUMENT) || separator !== '--' || !command) return undefined
  const ownedProcessId = marker.slice(OWNED_PROCESS_ARGUMENT.length)
  return ownedProcessId ? { ownedProcessId, command, args } : undefined
}

function refuse(reason: string): never {
  process.stderr.write(`Owned process host did not start its target: ${reason}\n`)
  process.exit(OWNED_PROCESS_HOST_NOT_STARTED)
}

/**
 * How long a host whose target has exited waits for the rest of its group:
 * through a closer's SIGTERM grace and its SIGKILL confirmation, so a closer
 * that signalled the group finds the host still verifiable when it rechecks
 * before SIGKILL.
 */
const LINGER_MS = TASK_SUPERVISOR_GRACEFUL_TIMEOUT_MS + OWNED_PROCESS_SIGKILL_CONFIRMATION_MS

/**
 * Returns once no other process of the host's group runs, or once `LINGER_MS`
 * has passed. Until then the host keeps its command line and leads its group.
 * The `ps` each read runs is the host's own child in its group, so it is left
 * out; every other process of the group counts. A process table that cannot
 * be read counts as members remaining, never as an empty group.
 */
async function lingerWhileGroupRuns(): Promise<void> {
  const deadline = Date.now() + LINGER_MS
  for (;;) {
    const table = await readProcessTableStrict({ excludeOwnProbe: true })
    const othersRun = table.kind === 'failure' || table.rows.some((row) =>
      row.processGroupId === process.pid && row.pid !== process.pid && !row.state.startsWith('Z'))
    if (!othersRun || Date.now() >= deadline) return
    await new Promise<void>((resolve) => setTimeout(resolve, OWNED_PROCESS_GROUP_POLL_MS))
  }
}

/** Whether a fence covers this path: present unless the name is reported absent. */
async function fencePresent(fencePath: string): Promise<boolean> {
  try {
    await fsp.lstat(fencePath)
    return true
  } catch (error) {
    return !hasErrorCode(error, 'ENOENT')
  }
}

async function main(): Promise<void> {
  // Installed first, so a signal that arrives before the target exists is
  // remembered and the target is then never started.
  let signalledBeforeStart: NodeJS.Signals | undefined
  let targetStarted = false
  for (const signal of RELAYED_SIGNALS) {
    process.on(signal, () => {
      if (!targetStarted) signalledBeforeStart ??= signal
    })
  }

  const parsed = parseHostArguments(process.argv.slice(2))
  if (!parsed) refuse('its arguments are not --runtime-owned-process=<id> -- <command>')
  const scopePath = process.env[OWNED_PROCESS_SCOPE_ENV]?.trim()
  if (!scopePath) refuse(`${OWNED_PROCESS_SCOPE_ENV} is not set`)
  const folders = ownedProcessScopeFolders(scopePath)

  const claim = await publishOrReadScopeRecord({
    scopePath,
    target: path.join(folders.claims, `${parsed.ownedProcessId}.json`),
    record: {
      version: 1,
      ownedProcessId: parsed.ownedProcessId,
      claimant: 'host',
      pid: process.pid,
      processGroupId: process.pid,
      claimedAt: new Date().toISOString(),
    },
    schema: claimRecordSchema,
    expectedOwnedProcessId: parsed.ownedProcessId,
  })
  if (claim.kind !== 'published') refuse(`owned process ${parsed.ownedProcessId} was already claimed`)

  const lineage = await walkAncestors(scopePath, parsed.ownedProcessId)
  if (lineage.kind === 'failed') refuse(lineage.reason)
  const fences = [
    path.join(folders.fences, 'attempt.json'),
    ...[parsed.ownedProcessId, ...lineage.ancestors].map((id) => path.join(folders.fences, `subtree-${id}.json`)),
  ]
  for (const fence of fences) {
    if (await fencePresent(fence)) refuse(`${path.basename(fence)} fences owned process ${parsed.ownedProcessId}`)
  }
  if (signalledBeforeStart) refuse(`${signalledBeforeStart} arrived before the target started`)

  targetStarted = true
  const target = spawn(parsed.command, [...parsed.args], {
    stdio: 'inherit',
    env: { ...process.env, [OWNED_PROCESS_ID_ENV]: parsed.ownedProcessId },
  })
  target.once('error', (error) => {
    process.stderr.write(`Owned process host could not start its target: ${error.message}\n`)
    process.exit(OWNED_PROCESS_HOST_TARGET_MISSING)
  })
  target.once('exit', (code, signal) => {
    const exitLikeTarget = (): void => {
      if (signal) {
        // End the same way: restore the default action and raise it here.
        for (const relayed of RELAYED_SIGNALS) process.removeAllListeners(relayed)
        process.kill(process.pid, signal)
        return
      }
      process.exit(code ?? OWNED_PROCESS_HOST_TARGET_MISSING)
    }
    void lingerWhileGroupRuns().then(exitLikeTarget, exitLikeTarget)
  })
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((error: unknown) => {
    refuse(error instanceof Error ? error.message : String(error))
  })
}
