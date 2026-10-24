import { startTransition, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AgentNameApprovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestedName: string;
  /** Names already used by other agents — disables confirm if collision. */
  reservedNames: Set<string>;
  onConfirm: (approvedName: string) => void;
  confirming?: boolean;
}

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

export default function AgentNameApprovalDialog({
  open,
  onOpenChange,
  suggestedName,
  reservedNames,
  onConfirm,
  confirming,
}: AgentNameApprovalDialogProps) {
  const [name, setName] = useState(suggestedName);

  useEffect(() => {
    if (!open) return;
    startTransition(() => {
      setName(suggestedName);
    });
  }, [open, suggestedName]);

  const trimmed = name.trim();
  const validShape = KEBAB.test(trimmed);
  const collision = reservedNames.has(trimmed);
  const canConfirm = validShape && !collision && !confirming;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve agent name</DialogTitle>
          <DialogDescription>
            The agent will be written to{" "}
            <code className="font-mono">agents/{trimmed || "<name>"}/</code>.
            You can edit the name before saving.
          </DialogDescription>
        </DialogHeader>

        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono outline-none focus:border-primary/40"
        />

        {!validShape && trimmed.length > 0 ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            Use kebab-case: lowercase letters, digits, and hyphens. Must start
            with a letter or digit.
          </div>
        ) : null}
        {collision ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-700">
            An agent with this name already exists. Pick a different name or
            cancel and use the Overwrite option.
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={confirming}
          >
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(trimmed)}
            disabled={!canConfirm}
          >
            {confirming ? "Saving…" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
