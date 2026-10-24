/**
 * Team Runtime — Generic Multi-Agent Team Extension
 *
 * A config-driven Pi extension that runs any multi-agent team defined
 * by a team.yaml file. Supports 5 stage types (discussion, pipeline,
 * chain, broadcast, review) organized into ordered levels with gates.
 *
 * Launch: cd <team-folder> && pi -e <path-to>/team-runtime/index.ts
 *
 * If no team.yaml exists, enters setup mode with an interactive agent
 * that guides team creation.
 *
 * ── Module Structure ────────────────────────────────────────────────────────
 *
 *   index.ts           — entry point, boot, event wiring, state persistence
 *   dashboard.ts       — all UI rendering: grid, cards, progress bars, timer
 *   commands.ts        — CLI command registrations (team-status, -advance, etc.)
 *   level-lifecycle.ts — gate evaluation, level advancement, experience reflections
 *   prompt-builder.ts  — coordinator system-prompt assembly (18+ template vars)
 *
 *   domains/runtime/runtime-context.ts — RuntimeContext interface + factory
 *   domains/runtime/template.ts        — template substitution and variables
 *   core/stage-helpers.ts     — pure helpers: getParticipantNames, etc.
 *   core/verdict-parser.ts    — shared parseVerdict (used by review + gate-checker)
 *
 * ── Error Handling Policy (4 layers — do NOT unify) ─────────────────────────
 *
 *   1. Config parsing   → returns { config, errors, warnings } result objects
 *                          Errors are recoverable — user can fix team.yaml
 *   2. Agent execution  → always resolves; errors surface in the .text field
 *                          Agent subprocesses can fail without crashing the host
 *   3. Engine tools     → throw for precondition violations (programmer errors),
 *                          catch and embed agent errors in the response
 *   4. Event handlers   → .catch() with console.error — must NEVER throw;
 *                          an unhandled exception would crash the Pi host process
 */

import * as fs from "node:fs";
import { whenDefined } from "../core/optional-properties.js";
import {
  type ModelSelectionRecord,
} from "../contracts/agent-model-selection.js";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type AgentMetrics,
  type LevelConfig,
  type TeamRegistryEntry,
} from "../core/types.js";
import { resolveEntryLevelIndex } from "../core/stage-helpers.js";
import {
  STAGE_TYPE,
  LEVEL_STATUS,
  STAGE_LIFECYCLE_STATUS,
  AGENT_STATE,
} from "../core/constants.js";
import { installShutdownHandlers } from "../core/lifecycle.js";
import type { ShutdownRegistration } from "../core/lifecycle.js";
import { BudgetLedger, roundUsd } from "../core/budget-ledger.js";
import { parseTeamConfig } from "../parsers/team-config.js";
import { parseStartConfig } from "../parsers/start-config.js";
import { parseTeamRegistry } from "../parsers/team-registry.js";
import { loadAgent, parseAgentFrontmatter } from "../parsers/load-agent.js";
import {
  logAgentRun,
  logHostEvent,
  logToolUse,
  logSessionStart,
  logRuntimeEvent,
} from "../domains/runtime/logger.js";
import {
  captureOwnedPiAgentDirectoryProof,
  registerOwnedPiAgentDirectoryExitCleanup,
} from "../domains/run/pi-agent-isolation.js";
import {
  buildPersistedRuntimeState,
  createRuntimeContext,
  restorePersistedRuntimeState,
} from "../domains/runtime/runtime-context.js";
import { RateLimiter } from "../core/rate-limiter.js";
import { applyTeamRuntimeOverrides } from "../core/team-runtime-overrides.js";
import {
  resolveCoordinatorAllowedTools,
  resolveGrantedGovernedFileTools,
  resolveLevelAllowedTools,
} from "../core/tool-policy.js";
import { isSafePathSegment, resolveRelativePathInside } from "../core/path-safety.js";
import { isHumanInputRoutingContext } from '../contracts/human-input.js'
import { armLevelTools, type LevelToolPorts } from "./level-tools.js";
import {
  endHostTurn,
  settleHostTurn,
  startHostTurn,
  type HostTurnLifecyclePorts,
} from "./host-turn-lifecycle.js";
import {
  teardownOnSessionShutdown,
  teardownOnSignal,
  type RuntimeTeardownPorts,
} from "./runtime-teardown.js";

// Engines
import { hasBlockedChainStepVerdict } from "../engines/chain.js";
import { AgentQuestionInterruptionError } from '../core/agent-question-interruption.js';
import { MCP_WORKER_TURN_URL_ENV } from '../domains/mcp/mcp-worker-turn.js';
import { hasMcpProviderAdapter } from '../domains/mcp/mcp-provider-support.js';
import {
  adoptedCheckpointHeader,
  adoptedCheckpointLevels,
  checkpointOwnership,
  checkpointResumeAllowed,
  foreignCheckpointRefusal,
  resumedCheckpointStartTime,
} from "./checkpoint-adoption.js";
import { getProcessRunTextStream } from "../domains/runtime/agent-text-run-stream.js";
import { ensureParsed, loadInputFiles } from "../parsers/input-files.js";
import { coordinateFileParserLauncher } from "../core/file-parse-coordinator.js";
import { resolveRuntimeFileParserLauncher } from "../core/file-parser-launcher.js";
import { updateDashboard, manageRefreshTimer } from "./dashboard.js";
import { installDashboardObserver } from "./runtime-observers.js";
import { registerCommands } from "./commands.js";
import {
  runDelegatedRoutingAutostart,
  runEngineToolAutostart,
  type DelegatedRoutingAutostartPorts,
  type StageAutostartPorts,
} from "./stage-autostart.js";
import {
  resolveHostWorkflowPrompt,
  shouldRuntimeAutostartLevel,
} from "./prompt-builder.js";
import {
  activatePendingStageEntry,
  tryAdvanceLevel as tryAdvanceLevelImpl,
  type LifecycleCallbacks,
} from "./level-lifecycle.js";
import {
  assignmentLocationRefusal,
  bootConfigSource,
  entryLevelActivation,
  initialAgentMetrics,
  pendingLevelStates,
  resolveTeamBoot,
  toRosterEntrySlim,
} from "./team-boot.js";
import {
  buildStageEntryFollowUp,
  buildToolFailureFollowUp,
} from "../domains/stage/stage-entry.js";
import {
  discardPendingStageEntries,
  enqueueFollowUp,
  flushPendingFollowUps,
} from "../domains/runtime/follow-up.js";
import {
  HostRunLifetime,
  HOST_ENTRY_START_DEADLINE_MS,
  HOST_KEEP_ALIVE_INTERVAL_MS,
  type HostRunStop,
} from "../domains/runtime/host-run-lifetime.js";
import { getAutoRegisteredTeamEntries } from "../domains/runtime/runtime-roster.js";
import { DeferredRunCompletion } from "../domains/run/run-completion.js";
import { loadDotEnv } from "../core/env-loader.js";
import { createManagedDevServices } from "./dev-services.js";
import {
  resolveRuntimeAutostartOwnership,
  resolveRuntimeOwnedStageTool,
} from "../domains/runtime/runtime-owned-stage.js";
import {
  readRuntimeAutostartInput,
  resolveRuntimeAutostartOutputOverride,
} from "../domains/stage/runtime-autostart-input.js";
import {
  buildDelegatedDiscussionCoordinatorRequest,
} from "../domains/delegation/delegated-discussion-autostart.js";
import { buildDelegatedRoutingAutostartPlan } from "../domains/delegation/delegated-routing-autostart.js";
import {
  transitionStageStatus,
} from "../domains/stage/stage-lifecycle.js";
import { initProviders } from "../providers/index.js";
import {
  hasCheckpoint,
  readCheckpoint,
  writeCheckpoint,
  deleteCheckpoint,
  formatCheckpointSummary,
} from "../domains/runtime/checkpoint.js";
import {
  getAssignmentPath,
  resolveRuntimeAssignmentLocation,
} from "../domains/runtime/runtime-paths.js";
import {
  admitHostEntry,
  discardHostEntry,
  hostEntryForLevel,
  hostAdmissionCrashRequested,
  pendingHostEntryFor,
  settleHostEntry,
  HOST_ADMISSION_PENDING_CRASH_POINT,
  HOST_SETTLE_WRITE_FAILURE_POINT,
} from "../domains/runtime/host-admission.js";
import {
  decideHostEntryResume,
  readHostEntryAdmission,
} from "../contracts/host-entry-admission.js";
import {
  hostModelSelectionRecord,
  resolveDesiredHostModel,
  type HostModelSpec,
} from "../domains/provider/host-model.js";
import { parseWorkflowRegistry } from "../workflows/loader.js";
import {
  validateDeclaredCoordinators,
  validateHostProviderReadiness,
  validateLoadedAgentProviders,
} from "../domains/provider/provider-preflight.js";
import { applyDesiredHostModel } from "./host-model-preference.js";
import {
  STANDALONE_SKILL_LOADER_TOOL_NAME,
} from "./standalone-skill-loader-tool.js";
import { CapabilityDispatcher } from "../core/capability-dispatcher.js";
import { createTeamRuntimeCapabilityDispatcher } from "./capability-dispatch-factory.js";
import { startWorkspaceExecutionJournal } from "../services/execution-journal-tenant-pin.js";
import {
  createWorkspaceExecutionJournalRegistry,
  type WorkspaceExecutionJournalRegistry,
} from "../services/workspace-execution-journal-registry.js";
import type {
  CapabilityAdapter,
  CapabilityExecutionContext,
  CapabilityPolicyDecision,
} from "../contracts/capability-dispatch.js";
import { AssignmentCapabilityEvidenceWriter } from "../domains/runtime/capability-evidence-writer.js";
import { TeamRuntimeCapabilityPolicy } from "./capability-tool-policy.js";
import { TeamRuntimeCapabilityBypassDetector } from "./capability-bypass-detector.js";
import {
  TeamRuntimeCapabilityBudgetPort,
  isTeamRuntimeEngineCapabilityMetered,
} from "./capability-budget-port.js";
import {
  beginDiscussionContinuation,
} from "../core/discussion-continuation-control.js";
import {
  planChainRecovery,
  planStageRecovery,
  stageRecoveryChanged,
} from "./stage-recovery.js";
import {
  runDiscussionAutostart,
  type DiscussionAutostartPorts,
  type DiscussionCoordinatorCallPorts,
} from "./discussion-autostart.js";
import {
  PIPELINE_GOVERNED_PI_TOOL_NAMES,
} from "./governed-pi-tools.js";
import {
  ENGINE_TOOL_CAPABILITY_IDS,
} from "../services/engine-capability-adapter.js";
import { requireTeamRuntimeCapabilityIdentity } from "./runtime-capability-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultColors = [36, 178, 71, 168, 39, 208, 82, 141, 63, 215];
const TEAM_RUNTIME_AUTOSTART_SOURCE = {
  kind: "engine" as const,
  id: "team-runtime:runtime-autostart",
  version: "1",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function colorForIndex(index: number): number {
  const color = defaultColors[index % defaultColors.length];
  if (color === undefined) throw new Error("No default agent color is available");
  return color;
}

function resolveTeamRuntimeRepoRoot(moduleDir: string): string {
  const parent = path.resolve(moduleDir, "..");
  return path.basename(parent) === "dist-electron"
    ? path.dirname(parent)
    : parent;
}

function loadHumanInputRouting(
  ctx: ReturnType<typeof createRuntimeContext>,
) {
  const configuredPath = process.env.TEAM_HUMAN_INPUT_ROUTING_FILE?.trim()
  if (!configuredPath) return undefined
  const assignmentPath = path.resolve(getAssignmentPath(ctx))
  const routingPath = path.resolve(configuredPath)
  const relative = path.relative(assignmentPath, routingPath).split(path.sep).join('/')
  const containedPath = resolveRelativePathInside(assignmentPath, relative)
  if (!containedPath || containedPath !== routingPath) {
    console.error('[team-runtime] Ignoring human-input routing file outside the assignment.')
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(routingPath, 'utf8'))
    if (isHumanInputRoutingContext(parsed)) return parsed
    console.error('[team-runtime] Ignoring invalid human-input routing context.')
  } catch (error) {
    console.error(
      '[team-runtime] Failed to load human-input routing context:',
      error instanceof Error ? error.message : String(error),
    )
  }
  return undefined
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

let globalErrorBoundariesInstalled = false;

/**
 * Keep a stray rejection or throw from taking the Pi host process down.
 *
 * Once for the process, not once per extension. These two handlers are
 * identical for every runtime and name no run, so a second copy changes no
 * behaviour — but a host that loads a session per run would gain a pair every
 * time, and past ten of them Node starts reporting a leak it is right about.
 */
function ensureGlobalErrorBoundaries(): void {
  if (globalErrorBoundariesInstalled) return;
  globalErrorBoundariesInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(`[team-runtime] Unhandled rejection: ${message}`);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[team-runtime] Uncaught exception: ${err.message}`);
    console.error(err.stack);
  });
}

export default function teamRuntimeExtension(pi: ExtensionAPI): void {
  loadDotEnv();
  initProviders();
  const runtimeFaultInjection = process.env.TEAM_RUNTIME_FAULT_INJECT;

  ensureGlobalErrorBoundaries();

  /**
   * This host process, for the life of this process.
   *
   * Not the run and not the session: both survive a recovery, which is exactly
   * the case that needs distinguishing. Generated rather than derived from the
   * environment so a relaunch with identical settings still differs.
   */
  const hostInstanceId = randomUUID();
  const ctx = createRuntimeContext(pi);
  // Passed rather than re-read, so the fault-injection variable keeps the
  // single read site above and its named values stay auditable in one place.
  if (runtimeFaultInjection) ctx.faultInjection = runtimeFaultInjection;
  // Who decides this process may stop.
  //
  // A launched Team host is a Pi print-mode run, and print mode's lifetime is
  // exactly the prompts it awaits. The run's own work does not fit that shape:
  // its opening entry is queued rather than prompted, and each later level is
  // entered by another entry queued while the previous turn settles. The
  // `team-host-run` command below holds Pi's one awaited prompt open until this
  // says nothing is owed.
  ctx.hostRunLifetime = new HostRunLifetime({
    work: {
      pendingEntryCount: () => ctx.pendingFollowUps.length,
      turnInFlight: () => ctx.outerTurnOwner !== null,
    },
    clock: {
      setTimeout: (handler, delayMs) => {
        const timer = setTimeout(handler, delayMs);
        return { cancel: () => clearTimeout(timer) };
      },
    },
    // A referenced timer that does nothing, which is the whole point: it is
    // the only work this process has while it waits for a queued entry's
    // wake-up, and without it Node would end the run between turns.
    keepAlive: () => {
      const held = setInterval(() => {}, HOST_KEEP_ALIVE_INTERVAL_MS);
      return { release: () => clearInterval(held) };
    },
    startDeadlineMs: HOST_ENTRY_START_DEADLINE_MS,
  });
  const fileParserLauncher = coordinateFileParserLauncher(
    resolveRuntimeFileParserLauncher({
      defaultRepoRootPath: resolveTeamRuntimeRepoRoot(__dirname),
      timeoutMs: 120_000,
    }),
  );
  const devServices = createManagedDevServices();
  // Named, and given back at `session_shutdown`. An anonymous listener here is
  // one more exit callback per run for the life of the host, each one holding
  // a dev-services instance whose session has already ended.
  const stopDevServicesAtExit = (): void => devServices.stopSync();
  process.once("exit", stopDevServicesAtExit);
  // The run's own Pi agent directory, when the launcher gave this process one.
  //
  // Registered only on proof of ownership, so a host that was never given a
  // directory installs nothing at all, and the proof is copied rather than
  // re-read later — a `PI_CODING_AGENT_DIR` the user set for themselves is
  // never a candidate either way.
  const ownedPiAgentDirectory = captureOwnedPiAgentDirectoryProof(process.env);
  if (ownedPiAgentDirectory) {
    registerOwnedPiAgentDirectoryExitCleanup(ownedPiAgentDirectory);
  }
  // Kept, not discarded. The observer lives in a module-global subscriber set
  // (`domains/runtime/runtime-events.ts:19-22`), so an extension that never
  // unsubscribes leaves a callback holding this `ctx` and its UI pane for the
  // life of the process — still rendering, and still re-arming the refresh
  // interval, long after the run it belongs to has finished.
  const disposeDashboardObserver = installDashboardObserver(ctx);
  const toolErrorMessages = new Map<string, string>();
  const suppressToolFailureFollowUpCallIds = new Set<string>();
  const runCompletion = new DeferredRunCompletion();
  let waitingForAgentAnswer = false;
  /**
   * This process did not take ownership of the recovery snapshot it found.
   *
   * Either it could not read that snapshot whole, or it read it and refused to
   * act on what it said. Read by `persistState`: a process that will not resume
   * a run must not rewrite the record it would not resume, or the refusal lasts
   * exactly one restart and the one after it replays whatever the record was
   * protecting.
   *
   * Raised *before* the restore rather than after it, and lowered only once the
   * whole snapshot has been accepted. The restore validates hard enough to
   * throw — a malformed nested engine state raises out of
   * `restoreLevelStatesFromCheckpoint` — and a flag set afterwards is a flag
   * that is never set on exactly the path that needs it.
   */
  let recoverySnapshotRefused = false;
  let incompleteRunLogged = false;
  let runTerminalFailureLogged = false;
  let shutdownRegistration: ShutdownRegistration | null = null;
  const runtimeExtensionPath = path.resolve(fileURLToPath(import.meta.url));
  const capabilityBypassDetector = new TeamRuntimeCapabilityBypassDetector({
    isGovernedRegistrationActive: (toolName) => {
      const activeTool = pi.getAllTools().find((tool) => tool.name === toolName);
      return activeTool !== undefined &&
        path.resolve(activeTool.sourceInfo.path) === runtimeExtensionPath;
    },
  });
  const capabilityPolicy = new TeamRuntimeCapabilityPolicy({
    getSnapshot: () => {
      const level = getCurrentLevel();
      const coordinator = getCurrentCoordinator();
      const levelAllowedTools = getAllowedLevelTools();
      return {
        ...(level ? { levelId: level.id } : {}),
        coordinatorRunId: ctx.coordinatorRunId,
        levelAdvancedCoordinatorRunId: ctx.levelAdvancedCoordinatorRunId,
        ...(coordinator
          ? {
              coordinator: {
                name: coordinator.name,
                ...whenDefined(
                  resolveCoordinatorAllowedTools(
                    coordinator.tools,
                    levelAllowedTools,
                    getGrantedGovernedPiTools(),
                  ),
                  (allowedTools) => ({ allowedTools }),
                ),
              },
            }
          : {}),
        levelAllowedTools,
        engineTools: ctx.ENGINE_TOOLS,
        usedLevelToolsThisCoordinatorTurn:
          ctx.usedLevelToolsThisCoordinatorTurn,
      };
    },
    trustedRuntimeSource: TEAM_RUNTIME_AUTOSTART_SOURCE,
    onDenied: ({ invocation, toolName, decision }) =>
      recordRefusedToolCall({
        gate: "blocked_by_capability_policy",
        toolName,
        toolCallId: invocation.toolCallId,
        code: decision.code,
        reason: decision.reason,
      }),
  });

  /**
   * Write the durable record of a refused tool call.
   *
   * One path for every gate that refuses inside a dispatch, because a reader is
   * owed the same thing from each: a flag saying the call was blocked rather
   * than broken, and the code that selects the sentence they are shown
   * (`contracts/capability-policy-denial.ts`). A gate that wrote no record at
   * all reached the timeline through the failure arm instead — "failed using
   * tool bash", in the error accent, with the reason thrown away.
   */
  function recordRefusedToolCall(input: {
    readonly gate: "blocked_by_capability_policy" | "blocked_tool_safety";
    readonly toolName: string;
    readonly toolCallId: string;
    readonly code: string;
    readonly reason: string;
  }): void {
    if (!ctx.teamConfig || ctx.blockedToolCallIds.has(input.toolCallId)) {
      return;
    }
    const outputDir = getAssignmentPath(ctx);
    const deniedAttribution = owningTurnAttribution();
    logToolUse(
      outputDir,
      input.toolName,
      input.toolCallId,
      true,
      ctx.state.rootSessionId,
      {
        [input.gate]: true,
        policy_code: input.code,
        // A refusal is an observation about the turn that asked, so it names
        // that turn's coordinator and level however far the level index has
        // since moved. `current_level` stays live beside them: where the
        // runtime stands is what the gate was reasoning about.
        agent_name: deniedAttribution.coordinator,
        level_id: deniedAttribution.level_id,
        current_level: getCurrentLevel()?.id ?? null,
        reason: input.reason,
      },
    );
    ctx.blockedToolCallIds.add(input.toolCallId);
    suppressToolFailureFollowUpCallIds.add(input.toolCallId);
  }
  let capabilityDispatcher: CapabilityDispatcher | undefined;
  let capabilityBudgetPort: TeamRuntimeCapabilityBudgetPort | undefined;
  let capabilityEvidenceWriter: AssignmentCapabilityEvidenceWriter | undefined;
  let capabilityAssignmentPath: string | undefined;
  let executionJournalRegistry: WorkspaceExecutionJournalRegistry | undefined;

  function runtimeCapabilityIdentity(): {
    readonly sessionId: string;
    readonly runId: string;
    readonly assignmentId: string;
    readonly taskId: string;
    readonly processIdentity: string;
  } {
    return requireTeamRuntimeCapabilityIdentity({
      location: ctx.assignmentLocation,
      runtimeSessionId: ctx.state.sessionId,
      environment: process.env,
    });
  }

  function buildCapabilityExecutionContext(): CapabilityExecutionContext {
    const identity = runtimeCapabilityIdentity();
    const coordinator = getCurrentCoordinator();
    const workflowStepId = process.env.TEAM_RUNTIME_WORKFLOW_STEP_ID?.trim();
    return {
      contractVersion: 1,
      requestId: `team-runtime-${randomUUID()}`,
      sessionId: identity.sessionId,
      runId: identity.runId,
      assignmentId: identity.assignmentId,
      taskId: identity.taskId,
      agentPath: coordinator ? `agents/${coordinator.name}` : "runtime",
      authority: {
        kind: "runtime-assignment",
        processIdentity: identity.processIdentity,
      },
      ...(coordinator ? { agentDisplayName: coordinator.name } : {}),
      ...(workflowStepId ? { workflowStepId } : {}),
    };
  }

  function authorizeRuntimeCapability(input: {
    readonly context: CapabilityExecutionContext;
  }): CapabilityPolicyDecision {
    try {
      const expected = buildCapabilityExecutionContext();
      return input.context.sessionId === expected.sessionId &&
        input.context.runId === expected.runId &&
        input.context.assignmentId === expected.assignmentId &&
        input.context.taskId === expected.taskId &&
        input.context.agentPath === expected.agentPath &&
        input.context.authority.kind === "runtime-assignment" &&
        expected.authority.kind === "runtime-assignment" &&
        input.context.authority.processIdentity ===
          expected.authority.processIdentity
        ? { kind: "allow" }
        : {
            kind: "deny",
            code: "runtime_assignment_invalid",
            reason: "The Team Runtime assignment authority changed.",
          };
    } catch {
      return {
        kind: "deny",
        code: "runtime_assignment_unavailable",
        reason: "The Team Runtime assignment authority is unavailable.",
      };
    }
  }

  function ensureCapabilityDispatcher(): CapabilityDispatcher {
    const assignmentPath = path.resolve(getAssignmentPath(ctx));
    if (capabilityDispatcher && capabilityAssignmentPath === assignmentPath) {
      return capabilityDispatcher;
    }
    void capabilityEvidenceWriter?.close().catch(() => undefined);
    const identity = runtimeCapabilityIdentity();
    // Fail-closed invariant: governed dispatch requires the durable journal
    // authority opened at the session_start startup boundary. An absent
    // registry means an unmanaged runtime reached dispatch registration,
    // which must fail rather than fall back to the legacy authority.
    const journalRegistry = executionJournalRegistry;
    if (!journalRegistry) {
      throw new Error(
        "Team Runtime capability dispatch requires the execution journal " +
          "registry, but the durable journal startup boundary did not run.",
      );
    }
    const ports = createTeamRuntimeCapabilityDispatcher({
      assignmentPath,
      sessionId: identity.sessionId,
      runId: identity.runId,
      assignmentId: identity.assignmentId,
      authority: {
        authorize: async (input) => authorizeRuntimeCapability(input),
      },
      policy: capabilityPolicy,
      budget: {
        ledger: ctx.budgetLedger,
        readTotalCostUsd: () => ctx.state.totalCost,
        isMetered: isTeamRuntimeEngineCapabilityMetered,
      },
      clock: { now: Date.now },
      ids: { nextAttemptId: () => `team-runtime-attempt-${randomUUID()}` },
      durable: (input) => journalRegistry.resolve(input),
    });
    capabilityEvidenceWriter = ports.evidenceWriter;
    capabilityBudgetPort = ports.budgetPort;
    capabilityDispatcher = ports.dispatcher;
    capabilityAssignmentPath = assignmentPath;
    return capabilityDispatcher;
  }

  // ── Boot: resolve start.yaml / teams.yaml / per-team team.yaml ──

  function resolveBootConfigPath(cwd: string): {
    configPath?: string;
    errors: string[];
    startPath?: string;
    entry?: TeamRegistryEntry;
  } {
    const explicitConfigPath = process.env.TEAM_CONFIG_PATH;
    if (explicitConfigPath) {
      if (fs.existsSync(explicitConfigPath)) {
        return { configPath: path.resolve(explicitConfigPath), errors: [] };
      }
      return {
        errors: [
          `Explicit team config path does not exist: ${explicitConfigPath}`,
        ],
      };
    }

    const errors: string[] = [];
    const startCandidates = [
      path.join(cwd, "start.yaml"),
      path.join(cwd, ".pi", "start.yaml"),
    ];

    let startPath: string | undefined;
    for (const candidate of startCandidates) {
      if (fs.existsSync(candidate)) {
        startPath = candidate;
        break;
      }
    }

    if (!startPath) {
      const legacyCandidates = [
        path.join(cwd, "team.yaml"),
        path.join(cwd, ".pi", "team.yaml"),
      ];
      for (const candidate of legacyCandidates) {
        if (fs.existsSync(candidate)) {
          return { configPath: candidate, errors: [] };
        }
      }
      return { errors: [] };
    }

    const startResult = parseStartConfig(startPath);
    if (!startResult.config) {
      return { errors: startResult.errors, startPath };
    }

    const startDir = path.dirname(path.resolve(startPath));
    const registryPath =
      startResult.config.registry ??
      [
        path.join(startDir, "teams.yaml"),
        path.join(startDir, ".pi", "teams.yaml"),
      ].find((candidate) => fs.existsSync(candidate));

    if (!registryPath) {
      return {
        errors: [
          `Cannot resolve teams registry for ${startPath}. Add 'registry:' or colocate teams.yaml.`,
        ],
        startPath,
      };
    }

    const registryResult = parseTeamRegistry(registryPath);
    if (registryResult.errors.length > 0) {
      return { errors: registryResult.errors, startPath };
    }

    const startEntryName = startResult.config.entry;
    const entry = registryResult.entries.find(
      (candidate) => candidate.name === startEntryName,
    );
    if (!entry) {
      return {
        errors: [
          `Start entry '${startResult.config.entry}' was not found in ${registryPath}`,
        ],
        startPath,
      };
    }

    if (entry.type !== "team") {
      return {
        errors: [
          `Start entry '${entry.name}' must be type 'team', got '${entry.type}'`,
        ],
        startPath,
      };
    }

    const teamPath = entry.team_path;
    const teamCandidates =
      fs.existsSync(teamPath) && fs.statSync(teamPath).isDirectory()
        ? [
            path.join(teamPath, "team.yaml"),
            path.join(teamPath, ".pi", "team.yaml"),
          ]
        : [teamPath];

    for (const candidate of teamCandidates) {
      if (fs.existsSync(candidate)) {
        return { configPath: candidate, errors: [], startPath, entry };
      }
    }

    return {
      errors: [
        `Start entry '${entry.name}' does not resolve to a bootable team config under ${teamPath}`,
      ],
      startPath,
    };
  }

  async function boot(cwd: string): Promise<boolean> {
    ctx.configErrors = [];
    ctx.bootEntry = null;
    delete ctx.assignmentLocation;
    const bootResolution = resolveBootConfigPath(cwd);
    const configSource = bootConfigSource(bootResolution);
    if (configSource.kind === "refused") {
      ctx.configErrors = configSource.errors;
      return false;
    }
    if (configSource.kind === "setup") {
      ctx.setupMode = true;
      return false;
    }
    const configPath = configSource.configPath;

    const result = parseTeamConfig(configPath);
    if (!result.config) {
      ctx.configErrors = result.errors;
      return false;
    }

    // The environment values are read here, where reading cannot fail or change
    // anything. The plan decides from them, and the checks below apply its
    // decisions in order.
    const plan = resolveTeamBoot({
      config: result.config,
      warnings: result.warnings,
      resolvedEntry: bootResolution.entry,
      env: {
        configOverridesJson: process.env.TEAM_CONFIG_OVERRIDES_JSON,
        bootEntryJson: process.env.TEAM_BOOT_ENTRY_JSON,
        budgetCap: process.env.TEAM_BUDGET_CAP,
        budgetPolicy: process.env.TEAM_BUDGET_POLICY,
      },
    });

    // A team still being assembled is not one this runtime can run: it has no
    // roster yet, and its completion gate names an artifact no agent produces.
    // Every caller-side guard refuses one before starting a process, and none
    // of them is on this path — `TEAM_CONFIG_PATH` points straight here. So the
    // app refuses on its own behalf, with the reason the user needs, instead of
    // starting and failing somewhere they cannot read.
    if (plan.buildingRefusal) {
      ctx.configErrors = plan.buildingRefusal;
      return false;
    }

    const workspacePathOverride = process.env.TEAM_WORKSPACE_PATH;
    if (workspacePathOverride) {
      result.config.workspace.path = workspacePathOverride;
    }

    try {
      const assignmentLocation = resolveRuntimeAssignmentLocation(
        result.config.workspace.path,
      );
      if (assignmentLocation) ctx.assignmentLocation = assignmentLocation;
      else delete ctx.assignmentLocation;
    } catch (error) {
      ctx.configErrors = assignmentLocationRefusal(error);
      return false;
    }

    if (plan.runtimeOverrides.kind === "invalid") {
      ctx.configErrors = plan.runtimeOverrides.errors;
      return false;
    }
    if (plan.runtimeOverrides.kind === "overrides") {
      const overrideErrors = applyTeamRuntimeOverrides(
        result.config,
        plan.runtimeOverrides.overrides,
      );
      if (overrideErrors.length > 0) {
        ctx.configErrors = overrideErrors;
        return false;
      }
    }

    if (plan.bootEntry.kind === "invalid") {
      ctx.configErrors = plan.bootEntry.errors;
      return false;
    }
    if (plan.bootEntry.kind === "entry") {
      ctx.bootEntry = plan.bootEntry.entry;
    }

    for (const line of plan.warningLines) {
      console.warn(line);
    }

    ctx.teamConfig = result.config;
    ctx.bootEntry = plan.resolvedBootEntry;
    if (result.config.rateLimiting) {
      ctx.rateLimiter = new RateLimiter(result.config.rateLimiting);
    }

    // B4: Initialize budget ledger
    // Priority: parent cap > team cap > spawn limit > finite advisory default.
    if (plan.budget) {
      ctx.budgetLedger = new BudgetLedger({
        capUsd: plan.budget.capUsd,
        policy: plan.budget.policy,
      });
    } else {
      delete ctx.budgetLedger;
    }

    ctx.teamRoot = bootResolution.startPath
      ? path.dirname(path.resolve(bootResolution.startPath))
      : path.dirname(path.resolve(configPath));

    // Auto-parse binary input files if needed, then load
    const inputDir = path.join(ctx.teamRoot, "input-files");
    await ensureParsed(inputDir, fileParserLauncher);
    ctx.inputFilesContent = loadInputFiles(inputDir);
    const humanInputRouting = loadHumanInputRouting(ctx);
    if (humanInputRouting) ctx.humanInputRouting = humanInputRouting;
    else delete ctx.humanInputRouting;

    // Load all agents
    ctx.agents.clear();
    ctx.agentMetrics.clear();
    ctx.rosterEntries.clear();
    ctx.teamRegistry.clear();
    ctx.workflowRegistry.clear();

    for (const entry of ctx.teamConfig.composition?.registry_entries ?? []) {
      ctx.teamRegistry.set(entry.name, entry);
    }

    const workflowRegistryPath = path.join(
      ctx.teamRoot,
      "workflows",
      "registry.yaml",
    );
    if (fs.existsSync(workflowRegistryPath)) {
      const workflowRegistry = parseWorkflowRegistry(workflowRegistryPath);
      if (workflowRegistry.errors.length > 0) {
        ctx.configErrors.push(...workflowRegistry.errors);
        return false;
      }
      for (const warning of workflowRegistry.warnings) {
        console.warn(`[workflow-registry] ${warning}`);
      }
      for (const entry of workflowRegistry.entries) {
        ctx.workflowRegistry.set(entry.name, entry);
      }
    }

    for (let i = 0; i < ctx.teamConfig.agents.length; i++) {
      const entry = ctx.teamConfig.agents[i];
      if (!entry) continue;
      ctx.rosterEntries.set(entry.name, toRosterEntrySlim(entry));
      const loaded = loadAgent(
        entry,
        ctx.teamConfig,
        colorForIndex(i),
      );
      if (loaded) {
        ctx.agents.set(loaded.name, loaded);
        ctx.agentMetrics.set(loaded.name, initialAgentMetrics(loaded));
      }
    }

    const autoRegisteredTeams = getAutoRegisteredTeamEntries(
      ctx.teamConfig,
      ctx.teamRegistry,
    );
    for (let i = 0; i < autoRegisteredTeams.length; i++) {
      const entry = autoRegisteredTeams[i];
      if (!entry) continue;
      ctx.rosterEntries.set(entry.name, toRosterEntrySlim(entry));
      const loaded = loadAgent(
        entry,
        ctx.teamConfig,
        colorForIndex(ctx.agents.size + i),
      );
      if (loaded) {
        ctx.agents.set(loaded.name, loaded);
        ctx.agentMetrics.set(loaded.name, initialAgentMetrics(loaded));
      }
    }

    const entryLevelIndex = resolveEntryLevelIndex(
      ctx.teamConfig.levels,
      ctx.teamConfig.workflow?.entry_level,
    );
    ctx.state.currentLevelIndex = entryLevelIndex;

    ctx.configErrors.push(...validateLoadedAgentProviders(ctx.agents.values()));
    // Before any host model is resolved: a level whose declared coordinator
    // never loaded has no owner, and resolving a host pair for it would pick
    // one nobody chose.
    ctx.configErrors.push(
      ...validateDeclaredCoordinators({
        levels: ctx.teamConfig.levels,
        loadedAgentNames: new Set(ctx.agents.keys()),
        personaPathFor: (agentName) =>
          ctx.teamConfig?.agents.find((entry) => entry.name === agentName)
            ?.agent_file,
      }),
    );
    const entryLevel = ctx.teamConfig.levels[entryLevelIndex];
    if (!shouldRuntimeAutostartLevel(entryLevel, process.env)) {
      const desiredHost = resolveDesiredHostModel(
        ctx.bootEntry,
        getCurrentCoordinator(),
      );
      if (desiredHost) {
        ctx.configErrors.push(
          ...validateHostProviderReadiness(
            desiredHost.provider,
            desiredHost.model,
          ),
        );
      }
    }
    if (ctx.configErrors.length > 0) {
      return false;
    }

    // Initialize level states
    for (const [levelId, levelState] of pendingLevelStates(ctx.teamConfig.levels)) {
      ctx.state.levelStates.set(levelId, levelState);
    }

    // Mark the declared workflow entry (or the first level by default) active.
    const activation = entryLevelActivation(
      ctx.teamConfig.levels,
      entryLevelIndex,
    );
    if (activation) {
      const ls = ctx.state.levelStates.get(activation.levelId);
      if (ls) {
        ls.status = activation.status;
        ls.stageStatus = activation.stageStatus;
      }
    }

    return true;
  }

  // ── Current level helpers ──

  function getCurrentLevel(): LevelConfig | undefined {
    if (!ctx.teamConfig) return undefined;
    return ctx.teamConfig.levels[ctx.state.currentLevelIndex];
  }

  function getCurrentCoordinator() {
    const level = getCurrentLevel();
    if (!level) return undefined;
    const coordName = level.stage.coordinator;
    return coordName ? ctx.agents.get(coordName) : undefined;
  }

  /**
   * The governed Pi file tools this level's coordinator was granted.
   *
   * The persona's `tools:` list is the whole grant, and this is the one place
   * it is read. Registration (`registerLevelTools`) and authorization (the
   * capability policy snapshot) both ask here, so a tool cannot be registered
   * under a permission the policy will not honour.
   */
  function getGrantedGovernedPiTools(): string[] {
    return resolveGrantedGovernedFileTools(getCurrentCoordinator()?.tools);
  }

  function getAllowedLevelTools(): Set<string> {
    const level = getCurrentLevel();
    return resolveLevelAllowedTools({
      ...whenDefined(level?.stage.type, (stageType) => ({ stageType })),
      spawnTeams: level?.permissions?.spawn_teams === true,
      hasWorkflows: ctx.workflowRegistry.size > 0,
      alwaysAllowed: [STANDALONE_SKILL_LOADER_TOOL_NAME],
    });
  }

  // ── Register tools for current level ──

  function registerLevelTools(): void {
    if (!ctx.teamConfig || !ctx.state.sessionId) return;
    const level = getCurrentLevel();
    if (!level) return;

    armLevelTools(
      {
        teamConfig: ctx.teamConfig,
        level,
        outputPath: getAssignmentPath(ctx),
        runtimeSource: TEAM_RUNTIME_AUTOSTART_SOURCE,
      },
      makeLevelToolPorts(),
    );
  }

  /**
   * The ports `armLevelTools` calls. Building them reads no runtime value;
   * each one reads `ctx`, the capability layer or the environment when it is
   * called.
   */
  function makeLevelToolPorts(): LevelToolPorts {
    return {
      registrar: {
        registerTool: (definition) => {
          ctx.pi.registerTool(definition);
        },
        setActiveTools: (toolNames) => {
          ctx.pi.setActiveTools(toolNames);
        },
      },
      capabilities: {
        ensureDispatcher: () => ({
          dispatcher: ensureCapabilityDispatcher(),
          budgetAdoptionScope: capabilityBudgetPort,
        }),
        clearPolicyRegistrations: () => {
          capabilityPolicy.clearRegistrations();
        },
        registerPolicy: (registration) => {
          capabilityPolicy.register(registration);
        },
        replaceGovernedTools: (toolNames) => {
          capabilityBypassDetector.replaceGovernedTools(toolNames);
        },
        recordRawToolError: (toolCallId, message) => {
          toolErrorMessages.set(toolCallId, message);
        },
        recordRefusedToolCall,
        buildExecutionContext: buildCapabilityExecutionContext,
      },
      publishCurrentTools: (registeredTools, toolInvokers) => {
        ctx.currentRegisteredTools = registeredTools;
        ctx.currentToolInvokers = toolInvokers;
      },
      engineContext: () => ({
        teamRegistry: ctx.teamRegistry,
        teamRootPath: ctx.teamRoot,
        activeSpawnCountRef: {
          get count() {
            return ctx.activeSpawnCount;
          },
          set count(value: number) {
            ctx.activeSpawnCount = value;
          },
        },
        agents: ctx.agents,
        rosterEntries: ctx.rosterEntries,
        state: ctx.state,
        inputFilesContent: ctx.inputFilesContent,
        agentMetrics: ctx.agentMetrics,
        shutdownSignal: ctx.shutdownController.signal,
        recoveryMode: process.env.TEAM_RUNTIME_RECOVERY === "1",
        delegatedAutostart: process.env.TEAM_DELEGATED_AUTOSTART === "1",
        humanQuestions: Boolean(process.env[MCP_WORKER_TURN_URL_ENV]?.trim()),
        chatMode: process.env.TEAM_CHAT_MODE === "1",
        getCurrentCoordinatorRunId: () => ctx.coordinatorRunId,
        setDelegationStatus: (delegationId, snapshot) => {
          if (snapshot) ctx.activeDelegations.set(delegationId, snapshot);
          else ctx.activeDelegations.delete(delegationId);
        },
        onDashboardUpdate: () => {
          if (ctx.lastCtx) updateDashboard(ctx.lastCtx, ctx);
        },
        onStateCheckpoint: persistState,
        ...whenDefined(ctx.assignmentLocation, (assignmentLocation) => ({ assignmentLocation })),
        ...whenDefined(ctx.humanInputRouting, (humanInputRouting) => ({ humanInputRouting })),
        ...whenDefined(ctx.rateLimiter, (rateLimiter) => ({ rateLimiter })),
        ...whenDefined(ctx.budgetLedger, (budgetLedger) => ({ budgetLedger })),
        ...whenDefined(getCurrentCoordinator()?.name, (coordinatorName) => ({ coordinatorName })),
      }),
      live: {
        sessionId: () => ctx.state.sessionId,
        rootSessionId: () => ctx.state.rootSessionId,
        currentCoordinatorName: () => getCurrentCoordinator()?.name,
        totalCostUsd: () => ctx.state.totalCost,
      },
      lookups: {
        workflowRegistry: () => ctx.workflowRegistry,
        repoRoot: () => resolveTeamRuntimeRepoRoot(__dirname),
        grantedGovernedPiTools: getGrantedGovernedPiTools,
        allowedLevelTools: getAllowedLevelTools,
      },
    };
  }

  /**
   * Put the host on the active level's pair and arm that level's stage.
   *
   * A level is owed three acts before it is asked to work — switch, arm, then
   * send — and this performs the first two. It is the only place they happen,
   * so a level cannot be prepared one way by a gate and another way by a
   * command.
   *
   * @returns false when the host could not be put on the level's pair. Nothing
   *   may then be sent: the caller fails closed, and `input` turns the next
   *   prompt away rather than spending a host request on a level nobody armed.
   */
  async function enterActiveLevelOnItsOwnPair(
    extCtx: ExtensionContext,
  ): Promise<boolean> {
    const hostModelReady = await applyHostModelPreference(pi, extCtx, ctx);
    if (!hostModelReady) {
      enterConfigErrorMode(extCtx);
      updateDashboard(extCtx, ctx);
      return false;
    }
    // The disclosure belongs here, with the switch, and not at whichever caller
    // happened to reach it. Written before the stage is armed and before
    // anything is sent, so a run can always say which pair each level was
    // entered on — once per entry, however the transition arrived.
    logHostLifecycleEvent(
      "host.model_selection.resolved",
      {
        resolved_host_provider: extCtx.model?.provider ?? null,
        resolved_host_model: extCtx.model?.id ?? null,
      },
      // About the level being entered, not about the turn that is handing over.
      // At a settle the outgoing turn is still held, and attributing this to it
      // would say the previous level resolved a pair it never used.
      { attributeTo: "current-position" },
    );
    activatePendingStageEntryIfNeeded();
    return true;
  }

  /**
   * Prepare the level a transition has just moved to.
   *
   * A turn in flight defers: `agent_settled` will do it, and doing it now would
   * move the host out from under the coordinator still using it. With no turn
   * in flight there is no settle coming — Pi runs a registered command
   * "immediately, even during streaming"
   * (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:785`), which
   * includes at an idle prompt — so the transition prepares the level itself.
   */
  async function prepareHostForActiveLevel(
    extCtx: ExtensionContext,
  ): Promise<boolean> {
    if (ctx.outerTurnOwner) return true;
    return enterActiveLevelOnItsOwnPair(extCtx);
  }

  /**
   * The attribution fields a tool record shares with the host lifecycle log.
   *
   * Taken from the turn that is running, or from the current position when no
   * turn owns the loop. This is observability only: authorization, follow-up
   * routing and gate advancement all keep reading the live level, because those
   * are decisions about what may happen next rather than statements about what
   * already happened.
   */
  function owningTurnAttribution(): {
    level_id: string | null
    stage_type: string | null
    coordinator: string | null
    coordinator_run_id: number
  } {
    const owner = ctx.outerTurnOwner;
    if (owner) {
      return {
        level_id: owner.levelId,
        stage_type: owner.stageType,
        coordinator: owner.coordinatorName,
        coordinator_run_id: owner.coordinatorRunId,
      };
    }
    return {
      level_id: getCurrentLevel()?.id ?? null,
      stage_type: getCurrentLevel()?.stage.type ?? null,
      coordinator: getCurrentCoordinator()?.name ?? null,
      coordinator_run_id: ctx.coordinatorRunId,
    };
  }

  /**
   * What the host did when it stopped.
   *
   * Only one of the four outcomes is a failure this process alone can see.
   * `no_work_remains` is a finished run; `run_failed` already wrote its own
   * terminal record before releasing the host; `abandoned` is a teardown that
   * is already reporting itself. `entry_never_started` is the exception: Pi
   * accepted an entry, rejected it asynchronously on its own error channel, and
   * nothing else will ever say so. The reason is a fixed word from a closed
   * set, never text from outside this process.
   */
  function reportHostRunStop(stop: HostRunStop): void {
    const level = getCurrentLevel();
    const levelName = level?.id ?? "unknown";
    // Two failures this process alone can see, and nothing else will record.
    const error =
      stop.reason === "entry_never_started"
        ? `Level '${levelName}' was entered but never started a turn. ` +
          `Team execution is blocked.`
        : stop.reason === "entry_never_dispatched"
          ? `Level '${levelName}' could not be entered at all: its opening ` +
            `message was never handed to the host. Team execution is blocked.`
          : null;
    if (error === null) return;
    const outputDir = getAssignmentOutputDir();
    if (!outputDir) return;
    requestRunFailure({
      assignmentPath: outputDir,
      levelId: level?.id ?? "",
      stageType: level?.stage.type ?? "",
      error,
    });
  }

  /**
   * What a restored host-entry admission lets this process do.
   *
   * The record is written before a stage entry is handed to Pi and never after,
   * because `sendUserMessage` returns `void` and its refusal arrives on Pi's
   * own error channel — after the call there is nothing left to learn. So the
   * three states answer three different questions, and only one of them
   * authorises a dispatch.
   *
   * `dispatching` reduces to indeterminate, the same reduction this repository
   * already applies to a governed dispatch that reached its start barrier with
   * no terminal record (`core/durable-dispatch.ts:82`). The entry may have
   * started a coordinator turn that called tools, published messages and
   * charged a model, or it may never have left. Nothing durable distinguishes
   * those, so the run stays interrupted rather than being replayed, marked
   * failed, or reported complete. The desktop already reads a run with no
   * terminal event as interrupted, which is what this run is.
   *
   * @returns false when the host must not continue starting this run.
   */
  /**
   * What a restored host-entry admission lets this process do.
   *
   * The rule itself is pure and lives with the record
   * (`contracts/host-entry-admission.ts`), because it has to be right in every
   * combination of state and position and that is far cheaper to establish
   * without a process. This is the part that needs one: what each answer
   * actually does to the run.
   *
   * @returns false when the host must not continue starting this run.
   */
  function resumeRestoredHostEntry(
    extCtx: ExtensionContext,
    restored: ReturnType<typeof readHostEntryAdmission>,
  ): boolean {
    const level = getCurrentLevel();
    // The admitted level's own recorded state, looked up by id. The position
    // above is an index into whatever level list this process booted with, so
    // it cannot distinguish "the run moved on" from "the level list changed
    // under the saved index"; this can, because it is keyed by the identity the
    // admission actually names.
    const admittedLevelState = restored.kind === "admission"
      ? ctx.state.levelStates.get(restored.admission.levelId)
      : undefined;
    const decision = decideHostEntryResume(restored, {
      levelId: level?.id,
      visit: level ? ctx.state.levelStates.get(level.id)?.visitCount ?? 0 : 0,
      ...whenDefined(admittedLevelState, (admitted) => ({
        admittedLevel: {
          completed: admitted.status === LEVEL_STATUS.COMPLETED,
          visit: admitted.visitCount ?? 0,
        },
      })),
    });

    switch (decision) {
      case "start":
      case "resume":
        return true;

      case "discard_stale":
        // Not ambiguous and not a refusal: the run has moved on, so the record
        // describes work that is over. Cleared here because nothing later would
        // — no settle, no transition and no discard is coming for a level the
        // run will not return to — and a record nothing clears would refuse
        // every restart from now on.
        discardHostEntry(ctx);
        return true;

      case "refuse_changed_definition": {
        // The run booted somewhere other than the level its saved entry names,
        // and that level's own record does not say it finished. The position a
        // checkpoint restores is an index, so this is what an edited `team.yaml`
        // looks like from here — and dispatching whatever now sits at that index
        // would run a level in place of the one that was interrupted.
        //
        // Nothing is discarded. The record is the only account of what this run
        // was doing, and a definition that changed under it is for a person to
        // resolve, not for this process to resolve by forgetting.
        const admission =
          restored.kind === "admission" ? restored.admission : undefined;
        const message =
          `This run was interrupted on level '${admission?.levelId ?? "unknown"}', ` +
          "which is not where the saved position now points and is not recorded " +
          "as finished. The team definition may have changed since the run " +
          "started. Team execution is blocked.";
        recoverySnapshotRefused = true;
        logHostLifecycleEvent(
          "host.entry_admission.changed_definition",
          {
            admitted_level_id: admission?.levelId ?? null,
            admitted_visit: admission?.visit ?? null,
            booted_level_id: level?.id ?? null,
          },
          { attributeTo: "current-position" },
        );
        ctx.configErrors = [message];
        enterConfigErrorMode(extCtx);
        updateDashboard(extCtx, ctx);
        return false;
      }

      case "refuse_unreadable": {
        const message =
          "This run's saved host entry could not be read, so it cannot be " +
          "resumed safely. Team execution is blocked.";
        recoverySnapshotRefused = true;
        logHostLifecycleEvent(
          "host.entry_admission.unreadable",
          {},
          { attributeTo: "current-position" },
        );
        ctx.configErrors = [message];
        enterConfigErrorMode(extCtx);
        updateDashboard(extCtx, ctx);
        return false;
      }

      case "refuse_indeterminate": {
        const admission =
          restored.kind === "admission" ? restored.admission : undefined;
        const message =
          `Level '${admission?.levelId ?? "unknown"}' was already handed to ` +
          "this run's host before it stopped, and whether that turn ran cannot " +
          "be established. Team execution is blocked.";
        recoverySnapshotRefused = true;
        logHostLifecycleEvent(
          "host.entry_admission.indeterminate",
          {
            admitted_level_id: admission?.levelId ?? null,
            admitted_visit: admission?.visit ?? null,
            ...whenDefined(admission?.selection, (admitted_selection) => ({
              admitted_selection,
            })),
          },
          { attributeTo: "current-position" },
        );
        // Nothing is queued and nothing is switched, so a managed host finds
        // no work and ends on its own. An interactive session does not end, and
        // blocked has to mean blocked there too: without this, `input` would
        // let the next thing a person typed start a turn on a level nobody
        // armed, on whatever pair the session booted with, and that turn would
        // record the admitted pair it never spoke to.
        ctx.configErrors = [message];
        enterConfigErrorMode(extCtx);
        updateDashboard(extCtx, ctx);
        return false;
      }
    }
  }

  function activatePendingStageEntryIfNeeded(): void {
    const level = getCurrentLevel();
    if (!level) return;
    activatePendingStageEntry({
      state: ctx,
      currentLevelId: level.id,
      clearInvocationAdmissions: () =>
        capabilityPolicy.clearInvocationAdmissions(),
      registerLevelTools,
    });
  }

  /**
   * Why the runtime declined to start the active stage.
   *
   * Every one of these used to be a bare `return false`. In a delegated child
   * that silence was the whole bug: the host was still handed the
   * "reply NOOP" prompt, the run ended with no artifact, and the parent's
   * diagnosis blamed the host provider for a stage the runtime never attempted.
   */
  type StageAutostartSkipReason =
    | "no_team_config"
    | "no_level"
    | "no_coordinator"
    | "stage_not_autostartable"
    | "missing_tool_invokers"
    | "fault_injected";

  function logStageAutostartSkipped(
    reason: StageAutostartSkipReason,
    extra: { missingTools?: string[]; toolName?: string } = {},
  ): false {
    const outputDir = getAssignmentOutputDir();
    if (outputDir) {
      const level = getCurrentLevel();
      logRuntimeEvent(outputDir, {
        timestamp: new Date().toISOString(),
        event: "runtime.stage_autostart.skipped",
        session_id: ctx.state.sessionId,
        root_session_id: ctx.state.rootSessionId,
        level_id: level?.id ?? null,
        stage_type: level?.stage.type ?? null,
        reason,
        delegated_autostart: process.env.TEAM_DELEGATED_AUTOSTART === "1",
        ...whenDefined(extra.toolName, (tool_name) => ({ tool_name })),
        missing_tools: extra.missingTools ?? [],
        registered_tools: ctx.currentRegisteredTools,
      });
    }
    return false;
  }

  /**
   * Records whether the runtime owns stage execution for this level, which is
   * what silences the host prompt. Keeping the assignment here — rather than at
   * each return — means a new early exit cannot leave a stale `true` behind.
   */
  async function startActiveLevel(extCtx: ExtensionContext): Promise<boolean> {
    const startingLevelId = getCurrentLevel()?.id;
    const started = await startStageAutostart(extCtx);
    ctx.delegatedAutostartOwnsStage = resolveRuntimeAutostartOwnership({
      startingLevelId,
      activeLevelId: getCurrentLevel()?.id,
      started,
      activeLevelOwnership: ctx.delegatedAutostartOwnsStage,
    });
    return started;
  }

  function suspendAgentQuestion(error: unknown, outputDir: string, levelId: string): boolean {
    if (!(error instanceof AgentQuestionInterruptionError)) return false;
    waitingForAgentAnswer = true;
    if (error.interruption.kind === 'awaiting_input') ctx.state.questionPausedAt = Date.now();
    persistState();
    logRuntimeEvent(outputDir, {
      timestamp: new Date().toISOString(), event: 'run.awaiting_agent_input',
      session_id: ctx.state.sessionId, root_session_id: ctx.state.rootSessionId,
      level_id: levelId, interruption: error.interruption,
    });
    ctx.hostRunLifetime?.abandon();
    return true;
  }

  /**
   * The runtime-state writes one level's autostart makes. `render` reads
   * `ctx.lastCtx` and `advanceLevel` builds the lifecycle callbacks when each
   * is called.
   */
  function makeStageAutostartPorts(
    extCtx: ExtensionContext,
    level: LevelConfig,
    outputDir: string,
  ): StageAutostartPorts {
    return {
      persist: persistState,
      render: () => {
        if (ctx.lastCtx) updateDashboard(ctx.lastCtx, ctx);
      },
      suspendForAgentQuestion: (error) =>
        suspendAgentQuestion(error, outputDir, level.id),
      requestRunFailure: (error) =>
        requestRunFailure({
          assignmentPath: outputDir,
          levelId: level.id,
          stageType: level.stage.type,
          error,
        }),
      advanceLevel: () =>
        tryAdvanceLevelImpl(extCtx, ctx, makeLifecycleCallbacks()),
      startRunClock: () => {
        if (ctx.state.timerStarted) return;
        ctx.state.startTime = Date.now();
        ctx.state.timerStarted = true;
      },
      readSessionIds: () => ({
        sessionId: ctx.state.sessionId,
        ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({
          rootSessionId,
        })),
        ...whenDefined(ctx.state.parentSessionId, (parentSessionId) => ({
          parentSessionId,
        })),
      }),
    };
  }

  /**
   * The routing arm's ports. `coordinatorMetrics` updates the `metrics` entry
   * passed in, and each read returns what the runtime holds when it is called.
   */
  function makeDelegatedRoutingAutostartPorts(
    extCtx: ExtensionContext,
    level: LevelConfig,
    outputDir: string,
    metrics: AgentMetrics | undefined,
  ): DelegatedRoutingAutostartPorts {
    return {
      ...makeStageAutostartPorts(extCtx, level, outputDir),
      coordinatorMetrics: {
        markActive: () => {
          if (!metrics) return;
          metrics.state = AGENT_STATE.ACTIVE;
          metrics.activeStartedAt = Date.now();
        },
        markDone: (result) => {
          if (!metrics) return;
          metrics.state = AGENT_STATE.DONE;
          delete metrics.activeStartedAt;
          metrics.rounds += 1;
          metrics.totalCost = roundUsd(metrics.totalCost + result.cost);
          metrics.contextTokens = result.contextTokens;
          metrics.model = result.model;
        },
        markFailed: (error) => {
          if (!metrics) return;
          metrics.state = AGENT_STATE.ERROR;
          delete metrics.activeStartedAt;
          metrics.failureCount += 1;
          metrics.lastError = error;
        },
      },
      readTotalCost: () => ctx.state.totalCost,
      writeTotalCost: (totalCost) => {
        ctx.state.totalCost = totalCost;
      },
      readBudgetLedger: () => ctx.budgetLedger,
      readShutdownSignal: () => ctx.shutdownController.signal,
      readChatMode: () => process.env.TEAM_CHAT_MODE === '1',
      readTeamName: () => {
        // Boot assigns a loaded config and nothing clears it, and this branch
        // runs only after the no_team_config check. A missing config still
        // fails the autostart with the error a direct read would throw.
        const teamConfig = ctx.teamConfig;
        if (!teamConfig) {
          throw new TypeError("Cannot read properties of null (reading 'team')");
        }
        return teamConfig.team.name;
      },
    };
  }

  /**
   * The ports of a discussion autostart's lead calls. Each read returns what
   * the runtime holds when it is called.
   */
  function makeDiscussionCoordinatorCallPorts(): DiscussionCoordinatorCallPorts {
    return {
      advanceCoordinatorRunId: () => {
        ctx.coordinatorRunId += 1;
      },
      render: () => {
        if (ctx.lastCtx) updateDashboard(ctx.lastCtx, ctx);
      },
      persist: persistState,
      readSessionIds: () => ({
        sessionId: ctx.state.sessionId,
        ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({
          rootSessionId,
        })),
        ...whenDefined(ctx.state.parentSessionId, (parentSessionId) => ({
          parentSessionId,
        })),
      }),
      readTotalCost: () => ctx.state.totalCost,
      writeTotalCost: (totalCost) => {
        ctx.state.totalCost = totalCost;
      },
      readBudgetLedger: () => ctx.budgetLedger,
      readShutdownSignal: () => ctx.shutdownController.signal,
      readRecoveryMode: () => process.env.TEAM_RUNTIME_RECOVERY === '1',
    };
  }

  /**
   * The discussion autostart's ports: the lead calls' ports, four of the
   * stage autostart's, and the reads and writes of its pass loop. Each read
   * returns what the runtime holds when it is called.
   */
  function makeDiscussionAutostartPorts(
    extCtx: ExtensionContext,
    level: LevelConfig,
    outputDir: string,
  ): DiscussionAutostartPorts {
    const stagePorts = makeStageAutostartPorts(extCtx, level, outputDir);
    return {
      ...makeDiscussionCoordinatorCallPorts(),
      suspendForAgentQuestion: stagePorts.suspendForAgentQuestion,
      requestRunFailure: stagePorts.requestRunFailure,
      advanceLevel: stagePorts.advanceLevel,
      startRunClock: stagePorts.startRunClock,
      resetCoordinatorTurn: () => {
        ctx.usedLevelToolsThisCoordinatorTurn.clear();
        capabilityPolicy.clearInvocationAdmissions();
        ctx.coordinatorToolCallsThisRun = 0;
      },
      readChatMode: () => process.env.TEAM_CHAT_MODE === "1",
      readTeamConfig: () => {
        // Throws the TypeError `buildDelegatedDiscussionContinuationRequest`
        // throws when it reads `team` from a null config.
        const teamConfig = ctx.teamConfig;
        if (!teamConfig) {
          throw new TypeError("Cannot read properties of null (reading 'team')");
        }
        return teamConfig;
      },
      readHumanInputRouting: () => ctx.humanInputRouting,
      hasLoadedAgent: (agentName) => ctx.agents.has(agentName),
    };
  }

  async function startStageAutostart(
    extCtx: ExtensionContext,
  ): Promise<boolean> {
    if (!ctx.teamConfig) return logStageAutostartSkipped("no_team_config");

    // Test-only fault injection. Auto-recovery cannot be exercised without a
    // deterministic way to make autostart decline, and a deliberately broken
    // team.yaml would test config validation instead of recovery.
    if (runtimeFaultInjection === "skip_stage_autostart") {
      return logStageAutostartSkipped("fault_injected");
    }

    const level = getCurrentLevel();
    // Set by a recovering chain; every other autostart sends no input.
    let recoveredChainInput: { action?: "resume" } = {};
    const recoveringLevelState = level
      ? ctx.state.levelStates.get(level.id)
      : undefined;
    if (
      recoveringLevelState &&
      level &&
      shouldRuntimeAutostartLevel(level, process.env)
    ) {
      const isRecovery = process.env.TEAM_RUNTIME_RECOVERY === "1";
      const recovery = planStageRecovery(
        recoveringLevelState,
        level.stage,
        isRecovery,
      );
      if (recovery.recoveredStatus !== undefined) {
        transitionStageStatus(recoveringLevelState, recovery.recoveredStatus);
      }
      if (recovery.reopenedPass) {
        recovery.reopenedPass.discussion.continuation =
          recovery.reopenedPass.continuation;
      }
      // The step's verdict file is read after the recovered status is
      // applied, and the restart is decided from the status as it is then.
      const chainRecovery = recovery.chain
        ? planChainRecovery({
            stageStatus: recoveringLevelState.stageStatus,
            chain: recovery.chain.state,
            isRecovery,
            inFlightStepBlockedByAgent: hasBlockedChainStepVerdict(
              getAssignmentPath(ctx),
              recovery.chain.stage.sequence,
              recovery.chain.state.outputs.length,
            ),
          })
        : undefined;
      if (chainRecovery) {
        if (chainRecovery.restartStatus !== undefined) {
          transitionStageStatus(recoveringLevelState, chainRecovery.restartStatus);
        }
        recoveredChainInput = chainRecovery.chainInput;
      }
      if (stageRecoveryChanged(recovery, chainRecovery)) {
        persistState();
      }
    }
    if (
      level?.stage.type === STAGE_TYPE.ROUTING &&
      shouldRuntimeAutostartLevel(level, process.env)
    ) {
      const coordinator = getCurrentCoordinator();
      if (!coordinator) return logStageAutostartSkipped("no_coordinator");

      const humanQuestions = Boolean(process.env[MCP_WORKER_TURN_URL_ENV]?.trim()) && hasMcpProviderAdapter(coordinator.provider);
      const routingTeamId = ctx.teamConfig.team.name;
      const outputDir = getAssignmentPath(ctx);
      const delegatedBrief = readRuntimeAutostartInput({
        assignmentPath: outputDir,
        teamConfig: ctx.teamConfig,
        level,
        ...whenDefined(process.env.TEAM_INPUT_ARTIFACT, (delegatedInputArtifact) => ({
          delegatedInputArtifact,
        })),
      });
      const availableTeams = [...ctx.teamRegistry.values()]
        .filter((entry) => entry.type === "team")
        .map((entry) =>
          entry.description
            ? `${entry.name}: ${entry.description}`
            : entry.name,
        );
      const plan = buildDelegatedRoutingAutostartPlan(
        ctx.teamConfig,
        level,
        delegatedBrief,
        availableTeams,
        resolveRuntimeAutostartOutputOverride({
          teamConfig: ctx.teamConfig,
          level,
          delegatedOutputArtifact: process.env.TEAM_OUTPUT_ARTIFACT,
        }),
        { humanQuestions },
      );
      const outputPath = path.isAbsolute(plan.outputArtifact)
        ? path.resolve(plan.outputArtifact)
        : path.resolve(outputDir, plan.outputArtifact);
      const relativeOutputPath = path.relative(path.resolve(outputDir), outputPath);
      if (
        !relativeOutputPath ||
        relativeOutputPath.startsWith("..") ||
        path.isAbsolute(relativeOutputPath)
      ) {
        throw new Error(
          `Delegated routing output must stay inside the assignment: ${plan.outputArtifact}`,
        );
      }

      return runDelegatedRoutingAutostart(
        {
          identity: {
            assignmentPath: outputDir,
            levelId: level.id,
            stageType: level.stage.type,
          },
          stage: level.stage,
          coordinator,
          plan,
          humanQuestions,
          resumeAfterQuestion:
            humanQuestions && process.env.TEAM_RUNTIME_RECOVERY === '1',
          teamId: routingTeamId,
          outputPath,
          relativeOutputPath,
          readLevelState: () => ctx.state.levelStates.get(level.id),
        },
        makeDelegatedRoutingAutostartPorts(
          extCtx,
          level,
          outputDir,
          ctx.agentMetrics.get(coordinator.name),
        ),
      );
    }

    if (
      level?.stage.type === STAGE_TYPE.DISCUSSION &&
      shouldRuntimeAutostartLevel(level, process.env)
    ) {
      const coordinator = getCurrentCoordinator();
      if (!coordinator) return logStageAutostartSkipped("no_coordinator");
      const activeTeamConfig = ctx.teamConfig;
      const discussionLevel = level;
      const discussionStage = level.stage;
      const discussionCoordinator = coordinator;
      const humanQuestions = Boolean(process.env[MCP_WORKER_TURN_URL_ENV]?.trim()) && hasMcpProviderAdapter(coordinator.provider);

      const setRosterTool = ctx.currentToolInvokers.get("set_roster");
      const createBriefTool = ctx.currentToolInvokers.get("create_brief");
      const converseTool = ctx.currentToolInvokers.get("converse");
      if (!setRosterTool || !createBriefTool || !converseTool) {
        return logStageAutostartSkipped("missing_tool_invokers", {
          missingTools: [
            ...(setRosterTool ? [] : ["set_roster"]),
            ...(createBriefTool ? [] : ["create_brief"]),
            ...(converseTool ? [] : ["converse"]),
          ],
        });
      }

      const outputDir = getAssignmentPath(ctx);
      const delegatedBrief = readRuntimeAutostartInput({
        assignmentPath: outputDir,
        teamConfig: ctx.teamConfig,
        level,
        ...whenDefined(process.env.TEAM_INPUT_ARTIFACT, (delegatedInputArtifact) => ({
          delegatedInputArtifact,
        })),
      });
      const coordinatorRequest = buildDelegatedDiscussionCoordinatorRequest(
        ctx.teamConfig,
        level,
        delegatedBrief,
        { humanQuestions },
      );
      const toolCallPrefix = `runtime-autostart-${randomUUID()}-delegated-discussion`;
      const coordinatorMetrics = ctx.agentMetrics.get(coordinator.name);
      const discussionLevelState = ctx.state.levelStates.get(level.id);
      let restoredDiscussionState = discussionLevelState?.engineState;
      const activationStartedAtMs = Date.now();
      if (restoredDiscussionState?.type !== STAGE_TYPE.DISCUSSION) {
        if (!discussionLevelState) {
          throw new Error("Discussion level state is unavailable at activation.");
        }
        restoredDiscussionState = {
          type: STAGE_TYPE.DISCUSSION,
          round: 0,
          messages: [],
          outputPath: outputDir,
          activationStartedAtMs,
        };
        discussionLevelState.engineState = restoredDiscussionState;
      } else if (
        restoredDiscussionState.continuation === undefined &&
        restoredDiscussionState.activationStartedAtMs === undefined
      ) {
        restoredDiscussionState.activationStartedAtMs = activationStartedAtMs;
      }
      let discussionStartedAt =
        restoredDiscussionState.continuation?.startedAtMs ??
        restoredDiscussionState.activationStartedAtMs ??
        activationStartedAtMs;
      let discussionClock = beginDiscussionContinuation(discussionStartedAt);
      const maxDiscussionTimeMinutes =
        level.stage.config.constraints?.max_time_minutes;

      logRuntimeEvent(outputDir, {
        timestamp: new Date().toISOString(),
        event: "runtime.stage_autostart.begin",
        session_id: ctx.state.sessionId,
        root_session_id: ctx.state.rootSessionId,
        level_id: level.id,
        stage_type: level.stage.type,
        tool_name: "delegated_discussion_autostart",
        tool_call_id: toolCallPrefix,
        registered_tools: ctx.currentRegisteredTools,
      });

      return runDiscussionAutostart(
        {
          assignmentPath: outputDir,
          teamConfig: activeTeamConfig,
          level: discussionLevel,
          stage: discussionStage,
          coordinator: discussionCoordinator,
          coordinatorMetrics,
          humanQuestions,
          maxDiscussionTimeMinutes,
          faultInjection: runtimeFaultInjection,
          readDiscussionClock: () => discussionClock,
          writeDiscussionClock: (clock) => {
            discussionClock = clock;
          },
          readDiscussionStartedAt: () => discussionStartedAt,
          writeDiscussionStartedAt: (startedAtMs) => {
            discussionStartedAt = startedAtMs;
          },
          restoredState: restoredDiscussionState,
          toolCallPrefix,
          delegatedBrief,
          coordinatorRequest,
          tools: {
            setRoster: setRosterTool,
            createBrief: createBriefTool,
            converse: converseTool,
          },
          extensionContext: extCtx,
          readLevelState: () => ctx.state.levelStates.get(level.id),
        },
        makeDiscussionAutostartPorts(extCtx, level, outputDir),
      );
    }

    if (!level) return logStageAutostartSkipped("no_level");
    const toolName = resolveRuntimeOwnedStageTool(level);
    if (!toolName) return logStageAutostartSkipped("stage_not_autostartable");

    const tool = ctx.currentToolInvokers.get(toolName);
    if (!tool) {
      return logStageAutostartSkipped("missing_tool_invokers", {
        missingTools: [toolName],
        toolName,
      });
    }

    const outputDir = getAssignmentPath(ctx);
    return runEngineToolAutostart(
      {
        identity: {
          assignmentPath: outputDir,
          levelId: level.id,
          stageType: level.stage.type,
        },
        toolName,
        invoker: tool,
        toolInput: recoveredChainInput,
        isEngineTool: ctx.ENGINE_TOOLS.has(toolName),
        registeredTools: ctx.currentRegisteredTools,
        readLevelState: () => ctx.state.levelStates.get(level.id),
        signal: ctx.shutdownController.signal,
        extensionContext: extCtx,
      },
      makeStageAutostartPorts(extCtx, level, outputDir),
    );
  }

  // ── Lifecycle callbacks object passed to level-lifecycle ──

  /**
   * Whether the runtime drives a level itself, rather than a coordinator.
   *
   * The environment is read here, at the extension boundary, and the answer is
   * handed to both transitions. Neither the gate-driven advance nor the manual
   * command may reach for it: a level that is armed on one path and left inert
   * on the other is the same bug twice.
   */
  function runtimeOwnsLevel(level: LevelConfig): boolean {
    return shouldRuntimeAutostartLevel(level, process.env);
  }

  /**
   * Record that the active level is owed an opening entry, on this pair.
   *
   * Resolved once, here, from the level's own coordinator. Every later use —
   * the host switch at the settle, the dispatch, and a recovery in another
   * process — reads this record rather than resolving again, because the
   * ordinary resolution reads the application default out of the *running*
   * process's environment: a recovered entry that re-resolved would run on
   * whatever default its new launch happened to be given.
   *
   * A level with no resolvable pair at all admits nothing. There is no record
   * to write, and inventing one would be the substitution this project exists
   * to prevent.
   */
  function admitHostEntryForActiveLevel(): void {
    const level = getCurrentLevel();
    if (!level) return;
    const selection = hostModelSelection(
      resolveDesiredHostModel(ctx.bootEntry ?? null, getCurrentCoordinator()),
    );
    if (!selection) return;
    admitHostEntry(ctx, {
      levelId: level.id,
      visit: ctx.state.levelStates.get(level.id)?.visitCount ?? 0,
      selection,
    });
  }

  function makeLifecycleCallbacks(): LifecycleCallbacks {
    return {
      teamChatMode: process.env.TEAM_CHAT_MODE === "1",
      registerLevelTools,
      startActiveLevel,
      runtimeOwnsLevel,
      prepareHostForActiveLevel,
      requestRunCompletion,
      admitHostEntryForActiveLevel,
      persistState,
      updateDashboard: (extCtx: ExtensionContext) =>
        updateDashboard(extCtx, ctx),
    };
  }

  // ── State Persistence ──

  /** Test-only: the settle write has failed once already. */
  let settleWriteFailureInjected = false;

  function persistState(): void {
    // Test-only, and before the writes rather than after them: what has to be
    // provable is that a run whose durable bookkeeping cannot be saved still
    // ends truthfully rather than holding its host open for ever.
    const settling = ctx.state.hostEntryAdmission;
    if (
      !settleWriteFailureInjected &&
      settling?.state === "settled" &&
      hostAdmissionCrashRequested(
        runtimeFaultInjection,
        HOST_SETTLE_WRITE_FAILURE_POINT,
        settling.levelId,
      )
    ) {
      settleWriteFailureInjected = true;
      throw new Error("Injected checkpoint write failure at settlement.");
    }
    ctx.pi.appendEntry("team-runtime", buildPersistedRuntimeState(ctx.state));
    // Write disk checkpoint for crash recovery (skip if run already completed,
    // or if this process refused to resume from the checkpoint it read).
    //
    // The second guard is what makes a refusal last. Shutdown persists, and an
    // unreadable admission cannot be held in a typed field — so without this,
    // the process that fails closed on a record it cannot read would overwrite
    // that record with nothing on its way out, and the next start would find a
    // clean-looking checkpoint and resume the very work the refusal existed to
    // stop. A run this process would not touch is a run it does not rewrite.
    if (
      ctx.teamConfig &&
      ctx.state.sessionId &&
      !ctx.state.endTime &&
      !recoverySnapshotRefused
    ) {
      writeCheckpoint(getAssignmentPath(ctx), ctx.state);
    }
    // Test-only, and placed here because the cut this phase has to survive is
    // defined by what reached the disk, not by where in the call stack the
    // process happened to be. The named point says which durable state the
    // recovery is then asked to handle, and which level's entry it is about.
    const pendingAdmission = ctx.state.hostEntryAdmission;
    if (
      pendingAdmission?.state === "pending" &&
      hostAdmissionCrashRequested(
        runtimeFaultInjection,
        HOST_ADMISSION_PENDING_CRASH_POINT,
        pendingAdmission.levelId,
      )
    ) {
      process.kill(process.pid, "SIGKILL");
    }
  }

  // The queue records a dispatch admission before it sends, and cannot reach
  // this from its own module. Assigned once, beside the definition it forwards.
  ctx.persistRuntimeState = persistState;

  function getAssignmentOutputDir(): string | null {
    if (!ctx.teamConfig || !ctx.state.sessionId) return null;
    return getAssignmentPath(ctx);
  }

  /**
   * How the host's pair was decided for the level the run is on right now.
   *
   * The admitted record first. Between processes it is the only account that
   * describes what this run decided: the ordinary resolution reads the
   * application default out of *this* process's environment, so a resumed level
   * would otherwise be disclosed as running on a pair it was never admitted
   * for, in the same event stream whose whole purpose is to say which model was
   * used and why. Within one process the two agree, so nothing changes there.
   */
  function currentPositionHostModelSelection():
    | ModelSelectionRecord
    | undefined {
    const admitted = hostEntryForLevel(ctx, getCurrentLevel()?.id ?? null);
    if (admitted) return admitted.selection;
    return hostModelSelection(
      resolveDesiredHostModel(
        ctx.bootEntry ?? null,
        getCurrentCoordinator() ?? undefined,
      ),
    );
  }

  /** The host's own provenance, when there is a whole pair to describe. */
  function hostModelSelection(
    spec: ReturnType<typeof resolveDesiredHostModel>,
  ): ModelSelectionRecord | undefined {
    return spec ? hostModelSelectionRecord(spec) : undefined;
  }

  /**
   * Who a host record is about.
   *
   * Almost always the turn that produced it, which is why that is the default.
   * `current-position` is for the few records that genuinely describe where the
   * runtime has arrived rather than what it was doing.
   */
  function logHostLifecycleEvent(
    event: string,
    extra: Record<string, unknown> = {},
    options: {
      readonly attributeTo?: "owning-turn" | "current-position"
    } = {},
  ): void {
    const outputDir = getAssignmentOutputDir();
    if (!outputDir) return;
    // The turn that is running owns what it produces. Only a record that is
    // genuinely about where the runtime has arrived asks for the live position.
    const owner =
      options.attributeTo === "current-position" ? null : ctx.outerTurnOwner;
    const currentLevel = getCurrentLevel();
    const currentCoordinator = getCurrentCoordinator();
    const coordinatorName = owner
      ? owner.coordinatorName
      : (currentCoordinator?.name ?? null);
    logHostEvent(outputDir, {
      timestamp: new Date().toISOString(),
      event,
      session_id: ctx.state.sessionId,
      root_session_id: ctx.state.rootSessionId,
      assignment_path: outputDir,
      team: ctx.teamConfig?.team.name ?? null,
      level_id: owner ? owner.levelId : (currentLevel?.id ?? null),
      stage_type: owner ? owner.stageType : (currentLevel?.stage.type ?? null),
      coordinator: coordinatorName,
      coordinator_run_id: owner ? owner.coordinatorRunId : ctx.coordinatorRunId,
      // Which host process this turn belongs to.
      //
      // The turn counter above starts at 0 in every process, so it reaches 1 on
      // each one's first turn. A recovered run keeps its session id, so without
      // this a reader cannot tell the turn before a crash from the first turn
      // after it: they arrive as the same run's turn 1, and anything keyed on
      // the pair silently merges two coordinators into one.
      host_instance_id: hostInstanceId,
      host_provider: owner
        ? owner.hostProvider
        : (ctx.lastCtx?.model?.provider ?? null),
      host_model: owner ? owner.hostModel : (ctx.lastCtx?.model?.id ?? null),
      // How that pair was decided, on every host lifecycle event rather than
      // only where a coordinator happens to exist. The pair alone cannot say
      // whether the host ran on the application default, and the host is a
      // model use like any other. For a record about the running turn it comes
      // from that turn's own coordinator, resolved when the turn opened; for
      // one about the current position it is recomputed from the same rule the
      // host applies, so a disagreement is visible rather than hidden.
      ...whenDefined(
        owner
          ? owner.hostModelSelection
          : currentPositionHostModelSelection(),
        (host_model_selection) => ({ host_model_selection }),
      ),
      ...extra,
    });
  }

  function logIncompleteRun(reason: string): void {
    if (waitingForAgentAnswer) return;
    if (
      incompleteRunLogged ||
      !ctx.teamConfig ||
      !ctx.state.sessionId ||
      ctx.state.endTime ||
      runTerminalFailureLogged
    )
      return;
    incompleteRunLogged = true;
    const currentLevel = getCurrentLevel();
    const outputDir = getAssignmentOutputDir();
    if (!outputDir) return;

    logRuntimeEvent(outputDir, {
      timestamp: new Date().toISOString(),
      event: "run.incomplete",
      session_id: ctx.state.sessionId,
      root_session_id: ctx.state.rootSessionId,
      parent_session_id: ctx.state.parentSessionId,
      assignment_path: outputDir,
      team: ctx.teamConfig.team.name,
      level_id: currentLevel?.id ?? null,
      stage_type: currentLevel?.stage.type ?? null,
      reason,
    });
  }

  function requestRunCompletion(completion: {
    assignmentPath: string;
    levelId: string;
    stageType: string;
  }): void {
    if (!ctx.teamConfig) return;
    runCompletion.request({
      ...completion,
      sessionId: ctx.state.sessionId,
      ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({
        rootSessionId,
      })),
      ...whenDefined(ctx.state.parentSessionId, (parentSessionId) => ({
        parentSessionId,
      })),
      team: ctx.teamConfig.team.name,
    });
  }

  function requestRunFailure(failure: {
    assignmentPath: string;
    levelId: string;
    stageType: string;
    error: string;
  }): void {
    if (!ctx.teamConfig) return;
    runTerminalFailureLogged = runCompletion.fail({
      ...failure,
      sessionId: ctx.state.sessionId,
      ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({
        rootSessionId,
      })),
      ...whenDefined(ctx.state.parentSessionId, (parentSessionId) => ({
        parentSessionId,
      })),
      team: ctx.teamConfig.team.name,
    }) || runTerminalFailureLogged;
  }

  function restoreState(
    entries: SessionEntry[],
    authoritativeSnapshotAccepted = false,
  ): void {
    for (const entry of entries) {
      if (
        entry.type === "custom" &&
        entry.customType === "team-runtime" &&
        entry.data !== undefined
      ) {
        restorePersistedRuntimeState(ctx.state, entry.data, {
          authoritativeSnapshotAccepted,
        });
      }
    }
  }

  function findPersistedRuntimeSessionId(entries: SessionEntry[]): string | undefined {
    let persistedSessionId: string | undefined;
    for (const entry of entries) {
      if (
        entry.type !== "custom" ||
        entry.customType !== "team-runtime" ||
        !isRecord(entry.data)
      ) {
        continue;
      }
      const candidate = entry.data.sessionId;
      persistedSessionId =
        typeof candidate === "string" && isSafePathSegment(candidate)
          ? candidate
          : undefined;
    }
    return persistedSessionId;
  }

  // ── Setup / Config Error Mode ──

  /**
   * Write a startup diagnostic to the assignment even when boot never got far
   * enough to establish one normally.
   *
   * Startup failures used to leave nothing but a `console.error` on the child's
   * stderr, which the parent discards whenever any other diagnostic exists. The
   * result was a child that produced no artifact for a reason nobody could read.
   * Best-effort by construction: a child with no resolvable assignment has
   * nowhere to write, and a diagnostic must never become a second failure.
   */
  function logStartupDiagnostic(
    event: string,
    payload: Record<string, unknown>,
  ): void {
    try {
      const sessionId = ctx.state.sessionId || process.env.TEAM_SESSION_ID || "";
      if (!ctx.assignmentLocation && !sessionId) return;
      const outputDir = ctx.assignmentLocation
        ? ctx.assignmentLocation.assignmentPath
        : getAssignmentPath({ ...ctx, state: { ...ctx.state, sessionId } });
      fs.mkdirSync(outputDir, { recursive: true });
      logRuntimeEvent(outputDir, {
        timestamp: new Date().toISOString(),
        event,
        session_id: sessionId,
        root_session_id: ctx.state.rootSessionId,
        assignment_path: outputDir,
        ...payload,
      });
    } catch {
      // A diagnostic that throws would replace the failure it describes.
    }
  }

  function enterConfigErrorMode(extCtx: ExtensionContext): void {
    const errorList = ctx.configErrors
      .map((e, i) => `  ${i + 1}. ${e}`)
      .join("\n");
    const message = `team.yaml has configuration errors:\n\n${errorList}\n\nFix these errors and restart.`;
    console.error(message);
    logStartupDiagnostic("runtime.config_error", {
      errors: [...ctx.configErrors],
    });
    extCtx.ui.notify(message, "error");
  }

  function enterSetupMode(extCtx: ExtensionContext): void {
    extCtx.ui.notify(
      "No team.yaml found in this directory.\n\n" +
        "To create a team, create a team.yaml file following the template format.\n" +
        "See the setup/templates/ directory in the team-runtime package for examples.\n\n" +
        "Or start a conversation — the setup agent will guide you through team creation.",
      "info",
    );
  }

  function buildConfigErrorPrompt(): string {
    const errorList = ctx.configErrors
      .map((e, i) => `${i + 1}. ${e}`)
      .join("\n");
    return [
      "You are the config-error reporter for the team runtime.",
      "Do not act like a general assistant.",
      "Do not ask follow-up questions.",
      "Do not offer to help with unrelated tasks.",
      "Respond concisely with the configuration error message below and stop.",
      "",
      "team.yaml has configuration errors:",
      "",
      errorList,
      "",
      "Fix these errors and restart.",
    ].join("\n");
  }

  // ── Teardown ──

  /**
   * The ports both teardown routes call. Building them reads no runtime value;
   * each member reads or changes `ctx` or a binding of this extension, or calls
   * the function it names, when it is called.
   */
  function makeRuntimeTeardownPorts(): RuntimeTeardownPorts {
    return {
      records: {
        recordIncompleteRun: (reason) => {
          logIncompleteRun(reason);
        },
        persistState: () => {
          persistState();
        },
      },
      work: {
        abort: () => {
          ctx.shutdownController.abort();
        },
        clearRefreshInterval: () => {
          if (ctx.refreshTimer) {
            clearInterval(ctx.refreshTimer);
            ctx.refreshTimer = null;
          }
        },
        clearFollowUpTimer: () => {
          if (ctx.pendingFollowUpTimer) {
            clearTimeout(ctx.pendingFollowUpTimer);
            ctx.pendingFollowUpTimer = null;
          }
        },
      },
      devServices: {
        stopSync: () => {
          devServices.stopSync();
        },
        stop: () => devServices.stop(),
      },
      session: {
        stopDashboardObserver: () => {
          disposeDashboardObserver();
        },
        abandonHostRun: () => {
          ctx.hostRunLifetime?.abandon();
        },
        emitCompletionOnShutdown: () => {
          runCompletion.emitOnShutdown();
        },
      },
      processBindings: {
        releaseSignalRegistration: () => {
          shutdownRegistration?.dispose();
          shutdownRegistration = null;
        },
        removeExitListener: () => {
          process.off("exit", stopDevServicesAtExit);
        },
      },
      writers: {
        flushTextStream: () => getProcessRunTextStream().close(),
        evidenceWriter: () => capabilityEvidenceWriter,
        journalRegistry: () => executionJournalRegistry,
      },
      checkpoint: {
        runCompleted: () =>
          Boolean(ctx.teamConfig && ctx.state.sessionId && ctx.state.endTime),
        delete: () => {
          deleteCheckpoint(getAssignmentPath(ctx));
        },
      },
    };
  }

  // The signal route and the session route live in `runtime-teardown.ts`.
  // `session_start` hands the signal route to `installShutdownHandlers`, and
  // `session_shutdown` below runs the session route.
  const runtimeTeardownPorts = makeRuntimeTeardownPorts();

  // ── Events ──

  /**
   * Layer 4 of the error policy at the top of this file: an event handler must
   * never throw. A rejection here used to leave the child with no stage tools,
   * no autostart, and no trace beyond stderr — the host then answered the
   * delegated NOOP prompt and the run ended with no artifact and no cause.
   */
  pi.on("session_start", async (_event, extCtx) => {
    try {
      await startSession(extCtx);
    } catch (error) {
      const errorText =
        error instanceof Error ? error.stack || error.message : String(error);
      console.error(`[team-runtime] Session start failed:\n${errorText}`);
      logStartupDiagnostic("runtime.host_start_failed", { error: errorText });
      // Surfacing it as a config error routes the host onto the config-error
      // prompt, so the child reports the failure instead of idling.
      ctx.configErrors = [`Team runtime failed to start: ${errorText}`];
      extCtx.ui.notify(`Team runtime failed to start:\n${errorText}`, "error");
      updateDashboard(extCtx, ctx);
    }
  });

  async function startSession(extCtx: ExtensionContext): Promise<void> {
    ctx.lastCtx = extCtx;
    const booted = await boot(extCtx.cwd);

    if (booted && ctx.teamConfig) {
      const entries = extCtx.sessionManager.getEntries();
      const persistedRuntimeSessionId = findPersistedRuntimeSessionId(entries);

      // Establish the intended logical run before resolving any mutable path.
      // Product/delegated recovery supplies the same TEAM_SESSION_ID to a new
      // process; MCP-scoped child assignments use their canonical assignment
      // identity. A reopened direct CLI session can reuse its persisted exact
      // assignment; a new standalone session receives a new isolated one.
      const date = new Date().toISOString().slice(0, 10);
      const time = new Date().toISOString().slice(11, 16).replace(":", "");
      ctx.state.sessionId =
        process.env.TEAM_SESSION_ID ||
        ctx.assignmentLocation?.assignmentId ||
        persistedRuntimeSessionId ||
        `${date}-${time}-${ctx.teamConfig.team.name}-${randomUUID()}`;
      ctx.state.tenantId =
        process.env.TEAM_TENANT_ID || ctx.state.tenantId || "local";
      ctx.state.rootSessionId =
        process.env.TEAM_ROOT_SESSION_ID || ctx.state.sessionId;
      const parentSessionId = process.env.TEAM_PARENT_SESSION_ID;
      if (parentSessionId) {
        ctx.state.parentSessionId = parentSessionId;
      } else {
        delete ctx.state.parentSessionId;
      }
      ctx.state.startTime = 0;
      ctx.state.timerStarted = false;
      ctx.state.endTime = null;

      const assignmentPath = getAssignmentPath(ctx);

      // Checkpoint resume detection
      let checkpointRestored = false;
      let restoredAdmission: ReturnType<typeof readHostEntryAdmission> = {
        kind: "absent",
      };
      // Persisted top-level tasks must explicitly enter recovery mode. Scoped
      // MCP child assignments retain their existing same-assignment resume
      // behavior within the owning workflow attempt.
      if (
        checkpointResumeAllowed({
          recoveryFlag: process.env.TEAM_RUNTIME_RECOVERY,
          assignmentLocation: ctx.assignmentLocation,
          persistedRuntimeSessionId,
        }) &&
        hasCheckpoint(assignmentPath)
      ) {
        // From here this process owes the snapshot its silence until it has
        // read the whole thing. Everything below can throw — the level-state
        // restore validates nested engine state hard enough to raise — and a
        // process that fails partway must not go on to write its own boot state
        // over the record it never finished reading.
        recoverySnapshotRefused = true;
        const ownership = checkpointOwnership(
          readCheckpoint(assignmentPath),
          ctx.state.sessionId,
        );
        if (ownership.kind === "own") {
          const checkpoint = ownership.checkpoint;
          console.warn(`[team-runtime] ${formatCheckpointSummary(checkpoint)}`);
          // The ids, level index and cost are assigned before the run clock
          // and the level states, which can throw, so a start that fails on
          // them still carries those; timerStarted, endTime and spawnDepth are
          // assigned after the clock, as before.
          const header = adoptedCheckpointHeader(checkpoint);
          ctx.state.rootSessionId = header.rootSessionId;
          if (header.parentSessionId === undefined) {
            delete ctx.state.parentSessionId;
          } else {
            ctx.state.parentSessionId = header.parentSessionId;
          }
          ctx.state.currentLevelIndex = header.currentLevelIndex;
          ctx.state.totalCost = header.totalCost;
          ctx.state.startTime = resumedCheckpointStartTime(checkpoint, Date.now());
          delete ctx.state.questionPausedAt;
          ctx.state.timerStarted = header.timerStarted;
          ctx.state.endTime = null;
          ctx.state.spawnDepth = header.spawnDepth;
          // Both read before either is committed. The level-state restore
          // throws on a nested semantic violation, and doing it first meant a
          // checkpoint with one bad field never got as far as its admission —
          // so the process could not know it had one to protect.
          //
          // The admission still has its own reader rather than being folded
          // into that restore: a record this build cannot read must refuse only
          // itself, not take the run's whole position down with it.
          const adopted = adoptedCheckpointLevels(
            checkpoint,
            ctx.state.startTime,
          );
          restoredAdmission = adopted.admission;
          ctx.state.levelStates = adopted.levelStates;
          if (restoredAdmission.kind === "admission") {
            ctx.state.hostEntryAdmission = restoredAdmission.admission;
          } else {
            delete ctx.state.hostEntryAdmission;
          }
          checkpointRestored = true;
          // Read whole. This process may write again — subject to what the
          // admission itself then says.
          recoverySnapshotRefused = false;
          logRuntimeEvent(assignmentPath, {
            timestamp: new Date().toISOString(),
            event: "run.resumed_from_checkpoint",
            session_id: ctx.state.sessionId,
            root_session_id: ctx.state.rootSessionId,
            checkpoint_level_index: checkpoint.currentLevelIndex,
            checkpoint_total_cost: checkpoint.totalCost,
          });
        } else if (ownership.kind === "foreign") {
          const checkpoint = ownership.checkpoint;
          // Read whole, and it belongs to another run. That is a different
          // thing from a snapshot this process could not read, and it keeps the
          // behaviour it already had.
          recoverySnapshotRefused = false;
          logRuntimeEvent(assignmentPath, {
            timestamp: new Date().toISOString(),
            event: "checkpoint.rejected",
            session_id: ctx.state.sessionId,
            root_session_id: ctx.state.rootSessionId,
            checkpoint_session_id: checkpoint.sessionId,
            reason: "session_identity_mismatch",
          });
          // Only a scoped assignment stops; a direct session goes on.
          const refusal = foreignCheckpointRefusal(
            checkpoint.sessionId,
            ctx.assignmentLocation,
          );
          if (refusal !== undefined) {
            console.error(`[team-runtime] ${refusal}`);
            extCtx.ui.notify(refusal, "error");
            return;
          }
        }
      }

      // boot() initializes the active level map. Only an accepted checkpoint
      // may replace it; clearing it loses in-progress stage state before the
      // delegated autostart tools can persist their work.

      // Restore state from session entries.
      //
      // An accepted checkpoint owns every field it carries, so this may only
      // supply what it does not — `tenantId`. Applied unconditionally, it would
      // be a second writer for the level index and every level's status while
      // the checkpoint alone carries the host's entry admission, and the two
      // halves would describe different moments of the same run.
      restoreState(entries, checkpointRestored);

      const outputDir = getAssignmentPath(ctx);
      fs.mkdirSync(outputDir, { recursive: true });
      logSessionStart(
        outputDir,
        ctx.state.sessionId,
        ctx.teamConfig.team.name,
        [...ctx.agents.keys()],
        ctx.state.rootSessionId,
      );
      logHostLifecycleEvent("host.session_start", {
        cwd: extCtx.cwd,
        boot_entry: ctx.bootEntry?.name ?? null,
        desired_host_provider:
          ctx.bootEntry?.host_provider ??
          getCurrentCoordinator()?.provider ??
          null,
        desired_host_model:
          ctx.bootEntry?.host_model ?? getCurrentCoordinator()?.model ?? null,
        initial_host_provider: extCtx.model?.provider ?? null,
        initial_host_model: extCtx.model?.id ?? null,
      });

      if (!resumeRestoredHostEntry(extCtx, restoredAdmission)) return;

      ctx.lastCtx = extCtx;
      const runtimeAutostartPlanned = shouldRuntimeAutostartLevel(
        getCurrentLevel(),
        process.env,
      );
      if (!runtimeAutostartPlanned) {
        const hostModelReady = await applyHostModelPreference(pi, extCtx, ctx);
        if (!hostModelReady) {
          enterConfigErrorMode(extCtx);
          updateDashboard(extCtx, ctx);
          return;
        }
        logHostLifecycleEvent("host.model_selection.resolved", {
          resolved_host_provider: extCtx.model?.provider ?? null,
          resolved_host_model: extCtx.model?.id ?? null,
        });
      }

      // Signal handling for this session, kept so `session_shutdown` can give
      // it back. A registration that outlives its session leaves a signal
      // bound to a runtime that has already stopped.
      shutdownRegistration?.dispose();
      shutdownRegistration = installShutdownHandlers({
        onShutdown: () => {
          teardownOnSignal(runtimeTeardownPorts);
        },
      });

      const devServicesResult = await devServices.start({
        workspacePath: ctx.teamConfig.workspace.path,
      });
      if (devServicesResult.errors.length > 0) {
        extCtx.ui.notify(
          `Dev service startup issue:\n${devServicesResult.errors.join("\n")}`,
          "warning",
        );
      }

      // Durable journal startup boundary (ADR A-4): resolve the journal
      // configuration and reconcile the workspace tenant pin once, before
      // any governed tool can dispatch. Constructed in every mode;
      // enrollment is decided per assignment inside the registry, and an
      // absent registry is what used to return an enrolled assignment to
      // the legacy authority.
      if (!executionJournalRegistry) {
        const journalOptions = await startWorkspaceExecutionJournal({
          workspacePath: ctx.teamConfig.workspace.path,
        });
        executionJournalRegistry = createWorkspaceExecutionJournalRegistry(
          ctx.teamConfig.workspace.path,
          journalOptions,
        );
      }

      // Register tools for current level
      registerLevelTools();

      pi.setSessionName(ctx.teamConfig.team.name);

      // Show startup notification
      const level = getCurrentLevel();
      const hostLabel = extCtx.model
        ? `${extCtx.model.provider}:${extCtx.model.id}`
        : "unknown";
      const providerList = [
        ...new Set([...ctx.agents.values()].map((a) => a.provider)),
      ].join(", ");
      const agentList = [...ctx.agents.values()]
        .map((a) => `  \u2022 ${a.name} [${a.model}]`)
        .join("\n");
      extCtx.ui.notify(
        `${ctx.teamConfig.team.name} \u2014 ${ctx.teamConfig.team.description}\n\n` +
          `Level: ${level?.name || "none"} (${level?.stage.type || "none"})\n` +
          `Host: ${hostLabel}\n` +
          `Agent providers: ${providerList}\n` +
          `Agents:\n${agentList}\n\n` +
          `Start working \u2014 ${getCurrentCoordinator() ? "the coordinator" : "the runtime"} will guide the process.`,
        "info",
      );

      const delegatedInputArtifact = process.env.TEAM_INPUT_ARTIFACT;
      let delegatedInputPath: string | undefined;
      let delegatedBrief: string | undefined;
      if (delegatedInputArtifact) {
        const assignmentDir = getAssignmentPath(ctx);
        delegatedInputPath = path.isAbsolute(delegatedInputArtifact)
          ? delegatedInputArtifact
          : path.join(assignmentDir, delegatedInputArtifact);
        if (fs.existsSync(delegatedInputPath)) {
          try {
            delegatedBrief = fs.readFileSync(delegatedInputPath, "utf-8");
          } catch (err) {
            console.error(
              "[team-runtime] Failed to read delegated input artifact:",
              err,
            );
          }
        }
      }

      if (level) {
        ctx.pendingStageEntryLevelId = null;
        // Startup's opening entry is an admitted entry like any other, unless a
        // restored one already covers this exact level and visit — in which
        // case that record is the resume, and re-admitting would replace the
        // pair it was admitted with by one resolved from this process's own
        // settings.
        const resumedEntry = pendingHostEntryFor(
          ctx,
          level.id,
          ctx.state.levelStates.get(level.id)?.visitCount ?? 0,
        );
        if (!resumedEntry) {
          admitHostEntryForActiveLevel();
          persistState();
        }
        const startedByRuntime = await startActiveLevel(extCtx);
        if (!startedByRuntime) {
          if (runtimeAutostartPlanned) {
            // The pair this level was admitted with, when there is one — the
            // same pair `applyHostModelPreference` is about to apply. Checking
            // readiness on a freshly resolved one would preflight a pair the
            // run is not going to use, and after a restart those differ.
            const admittedHost = hostEntryForLevel(ctx, level.id);
            const desiredHost = admittedHost
              ? {
                  provider: admittedHost.selection.provider,
                  model: admittedHost.selection.model,
                }
              : resolveDesiredHostModel(ctx.bootEntry, getCurrentCoordinator());
            const hostErrors = desiredHost
              ? validateHostProviderReadiness(
                  desiredHost.provider,
                  desiredHost.model,
                )
              : [];
            if (hostErrors.length > 0) {
              ctx.configErrors = hostErrors;
              enterConfigErrorMode(extCtx);
              updateDashboard(extCtx, ctx);
              return;
            }
            const hostModelReady = await applyHostModelPreference(pi, extCtx, ctx);
            if (!hostModelReady) {
              enterConfigErrorMode(extCtx);
              updateDashboard(extCtx, ctx);
              return;
            }
            logHostLifecycleEvent("host.model_selection.resolved", {
              resolved_host_provider: extCtx.model?.provider ?? null,
              resolved_host_model: extCtx.model?.id ?? null,
            });
          }
          enqueueFollowUp(
            ctx,
            buildStageEntryFollowUp(level, delegatedInputPath, delegatedBrief, {
              isDelegatedAutostart: Boolean(delegatedInputArtifact),
            }),
            {
              kind: "stage_entry",
              levelId: level.id,
              stageType: level.stage.type,
            },
          );
        }
      }

      updateDashboard(extCtx, ctx);
    } else if (ctx.configErrors.length > 0) {
      enterConfigErrorMode(extCtx);
    } else {
      enterSetupMode(extCtx);
    }
  }

  pi.on("input", () => {
    // An invalid configuration must not cost a host request. `before_agent_start`
    // cannot cancel a turn — its result carries only `message` and
    // `systemPrompt` — so letting the prompt through would spend the boot model
    // having an LLM narrate a failure the runtime already knows and has
    // already reported durably.
    if (ctx.configErrors.length > 0) {
      return { action: "handled" as const };
    }
    if (ctx.delegatedAutostartOwnsStage) {
      return { action: "handled" as const };
    }
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", (event, _extCtx) => {
    if (ctx.configErrors.length > 0) {
      const systemPrompt = buildConfigErrorPrompt();
      logHostLifecycleEvent("host.before_agent_start", {
        setup_mode: false,
        config_error_count: ctx.configErrors.length,
        system_prompt_length: systemPrompt.length,
        base_system_prompt_length:
          typeof event.systemPrompt === "string"
            ? event.systemPrompt.length
            : 0,
        delegated_autostart: false,
        config_error_mode: true,
      });
      return { systemPrompt };
    }

    if (ctx.setupMode) {
      // Load setup agent prompt
      const setupPromptPath = path.join(__dirname, "..", "setup", "setup-agent.md");
      if (fs.existsSync(setupPromptPath)) {
        const { body } = parseAgentFrontmatter(setupPromptPath);
        return { systemPrompt: body };
      }
      return;
    }

    if (!ctx.teamConfig) return;

    activatePendingStageEntryIfNeeded();

    const level = getCurrentLevel();
    const coordinator = getCurrentCoordinator();
    const systemPrompt = resolveHostWorkflowPrompt(
      event.systemPrompt,
      coordinator,
      level,
      ctx,
    );
    logHostLifecycleEvent("host.before_agent_start", {
      setup_mode: ctx.setupMode,
      config_error_count: ctx.configErrors.length,
      system_prompt_length:
        typeof systemPrompt === "string" ? systemPrompt.length : 0,
      base_system_prompt_length:
        typeof event.systemPrompt === "string" ? event.systemPrompt.length : 0,
      delegated_autostart: process.env.TEAM_DELEGATED_AUTOSTART === "1",
    });
    if (!systemPrompt) return;
    return { systemPrompt };
  });

  // Compaction is a provider call Pi makes before it starts the next turn
  // (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:861`). While it
  // runs, an entry that has been handed over has not started — and is not
  // failing to. Nothing else is done here: the runtime has no say in whether
  // the session compacts, only in not mistaking it for a stalled entry.
  pi.on("session_before_compact", () => {
    ctx.hostRunLifetime?.compactionStarted();
  });

  pi.on("session_compact", () => {
    ctx.hostRunLifetime?.compactionFinished();
  });

  /**
   * The ports the host turn lifecycle calls. Building them reads no runtime
   * value; each member reads or changes `ctx`, or calls the function it names,
   * when it is called.
   */
  function makeHostTurnLifecyclePorts(): HostTurnLifecyclePorts {
    return {
      // The claim's storage stays on the context, where the follow-up queue,
      // the host run lifetime and the host lifecycle log read it.
      claim: {
        current: () => ctx.outerTurnOwner,
        claim: (owner) => {
          ctx.outerTurnOwner = owner;
        },
        release: () => {
          ctx.outerTurnOwner = null;
        },
      },
      coordinatorRun: {
        read: () => ({
          runId: ctx.coordinatorRunId,
          levelAdvancedRunId: ctx.levelAdvancedCoordinatorRunId,
        }),
        raiseRunId: () => {
          ctx.coordinatorRunId++;
        },
        clearUsedLevelTools: () => {
          ctx.usedLevelToolsThisCoordinatorTurn.clear();
        },
        clearInvocationAdmissions: () => {
          capabilityPolicy.clearInvocationAdmissions();
        },
        clearFollowUpMarker: (runId) => {
          ctx.toolFailureFollowUpRunIds.delete(runId);
        },
        resetToolCallCount: () => {
          ctx.coordinatorToolCallsThisRun = 0;
        },
        clearLevelAdvanceFence: () => {
          ctx.levelAdvancedCoordinatorRunId = null;
        },
      },
      position: {
        startingPosition: () => {
          const level = getCurrentLevel();
          const coordinator = getCurrentCoordinator();
          // The admitted entry's pair, when the level has one, describes the
          // turn in preference to resolving one now.
          const admitted = hostEntryForLevel(ctx, level?.id ?? null);
          return {
            level,
            coordinator,
            admitted,
            desiredHostModelSelection: admitted
              ? undefined
              : hostModelSelection(
                  resolveDesiredHostModel(ctx.bootEntry ?? null, coordinator),
                ),
            levelIndex: ctx.state.currentLevelIndex,
          };
        },
        levelIndex: () => ctx.state.currentLevelIndex,
        currentLevel: () => getCurrentLevel(),
        currentCoordinatorName: () => getCurrentCoordinator()?.name ?? null,
        toolCallsThisRun: () => ctx.coordinatorToolCallsThisRun,
      },
      records: {
        runRecordIdentity: () => {
          if (!ctx.teamConfig || !ctx.state.sessionId) return null;
          const outputDir = getAssignmentPath(ctx);
          return {
            outputDir,
            sessionId: ctx.state.sessionId,
            rootSessionId: ctx.state.rootSessionId,
            team: ctx.teamConfig.team.name,
          };
        },
        writeAgentRun: (outputDir, event) => {
          logAgentRun(outputDir, event);
        },
        hostLifecycleEvent: (event, extra) => {
          logHostLifecycleEvent(event, extra);
        },
        assignmentOutputDir: () => getAssignmentOutputDir(),
      },
      metrics: {
        markActive: (coordinatorName) => {
          const metrics = ctx.agentMetrics.get(coordinatorName);
          if (metrics) {
            metrics.state = AGENT_STATE.ACTIVE;
            metrics.activeStartedAt = Date.now();
          }
        },
        markDoneWhenActive: (coordinatorName) => {
          const metrics = ctx.agentMetrics.get(coordinatorName);
          if (metrics && metrics.state === AGENT_STATE.ACTIVE) {
            metrics.state = AGENT_STATE.DONE;
            delete metrics.activeStartedAt;
          }
        },
      },
      hostRun: {
        turnStarted: () => {
          ctx.hostRunLifetime?.turnStarted();
        },
        turnSettled: () => {
          ctx.hostRunLifetime?.turnSettled();
        },
        runFailed: () => {
          ctx.hostRunLifetime?.runFailed();
        },
      },
      followUps: {
        anyOwed: () => ctx.pendingFollowUps.length > 0,
        flush: () => {
          flushPendingFollowUps(ctx);
        },
      },
      completion: {
        emitWhenIdle: (idle) => {
          runCompletion.emitWhenIdle(idle);
        },
        requestRunFailure: (failure) => {
          requestRunFailure(failure);
        },
      },
      settlement: {
        settleHostEntry: (levelId) => {
          settleHostEntry(ctx, levelId);
        },
        enterActiveLevelOnItsOwnPair: (extCtx) =>
          enterActiveLevelOnItsOwnPair(extCtx),
        activatePendingStageEntry: () => {
          activatePendingStageEntryIfNeeded();
        },
        discardPendingStageEntries: (reason) => {
          discardPendingStageEntries(ctx, reason);
        },
        clearPendingStageEntry: () => {
          ctx.pendingStageEntryLevelId = null;
        },
      },
      // `input` turns a prompt away while a config error is recorded.
      blockedReport: {
        configErrorRecorded: () => ctx.configErrors.length > 0,
        record: (message) => {
          ctx.configErrors = [message];
        },
        show: (extCtx) => {
          enterConfigErrorMode(extCtx);
        },
      },
      dashboard: {
        rememberExtensionContext: (extCtx) => {
          ctx.lastCtx = extCtx;
        },
        manageRefreshTimer: () => {
          manageRefreshTimer(ctx);
        },
        refresh: (extCtx) => {
          updateDashboard(extCtx, ctx);
        },
      },
      clock: {
        now: () => Date.now(),
        timestamp: () => new Date().toISOString(),
      },
    };
  }

  // The host turn's lifecycle lives in `host-turn-lifecycle.ts`, which owns the
  // outer-turn claim. `agent_start` and `agent_end` fire for every model call,
  // retries and queued continuations included; `agent_settled` fires once, when
  // the whole outer turn has ended.
  const hostTurnLifecyclePorts = makeHostTurnLifecyclePorts();

  pi.on("agent_start", (_event, extCtx) => {
    startHostTurn(extCtx, hostTurnLifecyclePorts);
  });

  pi.on("agent_end", (_event, extCtx) => {
    endHostTurn(extCtx, hostTurnLifecyclePorts);
  });

  // Returns the lifecycle's own promise, so Pi awaits the settle itself.
  pi.on("agent_settled", (_event, extCtx) =>
    settleHostTurn(extCtx, hostTurnLifecyclePorts),
  );

  pi.on("tool_execution_start", (_event, _extCtx) => {
    // Start the timer on first engine tool call
    if (!ctx.state.timerStarted && ctx.ENGINE_TOOLS.has(_event.toolName)) {
      ctx.state.startTime = Date.now();
      ctx.state.timerStarted = true;
    }
    if (ctx.teamConfig && ctx.state.sessionId) {
      const outputDir = getAssignmentPath(ctx);
      logRuntimeEvent(outputDir, {
        timestamp: new Date().toISOString(),
        event: "tool.execution_start",
        session_id: ctx.state.sessionId,
        root_session_id: ctx.state.rootSessionId,
        // Who made the call, not where the runtime has since moved to.
        ...owningTurnAttribution(),
        tool_name: _event.toolName,
        tool_call_id: _event.toolCallId,
        // The live counter beside the attributed one. The fence is an equality
        // test between these two live values
        // (`team-runtime/capability-tool-policy.ts:89-92`), so a record that
        // carried only the turn's captured id could not be used to check it.
        live_coordinator_run_id: ctx.coordinatorRunId,
        level_advanced_coordinator_run_id: ctx.levelAdvancedCoordinatorRunId,
        registered_tools: ctx.currentRegisteredTools,
      });
    }
    manageRefreshTimer(ctx);
  });

  pi.on("tool_call", (event) => {
    const bypassDecision = capabilityBypassDetector.observe(event);
    if (!ctx.teamConfig || ctx.configErrors.length > 0 || ctx.setupMode) {
      return bypassDecision?.result;
    }
    ctx.coordinatorToolCallsThisRun += 1;
    logHostLifecycleEvent("host.tool_call", {
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      tool_calls_in_turn: ctx.coordinatorToolCallsThisRun,
    });

    const outputDir = getAssignmentPath(ctx);
    const levelAllowedTools = getAllowedLevelTools();
    const callAttribution = owningTurnAttribution();

    logRuntimeEvent(outputDir, {
      timestamp: new Date().toISOString(),
      event: "tool.call_observed",
      session_id: ctx.state.sessionId,
      root_session_id: ctx.state.rootSessionId,
      // Who made the call, not where the runtime has since moved to.
      ...callAttribution,
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      // Live policy state, deliberately: the fence, the destination the
      // transition is holding, and the tools the *current* level allows are all
      // decisions about what may happen next.
      live_coordinator_run_id: ctx.coordinatorRunId,
      level_advanced_coordinator_run_id: ctx.levelAdvancedCoordinatorRunId,
      pending_stage_entry_level_id: ctx.pendingStageEntryLevelId,
      allowed_level_tools: Array.from(levelAllowedTools),
      registered_tools: ctx.currentRegisteredTools,
    });
    if (!bypassDecision) return;
    logToolUse(
      outputDir,
      event.toolName,
      event.toolCallId,
      true,
      ctx.state.rootSessionId,
      {
        blocked_capability_bypass: true,
        // The same field the policy gate writes, because a reader is owed the
        // same thing from both: a code that selects a sentence
        // (`contracts/capability-policy-denial.ts`). Without it this refusal
        // reached the timeline through the failure arm as "failed using tool",
        // with the reason discarded.
        policy_code: bypassDecision.code,
        // Who attempted it, and separately where the runtime stood when it was
        // refused. A blocked call is still a call the running turn made.
        agent_name: callAttribution.coordinator,
        level_id: callAttribution.level_id,
        current_level: getCurrentLevel()?.id ?? null,
        reason: bypassDecision.result.reason,
      },
    );
    ctx.blockedToolCallIds.add(event.toolCallId);
    suppressToolFailureFollowUpCallIds.add(event.toolCallId);
    return bypassDecision.result;
  });

  pi.on("tool_execution_end", async (event, extCtx) => {
    if (!ctx.teamConfig) return;
    ctx.lastCtx = extCtx;
    const toolErrorMessage = toolErrorMessages.get(event.toolCallId);
    if (toolErrorMessage) toolErrorMessages.delete(event.toolCallId);
    const suppressToolFailureFollowUp = suppressToolFailureFollowUpCallIds.has(
      event.toolCallId,
    );
    if (suppressToolFailureFollowUp)
      suppressToolFailureFollowUpCallIds.delete(event.toolCallId);

    // Log tool usage
    const outputDir = getAssignmentPath(ctx);
    const attribution = owningTurnAttribution();
    if (ctx.blockedToolCallIds.has(event.toolCallId)) {
      ctx.blockedToolCallIds.delete(event.toolCallId);
    } else {
      logToolUse(
        outputDir,
        event.toolName,
        event.toolCallId,
        event.isError,
        ctx.state.rootSessionId,
        {
          session_id: ctx.state.sessionId,
          team: ctx.teamConfig.team.name,
          // The turn that made the call owns the record of having made it.
          level_id: attribution.level_id,
          stage_type: attribution.stage_type,
          agent_name: attribution.coordinator,
          ...(toolErrorMessage ? { error: toolErrorMessage } : {}),
        },
      );
    }
    logRuntimeEvent(outputDir, {
      timestamp: new Date().toISOString(),
      event: "tool.execution_end",
      session_id: ctx.state.sessionId,
      root_session_id: ctx.state.rootSessionId,
      ...attribution,
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      is_error: event.isError,
      // The live counter beside the attributed one, so the fence's equality
      // test stays checkable from the record.
      live_coordinator_run_id: ctx.coordinatorRunId,
      level_advanced_coordinator_run_id: ctx.levelAdvancedCoordinatorRunId,
      registered_tools: ctx.currentRegisteredTools,
    });

    const currentLevel = getCurrentLevel();
    const coordinator = getCurrentCoordinator();
    if (
      event.isError &&
      coordinator &&
      currentLevel &&
      ctx.ENGINE_TOOLS.has(event.toolName) &&
      !suppressToolFailureFollowUp &&
      !ctx.toolFailureFollowUpRunIds.has(ctx.coordinatorRunId)
    ) {
      ctx.toolFailureFollowUpRunIds.add(ctx.coordinatorRunId);
      // Named with its level, because this starts a real turn on that level.
      // The queue uses the identity to put the level's durable record back in
      // flight before it sends: this turn can call tools and a provider, and a
      // crash during it must not read as a level with nothing outstanding.
      enqueueFollowUp(
        ctx,
        buildToolFailureFollowUp(
          currentLevel.id,
          event.toolName,
          ctx.coordinatorRunId,
          toolErrorMessage,
        ),
        { levelId: currentLevel.id, stageType: currentLevel.stage.type },
      );
    }

    // Check if current level is complete
    try {
      const currentLevel = getCurrentLevel();
      const currentLevelState = currentLevel
        ? ctx.state.levelStates.get(currentLevel.id)
        : undefined;
      if (currentLevel && currentLevelState?.status === LEVEL_STATUS.ACTIVE) {
        await tryAdvanceLevelImpl(extCtx, ctx, makeLifecycleCallbacks());
      }
    } catch (err) {
      console.error(`[team-runtime] Error checking gate: ${err}`);
    }

    manageRefreshTimer(ctx);
    updateDashboard(extCtx, ctx);
    persistState();
  });

  // Returns the teardown's own promise, so Pi awaits the whole route.
  pi.on("session_shutdown", () =>
    teardownOnSessionShutdown(runtimeTeardownPorts),
  );

  // ── Commands ──

  registerCommands(
    ctx,
    registerLevelTools,
    persistState,
    runtimeOwnsLevel,
    prepareHostForActiveLevel,
    startActiveLevel,
    reportHostRunStop,
    admitHostEntryForActiveLevel,
  );
}

async function applyHostModelPreference(
  pi: ExtensionAPI,
  extCtx: ExtensionContext,
  ctx: ReturnType<typeof createRuntimeContext>,
): Promise<boolean> {
  const level = ctx.teamConfig?.levels[ctx.state.currentLevelIndex];
  const coordinator = ctx.agents.get(
    (level?.stage as { coordinator?: string } | undefined)?.coordinator ?? "",
  );
  // The pair this level's entry was admitted with wins over resolving one now.
  //
  // Not an optimisation and not a recovery special case: it is what makes the
  // selection immutable from admission to dispatch. Within one process the two
  // agree, because the agents are loaded once at boot and the application
  // default is decoded once from this process's environment. Across a process
  // boundary they need not: `runtimeAppDefaultPair()` reads the environment the
  // *new* launch was given, so a run resumed after the default moved would
  // otherwise enter its level on a pair nobody admitted for it.
  const admitted = pendingHostEntryFor(
    ctx,
    level?.id,
    (level ? ctx.state.levelStates.get(level.id)?.visitCount : undefined) ?? 0,
  );
  const desired: HostModelSpec | null = admitted
    ? {
        provider: admitted.selection.provider,
        model: admitted.selection.model,
        source:
          admitted.selection.source === "agent" ? "coordinator" : "app-default",
      }
    : resolveDesiredHostModel(ctx.bootEntry, coordinator);
  if (!desired) return true;

  return applyDesiredHostModel(pi, extCtx, desired, {
    readAssignmentPath: () =>
      ctx.teamConfig && ctx.state.sessionId ? getAssignmentPath(ctx) : null,
    readSessionIds: () => ({
      sessionId: ctx.state.sessionId,
      rootSessionId: ctx.state.rootSessionId,
    }),
    setConfigError: (message) => {
      ctx.configErrors = [message];
    },
  });
}
