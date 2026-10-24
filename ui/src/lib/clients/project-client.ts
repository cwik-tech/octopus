import type {
  WorkspaceProject,
  WorkspaceProjectBrief,
  WorkspaceProjectCatalogRoot,
  WorkspaceProjectCatalogSessionBranch,
  WorkspaceProjectFile,
  WorkspaceProjectMembership,
  WorkspaceProjectMemoryProposal,
  WorkspaceProjectMemoryProposalStatus,
  WorkspaceProjectDeleteMode,
  WorkspaceProjectStatus,
  WorkspaceProjectSummary,
} from "@contracts/projects";
import type { WorkspaceProjectDetails } from "@contracts/project-details";
import type { SessionSummary } from "@contracts/sessions";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export async function listProjects(options: {
  includeArchived?: boolean;
} = {}): Promise<WorkspaceProjectSummary[]> {
  const suffix = options.includeArchived ? "?includeArchived=true" : "";
  const payload = await request<{ projects: WorkspaceProjectSummary[] }>(
    `/projects${suffix}`,
  );
  return payload.projects;
}

export async function createProject(input: {
  name: string;
  description?: string;
}): Promise<WorkspaceProject> {
  return request("/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name.trim(),
      ...(input.description !== undefined
        ? { description: input.description.trim() }
        : {}),
    }),
  });
}

export async function updateProject(
  projectId: string,
  patch: {
    name?: string;
    description?: string;
    status?: WorkspaceProjectStatus;
  },
): Promise<WorkspaceProject> {
  return request(`/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description.trim() }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    }),
  });
}

export async function deleteProject(
  projectId: string,
  mode: WorkspaceProjectDeleteMode,
): Promise<void> {
  await request(`/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export async function listProjectSessions(
  projectId: string,
): Promise<SessionSummary[]> {
  const payload = await request<{ sessions: SessionSummary[] }>(
    `/projects/${encodeURIComponent(projectId)}/sessions`,
  );
  return payload.sessions;
}

export async function getProjectDetails(
  projectId: string,
  signal?: AbortSignal,
): Promise<WorkspaceProjectDetails> {
  const payload = await request<unknown>(
    projectResourcePath(projectId, "details"),
    signal ? { signal } : undefined,
  );
  return parseWorkspaceProjectDetails(payload);
}

export async function getProjectCatalogRoot(
  projectId: string,
): Promise<WorkspaceProjectCatalogRoot> {
  return request(projectResourcePath(projectId, "catalog"));
}

export async function getProjectCatalogSession(
  projectId: string,
  sessionId: string,
): Promise<WorkspaceProjectCatalogSessionBranch> {
  return request(
    `${projectResourcePath(projectId, "catalog")}/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export function projectCatalogResourceUrl(resourcePath: string): string {
  return `${API_BASE}${resourcePath}`;
}

export async function assignSessionToProject(
  projectId: string,
  sessionId: string,
): Promise<WorkspaceProjectMembership> {
  return request(projectSessionPath(projectId, sessionId), {
    method: "PUT",
  });
}

export async function removeSessionFromProject(
  projectId: string,
  sessionId: string,
): Promise<void> {
  await request(projectSessionPath(projectId, sessionId), {
    method: "DELETE",
  });
}

export async function getProjectBrief(
  projectId: string,
): Promise<WorkspaceProjectBrief> {
  return request(projectResourcePath(projectId, "brief"));
}

export async function updateProjectBrief(
  projectId: string,
  content: string,
): Promise<WorkspaceProjectBrief> {
  return request(projectResourcePath(projectId, "brief"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export async function listProjectFiles(
  projectId: string,
): Promise<WorkspaceProjectFile[]> {
  const payload = await request<{ files: WorkspaceProjectFile[] }>(
    projectResourcePath(projectId, "files"),
  );
  return payload.files;
}

export async function uploadProjectFile(
  projectId: string,
  file: File,
): Promise<WorkspaceProjectFile> {
  return request(projectResourcePath(projectId, "files"), {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-filename": encodeURIComponent(file.name),
    },
    body: await file.arrayBuffer(),
  });
}

export async function deleteProjectFile(
  projectId: string,
  filename: string,
): Promise<void> {
  await request(
    `${projectResourcePath(projectId, "files")}/${encodeURIComponent(filename)}`,
    { method: "DELETE" },
  );
}

export function projectFileUrl(projectId: string, filename: string): string {
  return `${API_BASE}${projectResourcePath(projectId, "files")}/${encodeURIComponent(filename)}`;
}

export function projectExportUrl(projectId: string): string {
  return `${API_BASE}${projectResourcePath(projectId, "export")}`;
}

export async function listProjectMemoryProposals(
  projectId: string,
  status?: WorkspaceProjectMemoryProposalStatus,
): Promise<WorkspaceProjectMemoryProposal[]> {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  const payload = await request<{ proposals: WorkspaceProjectMemoryProposal[] }>(
    `${projectResourcePath(projectId, "memory-proposals")}${suffix}`,
  );
  return payload.proposals;
}

export async function decideProjectMemoryProposal(
  projectId: string,
  proposalId: string,
  decision: "approve" | "reject",
): Promise<WorkspaceProjectMemoryProposal> {
  return request(
    `${projectResourcePath(projectId, "memory-proposals")}/${encodeURIComponent(proposalId)}/${decision}`,
    { method: "POST" },
  );
}

function projectResourcePath(projectId: string, resource: string): string {
  return `/projects/${encodeURIComponent(projectId)}/${resource}`;
}

function projectSessionPath(projectId: string, sessionId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

async function request<T = void>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const response = init ? await fetch(url, init) : await fetch(url);
  if (!response.ok) throw await projectClientError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function projectClientError(response: Response): Promise<Error> {
  const fallback = `${response.status} ${response.statusText || "Request failed"}`;
  try {
    const payload = (await response.json()) as { error?: unknown };
    return new Error(
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error
        : fallback,
    );
  } catch (error) {
    return new Error(fallback, { cause: error });
  }
}

function parseWorkspaceProjectDetails(value: unknown): WorkspaceProjectDetails {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1
  ) {
    throw new Error("Unsupported project details version");
  }
  return value as WorkspaceProjectDetails;
}
