/**
 * Arms the active level's tools on the Pi host.
 *
 * `index.ts` returns before calling `armLevelTools` when there is no Team
 * config, no session id or no current level, and passes the level it read.
 * In order, `armLevelTools` creates the assignment directory, ensures the
 * capability dispatcher, throws when that left no budget adoption scope,
 * clears the capability policy's registrations and publishes this arming's
 * tool list and invoker map. It publishes the live collections before the
 * first registration and each registration fills them as it succeeds, so a
 * throw part way leaves the tools registered before it as the runtime's
 * current tools.
 *
 * It then registers the stage type's tools, the delegation tools and
 * `inspect-task-state` when the level may spawn teams, the five tools every
 * level gets, the skill loader and the governed Pi file tools the coordinator
 * was granted. It replaces the bypass detector's governed tools and the host's
 * active tools with this level's names, and writes `tools.registered`.
 *
 * It reads no environment and no runtime context. It asks for the engine
 * context once, where the stage tools' context is built. Values a tool reads
 * when it runs, and values arming reads at a later step, come through ports
 * called at those moments.
 */
import * as fs from "node:fs";
import { whenDefined } from "../core/optional-properties.js";
import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  BaseEngineContext,
  LevelConfig,
  TeamConfig,
} from "../core/types.js";
import { STAGE_TYPE } from "../core/constants.js";
import { logRuntimeEvent } from "../domains/runtime/logger.js";
import type { RuntimeToolInvoker } from "../domains/runtime/runtime-context.js";
import { INSPECT_TASK_STATE_TOOL_NAME } from "../core/tool-policy.js";
import {
  createDiscussionTool,
  type DiscussionContext,
} from "../engines/discussion.js";
import {
  createSetRosterTool,
  createBriefTool,
} from "../engines/discussion-tools.js";
import { createPipelineTool } from "../engines/pipeline.js";
import { createChainTool } from "../engines/chain.js";
import { createBroadcastTool } from "../engines/broadcast.js";
import { createReviewTool } from "../engines/review.js";
import {
  createSpawnTeamTool,
  type SpawnTeamContext,
} from "../engines/spawn-tools.js";
import {
  createSpawnWorkflowTool,
  type SpawnWorkflowContext,
} from "../engines/spawn-workflows.js";
import { inspectTaskState } from "../domains/sessions/inspect-task-state.js";
import { createBrowserTool } from "../domains/browser/browser-tool.js";
import { createResearchWebTool } from "../domains/acquisition/research-web-tool.js";
import { createYoutubeTool } from "../domains/youtube/youtube-tool.js";
import { createGenerateWordTool } from "../domains/word-generation/generate-word-tool.js";
import { createGenerateExcelTool } from "../domains/excel-generation/generate-excel-tool.js";
import { Type, type TSchema } from "typebox";
import {
  createStandaloneSkillLoaderTool,
  STANDALONE_SKILL_LOADER_TOOL_NAME,
} from "./standalone-skill-loader-tool.js";
import type { CapabilityDispatcher } from "../core/capability-dispatcher.js";
import type {
  CapabilityExecutionContext,
  CapabilityInvocationIdentity,
} from "../contracts/capability-dispatch.js";
import {
  createDefaultTeamRuntimeToolAdapterFactory,
  governTeamRuntimeTool,
  type TeamRuntimeToolAdapterFactory,
} from "./capability-tool-adapter.js";
import type { TeamRuntimeCapabilityRegistration } from "./capability-tool-policy.js";
import type { TeamRuntimeCapabilityBudgetPort } from "./capability-budget-port.js";
import {
  createPipelinePiToolAdapterFactory,
  registerEnabledPipelinePiTools,
  type PipelinePiToolRegistrar,
} from "./governed-pi-tools.js";
import {
  createDelegationToolAdapterFactory,
  createEngineToolAdapterFactory,
} from "../services/engine-capability-adapter.js";
import {
  createSkillLoaderCapabilityDispatchInvoker,
  SKILL_LOADER_CAPABILITY_ID,
} from "../services/skill-loader-capability-adapter.js";
import { serialCapabilityEffect } from "../contracts/capability-effect.js";
import { BROWSER_CAPABILITY_ID } from "../services/browser-capability-adapter.js";
import { RESEARCH_WEB_CAPABILITY_ID } from "../services/research-web-capability-adapter.js";
import { YOUTUBE_CAPABILITY_ID } from "../services/youtube-capability-adapter.js";
import { GENERATE_WORD_CAPABILITY_ID } from "../services/generate-word-capability-adapter.js";
import { GENERATE_EXCEL_CAPABILITY_ID } from "../services/generate-excel-capability-adapter.js";

const TEAM_RUNTIME_MODEL_SOURCE = {
  kind: "engine" as const,
  id: "team-runtime:pi-model",
  version: "1",
};
const TEAM_RUNTIME_PI_SOURCE = {
  kind: "pi-host" as const,
  id: "team-runtime:pi-model",
  version: "1",
};

function getStageFailureOverride(stage: LevelConfig["stage"]): "retry" | "fallback" | "skip" | "halt" | undefined {
  if (stage.type === STAGE_TYPE.ROUTING) return undefined;
  return stage.config.on_agent_failure;
}

/** What `index.ts` read at entry, before any effect of arming. */
export interface LevelToolArmingInput {
  readonly teamConfig: TeamConfig;
  readonly level: LevelConfig;
  /** The assignment directory arming creates and writes its records under. */
  readonly outputPath: string;
  /** The source every governed tool gives its runtime-channel invocations. */
  readonly runtimeSource: CapabilityInvocationIdentity["source"];
}

/**
 * The runtime values and engine callbacks the stage and spawn tool factories
 * take. The breadth is retained because `BaseEngineContext` and
 * `SpawnTeamContext` require these values; `DiscussionContext` adds
 * `humanQuestions` and `onStateCheckpoint`.
 */
export type LevelToolEngineContext =
  & Pick<
    BaseEngineContext,
    | "teamRootPath"
    | "agents"
    | "rosterEntries"
    | "state"
    | "inputFilesContent"
    | "agentMetrics"
    | "humanInputRouting"
    | "rateLimiter"
    | "budgetLedger"
  >
  & Required<Pick<
    BaseEngineContext,
    | "shutdownSignal"
    | "onDashboardUpdate"
    | "recoveryMode"
    | "delegatedAutostart"
    | "chatMode"
  >>
  & Pick<
    SpawnTeamContext,
    | "teamRegistry"
    | "activeSpawnCountRef"
    | "assignmentLocation"
    | "coordinatorName"
  >
  & Required<Pick<
    SpawnTeamContext,
    "getCurrentCoordinatorRunId" | "setDelegationStatus"
  >>
  & Required<Pick<DiscussionContext, "humanQuestions" | "onStateCheckpoint">>;

/**
 * The capability-layer operations arming performs, each at a fixed step:
 * ensure the dispatcher and read the budget scope it set, clear and register
 * policy entries, replace the bypass list, record raw errors and safety
 * refusals, and build the execution context a governed call runs under. Each
 * member is one operation, and none reads the runtime context.
 */
export interface LevelToolCapabilities {
  /** Ensures the dispatcher, then reads the budget adoption scope it set. */
  ensureDispatcher(): {
    readonly dispatcher: CapabilityDispatcher;
    readonly budgetAdoptionScope: TeamRuntimeCapabilityBudgetPort | undefined;
  };
  clearPolicyRegistrations(): void;
  registerPolicy(registration: TeamRuntimeCapabilityRegistration): void;
  replaceGovernedTools(toolNames: string[]): void;
  /** Stores the message a governed tool's own failure raised, under its call id. */
  recordRawToolError(toolCallId: string, message: string): void;
  recordRefusedToolCall(input: {
    readonly gate: "blocked_tool_safety";
    readonly toolName: string;
    readonly toolCallId: string;
    readonly code: string;
    readonly reason: string;
  }): void;
  buildExecutionContext(): CapabilityExecutionContext;
}

/** Runtime values read when a tool runs or when `tools.registered` is written. */
export interface LevelToolLiveReads {
  sessionId(): string;
  rootSessionId(): string | undefined;
  /** The current level's coordinator's name, or undefined when it has none. */
  currentCoordinatorName(): string | undefined;
  totalCostUsd(): number;
}

/** Values arming reads at a later step of its own, each read at that step. */
export interface LevelToolLookups {
  /** Read where the spawn branch decides on `spawn_workflow`. */
  workflowRegistry(): SpawnWorkflowContext["workflowRegistry"];
  /** Read where the skill loader is created. */
  repoRoot(): string;
  /** Read after the skill loader registers. */
  grantedGovernedPiTools(): string[];
  /** Read when `tools.registered` is written. */
  allowedLevelTools(): Set<string>;
}

export interface LevelToolPorts {
  readonly registrar: Pick<ExtensionAPI, "registerTool" | "setActiveTools">;
  readonly capabilities: LevelToolCapabilities;
  /** Called with the live collections before the first registration. */
  publishCurrentTools(
    registeredTools: string[],
    toolInvokers: Map<string, RuntimeToolInvoker>,
  ): void;
  /** Called once, where the stage tools' context is built. */
  engineContext(): LevelToolEngineContext;
  readonly live: LevelToolLiveReads;
  readonly lookups: LevelToolLookups;
}

export function armLevelTools(
  input: LevelToolArmingInput,
  ports: LevelToolPorts,
): void {
  const { teamConfig, level, outputPath } = input;
  const { registrar, capabilities, live, lookups } = ports;

  const workspacePath = teamConfig.workspace.path;
  fs.mkdirSync(outputPath, { recursive: true });
  const { dispatcher, budgetAdoptionScope } = capabilities.ensureDispatcher();
  if (!budgetAdoptionScope) {
    throw new Error("Team Runtime capability budget port is unavailable.");
  }
  const registeredTools: string[] = [];
  const toolInvokers = new Map<string, RuntimeToolInvoker>();
  capabilities.clearPolicyRegistrations();

  // The live collections are published before the first registration, and
  // each registration fills them as it succeeds. A throw later in arming
  // (the skill loader, the Pi tools) leaves the tools that did register as the
  // runtime's current tools, not the previous level's.
  ports.publishCurrentTools(registeredTools, toolInvokers);

  function registerGovernedTool<
    TParams extends TSchema,
    TDetails,
    TState,
  >(
    tool: ToolDefinition<TParams, TDetails, TState>,
    adapterFactory: TeamRuntimeToolAdapterFactory<TParams, TDetails>,
    modelSource: CapabilityInvocationIdentity["source"],
  ): void {
    const governed = governTeamRuntimeTool({
      tool,
      dispatcher,
      ...whenDefined(budgetAdoptionScope, (scope) => ({ budgetAdoptionScope: scope })),
      getContext: () => capabilities.buildExecutionContext(),
      modelSource,
      runtimeSource: input.runtimeSource,
      adapterFactory,
      onRawError: (toolCallId, error) => {
        capabilities.recordRawToolError(
          toolCallId,
          error instanceof Error ? error.message : String(error),
        );
      },
    });
    registrar.registerTool(governed.definition);
    toolInvokers.set(tool.name, governed.runtimeInvoker);
    capabilities.registerPolicy({
      capabilityId: adapterFactory.capabilityId,
      toolName: tool.name,
    });
    registeredTools.push(tool.name);
  }

  const stageFailureOverride = getStageFailureOverride(level.stage);

  const engineContext = ports.engineContext();
  const commonCtx = {
    ...engineContext,
    teamName: teamConfig.team.name,
    teamConfig,
    levelId: level.id,
    stageType: level.stage.type,
    workspacePath,
    outputPath,
    adoptCapabilityBudget: (toolCallId: string) =>
      budgetAdoptionScope.adopt(toolCallId),
    onRosterSelected: (participants: readonly string[]) => {
      logRuntimeEvent(outputPath, {
        timestamp: new Date().toISOString(),
        event: "discussion.roster.selected",
        session_id: live.sessionId(),
        root_session_id: live.rootSessionId(),
        level_id: level.id,
        stage_type: level.stage.type,
        participants: [...participants],
      });
    },
    ...whenDefined(level.permissions, (permissions) => ({ permissions })),
    ...(level.stage.type === STAGE_TYPE.ROUTING ? { routingOutput: level.stage.config.output } : {}),
    ...whenDefined(stageFailureOverride, (stageFailureOverride) => ({ stageFailureOverride })),
  };

  switch (level.stage.type) {
    case STAGE_TYPE.ROUTING:
      break;
    case STAGE_TYPE.DISCUSSION: {
      registerGovernedTool(
        createSetRosterTool({ ...commonCtx, config: level.stage }),
        createEngineToolAdapterFactory({
          toolName: "set_roster",
          readTotalCostUsd: () => live.totalCostUsd(),
        }),
        TEAM_RUNTIME_MODEL_SOURCE,
      );
      registerGovernedTool(
        createBriefTool({ ...commonCtx, config: level.stage }),
        createEngineToolAdapterFactory({
          toolName: "create_brief",
          readTotalCostUsd: () => live.totalCostUsd(),
        }),
        TEAM_RUNTIME_MODEL_SOURCE,
      );
      registerGovernedTool(
        createDiscussionTool({ ...commonCtx, config: level.stage }),
        createEngineToolAdapterFactory({
          toolName: "converse",
          readTotalCostUsd: () => live.totalCostUsd(),
        }),
        TEAM_RUNTIME_MODEL_SOURCE,
      );
      break;
    }
    case STAGE_TYPE.PIPELINE: {
      registerGovernedTool(
        createPipelineTool({ ...commonCtx, config: level.stage }),
        createEngineToolAdapterFactory({
          toolName: "dispatch",
          readTotalCostUsd: () => live.totalCostUsd(),
        }),
        TEAM_RUNTIME_MODEL_SOURCE,
      );
      break;
    }
    case STAGE_TYPE.CHAIN: {
      registerGovernedTool(
        createChainTool({ ...commonCtx, config: level.stage }),
        createEngineToolAdapterFactory({
          toolName: "handoff",
          readTotalCostUsd: () => live.totalCostUsd(),
        }),
        TEAM_RUNTIME_MODEL_SOURCE,
      );
      break;
    }
    case STAGE_TYPE.BROADCAST: {
      registerGovernedTool(
        createBroadcastTool({ ...commonCtx, config: level.stage }),
        createEngineToolAdapterFactory({
          toolName: "broadcast",
          readTotalCostUsd: () => live.totalCostUsd(),
        }),
        TEAM_RUNTIME_MODEL_SOURCE,
      );
      break;
    }
    case STAGE_TYPE.REVIEW: {
      registerGovernedTool(
        createReviewTool({ ...commonCtx, config: level.stage }),
        createEngineToolAdapterFactory({
          toolName: "submit_for_review",
          readTotalCostUsd: () => live.totalCostUsd(),
        }),
        TEAM_RUNTIME_MODEL_SOURCE,
      );
      break;
    }
  }

  if (level.permissions?.spawn_teams) {
    registerGovernedTool(
      createSpawnTeamTool(commonCtx),
      createDelegationToolAdapterFactory({
        toolName: "spawn_team",
        assignmentPath: outputPath,
        readTotalCostUsd: () => live.totalCostUsd(),
      }),
      TEAM_RUNTIME_MODEL_SOURCE,
    );
    if (lookups.workflowRegistry().size > 0) {
      registerGovernedTool(
        createSpawnWorkflowTool({
          ...commonCtx,
          workflowRegistry: lookups.workflowRegistry(),
        }),
        createDelegationToolAdapterFactory({
          toolName: "spawn_workflow",
          assignmentPath: outputPath,
          readTotalCostUsd: () => live.totalCostUsd(),
        }),
        TEAM_RUNTIME_MODEL_SOURCE,
      );
    }
    // inspect-task-state — read-only mid-run Q&A tool for the receptionist
    // Implementation: domains/sessions/inspect-task-state.ts
    const inspectTaskStateTool = defineTool({
      name: INSPECT_TASK_STATE_TOOL_NAME,
      label: "Inspect Task State",
      description:
        "Retrieve the current state of a running or completed task. " +
        "Returns stage progress, status (running/done/error/not_found), " +
        "and a summary of recent conversation messages. " +
        "Use when the user asks what is happening with a running task.",
      promptSnippet:
        "Use `inspect-task-state` to check on a running task. " +
        "Find the taskId in the '[system] Active task: {taskId}' message in conversation history.",
      parameters: Type.Object({
        taskId: Type.String({
          description:
            "The task ID to inspect. Look for '[system] Active task: {taskId}' in conversation history.",
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _extensionCtx) {
        const result = await inspectTaskState({
          taskId: params.taskId,
          ...whenDefined(live.sessionId() || undefined, (sessionId) => ({
            sessionId,
          })),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });
    registerGovernedTool(
      inspectTaskStateTool,
      createDefaultTeamRuntimeToolAdapterFactory({
        capabilityId: "team-runtime.tool.inspect-task-state",
        effect: serialCapabilityEffect("read-only"),
        risk: "read-only",
      }),
      TEAM_RUNTIME_PI_SOURCE,
    );
  }

  // browser — local Chrome automation. Registered globally; only agents whose
  // `tools:` allowlist includes `browser` can pass the dispatch policy.
  registerGovernedTool(
    createBrowserTool({
      signal: engineContext.shutdownSignal,
      getAgentPath: () => {
        const coordinatorName = live.currentCoordinatorName()
        return coordinatorName !== undefined ? `agents/${coordinatorName}` : undefined
      },
    }),
    createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: BROWSER_CAPABILITY_ID,
      effect: serialCapabilityEffect("unknown"),
      risk: "browser-interaction",
    }),
    TEAM_RUNTIME_PI_SOURCE,
  );

  // research_web — parent-owned discovery and evidence acquisition. Chrome is
  // one fallback inside this gateway rather than the research abstraction.
  registerGovernedTool(
    createResearchWebTool({
      signal: engineContext.shutdownSignal,
      getAgentPath: () => {
        const coordinatorName = live.currentCoordinatorName()
        return coordinatorName !== undefined ? `agents/${coordinatorName}` : undefined
      },
    }),
    createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: RESEARCH_WEB_CAPABILITY_ID,
      effect: serialCapabilityEffect("read-only"),
      risk: "external-read",
    }),
    TEAM_RUNTIME_PI_SOURCE,
  );

  // youtube_extract — parent-owned transcript capture. The runtime exposes it
  // globally, while the active agent allowlist and parent service both enforce
  // that only the dedicated YouTube extractor may call it.
  registerGovernedTool(
    createYoutubeTool({
      signal: engineContext.shutdownSignal,
      getAgentPath: () => {
        const coordinatorName = live.currentCoordinatorName()
        return coordinatorName !== undefined ? `agents/${coordinatorName}` : undefined
      },
    }),
    createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: YOUTUBE_CAPABILITY_ID,
      effect: serialCapabilityEffect("mutating"),
      risk: "artifact-write",
    }),
    TEAM_RUNTIME_PI_SOURCE,
  );

  // generate_word — deterministic Markdown-to-DOCX publication. Registered
  // globally; the active agent allowlist and parent service enforce access.
  registerGovernedTool(
    createGenerateWordTool({
      signal: engineContext.shutdownSignal,
      getAgentPath: () => {
        const coordinatorName = live.currentCoordinatorName()
        return coordinatorName !== undefined ? `agents/${coordinatorName}` : undefined
      },
    }),
    createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: GENERATE_WORD_CAPABILITY_ID,
      effect: serialCapabilityEffect("mutating"),
      risk: "artifact-write",
    }),
    TEAM_RUNTIME_PI_SOURCE,
  );

  // generate_excel — deterministic Markdown/template-to-XLSX publication.
  // Registered globally; the active agent allowlist and parent service
  // enforce access.
  registerGovernedTool(
    createGenerateExcelTool({
      signal: engineContext.shutdownSignal,
      getAgentPath: () => {
        const coordinatorName = live.currentCoordinatorName()
        return coordinatorName !== undefined ? `agents/${coordinatorName}` : undefined
      },
    }),
    createDefaultTeamRuntimeToolAdapterFactory({
      capabilityId: GENERATE_EXCEL_CAPABILITY_ID,
      effect: serialCapabilityEffect("mutating"),
      risk: "artifact-write",
    }),
    TEAM_RUNTIME_PI_SOURCE,
  );

  const skillLoaderTool = createStandaloneSkillLoaderTool({
    dispatchInvoker: createSkillLoaderCapabilityDispatchInvoker({
      repoRootPath: lookups.repoRoot(),
      dispatcher,
    }),
    getInvocationContext: () => {
      const executionContext = capabilities.buildExecutionContext();
      return {
        context: {
          contractVersion: 1,
          requestId: executionContext.requestId,
          sessionId: executionContext.sessionId,
          runId: executionContext.runId,
          assignmentId: executionContext.assignmentId,
          ...(executionContext.taskId
            ? { taskId: executionContext.taskId }
            : {}),
          agentPath: executionContext.agentPath,
          ...(executionContext.workflowId
            ? { workflowId: executionContext.workflowId }
            : {}),
          ...(executionContext.workflowStepId
            ? { workflowStepId: executionContext.workflowStepId }
            : {}),
          ...(executionContext.agentId
            ? { agentId: executionContext.agentId }
            : {}),
          ...(executionContext.agentDisplayName
            ? { agentDisplayName: executionContext.agentDisplayName }
            : {}),
          ...(executionContext.activityScopeId
            ? { activityScopeId: executionContext.activityScopeId }
            : {}),
        },
        authority: executionContext.authority,
      };
    },
  });
  registrar.registerTool(skillLoaderTool);
  capabilities.registerPolicy({
    capabilityId: SKILL_LOADER_CAPABILITY_ID,
    toolName: skillLoaderTool.name,
  });
  registeredTools.push(STANDALONE_SKILL_LOADER_TOOL_NAME);

  const enabledPiTools = new Set(lookups.grantedGovernedPiTools());
  const piRegistrar: PipelinePiToolRegistrar = {
    register: (registration) => {
      registerGovernedTool(
        registration.tool,
        createPipelinePiToolAdapterFactory({
          name: registration.name,
          cwd: outputPath,
          effect: registration.effect,
          // The safety gate's refusals reach the same record the capability
          // policy's do. They cannot arrive through `onDenied`: this denial
          // is the one the dispatcher resolves
          // (`core/capability-policy.ts:25`) while the policy is allowing the
          // same call, so nothing else would ever say the call was refused.
          onRefused: (refusal) =>
            capabilities.recordRefusedToolCall({
              gate: "blocked_tool_safety",
              toolName: refusal.toolName,
              toolCallId: refusal.toolCallId,
              code: refusal.decision.code,
              reason: refusal.decision.reason,
            }),
        }),
        TEAM_RUNTIME_PI_SOURCE,
      );
    },
  };
  registerEnabledPipelinePiTools({
    cwd: outputPath,
    enabled: enabledPiTools,
    registrar: piRegistrar,
  });

  capabilities.replaceGovernedTools(registeredTools);

  // Registering a tool is not the same as the host being able to call it.
  //
  // Every Team host launch passes `--no-builtin-tools` (`core/pi-runtime.ts:98`),
  // which in the installed Pi keeps the built-in definitions in the tool
  // registry and starts them inactive. A tool an extension registers later
  // joins the active set only when its *name* was new to that registry
  // (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:2005-2012`).
  // The governed file tools reuse the built-in names on purpose, so their
  // names are never new: Pi swaps the definition in and leaves the tool
  // inactive, and a coordinator granted `write` is told "Tool write not
  // found". Naming this level's tools is what makes the persona's `tools:`
  // list reach the model.
  //
  // The set is replaced rather than added to, so the previous level's tools
  // do not stay callable after the run has moved on.
  registrar.setActiveTools([...new Set(registeredTools)]);

  logRuntimeEvent(outputPath, {
    timestamp: new Date().toISOString(),
    event: "tools.registered",
    session_id: live.sessionId(),
    root_session_id: live.rootSessionId(),
    level_id: level.id,
    stage_type: level.stage.type,
    registered_tools: registeredTools,
    allowed_level_tools: Array.from(lookups.allowedLevelTools()),
    coordinator: live.currentCoordinatorName() ?? null,
    coordinator_run_id: engineContext.getCurrentCoordinatorRunId(),
  });
}
