import { whenDefined } from '../../core/optional-properties.js'
import {
  deriveTitleFromBrief,
  isUsableJobTitle,
  sanitizeRawTitle,
} from '../job-title/job-title-sanitize.js'

export interface ReceptionJobRequest {
  request_type: 'writing' | 'problem_analysis' | 'general'
  target_team: string
  requested_result_type: string
  job_title: string
  clarification_needed: boolean
  missing_inputs: string[]
  source: 'user' | 'external' | 'team'
  input_summary: string
  rationale: string
}

export interface ReceptionRoutingDecision {
  status: 'delegated'
  target_team: string
  requested_result_type: string
  rationale: string
  delegation_artifacts: {
    job_request: string
    brief: string
    result: string
  }
}

export interface UserFacingResultEnvelope {
  status: 'completed' | 'completed_with_warnings' | 'blocked' | 'failed' | 'delegated'
  primary_artifact?: string
  secondary_artifacts?: string[]
  summary: string
  open_issues?: string[]
  lineage?: Record<string, string>
}

function summarizeInput(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  return normalized.slice(0, 240) || '[No request summary available]'
}

function fallbackJobTitle(text: string): string {
  return deriveTitleFromBrief(text) ?? 'Untitled job'
}

function normalizeJobTitle(raw: string | null | undefined, fallbackSource: string): string {
  if (typeof raw === 'string') {
    const sanitized = sanitizeRawTitle(raw)
    if (sanitized && isUsableJobTitle(sanitized, fallbackSource)) return sanitized
  }
  return fallbackJobTitle(fallbackSource)
}

function summarizeResult(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
  return lines[0]?.slice(0, 240) || 'Delegated specialist result is available.'
}

export function inferReceptionRequestType(targetTeam: string): ReceptionJobRequest['request_type'] {
  if (targetTeam === 'writing-team') return 'writing'
  if (targetTeam === 'problem-thinking-board') return 'problem_analysis'
  return 'general'
}

export function buildReceptionJobRequest(params: {
  targetTeam: string
  requestedResultType: string
  brief: string
  rationale: string
  source?: ReceptionJobRequest['source']
  jobTitle?: string | null
}): ReceptionJobRequest {
  return {
    request_type: inferReceptionRequestType(params.targetTeam),
    target_team: params.targetTeam,
    requested_result_type: params.requestedResultType,
    job_title: normalizeJobTitle(params.jobTitle, params.brief),
    clarification_needed: false,
    missing_inputs: [],
    source: params.source ?? 'user',
    input_summary: summarizeInput(params.brief),
    rationale: params.rationale,
  }
}

export function buildReceptionRoutingDecision(params: {
  targetTeam: string
  requestedResultType: string
  rationale: string
  jobRequestPath: string
  briefArtifactPath: string
  resultArtifactPath: string
}): ReceptionRoutingDecision {
  return {
    status: 'delegated',
    target_team: params.targetTeam,
    requested_result_type: params.requestedResultType,
    rationale: params.rationale,
    delegation_artifacts: {
      job_request: params.jobRequestPath,
      brief: params.briefArtifactPath,
      result: params.resultArtifactPath,
    },
  }
}

export function buildUserFacingResultEnvelope(params: {
  childStatus: 'completed' | 'completed_with_warnings' | 'blocked' | 'failed'
  primaryArtifact?: string
  summarySource: string
  lineage?: Record<string, string>
}): UserFacingResultEnvelope {
  return {
    status: params.childStatus,
    ...whenDefined(params.primaryArtifact, (primary_artifact) => ({ primary_artifact })),
    summary: summarizeResult(params.summarySource),
    ...whenDefined(params.lineage, (lineage) => ({ lineage })),
  }
}
