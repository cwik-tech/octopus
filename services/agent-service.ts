import type {
  AgentPackageAddKind,
  AgentPackageImportAction,
  ChatTurn as AgentChatTurn,
} from "../contracts/agent-generator.js";
import {
  addAgentToTeamRequestSchema,
  agentPackageAddRequestSchema,
  agentPackageImportRequestSchema,
  agentPackageRemoveRequestSchema,
  commitAgentRequestSchema,
  deleteAgentByNameRequestSchema,
  deleteAgentRequestSchema,
  draftAgentRequestSchema,
  listSkillsRequestSchema,
  refineAgentRequestSchema,
  saveAgentPersonaRequestSchema,
} from "../contracts/schemas/agent-requests.js";
import {
  parseServiceRequest,
} from "./service-errors.js";

export function parseListSkillsBody(payload: unknown): { path: string } {
  return parseServiceRequest(listSkillsRequestSchema, payload);
}

export function parseDraftAgentBody(payload: unknown): {
  jobId?: string;
  skillPaths: string[];
  chatHistory: AgentChatTurn[];
  duplicatePolicy?: "overwrite" | "duplicate";
  provider?: string;
  model?: string;
} {
  return parseServiceRequest(draftAgentRequestSchema, payload);
}

export function parseCommitAgentBody(payload: unknown): {
  approvedName: string;
  personaMarkdown: string;
  skillPaths: string[];
  generatedSkills?: Array<{ name: string; body: string }>;
  overwrite?: boolean;
} {
  return parseServiceRequest(commitAgentRequestSchema, payload);
}

export function parseRefineAgentBody(payload: unknown): {
  jobId?: string;
  agentName: string;
  currentPersona: string;
  chatHistory: AgentChatTurn[];
  provider?: string;
  model?: string;
} {
  return parseServiceRequest(refineAgentRequestSchema, payload);
}

export function parseSaveAgentPersonaBody(payload: unknown): {
  agentName: string;
  personaMarkdown: string;
} {
  return parseServiceRequest(saveAgentPersonaRequestSchema, payload);
}

export function parseAgentPackageAddBody(payload: unknown): {
  agentName: string;
  kind: AgentPackageAddKind;
  files: Array<{ relativePath: string; contentBase64: string }>;
} {
  return parseServiceRequest(agentPackageAddRequestSchema, payload);
}

export function parseAgentPackageImportBody(payload: unknown): {
  agentName: string;
  preferredKind: AgentPackageAddKind;
  files: Array<{ relativePath: string; contentBase64: string }>;
  choices?: Array<{
    id: string;
    selected: boolean;
    action: AgentPackageImportAction;
  }>;
} {
  return parseServiceRequest(agentPackageImportRequestSchema, payload);
}

export function parseAgentPackageRemoveBody(payload: unknown): {
  agentName: string;
  kind: AgentPackageAddKind;
  agentPath: string;
  mode: "disconnect" | "delete";
} {
  return parseServiceRequest(agentPackageRemoveRequestSchema, payload);
}

export function parseDeleteAgentBody(payload: unknown): {
  deleteSkills: boolean;
} {
  return parseServiceRequest(deleteAgentRequestSchema, payload);
}

export function parseDeleteAgentRequestBody(payload: unknown): {
  agentName: string;
  deleteSkills: boolean;
} {
  return parseServiceRequest(deleteAgentByNameRequestSchema, payload);
}

export function parseAddAgentToTeamBody(payload: unknown): {
  agentName: string;
  teamId: string;
  role?: string;
} {
  return parseServiceRequest(addAgentToTeamRequestSchema, payload);
}
