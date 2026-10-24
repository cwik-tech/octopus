import type {
  WorkspaceProjectBrief,
  WorkspaceProjectCatalogRoot,
  WorkspaceProjectFile,
  WorkspaceProjectMemoryProposal,
  WorkspaceProjectSummary,
} from "./projects.js";
import type { SessionSummary } from "./sessions.js";
import type { Schedule } from "./schedules.js";

export interface WorkspaceProjectDetails {
  version: 1;
  project: WorkspaceProjectSummary;
  brief: WorkspaceProjectBrief;
  files: WorkspaceProjectFile[];
  catalog: WorkspaceProjectCatalogRoot;
  sessions: SessionSummary[];
  schedules: Schedule[];
  memoryProposals: WorkspaceProjectMemoryProposal[];
}
