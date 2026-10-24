import * as path from "node:path";

import type {
  WorkspaceProjectCatalogCategory,
  WorkspaceProjectCatalogFile,
  WorkspaceProjectCatalogRoot,
  WorkspaceProjectCatalogSessionBranch,
  WorkspaceProjectFile,
} from "../contracts/projects.js";
import type { SessionSummary } from "../contracts/sessions.js";
import type { RunStore, RunSummary } from "../domains/run/run-store.js";
import type { SessionStore } from "../domains/sessions/session-store.js";
import type { WorkspaceProjectContextStore } from "../domains/projects/project-context-store.js";
import {
  WorkspaceProjectServiceError,
  type WorkspaceProjectService,
} from "../domains/projects/workspace-project-service.js";

const PRIVATE_PATH_SEGMENTS = new Set([
  ".git",
  ".locks",
  ".runtime",
  "checkpoints",
  "input-snapshot",
  "locks",
  "logs",
  "mcp-resolution",
  "workflow-snapshot",
]);

const PRIVATE_ROOT_FILES = new Set([
  "incoming-brief.md",
  "job-request.md",
  "run.json",
  "task.json",
  "workflow.yaml",
]);

export class WorkspaceProjectFileCatalogService {
  private readonly projectService: WorkspaceProjectService;
  private readonly projectContextStore: WorkspaceProjectContextStore;
  private readonly sessionStore: SessionStore;
  private readonly runStore: RunStore;

  constructor(options: {
    projectService: WorkspaceProjectService;
    projectContextStore: WorkspaceProjectContextStore;
    sessionStore: SessionStore;
    runStore: RunStore;
  }) {
    this.projectService = options.projectService;
    this.projectContextStore = options.projectContextStore;
    this.sessionStore = options.sessionStore;
    this.runStore = options.runStore;
  }

  async listRoot(projectId: string): Promise<WorkspaceProjectCatalogRoot> {
    const [files, projectRead] = await Promise.all([
      this.projectContextStore.listFiles(projectId),
      this.projectService.getProjectWithSessions(projectId),
    ]);
    return buildProjectCatalogRoot(projectId, files, projectRead.sessions);
  }

  async listSessionBranch(
    projectId: string,
    sessionId: string,
  ): Promise<WorkspaceProjectCatalogSessionBranch> {
    await this.requireProjectSession(projectId, sessionId);
    const [files, tasks, messages, allRuns] = await Promise.all([
      this.sessionStore.listFiles(sessionId),
      this.sessionStore.listTaskRecords(sessionId),
      this.sessionStore.listChatMessages(sessionId),
      this.runStore.listRuns(),
    ]);
    const rootRunIds = new Set(tasks.map((task) => task.runId));
    const ownedRuns = allRuns.filter(
      (run) => rootRunIds.has(run.id) || Boolean(run.rootRunId && rootRunIds.has(run.rootRunId)),
    );
    const ownedRunIds = new Set(ownedRuns.map((run) => run.id));
    const deliveryKeys = new Set<string>();
    for (const message of messages) {
      for (const artifact of message.delivery?.artifacts ?? []) {
        if (ownedRunIds.has(artifact.runId)) {
          deliveryKeys.add(artifactKey(artifact.runId, artifact.path));
        }
      }
    }

    const deliveries: WorkspaceProjectCatalogFile[] = [];
    const artifacts: WorkspaceProjectCatalogFile[] = [];
    const evidence: WorkspaceProjectCatalogFile[] = [];
    for (const run of ownedRuns) {
      for (const artifactPath of run.artifactPaths) {
        if (isPrivateArtifactPath(artifactPath)) continue;
        const category = categorizeArtifact(
          run,
          artifactPath,
          deliveryKeys,
        );
        const entry = catalogFile({
          category,
          name: path.posix.basename(normalizeArtifactPath(artifactPath)),
          resource: {
            kind: "run_artifact",
            runId: run.id,
            artifactPath: normalizeArtifactPath(artifactPath),
            resourcePath: runArtifactResourcePath(run.id, artifactPath),
          },
        });
        if (category === "delivery") deliveries.push(entry);
        else if (category === "evidence") evidence.push(entry);
        else artifacts.push(entry);
      }
    }

    return {
      version: 1,
      projectId,
      sessionId,
      inputs: files
        .map((file) =>
          catalogFile({
            category: "session_input",
            name: file.name,
            size: file.size,
            resource: {
              kind: "session_file",
              sessionId,
              filename: file.name,
              resourcePath: sessionFileResourcePath(sessionId, file.name),
            },
          }),
        )
        .sort(compareCatalogFiles),
      deliveries: deduplicateAndSort(deliveries),
      artifacts: deduplicateAndSort(artifacts),
      evidence: deduplicateAndSort(evidence),
    };
  }

  private async requireProjectSession(
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    await this.projectService.getProjectRecord(projectId);
    const session = await this.projectService.getSession(sessionId);
    if (!session || session.projectId !== projectId) {
      throw new WorkspaceProjectServiceError(
        "session_not_found",
        `Session does not belong to project: ${sessionId}`,
      );
    }
  }
}

export function buildProjectCatalogRoot(
  projectId: string,
  files: readonly WorkspaceProjectFile[],
  sessions: readonly SessionSummary[],
): WorkspaceProjectCatalogRoot {
  return {
    version: 1,
    projectId,
    sharedInputs: files
      .map((file) =>
        catalogFile({
          category: "shared_input",
          name: file.name,
          size: file.size,
          resource: {
            kind: "project_file",
            projectId,
            filename: file.name,
            resourcePath: projectFileResourcePath(projectId, file.name),
          },
        }),
      )
      .sort(compareCatalogFiles),
    sessions: sessions
      .map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
      }))
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.title.localeCompare(right.title),
      ),
  };
}

function catalogFile(params: {
  category: WorkspaceProjectCatalogCategory;
  name: string;
  size?: number;
  resource: WorkspaceProjectCatalogFile["resource"];
}): WorkspaceProjectCatalogFile {
  const contentType = contentTypeForFilename(params.name);
  return {
    id: `${params.resource.kind}:${params.resource.resourcePath}`,
    name: params.name,
    category: params.category,
    contentType,
    ...(params.size === undefined ? {} : { size: params.size }),
    capabilities: {
      preview: previewCapability(params.resource.kind, contentType),
      download: true,
      delete:
        params.resource.kind === "project_file" ||
        params.resource.kind === "session_file",
    },
    resource: params.resource,
  };
}

function categorizeArtifact(
  run: RunSummary,
  artifactPath: string,
  deliveryKeys: ReadonlySet<string>,
): "delivery" | "artifact" | "evidence" {
  if (deliveryKeys.has(artifactKey(run.id, artifactPath))) return "delivery";
  return hasEvidenceSegment(artifactPath) ? "evidence" : "artifact";
}

function hasEvidenceSegment(artifactPath: string): boolean {
  return normalizeArtifactPath(artifactPath)
    .split("/")
    .some((segment) =>
      ["browser", "evidence", "source", "sources"].includes(segment.toLowerCase()),
    );
}

function isPrivateArtifactPath(artifactPath: string): boolean {
  const normalized = normalizeArtifactPath(artifactPath);
  const segments = normalized.split("/").filter(Boolean);
  const firstSegment = segments[0];
  if (firstSegment === undefined) return true;
  if (PRIVATE_ROOT_FILES.has(firstSegment.toLowerCase())) return true;
  return segments.some(
    (segment) =>
      PRIVATE_PATH_SEGMENTS.has(segment.toLowerCase()) ||
      segment.toLowerCase().endsWith(".lock"),
  );
}

function normalizeArtifactPath(artifactPath: string): string {
  return artifactPath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function artifactKey(runId: string, artifactPath: string): string {
  return `${runId}\0${normalizeArtifactPath(artifactPath)}`;
}

function projectFileResourcePath(projectId: string, filename: string): string {
  return `/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(filename)}`;
}

function sessionFileResourcePath(sessionId: string, filename: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(filename)}`;
}

function runArtifactResourcePath(runId: string, artifactPath: string): string {
  const encodedPath = normalizeArtifactPath(artifactPath)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `/runs/${encodeURIComponent(runId)}/assignments/${encodedPath}`;
}

function previewCapability(
  kind: WorkspaceProjectCatalogFile["resource"]["kind"],
  contentType: string,
): "artifact" | "browser" | "none" {
  if (
    contentType === "application/pdf" ||
    contentType.startsWith("image/")
  ) {
    return "browser";
  }
  if (kind !== "run_artifact") {
    return contentType.startsWith("text/") || contentType === "application/json"
      ? "browser"
      : "none";
  }
  if (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "artifact";
  }
  return "none";
}

function contentTypeForFilename(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case ".md": return "text/markdown";
    case ".txt": return "text/plain";
    case ".csv": return "text/csv";
    case ".json": return "application/json";
    case ".pdf": return "application/pdf";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default: return "application/octet-stream";
  }
}

function deduplicateAndSort(
  entries: WorkspaceProjectCatalogFile[],
): WorkspaceProjectCatalogFile[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()]
    .sort(compareCatalogFiles);
}

function compareCatalogFiles(
  left: WorkspaceProjectCatalogFile,
  right: WorkspaceProjectCatalogFile,
): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}
