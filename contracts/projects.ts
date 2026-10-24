import type { SessionSummary } from "./sessions.js";

export type WorkspaceProjectStatus = "active" | "archived";
export type WorkspaceProjectDeleteMode =
  | "delete_sessions"
  | "ungroup_sessions";

export interface WorkspaceProject {
  version: 1;
  id: string;
  name: string;
  description?: string;
  status: WorkspaceProjectStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface WorkspaceProjectSummary extends WorkspaceProject {
  sessionCount: number;
  activeSessionCount: number;
  latestActivityAt?: string;
}

export interface WorkspaceProjectMembership {
  version: 1;
  sessionId: string;
  projectId: string;
  assignedAt: string;
  updatedAt: string;
}

export interface WorkspaceProjectBrief {
  content: string;
  updatedAt: string;
}

export interface WorkspaceProjectFile {
  name: string;
  size: number;
  uploadedAt: string;
  parseStatus: "pending" | "parsing" | "parsed" | "error";
  parsedAt?: string;
  parserError?: string;
  outputs?: Record<string, string>;
}

export interface WorkspaceProjectContextSelection {
  projectId: string;
  includeBrief: boolean;
  fileNames: string[];
}

export interface WorkspaceProjectContextSnapshot {
  version: 1;
  projectId: string;
  projectUpdatedAt: string;
  capturedAt: string;
  brief?: WorkspaceProjectContextSnapshotFile;
  files: WorkspaceProjectContextSnapshotFile[];
}

export interface WorkspaceProjectContextSnapshotFile {
  name?: string;
  relativePath: string;
  mimeType?: string;
  sha256: string;
  byteLength: number;
}

export type WorkspaceProjectMemoryProposalStatus =
  | "pending"
  | "approved"
  | "rejected";

export interface WorkspaceProjectMemoryProposal {
  version: 1;
  id: string;
  projectId: string;
  content: string;
  sourceSessionId?: string;
  status: WorkspaceProjectMemoryProposalStatus;
  createdAt: string;
  decidedAt?: string;
}

export interface WorkspaceProjectExportFile extends WorkspaceProjectFile {
  contentBase64: string;
  sha256: string;
}

export interface WorkspaceProjectExportSchedule {
  id: string;
  name: string;
  kind: "agent" | "workflow";
  target: string;
  modelOverride?: { provider: string; model: string };
  projectId: string;
  projectContext?: {
    version: 1;
    includeBrief: boolean;
    fileNames: string[];
  };
  prompt: string;
  cron: string;
  timezone: string;
  scheduleLabel: string;
  overlap: "skip" | "queue" | "cancel_previous";
  notifyOnFailure: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceProjectExport {
  version: 1;
  exportedAt: string;
  project: WorkspaceProject;
  brief?: WorkspaceProjectBrief;
  files: WorkspaceProjectExportFile[];
  sessions: SessionSummary[];
  memoryProposals: WorkspaceProjectMemoryProposal[];
  schedules: WorkspaceProjectExportSchedule[];
}

export type WorkspaceProjectCatalogCategory =
  | "shared_input"
  | "session_input"
  | "delivery"
  | "artifact"
  | "evidence";

export type WorkspaceProjectCatalogResource =
  | {
      kind: "project_file";
      projectId: string;
      filename: string;
      resourcePath: string;
    }
  | {
      kind: "session_file";
      sessionId: string;
      filename: string;
      resourcePath: string;
    }
  | {
      kind: "run_artifact";
      runId: string;
      artifactPath: string;
      resourcePath: string;
    };

export interface WorkspaceProjectCatalogFile {
  id: string;
  name: string;
  category: WorkspaceProjectCatalogCategory;
  contentType: string;
  size?: number;
  capabilities: {
    preview: "artifact" | "browser" | "none";
    download: boolean;
    delete: boolean;
  };
  resource: WorkspaceProjectCatalogResource;
}

export interface WorkspaceProjectCatalogSession {
  id: string;
  title: string;
  updatedAt: string;
  childCount?: number;
}

export interface WorkspaceProjectCatalogRoot {
  version: 1;
  projectId: string;
  sharedInputs: WorkspaceProjectCatalogFile[];
  sessions: WorkspaceProjectCatalogSession[];
}

export interface WorkspaceProjectCatalogSessionBranch {
  version: 1;
  projectId: string;
  sessionId: string;
  inputs: WorkspaceProjectCatalogFile[];
  deliveries: WorkspaceProjectCatalogFile[];
  artifacts: WorkspaceProjectCatalogFile[];
  evidence: WorkspaceProjectCatalogFile[];
}

export const WORKSPACE_PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidWorkspaceProjectId(value: string): boolean {
  return WORKSPACE_PROJECT_ID_PATTERN.test(value);
}

export function isSafeWorkspaceProjectContextFilename(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 200 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(value);
    return decoded === value || isSafeWorkspaceProjectContextFilename(decoded);
  } catch {
    return false;
  }
}
