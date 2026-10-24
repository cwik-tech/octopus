import type { ProviderCatalogGroup } from "@/lib/clients/provider-settings-client";

export interface ModelChoice {
  provider: string;
  model: string;
}

export const DEFAULT_MODEL_CHOICE: ModelChoice = {
  provider: "",
  model: "",
};

const SEPARATOR = "::";

export function encodeModelValue(provider: string, model: string): string {
  return `${provider}${SEPARATOR}${model}`;
}

export function decodeModelValue(value: string): ModelChoice {
  const index = value.indexOf(SEPARATOR);
  if (index === -1) return { provider: "", model: value };
  return {
    provider: value.slice(0, index),
    model: value.slice(index + SEPARATOR.length),
  };
}

/**
 * Sentinel model id used when no concrete model has been resolved yet
 * (mirrors DEFAULT_MODEL in core/constants.ts).
 */
export const UNRESOLVED_MODEL_ID = "default";

export function isModelUnresolved(model: string | null | undefined): boolean {
  const value = model?.trim();
  return !value || value === UNRESOLVED_MODEL_ID;
}

export function formatProvider(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

export function isModelChoiceAvailable(
  groups: readonly ProviderCatalogGroup[],
  choice: ModelChoice,
  capability: "chat" | "pdf" = "chat",
): boolean {
  return groups.some(
    (group) =>
      group.provider === choice.provider &&
      group.models.some(
        (model) =>
          model.id === choice.model &&
          (model.capabilities?.includes(capability) ?? capability === "chat"),
      ),
  );
}
