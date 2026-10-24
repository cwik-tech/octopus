import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CRITIC_FALLBACK_MS,
  CRITIC_FLOOR_MS,
  RESEARCH_FALLBACK_MS,
  RESEARCH_FLOOR_MS,
  SYNTHESIS_FALLBACK_MS,
  SYNTHESIS_FLOOR_MS,
  estimateDurationMs,
  observedAgentDurationMs,
  observedResearchSpanMs,
} from './observed-duration-estimates.mjs'
import {
  hashResearchValue,
  readAndValidateAdaptiveAmendment,
} from './adaptive-amendment.mjs'

// Exit-code contract with the runtime (see ROUTE_UNAVAILABLE_EXIT_CODE in
// engines/gate-checker.ts): used only for the write-free insufficient-budget
// preflight refusal below so the runtime treats this gate route as
// unavailable and evaluates later gates. All other failures exit 1 via
// uncaught throws.
const ROUTE_UNAVAILABLE_EXIT_CODE = 69
const RESTRUCTURE_ONLY_RESEARCH_MS = 30_000

const workspacePath = requiredPath('WORKSPACE_PATH')
const inputPath = requiredPath('TRANSFORM_INPUT')
const outputPath = requiredPath('TRANSFORM_OUTPUT')
assertInside(workspacePath, inputPath, 'input')
assertInside(workspacePath, outputPath, 'output')
assertNoSymlinkComponents(path.dirname(outputPath))
assertWritableOutputTarget(outputPath)

const verdict = readRegularJson(inputPath, 'quality verdict')
const planPath = ownedPath('research/approved-plan.json')
const plan = readRegularJson(planPath, 'approved plan')
const limits = readRegularJson(ownedPath('research/runtime-limits.json'), 'runtime limits')
const manifest = readRegularJson(
  ownedPath('research/evidence/current-manifest.json'),
  'evidence manifest',
)

if (verdict.schemaVersion !== 1 || verdict.decision !== 'REVISE') {
  throw new Error('Correction materialization requires a schema-v1 REVISE verdict.')
}
if (verdict.correctionRoute === 'synthesis') {
  throw new Error('Synthesis-only corrections must not schedule research tasks.')
}
if (verdict.correctionWave !== 0 && verdict.correctionWave !== 1) {
  throw new Error('Only correction waves 1 and 2 may be materialized.')
}
if (!Array.isArray(verdict.correctionRequests) || verdict.correctionRequests.length === 0) {
  throw new Error('REVISE verdict has no correction requests.')
}
if (plan.schemaVersion !== 1 || typeof plan.approvalHash !== 'string') {
  throw new Error('Approved plan is missing its runtime approval hash.')
}
if (
  limits.schemaVersion !== 1 ||
  limits.planId !== plan.planId ||
  limits.maxDurationMinutes !== plan.maxDurationMinutes ||
  !Number.isFinite(Date.parse(limits.deadlineAt))
) {
  throw new Error('Deep Research runtime limits do not match the approved plan.')
}
if (Date.now() >= Date.parse(limits.deadlineAt)) {
  throw new Error('Approved Deep Research deadline expired before correction materialization.')
}
if (!manifest.latestByTask || typeof manifest.latestByTask !== 'object') {
  throw new Error('Evidence manifest is missing current task artifacts.')
}

const taskById = new Map(plan.tasks.map((task) => [task.id, task]))
const requestsByTask = {}
for (const request of verdict.correctionRequests) {
  if (!Array.isArray(request.taskIds) || request.taskIds.length === 0) {
    throw new Error(`Correction '${String(request.id)}' has no task targets.`)
  }
  for (const taskId of request.taskIds) {
    if (!taskById.has(taskId)) {
      throw new Error(`Correction references unknown task '${String(taskId)}'.`)
    }
    ;(requestsByTask[taskId] ??= []).push(request)
  }
}

const targetIds = Object.keys(requestsByTask).sort(taskNumberOrder)
const targetSet = new Set(targetIds)
const remainingMs = Date.parse(limits.deadlineAt) - Date.now()
const requiredMs = minimumCorrectionCompletionMs(requestsByTask)
if (remainingMs < requiredMs) {
  // Preflight refusal — no files have been written yet. Exit with the
  // route-unavailable code so the runtime skips this gate and evaluates
  // later gates instead of blocking the run.
  console.error(
    `Insufficient remaining execution budget for a safe correction wave: ` +
    `${Math.ceil(requiredMs / 1000)} seconds required, ${Math.max(0, Math.floor(remainingMs / 1000))} seconds remain. ` +
    'No correction tasks were started; the latest quality verdict remains authoritative.',
  )
  process.exit(ROUTE_UNAVAILABLE_EXIT_CODE)
}
const nextWave = verdict.correctionWave + 1
const sourceVerdictPath = `research/quality/verdict-wave-${verdict.correctionWave}.json`
const amendmentPath =
  `research/amendments/amendment-wave-${nextWave}.json`
const amendmentFilePath = ownedPath(amendmentPath)
const amendment = plan.executionPolicy || fs.existsSync(amendmentFilePath)
  ? readAndValidateAdaptiveAmendment({
      amendmentPath: amendmentFilePath,
      plan,
      verdict,
      sourceVerdictPath,
      expectedRoute: 'research',
    })
  : null
writeImmutable(ownedPath(sourceVerdictPath), verdict)

const reportPath = ownedPath('research-package.md')
if (fs.existsSync(reportPath)) {
  writeImmutableText(
    ownedPath(`research/reports/report-wave-${verdict.correctionWave}.md`),
    readRegularText(reportPath, 'research report'),
  )
}
const deterministicPath = ownedPath('research/quality/deterministic-verdict.json')
if (fs.existsSync(deterministicPath)) {
  writeImmutable(
    ownedPath(`research/quality/deterministic-review-wave-${verdict.correctionWave}.json`),
    readRegularJson(deterministicPath, 'deterministic verdict'),
  )
}

const executablePlanPath = ownedPath('research/plan.md')
const runtimePlanPath = ownedPath('.runtime/pipeline/collect-evidence/plan.md')
const completedPlanPath = fs.existsSync(runtimePlanPath) ? runtimePlanPath : executablePlanPath
if (fs.existsSync(completedPlanPath)) {
  writeImmutableText(
    ownedPath(`research/plans/plan-wave-${verdict.correctionWave}.md`),
    readRegularText(completedPlanPath, 'executable plan'),
  )
}
writeAtomic(executablePlanPath, buildCorrectionPlan(targetIds, targetSet, taskById, nextWave))

const context = {
  schemaVersion: 1,
  wave: nextWave,
  approvedPlanHash: plan.approvalHash,
  sourceVerdictPath,
  sourceVerdictHash: hashResearchValue(verdict),
  ...(amendment
    ? {
        amendmentPath,
        amendmentHash: hashResearchValue(amendment),
      }
    : {}),
  taskRequests: Object.fromEntries(targetIds.map((taskId) => [taskId, requestsByTask[taskId]])),
}
writeAtomic(outputPath, `${JSON.stringify(context, null, 2)}\n`)

function buildCorrectionPlan(targetIds, targetSet, taskById, wave) {
  const lines = [
    `# Plan: Deep Research Correction Wave ${wave}`,
    '**Status:** executing',
    '',
    `### S1: Targeted Corrections Wave ${wave}`,
  ]
  for (const taskId of targetIds) {
    const task = taskById.get(taskId)
    const dependencies = (task.dependsOn ?? []).filter((dependency) => targetSet.has(dependency))
    lines.push(
      `#### ${taskId}: ${singleLine(task.title)}`,
      '- **Agent:** web-researcher',
      '- **Status:** pending',
      '- **Validate:** false',
      `- **Depends on:** ${dependencies.join(', ') || 'none'}`,
      '- **Gate:** false',
      `- **Result file:** research/evidence/wave-${wave}/${taskId}.json`,
      '',
    )
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function minimumCorrectionCompletionMs(requestsByTask) {
  const researchMs = Object.values(requestsByTask).every((requests) =>
    requests.every((request) => request.type === 'restructure_packet'),
  )
    ? RESTRUCTURE_ONLY_RESEARCH_MS
    : estimateDurationMs(observedResearchSpanMs(ownedPath('research/evidence')), {
        fallbackMs: RESEARCH_FALLBACK_MS,
        floorMs: RESEARCH_FLOOR_MS,
      })
  const agentRunLogPath = ownedPath('logs/agent-runs.jsonl')
  const synthesisMs = estimateDurationMs(
    observedAgentDurationMs(agentRunLogPath, 'research-synthesizer'),
    { fallbackMs: SYNTHESIS_FALLBACK_MS, floorMs: SYNTHESIS_FLOOR_MS },
  )
  const criticMs = estimateDurationMs(
    observedAgentDurationMs(agentRunLogPath, 'evidence-critic'),
    { fallbackMs: CRITIC_FALLBACK_MS, floorMs: CRITIC_FLOOR_MS },
  )
  return researchMs + synthesisMs + criticMs
}

function ownedPath(relativePath) {
  const candidate = path.resolve(workspacePath, relativePath)
  assertInside(workspacePath, candidate, relativePath)
  assertNoSymlinkComponents(path.dirname(candidate))
  return candidate
}

function requiredPath(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return path.resolve(value)
}

function assertInside(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Correction ${label} path must stay inside the assignment.`)
  }
}

function assertNoSymlinkComponents(directory) {
  const root = path.resolve(workspacePath)
  let current = root
  const relative = path.relative(root, path.resolve(directory))
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Correction output directory escapes the assignment.')
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) continue
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Correction output uses a symbolic-link directory: ${segment}`)
    }
  }
}

function readRegularJson(filePath, label) {
  return JSON.parse(readRegularText(filePath, label))
}

function assertWritableOutputTarget(filePath) {
  if (!fs.existsSync(filePath)) return
  const stats = fs.lstatSync(filePath)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Correction output must be a regular file when it already exists.')
  }
}

function readRegularText(filePath, label) {
  const stats = fs.lstatSync(filePath)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file.`)
  }
  if (stats.size > 2 * 1024 * 1024) throw new Error(`${label} is too large.`)
  return fs.readFileSync(filePath, 'utf8')
}

function writeImmutable(filePath, value) {
  writeImmutableText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeImmutableText(filePath, contents) {
  if (fs.existsSync(filePath)) {
    if (readRegularText(filePath, 'immutable correction artifact') !== contents) {
      throw new Error(`Immutable correction artifact changed: ${path.basename(filePath)}`)
    }
    return
  }
  writeAtomic(filePath, contents)
}

function writeAtomic(filePath, contents) {
  assertInside(workspacePath, filePath, 'output')
  assertNoSymlinkComponents(path.dirname(filePath))
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  fs.writeFileSync(temporaryPath, contents, { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporaryPath, filePath)
}

function singleLine(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

function taskNumberOrder(left, right) {
  return Number(left.slice(1)) - Number(right.slice(1))
}
