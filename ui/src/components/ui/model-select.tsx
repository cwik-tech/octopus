import { ChevronsUpDown, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import type {
  ProviderCatalogGroup,
  ProviderModelInfo,
} from "@/lib/clients/provider-settings-client";
import {
  encodeModelValue,
  type ModelChoice,
} from "@/lib/utils/model-catalog";
import { cn } from "@/lib/utils/utils";

interface ModelSelectProps {
  provider?: string | undefined;
  model?: string | undefined;
  onChange: (choice: ModelChoice) => void;
  /**
   * Where the selection this control writes for itself goes.
   *
   * `fallbackToFirstAvailable` fills an empty picker from an effect, through
   * the same callback a click uses. A caller that has to tell a person's choice
   * from the control's own housekeeping passes this; without it the two are
   * indistinguishable and the automatic write goes to `onChange` as before.
   */
  onAutoSelect?: ((choice: ModelChoice) => void) | undefined;
  className?: string | undefined;
  contentClassName?: string;
  size?: "sm" | "default";
  disabled?: boolean | undefined;
  placeholder?: string;
  /**
   * Write a selection into an empty or unavailable picker. Off by default,
   * because an empty pair may be deliberate inheritance.
   */
  fallbackToFirstAvailable?: boolean | undefined;
  capability?: "chat" | "pdf";
  groups?: ProviderCatalogGroup[];
  currentStatus?: ReactNode;
  /**
   * Offers "Use app default" as the first choice, for a caller whose empty
   * pair means inheriting the application default. While `selected`, the
   * caller passes the default's own pair so the trigger names what will run,
   * and that model's entry is not ticked as though it had been chosen.
   */
  appDefaultOption?: { selected: boolean; onSelect: () => void };
  showIndicator?: boolean;
  id?: string;
  "aria-label"?: string;
  dialogTitle?: string;
  dialogDescription?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
}

export function ModelSelect({
  provider,
  model,
  onChange,
  onAutoSelect,
  className,
  contentClassName,
  size = "sm",
  disabled,
  placeholder = "Select model",
  fallbackToFirstAvailable = false,
  capability = "chat",
  groups: providedGroups,
  currentStatus,
  appDefaultOption,
  showIndicator = true,
  id,
  "aria-label": ariaLabel,
  dialogTitle = "Select model",
  dialogDescription = "Search enabled models from connected providers and local CLI agents.",
  searchPlaceholder = "Search models...",
  emptyMessage = "No enabled models. Configure providers in Settings.",
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const catalog = useProviderCatalog();
  const groups = useMemo(
    () =>
      (providedGroups ?? catalog.groups)
        .map((group) => ({
          ...group,
          models: group.models.filter((entry) =>
            supportsCapability(entry, capability),
          ),
        }))
        .filter((group) => group.models.length > 0),
    [capability, catalog.groups, providedGroups],
  );
  const loading = catalog.loading;
  const error = catalog.error;
  const currentProvider = provider?.trim() ?? "";
  const currentModel = model?.trim() ?? "";
  const current = useMemo(() => {
    const group = groups.find((entry) => entry.provider === currentProvider);
    const entry = group?.models.find((candidate) => candidate.id === currentModel);
    return group && entry ? { group, entry } : null;
  }, [currentModel, currentProvider, groups]);
  /**
   * The one application default, and nothing else.
   *
   * Catalog order is deliberately not a second candidate. Reaching for the
   * first entry would invent an application-wide default nobody selected,
   * which is the hierarchy this picker exists to have removed.
   */
  const defaultChoice = useMemo(() => {
    const selection = catalog.defaultModel;
    if (!selection) return null;
    return groups.some(
      (group) =>
        group.provider === selection.provider &&
        group.models.some((entry) => entry.id === selection.model),
    )
      ? selection
      : null;
  }, [catalog.defaultModel, groups]);

  // Only a caller that asks for it gets a selection written on its behalf, and
  // only into a genuinely empty pair. An empty pair can mean "inherit the
  // application default", and filling it in would turn deliberate inheritance
  // into an explicit choice nobody made.
  //
  // A pair that is set but absent from the catalog is left exactly as it is. It
  // is a deliberate selection that currently cannot run, and the user has to be
  // told which selection is broken rather than moved quietly onto another one.
  useEffect(() => {
    if (fallbackToFirstAvailable && !currentModel && defaultChoice) {
      (onAutoSelect ?? onChange)(defaultChoice);
    }
  }, [currentModel, fallbackToFirstAvailable, defaultChoice, onAutoSelect, onChange]);

  const triggerText = current?.entry.name || currentModel || placeholder;
  const inheriting = appDefaultOption?.selected ?? false;
  const defaultName = useMemo(() => {
    const selection = catalog.defaultModel;
    if (!selection) return null;
    const group = groups.find((entry) => entry.provider === selection.provider);
    return (
      group?.models.find((entry) => entry.id === selection.model)?.name ??
      selection.model
    );
  }, [catalog.defaultModel, groups]);
  const triggerIcon = current?.entry.icon || current?.group.icon;

  return (
    <>
      <button
        id={id}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-2 text-left text-sm shadow-xs outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
          size === "sm" ? "h-8" : "h-9",
          className,
        )}
      >
        {triggerIcon ? <ProviderIcon provider={triggerIcon} /> : null}
        <span className="min-w-0 flex-1 truncate">{triggerText}</span>
        {inheriting && currentModel ? (
          <span className="shrink-0 text-xs text-muted-foreground">Default</span>
        ) : null}
        {currentModel && currentStatus ? currentStatus : null}
        {currentModel && !current && !currentStatus ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-xs text-orange-600 dark:text-orange-400"
            title="Configured model is not available in the catalog"
          >
            <TriangleAlert className="size-3.5 text-orange-500" />
            Unavailable
          </span>
        ) : null}
        {showIndicator ? (
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={dialogTitle}
        description={dialogDescription}
        className={cn(
          "desktop-shell top-1/2 flex max-h-[calc(100dvh-3rem)] -translate-y-1/2 flex-col sm:max-w-md",
          contentClassName,
        )}
      >
        <Command className="min-h-0 h-[min(32rem,calc(100dvh-3rem))] max-h-[inherit] p-0">
          <CommandInput placeholder={searchPlaceholder} autoFocus />
          <CommandList className="min-h-0 flex-1 max-h-none overflow-y-auto pr-1">
            <CommandEmpty>
              {loading
                ? "Loading available models..."
                : error
                  ? `Unable to load models: ${error}`
                  : emptyMessage}
            </CommandEmpty>
            {appDefaultOption ? (
              <CommandGroup>
                <CommandItem
                  value="Use app default"
                  data-checked={inheriting}
                  onSelect={() => {
                    appDefaultOption.onSelect();
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">Use app default</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {defaultName ?? "None set"}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {currentModel && (!current || currentStatus) ? (
              <CommandGroup heading="Current configuration">
                <CommandItem disabled value={`unavailable-${currentProvider}-${currentModel}`}>
                  <ProviderIcon provider={currentProvider || "models"} />
                  <span className="min-w-0 flex-1 truncate">{currentModel}</span>
                  {currentStatus ?? (
                    <span className="inline-flex items-center gap-1 text-xs text-orange-600 dark:text-orange-400">
                      <TriangleAlert className="size-3.5 text-orange-500" />
                      Unavailable
                    </span>
                  )}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groups.map((group) => (
              <CommandGroup key={group.provider} heading={group.name}>
                {group.models.map((entry) => {
                  const selected =
                    !inheriting &&
                    group.provider === currentProvider &&
                    entry.id === currentModel;
                  return (
                    <CommandItem
                      key={encodeModelValue(group.provider, entry.id)}
                      value={`${group.name} ${entry.name} ${entry.id}`}
                      data-checked={selected}
                      onSelect={() => {
                        onChange({ provider: group.provider, model: entry.id });
                        setOpen(false);
                      }}
                    >
                      <ProviderIcon provider={entry.icon || group.icon} />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {entry.free ? (
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                          Free
                        </span>
                      ) : null}
                      {entry.contextLength ? (
                        <span className="text-xs text-muted-foreground">
                          {formatContextLength(entry.contextLength)}
                        </span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}

function supportsCapability(
  model: ProviderModelInfo,
  capability: "chat" | "pdf",
): boolean {
  if (!model.capabilities) return capability === "chat";
  return model.capabilities.includes(capability);
}

function formatContextLength(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}
