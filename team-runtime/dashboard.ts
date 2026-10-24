/**
 * Team Runtime — Dashboard Rendering
 *
 * All dashboard/UI rendering logic extracted from index.ts.
 * Functions accept `ctx: RuntimeContext` for state access.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type {
  AgentMetrics,
  AgentRunEvent,
  DelegationStatusSnapshot,
} from "../core/types.js";
import { STAGE_TYPE } from "../core/constants.js";
import { AGENT_STATE } from "../core/constants.js";
import { getCurrentConstraints } from "../core/stage-helpers.js";
import { formatCost } from "../core/constraints.js";
import type { RuntimeContext } from "../domains/runtime/runtime-context.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAgentRunEvent(value: unknown): value is AgentRunEvent {
  if (!isRecord(value)) return false;
  return typeof value.timestamp === "string" &&
    (value.event === "start" || value.event === "end" || value.event === "fail" || value.event === "skip") &&
    typeof value.session_id === "string" &&
    typeof value.assignment_path === "string" &&
    typeof value.team === "string" &&
    typeof value.agent_name === "string" &&
    (value.agent_type === "agent" || value.agent_type === "team");
}
import {
  formatRecentErrors,
  errorTypeColor,
} from "../core/error-aggregator.js";

type DashboardTheme = Pick<Theme, "fg">;

// ─── Local Helper ────────────────────────────────────────────────────────────

/** Elapsed ms: 0 before timer starts, frozen after end, live in between. */
function getElapsedMs(ctx: RuntimeContext): number {
  if (!ctx.state.timerStarted) return 0;
  const end = ctx.state.endTime ?? Date.now();
  return end - ctx.state.startTime;
}

function summarizeActiveDelegation(ctx: RuntimeContext): string | null {
  const snapshots = [...(ctx.activeDelegations?.values() ?? [])];
  const delegation = snapshots[0];
  if (!delegation) return null;
  let progress: string = delegation.status;
  const childAssignmentPath = delegation.childAssignmentPath;

  if (
    childAssignmentPath &&
    fs.existsSync(childAssignmentPath)
  ) {
    const candidates = [
      "final-draft.md",
      "review-feedback-v1.md",
      "draft-v1.md",
      "draft-package.md",
      "brief.md",
      "incoming-brief.md",
    ];
    const found = candidates.find((name) =>
      fs.existsSync(path.join(childAssignmentPath, name)),
    );
    if (found) progress = `${delegation.status} • ${found}`;
  }

  return `Waiting on ${delegation.toTeam} (${progress})`;
}

function inferAgentStateFromEvent(event: AgentRunEvent): AgentMetrics["state"] {
  if (event.event === "start" || event.status === "active")
    return AGENT_STATE.ACTIVE;
  if (event.event === "fail" || event.status === "failed")
    return AGENT_STATE.ERROR;
  if (event.event === "skip" || event.status === "skipped")
    return AGENT_STATE.DONE;
  return AGENT_STATE.DONE;
}

/**
 * What a delegated child's card says when its own record names no model.
 *
 * Rendered rather than left blank, because a blank column is indistinguishable
 * from a card that simply has no model to show. This says the history is
 * missing, which is the honest answer.
 */
const UNRECORDED_CHILD_MODEL = "unknown";

/**
 * This event's attempt identity, exactly as recorded, or nothing.
 *
 * Read from `unknown` rather than trusted: `isAgentRunEvent` does not check
 * this optional field, so its declared type says nothing about what is actually
 * in the file. A blank or wrong-typed id is no id at all — it must never be
 * what makes two events look like the same attempt.
 *
 * Padded ids are refused rather than trimmed. This value is compared, so
 * normalizing it would make `attempt-a` and ` attempt-a ` the same attempt and
 * bring back the borrowing this exists to prevent.
 */
function readDispatchId(event: AgentRunEvent): string | undefined {
  const value: unknown = event.dispatch_id;
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value !== value.trim()) return undefined;
  return value;
}

function readDelegatedChildAgentMetrics(
  delegation: DelegationStatusSnapshot,
  parentTeamMetrics: AgentMetrics | undefined,
): Map<string, AgentMetrics> {
  const childAssignmentPath = delegation.childAssignmentPath;
  if (!childAssignmentPath) return new Map();

  const logPath = path.join(childAssignmentPath, "logs", "agent-runs.jsonl");
  if (!fs.existsSync(logPath)) return new Map();

  const fallbackColor = parentTeamMetrics?.color ?? 141;
  const childMetrics = new Map<string, AgentMetrics>();
  // Which attempt each recorded model belongs to. A start and its own end are
  // one attempt and share a model; a retry is a different one.
  const modelDispatchIds = new Map<string, string | undefined>();
  const raw = fs.readFileSync(logPath, "utf8").trim();
  if (!raw) return childMetrics;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isAgentRunEvent(event)) continue;

    const existing = childMetrics.get(event.agent_name);
    const metrics: AgentMetrics = existing ?? {
      state: AGENT_STATE.IDLE,
      rounds: 0,
      totalCost: 0,
      contextTokens: 0,
      model: event.model || UNRECORDED_CHILD_MODEL,
      color: fallbackColor,
      failureCount: 0,
    };

    // What this agent ran on, and only what was actually recorded for the
    // attempt in hand.
    //
    // The parent's model and the delegated Team's name are facts about
    // something else, so neither stands in. A model is carried forward only
    // within one identified attempt — a start and its own end — because
    // `dispatch_id` is what tells attempts apart, and showing a retry the model
    // its predecessor ran on is a claim about the retry that nothing recorded.
    // Where either side has no identity there is nothing to match on, so
    // nothing is assumed.
    const attemptId = readDispatchId(event);
    if (event.model) {
      metrics.model = event.model;
      modelDispatchIds.set(event.agent_name, attemptId);
    } else {
      const recordedFor = modelDispatchIds.get(event.agent_name);
      const sameAttempt = attemptId !== undefined && attemptId === recordedFor;
      metrics.model = sameAttempt ? metrics.model : UNRECORDED_CHILD_MODEL;
      if (!sameAttempt) modelDispatchIds.delete(event.agent_name);
    }
    metrics.state = inferAgentStateFromEvent(event);
    if (metrics.state === AGENT_STATE.ACTIVE) {
      metrics.activeStartedAt = Date.parse(event.timestamp) || Date.now();
    } else {
      delete metrics.activeStartedAt;
    }
    if (metrics.state === AGENT_STATE.ERROR) {
      metrics.failureCount += 1;
    }

    childMetrics.set(event.agent_name, metrics);
  }

  return childMetrics;
}

function getDisplayAgentMetrics(
  ctx: RuntimeContext,
): Map<string, AgentMetrics> {
  const displayMetrics = new Map(ctx.agentMetrics);
  const delegations = [...(ctx.activeDelegations?.values() ?? [])];

  for (const delegation of delegations) {
    const delegatedTeamMetrics = displayMetrics.get(delegation.toTeam);
    const childMetrics = readDelegatedChildAgentMetrics(
      delegation,
      delegatedTeamMetrics,
    );
    if (childMetrics.size === 0) continue;

    displayMetrics.delete(delegation.toTeam);
    for (const [agentName, metrics] of childMetrics.entries()) {
      const uniqueName = displayMetrics.has(agentName)
        ? `${delegation.toTeam}/${agentName}`
        : agentName;
      displayMetrics.set(uniqueName, metrics);
    }
  }

  return displayMetrics;
}

// ─── Round Helper ────────────────────────────────────────────────────────────

/**
 * Extract the current round/iteration/step number from engine state.
 * Returns 0 if the level has no active engine state.
 */
export function getCurrentRound(ctx: RuntimeContext): number {
  if (!ctx.teamConfig) return 0;
  const level = ctx.teamConfig.levels[ctx.state.currentLevelIndex];
  if (!level) return 0;
  const ls = ctx.state.levelStates.get(level.id);
  if (!ls?.engineState) return 0;
  if (ls.engineState.type === STAGE_TYPE.DISCUSSION)
    return ls.engineState.round;
  if (ls.engineState.type === STAGE_TYPE.REVIEW)
    return ls.engineState.iteration;
  if (ls.engineState.type === STAGE_TYPE.CHAIN)
    return ls.engineState.currentStep;
  return 0;
}

// ─── Progress Bar ────────────────────────────────────────────────────────────

/**
 * Render a single colored progress bar row.
 * Pure function — no side effects, no closure dependencies.
 */
export function renderProgressBar(
  label: string,
  current: number,
  max: number,
  width: number,
  theme: DashboardTheme,
): string {
  const labelPad = 8;
  const valuePad = 20;
  const barWidth = Math.max(10, width - labelPad - valuePad);
  const ratio = Math.min(1, Math.max(0, current / max));
  const filled = Math.round(ratio * barWidth);
  const empty = barWidth - filled;

  const warningThreshold = 0.8;
  const barColor =
    ratio >= warningThreshold ? "\x1b[38;5;196m" : "\x1b[38;5;226m";
  const filledStr = barColor + "\u2588".repeat(filled) + "\x1b[0m";
  const emptyStr = "\x1b[38;5;238m" + "\u2591".repeat(empty) + "\x1b[0m";

  const labelStr = "\x1b[1;38;5;208m" + label.padEnd(labelPad) + "\x1b[0m";
  const currentStr =
    label === "BUDGET" ? `$${current.toFixed(2)}` : `${current.toFixed(1)} min`;
  const maxStr = label === "BUDGET" ? `$${max}` : `${max} min`;

  return `${labelStr}${filledStr}${emptyStr}  ${currentStr.padEnd(10)}${theme.fg("dim", maxStr)}`;
}

// ─── Agent Card ──────────────────────────────────────────────────────────────

/**
 * Render a single agent status card.
 * Pure function — no side effects, no closure dependencies.
 */
export function renderAgentCard(
  name: string,
  metrics: AgentMetrics,
  cardWidth: number,
): string[] {
  const c = metrics.color;
  const bg = (t: string) => `\x1b[48;5;${c};30m${t}\x1b[0m`;

  const displayName = name.replace(
    /(^|[-])(\w)/g,
    (_m: string, sep: string, ch: string) => (sep === "-" ? " " : "") + ch.toUpperCase(),
  );
  const compactModel = metrics.model
    ? metrics.model.startsWith("gpt-")
      ? metrics.model
      : metrics.model.replace(/^[^-]+-/, "")
    : "";
  const modelLabel = compactModel ? ` [${compactModel}]` : "";

  let statusIcon: string;
  switch (metrics.state) {
    case AGENT_STATE.IDLE:
      statusIcon = "o";
      break;
    case AGENT_STATE.ACTIVE:
      statusIcon = Math.floor(Date.now() / 500) % 2 === 0 ? "\u25c9" : "\u25cb";
      break;
    case AGENT_STATE.DONE:
      statusIcon = "\u2713";
      break;
    case AGENT_STATE.ERROR:
      statusIcon = "\u2717";
      break;
  }

  const statsItems: string[] = [];
  if (metrics.rounds > 0) statsItems.push(`r:${metrics.rounds}`);
  if (metrics.totalCost > 0)
    statsItems.push(`$${metrics.totalCost.toFixed(2)}`);
  if (metrics.state === AGENT_STATE.ACTIVE) statsItems.push("ACTIVE");
  if (metrics.failureCount > 0)
    statsItems.push(`\x1b[38;5;196m\u2717${metrics.failureCount}\x1b[0m`);
  const rightPart = statsItems.length > 0 ? ` ${statsItems.join(" ")} ` : "";
  const maxLeftWidth = Math.max(8, cardWidth - visibleWidth(rightPart) - 1);
  const identity = truncateToWidth(
    ` ${statusIcon} ${displayName}${modelLabel}`,
    maxLeftWidth,
  );
  const leftPart = `\x1b[1m${identity}\x1b[22m`;

  const leftLen = visibleWidth(leftPart);
  const rightLen = visibleWidth(rightPart);
  const padding = Math.max(1, cardWidth - leftLen - rightLen);

  const contentLine = bg(leftPart + " ".repeat(padding) + rightPart);
  const emptyLine = bg(" ".repeat(cardWidth));
  return [emptyLine, contentLine, emptyLine];
}

// ─── Error Pane ──────────────────────────────────────────────────────────────

/**
 * Render a scrollable error pane with the last N agent errors.
 */
export function renderErrorPane(
  width: number,
  ctx: RuntimeContext,
  maxLines = 12,
): string[] {
  const workspacePath = ctx.teamConfig?.workspace?.path;
  if (!workspacePath) return [];

  const errors = formatRecentErrors(workspacePath, 20);
  if (errors.length === 0) return [];

  const lines: string[] = [];
  lines.push(
    "\x1b[1;38;5;196m── Error Log ───────────────────────────────────────────────\x1b[0m",
  );

  const displayedErrors = errors.slice(-maxLines).reverse();
  for (const entry of displayedErrors) {
    const color = errorTypeColor(entry.errorType);
    const timeLabel = entry.time.slice(11, 19);
    const agentLabel = entry.agent.slice(0, 14).padEnd(14);
    const typeLabel = `[${entry.errorType}]`.padEnd(14);
    const attemptLabel = `a${entry.attempt}/${entry.maxAttempts}`;
    const prefix = `\x1b[38;5;242m${timeLabel}\x1b[0m \x1b[1m${agentLabel}\x1b[0m \x1b[38;5;${color}m${typeLabel}\x1b[0m ${attemptLabel}`;
    const prefixWidth = visibleWidth(prefix);
    const msgWidth = Math.max(10, width - prefixWidth - 2);
    const msg = truncateToWidth(entry.message, msgWidth);
    lines.push(`${prefix} ${msg}`);
  }

  if (errors.length > maxLines) {
    lines.push(
      `\x1b[38;5;242m… and ${errors.length - maxLines} more errors\x1b[0m`,
    );
  }

  return lines;
}

// ─── Grid Renderer ───────────────────────────────────────────────────────────

/**
 * Build the full dashboard grid: header, progress bars, and agent cards.
 *
 * @param width  Terminal width in characters
 * @param theme  Pi TUI theme object
 * @param ctx    Runtime context (state, teamConfig, agentMetrics)
 */
export function renderGrid(
  width: number,
  theme: DashboardTheme,
  ctx: RuntimeContext,
): string[] {
  if (!ctx.teamConfig) return [];

  const lines: string[] = [];
  const level = ctx.teamConfig.levels[ctx.state.currentLevelIndex];
  const round = getCurrentRound(ctx);
  const constraints = getCurrentConstraints(level);
  const displayAgentMetrics = getDisplayAgentMetrics(ctx);

  // Header: Team Name — Round N    $X.XX
  const activeCount = [...displayAgentMetrics.values()].filter(
    (m) => m.state === AGENT_STATE.ACTIVE,
  ).length;
  const headerStatus = activeCount > 0 ? `(${activeCount} active)` : "";
  const roundLabel = round > 0 ? `Round ${round}` : level?.stage.type || "";
  lines.push(
    `\x1b[1;38;5;178m${ctx.teamConfig.team.name}\x1b[0m` +
      `\x1b[38;5;242m \u2014 ${roundLabel} ${headerStatus}\x1b[0m` +
      (ctx.state.totalCost > 0
        ? `  \x1b[38;5;226m${formatCost(ctx.state.totalCost)}\x1b[0m`
        : ""),
  );
  const delegationSummary = summarizeActiveDelegation(ctx);
  if (delegationSummary) {
    lines.push(`\x1b[38;5;214m${delegationSummary}\x1b[0m`);
  }
  lines.push("");

  // Progress bars (TIME + BUDGET)
  if (constraints) {
    const elapsedMin = getElapsedMs(ctx) / 60000;
    lines.push(
      renderProgressBar("TIME", elapsedMin, constraints.maxTime, width, theme),
    );
    lines.push(
      renderProgressBar(
        "BUDGET",
        ctx.state.totalCost,
        constraints.maxBudget,
        width,
        theme,
      ),
    );
    lines.push("");
  }

  // Agent cards
  const allAgents = [...displayAgentMetrics.entries()];
  if (allAgents.length > 0) {
    const gap = 1;
    const totalGaps = (allAgents.length - 1) * gap;
    const cardWidth = Math.max(
      20,
      Math.floor((width - totalGaps) / Math.min(allAgents.length, 4)),
    );

    const cards = allAgents.map(([name, m]) =>
      renderAgentCard(name, m, cardWidth),
    );

    // Arrange in rows of 4
    for (let i = 0; i < cards.length; i += 4) {
      const row = cards.slice(i, i + 4);
      const cardHeight = row[0]?.length
        ? row[0].length && row[0].constructor === Array
          ? row[0].length
          : 0
        : 0;
      for (let lineIndex = 0; lineIndex < cardHeight; lineIndex++) {
        lines.push(
          row.map((card) => card[lineIndex] ?? "").join(" ".repeat(gap)),
        );
      }
    }
  }

  // Error pane
  const errorPane = renderErrorPane(width, ctx);
  if (errorPane.length > 0) {
    lines.push("");
    lines.push(...errorPane);
  }

  return lines.map((line) => {
    if (visibleWidth(line) > width) return truncateToWidth(line, width);
    return line;
  });
}

// ─── Dashboard Update ────────────────────────────────────────────────────────

/**
 * Update the status bar and the dashboard widget.
 * Stores `extCtx` as `ctx.lastCtx` so the refresh timer always has a
 * current context to render into.
 *
 * @param extCtx  Current extension context (from a Pi event)
 * @param ctx     Runtime context (state, teamConfig, agentMetrics)
 */
export function updateDashboard(
  extCtx: ExtensionContext,
  ctx: RuntimeContext,
): void {
  ctx.lastCtx = extCtx;
  if (!ctx.teamConfig) return;

  const level = ctx.teamConfig.levels[ctx.state.currentLevelIndex];
  const levelName = level?.name || "Setup";
  const displayAgentMetrics = getDisplayAgentMetrics(ctx);

  // Status bar
  const activeCount = [...displayAgentMetrics.values()].filter(
    (m) => m.state === AGENT_STATE.ACTIVE,
  ).length;
  const errorCount = [...displayAgentMetrics.values()].filter(
    (m) => m.failureCount > 0,
  ).length;
  const statusParts = [ctx.teamConfig.team.name, levelName];
  if (activeCount > 0) statusParts.push(`${activeCount} active`);
  const delegationSummary = summarizeActiveDelegation(ctx);
  if (delegationSummary) statusParts.push(delegationSummary);
  if (ctx.state.totalCost > 0)
    statusParts.push(formatCost(ctx.state.totalCost));
  if (errorCount > 0)
    statusParts.push(`${errorCount} error${errorCount !== 1 ? "s" : ""}`);

  extCtx.ui.setStatus("team-runtime", statusParts.join(" | "));

  // Widget — captures ctx in closure so each render call uses live values
  extCtx.ui.setWidget("team-runtime-grid", (_tui, theme) => ({
    render(width: number): string[] {
      return renderGrid(width, theme, ctx);
    },
    invalidate() {},
  }));
}

// ─── Refresh Timer ───────────────────────────────────────────────────────────

/**
 * Start or stop the 500 ms refresh interval that keeps the dashboard
 * animated while agents are active.
 * Reads `ctx.agentMetrics`, `ctx.lastCtx`, `ctx.refreshTimer` and mutates
 * `ctx.refreshTimer` in place.
 */
export function manageRefreshTimer(ctx: RuntimeContext): void {
  // Shutdown is final. The interval's own exit condition is "no agent is
  // active", which a turn that never ended never satisfies, so a runtime event
  // arriving after `session_shutdown` could re-arm a repeating referenced timer
  // that then runs for the life of the process. Artifact writes publish
  // asynchronously and the dashboard observer reacts to them
  // (`team-runtime/runtime-observers.ts:11-19`), so those late events are
  // ordinary, not exceptional.
  const shutDown = ctx.shutdownController.signal.aborted;
  const hasActive =
    !shutDown &&
    [...getDisplayAgentMetrics(ctx).values()].some(
      (m) => m.state === AGENT_STATE.ACTIVE,
    );
  if (hasActive && !ctx.refreshTimer && ctx.lastCtx) {
    // Capture current lastCtx so the timer always renders to the same pane
    const capturedExtCtx = ctx.lastCtx;
    const timer = setInterval(() => {
      if (
        [...getDisplayAgentMetrics(ctx).values()].some(
          (m) => m.state === AGENT_STATE.ACTIVE,
        )
      ) {
        updateDashboard(capturedExtCtx, ctx);
      } else {
        clearInterval(timer);
        ctx.refreshTimer = null;
      }
    }, 500);
    ctx.refreshTimer = timer;
  } else if (!hasActive && ctx.refreshTimer) {
    clearInterval(ctx.refreshTimer);
    ctx.refreshTimer = null;
  }
}
