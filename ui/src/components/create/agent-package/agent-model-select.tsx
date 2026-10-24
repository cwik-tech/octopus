import { useMemo } from "react";

import { ModelSelect } from "@/components/ui/model-select";
import { ProviderHealthBadge } from "@/components/ui/provider-health-badge";
import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import {
  applyPersonaAppDefault,
  applyPersonaModel,
  parsePersonaModelMode,
} from "./persona-frontmatter";
import { useAgentModelHealth } from "./use-agent-model-health";

/**
 * The agent's model, read from and written to its persona frontmatter.
 *
 * Two configuration choices and no third: the agent's own pair, or the one
 * application default. Default mode is stored as the absence of a pair, so
 * reopening the agent after the default changes still shows inheritance.
 */
export function AgentModelSelect(props: {
  agentName: string | null;
  personaMarkdown: string;
  onPersonaChange: (value: string) => void;
  className?: string;
}) {
  const modelChoice = useMemo(
    () => parsePersonaModelMode(props.personaMarkdown),
    [props.personaMarkdown],
  );
  const { defaultModelState } = useProviderCatalog();
  const inheriting = modelChoice.mode === "app-default";
  // A half-configured pair is shown as the model it names. The runtime refuses
  // it, and showing inheritance instead would say the agent is fine.
  const effective =
    modelChoice.mode === "explicit"
      ? { provider: modelChoice.provider, model: modelChoice.model }
      : modelChoice.mode === "invalid"
        ? {
            provider: modelChoice.provider ?? "",
            model: modelChoice.model ?? "",
          }
        : defaultModelState.status === "unset"
          ? { provider: "", model: "" }
          : {
              provider: defaultModelState.provider,
              model: defaultModelState.model,
            };
  // Health is checked against the pair that would actually run.
  const modelHealth = useAgentModelHealth({
    agentName: props.agentName,
    provider: effective.provider,
    model: effective.model,
  });

  return (
    <ModelSelect
      provider={effective.provider}
      model={effective.model}
      onChange={(choice) =>
        props.onPersonaChange(
          applyPersonaModel(props.personaMarkdown, choice.provider, choice.model),
        )
      }
      appDefaultOption={{
        selected: inheriting,
        onSelect: () => {
          if (inheriting) return;
          props.onPersonaChange(applyPersonaAppDefault(props.personaMarkdown));
        },
      }}
      placeholder={inheriting ? "No app default set" : "Select model"}
      className={props.className}
      currentStatus={
        <ProviderHealthBadge
          health={modelHealth.health}
          loading={modelHealth.loading && !modelHealth.health}
          className="text-xs"
        />
      }
      aria-label="Agent model"
    />
  );
}
