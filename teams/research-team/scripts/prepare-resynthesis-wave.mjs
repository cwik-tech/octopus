import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CRITIC_FALLBACK_MS,
  CRITIC_FLOOR_MS,
  SYNTHESIS_FALLBACK_MS,
  SYNTHESIS_FLOOR_MS,
  estimateDurationMs,
  observedAgentDurationMs,
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

const workspacePath = requiredPath('WORKSPACE_PATH')
const inputPath = requiredPath('TRANSFORM_INPUT')
const outputPath = requiredPath('TRANSFORM_OUTPUT')
assertInside(workspacePath, inputPath, 'input')
assertInside(workspacePath, outputPath, 'output')
assertNoSymlinkComponents(path.dirname(outputPath))
assertWritableOutputTarget(outputPath)

const verdict = readRegularJson(inputPath, 'quality verdict')
const plan = readRegularJson(ownedPath('research/approved-plan.json'), 'approved plan')
const limits = readRegularJson(ownedPath('research/runtime-limits.json'), 'runtime limits')
const deterministic = readRegularJson(
  ownedPath('research/quality/deterministic-verdict.json'),
  'deterministic verdict',
)

if (
  verdict.schemaVersion !== 1 ||
  verdict.decision !== 'REVISE' ||
  verdict.correctionRoute !== 'synthesis'
) {
  throw new Error('Resynthesis materialization requires a synthesis-routed schema-v1 REVISE verdict.')
}
if (verdict.correctionWave !== 0 && verdict.correctionWave !== 1) {
  throw new Error('Only correction waves 1 and 2 may be materialized.')
}
if (
  !Array.isArray(verdict.correctionRequests) ||
  verdict.correctionRequests.length === 0 ||
  verdict.correctionRequests.some((request) => request?.type !== 'resynthesize')
) {
  throw new Error('Synthesis-only correction waves require non-empty resynthesize requests only.')
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
if (
  deterministic.schemaVersion !== 1 ||
  deterministic.correctionWave !== verdict.correctionWave ||
  deterministic.decision !== 'APPROVE' ||
  !Array.isArray(deterministic.findings) ||
  deterministic.findings.some((finding) => finding?.severity === 'blocking') ||
  !Array.isArray(deterministic.correctionRequests) ||
  deterministic.correctionRequests.length > 0
) {
  throw new Error('Synthesis-only routing is unsafe while deterministic evidence corrections remain.')
}

const remainingMs = Date.parse(limits.deadlineAt) - Date.now()
const requiredMs = minimumResynthesisCompletionMs()
if (remainingMs < requiredMs) {
  // Preflight refusal — no files have been written yet. Exit with the
  // route-unavailable code so the runtime skips this gate and evaluates
  // later gates instead of blocking the run.
  console.error(
    `Insufficient remaining execution budget for safe resynthesis: ` +
    `${Math.ceil(requiredMs / 1000)} seconds required, ${Math.max(0, Math.floor(remainingMs / 1000))} seconds remain. ` +
    'No synthesis wave was started; the latest quality verdict remains authoritative.',
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
      expectedRoute: 'synthesis',
    })
  : null
const reportPath = ownedPath('research-package.md')
const currentVerdictPath = ownedPath('research/quality/current-verdict.json')
assertRemovableRegularFile(reportPath, 'research report')
assertRemovableRegularFile(currentVerdictPath, 'current quality verdict')

writeImmutable(ownedPath(sourceVerdictPath), verdict)
writeImmutableText(
  ownedPath(`research/reports/report-wave-${verdict.correctionWave}.md`),
  readRegularText(reportPath, 'research report'),
)
writeImmutable(
  ownedPath(`research/quality/deterministic-review-wave-${verdict.correctionWave}.json`),
  deterministic,
)

const nextDeterministic = {
  ...deterministic,
  verdictId: `deterministic-resynthesis-${nextWave}-${hashResearchValue({
    priorVerdictId: deterministic.verdictId,
    sourceVerdictHash: hashResearchValue(verdict),
  }).slice(0, 12)}`,
  correctionWave: nextWave,
  reviewedAt: new Date().toISOString(),
}
writeImmutable(
  ownedPath(`research/quality/deterministic-verdict-wave-${nextWave}.json`),
  nextDeterministic,
)
writeAtomic(
  ownedPath('research/quality/deterministic-verdict.json'),
  `${JSON.stringify(nextDeterministic, null, 2)}\n`,
)

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
  taskRequests: {},
}
writeAtomic(outputPath, `${JSON.stringify(context, null, 2)}\n`)
fs.unlinkSync(reportPath)
fs.unlinkSync(currentVerdictPath)

function minimumResynthesisCompletionMs() {
  const agentRunLogPath = ownedPath('logs/agent-runs.jsonl')
  const synthesisMs = estimateDurationMs(
    observedAgentDurationMs(agentRunLogPath, 'research-synthesizer'),
    { fallbackMs: SYNTHESIS_FALLBACK_MS, floorMs: SYNTHESIS_FLOOR_MS },
  )
  const criticMs = estimateDurationMs(
    observedAgentDurationMs(agentRunLogPath, 'evidence-critic'),
    { fallbackMs: CRITIC_FALLBACK_MS, floorMs: CRITIC_FLOOR_MS },
  )
  return synthesisMs + criticMs
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
    throw new Error(`Resynthesis ${label} path must stay inside the assignment.`)
  }
}

function assertNoSymlinkComponents(directory) {
  const root = path.resolve(workspacePath)
  let current = root
  const relative = path.relative(root, path.resolve(directory))
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resynthesis output directory escapes the assignment.')
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) continue
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Resynthesis output uses a symbolic-link directory: ${segment}`)
    }
  }
}

function assertRemovableRegularFile(filePath, label) {
  const stats = fs.lstatSync(filePath)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file.`)
  }
}

function assertWritableOutputTarget(filePath) {
  if (!fs.existsSync(filePath)) return
  const stats = fs.lstatSync(filePath)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Resynthesis output must be a regular file when it already exists.')
  }
}

function readRegularJson(filePath, label) {
  return JSON.parse(readRegularText(filePath, label))
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
    if (readRegularText(filePath, 'immutable resynthesis artifact') !== contents) {
      throw new Error(`Immutable resynthesis artifact changed: ${path.basename(filePath)}`)
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
