import { Check, Copy, FileText, Loader2, Save } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PanelCard, PanelContent, PanelHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils/utils";

interface AgentPersonaEditorProps {
  agentName: string | null;
  personaMarkdown: string | null;
  onChange: (value: string) => void;
  dirty: boolean;
  saving: boolean;
  saved: { personaPath: string } | null;
  saveError: string | null;
  onSave: () => void | Promise<void>;
  className?: string;
}

export default function AgentPersonaEditor({
  agentName,
  personaMarkdown,
  onChange,
  dirty,
  saving,
  saved,
  saveError,
  onSave,
  className,
}: AgentPersonaEditorProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!personaMarkdown) return;
    try {
      await navigator.clipboard.writeText(personaMarkdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const canSave = !!personaMarkdown && !saving && !!agentName && dirty;

  return (
    <PanelCard
      variant="inset"
      className={cn("overflow-hidden", className)}
    >
      <PanelHeader
        icon={<FileText className="size-4 text-muted-foreground" />}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span>Persona</span>
            {agentName ? (
              <span className="truncate font-mono text-xs normal-case tracking-normal">
                {agentName}.md
              </span>
            ) : null}
          </span>
        }
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!personaMarkdown}
              onClick={() => void handleCopy()}
              className="gap-1.5"
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
              <span className="text-xs">{copied ? "Copied" : "Copy"}</span>
            </Button>
            <Button
              size="sm"
              disabled={!canSave}
              onClick={() => void onSave()}
              className="gap-1.5"
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              <span className="text-xs">{saving ? "Saving" : "Save"}</span>
            </Button>
          </>
        }
      />

      <PanelContent className="flex flex-col gap-3 p-3">
        {personaMarkdown ? (
          <textarea
            aria-label="Persona markdown"
            value={personaMarkdown}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none overflow-auto rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-relaxed outline-none focus:border-primary/40"
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
            Select an agent on the left, or create a new one from the skills
            tree above. The persona markdown will appear here for editing.
          </div>
        )}

        {dirty && personaMarkdown ? (
          <div className="shrink-0 text-xs text-muted-foreground">
            Unsaved persona edits
          </div>
        ) : null}

        {saveError ? (
          <div className="shrink-0 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            {saveError}
          </div>
        ) : null}

        {saved ? (
          <div className="shrink-0 rounded-lg border border-emerald-500/30 bg-emerald-500/8 px-3 py-2 text-xs text-emerald-700">
            Saved <code className="font-mono">{saved.personaPath}</code>
          </div>
        ) : null}
      </PanelContent>
    </PanelCard>
  );
}
