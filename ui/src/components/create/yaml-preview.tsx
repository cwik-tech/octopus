import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Loader2,
  Maximize2,
  Save,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PanelCard, PanelContent, PanelHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils/utils";

export interface YamlPreviewProps {
  yaml: string | null;
  onYamlChange: (yaml: string) => void;
  warnings: string[];
  errors: string[];
  validating: boolean;
  dirty: boolean;
  saving: boolean;
  saved: { yamlPath: string; filename: string } | null;
  saveError: string | null;
  onSave: (filename?: string) => void | Promise<void>;
  filenameDefault?: string | undefined;
  className?: string;
}

function YamlPreview({
  yaml,
  onYamlChange,
  warnings,
  errors,
  validating,
  dirty,
  saving,
  saved,
  saveError,
  onSave,
  filenameDefault,
  className,
}: YamlPreviewProps) {
  const [copied, setCopied] = useState(false);
  const [yamlDialogOpen, setYamlDialogOpen] = useState(false);
  const effectiveFilename = filenameDefault?.trim() || undefined;

  const canSave = !!yaml && !saving && !validating && errors.length === 0;

  const handleCopy = async () => {
    if (!yaml) return;
    try {
      await navigator.clipboard.writeText(yaml);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <>
      <PanelCard className={cn("shadow-sm", className)}>
        <PanelHeader
          icon={<Code2 className="size-4 text-muted-foreground" />}
          title="YAML"
          actions={
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!yaml}
                onClick={() => setYamlDialogOpen(true)}
                aria-label="Maximize YAML editor"
              >
                <Maximize2 className="size-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!yaml}
                onClick={() => void handleCopy()}
                aria-label={copied ? "YAML copied" : "Copy YAML"}
              >
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            </>
          }
        />

        <PanelContent className="flex flex-col gap-3 p-3">
          <YamlMessages warnings={warnings} errors={errors} />

          {yaml ? (
            <textarea
              value={yaml}
              onChange={(event) => onYamlChange(event.target.value)}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none overflow-auto rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-relaxed outline-none focus:border-primary/40"
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-6 text-center text-xs text-muted-foreground">
              The YAML will appear here once the architect proposes a draft.
            </div>
          )}

          <div className="flex shrink-0 justify-end">
            <YamlSaveButton
              canSave={canSave}
              saving={saving}
              onSave={() => void onSave(effectiveFilename)}
            />
          </div>

          <YamlStatus
            dirty={dirty}
            validating={validating}
            yaml={yaml}
            saveError={saveError}
            saved={saved}
          />
        </PanelContent>
      </PanelCard>

      <Dialog open={yamlDialogOpen} onOpenChange={setYamlDialogOpen}>
        <DialogContent className="flex h-[90vh] max-h-[90vh] w-[calc(100vw-2rem)] max-w-280 flex-col gap-3 p-4 sm:max-w-280">
          <DialogHeader className="pr-8">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Code2 className="size-4 text-muted-foreground" />
              YAML
            </DialogTitle>
          </DialogHeader>

          <YamlMessages warnings={warnings} errors={errors} />

          {yaml ? (
            <textarea
              value={yaml}
              onChange={(event) => onYamlChange(event.target.value)}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none overflow-auto rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-relaxed outline-none focus:border-primary/40"
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
              The YAML will appear here once the architect proposes a draft.
            </div>
          )}

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 pt-3">
            <YamlStatus
              dirty={dirty}
              validating={validating}
              yaml={yaml}
              saveError={null}
              saved={null}
              compact
            />
            <YamlSaveButton
              canSave={canSave}
              saving={saving}
              onSave={() => void onSave(effectiveFilename)}
            />
          </div>

          <YamlStatus
            dirty={false}
            validating={false}
            yaml={yaml}
            saveError={saveError}
            saved={saved}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function YamlMessages({
  errors,
  warnings,
}: {
  errors: string[];
  warnings: string[];
}) {
  return (
    <>
      {warnings.length > 0 ? (
        <div className="flex shrink-0 items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <ul className="list-disc space-y-0.5 pl-4">
            {warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div className="flex shrink-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <ul className="list-disc space-y-0.5 pl-4">
            {errors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function YamlSaveButton({
  canSave,
  onSave,
  saving,
}: {
  canSave: boolean;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <Button
      size="sm"
      disabled={!canSave}
      onClick={onSave}
      className="gap-1.5"
    >
      {saving ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Save className="size-3.5" />
      )}
      <span className="text-xs">{saving ? "Saving" : "Save"}</span>
    </Button>
  );
}

function YamlStatus({
  compact = false,
  dirty,
  saveError,
  saved,
  validating,
  yaml,
}: {
  compact?: boolean;
  dirty: boolean;
  saveError: string | null;
  saved: { yamlPath: string; filename: string } | null;
  validating: boolean;
  yaml: string | null;
}) {
  return (
    <>
      {yaml && (dirty || validating) ? (
        <div
          className={cn(
            "shrink-0 text-xs text-muted-foreground",
            compact ? "min-w-0 truncate" : null,
          )}
        >
          {validating ? "Validating YAML..." : "Unsaved YAML edits"}
        </div>
      ) : compact ? (
        <div />
      ) : null}

      {saveError ? (
        <div className="shrink-0 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          {saveError}
        </div>
      ) : null}

      {saved ? (
        <div className="shrink-0 rounded-lg border border-emerald-500/30 bg-emerald-500/8 px-3 py-2 text-xs text-emerald-700">
          Saved <code className="font-mono">{saved.filename}</code>. It will
          appear in the Run tab on next mount.
        </div>
      ) : null}
    </>
  );
}

export default YamlPreview;
