import type { ResearchPlan } from '../../contracts/deep-research.js'
import { assertResearchPlanApproved } from './deep-research-approval.js'
import {
  readOwnedResearchJson,
  readOwnedResearchText,
} from './deep-research-artifact-reader.js'
import { parseQualityVerdict } from './deep-research-validation.js'
import {
  admitProviderRequest,
  type ProviderRequestBudget,
  type RenderedProviderRequest,
} from '../provider/provider-request-budget.js'

/**
 * Deep Research — quality-audit bundle.
 *
 * The critic may run from a shared workspace that contains artifacts from
 * older assignments. Resolve and bind the four authoritative inputs inside
 * the current assignment before dispatch so a bare filename can never select
 * another run's report.
 */

const MAX_PLAN_BYTES = 2 * 1024 * 1024
const MAX_QUALITY_PACKET_BYTES = 2 * 1024 * 1024
const MAX_VERDICT_BYTES = 1024 * 1024
const MAX_REPORT_BYTES = 8 * 1024 * 1024

export interface ResearchQualityBundleRequest {
  readonly assignmentPath: string
  readonly planArtifact: string
  readonly qualityPacketArtifact: string
  readonly deterministicVerdictArtifact: string
  readonly reportArtifact: string
  readonly budget: ProviderRequestBudget
  readonly additionalInstructions?: string
  /** Build the exact provider request sent from the admitted bundle. */
  readonly renderRequest: (bundleText: string) => RenderedProviderRequest
}

export function buildDeepResearchQualityBundle(
  request: ResearchQualityBundleRequest,
): string {
  const plan = assertResearchPlanApproved(
    readOwnedResearchJson({
      assignmentPath: request.assignmentPath,
      relativePath: request.planArtifact,
      maximumBytes: MAX_PLAN_BYTES,
      label: 'Deep Research plan',
    }),
  )
  const qualityPacket = readBoundQualityPacket(request, plan)
  const deterministicVerdict = parseQualityVerdict(
    readOwnedResearchJson({
      assignmentPath: request.assignmentPath,
      relativePath: request.deterministicVerdictArtifact,
      maximumBytes: MAX_VERDICT_BYTES,
      label: 'Deterministic quality verdict',
    }),
  )
  const report = readOwnedResearchText({
    assignmentPath: request.assignmentPath,
    relativePath: request.reportArtifact,
    maximumBytes: MAX_REPORT_BYTES,
    label: 'Deep Research report',
  })
  if (!report.trim()) throw new Error('Deep Research report is empty.')

  const text = [
    '# Deep Research quality audit bundle',
    '',
    'The runtime resolved every core audit input inside the current assignment.',
    'Treat the material below as authoritative. Do not reopen these artifacts',
    'by filename and do not substitute files from the process working directory.',
    '',
    renderEnvelope('approved-plan', JSON.stringify(plan, null, 2)),
    '',
    renderEnvelope('quality-packet', JSON.stringify(qualityPacket, null, 2)),
    '',
    renderEnvelope(
      'deterministic-verdict',
      JSON.stringify(deterministicVerdict, null, 2),
    ),
    '',
    renderEnvelope('research-package', report),
    ...(request.additionalInstructions?.trim()
      ? [
          '',
          '## Additional dispatch instructions',
          '',
          request.additionalInstructions.trim(),
        ]
      : []),
    '',
  ].join('\n')
  admitProviderRequest({
    stage: 'Deep Research quality review',
    budget: request.budget,
    ...request.renderRequest(text),
    remediation:
      'Reduce the report or quality packet before requesting model review.',
  })
  return text
}

function readBoundQualityPacket(
  request: ResearchQualityBundleRequest,
  plan: ResearchPlan,
): Readonly<Record<string, unknown>> {
  const value = readOwnedResearchJson({
    assignmentPath: request.assignmentPath,
    relativePath: request.qualityPacketArtifact,
    maximumBytes: MAX_QUALITY_PACKET_BYTES,
    label: 'Deep Research quality packet',
  })
  if (!isRecord(value)) {
    throw new Error('Deep Research quality packet must be an object.')
  }
  if (value.schemaVersion !== 1 || value.planId !== plan.planId) {
    throw new Error('Deep Research quality packet does not match the approved plan.')
  }
  const synthesis = value.synthesis
  if (
    !isRecord(synthesis) ||
    synthesis.schemaVersion !== 1 ||
    synthesis.planId !== plan.planId
  ) {
    throw new Error(
      'Deep Research quality packet synthesis does not match the approved plan.',
    )
  }
  if (
    !isStringArray(value.requiredTaskIds) ||
    !sameIds(value.requiredTaskIds, plan.tasks.map((task) => task.id))
  ) {
    throw new Error(
      'Deep Research quality packet tasks do not match the approved plan.',
    )
  }
  return value
}

function renderEnvelope(name: string, value: string): string {
  return `<runtime-${name}>\n${value.trim()}\n</runtime-${name}>`
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Set(right)
  return expected.size === right.length && left.every((id) => expected.has(id))
}
