import { Plus, X } from "lucide-react";

import {
  newCapabilityAliasDraft,
  type McpCapabilityAliasDraft,
} from "@/components/settings/mcp-connection-draft";
import { FieldHelp } from "@/components/ui/field-help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface McpCapabilityAliasEditorProps {
  aliases: McpCapabilityAliasDraft[];
  onChange: (aliases: McpCapabilityAliasDraft[]) => void;
}

export function McpCapabilityAliasEditor({
  aliases,
  onChange,
}: McpCapabilityAliasEditorProps) {
  return (
    <fieldset className="space-y-3 rounded-lg border border-border/70 p-3">
      <legend className="sr-only">Workflow capabilities</legend>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1">
            <span className="px-1 text-sm font-medium">
              Workflow capabilities
            </span>
            <FieldHelp label="Help: workflow matching">
              Optional labels that let a workflow find a suitable MCP connection
              before a run. Add them only when a workflow declares required or
              optional MCP capabilities. They are not MCP tool names and do not
              grant or restrict server permissions.
            </FieldHelp>
          </div>
          <p className="mt-1 max-w-2xl px-1 text-xs leading-relaxed text-muted-foreground">
            Optional labels used to match this connection to workflow requirements
            before a run. Most connections can leave this section empty.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={aliases.length >= 64}
          onClick={() => onChange([...aliases, newCapabilityAliasDraft()])}
        >
          <Plus />
          Add capability
        </Button>
      </div>

      {aliases.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          No workflow capabilities declared. Tools can still be granted to agents,
          but capability-based workflow preflight cannot select this connection.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,0.45fr)_auto] gap-2 px-1 text-xs font-medium text-muted-foreground">
            <div className="flex items-center gap-1">
              <span>Capability name</span>
              <FieldHelp label="Help: workflow capability labels">
                Enter the exact label used by the workflow, such as
                {" "}<span className="font-mono">web.search</span> or
                {" "}<span className="font-mono">documents.read</span>. This is
                a label you define for preflight matching, not the name of an MCP
                tool.
              </FieldHelp>
            </div>
            <div className="flex items-center gap-1">
              <span>Access match</span>
              <FieldHelp label="Help: workflow access matching">
                Choose whether this connection can satisfy a workflow requirement
                for Read, Write, or Read &amp; write during preflight. This is
                matching metadata only; it does not enforce runtime permissions.
              </FieldHelp>
            </div>
            <span aria-hidden="true" />
          </div>
          {aliases.map((alias, index) => (
            <div
              key={alias.id}
              className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,0.45fr)_auto] gap-2"
            >
              <Input
                value={alias.capability}
                aria-label={`Workflow capability ${index + 1}`}
                className="font-mono"
                placeholder="web.search"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => onChange(aliases.map((candidate) =>
                  candidate.id === alias.id
                    ? { ...candidate, capability: event.target.value }
                    : candidate,
                ))}
              />
              <select
                value={alias.access}
                aria-label={`Workflow capability access ${index + 1}`}
                className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                onChange={(event) => onChange(aliases.map((candidate) =>
                  candidate.id === alias.id
                    ? {
                        ...candidate,
                        access: event.target.value as McpCapabilityAliasDraft["access"],
                      }
                    : candidate,
                ))}
              >
                <option value="read">Read</option>
                <option value="write">Write</option>
                <option value="any">Read &amp; write</option>
              </select>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove workflow capability ${index + 1}`}
                onClick={() => onChange(
                  aliases.filter((candidate) => candidate.id !== alias.id),
                )}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}
