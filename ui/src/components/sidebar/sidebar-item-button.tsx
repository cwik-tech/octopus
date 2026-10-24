import { Info, Loader2, Plus, Trash2 } from "lucide-react";
import { useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const sidebarItemClassName =
  "w-full rounded-lg px-2.5 py-1.5 text-left transition-colors";

export function SidebarItemButton({
  descriptionTooltip,
  label,
  labelTrailing,
  rowTooltip,
  rowStatus,
  leading,
  pressed,
  checked,
  meta,
  metaIcon,
  metaIconLabel,
  auxiliaryAction,
  auxiliaryActionIcon,
  auxiliaryActionLabel,
  auxiliaryActionAlwaysVisible = false,
  onClick,
  onAuxiliaryAction,
  onDelete,
  onPreview,
  previewLabel,
  deleting = false,
  selected,
}: {
  descriptionTooltip?: string | undefined;
  label: string;
  labelTrailing?: ReactNode;
  rowTooltip?: ReactNode;
  /**
   * A condition the row is in, for assistive technology.
   *
   * The row's `aria-label` is its whole accessible name and replaces
   * everything nested inside it, so a status shown only as a nested icon is
   * never announced. `name` joins the row's name; `description` becomes its
   * accessible description, carrying what `rowTooltip` shows visually.
   */
  rowStatus?: { name: string; description: string } | undefined;
  /** Slot before the label, e.g. a multi-select box. */
  leading?: ReactNode;
  /** Set when the row is a toggle rather than a navigation target. */
  pressed?: boolean | undefined;
  /**
   * Set where the row is one option in a single-choice list. The row then
   * reports itself as a radio, which is what tells a screen reader that
   * picking this one drops the previous pick. Multi-select rows use
   * `pressed` instead; a row never carries both.
   */
  checked?: boolean | undefined;
  meta?: string | null | undefined;
  metaIcon?: ReactNode;
  metaIconLabel?: string;
  auxiliaryAction?: ReactNode;
  auxiliaryActionIcon?: ReactNode;
  auxiliaryActionLabel?: string;
  /** Set where the action is the row's purpose rather than an extra. */
  auxiliaryActionAlwaysVisible?: boolean;
  onClick: () => void;
  onAuxiliaryAction?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  onPreview?: () => void;
  previewLabel?: string;
  deleting?: boolean;
  selected?: boolean;
}) {
  const hasInfoButton = Boolean(descriptionTooltip) || Boolean(onPreview);
  const infoAriaLabel = previewLabel ?? `View description for ${label}`;
  const rowStatusDescriptionId = useId();
  const actionCount =
    Number(hasInfoButton) +
    Number(Boolean(auxiliaryAction || onAuxiliaryAction)) +
    Number(Boolean(onDelete));
  const row = (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-label={rowStatus ? `${label} — ${rowStatus.name}` : label}
      {...(rowStatus ? { "aria-describedby": rowStatusDescriptionId } : {})}
      {...(checked === undefined
        ? { "aria-pressed": pressed }
        : { role: "radio", "aria-checked": checked })}
      className={[
        "h-auto flex-col items-stretch gap-0 font-normal",
        sidebarItemClassName,
        actionCount >= 3
          ? "pr-24"
          : actionCount === 2
            ? "pr-16"
            : actionCount === 1
              ? "pr-9"
              : "",
        selected
          ? "bg-sidebar-primary/16 text-sidebar-foreground ring-1 ring-sidebar-primary/35 hover:bg-sidebar-primary/16"
          : "text-sidebar-foreground/82 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        {leading}
        <span className="truncate">{label}</span>
        {labelTrailing}
      </div>
      {rowStatus ? (
        <span className="sr-only" id={rowStatusDescriptionId}>
          {rowStatus.description}
        </span>
      ) : null}
      {meta ? (
        <div className="mt-1 flex items-center gap-1 line-clamp-2 text-xs text-sidebar-foreground/50">
          {metaIcon ? (
            <span
              role="img"
              aria-label={metaIconLabel}
              className="inline-flex shrink-0"
            >
              {metaIcon}
            </span>
          ) : null}
          {meta}
        </div>
      ) : null}
    </Button>
  );

  return (
    <div className="group relative">
      {rowTooltip ? (
        <Tooltip>
          <TooltipTrigger render={row} />
          <TooltipContent
            role="tooltip"
            side="right"
            align="start"
            className="max-w-72 whitespace-normal text-left leading-relaxed"
          >
            {rowTooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        row
      )}
      {hasInfoButton ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={infoAriaLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  onPreview?.();
                }}
                className={[
                  "absolute top-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100",
                  (auxiliaryAction || onAuxiliaryAction) && onDelete
                    ? "right-[3.625rem]"
                    : auxiliaryAction || onAuxiliaryAction || onDelete
                      ? "right-8"
                      : "right-1.5",
                ].join(" ")}
              />
            }
          >
            <Info className="size-3" />
          </TooltipTrigger>
          {descriptionTooltip ? (
            <TooltipContent
              side="right"
              align="start"
              className="max-w-72 whitespace-normal leading-relaxed"
            >
              {descriptionTooltip}
            </TooltipContent>
          ) : null}
        </Tooltip>
      ) : null}
      {auxiliaryAction ? (
        <div
          className={[
            "absolute top-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
            onDelete ? "right-8" : "right-1.5",
          ].join(" ")}
        >
          {auxiliaryAction}
        </div>
      ) : onAuxiliaryAction ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            onAuxiliaryAction();
          }}
          title={auxiliaryActionLabel}
          aria-label={auxiliaryActionLabel ?? `More actions for ${label}`}
          className={[
            "absolute top-1.5 transition-opacity",
            auxiliaryActionAlwaysVisible
              ? "opacity-70 hover:opacity-100"
              : "opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100",
            onDelete ? "right-8" : "right-1.5",
          ].join(" ")}
        >
          {auxiliaryActionIcon ?? <Plus className="size-3" />}
        </Button>
      ) : null}
      {onDelete ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          disabled={deleting}
          title={`Delete ${label}`}
          aria-label={`Delete ${label}`}
          className={[
            "absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100",
            deleting ? "opacity-100" : "",
          ].join(" ")}
        >
          {deleting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Trash2 className="size-3" />
          )}
        </Button>
      ) : null}
    </div>
  );
}
