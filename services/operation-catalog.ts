export type OperationGroup =
  | "runs"
  | "runOrchestrator"
  | "workflows"
  | "workflowGenerator"
  | "teamBuilder"
  | "agents"
  | "projects"
  | "sessions"
  | "tasks";

export type OperationKind = "query" | "command" | "stream";

export interface OperationHttpBinding {
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  path: string;
}

export interface ApplicationOperation {
  id: string;
  group: OperationGroup;
  kind: OperationKind;
  summary: string;
  http?: OperationHttpBinding;
  runtimeScope?: "all" | "lightweight-only";
}

export interface OperationSurfaceOptions {
  /** Full session runtimes require durable task admission for every launch. */
  fullSessionRuntime?: boolean;
}

export const operationCatalog = [
  {
    id: "runs.list",
    group: "runs",
    kind: "query",
    summary: "List runs",
    http: { method: "GET", path: "/runs" },
  },
  {
    id: "runs.start",
    group: "runs",
    kind: "command",
    summary: "Start a run",
    http: { method: "POST", path: "/runs" },
    runtimeScope: "lightweight-only",
  },
  {
    id: "runs.read",
    group: "runs",
    kind: "query",
    summary: "Read a run",
    http: { method: "GET", path: "/runs/{runId}" },
  },
  {
    id: "runs.diagnostics.read",
    group: "runs",
    kind: "query",
    summary: "Read run diagnostics",
    http: { method: "GET", path: "/runs/{runId}/diagnostics" },
  },
  {
    id: "runs.flow.read",
    group: "runs",
    kind: "query",
    summary: "Read run flow",
    http: { method: "GET", path: "/runs/{runId}/flow" },
  },
  {
    id: "runs.events.list",
    group: "runs",
    kind: "query",
    summary: "List run events",
    http: { method: "GET", path: "/runs/{runId}/events" },
  },
  {
    id: "runs.events.stream",
    group: "runs",
    kind: "stream",
    summary: "Stream run events",
    http: { method: "GET", path: "/runs/{runId}/events?stream=1" },
  },
  {
    id: "runs.artifacts.read",
    group: "runs",
    kind: "query",
    summary: "Read a run assignment artifact",
    http: { method: "GET", path: "/runs/{runId}/assignments/{artifactPath}" },
  },
  {
    id: "runOrchestrator.plan",
    group: "runOrchestrator",
    kind: "command",
    summary: "Plan a workflow run from a user goal",
  },
  {
    id: "runOrchestrator.apply",
    group: "runOrchestrator",
    kind: "command",
    summary: "Apply an approved workflow run plan",
  },
  {
    id: "runOrchestrator.message",
    group: "runOrchestrator",
    kind: "command",
    summary: "Send a receptionist message in a run session",
    http: { method: "POST", path: "/sessions/{sessionId}/messages" },
  },
  {
    id: "runOrchestrator.status",
    group: "runOrchestrator",
    kind: "query",
    summary: "Read orchestrated run task status",
    http: { method: "GET", path: "/sessions/{sessionId}/tasks/{taskId}" },
  },
  {
    id: "runOrchestrator.cancel",
    group: "runOrchestrator",
    kind: "command",
    summary: "Cancel an orchestrated run task",
    http: { method: "DELETE", path: "/sessions/{sessionId}/tasks/{taskId}" },
  },
  {
    id: "workflows.list",
    group: "workflows",
    kind: "query",
    summary: "List workflows",
    http: { method: "GET", path: "/workflows" },
  },
  {
    id: "workflows.read",
    group: "workflows",
    kind: "query",
    summary: "Read workflow YAML and declared stages",
    http: { method: "GET", path: "/workflows/{workflowId}" },
  },
  {
    id: "workflows.update",
    group: "workflows",
    kind: "command",
    summary: "Update workflow YAML",
    http: { method: "PATCH", path: "/workflows/{workflowId}" },
  },
  {
    id: "workflows.delete",
    group: "workflows",
    kind: "command",
    summary: "Delete a workflow",
    http: { method: "DELETE", path: "/workflows/{workflowId}" },
  },
  {
    id: "workflowGenerator.teams.list",
    group: "workflowGenerator",
    kind: "query",
    summary: "List teams available to workflow generation",
    http: { method: "GET", path: "/create/teams" },
  },
  {
    id: "workflowGenerator.turn",
    group: "workflowGenerator",
    kind: "command",
    summary: "Run a workflow generator turn",
    http: { method: "POST", path: "/create/turn" },
  },
  {
    id: "workflowGenerator.validateYaml",
    group: "workflowGenerator",
    kind: "command",
    summary: "Validate generated workflow YAML",
    http: { method: "POST", path: "/create/validate-yaml" },
  },
  {
    id: "workflowGenerator.save",
    group: "workflowGenerator",
    kind: "command",
    summary: "Save a generated workflow",
    http: { method: "POST", path: "/create/save" },
  },
  {
    id: "workflowGenerator.jobs.cancel",
    group: "workflowGenerator",
    kind: "command",
    summary: "Cancel an active or pending create job",
    http: { method: "POST", path: "/create/jobs/{jobId}/cancel" },
  },
  {
    id: "workflowGenerator.artifacts.reveal",
    group: "workflowGenerator",
    kind: "command",
    summary: "Reveal an assignment artifact on disk",
    http: { method: "POST", path: "/create/reveal-artifact" },
  },
  {
    id: "teamBuilder.teams.list",
    group: "teamBuilder",
    kind: "query",
    summary: "List team builder teams",
    http: { method: "GET", path: "/create/team-builder/teams" },
  },
  {
    id: "teamBuilder.teams.create",
    group: "teamBuilder",
    kind: "command",
    summary: "Create a team builder team",
    http: { method: "POST", path: "/create/team-builder/teams" },
  },
  {
    id: "teamBuilder.teams.read",
    group: "teamBuilder",
    kind: "query",
    summary: "Read a team builder team",
    http: { method: "GET", path: "/create/team-builder/teams/{teamId}" },
  },
  {
    id: "teamBuilder.teams.update",
    group: "teamBuilder",
    kind: "command",
    summary: "Update a team builder team",
    http: { method: "PUT", path: "/create/team-builder/teams/{teamId}" },
  },
  {
    id: "teamBuilder.teams.delete",
    group: "teamBuilder",
    kind: "command",
    summary: "Delete a team builder team",
    http: { method: "DELETE", path: "/create/team-builder/teams/{teamId}" },
  },
  {
    id: "teamBuilder.agents.add",
    group: "teamBuilder",
    kind: "command",
    summary: "Add an agent to a team builder team",
    http: { method: "POST", path: "/create/team-builder/teams/{teamId}/agents" },
  },
  {
    id: "teamBuilder.agents.remove",
    group: "teamBuilder",
    kind: "command",
    summary: "Remove an agent from a team builder team",
    http: {
      method: "DELETE",
      path: "/create/team-builder/teams/{teamId}/agents/{agentName}",
    },
  },
  {
    id: "agents.list",
    group: "agents",
    kind: "query",
    summary: "List agents",
    http: { method: "GET", path: "/create/agents" },
  },
  {
    id: "agents.read",
    group: "agents",
    kind: "query",
    summary: "Read agent detail",
    http: { method: "GET", path: "/create/agents/{agentName}" },
  },
  {
    id: "agents.draft",
    group: "agents",
    kind: "command",
    summary: "Draft an agent",
    http: { method: "POST", path: "/create/agents/draft" },
  },
  {
    id: "agents.commit",
    group: "agents",
    kind: "command",
    summary: "Commit a drafted agent",
    http: { method: "POST", path: "/create/agents/commit" },
  },
  {
    id: "agents.refine",
    group: "agents",
    kind: "command",
    summary: "Refine an agent persona",
    http: { method: "POST", path: "/create/agents/refine" },
  },
  {
    id: "agents.persona.save",
    group: "agents",
    kind: "command",
    summary: "Save an agent persona",
    http: { method: "POST", path: "/create/agents/save" },
  },
  {
    id: "agents.delete",
    group: "agents",
    kind: "command",
    summary: "Delete an agent",
    http: { method: "DELETE", path: "/create/agents/{agentName}" },
  },
  {
    id: "agents.deleteByBody",
    group: "agents",
    kind: "command",
    summary: "Delete an agent from a request body",
    http: { method: "POST", path: "/create/agents/delete" },
  },
  {
    id: "agents.deletePreview",
    group: "agents",
    kind: "query",
    summary: "Preview agent deletion",
    http: { method: "GET", path: "/create/agents/{agentName}/delete-preview" },
  },
  {
    id: "agents.teamOptions.list",
    group: "agents",
    kind: "query",
    summary: "List agent team options",
    http: { method: "GET", path: "/create/agents/teams" },
  },
  {
    id: "agents.skills.list",
    group: "agents",
    kind: "query",
    summary: "List skills under a path",
    http: { method: "POST", path: "/create/agents/list-skills" },
  },
  {
    id: "agents.teams.add",
    group: "agents",
    kind: "command",
    summary: "Add an agent to a runtime team",
    http: { method: "POST", path: "/create/agents/add-to-team" },
  },
  {
    id: "agents.package.add",
    group: "agents",
    kind: "command",
    summary: "Add files to an agent package",
    http: { method: "POST", path: "/create/agents/package/add" },
  },
  {
    id: "agents.package.importPreview",
    group: "agents",
    kind: "command",
    summary: "Preview agent package import",
    http: { method: "POST", path: "/create/agents/package/import-preview" },
  },
  {
    id: "agents.package.import",
    group: "agents",
    kind: "command",
    summary: "Import an agent package",
    http: { method: "POST", path: "/create/agents/package/import" },
  },
  {
    id: "agents.package.remove",
    group: "agents",
    kind: "command",
    summary: "Remove an agent package item",
    http: { method: "POST", path: "/create/agents/package/remove" },
  },
  {
    id: "projects.list",
    group: "projects",
    kind: "query",
    summary: "List workspace projects",
    http: { method: "GET", path: "/projects" },
  },
  {
    id: "projects.create",
    group: "projects",
    kind: "command",
    summary: "Create a workspace project",
    http: { method: "POST", path: "/projects" },
  },
  {
    id: "projects.read",
    group: "projects",
    kind: "query",
    summary: "Read a workspace project",
    http: { method: "GET", path: "/projects/{projectId}" },
  },
  {
    id: "projects.details.read",
    group: "projects",
    kind: "query",
    summary: "Read the initial workspace project Library payload",
    http: { method: "GET", path: "/projects/{projectId}/details" },
  },
  {
    id: "projects.update",
    group: "projects",
    kind: "command",
    summary: "Update or archive a workspace project",
    http: { method: "PATCH", path: "/projects/{projectId}" },
  },
  {
    id: "projects.delete",
    group: "projects",
    kind: "command",
    summary: "Delete an empty workspace project",
    http: { method: "DELETE", path: "/projects/{projectId}" },
  },
  {
    id: "projects.sessions.list",
    group: "projects",
    kind: "query",
    summary: "List sessions assigned to a workspace project",
    http: { method: "GET", path: "/projects/{projectId}/sessions" },
  },
  {
    id: "projects.sessions.assign",
    group: "projects",
    kind: "command",
    summary: "Assign or move a session into a workspace project",
    http: {
      method: "PUT",
      path: "/projects/{projectId}/sessions/{sessionId}",
    },
  },
  {
    id: "projects.sessions.remove",
    group: "projects",
    kind: "command",
    summary: "Remove a session from a workspace project",
    http: {
      method: "DELETE",
      path: "/projects/{projectId}/sessions/{sessionId}",
    },
  },
  {
    id: "projects.brief.read",
    group: "projects",
    kind: "query",
    summary: "Read a workspace project brief",
    http: { method: "GET", path: "/projects/{projectId}/brief" },
  },
  {
    id: "projects.brief.update",
    group: "projects",
    kind: "command",
    summary: "Update a workspace project brief",
    http: { method: "PUT", path: "/projects/{projectId}/brief" },
  },
  {
    id: "projects.files.list",
    group: "projects",
    kind: "query",
    summary: "List shared workspace project files",
    http: { method: "GET", path: "/projects/{projectId}/files" },
  },
  {
    id: "projects.files.upload",
    group: "projects",
    kind: "command",
    summary: "Upload a shared workspace project file",
    http: { method: "POST", path: "/projects/{projectId}/files" },
  },
  {
    id: "projects.files.read",
    group: "projects",
    kind: "query",
    summary: "Read a shared workspace project file",
    http: { method: "GET", path: "/projects/{projectId}/files/{filename}" },
  },
  {
    id: "projects.files.delete",
    group: "projects",
    kind: "command",
    summary: "Delete a shared workspace project file",
    http: { method: "DELETE", path: "/projects/{projectId}/files/{filename}" },
  },
  {
    id: "projects.catalog.read",
    group: "projects",
    kind: "query",
    summary: "Read the lazy workspace project file catalog root",
    http: { method: "GET", path: "/projects/{projectId}/catalog" },
  },
  {
    id: "projects.catalog.session.read",
    group: "projects",
    kind: "query",
    summary: "Read one session branch of a workspace project file catalog",
    http: {
      method: "GET",
      path: "/projects/{projectId}/catalog/sessions/{sessionId}",
    },
  },
  {
    id: "projects.memory.list",
    group: "projects",
    kind: "query",
    summary: "List workspace project memory proposals",
    http: { method: "GET", path: "/projects/{projectId}/memory-proposals" },
  },
  {
    id: "projects.memory.propose",
    group: "projects",
    kind: "command",
    summary: "Propose durable workspace project memory",
    http: { method: "POST", path: "/projects/{projectId}/memory-proposals" },
  },
  {
    id: "projects.memory.approve",
    group: "projects",
    kind: "command",
    summary: "Approve a workspace project memory proposal",
    http: {
      method: "POST",
      path: "/projects/{projectId}/memory-proposals/{proposalId}/approve",
    },
  },
  {
    id: "projects.memory.reject",
    group: "projects",
    kind: "command",
    summary: "Reject a workspace project memory proposal",
    http: {
      method: "POST",
      path: "/projects/{projectId}/memory-proposals/{proposalId}/reject",
    },
  },
  {
    id: "projects.export",
    group: "projects",
    kind: "query",
    summary: "Export a portable workspace project bundle",
    http: { method: "GET", path: "/projects/{projectId}/export" },
  },
  {
    id: "sessions.list",
    group: "sessions",
    kind: "query",
    summary: "List sessions",
    http: { method: "GET", path: "/sessions" },
  },
  {
    id: "sessions.create",
    group: "sessions",
    kind: "command",
    summary: "Create a session",
    http: { method: "POST", path: "/sessions" },
  },
  {
    id: "sessions.read",
    group: "sessions",
    kind: "query",
    summary: "Read a session",
    http: { method: "GET", path: "/sessions/{sessionId}" },
  },
  {
    id: "sessions.rename",
    group: "sessions",
    kind: "command",
    summary: "Rename a session",
    http: { method: "PATCH", path: "/sessions/{sessionId}" },
  },
  {
    id: "sessions.delete",
    group: "sessions",
    kind: "command",
    summary: "Delete a session",
    http: { method: "DELETE", path: "/sessions/{sessionId}" },
  },
  {
    id: "sessions.messages.list",
    group: "sessions",
    kind: "query",
    summary: "List session messages",
    http: { method: "GET", path: "/sessions/{sessionId}/messages" },
  },
  {
    id: "sessions.messages.send",
    group: "sessions",
    kind: "command",
    summary: "Send a session message",
    http: { method: "POST", path: "/sessions/{sessionId}/messages" },
  },
  {
    id: "sessions.files.list",
    group: "sessions",
    kind: "query",
    summary: "List session files",
    http: { method: "GET", path: "/sessions/{sessionId}/files" },
  },
  {
    id: "sessions.files.upload",
    group: "sessions",
    kind: "command",
    summary: "Upload a session file",
    http: { method: "POST", path: "/sessions/{sessionId}/files" },
  },
  {
    id: "sessions.files.delete",
    group: "sessions",
    kind: "command",
    summary: "Delete a session file",
    http: { method: "DELETE", path: "/sessions/{sessionId}/files/{filename}" },
  },
  {
    id: "tasks.list",
    group: "tasks",
    kind: "query",
    summary: "List session tasks",
    http: { method: "GET", path: "/sessions/{sessionId}/tasks" },
  },
  {
    id: "tasks.create",
    group: "tasks",
    kind: "command",
    summary: "Create a session task",
    http: { method: "POST", path: "/sessions/{sessionId}/tasks" },
  },
  {
    id: "tasks.read",
    group: "tasks",
    kind: "query",
    summary: "Read a session task",
    http: { method: "GET", path: "/sessions/{sessionId}/tasks/{taskId}" },
  },
  {
    id: "tasks.delete",
    group: "tasks",
    kind: "command",
    summary: "Delete a session task",
    http: { method: "DELETE", path: "/sessions/{sessionId}/tasks/{taskId}" },
  },
] as const satisfies readonly ApplicationOperation[];

export type OperationId = (typeof operationCatalog)[number]["id"];

export function listOperations(
  group?: OperationGroup,
  options: OperationSurfaceOptions = {},
): ApplicationOperation[] {
  return operationCatalog.filter(
    (operation) =>
      (group === undefined || operation.group === group) &&
      !(
        options.fullSessionRuntime &&
        "runtimeScope" in operation &&
        operation.runtimeScope === "lightweight-only"
      ),
  );
}

export function getOperation(
  id: OperationId,
  options: OperationSurfaceOptions = {},
): ApplicationOperation {
  const operation = operationCatalog.find((entry) => entry.id === id);
  if (!operation) {
    throw new Error(`Unknown operation: ${id}`);
  }
  if (
    options.fullSessionRuntime &&
    "runtimeScope" in operation &&
    operation.runtimeScope === "lightweight-only"
  ) {
    throw new Error(`Operation is unavailable in the full session runtime: ${id}`);
  }
  return operation;
}
