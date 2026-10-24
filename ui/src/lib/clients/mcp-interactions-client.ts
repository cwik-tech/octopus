import { getApiBaseUrl } from "@/lib/utils/desktop";
import type { McpToolRisk } from "@contracts/mcp";

const API_BASE = getApiBaseUrl();

export type { McpToolRisk };

export type McpApprovalStatus =
  | "pending"
  | "approved-once"
  | "approved-run"
  | "denied"
  | "cancelled"
  | "expired"
  | "interrupted";

export type McpElicitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired"
  | "interrupted";

interface McpInteractionBase {
  interactionId: string;
  sessionId: string;
  runId: string;
  assignmentId: string;
  agentPath: string;
  serverId: string;
  toolCallId: string;
  namespacedToolName: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
}

export interface McpApprovalInteraction extends McpInteractionBase {
  kind: "approval";
  toolRisk: McpToolRisk;
  argumentNames: string[];
  status: McpApprovalStatus;
  decision?: "approve" | "deny";
  approvalScope?: "once" | "run";
}

interface McpElicitationBase extends McpInteractionBase {
  kind: "elicitation";
  message: string;
  status: McpElicitationStatus;
  action?: "accept" | "decline" | "cancel";
}

interface McpFormFieldBase {
  title?: string;
  description?: string;
}

export interface McpStringFieldSchema extends McpFormFieldBase {
  type: "string";
  minLength?: number;
  maxLength?: number;
  format?: "date" | "date-time" | "email" | "uri";
  default?: string;
}

export interface McpStringEnumFieldSchema extends McpFormFieldBase {
  type: "string";
  enum: string[];
  default?: string;
}

export interface McpTitledStringEnumFieldSchema extends McpFormFieldBase {
  type: "string";
  oneOf: Array<{ const: string; title: string }>;
  default?: string;
}

export interface McpNumberFieldSchema extends McpFormFieldBase {
  type: "number" | "integer";
  minimum?: number;
  maximum?: number;
  default?: number;
}

export interface McpBooleanFieldSchema extends McpFormFieldBase {
  type: "boolean";
  default?: boolean;
}

export interface McpArrayFieldSchema extends McpFormFieldBase {
  type: "array";
  minItems?: number;
  maxItems?: number;
  items:
    | { type: "string"; enum: string[] }
    | { anyOf: Array<{ const: string; title: string }> };
  default?: string[];
}

export type McpFormFieldSchema =
  | McpStringFieldSchema
  | McpStringEnumFieldSchema
  | McpTitledStringEnumFieldSchema
  | McpNumberFieldSchema
  | McpBooleanFieldSchema
  | McpArrayFieldSchema;

export interface McpElicitationFormSchema {
  type: "object";
  properties: Record<string, McpFormFieldSchema>;
  required: string[];
  additionalProperties: false;
}

export interface McpFormElicitationInteraction extends McpElicitationBase {
  mode: "form";
  schema: McpElicitationFormSchema;
}

export interface McpUrlElicitationInteraction extends McpElicitationBase {
  mode: "url";
  url: string;
  elicitationId: string;
}

export type McpElicitationInteraction =
  | McpFormElicitationInteraction
  | McpUrlElicitationInteraction;

export type McpInteraction =
  | McpApprovalInteraction
  | McpElicitationInteraction;

export type McpElicitationFormValue =
  | string
  | number
  | boolean
  | string[];

export type McpInteractionResponse =
  | { kind: "approval"; decision: "approve"; scope: "once" | "run" }
  | { kind: "approval"; decision: "deny" }
  | {
      kind: "elicitation";
      action: "accept";
      values?: Record<string, McpElicitationFormValue> | undefined;
    }
  | { kind: "elicitation"; action: "decline" | "cancel" };

export interface McpInteractionListResult {
  interactions: McpInteraction[];
  truncated: boolean;
}

export interface McpInteractionsClient {
  list(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<McpInteractionListResult>;
  respond(
    sessionId: string,
    interactionId: string,
    response: McpInteractionResponse,
    signal?: AbortSignal,
  ): Promise<McpInteraction>;
}

export class McpInteractionsClientError extends Error {
  readonly status: number;
  readonly code?: string | undefined;

  constructor(
    message: string,
    status: number,
    code?: string,
  ) {
    super(message);
    this.name = "McpInteractionsClientError";
    this.status = status;
    this.code = code;
  }
}

export function listMcpInteractions(
  sessionId: string,
  signal?: AbortSignal,
): Promise<McpInteractionListResult> {
  return request(
    interactionPath(sessionId),
    signal ? { signal } : undefined,
  );
}

export async function respondToMcpInteraction(
  sessionId: string,
  interactionId: string,
  response: McpInteractionResponse,
  signal?: AbortSignal,
): Promise<McpInteraction> {
  const payload = await request<{ interaction: McpInteraction }>(
    `${interactionPath(sessionId)}/${encodeURIComponent(interactionId)}/respond`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(response),
      ...(signal ? { signal } : {}),
    },
  );
  return payload.interaction;
}

export const mcpInteractionsClient: McpInteractionsClient = {
  list: listMcpInteractions,
  respond: respondToMcpInteraction,
};

function interactionPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/mcp-interactions`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText}`.trim();
    try {
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        code?: string;
      };
      throw new McpInteractionsClientError(
        payload.error || payload.message || fallback,
        response.status,
        payload.code,
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new McpInteractionsClientError(fallback, response.status);
      }
      throw error;
    }
  }
  return (await response.json()) as T;
}
