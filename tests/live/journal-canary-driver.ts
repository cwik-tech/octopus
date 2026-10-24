import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  attributeCanaryOutcome,
  parseArmOutcome,
  type CanaryArmOutcome,
  type CanaryAttribution,
} from './journal-canary-attribution.js'

/**
 * AC15's controlled live canary: both arms, one disposable workspace.
 *
 * The arms are separate processes because the journal flag is read at startup,
 * and neither can reach a verdict alone — it holds only its own outcome. This
 * driver owns everything they share: one workspace, one outcome directory, the
 * order, and the verdict.
 *
 * **The driver is the authority on attribution**, not the arms. A journal arm
 * that dies before recording anything is exactly when a verdict matters most,
 * so the verdict is computed here, after both arms, from whatever each left
 * behind. An arm that produced no outcome file is reported as a failure with
 * that fact as its signature, rather than silently dropping the comparison.
 *
 * The workspace is created here and is always disposable. It is never shared or
 * user-owned: enrollment is irreversible per assignment (ADR §16).
 */

const ARM_TIMEOUT_MS = 25 * 60_000

export type ArmName = 'control' | 'journal'

export interface ArmRun {
  readonly arm: ArmName
  readonly status: number | null
  readonly signal: string | null
  /** Set when the process could not be run at all, or exceeded its deadline. */
  readonly spawnError?: string
  /** What the arm recorded, corrected for how its process ended. */
  readonly outcome: CanaryArmOutcome
}

export interface CanaryRunReport {
  readonly workspacePath: string
  readonly outcomeDir: string
  readonly arms: readonly ArmRun[]
  readonly attribution: CanaryAttribution
  /**
   * The gate passes only when both arms ran, both processes ended cleanly, and
   * both recorded completion.
   */
  readonly passed: boolean
  readonly retained: boolean
}

export interface CanaryDriverOptions {
  readonly repoRoot: string
  readonly keepWorkspace: boolean
  /** Injected so the driver's own coordination is testable without a provider. */
  readonly runArm?: (input: {
    readonly arm: ArmName
    readonly workspacePath: string
    readonly outcomeDir: string
  }) => { status: number | null; signal: string | null; error?: Error }
  readonly armTimeoutMs?: number
  readonly log?: (line: string) => void
}

/**
 * Read what an arm recorded, or say precisely why there is nothing to read.
 *
 * A missing file is not the same as a malformed one. Both mean the arm cannot
 * speak for itself, but only the second suggests something wrote nonsense, and
 * a verdict derived from either must say so rather than imply the arm was fine.
 */
function readArmOutcome(
  arm: ArmName,
  outcomeDir: string,
  fallbackSignature: string,
): CanaryArmOutcome {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(outcomeDir, `${arm}.json`), 'utf8')
  } catch {
    return { completed: false, failureSignature: fallbackSignature }
  }
  try {
    return parseArmOutcome(arm, raw)
  } catch (error) {
    return {
      completed: false,
      failureSignature: `unreadable ${arm} outcome: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

/**
 * How an arm's process failed, or `undefined` if it ended cleanly.
 *
 * A clean ending is exit status 0 with no signal and no spawn error. Anything
 * else is a failure of the run regardless of what the arm wrote, because the
 * arm records its outcome and then keeps going: teardown closes the registry,
 * removes directories, restores the environment. A failure after the write
 * leaves `{"completed":true}` on disk beside a nonzero exit.
 */
function describeProcessFailure(input: {
  readonly status: number | null
  readonly signal: string | null
  readonly error?: Error
  readonly timeoutMs: number
}): string | undefined {
  if (input.error) {
    return `arm process failed to run: ${input.error.message}`
  }
  if (input.signal) {
    return `arm process was killed by ${input.signal} (deadline ${input.timeoutMs}ms)`
  }
  if (input.status === null) {
    return `arm process ended with no exit status (deadline ${input.timeoutMs}ms)`
  }
  if (input.status !== 0) {
    return `arm process exited ${input.status}`
  }
  return undefined
}

/**
 * The outcome the verdict is computed from: what the arm recorded, corrected
 * for how its process actually ended.
 *
 * The process result is the authority on termination; the file is the authority
 * on what happened before it. So a process failure overrides a recorded
 * completion, but an arm that already diagnosed itself keeps its own signature —
 * "blocked at discuss" locates the failure, "exited 1" does not.
 */
function effectiveArmOutcome(
  recorded: CanaryArmOutcome,
  processFailure: string | undefined,
): CanaryArmOutcome {
  if (!processFailure) {
    return recorded
  }
  return {
    completed: false,
    failureSignature: recorded.failureSignature ?? processFailure,
  }
}

export function runJournalCanary(options: CanaryDriverOptions): CanaryRunReport {
  const timeoutMs = options.armTimeoutMs ?? ARM_TIMEOUT_MS
  const log = options.log ?? ((line: string) => process.stdout.write(line))

  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'journal-canary-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const outcomeDir = path.join(root, 'outcomes')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(outcomeDir, { recursive: true })

  log(`canary workspace: ${workspacePath}\n`)
  log(`canary outcomes:  ${outcomeDir}\n`)

  const runArm = options.runArm ?? defaultArmRunner(options.repoRoot, timeoutMs)

  // Control first, so a reader of the transcript sees the baseline before the
  // arm under test. The verdict does not depend on the order.
  const arms: ArmRun[] = []
  for (const arm of ['control', 'journal'] as const) {
    log(`\n=== canary arm: ${arm} ===\n`)
    const run = runArm({ arm, workspacePath, outcomeDir })
    const processFailure = describeProcessFailure({ ...run, timeoutMs })
    const recorded = readArmOutcome(
      arm,
      outcomeDir,
      processFailure ?? 'arm process exited 0 without recording an outcome',
    )
    const outcome = effectiveArmOutcome(recorded, processFailure)
    arms.push({
      arm,
      status: run.status,
      signal: run.signal,
      ...(run.error ? { spawnError: run.error.message } : {}),
      outcome,
    })
    log(
      `=== arm ${arm}: status=${String(run.status)} signal=${String(run.signal)} ` +
        `completed=${outcome.completed} ===\n`,
    )
  }

  const control = arms.find((entry) => entry.arm === 'control')
  const journal = arms.find((entry) => entry.arm === 'journal')
  if (!control || !journal) {
    throw new Error('both canary arms must be attempted')
  }

  const attribution = attributeCanaryOutcome({
    journal: journal.outcome,
    control: control.outcome,
  })
  log(`\ncanary attribution: ${attribution.verdict}\n`)
  log(`canary attribution: ${attribution.summary}\n`)

  if (options.keepWorkspace) {
    log(`\ncanary workspace retained at ${workspacePath}\n`)
  } else {
    fs.rmSync(root, { recursive: true, force: true })
    log('\ncanary workspace discarded\n')
  }

  return {
    workspacePath,
    outcomeDir,
    arms,
    attribution,
    passed: control.outcome.completed && journal.outcome.completed,
    retained: options.keepWorkspace,
  }
}

function defaultArmRunner(
  repoRoot: string,
  timeoutMs: number,
): NonNullable<CanaryDriverOptions['runArm']> {
  return ({ arm, workspacePath, outcomeDir }) => {
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--test', 'tests/live/journal-cutover-live.test.ts'],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        // Bounded, so a hung provider ends the gate instead of the gate ending
        // the working day. Longer than the test's own 20-minute timeout, so the
        // test reports its own failure first where it can.
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          PIPELINE_LIVE_JOURNAL_CUTOVER: arm === 'control' ? 'control' : '1',
          PIPELINE_CANARY_WORKSPACE: workspacePath,
          PIPELINE_CANARY_OUTCOME_DIR: outcomeDir,
          // The driver owns the workspace, so an arm must never remove it.
          PIPELINE_KEEP_LIVE_WORKSPACE: '1',
        },
      },
    )
    return {
      status: run.status,
      signal: run.signal,
      ...(run.error ? { error: run.error } : {}),
    }
  }
}
