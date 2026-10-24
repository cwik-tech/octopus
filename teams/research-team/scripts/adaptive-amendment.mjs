import * as crypto from 'node:crypto'
import * as fs from 'node:fs'

export function readAndValidateAdaptiveAmendment(params) {
  const stats = fs.lstatSync(params.amendmentPath)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Deep Research plan amendment must be a regular file.')
  }
  if (stats.size > 256 * 1024) {
    throw new Error('Deep Research plan amendment exceeds its size limit.')
  }
  const amendment = JSON.parse(fs.readFileSync(params.amendmentPath, 'utf8'))
  const expectedVerdictHash = hashResearchValue(params.verdict)
  if (
    amendment?.schemaVersion !== 1 ||
    typeof amendment.amendmentId !== 'string' ||
    amendment.planId !== params.plan.planId ||
    amendment.approvedPlanHash !== params.plan.approvalHash ||
    amendment.sourceVerdictPath !== params.sourceVerdictPath ||
    amendment.sourceVerdictHash !== expectedVerdictHash ||
    amendment.fromWave !== params.verdict.correctionWave ||
    amendment.toWave !== params.verdict.correctionWave + 1 ||
    amendment.route !== params.expectedRoute ||
    amendment.scopeChange !== 'none' ||
    !Number.isInteger(amendment.expectedInformationGain) ||
    amendment.expectedInformationGain < 0 ||
    amendment.expectedInformationGain > 100
  ) {
    throw new Error(
      'Deep Research plan amendment is not bound to the approved plan and source verdict.',
    )
  }
  if (
    params.plan.executionPolicy &&
    amendment.approvedMaxCostUsd !== params.plan.executionPolicy.maxCostUsd
  ) {
    throw new Error(
      'Deep Research plan amendment changes the approved research cost boundary.',
    )
  }
  const targetTaskIds = uniqueSorted(
    params.verdict.correctionRequests.flatMap((request) => request.taskIds ?? []),
  )
  if (!sameStrings(amendment.targetTaskIds, targetTaskIds)) {
    throw new Error(
      'Deep Research plan amendment task targets do not match the source verdict.',
    )
  }
  return amendment
}

export function hashResearchValue(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

function uniqueSorted(values) {
  return [...new Set(values)].sort()
}

function sameStrings(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  )
}
