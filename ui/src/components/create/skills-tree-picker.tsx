import {
  ChevronDown,
  ChevronRight,
  FolderTree,
  Loader2,
  Sparkles,
} from "lucide-react";
import { startTransition, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { PanelCard, PanelContent, PanelHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { listSkillsTree } from "@/lib/clients/agent-generator-client";
import type { SkillTreeNode } from "@/lib/models/agent-generator-model";

interface SkillsTreePickerProps {
  path: string;
  onPathChange: (path: string) => void;
  selectedPaths: Set<string>;
  onToggle: (path: string, selected: boolean) => void;
  onCreate: () => void;
  creating: boolean;
  createDisabled?: boolean;
}

export default function SkillsTreePicker({
  path,
  onPathChange,
  selectedPaths,
  onToggle,
  onCreate,
  creating,
  createDisabled,
}: SkillsTreePickerProps) {
  const [tree, setTree] = useState<SkillTreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftPath, setDraftPath] = useState(path);

  useEffect(() => {
    startTransition(() => {
      setDraftPath(path);
    });
  }, [path]);

  useEffect(() => {
    if (!path.trim()) {
      startTransition(() => {
        setTree(null);
        setError(null);
        setLoading(false);
      });
      return;
    }
    let cancelled = false;
    startTransition(() => {
      setLoading(true);
      setError(null);
    });
    void listSkillsTree({ path })
      .then((result) => {
        if (cancelled) return;
        startTransition(() => {
          setTree(result.tree);
          setLoading(false);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        startTransition(() => {
          setTree(null);
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const selectionCount = selectedPaths.size;

  return (
    <PanelCard variant="inset">
      <PanelHeader
        icon={<FolderTree className="size-4 text-muted-foreground" />}
        title="Skills source"
      />

      <PanelContent className="flex flex-col gap-3 p-3">
        <form
          className="flex shrink-0 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onPathChange(draftPath.trim());
          }}
        >
          <input
            value={draftPath}
            onChange={(event) => setDraftPath(event.target.value)}
            placeholder="/absolute/path/to/skills"
            className="flex-1 rounded-lg border border-border/60 bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/40"
          />
          <Button
            size="sm"
            type="submit"
            variant="secondary"
            className="text-xs"
          >
            Load
          </Button>
        </form>

        <Separator />

        <div className="max-h-[40vh] min-h-30 overflow-y-auto rounded-lg border border-border/60 bg-muted/30 p-2">
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading skills…
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : tree ? (
            <TreeNode
              node={tree}
              depth={0}
              selectedPaths={selectedPaths}
              onToggle={onToggle}
              startOpen
            />
          ) : (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              Enter a path above to load skills. Folders containing a SKILL.md
              file appear as selectable leaves.
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {selectionCount === 0
              ? "No skills selected"
              : selectionCount === 1
                ? "1 skill selected"
                : `${selectionCount} skills selected`}
          </span>
          <Button
            size="sm"
            onClick={onCreate}
            disabled={createDisabled || creating || selectionCount === 0}
            className="gap-1.5"
          >
            {creating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            <span className="text-xs">
              {creating ? "Creating…" : "Create agent from selected"}
            </span>
          </Button>
        </div>
      </PanelContent>
    </PanelCard>
  );
}

interface TreeNodeProps {
  node: SkillTreeNode;
  depth: number;
  selectedPaths: Set<string>;
  onToggle: (path: string, selected: boolean) => void;
  startOpen?: boolean;
}

function TreeNode({
  node,
  depth,
  selectedPaths,
  onToggle,
  startOpen,
}: TreeNodeProps) {
  const [open, setOpen] = useState(startOpen ?? depth < 1);
  const isLeaf = node.isSkill;
  const isSelected = isLeaf && selectedPaths.has(node.path);
  const hasChildren = !isLeaf && (node.children?.length ?? 0) > 0;

  const indent = useMemo(() => ({ paddingLeft: `${depth * 14}px` }), [depth]);

  return (
    <div>
      <div
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted/40"
        style={indent}
      >
        {isLeaf ? (
          <label className="flex flex-1 items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="size-3.5 rounded border-border/60"
              checked={isSelected}
              onChange={(event) => onToggle(node.path, event.target.checked)}
            />
            <span className="truncate text-xs font-medium text-foreground">
              {node.label}
            </span>
          </label>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setOpen((value) => !value)}
            className="h-auto flex-1 justify-start gap-1.5 px-0 text-left font-normal hover:bg-transparent"
          >
            {hasChildren ? (
              open ? (
                <ChevronDown className="size-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3 text-muted-foreground" />
              )
            ) : (
              <span className="inline-block size-3" />
            )}
            <span className="truncate text-xs text-muted-foreground">
              {node.label}
            </span>
          </Button>
        )}
      </div>
      {hasChildren && open && node.children
        ? node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPaths={selectedPaths}
              onToggle={onToggle}
            />
          ))
        : null}
    </div>
  );
}
