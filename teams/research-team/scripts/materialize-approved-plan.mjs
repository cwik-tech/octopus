import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { hashResearchValue } from './adaptive-amendment.mjs'

const inputPath = requiredEnvironmentPath('TRANSFORM_INPUT')
const outputPath = requiredEnvironmentPath('TRANSFORM_OUTPUT')
const workspacePath = requiredEnvironmentPath('WORKSPACE_PATH')

assertInside(workspacePath, inputPath, 'input')
assertInside(workspacePath, outputPath, 'output')

const briefPath = path.join(workspacePath, 'incoming-brief.md')
assertInside(workspacePath, briefPath, 'brief')
const brief = fs.readFileSync(briefPath, 'utf8')
const runtimeMarker = '<!-- pipeline-runtime:approved-deep-research-plan:v1 -->'
const markerIndex = brief.lastIndexOf(runtimeMarker)
if (markerIndex < 0) {
  throw new Error('The delegated brief does not contain the runtime-approved Deep Research plan block.')
}
const jsonText = extractJsonObject(brief.slice(markerIndex + runtimeMarker.length))
const plan = JSON.parse(jsonText)
validateExecutablePlan(plan)

writeAtomic(outputPath, `${JSON.stringify(plan, null, 2)}\n`)
const startedAt = new Date()
writeAtomic(
  path.join(workspacePath, 'research', 'runtime-limits.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    planId: plan.planId,
    maxDurationMinutes: plan.maxDurationMinutes,
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(startedAt.getTime() + (plan.maxDurationMinutes * 60_000)).toISOString(),
  }, null, 2)}\n`,
)
writeAtomic(
  path.join(workspacePath, 'research', 'plan.md'),
  buildPipelinePlan(plan),
)

function validateExecutablePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('Approved Deep Research plan must be a JSON object.')
  }
  if (plan.schemaVersion !== 1) {
    throw new Error('Approved Deep Research plan must use schema version 1.')
  }
  if (typeof plan.approvedAt !== 'string' || typeof plan.approvalHash !== 'string') {
    throw new Error('Deep Research plan is missing runtime approval fields.')
  }
  if (
    !Number.isFinite(Date.parse(plan.approvedAt)) ||
    !/^[a-f0-9]{64}$/.test(plan.approvalHash)
  ) {
    throw new Error('Deep Research plan has invalid runtime approval fields.')
  }
  const {
    approvedAt: _approvedAt,
    approvalHash,
    ...unapprovedPlan
  } = plan
  if (hashResearchValue(unapprovedPlan) !== approvalHash) {
    throw new Error('Deep Research plan approval hash does not match its contents.')
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('Approved Deep Research plan has no tasks.')
  }
  if (!Number.isInteger(plan.maxDurationMinutes) || plan.maxDurationMinutes < 5 || plan.maxDurationMinutes > 120) {
    throw new Error('Approved Deep Research duration must be between 5 and 120 minutes.')
  }
  if (!Number.isInteger(plan.maxResearcherAgents) || plan.maxResearcherAgents < 1 || plan.maxResearcherAgents > 8) {
    throw new Error('Approved Deep Research researcher limit must be between 1 and 8.')
  }
  if (!Array.isArray(plan.workerSpecs) || plan.workerSpecs.length !== plan.tasks.length) {
    throw new Error('Every approved research task must have one worker specification.')
  }

  const taskIds = new Set()
  const workerById = new Map(plan.workerSpecs.map((worker) => [worker.id, worker]))
  for (const task of plan.tasks) {
    if (!/^T[1-9]\d*$/.test(task.id)) {
      throw new Error(`Research task '${String(task.id)}' must use an executable T-number ID.`)
    }
    if (taskIds.has(task.id)) throw new Error(`Duplicate research task '${task.id}'.`)
    taskIds.add(task.id)
    const worker = workerById.get(task.workerSpecId)
    if (!worker || worker.baseAgent !== 'web-researcher') {
      throw new Error(`Research task '${task.id}' must use the trusted web-researcher capability.`)
    }
    if (worker.question !== task.question) {
      throw new Error(`Research task '${task.id}' question does not match its worker specification.`)
    }
  }
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!taskIds.has(dependency)) {
        throw new Error(`Research task '${task.id}' has unknown dependency '${dependency}'.`)
      }
    }
  }
}

function buildPipelinePlan(plan) {
  const lines = [
    '# Plan: Approved Deep Research Evidence Collection',
    '**Status:** executing',
    '',
    '### S1: Approved Research Tasks',
  ]
  for (const task of plan.tasks) {
    lines.push(
      `#### ${task.id}: ${singleLine(task.title)}`,
      '- **Agent:** web-researcher',
      '- **Status:** pending',
      '- **Validate:** false',
      `- **Depends on:** ${(task.dependsOn ?? []).join(', ') || 'none'}`,
      '- **Gate:** false',
      `- **Result file:** research/evidence/wave-0/${task.id}.json`,
      '',
    )
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function extractJsonObject(value) {
  const start = value.indexOf('{')
  if (start < 0) throw new Error('Approved Deep Research plan JSON was not found.')
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return value.slice(start, index + 1)
    }
  }
  throw new Error('Approved Deep Research plan JSON is incomplete.')
}

function requiredEnvironmentPath(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return path.resolve(value)
}

function assertInside(rootPath, candidatePath, label) {
  const relative = path.relative(path.resolve(rootPath), candidatePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Transform ${label} path must stay inside the assignment.`)
  }
}

function singleLine(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

function writeAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  fs.writeFileSync(temporaryPath, contents, { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporaryPath, filePath)
}
