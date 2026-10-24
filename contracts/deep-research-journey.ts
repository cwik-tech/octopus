import type {
  CorrectionRequest,
  QualityFinding,
  QualityVerdict,
  ResearchPlan,
} from './deep-research.js'
import type { TaskStatus } from './sessions.js'
import type {
  DurableWorkflowStatus,
  DurableWorkflowStepStatus,
} from './workflows.js'

export const DEEP_RESEARCH_JOURNEY_VERSION = 1 as const
export const DEEP_RESEARCH_WORKFLOW_ID = 'deep-research-report' as const

export type DeepResearchJourneyPhase =
  | 'planning'
  | 'research'
  | 'editorial'
  | 'delivery'
  | 'escalation'

export type DeepResearchJourneyResearchStatus =
  | 'not_started'
  | 'collecting'
  | 'drafting'
  | 'synthesizing'
  | 'reviewing'
  | 'correcting'
  | 'blocked'
  | 'approved'

export type DeepResearchJourneyWorkerStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'

export type DeepResearchJourneyArtifactKind =
  | 'plan'
  | 'evidence'
  | 'evidence_graph'
  | 'section_dossier'
  | 'adaptive_decision'
  | 'amendment'
  | 'synthesis'
  | 'quality'
  | 'research_report'
  | 'editorial_draft'
  | 'final_markdown'
  | 'final_docx'
  | 'publication_audit'
  | 'escalation'

export type DeepResearchJourneyFinding = QualityFinding
export type DeepResearchJourneyCorrectionRequest = CorrectionRequest

export interface DeepResearchJourneyWorkflowStep {
  readonly id: 'research' | 'editorial' | 'publish'
  readonly status: DurableWorkflowStepStatus
  readonly runId: string
}

export interface DeepResearchJourneyWorkflow {
  readonly status: DurableWorkflowStatus | 'not_started'
  readonly revision: number | null
  readonly currentStepId: 'research' | 'editorial' | 'publish' | null
  readonly steps: readonly DeepResearchJourneyWorkflowStep[]
}

export interface DeepResearchJourneyWorker {
  readonly taskId: string
  readonly displayRole: string
  readonly status: DeepResearchJourneyWorkerStatus
  readonly attempt: number
}

export interface DeepResearchJourneyResearch {
  readonly status: DeepResearchJourneyResearchStatus
  readonly correctionWave: 0 | 1 | 2
  readonly workers: readonly DeepResearchJourneyWorker[]
  readonly block: {
    readonly kind: 'quality' | 'execution'
    readonly message: string
  } | null
}

export interface DeepResearchJourneyQuality {
  readonly decision: QualityVerdict['decision']
  readonly correctionRoute?: QualityVerdict['correctionRoute']
  readonly correctionWave: QualityVerdict['correctionWave']
  readonly reviewedAt: string
  readonly findings: readonly DeepResearchJourneyFinding[]
  readonly correctionRequests: readonly DeepResearchJourneyCorrectionRequest[]
}

export interface DeepResearchJourneyEscalation {
  readonly runId: string
  readonly relativePath: 'research/quality/escalation.md'
}

export interface DeepResearchJourneyArtifact {
  readonly kind: DeepResearchJourneyArtifactKind
  readonly label: string
  readonly runId: string
  readonly relativePath: string
  readonly mediaType: string
}

export interface DeepResearchJourneySnapshot {
  readonly version: typeof DEEP_RESEARCH_JOURNEY_VERSION
  readonly sessionId: string
  readonly taskId: string
  readonly workflowId: typeof DEEP_RESEARCH_WORKFLOW_ID
  readonly taskStatus: TaskStatus
  readonly phase: DeepResearchJourneyPhase
  readonly updatedAt: string
  readonly integrity: 'complete' | 'partial'
  readonly workflow: DeepResearchJourneyWorkflow
  readonly plan: ResearchPlan | null
  readonly research: DeepResearchJourneyResearch | null
  readonly quality: DeepResearchJourneyQuality | null
  readonly escalation: DeepResearchJourneyEscalation | null
  readonly artifacts: readonly DeepResearchJourneyArtifact[]
}
