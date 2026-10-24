/**
 * Client for the Agent Architect routes on api-server.ts.
 *
 * Mirrors workflow-generator-client.ts in shape. All endpoints live under
 * /api/create/agents/* (the Vite dev proxy strips /api before forwarding to
 * the backend's /create/agents/* routes).
 */

import type {
  AgentSummary,
  AgentProviderHealth,
  AgentProviderHealthTarget,
  AgentDeleteResult,
  AgentDetail,
  AgentPackageAddKind,
  AgentPackageFileInput,
  AgentPackageImportChoice,
  AgentPackageImportItem,
  AgentPackageRemoveMode,
  AgentTeamOption,
  ChatTurn,
  CommitAgentResult,
  DraftAgentResponse,
  RefineAgentResponse,
  SkillTreeNode,
} from "@/lib/models/agent-generator-model";
import { invalidateAgentProviderHealth } from "@/lib/clients/agent-provider-health-signal";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

const CHAT_GENERATED_SKILL_SENTINEL = "__agent_architect_chat_generated_skill__";

function toUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function toWireSkillPaths(skillPaths: string[]): string[] {
  return skillPaths.length > 0 ? skillPaths : [CHAT_GENERATED_SKILL_SENTINEL];
}

async function expectOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const fallback = `${response.status} ${response.statusText}`;
  try {
    const payload = (await response.json()) as {
      error?: string;
      details?: string[];
    };
    const detailSuffix =
      Array.isArray(payload.details) && payload.details.length > 0
        ? `: ${payload.details.join("; ")}`
        : "";
    throw new Error(`${payload.error || fallback}${detailSuffix}`);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(fallback, { cause: error });
  }
}

export async function listAgents(options?: {
  includeHidden?: boolean;
  /** Include agents the runtime owns but the user edits, such as the front door. */
  includeSystem?: boolean;
}): Promise<AgentSummary[]> {
  const path = options?.includeHidden
    ? "/create/agents?include_hidden=1"
    : options?.includeSystem
      ? "/create/agents?include_system=1"
      : "/create/agents";
  const response = await expectOk(await fetch(toUrl(path)));
  const payload = (await response.json()) as { agents: AgentSummary[] };
  return payload.agents;
}

export async function checkAgentProviderHealth(input: {
  agentNames?: string[];
  targets?: AgentProviderHealthTarget[];
}): Promise<AgentProviderHealth[]> {
  const response = await expectOk(
    await fetch(toUrl("/create/agents/health"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  const payload = (await response.json()) as { health: AgentProviderHealth[] };
  return payload.health;
}

export async function listAgentTeams(): Promise<AgentTeamOption[]> {
  const response = await expectOk(await fetch(toUrl("/create/agents/teams")));
  const payload = (await response.json()) as { teams: AgentTeamOption[] };
  return payload.teams;
}

export async function addAgentToTeam(input: {
  agentName: string;
  teamId: string;
}): Promise<{ agentName: string; teamId: string; added: boolean }> {
  const response = await expectOk(
    await fetch(toUrl("/create/agents/add-to-team"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return (await response.json()) as {
    agentName: string;
    teamId: string;
    added: boolean;
  };
}

export async function deleteAgent(input: {
  agentName: string;
  deleteSkills: boolean;
}): Promise<AgentDeleteResult> {
  const response = await fetch(toUrl("/create/agents/delete"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 404) {
    const fallback = await fetch(
      toUrl(`/create/agents/${encodeURIComponent(input.agentName)}`),
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteSkills: input.deleteSkills }),
      },
    );
    if (fallback.status === 404) {
      throw new Error("Agent delete endpoint not found. Restart the API server.");
    }
    return (await expectOk(fallback).then((res) => res.json())) as AgentDeleteResult;
  }
  await expectOk(response);
  return (await response.json()) as AgentDeleteResult;
}

export async function listSkillsTree(input: {
  path: string;
}): Promise<{ tree: SkillTreeNode }> {
  const response = await expectOk(
    await fetch(toUrl("/create/agents/list-skills"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return (await response.json()) as { tree: SkillTreeNode };
}

export async function draftAgent(input: {
  jobId: string;
  skillPaths: string[];
  chatHistory: ChatTurn[];
  duplicatePolicy?: "overwrite" | "duplicate" | undefined;
  provider?: string;
  model?: string;
}): Promise<DraftAgentResponse> {
  const response = await expectOk(
    await fetch(toUrl("/create/agents/draft"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        skillPaths: toWireSkillPaths(input.skillPaths),
      }),
    }),
  );
  return (await response.json()) as DraftAgentResponse;
}

export async function commitAgent(input: {
  approvedName: string;
  personaMarkdown: string;
  skillPaths: string[];
  generatedSkills?: Array<{ name: string; body: string }> | undefined;
  overwrite?: boolean;
}): Promise<CommitAgentResult> {
  const response = await expectOk(
    await fetch(toUrl("/create/agents/commit"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        skillPaths: toWireSkillPaths(input.skillPaths),
      }),
    }),
  );
  return (await response.json()) as CommitAgentResult;
}

export async function refineAgent(input: {
  jobId: string;
  agentName: string;
  currentPersona: string;
  chatHistory: ChatTurn[];
  provider?: string;
  model?: string;
}): Promise<RefineAgentResponse> {
  const response = await expectOk(
    await fetch(toUrl("/create/agents/refine"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return (await response.json()) as RefineAgentResponse;
}

export async function saveAgentPersona(input: {
  agentName: string;
  personaMarkdown: string;
}): Promise<{ personaPath: string }> {
  const response = await expectOk(
    await fetch(toUrl("/create/agents/save"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  const saved = (await response.json()) as { personaPath: string };
  // The persona is where an agent's provider and model are written, so a save
  // can have just pointed it at a different account. Published after the write
  // lands, so whoever re-asks reads the new frontmatter and not the old.
  invalidateAgentProviderHealth();
  return saved;
}

export async function addAgentPackageFiles(input: {
  agentName: string;
  kind: AgentPackageAddKind;
  files: AgentPackageFileInput[];
}): Promise<AgentDetail> {
  const response = await expectOk(
    await fetch(toUrl("/create/agents/package/add"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return (await response.json()) as AgentDetail;
}

export async function previewAgentPackageImport(input: {
  agentName: string;
  kind: AgentPackageAddKind;
  files: AgentPackageFileInput[];
}): Promise<{ items: AgentPackageImportItem[] }> {
  const response = await fetch(toUrl("/create/agents/package/import-preview"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 404) throw stalePackageEndpointError();
  await expectOk(response);
  return (await response.json()) as { items: AgentPackageImportItem[] };
}

export async function commitAgentPackageImport(input: {
  agentName: string;
  kind: AgentPackageAddKind;
  files: AgentPackageFileInput[];
  choices: AgentPackageImportChoice[];
}): Promise<AgentDetail> {
  const response = await fetch(toUrl("/create/agents/package/import"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 404) throw stalePackageEndpointError();
  await expectOk(response);
  return (await response.json()) as AgentDetail;
}

export async function removeAgentPackageItem(input: {
  agentName: string;
  kind: AgentPackageAddKind;
  agentPath: string;
  mode: AgentPackageRemoveMode;
}): Promise<AgentDetail> {
  const response = await fetch(toUrl("/create/agents/package/remove"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 404) throw stalePackageEndpointError();
  await expectOk(response);
  return (await response.json()) as AgentDetail;
}

function stalePackageEndpointError(): Error {
  return new Error(
    "Agent package endpoint not found. Restart the API server to load the package editing routes.",
  );
}

export async function readAgentPersona(input: {
  agentName: string;
}): Promise<AgentDetail> {
  const response = await expectOk(
    await fetch(toUrl(`/create/agents/${encodeURIComponent(input.agentName)}`)),
  );
  return (await response.json()) as AgentDetail;
}

export async function revealAgentAsset(input: {
  path: string;
}): Promise<{ path: string }> {
  const response = await expectOk(
    await fetch(toUrl("/create/reveal-artifact"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifactPath: input.path }),
    }),
  );
  return (await response.json()) as { path: string };
}

export async function cancelAgentJob(jobId: string): Promise<void> {
  await expectOk(
    await fetch(toUrl(`/create/jobs/${encodeURIComponent(jobId)}/cancel`), {
      method: "POST",
    }),
  );
}
