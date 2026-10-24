import {
  readAgentModelChoice,
  resolveAgentModelChoice,
  type AppDefaultModelState,
  type ModelSelectionError,
  type ModelSelectionSource,
} from "@contracts/agent-model-selection";
import { formatProvider } from "@/lib/utils/model-catalog";
import type { TeamRosterAgentRuntime } from "@/lib/models/team-builder-model";

/**
 * The provider/model a roster entry will actually run with, and where it came
 * from.
 *
 * This calls the same pure rule the runtime calls, with the agent's own persona
 * as the only member-level input. A team contributes nothing, so the roster can
 * never advertise a pair the run would not use.
 */
export function resolveRosterAgentRuntime(
  agent: TeamRosterAgentRuntime,
  appDefault: AppDefaultModelState,
): {
  provider: string;
  model: string;
  source?: ModelSelectionSource;
  error?: ModelSelectionError;
} {
  const reading = readAgentModelChoice({
    ...(agent.personaProvider ? { provider: agent.personaProvider } : {}),
    ...(agent.personaModel ? { model: agent.personaModel } : {}),
  });
  if (!reading.choice) {
    return {
      provider: "",
      model: "",
      ...(reading.error ? { error: reading.error } : {}),
    };
  }
  const resolved = resolveAgentModelChoice(reading.choice, appDefault);
  if (!resolved.ok) {
    return { provider: "", model: "", error: resolved.error };
  }
  return {
    provider: resolved.selection.provider,
    model: resolved.selection.model,
    source: resolved.selection.source,
  };
}

/** Short chip label naming where an agent's runtime came from. */
export function formatRuntimeSource(
  source: ModelSelectionSource | undefined,
): string {
  if (source === "agent") return "agent model";
  if (source === "app-default") return "app default";
  return "not resolved";
}

export function formatAgentModelLabel(
  provider: string | undefined,
  model: string,
): string {
  if (!model) return "No model";
  return provider ? `${formatProvider(provider)} / ${model}` : model;
}
