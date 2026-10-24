import { TriangleAlert } from "lucide-react";

import { ProviderIcon } from "@/components/ui/provider-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import type { ProviderCatalogGroup } from "@/lib/clients/provider-settings-client";
import { isModelUnresolved } from "@/lib/utils/model-catalog";
import { cn } from "@/lib/utils/utils";

/**
 * Resolves the icon slug for a runtime provider. Configured connections are
 * stored as `connection:<id>`, which carries no brand on its own — look the
 * connection up in the provider catalog and reuse its model/group icon.
 */
export function resolveProviderIconSlug(
  provider: string,
  model: string | undefined,
  groups: ProviderCatalogGroup[],
): string {
  const group = groups.find((entry) => entry.provider === provider);
  if (!group) return provider;
  const match = model
    ? group.models.find((entry) => entry.id === model.trim())
    : undefined;
  return match?.icon || group.icon || provider;
}

export function ProviderModelIcon({
  className,
  model,
  provider,
}: {
  className?: string;
  model?: string | undefined;
  provider: string;
}) {
  const catalog = useProviderCatalog();
  const unresolved = isModelUnresolved(model);
  const modelLabel = unresolved ? "Model unavailable" : model!.trim();
  const accessibleLabel = unresolved
    ? "Model unavailable"
    : `Model: ${modelLabel}`;
  const iconProvider = resolveProviderIconSlug(provider, model, catalog.groups);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          aria-label={accessibleLabel}
          render={
            <span
              className={cn(
                "inline-flex size-3.5 shrink-0 items-center justify-center",
                className,
              )}
            />
          }
        >
          {unresolved ? (
            <TriangleAlert className="size-full text-orange-500" />
          ) : (
            <ProviderIcon provider={iconProvider} className="size-full" />
          )}
        </TooltipTrigger>
        <TooltipContent side="top">{modelLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
