import { executeProvider, getProvider } from "../../providers/index.js";
import type { Provider } from "../../providers/types.js";
import type { ThinkingLevel } from "../../core/types.js";
import { PROVIDER_FAILURE_USER_MESSAGES } from "../../contracts/provider.js";
import {
  readAgentModelChoice,
  resolveAgentModelChoice,
} from "../../contracts/agent-model-selection.js";
import { getRuntimeDefaultModelState } from "../provider/default-model-selection.js";
import { parseProviderError } from "../provider/provider-error.js";
import {
  activeProviderFailure,
  providerFailureDiagnostic,
  type ProviderFailureObservation,
  type ProviderFailureSnapshot,
} from "../provider/provider-failure-projection.js";
import {
  providerUsageDiagnostic,
  readingRetiresUsageLimit,
  readProviderUsage,
  type ProviderUsageCost,
  type ProviderUsageReading,
  type ProviderUsageSource,
} from "../provider/provider-usage.js";
import { KNOWN_AGENT_PROVIDER_NAMES } from "../provider/provider-preflight.js";
import {
  isConfiguredProviderName,
  type LocalCliAgentView,
} from "../provider/provider-settings.js";
import { listAgents } from "./list-agents.js";
import type { Diagnostic, DiagnosticKind } from "../../contracts/health.js";
import type {
  AgentProviderHealth,
  AgentProviderHealthTarget,
  AgentSummary,
} from "./types.js";

const PING_TIMEOUT_MS = 8000;
const HEALTH_CHECK_MAX_OUTPUT_TOKENS = 16;
const CLI_PROVIDER_LABELS = new Map([
  ["codex", "Codex CLI"],
  ["claude", "Claude Code"],
  ["gemini", "Gemini CLI"],
  ["kimi-cli", "Kimi Code CLI"],
  ["qwen", "Qwen Code"],
  ["pi", "Pi"],
]);
const API_PING_PROVIDERS: ReadonlySet<string> = new Set(
  KNOWN_AGENT_PROVIDER_NAMES.filter(
    (providerName) => !CLI_PROVIDER_LABELS.has(providerName),
  ),
);

export interface AgentProviderCliSettingsReader {
  listCliAgents(forceRefresh?: boolean): Promise<LocalCliAgentView[]>;
}

interface ProviderHealthResult {
  status: AgentProviderHealth["status"];
  message?: string;
  /** Why the check ended this way, in the shared diagnostic vocabulary. */
  kind?: DiagnosticKind;
  /** The provider actually answered a call, rather than local settings did. */
  pinged?: boolean;
  latencyMs?: number;
}

/**
 * What an earlier run found, when this check has nothing fresher to say.
 *
 * A provider that just answered a live call has disproved whatever a past run
 * discovered, so the ping wins. So does a ping that failed: it is the newest
 * and most specific account of the same provider. Everything else — a CLI
 * whose local settings say "installed and enabled", a provider this build
 * cannot ping at all — is not evidence about the account behind it, and there
 * the run's own experience is the only thing anyone knows.
 */
/**
 * What an allowance reading is worth saying about one agent, if anything.
 *
 * A provider that just answered a live call has proved the account works now,
 * which a reading from an earlier moment cannot overrule. The two facts are
 * not in conflict — an account at 95% answers perfectly well — so the reading
 * still warns; it simply does not get to call an account spent that just
 * replied.
 */
function providerUsageDiagnosticFor(input: {
  reading: ProviderUsageReading | undefined;
  agentName: string;
  now: Date;
  answeredLive?: boolean;
}): Diagnostic | undefined {
  if (!input.reading) return undefined;
  const stated = providerUsageDiagnostic(
    input.reading,
    { agentName: input.agentName },
    input.now,
  );
  if (!stated || !input.answeredLive) return stated;
  return { ...stated, severity: "warning" };
}

function runtimeFailureObservation(input: {
  snapshot: ProviderFailureSnapshot | undefined;
  provider: string;
  model: string;
  result: ProviderHealthResult;
  now: Date;
}): ProviderFailureObservation | undefined {
  if (!input.snapshot) return undefined;
  if (input.result.status === "error") return undefined;
  if (input.result.status === "ok" && input.result.pinged === true) {
    return undefined;
  }
  return activeProviderFailure(
    input.snapshot,
    { provider: input.provider, model: input.model },
    input.now,
  );
}

/**
 * Whether a later allowance reading has overtaken what a run found.
 *
 * Only a usage limit can be overtaken this way. That failure is a statement
 * about the provider's windows, and a reading measures those windows directly,
 * so a later one is simply the better account of them. The other account
 * failures are not about a window at all: a reading says nothing about whether
 * a key is valid, a plan is paid for, or a model is permitted, and letting one
 * retire those would clear a badge on evidence that never addressed it.
 *
 * This is the only thing that can retire a CLI provider's usage limit. Nothing
 * pings a CLI, so without it a limit found once is reported until the derived
 * file is deleted by hand — long after the windows it described rolled over.
 *
 * The reading has to earn it; `readingRetiresUsageLimit` holds the conditions.
 * Every way of failing them leaves the failure standing, which is the answer
 * that keeps a real limit visible.
 */
function retiredByAllowanceReading(
  observed: ProviderFailureObservation,
  reading: ProviderUsageReading | undefined,
  now: Date,
): boolean {
  if (observed.kind !== "usage_limit") return false;
  return readingRetiresUsageLimit({
    reading,
    failedAt: observed.observedAt,
    now,
  });
}

/**
 * One unhealthy answer, written so it still makes sense away from the row.
 *
 * The agent's own list shows its name beside the icon, but the same sentence
 * has to serve a Team badge naming a member, a log line, and a chat reply. It
 * is built once, here, rather than reassembled by whoever is drawing.
 */
function buildAgentDiagnostics(input: {
  agentName: string;
  provider?: string | undefined;
  model?: string | undefined;
  status: AgentProviderHealth["status"];
  message: string;
  kind: DiagnosticKind;
}): { diagnostics: Diagnostic[]; message: string } {
  if (input.status === "ok") {
    return { diagnostics: [], message: input.message };
  }
  const subject = `Agent '${input.agentName}'${
    input.provider ? ` (${input.provider})` : ""
  }`;
  const message = `${subject}: ${input.message}`;
  return {
    diagnostics: [
      {
        severity: input.status === "error" ? "error" : "warning",
        kind: input.kind,
        message,
        subject: {
          agentName: input.agentName,
          ...whenDefined(input.provider, (provider) => ({ provider })),
          ...whenDefined(input.model, (model) => ({ model })),
        },
      },
    ],
    message,
  };
}

export async function checkAgentProviderHealth(params: {
  repoRoot: string;
  agentNames?: string[];
  targets?: AgentProviderHealthTarget[];
  cliSettingsReader?: AgentProviderCliSettingsReader;
  /** What past runs discovered, projected from the execution journal. */
  providerFailures?: ProviderFailureSnapshot;
  /**
   * Who can say how much of a provider's allowance is left.
   *
   * Passed in rather than reached for, like the CLI settings reader beside it.
   * The only source that exists reads a directory under the user's home, and a
   * check that helped itself to that would answer differently depending on
   * whose machine it ran on — including in tests, which is how this was found.
   */
  usageSources?: readonly ProviderUsageSource[];
  /**
   * What this check may spend to find out. Free by default: a sidebar render
   * must never buy an answer, however useful the answer would be.
   */
  usageMaxCost?: ProviderUsageCost;
  now?: Date;
}): Promise<AgentProviderHealth[]> {
  const now = params.now ?? new Date();
  const usageSources = params.usageSources ?? [];
  // One reading per provider, not per agent: the allowance belongs to the
  // account, and a list of twelve agents on one CLI asks its source once.
  const usageByProvider = new Map<string, Promise<ProviderUsageReading | undefined>>();
  const usageFor = (provider: string) => {
    let reading = usageByProvider.get(provider);
    if (!reading) {
      reading = readProviderUsage({
        provider,
        sources: usageSources,
        ...whenDefined(params.usageMaxCost, (maxCost) => ({ maxCost })),
      });
      usageByProvider.set(provider, reading);
    }
    return reading;
  };
  const agents = listAgents(params.repoRoot);
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const declaredTargets =
    params.targets && params.targets.length > 0
      ? params.targets
      : params.agentNames && params.agentNames.length > 0
      ? params.agentNames.map((name) => byName.get(name) ?? missingAgent(name))
      : agents;
  // Resolve inheritance before loading CLI settings or checking providers, so
  // the library badge checks the same pair as the editor and runtime.
  const appDefault = getRuntimeDefaultModelState();
  const targets = declaredTargets.map((agent) => {
    const agentName = "name" in agent ? agent.name : agent.agentName;
    if (!params.targets?.length && !byName.has(agentName)) {
      return {
        agentName,
        provider: undefined,
        model: undefined,
        selectionError: "Agent was not found in the library.",
      };
    }
    const reading = readAgentModelChoice(agent);
    const resolved = reading.choice
      ? resolveAgentModelChoice(reading.choice, appDefault)
      : undefined;
    if (resolved?.ok) {
      return {
        agentName,
        provider: resolved.selection.provider,
        model: resolved.selection.model,
        selectionError: undefined,
      };
    }
    const error = resolved?.error ?? reading.error;
    return {
      agentName,
      provider: error?.provider,
      model: error?.model,
      selectionError: error?.message ?? "Agent model selection could not be determined.",
    };
  });

  let cliAgents: LocalCliAgentView[] | undefined;
  let cliSettingsError: string | undefined;
  if (
    targets.some((agent) =>
      agent.provider ? CLI_PROVIDER_LABELS.has(agent.provider) : false,
    )
  ) {
    if (params.cliSettingsReader) {
      try {
        cliAgents = await params.cliSettingsReader.listCliAgents(false);
      } catch (error) {
        cliSettingsError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const cache = new Map<string, Promise<ProviderHealthResult>>();

  return Promise.all(
    targets.map(async (agent) => {
      const agentName = agent.agentName;
      const checkedAt = new Date().toISOString();
      if (agent.selectionError || !agent.provider || !agent.model) {
        const selectionFailure = buildAgentDiagnostics({
          agentName,
          provider: agent.provider,
          model: agent.model,
          status: "unknown",
          message: agent.selectionError ?? "Agent model selection could not be determined.",
          kind: "config",
        });
        return {
          agentName,
          ...whenDefined(agent.provider, (provider) => ({ provider })),
          ...whenDefined(agent.model, (model) => ({ model })),
          status: "unknown",
          message: selectionFailure.message,
          checkedAt,
          diagnostics: selectionFailure.diagnostics,
        };
      }

      const cacheKey = `${agent.provider}\u0000${agent.model}`;
      let health = cache.get(cacheKey);
      if (!health) {
        health = CLI_PROVIDER_LABELS.has(agent.provider)
          ? Promise.resolve(resolveCliProviderHealth({
              providerName: agent.provider,
              model: agent.model,
              cliAgents,
              cliSettingsError,
            }))
          : pingProvider(agent.provider, agent.model);
        cache.set(cacheKey, health);
      }

      const result = await health;
      // Evidence in order of how directly it speaks about now: a live call
      // just made, then a failure a run actually hit, then a reading taken at
      // some earlier moment. A weaker one never speaks over a stronger one —
      // except where the two describe the very same window, which is what
      // `retiredByAllowanceReading` decides.
      const fromRun = runtimeFailureObservation({
        snapshot: params.providerFailures,
        provider: agent.provider,
        model: agent.model,
        result,
        now,
      });
      // Asked for only where it could change the answer, so a source that
      // charges for a reading is never billed for a failure it cannot speak to.
      const reading =
        result.status === "error" ||
        (fromRun !== undefined && fromRun.kind !== "usage_limit")
          ? undefined
          : await usageFor(agent.provider);
      const disprovedRuntimeFailureAt =
        fromRun !== undefined && retiredByAllowanceReading(fromRun, reading, now)
          ? fromRun.observedAt
          : undefined
      const stated =
        fromRun !== undefined && disprovedRuntimeFailureAt === undefined
          ? providerFailureDiagnostic(fromRun, { agentName })
          : result.status === "error"
            ? undefined
            : providerUsageDiagnosticFor({
                reading,
                agentName,
                now,
                answeredLive: result.pinged === true,
              });
      if (stated) {
        return {
          agentName,
          provider: agent.provider,
          model: agent.model,
          status: stated.severity,
          message: stated.message,
          checkedAt,
          ...whenDefined(result.latencyMs, (latencyMs) => ({ latencyMs })),
          diagnostics: [stated],
          ...whenDefined(disprovedRuntimeFailureAt, (at) => ({
            disprovedRuntimeFailureAt: at,
          })),
          ...(result.pinged === true ? { answeredLivePing: true } : {}),
        };
      }
      const checked = buildAgentDiagnostics({
        agentName,
        provider: agent.provider,
        model: agent.model,
        status: result.status,
        message: result.message ?? "Provider status could not be determined.",
        kind: result.kind ?? "unknown",
      });
      return {
        agentName,
        provider: agent.provider,
        model: agent.model,
        status: result.status,
        message: checked.message,
        checkedAt,
        ...whenDefined(result.latencyMs, (latencyMs) => ({ latencyMs })),
        diagnostics: checked.diagnostics,
        ...whenDefined(disprovedRuntimeFailureAt, (at) => ({
          disprovedRuntimeFailureAt: at,
        })),
        ...(result.pinged === true ? { answeredLivePing: true } : {}),
      };
    }),
  );
}

function resolveCliProviderHealth(params: {
  providerName: string;
  model: string;
  cliAgents: readonly LocalCliAgentView[] | undefined;
  cliSettingsError: string | undefined;
}): ProviderHealthResult {
  const label = CLI_PROVIDER_LABELS.get(params.providerName) ?? params.providerName;
  if (!params.cliAgents) {
    return {
      status: "unknown",
      kind: "config",
      message: params.cliSettingsError
        ? `${label} status could not be checked: ${params.cliSettingsError}`
        : `${label} status has not been loaded from AI Providers.`,
    };
  }
  const cliAgent = params.cliAgents.find(
    (candidate) => candidate.id === params.providerName,
  );
  if (!cliAgent?.available) {
    return {
      status: "error",
      kind: "config",
      message: `${label} is not installed or is not available on PATH.`,
    };
  }
  if (!cliAgent.enabled) {
    return {
      status: "error",
      kind: "config",
      message: `Enable ${label} in AI Providers.`,
    };
  }
  if (
    !cliAgent.models.some(
      (candidate) => candidate.id === params.model && candidate.enabled,
    )
  ) {
    return {
      status: "error",
      kind: "config",
      message: `Enable model '${params.model}' for ${label} in AI Providers.`,
    };
  }
  return {
    status: "ok",
    message: `${label} and model '${params.model}' are enabled.`,
  };
}

function missingAgent(name: string): AgentSummary {
  return {
    name,
    skills: [],
    usedInTeams: [],
  };
}

async function pingProvider(
  providerName: string,
  model: string,
): Promise<ProviderHealthResult> {
  if (!supportsProviderHealthPing(providerName)) {
    return {
      status: "unknown",
      kind: "config",
      message: `Provider '${providerName}' does not expose an API health ping.`,
    };
  }

  let provider: Provider;
  try {
    provider = getProvider(providerName);
  } catch (error) {
    return {
      status: "error",
      kind: "config",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

  try {
    await executeProvider(provider, {
      systemPrompt: "Health check. Reply with OK only.",
      userMessage: "OK",
      model,
      thinking: "low" as ThinkingLevel,
      signal: controller.signal,
      providerConfig: {
        reasoning: false,
        thinking_budget: 0,
        max_tokens: HEALTH_CHECK_MAX_OUTPUT_TOKENS,
        max_output_tokens: HEALTH_CHECK_MAX_OUTPUT_TOKENS,
        temperature: 0,
      },
    });
    return {
      status: "ok",
      message: "Provider responded.",
      pinged: true,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (controller.signal.aborted) {
      return {
        status: "error",
        kind: "timeout",
        message: `Provider '${providerName}' health check timed out.`,
        latencyMs,
      };
    }
    const parsed = parseProviderError(error);
    // Only a failure the provider itself answered with is reclassified.
    // Without a status or an error code the taxonomy is guessing from English,
    // and it guesses badly on this app's own preflight errors: "Configured
    // provider 'x' is unavailable. Revalidate it in Settings." is a setup fault
    // and reads as a transient outage. Those keep the sentence they were
    // written with, which is both accurate and already safe to show.
    const providerAnswered =
      parsed.statusCode !== undefined || parsed.code !== undefined;
    if (!providerAnswered || parsed.kind === "unknown") {
      return { status: "error", kind: "unknown", message: parsed.message, latencyMs };
    }
    // The same taxonomy a failed run is classified by, so an exhausted key
    // reads identically whether a ping or a turn found it. The kind is the
    // whole of what crosses: a provider's prose can carry an account
    // identifier, an API key, or a slice of the request, and none of that
    // belongs on a badge.
    return {
      status: "error",
      kind: parsed.kind,
      message: PROVIDER_FAILURE_USER_MESSAGES[parsed.kind],
      latencyMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function supportsProviderHealthPing(providerName: string): boolean {
  return API_PING_PROVIDERS.has(providerName) || isConfiguredProviderName(providerName);
}
import { whenDefined } from '../../core/optional-properties.js'
