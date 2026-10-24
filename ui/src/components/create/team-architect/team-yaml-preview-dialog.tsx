import { Check, Copy, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PanelCard, PanelContent, PanelHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

export function TeamYamlPreviewDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  yaml: string | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100vh-2rem)] gap-0 overflow-hidden bg-transparent p-0 ring-0 sm:max-w-3xl"
      >
        <DialogTitle className="sr-only">Preview team YAML</DialogTitle>
        <TeamYamlPreview
          yaml={props.yaml}
          loading={props.loading}
          error={props.error}
        />
      </DialogContent>
    </Dialog>
  );
}

function TeamYamlPreview(props: {
  yaml: string | null;
  loading: boolean;
  error: string | null;
}) {
  const [copied, setCopied] = useState(false);

  async function copyYaml() {
    if (!props.yaml) return;
    try {
      await navigator.clipboard.writeText(props.yaml);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard support is best-effort.
    }
  }

  return (
    <PanelCard
      variant="inset"
      className="min-h-0 overflow-hidden bg-card shadow-sm"
    >
      <PanelHeader
        title="YAML"
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!props.yaml}
              onClick={() => void copyYaml()}
              className="gap-1.5"
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
              <span className="text-xs">{copied ? "Copied" : "Copy"}</span>
            </Button>
            <DialogClose
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Close YAML preview"
                />
              }
            >
              <X className="size-3.5" />
            </DialogClose>
          </>
        }
      />
      <PanelContent className="min-h-0 p-3">
        {props.error ? (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            {props.error}
          </div>
        ) : null}
        {props.loading && !props.yaml ? (
          <div className="flex min-h-48 items-center justify-center px-3 py-6 text-center text-xs text-muted-foreground">
            Loading YAML...
          </div>
        ) : props.yaml ? (
          <pre className="max-h-[calc(100vh-10rem)] overflow-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-background p-3 font-mono text-xs leading-relaxed">
            {props.yaml}
          </pre>
        ) : (
          <div className="flex min-h-48 items-center justify-center px-3 py-6 text-center text-xs text-muted-foreground">
            No YAML available for this team.
          </div>
        )}
      </PanelContent>
    </PanelCard>
  );
}
