import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDisplayName } from "@/lib/utils/display-name";

interface AgentDuplicateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingAgentName: string;
  onOverwrite: () => void;
  onDuplicate: () => void;
}

export default function AgentDuplicateDialog({
  open,
  onOpenChange,
  existingAgentName,
  onOverwrite,
  onDuplicate,
}: AgentDuplicateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>An agent with these skills already exists</DialogTitle>
          <DialogDescription>
            Agent{" "}
            <code className="font-mono">
              {formatDisplayName(existingAgentName)}
            </code>{" "}
            already wraps this exact set of skills. Choose how to proceed.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={onDuplicate}>
            Duplicate
          </Button>
          <Button variant="destructive" onClick={onOverwrite}>
            Overwrite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
