/**
 * Team Runtime — Error Aggregator
 *
 * Reads structured JSONL error logs and surfaces aggregated insights.
 * Turns the write-only `agent-errors.jsonl` and `provider-events.jsonl`
 * into actionable debugging data.
 */

import { whenDefined } from "./optional-properties.js"
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentErrorEvent, ProviderEvent } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAgentErrorEvent(value: unknown): value is AgentErrorEvent {
  if (!isRecord(value)) return false;
  return typeof value.timestamp === "string" &&
    typeof value.session_id === "string" &&
    typeof value.level_id === "string" &&
    typeof value.agent_name === "string" &&
    typeof value.attempt === "number" &&
    typeof value.max_attempts === "number" &&
    typeof value.policy === "string" &&
    typeof value.error_message === "string" &&
    (value.error_type === "agent_failure" || value.error_type === "fallback_failure" || value.error_type === "halt" || value.error_type === "skipped") &&
    typeof value.duration_ms === "number";
}

function isProviderEvent(value: unknown): value is ProviderEvent {
  return isRecord(value) &&
    typeof value.timestamp === "string" &&
    typeof value.provider === "string" &&
    typeof value.event === "string";
}

// ─── Agent Error Aggregation ─────────────────────────────────────────────────

export interface AgentFailureSummary {
  agentName: string;
  failureCount: number;
  lastError: string;
  lastErrorType: string;
  lastTimestamp: string;
  errorTypes: string[];
}

export interface ProviderFailureSummary {
  provider: string;
  failureCount: number;
  lastStatusCode?: number;
  lastError: string;
  lastTimestamp: string;
}

/**
 * Read recent agent error events from workspace/agent-errors.jsonl.
 */
export function readAgentErrors(
  workspacePath: string,
  options: { since?: Date; agentFilter?: string; limit?: number } = {},
): AgentErrorEvent[] {
  const logPath = path.join(workspacePath, "agent-errors.jsonl");
  if (!fs.existsSync(logPath)) return [];

  const sinceMs = options.since?.getTime() ?? 0;
  const limit = options.limit ?? 1000;
  const results: AgentErrorEvent[] = [];

  const raw = fs.readFileSync(logPath, "utf8").trim();
  if (!raw) return [];

  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (results.length >= limit) break;
    const line = lines[i];
    if (!line) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (!isAgentErrorEvent(event)) continue;
      const eventTime = Date.parse(event.timestamp);
      if (Number.isFinite(eventTime) && eventTime < sinceMs) continue;
      if (options.agentFilter && event.agent_name !== options.agentFilter)
        continue;
      results.unshift(event);
    } catch {
      continue;
    }
  }

  return results;
}

/**
 * Summarize agent failures per agent from workspace/agent-errors.jsonl.
 */
export function getAgentFailureSummary(
  workspacePath: string,
): AgentFailureSummary[] {
  const errors = readAgentErrors(workspacePath, { limit: 10000 });
  const byAgent = new Map<string, AgentFailureSummary>();

  for (const event of errors) {
    const existing = byAgent.get(event.agent_name);
    if (existing) {
      existing.failureCount++;
      const eventTime = Date.parse(event.timestamp);
      const lastTime = Date.parse(existing.lastTimestamp);
      if (eventTime > lastTime) {
        existing.lastError = event.error_message;
        existing.lastErrorType = event.error_type;
        existing.lastTimestamp = event.timestamp;
      }
      if (!existing.errorTypes.includes(event.error_type)) {
        existing.errorTypes.push(event.error_type);
      }
    } else {
      byAgent.set(event.agent_name, {
        agentName: event.agent_name,
        failureCount: 1,
        lastError: event.error_message,
        lastErrorType: event.error_type,
        lastTimestamp: event.timestamp,
        errorTypes: [event.error_type],
      });
    }
  }

  return Array.from(byAgent.values()).sort(
    (a, b) => b.failureCount - a.failureCount,
  );
}

/**
 * Read provider failure events from assignment logs/provider-events.jsonl.
 */
export function readProviderFailures(
  outputPath: string,
  options: { since?: Date; providerFilter?: string; limit?: number } = {},
): ProviderEvent[] {
  const logPath = path.join(outputPath, "logs", "provider-events.jsonl");
  if (!fs.existsSync(logPath)) return [];

  const sinceMs = options.since?.getTime() ?? 0;
  const limit = options.limit ?? 1000;
  const results: ProviderEvent[] = [];

  const raw = fs.readFileSync(logPath, "utf8").trim();
  if (!raw) return [];

  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (results.length >= limit) break;
    const line = lines[i];
    if (!line) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (!isProviderEvent(event)) continue;
      if (event.event !== "request.fail" && event.status !== "failed") continue;
      const eventTime = Date.parse(event.timestamp);
      if (Number.isFinite(eventTime) && eventTime < sinceMs) continue;
      if (options.providerFilter && event.provider !== options.providerFilter)
        continue;
      results.unshift(event);
    } catch {
      continue;
    }
  }

  return results;
}

/**
 * Summarize provider failures per provider from assignment logs.
 */
export function getProviderFailureStats(
  outputPath: string,
): ProviderFailureSummary[] {
  const failures = readProviderFailures(outputPath, { limit: 10000 });
  const byProvider = new Map<string, ProviderFailureSummary>();

  for (const event of failures) {
    const provider = event.provider;
    const existing = byProvider.get(provider);
    const statusCode = extractStatusCode(event);
    const detail = event.detail ?? "Provider request failed";

    if (existing) {
      existing.failureCount++;
      const eventTime = Date.parse(event.timestamp);
      const lastTime = Date.parse(existing.lastTimestamp);
      if (eventTime > lastTime) {
        if (statusCode !== undefined) existing.lastStatusCode = statusCode;
        existing.lastError = detail;
        existing.lastTimestamp = event.timestamp;
      }
    } else {
      byProvider.set(provider, {
        provider,
        failureCount: 1,
        ...whenDefined(statusCode, (definedValue) => ({ lastStatusCode: definedValue })),
        lastError: detail,
        lastTimestamp: event.timestamp,
      });
    }
  }

  return Array.from(byProvider.values()).sort(
    (a, b) => b.failureCount - a.failureCount,
  );
}

function extractStatusCode(event: ProviderEvent): number | undefined {
  const raw = event.raw;
  if (raw && typeof raw.http_status === "number") return raw.http_status;
  // Try to extract from detail string
  const detail = event.detail ?? "";
  const match = detail.match(/\b(\d{3})\b/);
  const statusCodeText = match?.[1];
  if (statusCodeText) {
    const code = Number.parseInt(statusCodeText, 10);
    if (Number.isFinite(code)) return code;
  }
  return undefined;
}

// ─── Dashboard Helpers ───────────────────────────────────────────────────────

export interface ErrorPaneEntry {
  agent: string;
  stage: string;
  errorType: string;
  message: string;
  time: string;
  attempt: number;
  maxAttempts: number;
}

/**
 * Format the last N errors for display in a dashboard error pane.
 */
export function formatRecentErrors(
  workspacePath: string,
  limit = 20,
): ErrorPaneEntry[] {
  const errors = readAgentErrors(workspacePath, { limit });
  return errors.map((e) => ({
    agent: e.agent_name,
    stage: e.level_id,
    errorType: e.error_type,
    message: e.error_message,
    time: e.timestamp,
    attempt: e.attempt,
    maxAttempts: e.max_attempts,
  }));
}

/**
 * Color-code an error type for terminal display.
 */
export function errorTypeColor(errorType: string): number {
  switch (errorType) {
    case "halt":
      return 196; // red
    case "fallback_failure":
      return 208; // orange
    case "skipped":
      return 226; // yellow
    case "agent_failure":
      return 220; // yellow-orange
    default:
      return 250; // gray
  }
}
