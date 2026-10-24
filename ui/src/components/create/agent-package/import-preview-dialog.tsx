import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  AgentPackageImportAction,
  AgentPackageImportChoice,
} from "@/lib/models/agent-generator-model";
import { AssetIcon } from "./asset-icon";
import { formatImportAction } from "./package-display";
import type { ImportDraft } from "./types";

export function ImportPreviewDialog(props: {
  draft: ImportDraft | null;
  choices: Record<string, AgentPackageImportChoice>;
  busy: boolean;
  onChoiceChange: (choice: AgentPackageImportChoice) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const selectedCount =
    props.draft?.items.filter((item) => props.choices[item.id]?.selected).length ??
    0;
  const primaryItems =
    props.draft?.items.filter((item) => item.kind === props.draft?.kind) ?? [];
  const extraItems =
    props.draft?.items.filter((item) => item.kind !== props.draft?.kind) ?? [];

  return (
    <Dialog open={props.draft !== null} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[80vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import package files</DialogTitle>
          <DialogDescription>
            Select which detected skills, references, templates, scripts, and
            context files to include.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 max-h-[48vh] space-y-2 overflow-y-auto">
          {[...primaryItems, ...extraItems].map((item) => {
            const choice = props.choices[item.id] ?? {
              id: item.id,
              selected: item.defaultSelected,
              action: item.defaultAction,
            };
            return (
              <div
                key={item.id}
                className="rounded-lg border border-border/60 bg-background/70 p-3"
              >
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5"
                    checked={choice.selected}
                    onChange={(event) =>
                      props.onChoiceChange({
                        ...choice,
                        selected: event.target.checked,
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <AssetIcon kind={item.kind} />
                      <span className="font-mono text-xs font-medium">
                        {item.label}
                      </span>
                      <Badge variant="secondary" className="h-4 px-1.5 text-xs">
                        {item.kind}
                      </Badge>
                      {item.exists ? (
                        <Badge
                          variant="secondary"
                          className="h-4 px-1.5 text-xs"
                        >
                          exists
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                      {item.targetAgentPath}
                    </span>
                  </span>
                </label>
                {item.exists ? (
                  <select
                    value={choice.action}
                    disabled={!choice.selected}
                    onChange={(event) =>
                      props.onChoiceChange({
                        ...choice,
                        action: event.target.value as AgentPackageImportAction,
                      })
                    }
                    className="mt-2 h-7 rounded-lg border border-border/60 bg-background px-2 text-xs"
                  >
                    {item.availableActions.map((action) => (
                      <option key={action} value={action}>
                        {formatImportAction(action)}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={props.busy}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={props.busy || selectedCount === 0}
            onClick={props.onConfirm}
          >
            {props.busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Import selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
