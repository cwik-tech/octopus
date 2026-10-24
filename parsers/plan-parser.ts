/**
 * Team Runtime — Plan State Parser
 *
 * Parses plan.md into structured data for pipeline engine gate checks.
 * Extracted from agent-team's plan-parser.ts with minor generalizations:
 * - Removed test sprint concept
 * - Kept all computed functions for runtime gate checks
 *
 * Plan format:
 *   # Plan: {title}
 *   **Status:** draft | executing | completed | failed
 *
 *   ### S{N}: {sprint name}
 *   #### T{N}: {task title}
 *   - **Agent:** {agent name}
 *   - **Status:** pending | in_progress | completed | validated | failed | blocked
 *   - **Validate:** true | false
 *   - **Depends on:** T1, T2 | none
 *   - **Gate:** true | false
 *   - **Result file:** {path}
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isSafePathSegment } from '../core/path-safety.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../core/run-assignment-location.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'validated' | 'failed' | 'blocked' | 'skipped'

export interface PlanTask {
  id: string
  title: string
  agent: string
  status: TaskStatus
  validate: boolean
  dependsOn: string[]
  gate: boolean
  resultFile: string
  sprintId: string
}

export interface PlanSprint {
  id: string
  name: string
  taskIds: string[]
  gateTaskId: string | null
}

export type PlanStatus = 'draft' | 'executing' | 'completed' | 'failed'

export interface PlanState {
  title: string
  status: PlanStatus
  sprints: PlanSprint[]
  tasks: Map<string, PlanTask>
}

export function isSafePlanResultFile(resultFile: string): boolean {
  if (!resultFile || path.isAbsolute(resultFile)) return false
  const segments = resultFile.split('/')
  return (
    segments[0]?.toLowerCase() !==
      RUN_PRIVATE_RUNTIME_DIRECTORY_NAME.toLowerCase() &&
    segments.every((segment) => isSafePathSegment(segment))
  )
}

// ─── Parser ───────────────────────────────────────────────────────────────────

const VALID_TASK_STATUSES = new Set<string>([
  'pending', 'in_progress', 'completed', 'validated', 'failed', 'blocked', 'skipped',
])

const VALID_PLAN_STATUSES = new Set<string>(['draft', 'executing', 'completed', 'failed'])

function requiredCapture(match: RegExpMatchArray, index: number): string {
  const capture = match[index]
  if (capture === undefined) throw new Error(`Missing required regular-expression capture ${index}`)
  return capture
}

/**
 * Parse a plan.md file into structured PlanState.
 * Returns null if the file doesn't exist or can't be read.
 */
export function parsePlan(filepath: string): PlanState | null {
  let content: string
  try {
    content = fs.readFileSync(filepath, 'utf-8')
  } catch {
    return null
  }

  const lines = content.split('\n')

  // Plan-level fields
  const titleMatch = content.match(/^# Plan:\s*(.+)/m)
  const title = titleMatch ? requiredCapture(titleMatch, 1).trim() : ''

  const statusMatch = content.match(/\*\*Status:\*\*\s*(\S+)/)
  const rawStatus = statusMatch ? requiredCapture(statusMatch, 1).trim() : 'draft'
  const status = VALID_PLAN_STATUSES.has(rawStatus) ? rawStatus as PlanStatus : 'draft'

  // Parse sprints and tasks
  const sprints: PlanSprint[] = []
  const tasks = new Map<string, PlanTask>()

  let currentSprint: PlanSprint | null = null
  let currentTask: Partial<PlanTask> & { id?: string } | null = null

  for (const line of lines) {
    // Sprint header: ### S{N}: {name}
    const sprintMatch = line.match(/^### S(\d+):\s*(.+)/)
    if (sprintMatch) {
      if (currentTask?.id) {
        tasks.set(currentTask.id, currentTask as PlanTask)
      }
      currentSprint = {
        id: `S${requiredCapture(sprintMatch, 1)}`,
        name: requiredCapture(sprintMatch, 2).trim(),
        taskIds: [],
        gateTaskId: null,
      }
      sprints.push(currentSprint)
      currentTask = null
      continue
    }

    // Task header: #### T{N}: {title}
    const taskMatch = line.match(/^#### T(\d+):\s*(.+)/)
    if (taskMatch) {
      if (currentTask?.id) {
        tasks.set(currentTask.id, currentTask as PlanTask)
      }
      const taskId = `T${requiredCapture(taskMatch, 1)}`
      currentTask = {
        id: taskId,
        title: requiredCapture(taskMatch, 2).trim(),
        agent: '',
        status: 'pending',
        validate: false,
        dependsOn: [],
        gate: false,
        resultFile: '',
        sprintId: currentSprint?.id || '',
      }
      if (currentSprint) {
        currentSprint.taskIds.push(taskId)
      }
      continue
    }

    if (!currentTask?.id) continue

    // Parse task fields
    const agentMatch = line.match(/^- \*\*Agent:\*\*\s*(.+)/)
    if (agentMatch) {
      currentTask.agent = requiredCapture(agentMatch, 1).trim()
      continue
    }

    const statusFieldMatch = line.match(/^- \*\*Status:\*\*\s*(.+)/)
    if (statusFieldMatch) {
      const val = requiredCapture(statusFieldMatch, 1).trim()
      if (VALID_TASK_STATUSES.has(val)) {
        currentTask.status = val as TaskStatus
      }
      continue
    }

    const validateMatch = line.match(/^- \*\*Validate:\*\*\s*(.+)/)
    if (validateMatch) {
      currentTask.validate = requiredCapture(validateMatch, 1).trim().toLowerCase() === 'true'
      continue
    }

    const dependsMatch = line.match(/^- \*\*Depends on:\*\*\s*(.+)/)
    if (dependsMatch) {
      const raw = requiredCapture(dependsMatch, 1).trim()
      if (raw.toLowerCase() === 'none') {
        currentTask.dependsOn = []
      } else {
        const parts = raw.split(/[,\s]+/).filter(Boolean)
        currentTask.dependsOn = parts.filter((d) => /^T\d+$/.test(d))
      }
      continue
    }

    const resultMatch = line.match(/^- \*\*Result file:\*\*\s*(.+)/)
    if (resultMatch) {
      currentTask.resultFile = requiredCapture(resultMatch, 1).trim()
      continue
    }

    const gateMatch = line.match(/^- \*\*Gate:\*\*\s*(.+)/)
    if (gateMatch) {
      const isGate = requiredCapture(gateMatch, 1).trim().toLowerCase() === 'true'
      currentTask.gate = isGate
      if (isGate && currentSprint) {
        currentSprint.gateTaskId = currentTask.id
      }
      continue
    }

    // When we hit a new section header that isn't a task, finalize current task
    if (/^#{2,4}\s/.test(line) && !line.match(/^#### T\d+:/)) {
      if (currentTask.id) {
        tasks.set(currentTask.id, currentTask as PlanTask)
        currentTask = null
      }
    }
  }

  // Finalize last task
  if (currentTask?.id) {
    tasks.set(currentTask.id, currentTask as PlanTask)
  }

  // Fallback: if a status tracker table exists, use it to override task statuses
  const tableStatusPattern = /^\|\s*(T\d+)\s*\|\s*(\w+)\s*\|/
  for (const line of lines) {
    const tableMatch = line.match(tableStatusPattern)
    if (tableMatch) {
      const tid = requiredCapture(tableMatch, 1)
      const tableStatus = requiredCapture(tableMatch, 2).trim()
      if (VALID_TASK_STATUSES.has(tableStatus)) {
        const task = tasks.get(tid)
        if (task && task.status === 'pending' && tableStatus !== 'pending') {
          task.status = tableStatus as TaskStatus
        }
      }
    }
  }

  return { title, status, sprints, tasks }
}

// ─── Computed Functions ───────────────────────────────────────────────────────

/**
 * A task is "done" when:
 * - validate: true → status must be 'validated'
 * - validate: false → status must be 'completed'
 */
export function isTaskDone(task: PlanTask): boolean {
  if (task.validate) {
    return task.status === 'validated'
  }
  return task.status === 'completed' || task.status === 'validated'
}

/**
 * A task is in a terminal state (no more transitions expected).
 */
export function isTaskTerminal(task: PlanTask): boolean {
  return task.status === 'validated'
    || task.status === 'failed'
    || task.status === 'blocked'
    || task.status === 'skipped'
    || (task.status === 'completed' && !task.validate)
}

/**
 * A sprint is complete when ALL its tasks are in a terminal state.
 */
export function isSprintComplete(plan: PlanState, sprintId: string): boolean {
  const sprint = plan.sprints.find((s) => s.id === sprintId)
  if (!sprint) return false
  const allTerminal = sprint.taskIds.every((tid) => {
    const task = plan.tasks.get(tid)
    return task ? isTaskTerminal(task) : false
  })
  if (!allTerminal) return false
  if (sprint.gateTaskId) {
    const gateTask = plan.tasks.get(sprint.gateTaskId)
    if (!gateTask || gateTask.status !== 'validated') return false
  }
  return true
}

/**
 * All sprints in the plan are complete.
 */
export function areAllSprintsComplete(plan: PlanState): boolean {
  if (plan.sprints.length === 0) return false
  return plan.sprints.every((s) => isSprintComplete(plan, s.id))
}

/**
 * All work finished successfully. Unlike terminal completion, failed, blocked,
 * or skipped tasks never satisfy this predicate.
 */
export function areAllSprintsSuccessful(plan: PlanState): boolean {
  if (plan.sprints.length === 0) return false
  return plan.sprints.every((sprint) =>
    sprint.taskIds.every((taskId) => {
      const task = plan.tasks.get(taskId)
      return Boolean(task && isTaskDone(task))
    }),
  )
}

/**
 * Get tasks that are ready to execute:
 * - status is 'pending'
 * - all dependencies are "done"
 */
export function getReadyTasks(plan: PlanState): PlanTask[] {
  const ready: PlanTask[] = []
  for (const task of plan.tasks.values()) {
    if (task.status !== 'pending') continue
    const allDepsDone = task.dependsOn.every((depId) => {
      const dep = plan.tasks.get(depId)
      return dep ? isTaskDone(dep) : false
    })
    if (allDepsDone) ready.push(task)
  }
  return ready
}

/**
 * Get the current sprint — the first sprint that is not yet complete.
 */
export function getCurrentSprint(plan: PlanState): PlanSprint | null {
  for (const sprint of plan.sprints) {
    if (!isSprintComplete(plan, sprint.id)) return sprint
  }
  return null
}

/**
 * Check if all dependencies of a specific task are satisfied.
 */
export function checkDependencies(plan: PlanState, taskId: string): { satisfied: boolean; blocking: Array<{ id: string; status: TaskStatus }> } {
  const task = plan.tasks.get(taskId)
  if (!task) return { satisfied: false, blocking: [{ id: taskId, status: 'pending' }] }

  const blocking: Array<{ id: string; status: TaskStatus }> = []
  for (const depId of task.dependsOn) {
    const dep = plan.tasks.get(depId)
    if (!dep || !isTaskDone(dep)) {
      blocking.push({ id: depId, status: dep?.status || 'pending' })
    }
  }

  return { satisfied: blocking.length === 0, blocking }
}

/**
 * Extract a task ID (T{N}) from a task description string.
 */
export function extractTaskId(taskString: string): string | null {
  const match = taskString.match(/\bT(\d+)\b/)
  return match ? `T${requiredCapture(match, 1)}` : null
}

// ─── Format Validator ─────────────────────────────────────────────────────────

const REQUIRED_TASK_FIELDS = ['Agent', 'Status', 'Validate', 'Depends on']

/**
 * Validate that plan.md conforms to the expected format.
 * Returns specific, actionable error messages.
 */
export function validatePlanFormat(filepath: string): { valid: boolean; errors: string[] } {
  let content: string
  try {
    content = fs.readFileSync(filepath, 'utf-8')
  } catch {
    return { valid: false, errors: ['Cannot read plan.md'] }
  }

  const lines = content.split('\n')
  const errors: string[] = []

  if (!content.match(/^# Plan:\s*.+/m)) {
    errors.push('Missing plan title. Expected: "# Plan: {title}"')
  }
  if (!content.match(/\*\*Status:\*\*\s*\S+/)) {
    errors.push('Missing plan status. Expected: "**Status:** draft | executing | completed | failed"')
  }

  let sprintCount = 0
  let taskCount = 0
  let currentTaskId: string | null = null
  let currentTaskFields = new Set<string>()

  const wrongSprintHeaders: string[] = []
  const wrongTaskHeaders: string[] = []

  const finalizeTask = () => {
    if (!currentTaskId) return
    for (const field of REQUIRED_TASK_FIELDS) {
      if (!currentTaskFields.has(field)) {
        errors.push(`Task ${currentTaskId}: missing required field "- **${field}:**"`)
      }
    }
    currentTaskId = null
    currentTaskFields = new Set()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const lineNum = i + 1

    if (line.match(/^#{2}\s+Sprint\s+\d+/i) && !line.match(/^### S\d+:/)) {
      wrongSprintHeaders.push(
        `Line ${lineNum}: "${line.trim()}" \u2014 sprint header must use "### S{N}: {name}" format`
      )
    }

    if (line.match(/^#{3}\s+T\d+:/) && !line.match(/^#### T\d+:/)) {
      wrongTaskHeaders.push(
        `Line ${lineNum}: "${line.trim()}" \u2014 task header must use "#### T{N}: {title}" format`
      )
    }

    if (line.match(/^### S(\d+):\s*(.+)/)) {
      finalizeTask()
      sprintCount++
      continue
    }

    const taskMatch = line.match(/^#### T(\d+):\s*(.+)/)
    if (taskMatch) {
      finalizeTask()
      currentTaskId = `T${requiredCapture(taskMatch, 1)}`
      currentTaskFields = new Set()
      taskCount++
      continue
    }

    if (!currentTaskId) continue

    const fieldMatch = line.match(/^- \*\*(\w[\w\s]*\w|\w+):\*\*\s*(.*)/)
    if (fieldMatch) {
      const fieldName = requiredCapture(fieldMatch, 1)
      const fieldValue = requiredCapture(fieldMatch, 2).trim()
      currentTaskFields.add(fieldName)

      if (fieldName === 'Status' && !VALID_TASK_STATUSES.has(fieldValue)) {
        errors.push(
          `Task ${currentTaskId}: invalid status "${fieldValue}". Must be one of: ${[...VALID_TASK_STATUSES].join(', ')}`
        )
      }
      if (fieldName === 'Result file' && !isSafePlanResultFile(fieldValue)) {
        errors.push(
          `Task ${currentTaskId}: result file must be a safe assignment-relative path outside '${RUN_PRIVATE_RUNTIME_DIRECTORY_NAME}'`,
        )
      }
    }
  }

  finalizeTask()
  errors.unshift(...wrongSprintHeaders, ...wrongTaskHeaders)

  if (sprintCount === 0) {
    errors.push('No sprints found. Sprint headers must use "### S{N}: {name}" format.')
  }
  if (taskCount === 0) {
    errors.push('No tasks found. Task headers must use "#### T{N}: {title}" format.')
  }

  return { valid: errors.length === 0, errors }
}

// ─── Plan Updater ─────────────────────────────────────────────────────────────

const PLAN_UPDATE_LOCK_TIMEOUT_MS = 5_000
const PLAN_UPDATE_LOCK_RETRY_MS = 10
// New reclaim guards are atomically published files. This age applies only to
// ownerless directories left behind by the pre-atomic guard implementation.
const LEGACY_OWNERLESS_RECLAIM_GUARD_MAX_AGE_MS = 60_000
const LEGACY_RECLAIM_GUARD_OWNER_FILENAME = 'owner.json'

interface PlanUpdateLockRecord {
  pid: number
  nonce: string
  createdAt: string
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  )
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readPlanUpdateLock(lockPath: string): PlanUpdateLockRecord | null {
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return null
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<PlanUpdateLockRecord>
    if (
      !Number.isInteger(value.pid) ||
      typeof value.nonce !== 'string' ||
      !value.nonce ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return null
    }
    return value as PlanUpdateLockRecord
  } catch {
    return null
  }
}

function reclaimStalePlanUpdateLock(lockPath: string): void {
  const reclaimPath = `${lockPath}.reclaim`
  const guard = acquirePlanUpdateReclaimGuard(reclaimPath)
  if (!guard) return

  try {
    let stats: fs.Stats
    try {
      stats = fs.lstatSync(lockPath)
    } catch {
      return
    }
    if (!stats.isFile() || stats.isSymbolicLink()) return

    const record = readPlanUpdateLock(lockPath)
    if (!record || processIsAlive(record.pid)) return
    if (!ownsPlanUpdateReclaimGuard(reclaimPath, guard)) return
    const currentStats = fs.lstatSync(lockPath)
    const currentRecord = readPlanUpdateLock(lockPath)
    if (
      currentStats.dev !== stats.dev ||
      currentStats.ino !== stats.ino ||
      currentRecord?.pid !== record?.pid ||
      currentRecord?.nonce !== record?.nonce
    ) {
      return
    }
    fs.unlinkSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally {
    releasePlanUpdateReclaimGuard(reclaimPath, guard)
  }
}

function planUpdateReclaimInProgress(lockPath: string): boolean {
  const reclaimPath = `${lockPath}.reclaim`
  removeOrphanedPlanUpdateReclaimGuard(reclaimPath)
  try {
    fs.lstatSync(reclaimPath)
    return true
  } catch {
    return false
  }
}

function acquirePlanUpdateReclaimGuard(
  reclaimPath: string,
): PlanUpdateLockRecord | null {
  removeOrphanedPlanUpdateReclaimGuard(reclaimPath)

  const guard: PlanUpdateLockRecord = {
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  }
  return publishPlanUpdateFileLock(reclaimPath, guard) ? guard : null
}

function ownsPlanUpdateReclaimGuard(
  reclaimPath: string,
  guard: PlanUpdateLockRecord,
): boolean {
  const current = readPlanUpdateLock(reclaimPath)
  return current?.pid === guard.pid && current.nonce === guard.nonce
}

function releasePlanUpdateReclaimGuard(
  reclaimPath: string,
  guard: PlanUpdateLockRecord,
): void {
  if (!ownsPlanUpdateReclaimGuard(reclaimPath, guard)) return
  try {
    fs.unlinkSync(reclaimPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

interface PlanUpdateReclaimGuardSnapshot {
  dev: number
  ino: number
  kind: 'file' | 'legacy_directory'
  mtimeMs: number
  record: PlanUpdateLockRecord | null
}

function readPlanUpdateReclaimGuardSnapshot(
  reclaimPath: string,
): PlanUpdateReclaimGuardSnapshot | null {
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(reclaimPath)
  } catch {
    return null
  }
  if (stats.isSymbolicLink()) return null
  const kind = stats.isFile()
    ? 'file'
    : stats.isDirectory()
      ? 'legacy_directory'
      : null
  if (!kind) return null
  const record = readPlanUpdateLock(
    kind === 'file'
      ? reclaimPath
      : path.join(reclaimPath, LEGACY_RECLAIM_GUARD_OWNER_FILENAME),
  )
  return {
    dev: stats.dev,
    ino: stats.ino,
    kind,
    mtimeMs: stats.mtimeMs,
    record,
  }
}

function samePlanUpdateReclaimGuard(
  left: PlanUpdateReclaimGuardSnapshot,
  right: PlanUpdateReclaimGuardSnapshot,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.kind === right.kind &&
    left.record?.pid === right.record?.pid &&
    left.record?.nonce === right.record?.nonce
}

function planUpdateReclaimGuardIsOrphaned(
  snapshot: PlanUpdateReclaimGuardSnapshot,
): boolean {
  if (snapshot.record) return !processIsAlive(snapshot.record.pid)
  return snapshot.kind === 'legacy_directory' &&
    Date.now() - snapshot.mtimeMs >= LEGACY_OWNERLESS_RECLAIM_GUARD_MAX_AGE_MS
}

function removeOrphanedPlanUpdateReclaimGuard(reclaimPath: string): boolean {
  const observed = readPlanUpdateReclaimGuardSnapshot(reclaimPath)
  if (!observed || !planUpdateReclaimGuardIsOrphaned(observed)) return false
  const confirmed = readPlanUpdateReclaimGuardSnapshot(reclaimPath)
  if (
    !confirmed ||
    !samePlanUpdateReclaimGuard(observed, confirmed) ||
    !planUpdateReclaimGuardIsOrphaned(confirmed)
  ) {
    return false
  }

  const quarantinePath = `${reclaimPath}.orphan-${process.pid}-${randomUUID()}`
  try {
    fs.renameSync(reclaimPath, quarantinePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const moved = readPlanUpdateReclaimGuardSnapshot(quarantinePath)
  if (
    !moved ||
    !samePlanUpdateReclaimGuard(confirmed, moved) ||
    !planUpdateReclaimGuardIsOrphaned(moved)
  ) {
    try {
      fs.renameSync(quarantinePath, reclaimPath)
    } catch {
      // A newer guard won the canonical path; its owner will retain authority.
    }
    return false
  }
  if (moved.kind === 'legacy_directory') {
    fs.rmSync(quarantinePath, { recursive: true, force: true })
  } else {
    try {
      fs.unlinkSync(quarantinePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return true
}

function publishPlanUpdateFileLock(
  lockPath: string,
  record: PlanUpdateLockRecord,
): boolean {
  const candidatePath = `${lockPath}.candidate-${record.pid}-${record.nonce}`
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(candidatePath, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`)
    fs.fsyncSync(descriptor)
    try {
      fs.linkSync(candidatePath, lockPath)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(candidatePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function acquirePlanUpdateLock(lockPath: string): PlanUpdateLockRecord | null {
  const deadline = Date.now() + PLAN_UPDATE_LOCK_TIMEOUT_MS
  while (Date.now() <= deadline) {
    if (planUpdateReclaimInProgress(lockPath)) {
      sleepSync(PLAN_UPDATE_LOCK_RETRY_MS)
      continue
    }
    const record: PlanUpdateLockRecord = {
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    }
    try {
      if (!publishPlanUpdateFileLock(lockPath, record)) {
        reclaimStalePlanUpdateLock(lockPath)
        sleepSync(PLAN_UPDATE_LOCK_RETRY_MS)
        continue
      }
      if (planUpdateReclaimInProgress(lockPath)) {
        releasePlanUpdateLock(lockPath, record)
        sleepSync(PLAN_UPDATE_LOCK_RETRY_MS)
        continue
      }
      return record
    } catch (error) {
      return null
    }
  }
  return null
}

function releasePlanUpdateLock(
  lockPath: string,
  owned: PlanUpdateLockRecord,
): void {
  const current = readPlanUpdateLock(lockPath)
  if (current?.nonce !== owned.nonce || current.pid !== owned.pid) return
  try {
    fs.unlinkSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function isRegularNonSymlink(filepath: string): fs.Stats | null {
  try {
    const stats = fs.lstatSync(filepath)
    return stats.isFile() && !stats.isSymbolicLink() ? stats : null
  } catch {
    return null
  }
}

function writePlanAtomically(
  filepath: string,
  content: string,
  mode: number,
): void {
  const directory = path.dirname(filepath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filepath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', mode & 0o777)
    fs.writeFileSync(descriptor, content)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null

    // Never follow or overwrite an existing symlink target.
    if (!isRegularNonSymlink(filepath)) {
      throw new Error('Plan target is no longer a regular file.')
    }
    fs.renameSync(temporaryPath, filepath)

    const directoryDescriptor = fs.openSync(directory, 'r')
    try {
      fs.fsyncSync(directoryDescriptor)
    } finally {
      fs.closeSync(directoryDescriptor)
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    fs.rmSync(temporaryPath, { force: true })
  }
}

/**
 * Find and auto-skip all tasks that (transitively) depend on a skipped task.
 * Updates plan.md for each dependent and returns their IDs.
 * Only skips tasks that are currently 'pending'. Re-scans until a fixpoint is
 * reached so that dependents-of-dependents are also skipped.
 */
export function autoSkipDependents(planPath: string, skippedTaskId: string): string[] {
  const skipped: string[] = []

  // Track the set of tasks treated as blocked (the seed + every newly-skipped one).
  const blocked = new Set<string>([skippedTaskId])
  let changed = true
  while (changed) {
    changed = false
    const plan = parsePlan(planPath)
    if (!plan) break

    for (const task of plan.tasks.values()) {
      if (task.status !== 'pending') continue
      if (skipped.includes(task.id)) continue
      if (task.dependsOn.some((dep) => blocked.has(dep))) {
        if (!updateTaskStatus(planPath, task.id, 'skipped', 'pending')) {
          throw new Error(
            `Could not persist skipped status for dependent task '${task.id}'.`,
          )
        }
        skipped.push(task.id)
        blocked.add(task.id)
        changed = true
      }
    }
  }

  return skipped
}

/**
 * Return tasks claimed by a dead pipeline process to the runnable set.
 * Callers must invoke this only for an explicitly authorized recovery attempt.
 */
export function recoverInterruptedPipelineTasks(planPath: string): string[] {
  const plan = parsePlan(planPath)
  if (!plan) {
    throw new Error(`Cannot read pipeline plan during recovery: ${planPath}`)
  }

  const recovered: string[] = []
  for (const task of plan.tasks.values()) {
    if (task.status !== 'in_progress') continue
    if (!updateTaskStatus(planPath, task.id, 'pending', 'in_progress')) {
      throw new Error(
        `Could not recover interrupted pipeline task '${task.id}'.`,
      )
    }
    recovered.push(task.id)
  }
  return recovered
}

/**
 * Update a task's status in plan.md.
 * Returns true if the file was modified.
 */
export function updateTaskStatus(
  filepath: string,
  taskId: string,
  newStatus: TaskStatus,
  expectedStatus?: TaskStatus,
): boolean {
  const normalizedPath = path.resolve(filepath)
  if (!isRegularNonSymlink(normalizedPath)) return false

  const lockPath = `${normalizedPath}.status.lock`
  const lock = acquirePlanUpdateLock(lockPath)
  if (!lock) return false

  try {
    const targetStats = isRegularNonSymlink(normalizedPath)
    if (!targetStats) return false

    let content: string
    try {
      content = fs.readFileSync(normalizedPath, 'utf-8')
    } catch {
      return false
    }

    const lines = content.split('\n')
    const taskHeaderPattern = new RegExp(`^#### ${taskId}:\\s`)
    let inTask = false
    let modified = false
    let agentLineIndex = -1

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''

      if (taskHeaderPattern.test(line)) {
        inTask = true
        agentLineIndex = -1
        continue
      }

      if (inTask && /^#{2,4}\s/.test(line)) {
        if (!modified && agentLineIndex >= 0) {
          lines.splice(agentLineIndex + 1, 0, `- **Status:** ${newStatus}`)
          modified = true
        }
        break
      }

      if (!inTask) continue

      if (line.match(/^- \*\*Agent:\*\*/)) {
        agentLineIndex = i
      }

      if (line.match(/^- \*\*Status:\*\*/)) {
        const currentStatus = line
          .replace(/^- \*\*Status:\*\*\s*/, '')
          .trim() as TaskStatus
        if (expectedStatus !== undefined && currentStatus !== expectedStatus) {
          return false
        }
        lines[i] = `- **Status:** ${newStatus}`
        modified = true
        inTask = false
      }
    }

    if (inTask && !modified && agentLineIndex >= 0) {
      if (expectedStatus !== undefined) return false
      lines.splice(agentLineIndex + 1, 0, `- **Status:** ${newStatus}`)
      modified = true
    }

    if (modified) {
      writePlanAtomically(
        normalizedPath,
        lines.join('\n'),
        targetStats.mode,
      )
    }
    return modified
  } catch {
    return false
  } finally {
    releasePlanUpdateLock(lockPath, lock)
  }
}
