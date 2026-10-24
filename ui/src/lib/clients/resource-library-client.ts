import * as z from "zod/v4";
import {
  resourceLibraryArchiveResultSchema,
  resourceLibraryBrowserSnapshotSchema,
  resourceLibraryRevisionFilesSchema,
  resourceLibrarySkillMutationSchema,
  type ResourceLibraryBrowserSnapshot,
  type ResourceLibraryRevisionFiles,
  type ResourceLibrarySkillMutation,
  type ResourceLibraryArchiveResult,
} from "@contracts/resource-library";
import type { ResourceLibraryFileInput } from "@contracts/schemas/resource-library-requests";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export type ResourceSkillMutation = ResourceLibrarySkillMutation;
interface RequestOptions { signal?: AbortSignal }
const errorResponseSchema = z.object({ error: z.string() });
const requestTimeoutMs = 15_000;

async function expectOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const payload: unknown = await response.json().catch(() => null);
  const parsed = errorResponseSchema.safeParse(payload);
  throw new Error(parsed.success ? parsed.data.error : `${response.status} ${response.statusText}`);
}

async function requestJson<T>(input: {
  path: string;
  parse: (payload: unknown) => T;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}): Promise<T> {
  const deadline = AbortSignal.timeout(requestTimeoutMs);
  const response = await expectOk(await fetch(`${API_BASE}${input.path}`, {
    method: input.method ?? "POST",
    ...(input.method === "GET" ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(input.body ?? {}),
    }),
    signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline,
  }));
  const payload: unknown = await response.json();
  return input.parse(payload);
}

export function getResourceLibrarySnapshot(options: RequestOptions = {}): Promise<ResourceLibraryBrowserSnapshot> {
  return requestJson({ path: "/resource-library", method: "GET", parse: resourceLibraryBrowserSnapshotSchema.parse, ...options });
}

export function readResourceLibraryRevisionFiles(input: {
  skillId: string; revisionId: string;
}, options: RequestOptions = {}): Promise<ResourceLibraryRevisionFiles> {
  return requestJson({
    path: `/resource-library/skills/${encodeURIComponent(input.skillId)}/revisions/${encodeURIComponent(input.revisionId)}/files`,
    method: "GET", parse: resourceLibraryRevisionFilesSchema.parse, ...options,
  });
}

export function createResourceSkill(input: {
  slug: string;
  changeNote: string;
  expectedGeneration: number;
  files: ResourceLibraryFileInput[];
}, options: RequestOptions = {}): Promise<ResourceSkillMutation> {
  return requestJson({ path: "/resource-library/skills", body: input, parse: resourceLibrarySkillMutationSchema.parse, ...options });
}

export function saveResourceSkillRevision(input: {
  skillId: string;
  baseRevisionId: string;
  changeNote: string;
  expectedGeneration: number;
  files: ResourceLibraryFileInput[];
}, options: RequestOptions = {}): Promise<ResourceSkillMutation> {
  const { skillId, ...body } = input;
  return requestJson({
    parse: resourceLibrarySkillMutationSchema.parse, ...options,
    path: `/resource-library/skills/${encodeURIComponent(skillId)}/revisions`,
    body,
  });
}

export function restoreResourceSkillRevision(input: {
  skillId: string;
  sourceRevisionId: string;
  baseRevisionId: string;
  changeNote: string;
  expectedGeneration: number;
}, options: RequestOptions = {}): Promise<ResourceSkillMutation> {
  const { skillId, ...body } = input;
  return requestJson({
    parse: resourceLibrarySkillMutationSchema.parse, ...options,
    path: `/resource-library/skills/${encodeURIComponent(skillId)}/restore`,
    body,
  });
}

export function setResourceSkillArchived(input: {
  skillId: string;
  archived: boolean;
  expectedGeneration: number;
}, options: RequestOptions = {}): Promise<ResourceLibraryArchiveResult> {
  const { skillId, ...body } = input;
  return requestJson({
    parse: resourceLibraryArchiveResultSchema.parse, ...options,
    path: `/resource-library/skills/${encodeURIComponent(skillId)}/archive`,
    method: "PATCH",
    body,
  });
}

export function attachResourceSkill(input: {
  agentId: string;
  skillId: string;
  revisionId: string;
  alias: string;
  expectedGeneration: number;
}, options: RequestOptions = {}): Promise<ResourceLibraryBrowserSnapshot> {
  const { agentId, ...body } = input;
  return requestJson({
    parse: resourceLibraryBrowserSnapshotSchema.parse, ...options,
    path: `/resource-library/agents/${encodeURIComponent(agentId)}/attachments`,
    body,
  });
}

export function detachResourceSkill(input: {
  agentId: string;
  alias: string;
  expectedGeneration: number;
}, options: RequestOptions = {}): Promise<ResourceLibraryBrowserSnapshot> {
  const { agentId, alias, ...body } = input;
  return requestJson({
    parse: resourceLibraryBrowserSnapshotSchema.parse, ...options,
    path: `/resource-library/agents/${encodeURIComponent(agentId)}/attachments/${encodeURIComponent(alias)}`,
    method: "DELETE",
    body,
  });
}

export function selectResourceAgentRevision(input: {
  agentId: string;
  skillId: string;
  revisionId: string;
  expectedGeneration: number;
}, options: RequestOptions = {}): Promise<ResourceLibraryBrowserSnapshot> {
  const { agentId, ...body } = input;
  return requestJson({
    parse: resourceLibraryBrowserSnapshotSchema.parse, ...options,
    path: `/resource-library/agents/${encodeURIComponent(agentId)}/revision`,
    body,
  });
}
