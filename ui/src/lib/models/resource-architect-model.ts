export type {
  ChatTurn,
  CreateResourceRef,
  PlannedAgentSpec,
  ResourceArchitectPlan,
  ResourceArchitectOperation,
  ResourceArchitectTurnHttpResponse as ResourceArchitectTurnResponse,
  ResourceArchitectTurnMetric,
  ResourceArchitectTurnOutcome,
  ResourceBuildEvent,
  ResourceBuildEventType,
  ResourceBuildItem,
  ResourceBuildItemStatus,
  ResourceBuildJobSnapshot,
  ResourceBuildJobStatus,
  ResourceTeamAgentPlan,
  ResourceTeamNewAgentPlan,
  ResourceTeamPlan,
  ResourceSkillUpdate,
  ResourceSkillUpdateStatus,
  ResourceUpdateOperation,
  ResourceUpdatePlan,
} from "@contracts/resource-architect";

export interface ResourceArchitectTurnCancelledResponse {
  jobId: string;
  operation?: "conversation" | "proposal";
  cancelled: true;
}
