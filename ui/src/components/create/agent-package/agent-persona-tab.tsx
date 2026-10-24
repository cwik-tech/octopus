import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";

import PersonaMarkdownEditor from "@/components/create/persona-markdown-editor";
import { Button } from "@/components/ui/button";
import { PanelEmptyState } from "@/components/ui/card";
import { TabsContent } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { diffLines } from "@/lib/utils/line-diff";
import { parsePersonaModelMode } from "./persona-frontmatter";
import { StatusMessage } from "./status-message";

interface AgentPersonaTabProps {
  agentName: string | null;
  personaPath: string | null;
  personaMarkdown: string | null;
  savedPersonaMarkdown: string | null;
  onPersonaChange: (value: string) => void;
  dirty: boolean;
  saving: boolean;
  saved: { personaPath: string } | null;
  saveError: string | null;
  onSave: () => void | Promise<void>;
}

export function AgentPersonaTab(props: AgentPersonaTabProps) {
  const [copied, setCopied] = useState(false);
  // There is no Save button. What was typed is saved when the person leaves
  // the text; a model change saves itself from the editor header.
  const canSave = !!props.personaMarkdown && !!props.agentName && props.dirty;
  const personaDiff = useMemo(
    () =>
      props.personaMarkdown !== null && props.savedPersonaMarkdown !== null
        ? diffLines(props.savedPersonaMarkdown, props.personaMarkdown)
        : null,
    [props.personaMarkdown, props.savedPersonaMarkdown],
  );
  // The model is chosen in the editor header. A pair the runtime refuses is
  // still reported here, beside the file that holds it.
  const modelChoice = useMemo(
    () => parsePersonaModelMode(props.personaMarkdown),
    [props.personaMarkdown],
  );

  async function copyPersona() {
    if (!props.personaMarkdown) return;
    try {
      await navigator.clipboard.writeText(props.personaMarkdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard support is best-effort.
    }
  }

  return (
    <TabsContent value="persona" className="flex min-h-0 flex-1 flex-col pt-3 pb-0">
      <div className="mb-3 flex shrink-0 flex-col gap-2">
        <div className="min-w-0 text-xs text-muted-foreground">
          {props.personaPath ?? "Select an agent to edit persona markdown."}
        </div>

        {modelChoice.mode === "invalid" ? (
          // The runtime refuses this file. Saying so here is the difference
          // between an agent the user can fix and one that fails at startup
          // with no explanation in the editor that wrote it.
          <p className="text-xs text-destructive">{modelChoice.message}</p>
        ) : null}
      </div>

      {props.personaMarkdown ? (
        <PersonaMarkdownEditor
          value={props.personaMarkdown}
          onChange={props.onPersonaChange}
          onBlur={() => {
            if (canSave) void props.onSave();
          }}
          diff={personaDiff}
          className="min-h-0 flex-1"
          actions={
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  aria-label="Copy persona"
                  onClick={() => void copyPersona()}
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="text-muted-foreground"
                    />
                  }
                >
                  {copied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </TooltipTrigger>
                <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          }
        />
      ) : (
        <PanelEmptyState className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
          Select an agent on the left, or create a new one from selected skills.
        </PanelEmptyState>
      )}

      {props.saveError ? (
        <StatusMessage tone="error">{props.saveError}</StatusMessage>
      ) : null}
    </TabsContent>
  );
}
