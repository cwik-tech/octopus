import { Loader2, Square } from "lucide-react";
import type { ReactNode } from "react";

import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputTextareaProps,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { ModelSelect } from "@/components/ui/model-select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ModelChoice } from "@/lib/utils/model-catalog";

/** The `+` menu and the file handling behind it. */
export interface ChatComposerAttachments {
  /** Accessible name for the `+` trigger. */
  label: string;
  /** Disables the trigger alone. The textarea keeps its own disabled state. */
  disabled?: boolean | undefined;
  accept?: string | undefined;
  multiple?: boolean;
  onFilesAccepted?: ((files: File[]) => void) | undefined;
  onError?: (error: { message: string }) => void;
  /** Entries under "Add Files", for a caller with more to offer. */
  menuItems?: ReactNode;
}

/** The model this composer sends on, named in the control row. */
export interface ChatComposerModel {
  provider?: string | undefined;
  model?: string | undefined;
  onChange: (choice: ModelChoice) => void;
  /**
   * Where the picker's own prefill goes, for a caller that tells a person's
   * choice apart from one the control wrote for itself.
   */
  onAutoSelect?: ((choice: ModelChoice) => void) | undefined;
  fallbackToFirstAvailable?: boolean;
  disabled?: boolean;
  /** Accessible name, which is how people and tests find this picker. */
  label: string;
}

/** Replaces the send button while something is running. */
export interface ChatComposerStop {
  onStop: () => void;
  stopping?: boolean;
  label: string;
  stoppingLabel?: string;
}

export interface ChatComposerProps {
  placeholder: string;
  /** Stops both typing and sending. */
  disabled?: boolean;
  /** Turns the send button into a spinner. */
  submitting?: boolean;
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  submitLabel?: string;
  submittingLabel?: string;
  /** Everything the textarea needs beyond its placeholder and disabled state. */
  textareaProps?: Omit<
    PromptInputTextareaProps,
    "placeholder" | "disabled" | "className"
  >;
  /**
   * Wraps the textarea in place, for a caller that anchors a popover to it.
   * What this returns renders inside the form, above the control row.
   */
  renderTextarea?: (textarea: ReactNode) => ReactNode;
  attachments?: ChatComposerAttachments;
  model?: ChatComposerModel;
  stop?: ChatComposerStop | undefined;
}

/**
 * The one chat input. Run, Create and the architect panels all render this, so
 * how a message is typed, attached to, modelled and sent changes in one place.
 *
 * What sits above the input — notices, context pickers, attached-file rows —
 * belongs to the page that knows about it and is passed as this component's
 * sibling rather than a prop.
 */
export function ChatComposer({
  placeholder,
  disabled = false,
  submitting = false,
  onSubmit,
  submitLabel = "Submit",
  submittingLabel,
  textareaProps,
  renderTextarea,
  attachments,
  model,
  stop,
}: ChatComposerProps) {
  // The control row overlays the bottom of the textarea, so the text only has
  // to clear it when there is a row to clear.
  const hasControlRow = Boolean(attachments || model);
  const textarea = (
    <PromptInputTextarea
      {...textareaProps}
      placeholder={placeholder}
      disabled={disabled}
      className={hasControlRow ? "pb-11" : undefined}
    />
  );
  return (
    <PromptInput
      onSubmit={onSubmit}
      className="relative w-full"
      accept={attachments?.accept}
      multiple={attachments?.multiple}
      onFilesAccepted={attachments?.onFilesAccepted}
      onError={attachments?.onError}
    >
      {renderTextarea ? renderTextarea(textarea) : textarea}
      {hasControlRow ? (
        <div className="pointer-events-none absolute inset-x-1 bottom-1 flex items-center gap-1.5 pr-9 [&>*]:pointer-events-auto">
          {attachments ? (
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger
                aria-label={attachments.label}
                disabled={attachments.disabled}
              />
              <PromptInputActionMenuContent side="top" align="start">
                <PromptInputActionAddAttachments label="Add Files" />
                {attachments.menuItems}
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          ) : null}
          {model ? (
            <ModelSelect
              provider={model.provider}
              model={model.model}
              onChange={model.onChange}
              onAutoSelect={model.onAutoSelect}
              fallbackToFirstAvailable={model.fallbackToFirstAvailable}
              // Never disabled for want of a usable pair: this is the control
              // that supplies one, and a person whose selection has stopped
              // working needs it most.
              disabled={model.disabled}
              className="h-8 w-52 min-w-0 shrink border-0 bg-transparent text-xs shadow-none"
              contentClassName="max-h-80"
              showIndicator={false}
              aria-label={model.label}
            />
          ) : null}
        </div>
      ) : null}
      {stop ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="destructive"
                size="icon-sm"
                aria-label={
                  stop.stopping
                    ? (stop.stoppingLabel ?? stop.label)
                    : stop.label
                }
                className="absolute bottom-1 right-1"
                disabled={stop.stopping}
                onClick={stop.onStop}
              />
            }
          >
            {stop.stopping ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Square className="size-3.5" aria-hidden="true" />
            )}
          </TooltipTrigger>
          <TooltipContent role="tooltip" side="top">
            {stop.label}
          </TooltipContent>
        </Tooltip>
      ) : (
        <PromptInputSubmit
          status={submitting ? "submitted" : "ready"}
          disabled={disabled}
          aria-label={
            submitting ? (submittingLabel ?? submitLabel) : submitLabel
          }
          className="absolute bottom-1 right-1"
        />
      )}
    </PromptInput>
  );
}
