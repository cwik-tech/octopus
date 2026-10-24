import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod'

import { publishPrivateFileExclusively } from '../core/execution-journal.js'
import { hasErrorCode } from '../core/node-errors.js'
import { ensureRunPrivateRuntimeDirectory } from '../domains/runtime/runtime-paths.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../core/run-assignment-location.js'
import { inspectWorkspaceActivationReadiness } from './execution-journal-preflight.js'
import {
  ExecutionJournalConfigurationError,
  resolveExecutionJournalOptions,
  type ExecutionJournalMode,
  type ResolvedExecutionJournalOptions,
} from './workspace-execution-journal-registry.js'

/**
 * The workspace tenant pin (ADR A-4).
 *
 * The tenant is sealed immutably into every journal manifest, and it comes from
 * an environment variable, so changing it fails every enrolled assignment closed
 * with a manifest conflict — discovered mid-run, one dispatch at a time. The pin
 * does not change that outcome. It changes *when* the disagreement is found: at
 * startup, naming both values, instead of during an execution.
 *
 * The pin never overrides a manifest. Where they disagree the manifest still
 * wins and the assignment still fails closed.
 */

export const EXECUTION_JOURNAL_TENANT_PIN_FILENAME =
  'execution-journal-tenant.json'

/**
 * The pin's shape, validated from `unknown` on every read.
 *
 * `tenantId` repeats the runtime's own boundary rather than trusting the file:
 * a pin that accepted a value a manifest rejects would move the failure from
 * startup back into the middle of a run, which is the whole thing the pin
 * exists to prevent.
 */
const TENANT_PIN_SCHEMA = z.object({
  schemaVersion: z.literal(1),
  tenantId: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => value === value.trim(), {
      message: 'must not carry leading or trailing whitespace',
    })
    // eslint-disable-next-line no-control-regex -- the manifest rejects these.
    .refine((value) => !/[\0-\x1f\x7f]/.test(value), {
      message: 'must not contain control characters',
    }),
  pinnedAt: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: 'must be a timestamp',
    }),
})

export type ExecutionJournalTenantPin = z.infer<typeof TENANT_PIN_SCHEMA>

export function tenantPinPath(workspacePath: string): string {
  return path.join(
    workspacePath,
    RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
    EXECUTION_JOURNAL_TENANT_PIN_FILENAME,
  )
}

/**
 * Read the pin, or `undefined` when this workspace has none.
 *
 * A pin that is a symlink, a directory, or anything but a regular file is
 * refused rather than followed: it decides which tenant this workspace seals,
 * so a redirected pin is a configuration failure, not a fallback.
 */
export async function readTenantPin(
  workspacePath: string,
): Promise<ExecutionJournalTenantPin | undefined> {
  const pinPath = tenantPinPath(workspacePath)

  // Containment first. A `.runtime` that resolves outside the workspace can be
  // swapped by anything with write access to wherever it points, and it decides
  // which tenant every journal here is sealed for.
  const directory = path.dirname(pinPath)
  let directoryStat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    directoryStat = await fs.lstat(directory)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
  // Checked before the mode, because a symlink's own mode is always
  // group/other-readable and would otherwise produce a permissions diagnosis
  // for what is really a redirection. Both refuse; only one explains.
  //
  // Containment by realpath was considered and dropped: with this check in
  // place there is no path that escapes the workspace and still reaches the
  // read, so a containment branch here would be code no test could reach.
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw pinRefused(
      directory,
      'the run-private runtime directory must be a real directory, not a ' +
        'symbolic link. A pin reached through a link is decided by whoever ' +
        'controls the link target.',
    )
  }
  if ((directoryStat.mode & 0o077) !== 0) {
    throw pinRefused(
      directory,
      'the run-private runtime directory is readable or traversable by others; ' +
        'it must be 0700.',
    )
  }

  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(pinPath)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw pinRefused(
      pinPath,
      'the workspace tenant pin must be a regular file, not a symbolic link ' +
        'or a directory.',
    )
  }
  if ((stat.mode & 0o077) !== 0) {
    throw pinRefused(
      pinPath,
      'the workspace tenant pin is readable by others; it must be 0600.',
    )
  }

  const raw = await fs.readFile(pinPath, 'utf8')
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    throw pinRefused(
      pinPath,
      'the workspace tenant pin is not valid JSON. A parse error escaping from ' +
        'here would surface as an unexplained crash rather than a ' +
        'configuration failure.',
    )
  }

  const parsed = TENANT_PIN_SCHEMA.safeParse(parsedJson)
  if (!parsed.success) {
    throw pinRefused(
      pinPath,
      `the workspace tenant pin is unreadable (${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
        .join('; ')}). Delete it only after confirming with the activation ` +
        "preflight which tenant this workspace's journals are actually sealed for.",
    )
  }
  return parsed.data
}

function pinRefused(
  subject: string,
  detail: string,
): ExecutionJournalConfigurationError {
  return new ExecutionJournalConfigurationError('TEAM_TENANT_ID', subject, detail)
}

export interface ReconcileTenantPinInput {
  readonly workspacePath: string
  readonly tenantId: string
  readonly mode: ExecutionJournalMode
  readonly now?: () => Date
}

/**
 * Compare the environment tenant against this workspace, and pin it when the
 * workspace is provably empty.
 *
 * Called once at startup. It is deliberately not called from a dispatch: a pin
 * written as a side effect of executing work would record whatever tenant
 * happened to be set at that moment.
 */
export async function reconcileWorkspaceTenantPin(
  input: ReconcileTenantPinInput,
): Promise<ExecutionJournalTenantPin | undefined> {
  const existing = await readTenantPin(input.workspacePath)

  if (existing && existing.tenantId !== input.tenantId) {
    throw new ExecutionJournalConfigurationError(
      'TEAM_TENANT_ID',
      input.tenantId,
      `this workspace is pinned to tenant '${existing.tenantId}'. Every ` +
        'journal here is sealed for that tenant and would fail closed under ' +
        'a different one. Run `npm run journal:preflight` before changing it.',
    )
  }

  // The preflight runs whether or not a pin exists. A pin records what was
  // true when it was written; it is not evidence about the journals here now.
  // A workspace can acquire a foreign journal after being pinned — copied in,
  // restored from a backup, written by a build that predates the pin — and
  // returning early on a matching pin would leave that to surface one dispatch
  // at a time mid-run, which is exactly what startup reconciliation exists to
  // prevent.
  const readiness = await inspectWorkspaceActivationReadiness({
    workspacePath: input.workspacePath,
    environmentTenantId: input.tenantId,
  })

  // The verdict is the whole decision. `ready` already means discovery was
  // complete, nothing was unreadable, and every sealed tenant equals the
  // environment value — which is exactly the condition under which a pin is
  // safe, whether the workspace holds no journals or a hundred agreeing ones.
  if (readiness.verdict !== 'ready') {
    if (existing) {
      const detail = readiness.problems
        .map((problem) => `${problem.kind}: ${problem.detail}`)
        .join(' | ')
      throw new ExecutionJournalConfigurationError(
        'TEAM_TENANT_ID',
        input.tenantId,
        `this workspace is pinned to '${existing.tenantId}' but no longer ` +
          `matches that pin. ${detail}`,
      )
    }
    const summary = readiness.problems
      .map((problem) => `${problem.kind}: ${problem.detail}`)
      .join(' | ')
    throw new ExecutionJournalConfigurationError(
      'TEAM_TENANT_ID',
      input.tenantId,
      'this workspace cannot be pinned yet. Run `npm run journal:preflight -- ' +
        '--workspace <path>` and resolve its verdict before starting with the ' +
        `journal enabled. ${summary}`,
    )
  }

  // An empty workspace with the journal off has nothing to protect yet, and
  // pinning then would record a tenant no journal was ever sealed for. Once
  // journals exist the pin protects them in either mode, because authority is
  // sticky and they resolve regardless of the flag.
  if (existing) return existing

  if (input.mode !== 'authoritative' && readiness.enrolledJournalCount === 0) {
    return undefined
  }

  return writeTenantPin(input.workspacePath, input.tenantId, input.now)
}

/**
 * The one asynchronous startup boundary for the durable journal.
 *
 * Both the API/Electron composition root and the detached task worker resolve
 * their journal configuration through here. They used to resolve it
 * separately — the worker by reading the environment directly — so a workspace
 * pinned to one tenant would accept a worker launched with another and seal a
 * fresh manifest to it. A second door into the same decision is a second place
 * for it to be wrong.
 *
 * The pin is reconciled in **every** mode. Authority is sticky: an assignment
 * that has enrolled resolves its journal whatever the flag says, so a
 * disagreeing tenant is exactly as fatal with the journal disabled.
 */
export async function startWorkspaceExecutionJournal(input: {
  readonly workspacePath: string
  readonly now?: () => Date
}): Promise<ResolvedExecutionJournalOptions> {
  const options = resolveExecutionJournalOptions()
  await reconcileWorkspaceTenantPin({
    workspacePath: input.workspacePath,
    tenantId: options.tenantId,
    mode: options.mode,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return options
}

/**
 * Create the pin, losing to a concurrent first writer rather than overwriting.
 *
 * Two processes may start against a fresh workspace at once. The loser re-reads
 * the winner's file and compares: equal values proceed, unequal values fail. No
 * lock is required, because the file is written once and read thereafter.
 */
async function writeTenantPin(
  workspacePath: string,
  tenantId: string,
  now: (() => Date) | undefined,
): Promise<ExecutionJournalTenantPin> {
  const pin: ExecutionJournalTenantPin = {
    schemaVersion: 1,
    tenantId,
    pinnedAt: (now?.() ?? new Date()).toISOString(),
  }

  const directory = ensureRunPrivateRuntimeDirectory(workspacePath)
  const pinPath = path.join(directory, EXECUTION_JOURNAL_TENANT_PIN_FILENAME)

  // One persistence path, shared with the journal's own manifest publication:
  // a synced temporary file, an atomic publication, then a parent-directory
  // sync. `exclusively` loses to a concurrent first writer rather than
  // replacing what it wrote.
  const published = await publishPrivateFileExclusively(
    pinPath,
    `${JSON.stringify(pin)}\n`,
  )
  if (published) return pin

  const winner = await readTenantPin(workspacePath)
  if (!winner || winner.tenantId !== tenantId) {
    throw pinRefused(
      pinPath,
      `another process pinned this workspace to '${winner?.tenantId ?? 'an unreadable value'}' first.`,
    )
  }
  return winner
}
