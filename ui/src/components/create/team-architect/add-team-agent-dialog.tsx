import { Loader2, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDisplayName } from "@/lib/utils/display-name";
import type { TeamEditorController } from "./use-team-editor";

export function AddTeamAgentDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editor: TeamEditorController;
}) {
  const [agentToAdd, setAgentToAdd] = useState("");

  function selectAgent(agentName: string) {
    setAgentToAdd(agentName);
  }

  // Only the reference and the team responsibilities are saved. Copying the
  // agent's current model would freeze today's choice into this team and
  // diverge the moment the agent is edited. There is no grade to pick either:
  // the member's role says what it does, and the Agent's own file says what it
  // runs on.
  async function addAgent() {
    await props.editor.addAgent({ agentName: agentToAdd }, () => {
      setAgentToAdd("");
      props.onOpenChange(false);
    });
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Select
            value={agentToAdd || null}
            onValueChange={(value) => {
              if (typeof value === "string") selectAgent(value);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select agent...">
                {(selected) =>
                  typeof selected === "string" && selected ? (
                    <span className="truncate">
                      {formatDisplayName(selected)}
                    </span>
                  ) : (
                    "Select agent..."
                  )
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              {props.editor.availableAgents.map((agent) => (
                <SelectItem key={agent.name} value={agent.name}>
                  {formatDisplayName(agent.name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            This agent runs with the model set on the agent itself, or with the
            application default. Teams do not change that.
          </p>
          {/* A refusal belongs where the user is. A review team is one writer
              and one checker, so a third member is turned away — and saying so
              only behind this dialog leaves them pressing Add with nothing
              happening. */}
          {props.editor.error ? (
            <p className="text-xs text-destructive" role="alert">
              {props.editor.error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={props.editor.saving}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void addAgent()}
            disabled={!agentToAdd || props.editor.saving}
          >
            {props.editor.saving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
