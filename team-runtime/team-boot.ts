/**
 * What a Team Runtime boot decides from the Team config it parsed and the
 * values it read from the environment.
 *
 * These functions are pure: they read only their arguments, change nothing
 * and return decisions or values. `entryLevelActivation` throws on a level
 * list with no entry level, and throwing is its only effect.
 *
 * `boot` in `index.ts` reads the files, the environment and the file parser,
 * prints, returns early and writes the runtime state. It asks
 * `bootConfigSource` where the config comes from and parses it, then asks
 * `resolveTeamBoot` once and applies that plan between its own steps, asking
 * `assignmentLocationRefusal` only when resolving the assignment location
 * throws. Once the config is committed it asks `toRosterEntrySlim`,
 * `initialAgentMetrics`, `pendingLevelStates` and then `entryLevelActivation`.
 */
import {
  AGENT_STATE,
  DEFAULT_BUDGET_POLICY,
  DEFAULT_SESSION_BUDGET_USD,
  LEVEL_STATUS,
  STAGE_TYPE,
} from "../core/constants.js";
import type { BudgetPolicy } from "../core/budget-ledger.js";
import type {
  AgentMetrics,
  AgentRosterEntry,
  LevelState,
  RosterEntrySlim,
  TeamConfig,
  TeamRegistryEntry,
  TeamRuntimeOverrides,
} from "../core/types.js";
import { getInitialStageStatus } from "../domains/stage/stage-lifecycle.js";

/** Where a boot's Team config comes from, or why there is none. */
export type BootConfigSource =
  | { readonly kind: "refused"; readonly errors: string[] }
  | { readonly kind: "setup" }
  | { readonly kind: "config"; readonly configPath: string };

/** What `TEAM_CONFIG_OVERRIDES_JSON` held. */
export type RuntimeOverridesReading =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly errors: string[] }
  | { readonly kind: "overrides"; readonly overrides: TeamRuntimeOverrides };

/** What `TEAM_BOOT_ENTRY_JSON` held. */
export type BootEntryReading =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly errors: string[] }
  | { readonly kind: "entry"; readonly entry: TeamRegistryEntry };

/** The budget ledger a boot creates. */
export interface BootBudget {
  readonly capUsd: number;
  readonly policy: BudgetPolicy;
}

/** The entry level a boot marks active, and the status it gives it. */
export interface EntryLevelActivation {
  readonly levelId: string;
  readonly status: LevelState["status"];
  readonly stageStatus: LevelState["stageStatus"];
}

/**
 * The config path when the boot resolution found one; otherwise its errors,
 * or setup mode when it found neither.
 */
export function bootConfigSource(resolution: {
  readonly configPath?: string;
  readonly errors: string[];
}): BootConfigSource {
  if (resolution.configPath) {
    return { kind: "config", configPath: resolution.configPath };
  }
  if (resolution.errors.length > 0) {
    return { kind: "refused", errors: resolution.errors };
  }
  return { kind: "setup" };
}

/** The config error for a Team whose `team.building` is `true`. */
function buildingTeamRefusal(config: TeamConfig): string[] | undefined {
  if (config.team?.building !== true) return undefined;
  return [
    `Team '${config.team.name}' is still being built and cannot be run yet. ` +
      `Wait for its build to finish.`,
  ];
}

/** The config error for an assignment location that failed to resolve. */
export function assignmentLocationRefusal(error: unknown): string[] {
  return [error instanceof Error ? error.message : String(error)];
}

/**
 * Reads `TEAM_CONFIG_OVERRIDES_JSON`. An empty or missing value is absent;
 * a value that is not JSON or not a runtime-overrides shape is invalid.
 */
function readRuntimeOverrides(raw: string | undefined): RuntimeOverridesReading {
  if (!raw) return { kind: "absent" };
  const overrides = parseJson(raw);
  if (!isTeamRuntimeOverrides(overrides)) {
    return { kind: "invalid", errors: ["Invalid TEAM_CONFIG_OVERRIDES_JSON."] };
  }
  return { kind: "overrides", overrides };
}

/**
 * Reads `TEAM_BOOT_ENTRY_JSON`. An empty or missing value is absent; a value
 * that is not JSON or not a Team registry entry is invalid.
 */
function readBootEntryOverride(raw: string | undefined): BootEntryReading {
  if (!raw) return { kind: "absent" };
  const entry = parseJson(raw);
  if (!isTeamRegistryEntry(entry)) {
    return { kind: "invalid", errors: ["Invalid TEAM_BOOT_ENTRY_JSON."] };
  }
  return { kind: "entry", entry };
}

/**
 * The lines of the configuration-warnings banner, one `console.warn` each.
 * Empty when there are no warnings.
 */
function configWarningLines(warnings: readonly string[] | undefined): string[] {
  if (!warnings || warnings.length === 0) return [];
  const yellow = "\x1b[33m";
  const bold = "\x1b[1m";
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const warnIcon = "⚠";

  return [
    "",
    `${yellow}${bold}╔══════════════════════════════════════════════════════════════╗${reset}`,
    `${yellow}${bold}║  ${warnIcon}  CONFIG WARNINGS (${warnings.length})${" ".repeat(Math.max(0, 39 - String(warnings.length).length))}║${reset}`,
    `${yellow}${bold}╚══════════════════════════════════════════════════════════════╝${reset}`,
    ...warnings.map((w) => `${yellow}  ${warnIcon}  ${w}${reset}`),
    `${dim}${"─".repeat(64)}${reset}`,
    "",
  ];
}

/**
 * The boot entry: the one `TEAM_BOOT_ENTRY_JSON` named, else the start
 * entry the boot resolution found, else none.
 */
function resolveBootEntry(
  envEntry: TeamRegistryEntry | null,
  resolvedEntry: TeamRegistryEntry | undefined,
): TeamRegistryEntry | null {
  return envEntry ?? resolvedEntry ?? null;
}

/**
 * The budget ledger's cap and policy, or `undefined` when the boot keeps no
 * ledger. The cap is the first of a positive `TEAM_BUDGET_CAP`, the config's
 * `budget.cap_usd`, its spawn limit's `maxTotalBudgetUsd` and the session
 * default. The policy is a `TEAM_BUDGET_POLICY` of `halt` or `warn`, else the
 * config's `budget.on_exceed`, else the default. There is no ledger when the
 * config sets `budget.enforce: false` and `TEAM_BUDGET_CAP` is not positive,
 * or when the cap is infinite.
 */
function resolveBootBudget(input: {
  readonly config: TeamConfig;
  readonly envBudgetCap: string | undefined;
  readonly envBudgetPolicy: string | undefined;
}): BootBudget | undefined {
  const configBudget = input.config.budget;
  const envBudgetCap = parseFloat(input.envBudgetCap ?? "");
  const configuredBudgetPolicy = input.envBudgetPolicy;
  const envBudgetPolicy: BudgetPolicy | undefined =
    configuredBudgetPolicy === "halt" || configuredBudgetPolicy === "warn"
      ? configuredBudgetPolicy
      : undefined;
  const effectiveCap =
    (envBudgetCap > 0 ? envBudgetCap : undefined) ??
    configBudget?.cap_usd ??
    input.config.composition?.spawn_limits?.maxTotalBudgetUsd ??
    DEFAULT_SESSION_BUDGET_USD;
  const shouldEnforce = configBudget?.enforce !== false || envBudgetCap > 0;
  const effectivePolicy: BudgetPolicy =
    envBudgetPolicy ?? configBudget?.on_exceed ?? DEFAULT_BUDGET_POLICY;
  if (
    shouldEnforce &&
    effectiveCap !== undefined &&
    effectiveCap < Infinity
  ) {
    return { capUsd: effectiveCap, policy: effectivePolicy };
  }
  return undefined;
}

/** The environment values boot's configuration decisions read. Reading them has no effect. */
export interface TeamBootEnvironment {
  /** `TEAM_CONFIG_OVERRIDES_JSON`. */
  readonly configOverridesJson: string | undefined;
  /** `TEAM_BOOT_ENTRY_JSON`. */
  readonly bootEntryJson: string | undefined;
  /** `TEAM_BUDGET_CAP`. */
  readonly budgetCap: string | undefined;
  /** `TEAM_BUDGET_POLICY`. */
  readonly budgetPolicy: string | undefined;
}

/**
 * Boot's decisions for a parsed Team config. The shell applies them in this
 * order, with its own steps between: refuse a team still being built; apply
 * `TEAM_WORKSPACE_PATH` and resolve the assignment location; refuse invalid
 * runtime overrides, or apply valid ones, since applying them changes the
 * config; refuse an invalid boot entry, or take the one named; print the
 * warning lines; commit the config with the resolved boot entry; set a new
 * rate limiter when the config configures one, and otherwise keep the one an
 * earlier boot set; then replace the budget ledger, or remove it when the
 * plan has no budget.
 */
export interface TeamBootPlan {
  readonly buildingRefusal: string[] | undefined;
  readonly runtimeOverrides: RuntimeOverridesReading;
  readonly bootEntry: BootEntryReading;
  /**
   * The entry the run boots with once the checks above pass: the one
   * `TEAM_BOOT_ENTRY_JSON` names, else the start entry, else none.
   */
  readonly resolvedBootEntry: TeamRegistryEntry | null;
  readonly warningLines: string[];
  /** The budget ledger's cap and policy, or `undefined` for no ledger. */
  readonly budget: BootBudget | undefined;
}

/**
 * Boot's configuration decisions for a parsed Team config. Applying runtime
 * overrides changes only levels, gates and workflow, and the budget reads
 * only `budget` and `composition.spawn_limits`, so the budget decided here is
 * the one the overridden config would give.
 */
export function resolveTeamBoot(input: {
  readonly config: TeamConfig;
  readonly warnings: readonly string[] | undefined;
  /** The entry `start.yaml` names, when boot found the config through one. */
  readonly resolvedEntry: TeamRegistryEntry | undefined;
  readonly env: TeamBootEnvironment;
}): TeamBootPlan {
  const bootEntry = readBootEntryOverride(input.env.bootEntryJson);
  return {
    buildingRefusal: buildingTeamRefusal(input.config),
    runtimeOverrides: readRuntimeOverrides(input.env.configOverridesJson),
    bootEntry,
    resolvedBootEntry: resolveBootEntry(
      bootEntry.kind === "entry" ? bootEntry.entry : null,
      input.resolvedEntry,
    ),
    warningLines: configWarningLines(input.warnings),
    budget: resolveBootBudget({
      config: input.config,
      envBudgetCap: input.env.budgetCap,
      envBudgetPolicy: input.env.budgetPolicy,
    }),
  };
}

/** The roster entry the runtime keeps for an agent or Team in the roster. */
export function toRosterEntrySlim(entry: AgentRosterEntry): RosterEntrySlim {
  return {
    type: entry.type,
    ...(entry.role ? { role: entry.role } : {}),
    ...(entry.team_path ? { team_path: entry.team_path } : {}),
    ...(entry.input_artifact ? { input_artifact: entry.input_artifact } : {}),
    ...(entry.output_artifact ? { output_artifact: entry.output_artifact } : {}),
    ...(entry.host_model ? { host_model: entry.host_model } : {}),
    ...(entry.host_provider ? { host_provider: entry.host_provider } : {}),
    ...(entry.mount ? { mount: entry.mount } : {}),
    ...(entry.on_failure ? { on_failure: entry.on_failure } : {}),
  };
}

/** The metrics a loaded agent starts with: idle, with nothing spent. */
export function initialAgentMetrics(agent: {
  readonly model: string;
  readonly color: number;
}): AgentMetrics {
  return {
    state: AGENT_STATE.IDLE,
    rounds: 0,
    totalCost: 0,
    contextTokens: 0,
    model: agent.model,
    color: agent.color,
    failureCount: 0,
  };
}

/** A new pending level state for each level, in the levels' order. */
export function pendingLevelStates(
  levels: readonly { readonly id: string }[],
): Array<readonly [string, LevelState]> {
  return levels.map((level) => [
    level.id,
    {
      status: LEVEL_STATUS.PENDING,
      stageStatus: getInitialStageStatus(false),
      engineState: null,
      loopbackCount: 0,
    },
  ]);
}

/**
 * The entry level to mark active, or `undefined` when there are no levels.
 * Throws when there are levels but none at `entryLevelIndex`.
 */
export function entryLevelActivation(
  levels: readonly { readonly id: string }[],
  entryLevelIndex: number,
): EntryLevelActivation | undefined {
  if (levels.length === 0) return undefined;
  const entryLevel = levels[entryLevelIndex];
  if (!entryLevel) throw new Error("Team configuration has no initial level");
  return {
    levelId: entryLevel.id,
    status: LEVEL_STATUS.ACTIVE,
    stageStatus: getInitialStageStatus(true),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isTeamRuntimeOverrides(value: unknown): value is TeamRuntimeOverrides {
  if (!isRecord(value)) return false;
  if (
    value.stage_type !== undefined &&
    (typeof value.stage_type !== "string" || !Object.values(STAGE_TYPE).some((stage) => stage === value.stage_type))
  ) return false;
  if (value.levels === undefined) return true;
  if (!isRecord(value.levels)) return false;
  return Object.values(value.levels).every((level) => {
    if (!isRecord(level)) return false;
    const discussion = level.discussion;
    const review = level.review;
    return (discussion === undefined || (
      isRecord(discussion) &&
      isOptionalStringArray(discussion.participants) &&
      (discussion.min_rounds === undefined || typeof discussion.min_rounds === "number") &&
      (discussion.max_rounds === undefined || typeof discussion.max_rounds === "number") &&
      (discussion.min_successful_participants === undefined || typeof discussion.min_successful_participants === "number")
    )) && (review === undefined || (
      isRecord(review) &&
      (review.max_iterations === undefined || typeof review.max_iterations === "number")
    ));
  });
}

function isTeamRegistryEntry(value: unknown): value is TeamRegistryEntry {
  if (!isRecord(value) || value.type !== "team" || typeof value.name !== "string" || typeof value.team_path !== "string") {
    return false;
  }
  if (!isOptionalString(value.description) || !isOptionalStringArray(value.tags)) return false;
  return isOptionalString(value.input_artifact) &&
    isOptionalString(value.output_artifact) &&
    isOptionalString(value.requested_capability) &&
    isOptionalString(value.host_model) &&
    isOptionalString(value.host_provider) &&
    (value.mount === undefined || (Array.isArray(value.mount) && value.mount.every((mount) =>
      isRecord(mount) && typeof mount.from === "string" && typeof mount.to === "string",
    )));
}
