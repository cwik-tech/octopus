import { Loader2, Plus } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import type {
  AgentPackageAddKind,
  AgentPackageFileInput,
} from "@/lib/models/agent-generator-model";
import { filesToPayload } from "./package-file-payload";

export function AddPackageFilesButton(props: {
  kind: AgentPackageAddKind;
  onFiles: (files: AgentPackageFileInput[]) => void;
  disabled: boolean;
  busy: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.setAttribute("webkitdirectory", "");
  }, [props.kind]);

  return (
    <div className={props.className}>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = event.target.files;
          if (!files || files.length === 0) return;
          void filesToPayload(files).then(props.onFiles);
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-full gap-1.5 text-xs"
        disabled={props.disabled}
        onClick={() => inputRef.current?.click()}
      >
        {props.busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Plus className="size-3.5" />
        )}
        <span>{props.busy ? "Adding" : addLabel(props.kind)}</span>
      </Button>
    </div>
  );
}

function addLabel(kind: AgentPackageAddKind): string {
  if (kind === "skill") return "Import skill folder";
  if (kind === "template") return "Import templates";
  if (kind === "reference") return "Import references";
  if (kind === "script") return "Import scripts";
  return "Import context";
}
